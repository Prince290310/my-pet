'use strict';
/*
 * exams.js - the exam planner (Sage the owl's other job).
 *
 *   maths exam on 20 nov chapters 1-8          physics exam is on 5th december: optics, waves, heat
 *   exam on 12/11 units 3 to 6                 my exams / exam plan / what should I study today
 *   done studying (or "studied today")         cancel my maths exam
 *
 * Sage spreads the chapters over the days before the exam (new chapters first, revision days in
 * between, a full revision + practice paper near the end, light revision the day before). Every day
 * at the study time (Settings → Exam planner) Shadow reminds you what's on for today, and "quiz me"
 * then quizzes you on exactly those chapters. The morning briefing counts down too.
 * Saved in %APPDATA%\Shadow\exams.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MAX_TOPICS = 40;
const MAX_EXAMS = 12;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const startOfDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const fromKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const daysBetween = (aKey, bKey) => Math.round((fromKey(bKey) - fromKey(aKey)) / DAY);
const addDays = (key, n) => {
  const d = new Date(fromKey(key));
  d.setDate(d.getDate() + n);
  return dayKey(d.getTime());
};
const nice = (key) => new Date(fromKey(key)).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The date at the start of `s` -> { key: 'YYYY-MM-DD', rest } or null.
 * 20 nov · 20th November 2026 · nov 20 · 20/11 · 20-11-26 · tomorrow · in 10 days · next friday · friday
 */
function parseDate(s, now = Date.now()) {
  const t = String(s || '').trim().toLowerCase();
  const today = startOfDay(now);
  const yearOf = (y) => (y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : null);
  const build = (day, month, year) => {
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    let y = year || new Date(now).getFullYear();
    let d = new Date(y, month, day);
    if (d.getMonth() !== month) return null; // 31 Feb
    if (!year && d.getTime() < today) d = new Date(++y, month, day); // already passed this year
    return dayKey(d.getTime());
  };
  let m;
  if ((m = /^(?:the )?(\d{1,2})(?:st|nd|rd|th)?(?: of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,? (\d{4}))?\b/.exec(t))) {
    const key = build(Number(m[1]), MONTHS.indexOf(m[2].slice(0, 3)), yearOf(m[3]));
    return key && { key, rest: t.slice(m[0].length) };
  }
  if ((m = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?\b/.exec(t))) {
    const key = build(Number(m[2]), MONTHS.indexOf(m[1].slice(0, 3)), yearOf(m[3]));
    return key && { key, rest: t.slice(m[0].length) };
  }
  if ((m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?\b/.exec(t))) {
    const key = build(Number(m[1]), Number(m[2]) - 1, yearOf(m[3])); // Indian order: day/month
    return key && { key, rest: t.slice(m[0].length) };
  }
  if ((m = /^(?:the )?day after tomorrow\b/.exec(t))) return { key: dayKey(today + 2 * DAY + DAY / 2), rest: t.slice(m[0].length) };
  if ((m = /^(?:tomorrow|tmrw|tmr)\b/.exec(t))) return { key: dayKey(today + DAY + DAY / 2), rest: t.slice(m[0].length) };
  if ((m = /^in (\d{1,3}) days?\b/.exec(t))) return { key: dayKey(today + Number(m[1]) * DAY + DAY / 2), rest: t.slice(m[0].length) };
  if ((m = /^in (a|one|two|three|\d) weeks?\b/.exec(t))) {
    const n = { a: 1, one: 1, two: 2, three: 3 }[m[1]] || Number(m[1]);
    return { key: dayKey(today + n * 7 * DAY + DAY / 2), rest: t.slice(m[0].length) };
  }
  if ((m = /^(next |this |coming )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*\b/.exec(t))) {
    const want = WEEKDAYS.findIndex((w) => w.startsWith(m[2].slice(0, 3)));
    let diff = (want - new Date(now).getDay() + 7) % 7 || 7;
    if (m[1] === 'next ' && diff < 7) diff += 0; // "next friday" = the coming one, like people mean it
    return { key: dayKey(today + diff * DAY + DAY / 2), rest: t.slice(m[0].length) };
  }
  return null;
}

/** "chapters 1-8" / "ch 2, 4 and 7" / "units 3 to 6" / "optics, waves and heat" -> topic names. */
function parseTopics(s) {
  let t = String(s || '')
    .trim()
    .replace(/^[,:;–—-]+\s*/, '')
    .replace(/^(?:and |with |covering |cover |syllabus:? |portion:? |for |of )+/i, '')
    .replace(/[.!]+$/, '')
    .trim();
  if (!t) return [];
  const m = /^(chapters?|chaps?|ch\.?|units?|lessons?|modules?|topics?|lectures?)\s*:?\s*(.*)$/i.exec(t);
  let label = 'Chapter';
  if (m) {
    const w = m[1].toLowerCase();
    label = /^unit/.test(w) ? 'Unit' : /^lesson/.test(w) ? 'Lesson' : /^module/.test(w) ? 'Module' : /^lecture/.test(w) ? 'Lecture' : /^topic/.test(w) ? '' : 'Chapter';
    t = m[2].trim();
  }
  const out = [];
  for (const part of t.split(/\s*(?:,|;|&|\band\b|\bplus\b)\s*/i).filter(Boolean)) {
    const r = /^(\d{1,3})\s*(?:-|–|—|to|till|through)\s*(\d{1,3})$/i.exec(part);
    if (r && label) {
      const a = Number(r[1]);
      const b = Number(r[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b) && out.length < MAX_TOPICS; i++) out.push(`${label} ${i}`);
    } else if (/^\d{1,3}$/.test(part) && label) out.push(`${label} ${part}`);
    else out.push(cap(part.replace(/^(?:chapter|ch\.?|unit)\s*/i, (x) => x).slice(0, 60)));
    if (out.length >= MAX_TOPICS) break;
  }
  return [...new Set(out)];
}

const clean = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey |ok |okay )?(?:shadow|sage)?[,:!]?\s*/i, '')
    .replace(/^(?:please|pls|plz|can you|could you)\s+/i, '')
    .replace(/[?!]+$/, '')
    .trim();

/** Chat message -> exam command, or null. */
function parseExamCommand(input, now = Date.now()) {
  const t = clean(input);
  const l = t.toLowerCase().replace(/\.$/, '');
  let m;
  if (/^(?:show |see |what'?s |whats )?(?:my |the )?(?:exams?|exam (?:plans?|schedule|timetable|list)|test (?:plans?|schedule|timetable))$|^(?:show |see )?(?:my |the )?(?:study|revision) (?:plan|schedule|timetable)$|^(?:when (?:are|is) my (?:next )?exams?)$/.test(l)) {
    return { type: 'show' };
  }
  if (/^what (?:should|do|shall) i (?:study|revise|read)(?: today)?$|^what'?s (?:on )?(?:my )?(?:study|revision)(?: plan)? (?:for )?today$|^today'?s (?:study|revision)(?: plan)?$/.test(l)) return { type: 'today' };
  if (/^(?:i'?m |i am )?(?:done|finished)(?: with)? (?:studying|study|revision|revising|today'?s (?:study|revision|chapters?|plan))(?: for today| today)?$|^(?:i )?(?:studied|revised)(?: today| everything| it all)?$/.test(l)) return { type: 'done' };
  if ((m = /^(?:cancel|delete|remove|forget|drop)(?: my| the)? (.{0,30}?) ?(?:exam|test)(?: plan)?$/.exec(l))) return { type: 'cancel', subject: m[1].trim() };
  // "<subject> exam on <date> <topics>"
  if ((m = /^(?:i have |i've got |ive got |i got |my |add |there'?s |new )?(?:an? |the )?(?:([a-z][\w&+.-]*(?: [\w&+.-]+){0,2}) )?(exam|test|paper|exams|board exam|final exam|finals)(?: is| will be)? (?:on|for|at) (.+)$/i.exec(t))) {
    let subject = (m[1] || '').replace(/^(?:my|the|an?|add)\s+/i, '').trim();
    if (/^(?:the|my|an?|add)$/i.test(subject)) subject = '';
    const d = parseDate(m[3], now);
    // "write a unit test for my code" is not an exam - only ask for a date when it clearly is one
    if (!d) return /exam|finals/i.test(m[2]) ? { type: 'add', error: 'date' } : null;
    const topics = parseTopics(d.rest);
    return { type: 'add', subject: subject ? cap(subject.slice(0, 30)) : '', date: d.key, topics };
  }
  return null;
}

/**
 * Day-by-day plan from `startKey` up to the day before `examKey`.
 * Returns [{ date, kind: 'learn'|'revise'|'mock'|'light', topics }].
 */
function buildPlan(topics, startKey, examKey) {
  const total = daysBetween(startKey, examKey); // study days before the exam
  if (total <= 0) return [];
  const T = topics.length;
  // don't stretch 3 chapters over 3 months: start about 3 days per topic (+ review days) before
  const want = Math.max(5, T * 3 + 3);
  const days = Math.min(total, want, 45);
  const first = addDays(examKey, -days);
  const plan = [];
  const light = days >= 2 ? 1 : 0; // the day before: light revision
  const mock = days >= 5 ? (days >= 12 ? 2 : 1) : 0; // full revision + practice paper
  const learn = days - light - mock;
  for (let i = 0; i < learn; i++) {
    const date = addDays(first, i);
    if (!T) {
      plan.push({ date, kind: 'revise', topics: ['Your notes + practice questions'] });
      continue;
    }
    const a = Math.ceil((i * T) / learn);
    const b = Math.ceil(((i + 1) * T) / learn);
    if (b > a) plan.push({ date, kind: 'learn', topics: topics.slice(a, b) });
    else plan.push({ date, kind: 'revise', topics: topics.slice(Math.max(0, a - 2), a) });
  }
  for (let i = 0; i < mock; i++) plan.push({ date: addDays(first, learn + i), kind: 'mock', topics: [i === mock - 1 ? 'Practice paper (time yourself!)' : 'Full revision of everything'] });
  if (light) plan.push({ date: addDays(examKey, -1), kind: 'light', topics: ['Light revision + early sleep 😴'] });
  return plan;
}

const KIND_ICON = { learn: '📖', revise: '🔁', mock: '📝', light: '🌙' };
const dayText = (d) => `${KIND_ICON[d.kind] || '📖'} ${d.kind === 'revise' ? 'Revise ' : ''}${d.topics.join(', ')}`;

class ExamPlanner {
  constructor({ file, clock = () => Date.now() }) {
    this.file = file;
    this.clock = clock;
    this.data = { exams: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && Array.isArray(raw.exams)) this.data.exams = raw.exams.filter((e) => e && /^\d{4}-\d\d-\d\d$/.test(e.date) && Array.isArray(e.plan));
    } catch {
      /* first run */
    }
    this.prune();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn('[exams] could not save:', err.message);
    }
  }

  /** Exams more than a day in the past are cleared out. */
  prune() {
    const yesterday = dayKey(this.clock() - DAY);
    const before = this.data.exams.length;
    this.data.exams = this.data.exams.filter((e) => e.date >= yesterday);
    if (this.data.exams.length !== before) this.save();
  }

  upcoming() {
    const today = dayKey(this.clock());
    return this.data.exams.filter((e) => e.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  name(e) {
    return e.subject ? `${e.subject} exam` : 'exam';
  }

  /** Today's plan entries across all exams -> [{ exam, day }]. */
  today() {
    const k = dayKey(this.clock());
    const out = [];
    for (const e of this.upcoming()) {
      const day = e.plan.find((d) => d.date === k);
      if (day) out.push({ exam: e, day });
    }
    return out;
  }

  countdown(e) {
    const n = daysBetween(dayKey(this.clock()), e.date);
    return n <= 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
  }

  /** Run a parsed command -> Shadow's reply. */
  run(cmd) {
    this.prune();
    switch (cmd.type) {
      case 'add':
        return this.add(cmd);
      case 'show':
        return this.describe();
      case 'today':
        return this.todayText() || (this.upcoming().length ? 'Nothing planned for today - free day! 🎉 (Say "exam plan" to see the rest.)' : 'No exams planned, Prince. Tell me like "maths exam on 20 nov chapters 1-8" 📚');
      case 'done':
        return this.markDone();
      case 'cancel':
        return this.cancel(cmd.subject);
      default:
        return null;
    }
  }

  add(cmd) {
    if (cmd.error === 'date') return 'When is it, Prince? Say it like "maths exam on 20 nov chapters 1-8" or "physics exam on 5/12: optics, waves" 📅';
    const today = dayKey(this.clock());
    if (cmd.date <= today) return cmd.date === today ? 'Today?! All the best, Prince - you\'ve got this 💪 Quick tip: read your summary notes once, then relax.' : "That date's already gone, Prince 🤔";
    if (daysBetween(today, cmd.date) > 366) return "That's more than a year away, Prince - let's plan it closer to the time 📅";
    // same subject + date replaces the old plan
    const same = this.data.exams.findIndex((e) => e.date === cmd.date && (e.subject || '').toLowerCase() === (cmd.subject || '').toLowerCase());
    if (same < 0 && this.data.exams.length >= MAX_EXAMS) return `You already have ${MAX_EXAMS} exams planned, Prince - cancel one first.`;
    const plan = buildPlan(cmd.topics, today, cmd.date);
    const exam = { id: crypto.randomBytes(4).toString('hex'), subject: cmd.subject || '', date: cmd.date, topics: cmd.topics, plan, created: this.clock(), reminded: [] };
    if (same >= 0) this.data.exams[same] = exam;
    else this.data.exams.push(exam);
    this.save();
    const first = plan[0];
    const started = first && first.date === today ? 'Today' : first ? `From ${nice(first.date)}` : '';
    const n = cmd.topics.length;
    return [
      `📅 ${cap(this.name(exam))} on ${nice(exam.date)} (${this.countdown(exam)}) - Sage made your plan: ${plan.length} study day${plan.length === 1 ? '' : 's'}${n ? ` for ${n} topic${n === 1 ? '' : 's'}` : ''}.`,
      first ? `${started}: ${dayText(first)}.` : '',
      'I\'ll remind you every day at study time. Say "exam plan" to see it all, "quiz me" after studying, and "done studying" when you finish ✓',
    ]
      .filter(Boolean)
      .join(' ');
  }

  todayText() {
    const items = this.today();
    if (!items.length) return '';
    return items.map(({ exam, day }) => `📚 ${cap(this.name(exam))} (${this.countdown(exam)}): ${dayText(day)}${day.done ? ' ✓ done' : ''}`).join('\n');
  }

  describe() {
    const list = this.upcoming();
    if (!list.length) return 'No exams planned, Prince. Tell me like "maths exam on 20 nov chapters 1-8" 📚';
    const today = dayKey(this.clock());
    return list
      .map((e) => {
        const left = e.plan.filter((d) => d.date >= today);
        const done = e.plan.filter((d) => d.done).length;
        const lines = left.slice(0, 7).map((d) => `${d.date === today ? 'Today' : nice(d.date)}: ${dayText(d)}${d.done ? ' ✓' : ''}`);
        const more = left.length > 7 ? `\n…and ${left.length - 7} more days` : '';
        return `📅 ${cap(this.name(e))} - ${nice(e.date)} (${this.countdown(e)})${done ? ` · ${done}/${e.plan.length} days done` : ''}\n${lines.join('\n') || 'All study days are behind you - good luck! 🍀'}${more}`;
      })
      .join('\n\n');
  }

  markDone() {
    const items = this.today();
    if (!items.length) return 'Nothing was planned for today, but studying extra is always good 😼';
    items.forEach(({ day }) => (day.done = true));
    this.save();
    const e = items[0].exam;
    const done = e.plan.filter((d) => d.done).length;
    return `✓ Nice work, Prince! ${done}/${e.plan.length} study days done for your ${this.name(e)} 🦉 Want a quick check? Say "quiz me".`;
  }

  cancel(subject) {
    const list = this.upcoming();
    if (!list.length) return "There's no exam to cancel, Prince.";
    const s = (subject || '').toLowerCase().replace(/^(?:my|the)\s+/, '');
    const match = s ? list.filter((e) => (e.subject || '').toLowerCase().includes(s)) : list;
    if (!match.length) return `I don't have a ${subject} exam, Prince. ${list.map((e) => cap(this.name(e))).join(', ')}?`;
    if (match.length > 1) return `Which one, Prince? ${match.map((e) => `${cap(this.name(e))} (${nice(e.date)})`).join(' · ')} - say "cancel <subject> exam".`;
    this.data.exams = this.data.exams.filter((e) => e !== match[0]);
    this.save();
    return `Removed your ${this.name(match[0])} on ${nice(match[0].date)} and its plan ✓`;
  }

  /** Settings → REMOVE */
  remove(id) {
    const before = this.data.exams.length;
    this.data.exams = this.data.exams.filter((e) => e.id !== id);
    if (this.data.exams.length !== before) this.save();
  }

  /**
   * Study reminders that are due now -> [{ key, message }]. Each day's reminder fires once, at the
   * study time (or later that day if the PC was off), never after 11 PM.
   */
  due(studyTime = '18:00') {
    const now = this.clock();
    const [h, mi] = studyTime.split(':').map(Number);
    const at = startOfDay(now) + (h * 60 + mi) * 60 * 1000;
    if (now < at || new Date(now).getHours() >= 23) return [];
    const k = dayKey(now);
    const out = [];
    for (const { exam, day } of this.today()) {
      if (day.done || (exam.reminded || []).includes(k)) continue;
      exam.reminded = [...(exam.reminded || []).slice(-60), k];
      out.push({
        key: `exam|${exam.id}|${k}`,
        message: `Study time! ${cap(this.name(exam))} ${this.countdown(exam)} - today: ${day.topics.join(', ')}. Say "quiz me" when you're done 🦉`,
      });
    }
    if (out.length) this.save();
    return out;
  }

  /** One line for the morning briefing ('' if there's nothing). */
  briefingLine() {
    const items = this.today();
    if (items.length) {
      const { exam, day } = items[0];
      return `📚 ${cap(this.name(exam))} ${this.countdown(exam)}: today ${day.topics.slice(0, 3).join(', ')}${day.topics.length > 3 ? '…' : ''}.`;
    }
    const next = this.upcoming()[0];
    return next ? `📚 ${cap(this.name(next))} ${this.countdown(next)}.` : '';
  }

  /** What "quiz me" (no topic) should cover today, or ''. */
  quizTopic() {
    const items = this.today().filter(({ day }) => day.kind !== 'light');
    if (!items.length) return '';
    const { exam, day } = items[0];
    const topics = day.kind === 'mock' ? exam.topics : day.topics;
    return `${exam.subject ? `${exam.subject}: ` : ''}${topics.join(', ')}`.slice(0, 200);
  }

  /** For the chat AI ("when is my maths exam?"). */
  chatContext() {
    const list = this.upcoming();
    if (!list.length) return '';
    return `Prince's planned exams: ${list.map((e) => `${cap(this.name(e))} on ${nice(e.date)} (${this.countdown(e)})${e.topics.length ? `, topics: ${e.topics.slice(0, 12).join(', ')}` : ''}`).join('; ')}.${this.todayText() ? ` Today's study plan: ${this.todayText().replace(/\n/g, ' ')}` : ''}`;
  }
}

module.exports = { ExamPlanner, parseExamCommand, parseDate, parseTopics, buildPlan, dayKey };
