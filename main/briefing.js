'use strict';
/*
 * briefing.js - the HUD's two reports.
 *
 *   MISSION BRIEFING   15 minutes after you open the laptop (Windows starts, it wakes from sleep, or you
 *                      unlock it after a while): today's schedule, exams, to-dos, weather, heads-ups.
 *   MISSION DEBRIEF    every 12 hours (Settings → HUD, default 9 PM and 9 AM): screen time, what got done,
 *                      what's still open and what's next. Away from the PC? It goes to your phone.
 *
 * Chat: "brief me" / "my day" · "debrief" / "how was my day" (from the phone: as text).
 *
 * The activity log (activity.json) only keeps counts and short labels for 3 days: minutes at the PC
 * per hour, files sent/received, songs played, reminders delivered, games. Nothing else is recorded.
 */

const fs = require('fs');
const path = require('path');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KEEP = 3 * DAY;

const pad = (n) => String(n).padStart(2, '0');
const hourKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
};
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const keyMs = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
function clock12(ms) {
  const d = new Date(ms);
  return `${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
const short = (s, n = 48) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function duration(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h ? `${h}h ${pad(m)}m` : `${m}m`;
}
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const KIND = { learn: '📖', revise: '🔁', mock: '📝', light: '🌙' };

// ------------------------------------------------------------------ activity log
class ActivityLog {
  constructor({ file, clock = () => Date.now() }) {
    this.file = file;
    this.clock = clock;
    this.data = { events: [], active: {}, lastBriefAt: 0, lastDebriefSlot: '' };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw.events)) this.data.events = raw.events.filter((e) => e && Number.isFinite(e.t) && typeof e.kind === 'string');
      if (raw.active && typeof raw.active === 'object') this.data.active = Object.fromEntries(Object.entries(raw.active).filter(([, v]) => Number.isFinite(v)));
      this.data.lastBriefAt = Number(raw.lastBriefAt) || 0;
      this.data.lastDebriefSlot = typeof raw.lastDebriefSlot === 'string' ? raw.lastDebriefSlot : '';
    } catch {
      /* first run */
    }
    this.timer = null;
  }

  /** Something happened: 'file-sent' | 'file-received' | 'song' | 'reminder' | 'game' | 'study' */
  note(kind, text = '') {
    this.data.events.push({ t: this.clock(), kind, text: short(String(text || ''), 60) });
    this.saveSoon();
  }

  /** Called every minute: one more minute at the PC (when it wasn't idle). */
  minute(active) {
    if (!active) return;
    const k = hourKey(this.clock());
    this.data.active[k] = Math.min(60, (this.data.active[k] || 0) + 1);
    this.saveSoon();
  }

  activeMinutes(from, to) {
    let n = 0;
    for (const [k, v] of Object.entries(this.data.active)) {
      const [d, h] = k.split('T');
      const start = keyMs(d) + Number(h) * HOUR;
      if (start + HOUR <= from || start >= to) continue;
      // the hour the window starts in counts in proportion; the current hour's minutes all happened already
      n += start < from ? (v * (start + HOUR - from)) / HOUR : v;
    }
    return Math.round(n);
  }

  events(from, to, kind) {
    return this.data.events.filter((e) => e.t >= from && e.t < to && (!kind || e.kind === kind));
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  prune() {
    const cut = this.clock() - KEEP;
    this.data.events = this.data.events.filter((e) => e.t >= cut).slice(-500);
    for (const k of Object.keys(this.data.active)) {
      const [d, h] = k.split('T');
      if (keyMs(d) + Number(h) * HOUR < cut) delete this.data.active[k];
    }
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 5000);
  }

  save() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    this.prune();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[activity] could not save:', err.message);
    }
  }
}

// ------------------------------------------------------------------ the reports
/**
 * Report shape (what the HUD's centre card shows, and what the phone gets as text):
 * { kind: 'brief'|'debrief', title, sub, summary, tiles: [{ icon, value, label, tone }],
 *   sections: [{ title, items: [{ icon, text, when, tone }] }] }
 */
function hello(now) {
  const h = new Date(now).getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

/** Today's calendar events still worth mentioning, sorted. */
function eventsBetween(calendar, from, to) {
  if (!calendar || !calendar.url || !calendar.url()) return [];
  return (calendar.upcoming || [])
    .filter((o) => (o.allDay ? o.start < to && o.start + DAY > from : o.start >= from - 30 * MIN && o.start < to))
    .sort((a, b) => a.start - b.start);
}

function examLines(exams, now) {
  if (!exams) return { next: null, today: [] };
  const list = exams.upcoming();
  const next = list[0] ? { subject: list[0].subject || 'Exam', days: Math.round((keyMs(list[0].date) - keyMs(dayKey(now))) / DAY), countdown: exams.countdown(list[0]) } : null;
  const today = exams.today().map(({ exam, day }) => ({ subject: exam.subject || 'Exam', icon: KIND[day.kind] || '📖', text: `${day.kind === 'revise' ? 'Revise ' : day.kind === 'mock' ? 'Mock test: ' : ''}${day.topics.join(', ')}`, done: !!day.done }));
  return { next, today, later: list.slice(1, 3).map((e) => ({ subject: e.subject || 'Exam', days: Math.round((keyMs(e.date) - keyMs(dayKey(now))) / DAY) })) };
}

/** Morning (or any-time) briefing: the day ahead. */
function buildBrief({ now = Date.now(), tasks, exams, calendar, weather, sys = {}, studyTime = '18:00', updateReady = false }) {
  const endOfDay = new Date(now).setHours(23, 59, 59, 999);
  const events = eventsBetween(calendar, now, endOfDay);
  const ex = examLines(exams, now);
  const todos = tasks ? tasks.openTodos() : [];
  const rems = tasks ? tasks.pendingReminders().filter((r) => r.at <= endOfDay) : [];
  const w = weather && weather.ok ? weather : null;

  const tiles = [];
  if (w) tiles.push({ icon: w.now.icon, value: `${w.now.temp}°`, label: w.place.toUpperCase(), tone: w.today.rain >= 50 ? 'warn' : '' });
  tiles.push({ icon: '📅', value: String(events.length), label: events.length === 1 ? 'EVENT' : 'EVENTS', tone: '' });
  if (ex.next) tiles.push({ icon: '📚', value: ex.next.days <= 0 ? 'TODAY' : `${ex.next.days}d`, label: `${ex.next.subject.toUpperCase()} EXAM`, tone: ex.next.days <= 2 ? 'warn' : '' });
  tiles.push({ icon: '📝', value: String(todos.length), label: todos.length === 1 ? 'TO-DO' : 'TO-DOS', tone: '' });
  tiles.push({ icon: '⏰', value: String(rems.length), label: rems.length === 1 ? 'REMINDER' : 'REMINDERS', tone: '' });

  // the day, in time order
  const schedule = [
    ...events.map((e) => ({ at: e.allDay ? 0 : e.start, icon: '📅', text: short(e.title), when: e.allDay ? 'ALL DAY' : clock12(e.start), tone: !e.allDay && e.start - now < HOUR ? 'warn' : '' })),
    ...rems.map((r) => ({ at: r.at, icon: '⏰', text: short(r.text), when: clock12(r.at), tone: '' })),
  ];
  if (ex.today.length) {
    const [h, m] = studyTime.split(':').map(Number);
    const at = new Date(now).setHours(h, m, 0, 0);
    schedule.push({ at, icon: '📚', text: short(ex.today.map((t) => `${t.subject}: ${t.text}`).join(' + '), 60), when: clock12(at), tone: ex.today.every((t) => t.done) ? 'good' : '' });
  }
  schedule.sort((a, b) => a.at - b.at);

  const heads = [];
  if (w && w.today.rain !== null && w.today.rain >= 50) heads.push({ icon: '☔', text: `Rain likely today (${w.today.rain}%) - carry an umbrella`, tone: 'warn' });
  if (ex.next && ex.next.days === 0) heads.push({ icon: '🎯', text: `${ex.next.subject} exam is TODAY - you've got this`, tone: 'warn' });
  else if (ex.next && ex.next.days === 1) heads.push({ icon: '📚', text: `${ex.next.subject} exam tomorrow - final revision today`, tone: 'warn' });
  if (sys.battery && !sys.battery.charging && sys.battery.percent <= 30) heads.push({ icon: '🔋', text: `Battery at ${Math.round(sys.battery.percent)}% - plug in`, tone: 'bad' });
  if (sys.disk && sys.disk.free < 10 * 1024 ** 3) heads.push({ icon: '💾', text: 'Storage almost full - say "tidy my downloads"', tone: 'bad' });
  if (updateReady) heads.push({ icon: '✨', text: 'A Shadow update is ready - restart it from the tray', tone: '' });
  if (sys.uptimeH >= 7 * 24) heads.push({ icon: '🔄', text: `PC running for ${Math.floor(sys.uptimeH / 24)} days - a restart would help`, tone: '' });

  const sections = [];
  sections.push({ title: "TODAY'S SCHEDULE", items: schedule.length ? schedule.slice(0, 6) : [{ icon: '🎉', text: 'Nothing scheduled - a free day', when: '', tone: 'good' }] });
  if (todos.length) sections.push({ title: `OBJECTIVES · ${todos.length}`, items: todos.slice(0, 4).map((t) => ({ icon: '☐', text: short(t.text), when: '', tone: '' })) });
  if (heads.length) sections.push({ title: 'HEADS-UP', items: heads });

  // one or two sentences, J.A.R.V.I.S. style
  const parts = [];
  const timed = events.filter((e) => !e.allDay);
  if (timed.length) parts.push(`${plural(timed.length, 'event')} today, first ${short(timed[0].title, 30)} at ${clock12(timed[0].start)}`);
  if (ex.today.length) parts.push(`study ${short(ex.today.map((t) => `${t.subject}: ${t.text}`).join(' + '), 50)}`);
  else if (ex.next) parts.push(`${ex.next.subject} exam ${ex.next.countdown}`);
  if (todos.length) parts.push(plural(todos.length, 'to-do'));
  let summary = `${hello(now)}, Prince. ${parts.length ? `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : 'Your schedule is clear today.'}`;
  if (w) summary += ` ${w.place}: ${w.now.temp}°C, ${w.now.text.toLowerCase()}${w.today.rain >= 50 ? ' - rain likely, take an umbrella' : ''}.`;
  const d = new Date(now);
  return { kind: 'brief', title: 'MISSION BRIEFING', sub: `${DAYS[d.getDay()]} · ${d.getDate()} ${MONTHS[d.getMonth()]}`, summary, tiles: tiles.slice(0, 5), sections };
}

/** The last 12 hours, and what's next. */
function buildDebrief({ now = Date.now(), from = now - 12 * HOUR, log, tasks, exams, calendar, weather }) {
  const mins = log ? log.activeMinutes(from, now) : 0;
  const done = tasks ? tasks.data.todos.filter((t) => t.done && t.doneAt >= from && t.doneAt < now) : [];
  const open = tasks ? tasks.openTodos() : [];
  const ev = (k) => (log ? log.events(from, now, k) : []);
  const sent = ev('file-sent');
  const got = ev('file-received');
  const songs = ev('song');
  const reminded = ev('reminder');
  const games = ev('game');
  const studied = ev('study');
  const ex = examLines(exams, now);
  const until = now + 12 * HOUR;

  const tiles = [
    { icon: '⏱️', value: duration(mins), label: 'SCREEN TIME', tone: mins >= 8 * 60 ? 'warn' : '' },
    { icon: '✅', value: String(done.length), label: 'TASKS DONE', tone: done.length ? 'good' : '' },
    { icon: '📚', value: studied.length ? '✓' : ex.today.length ? '–' : '·', label: 'STUDY', tone: studied.length ? 'good' : ex.today.length ? 'warn' : '' },
    { icon: '⏰', value: String(reminded.length), label: 'REMINDERS', tone: '' },
    { icon: '📤', value: String(sent.length + got.length), label: 'FILES', tone: '' },
  ];
  if (songs.length) tiles.push({ icon: '🎵', value: String(songs.length), label: songs.length === 1 ? 'SONG' : 'SONGS', tone: '' });

  const completed = [
    ...done.map((t) => ({ at: t.doneAt, icon: '✅', text: short(t.text), when: clock12(t.doneAt), tone: 'good' })),
    ...studied.map((e) => ({ at: e.t, icon: '📚', text: short(e.text || 'Study session'), when: clock12(e.t), tone: 'good' })),
    ...sent.map((e) => ({ at: e.t, icon: '📤', text: `Sent ${short(e.text, 40)} to your phone`, when: clock12(e.t), tone: '' })),
    ...got.map((e) => ({ at: e.t, icon: '📥', text: `Got ${short(e.text, 40)} from your phone`, when: clock12(e.t), tone: '' })),
    ...games.map((e) => ({ at: e.t, icon: '🎮', text: short(e.text || 'Game'), when: clock12(e.t), tone: '' })),
  ].sort((a, b) => a.at - b.at);

  const next = [
    ...eventsBetween(calendar, now, until).map((e) => ({ at: e.allDay ? e.start : e.start, icon: '📅', text: short(e.title), when: e.allDay ? 'ALL DAY' : clock12(e.start), tone: '' })),
    ...(tasks ? tasks.pendingReminders().filter((r) => r.at < until) : []).map((r) => ({ at: r.at, icon: '⏰', text: short(r.text), when: clock12(r.at), tone: '' })),
  ].sort((a, b) => a.at - b.at);
  if (ex.next && ex.next.days <= 3) next.push({ at: until, icon: '📚', text: `${ex.next.subject} exam ${ex.next.countdown}`, when: '', tone: ex.next.days <= 1 ? 'warn' : '' });
  if (weather && weather.ok && weather.tomorrow && weather.tomorrow.rain !== null && weather.tomorrow.rain >= 50) next.push({ at: until, icon: '☔', text: `Rain likely tomorrow (${weather.tomorrow.rain}%)`, when: '', tone: 'warn' });

  const sections = [
    { title: 'COMPLETED', items: completed.length ? completed.slice(-5) : [{ icon: '·', text: 'Nothing ticked off in these 12 hours', when: '', tone: '' }] },
    { title: `STILL OPEN · ${open.length}`, items: open.length ? open.slice(0, 3).map((t) => ({ icon: '☐', text: short(t.text), when: '', tone: '' })) : [{ icon: '🎉', text: 'All objectives clear', when: '', tone: 'good' }] },
    { title: 'NEXT 12 HOURS', items: next.length ? next.slice(0, 4) : [{ icon: '🌙', text: 'Nothing scheduled', when: '', tone: '' }] },
  ];

  const bits = [`${duration(mins)} at the PC`];
  bits.push(done.length ? `${plural(done.length, 'task')} done` : 'no tasks ticked off');
  if (studied.length) bits.push('study done');
  if (sent.length + got.length) bits.push(plural(sent.length + got.length, 'file') + ' moved');
  let summary = `Last 12 hours: ${bits.join(', ')}.`;
  if (mins >= 8 * 60) summary += ' That is a long shift - take a real break, Prince.';
  else if (done.length >= 3) summary += ' Strong work, Prince.';
  else if (open.length) summary += ` ${plural(open.length, 'objective')} still open - pick one for next.`;
  if (next.length && next[0].when) summary += ` Next up: ${next[0].text} at ${next[0].when}.`;
  return { kind: 'debrief', title: 'MISSION DEBRIEF', sub: `LAST 12 HOURS · ${clock12(from)} – ${clock12(now)}`, summary, tiles, sections };
}

/** A report as a phone message. */
function reportText(r) {
  const lines = [`${r.kind === 'brief' ? '☀️' : '📊'} ${r.title} - ${r.sub}`, r.summary];
  for (const s of r.sections) {
    lines.push('', s.title);
    for (const i of s.items) lines.push(`${i.icon} ${i.text}${i.when ? ` - ${i.when}` : ''}`);
  }
  return lines.join('\n');
}

/** "brief me" / "debrief" in chat. */
function parseReportCommand(input) {
  const l = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:hey |ok )?(?:jarvis|shadow)[,:!]?\s*/, '')
    .replace(/^(?:please|pls|can you|could you)\s+/, '')
    .replace(/[?.!]+$/, '');
  if (/^(?:brief me(?: (?:on|about) (?:my|the) day)?|(?:my |the |daily |morning )?briefing|(?:what'?s|whats|what is) (?:my|the) day(?: look(?:ing)? like)?|my day|plan (?:for|of) (?:my |the )?day|how does my day look)$/.test(l)) return { type: 'brief' };
  if (/^(?:debrief(?: me)?|(?:my |the |mission )?debrief(?:ing)?|mission report|how was my day|how(?:'s| has| is) my day (?:been|going)|what did i do today|(?:my )?day report)$/.test(l)) return { type: 'debrief' };
  return null;
}

// ------------------------------------------------------------------ when they happen
/**
 * Decides when the briefing and the debrief show. main.js calls opened() / suspended() on the power
 * events and tick() every 30 seconds.
 */
class ReportScheduler {
  /**
   * @param {object} o
   * @param {ActivityLog} o.log
   * @param {() => number} o.idleSeconds
   * @param {(kind) => boolean} o.show   puts the report on the HUD (false = can't right now)
   * @param {(kind) => boolean} o.phone  sends it to the phone (false = no phone)
   */
  constructor({ settings, log, idleSeconds, show, phone, clock = () => Date.now(), busy = () => false }) {
    this.settings = settings;
    this.log = log;
    this.idleSeconds = idleSeconds;
    this.show = show;
    this.phone = phone;
    this.clock = clock;
    this.busy = busy;
    this.pending = null; // { at, until, why } - the briefing waiting for its 15 minutes
    if (!this.log.data.lastDebriefSlot) this.log.set({ lastDebriefSlot: this.slotKey(this.currentSlot()) }); // never right after installing
  }

  /** The laptop was opened: Windows started, woke up, or was unlocked after a while. */
  opened(why) {
    if (!this.settings.get('hudBrief')) return false;
    const now = this.clock();
    if (now - (this.log.data.lastBriefAt || 0) < 3 * HOUR) return false; // just briefed - don't repeat
    const delay = this.settings.get('hudBriefDelay') * MIN;
    this.pending = { at: now + delay, until: now + delay + 2 * HOUR, why };
    return true;
  }

  /** Closed again before the 15 minutes were up: start over next time. */
  suspended() {
    this.pending = null;
  }

  /** The last debrief time at or before now (9 PM / 9 AM by default). */
  currentSlot(now = this.clock()) {
    const [h, m] = String(this.settings.get('hudDebriefTime') || '21:00').split(':').map(Number);
    const d = new Date(now);
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
    const slots = [a - DAY, a - 12 * HOUR, a, a + 12 * HOUR].filter((t) => t <= now);
    return slots[slots.length - 1];
  }

  slotKey(t) {
    const d = new Date(t);
    return `${dayKey(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Every 30 s. Returns what it did ('brief' / 'debrief' / 'debrief-phone' / null). */
  tick() {
    const now = this.clock();
    const here = this.idleSeconds() <= 90;
    if (this.pending) {
      if (now > this.pending.until) this.pending = null;
      else if (now >= this.pending.at && here && !this.busy() && this.show('brief')) {
        this.pending = null;
        this.log.set({ lastBriefAt: now });
        return 'brief';
      }
    }
    if (!this.settings.get('hudDebrief')) return null;
    const slot = this.currentSlot(now);
    const key = this.slotKey(slot);
    if (key === this.log.data.lastDebriefSlot) return null;
    if (now - slot > 3 * HOUR) {
      this.log.set({ lastDebriefSlot: key }); // the PC was off - an old debrief isn't worth showing
      return null;
    }
    if (now - (this.log.data.lastBriefAt || 0) < 20 * MIN) return null; // right after a briefing: give it a moment
    if (here && !this.busy() && this.show('debrief')) {
      this.log.set({ lastDebriefSlot: key });
      return 'debrief';
    }
    if (!here && now - slot >= 30 * MIN && this.phone('debrief')) {
      this.log.set({ lastDebriefSlot: key });
      return 'debrief-phone';
    }
    return null;
  }
}

module.exports = { ActivityLog, ReportScheduler, buildBrief, buildDebrief, reportText, parseReportCommand, duration };
