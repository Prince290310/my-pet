'use strict';
/*
 * tasks.js - Prince's one-time reminders ("remind me at 6 to call Mom"), his to-do list,
 * and the morning briefing. Saved in %APPDATA%\Shadow\tasks.json (never in the project).
 *
 * Chat changes them in two ways:
 *  1. Plain commands Shadow understands by itself (work even with no AI key / no internet):
 *       remind me in 20 min to drink water      remind me at 6 pm to call Mom
 *       remind me tomorrow at 7:30 am to run    add to my list: physics homework
 *       todo: buy milk     done 2     remove 3     my list     my reminders     cancel reminder 1
 *  2. Anything else goes to the AI, which may end its reply with hidden [[...]] commands
 *     (see aiInstructions); main.js runs them through applyTags().
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LATE_MS = 2 * MIN; // fired this much after its time -> "(was due 6:00 PM)"
const STALE_MS = DAY; // missed by more than a day (PC was off) -> dropped quietly
const MAX_TEXT = 200;
const MAX_ITEMS = 200;

const pad = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clock12(ms) {
  const d = new Date(ms);
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const startOfDay = (ms) => new Date(ms).setHours(0, 0, 0, 0);

/** "today at 6:00 PM" / "tomorrow at 7:30 AM" / "Sun 12 Oct at 5:00 PM" / "in 20 min (6:05 PM)" */
function whenLabel(at, now) {
  const mins = Math.round((at - now) / MIN);
  if (mins >= 0 && mins < 60) return `in ${Math.max(1, mins)} min (${clock12(at)})`;
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days === 0) return `today at ${clock12(at)}`;
  if (days === 1) return `tomorrow at ${clock12(at)}`;
  const d = new Date(at);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} at ${clock12(at)}`;
}

const cleanText = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
    .slice(0, MAX_TEXT);

// ------------------------------------------------------------------ understanding plain commands

const DUR = String.raw`(\d+(?:\.\d+)?|an?|one|two|three|four|five|ten|fifteen|twenty|thirty|half an?)\s*(seconds?|secs?|minutes?|mins?|m|hours?|hrs?|h)`;
const TIME = String.raw`(noon|midnight|\d{1,2}(?::\d{2})?(?:\s*(?:am|pm|a\.m\.?|p\.m\.?))?)`;
const DAYWORD = String.raw`(today|tonight|tomorrow|tmrw|tmr)`;
const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };

function durationMs(n, unit) {
  const v = /^half/.test(n) ? 0.5 : WORDS[n] !== undefined ? WORDS[n] : Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (/^s/.test(unit)) return v * 1000;
  if (/^h/.test(unit)) return v * HOUR;
  return v * MIN;
}

/** Clock time + optional day word -> the next matching moment. */
function resolveTime(timeStr, dayWord, now) {
  const t = timeStr.toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
  let h;
  let mi = 0;
  let ampm = '';
  if (t === 'noon') h = 12;
  else if (t === 'midnight') h = 0;
  else {
    const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(t);
    if (!m) return null;
    h = +m[1];
    mi = +(m[2] || 0);
    ampm = m[3] || '';
  }
  if (h > 23 || mi > 59 || (ampm && (h < 1 || h > 12))) return null;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  const day = (dayWord || '').toLowerCase();
  const base = new Date(now);
  const at = (offsetDays, hour) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, hour, mi).getTime();
  const ambiguous = !ampm && h >= 1 && h <= 11 && t !== 'noon' && t !== 'midnight';
  if (day === 'tonight') return at(0, ambiguous ? h + 12 : h);
  if (/^(tomorrow|tmrw|tmr)$/.test(day)) return at(1, ambiguous && h <= 6 ? h + 12 : h);
  // No am/pm: 1-6 means afternoon/evening (nobody sets a 3 AM reminder by accident), 7-11 means the
  // next one - "at 9" is 9 PM if it's 3 PM now, 9 AM tomorrow if it's 10 PM.
  let today;
  if (!ambiguous) today = [at(0, h)];
  else if (h <= 6) today = [at(0, h + 12)];
  else today = [at(0, h), at(0, h + 12)];
  const next = today.find((x) => x > now);
  if (day === 'today') return next || today[today.length - 1]; // in the past -> "already passed"
  return next || at(1, ambiguous && h <= 6 ? h + 12 : h);
}

/** "remind me ..." -> { at, text } | { error } | null (not a reminder request) */
function parseRemind(rest, now) {
  const tries = [
    [new RegExp(`^in\\s+${DUR}\\s+(?:to\\s+|that\\s+|about\\s+)?(.+)$`, 'i'), (m) => ({ at: now + durationMs(m[1].toLowerCase(), m[2].toLowerCase()), text: m[3] })],
    [new RegExp(`^(?:to\\s+|that\\s+|about\\s+)?(.+?)\\s+in\\s+${DUR}$`, 'i'), (m) => ({ at: now + durationMs(m[2].toLowerCase(), m[3].toLowerCase()), text: m[1] })],
    [new RegExp(`^${DAYWORD}?\\s*(?:at\\s+)${TIME}\\s*${DAYWORD}?\\s+(?:to\\s+|that\\s+|about\\s+)?(.+)$`, 'i'), (m) => ({ at: resolveTime(m[2], m[1] || m[3], now), text: m[4] })],
    [new RegExp(`^${DAYWORD}\\s+${TIME}\\s+(?:to\\s+|that\\s+|about\\s+)?(.+)$`, 'i'), (m) => ({ at: resolveTime(m[2], m[1], now), text: m[3] })],
    [new RegExp(`^(?:to\\s+|that\\s+|about\\s+)?(.+?)\\s+${DAYWORD}?\\s*at\\s+${TIME}\\s*${DAYWORD}?$`, 'i'), (m) => ({ at: resolveTime(m[3], m[2] || m[4], now), text: m[1] })],
    [new RegExp(`^(?:to\\s+|that\\s+|about\\s+)?(.+?)\\s+${DAYWORD}\\s+${TIME}$`, 'i'), (m) => ({ at: resolveTime(m[3], m[2], now), text: m[1] })],
  ];
  for (const [re, build] of tries) {
    const m = re.exec(rest);
    if (!m) continue;
    const r = build(m);
    const text = cleanText(r.text);
    if (!text) return null;
    if (!r.at || !Number.isFinite(r.at)) return { error: 'time' };
    if (r.at <= now) return { error: 'past' };
    if (r.at - now > 366 * DAY) return { error: 'far' };
    return { at: Math.round(r.at / 1000) * 1000, text };
  }
  return null;
}

const LIST = String.raw`(?:to-?do|todo|task)?\s*(?:list|todos?|tasks?)`;

/** Turn a chat message into a command, or null if it should go to the AI. */
function parseCommand(input, now = Date.now()) {
  const t = String(input || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey |hi |ok |okay )?(?:shadow)?[,:!]?\s*/i, '')
    .replace(/^(?:please|pls|plz)\s+/i, '')
    .replace(/\s+(?:please|pls|plz)$/i, '')
    .replace(/[.!]+$/, '')
    .trim();
  if (!t) return null;
  let m;
  if ((m = /^remind me\s+(.+)$/i.exec(t))) {
    const r = parseRemind(m[1], now);
    return r ? (r.error ? { type: 'remind-error', error: r.error } : { type: 'remind', at: r.at, text: r.text }) : null;
  }
  if ((m = /^(?:add|put)\s+(.+?)\s+(?:to|on|in)\s+(?:my\s+)?(?:to-?do\s+|todo\s+|task\s+)?(?:list|todos?|tasks?)$/i.exec(t))) return { type: 'todo-add', text: cleanText(m[1]) };
  if ((m = /^(?:add\s+)?(?:to-?do|todo|task)\s*[:-]\s*(.+)$/i.exec(t))) return { type: 'todo-add', text: cleanText(m[1]) };
  if ((m = /^add\s+(?:to|on)\s+(?:my\s+)?(?:to-?do\s+|todo\s+)?(?:list|todos?)\s*[:-]?\s*(.+)$/i.exec(t))) return { type: 'todo-add', text: cleanText(m[1]) };
  if ((m = /^(?:mark\s+)?(?:done|finished|completed?|tick)\s*(?:#|no\.?\s*|number\s*)?(\d{1,3})(?:\s+(?:as\s+)?done)?$/i.exec(t))) return { type: 'todo-done', n: +m[1] };
  if ((m = /^(?:#)?(\d{1,3})\s+(?:is\s+)?(?:done|finished|completed?)$/i.exec(t))) return { type: 'todo-done', n: +m[1] };
  if ((m = /^(?:remove|delete)\s+(?:to-?do\s+|todo\s+|task\s+|item\s+)?(?:#|no\.?\s*|number\s*)?(\d{1,3})(?:\s+from\s+(?:my\s+)?list)?$/i.exec(t))) return { type: 'todo-remove', n: +m[1] };
  if ((m = /^(?:cancel|delete|remove)\s+reminder\s*(?:#|no\.?\s*|number\s*)?(\d{1,3})$/i.exec(t))) return { type: 'reminder-cancel', n: +m[1] };
  if (/^(?:show\s+(?:me\s+)?|see\s+|what'?s\s+on\s+|what\s+is\s+on\s+|whats\s+on\s+)?(?:my\s+)?reminders\??$/i.test(t)) return { type: 'reminder-list' };
  if (new RegExp(`^(?:show\\s+(?:me\\s+)?|see\\s+|open\\s+|what'?s\\s+on\\s+|what\\s+is\\s+on\\s+|whats\\s+on\\s+|read\\s+)?(?:my\\s+)?${LIST}\\??$`, 'i').test(t)) return { type: 'todo-list' };
  return null;
}

// ------------------------------------------------------------------ store

class TaskStore extends EventEmitter {
  constructor({ file, clock = () => Date.now() } = {}) {
    super();
    this.file = file;
    this.clock = clock;
    this.data = { todos: [], reminders: [], lastBriefing: '', lastNudge: 0 };
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const arr = (a) => (Array.isArray(a) ? a : []);
      this.data = {
        todos: arr(raw.todos)
          .filter((t) => t && typeof t.text === 'string' && t.id)
          .map((t) => ({ id: String(t.id), text: cleanText(t.text), done: !!t.done, created: +t.created || 0, doneAt: +t.doneAt || 0 })),
        reminders: arr(raw.reminders)
          .filter((r) => r && typeof r.text === 'string' && r.id && Number.isFinite(+r.at))
          .map((r) => ({ id: String(r.id), text: cleanText(r.text), at: +r.at, created: +r.created || 0, firedAt: +r.firedAt || 0 })),
        lastBriefing: typeof raw.lastBriefing === 'string' ? raw.lastBriefing : '',
        lastNudge: +raw.lastNudge || 0,
      };
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[tasks] could not read tasks.json, starting empty:', err.message);
    }
  }

  save() {
    const now = this.clock();
    // keep the file small: finished to-dos for a week, fired reminders for two days
    this.data.todos = this.data.todos.filter((t) => !t.done || now - t.doneAt < 7 * DAY);
    this.data.reminders = this.data.reminders.filter((r) => !r.firedAt || now - r.firedAt < 2 * DAY);
    this.emit('change');
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn('[tasks] could not save:', err.message);
    }
  }

  openTodos() {
    return this.data.todos.filter((t) => !t.done);
  }

  pendingReminders() {
    return this.data.reminders.filter((r) => !r.firedAt).sort((a, b) => a.at - b.at);
  }

  addTodo(text) {
    const clean = cleanText(text);
    if (!clean) return { error: 'empty' };
    if (this.openTodos().length >= MAX_ITEMS) return { error: 'full' };
    const dup = this.openTodos().find((t) => t.text.toLowerCase() === clean.toLowerCase());
    if (dup) return { todo: dup, duplicate: true };
    const todo = { id: crypto.randomUUID(), text: clean, done: false, created: this.clock(), doneAt: 0 };
    this.data.todos.push(todo);
    this.save();
    return { todo };
  }

  /** n = number as shown in the open list (1-based). ids lets a batch use numbers from one snapshot. */
  completeTodo(n, ids = this.openTodos().map((t) => t.id)) {
    const todo = this.data.todos.find((t) => t.id === ids[n - 1] && !t.done);
    if (!todo) return { error: 'number', count: this.openTodos().length };
    todo.done = true;
    todo.doneAt = this.clock();
    this.save();
    return { todo, left: this.openTodos().length };
  }

  removeTodo(n, ids = this.openTodos().map((t) => t.id)) {
    const i = this.data.todos.findIndex((t) => t.id === ids[n - 1] && !t.done);
    if (i < 0) return { error: 'number', count: this.openTodos().length };
    const [todo] = this.data.todos.splice(i, 1);
    this.save();
    return { todo, left: this.openTodos().length };
  }

  addReminder(at, text) {
    const now = this.clock();
    const clean = cleanText(text);
    if (!clean) return { error: 'empty' };
    if (!Number.isFinite(at) || at <= now - MIN) return { error: 'past' };
    if (at - now > 366 * DAY) return { error: 'far' };
    if (this.pendingReminders().length >= MAX_ITEMS) return { error: 'full' };
    const reminder = { id: crypto.randomUUID(), text: clean, at, created: now, firedAt: 0 };
    this.data.reminders.push(reminder);
    this.save();
    return { reminder };
  }

  cancelReminder(n, ids = this.pendingReminders().map((r) => r.id)) {
    const i = this.data.reminders.findIndex((r) => r.id === ids[n - 1] && !r.firedAt);
    if (i < 0) return { error: 'number', count: this.pendingReminders().length };
    const [reminder] = this.data.reminders.splice(i, 1);
    this.save();
    return { reminder };
  }

  /** Fire due reminders. Returns what fired (also emitted as 'fire'). */
  check(now = this.clock()) {
    const due = [];
    let changed = false;
    for (const r of this.pendingReminders()) {
      if (r.at > now) break;
      r.firedAt = now;
      changed = true;
      if (now - r.at > STALE_MS) continue; // the PC was off for over a day - too old to be useful
      const late = now - r.at > LATE_MS ? ` (was due ${clock12(r.at)})` : '';
      const what = r.text.charAt(0).toUpperCase() + r.text.slice(1);
      due.push({ time: clock12(r.at), message: `Prince! ${what}${late}`, key: `task|${r.id}`, source: 'chat' });
    }
    if (changed) this.save();
    due.forEach((r) => this.emit('fire', r));
    return due;
  }

  // -------------------------------------------------------------- chat
  /** Run a parsed command and return Shadow's reply. */
  run(cmd, now = this.clock()) {
    switch (cmd.type) {
      case 'remind': {
        const r = this.addReminder(cmd.at, cmd.text);
        if (r.error) return reminderError(r.error);
        return `Done! ⏰ I'll remind you ${whenLabel(cmd.at, now)}: "${r.reminder.text}"`;
      }
      case 'remind-error':
        return reminderError(cmd.error);
      case 'todo-add': {
        const r = this.addTodo(cmd.text);
        if (r.error) return r.error === 'full' ? 'Your list is full, Prince! Finish a few first 😅' : 'Add what, Prince? Try: "add to my list: physics homework"';
        if (r.duplicate) return `"${r.todo.text}" is already on your list, Prince 😼`;
        const n = this.openTodos().length;
        return `Added ✓ "${r.todo.text}" (${n} thing${n === 1 ? '' : 's'} on your list).`;
      }
      case 'todo-done': {
        const r = this.completeTodo(cmd.n);
        if (r.error) return numberError(cmd.n, r.count, 'list');
        return `Shabash Prince! ✓ "${r.todo.text}" done. ${r.left ? `${r.left} left.` : 'List is empty - full chill 😎'}`;
      }
      case 'todo-remove': {
        const r = this.removeTodo(cmd.n);
        if (r.error) return numberError(cmd.n, r.count, 'list');
        return `Removed "${r.todo.text}" from your list.`;
      }
      case 'todo-list': {
        const open = this.openTodos();
        if (!open.length) return 'Your list is empty, Prince. Full chill 😎 Add one with "todo: ..."';
        return `Your list: ${open.map((t, i) => `${i + 1}. ${t.text}`).join(' · ')}`;
      }
      case 'reminder-list': {
        const list = this.pendingReminders();
        if (!list.length) return 'No reminders set, Prince. Try "remind me in 20 min to drink water".';
        return `Your reminders: ${list.map((r, i) => `${i + 1}. ${whenLabel(r.at, now)} - ${r.text}`).join(' · ')}`;
      }
      case 'reminder-cancel': {
        const r = this.cancelReminder(cmd.n);
        if (r.error) return numberError(cmd.n, r.count, 'reminders');
        return `Cancelled ✓ "${r.reminder.text}".`;
      }
      default:
        return '';
    }
  }

  /** What the chat AI knows (and can change) about Prince's list and reminders. */
  chatContext(now = this.clock()) {
    const open = this.openTodos();
    const rem = this.pendingReminders();
    return [
      "Prince's to-do list (open items, numbered):",
      open.length ? open.map((t, i) => `${i + 1}. ${t.text}`).join('\n') : '(empty)',
      'One-time reminders Prince has set (numbered):',
      rem.length ? rem.map((r, i) => `${i + 1}. ${whenLabel(r.at, now)}: ${r.text}`).join('\n') : '(none)',
      '',
      AI_INSTRUCTIONS,
    ].join('\n');
  }

  /**
   * Run the hidden [[...]] commands in an AI reply. Returns { text, actions } where text is the
   * reply without the commands (plus a short confirmation if the AI forgot to mention it).
   */
  applyTags(reply, now = this.clock()) {
    const todoIds = this.openTodos().map((t) => t.id); // numbers refer to the list the AI saw
    const remIds = this.pendingReminders().map((r) => r.id);
    const actions = [];
    const text = String(reply || '').replace(/\[\[([^\]]{1,400})\]\]/g, (_, body) => {
      const parts = body.split('|').map((s) => s.trim());
      const head = parts[0].toLowerCase().replace(/\s+/g, ' ');
      let ok = false;
      let note = '';
      if (head === 'remind' && parts.length >= 3) {
        const at = parseIsoLocal(parts[1]);
        const r = this.addReminder(at, parts.slice(2).join(' | '));
        ok = !r.error;
        note = ok ? `⏰ ${whenLabel(r.reminder.at, now)}: ${r.reminder.text}` : `couldn't set that reminder (${r.error === 'past' ? 'time already passed' : 'bad time'})`;
      } else if (head === 'todo add' && parts[1]) {
        const r = this.addTodo(parts.slice(1).join(' | '));
        ok = !r.error;
        note = ok ? `✓ added: ${r.todo.text}` : "couldn't add that to-do";
      } else if ((head === 'todo done' || head === 'todo remove') && parts[1]) {
        const r = head === 'todo done' ? this.completeTodo(parseInt(parts[1], 10), todoIds) : this.removeTodo(parseInt(parts[1], 10), todoIds);
        ok = !r.error;
        note = ok ? `✓ ${head === 'todo done' ? 'done' : 'removed'}: ${r.todo.text}` : `no to-do number ${parts[1]}`;
      } else if (head === 'reminder cancel' && parts[1]) {
        const r = this.cancelReminder(parseInt(parts[1], 10), remIds);
        ok = !r.error;
        note = ok ? `✓ cancelled: ${r.reminder.text}` : `no reminder number ${parts[1]}`;
      } else {
        return '';
      }
      actions.push({ ok, note });
      return '';
    });
    let clean = text.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
    const failed = actions.filter((a) => !a.ok);
    if (!clean && actions.length) clean = actions.map((a) => a.note).join(' · ');
    else if (failed.length) clean += ` (⚠ ${failed.map((a) => a.note).join('; ')})`;
    else if (actions.some((a) => a.note.startsWith('⏰')) && !/remind|⏰|\d(:\d\d)?\s*(am|pm)/i.test(clean)) {
      clean += ` ${actions.filter((a) => a.note.startsWith('⏰')).map((a) => a.note).join(' · ')}`;
    }
    return { text: clean, actions };
  }

  // -------------------------------------------------------------- morning briefing + nudges
  briefingDue(now = this.clock()) {
    return new Date(now).getHours() >= 5 && this.data.lastBriefing !== dayKey(now);
  }

  markBriefed(now = this.clock()) {
    this.data.lastBriefing = dayKey(now);
    this.save();
  }

  /** One short bubble: today's calendar, open to-dos and today's reminders. */
  briefing(now = this.clock(), events = null) {
    const h = new Date(now).getHours();
    const hello = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const short = (s, n = 24) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const parts = [`${hello}, Prince!`];
    if (events) {
      const end = startOfDay(now) + DAY;
      const today = events.filter((e) => (e.allDay ? e.start <= now && e.start + DAY > now : e.start >= now - 30 * MIN && e.start < end));
      if (!today.length) parts.push('Calendar is free today 🎉');
      else {
        const shown = today.slice(0, 3).map((e) => (e.allDay ? short(e.title) : `${short(e.title)} ${clock12(e.start).replace(':00', '')}`));
        parts.push(`Today: ${shown.join(', ')}${today.length > 3 ? ` +${today.length - 3} more` : ''}.`);
      }
    }
    const open = this.openTodos();
    if (open.length) parts.push(`📝 ${open.length} to-do${open.length === 1 ? '' : 's'} (top: ${short(open[0].text, 28)}).`);
    const remToday = this.pendingReminders().filter((r) => r.at < startOfDay(now) + DAY);
    if (remToday.length) parts.push(`⏰ ${remToday.length} reminder${remToday.length === 1 ? '' : 's'} today.`);
    if (parts.length === 1) parts.push('Nothing on your plate - aaj full chill 😎');
    return parts.join(' ');
  }

  /** An idle-quip replacement nagging about an open to-do (at most every 2 hours). */
  nudge(now = this.clock(), random = Math.random) {
    const open = this.openTodos();
    if (!open.length || now - this.data.lastNudge < 2 * HOUR || random() < 0.5) return null;
    this.data.lastNudge = now;
    this.save();
    const t = open[Math.floor(random() * open.length)].text;
    const lines = [
      `Prince, "${t}" abhi bhi pending hai 👀`,
      `Psst... "${t}" is still on your list.`,
      `Finish "${t}" and I'll purr for you 😼`,
      `Chalo Prince, "${t}" ho jaye? Just saying 🐾`,
    ];
    return lines[Math.floor(random() * lines.length)];
  }
}

const AI_INSTRUCTIONS = [
  'You can set one-time reminders and manage the to-do list. To do it, END your reply with one or more commands,',
  'each on its own line, exactly in this format (Prince never sees them):',
  '[[remind | YYYY-MM-DD HH:MM | what to remind]]   (local time, 24-hour clock, must be in the future)',
  '[[todo add | text]]',
  '[[todo done | N]]      (N = the number in the to-do list above)',
  '[[todo remove | N]]',
  '[[reminder cancel | N]]',
  'Only use a command when Prince clearly asks. When you use one, say what you did (e.g. "Done, I\'ll remind you at 6 PM").',
  'Never say you set or changed something without the command. You cannot make repeating reminders.',
].join('\n');

function parseIsoLocal(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}

function reminderError(kind) {
  if (kind === 'past') return 'That time has already passed, Prince ⏳ Try a later time.';
  if (kind === 'far') return "That's too far away for my little brain - pick something within a year.";
  if (kind === 'full') return 'Too many reminders, Prince! Cancel some first.';
  return 'I didn\'t catch the time, Prince. Try: "remind me at 6 pm to call Mom" or "remind me in 20 min to drink water".';
}

function numberError(n, count, what) {
  if (!count) return what === 'list' ? 'Your list is empty, Prince 😎' : 'You have no reminders, Prince.';
  return `There's no number ${n}, Prince - you have ${count} ${what === 'list' ? `thing${count === 1 ? '' : 's'} on your list` : `reminder${count === 1 ? '' : 's'}`}.`;
}

module.exports = { TaskStore, parseCommand, resolveTime, whenLabel, clock12, AI_INSTRUCTIONS };
