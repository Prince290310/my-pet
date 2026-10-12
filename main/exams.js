'use strict';
/*
 * exams.js - the exam planner (Sage's other job - Doctor Strange in the Avengers theme).
 *
 *   my exams: maths 20 nov ch 1-8, physics 22 nov ch 1-5, chemistry 25 nov units 1-4
 *   (or paste your date sheet, one exam per line: "20 Nov - Maths - Ch 1-8")
 *   maths exam on 20 nov chapters 1-8          physics exam is on 5th december: optics, waves, heat
 *   my exams / exam plan / what should I study today
 *   done studying (or "studied today")         cancel my maths exam
 *
 * All exams are planned TOGETHER as one timetable: each subject gets study days in the run-up to its
 * exam (about 3 days per chapter), the days are shared out so every subject finishes in time (the one
 * that would run out of days first goes first; on a crowded day two subjects share it), each subject
 * gets full revision + a practice paper close to its exam, and the day before each exam is light
 * revision. Every day at the study time (Settings → Exam planner) one reminder lists all of today's
 * subjects, and "quiz me" quizzes you on exactly those chapters. The morning briefing counts down too.
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
function parseDate(s, now = Date.now(), { strict = false } = {}) {
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
  // in the middle of a sentence "1-8" is a chapter range, not 1 August: only 20/11, 20.11 or 20-11-2026 there
  if ((m = (strict ? /^(\d{1,2})(?:[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?|-(\d{1,2})-(\d{2}|\d{4}))\b/ : /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?\b/).exec(t))) {
    if (strict && m[4]) m = [m[0], m[1], m[4], m[5]];
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
  if ((m = /^(next |this |coming )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/.exec(t))) {
    const want = WEEKDAYS.findIndex((w) => w.startsWith(m[2].slice(0, 3)));
    let diff = (want - new Date(now).getDay() + 7) % 7 || 7;
    if (m[1] === 'next ' && diff < 7) diff += 0; // "next friday" = the coming one, like people mean it
    return { key: dayKey(today + diff * DAY + DAY / 2), rest: t.slice(m[0].length) };
  }
  return null;
}

/** The first date anywhere in `s` -> { index, length, key } or null. */
function findDate(s, now = Date.now()) {
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) {
    if (i && /[a-z0-9]/i.test(t[i - 1])) continue; // only at the start of a word
    const d = parseDate(t.slice(i), now, { strict: true });
    if (d) return { index: i, length: t.length - i - d.rest.length, key: d.key };
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

/** Filler around a subject name: "my exams are", "date sheet:", "exam on" ... */
const tidyWords = (x) =>
  String(x || '')
    .replace(/^.*?(?:exams?|tests?|papers?|date ?sheet|time ?table|schedule)\s*(?:are|is|:)\s*/i, '') // "my exams are", "date sheet:"
    .replace(/\b(?:i have|i've got|ive got|my|the|an?|add|exams?|tests?|papers?|date ?sheet|time ?table|schedule|is|are|will be|on|for|at|from)\b/gi, ' ')
    .replace(/[-–—:|,()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const EXAMISH = /\b(?:exams?|tests?|papers?|date ?sheet|time ?table|finals|boards?)\b/i;
const NOT_SUBJECT = /^(?:ch(?:apters?|aps?|\.)?|units?|lessons?|modules?|topics?|lectures?|syllabus)\b/i;

/** One exam out of a longer message: "maths 20 nov ch 1-8", "20 Nov - Maths - Ch 1-8", "physics on 22/11: optics". */
function parseExamSegment(seg, now) {
  const f = findDate(seg, now);
  if (!f) return null;
  const tidy = tidyWords;
  let subject = tidy(seg.slice(0, f.index));
  let rest = seg.slice(f.index + f.length).replace(/^[\s,:;|–—-]+/, '');
  if (!subject) {
    // date first: "20 Nov - Maths - Ch 1-8" / "20 nov maths chapters 1-8"
    const m = /^([A-Za-z][A-Za-z &+.]{0,30}?)(?:\s+(?:exam|test|paper))?\s*(?:[-–—:|,]\s*|\s+(?=ch|chap|unit|lesson|module|topic|lecture)|$)(.*)$/i.exec(rest);
    if (m && !NOT_SUBJECT.test(m[1].trim())) {
      subject = tidy(m[1]);
      rest = m[2];
    }
  }
  return { subject: subject ? cap(subject.slice(0, 30)) : '', date: f.key, topics: parseTopics(rest) };
}

/** Every date in `t` -> [{ index, length }] */
function datePositions(t, now) {
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (i && /[a-z0-9]/i.test(t[i - 1])) continue;
    const d = parseDate(t.slice(i), now, { strict: true });
    if (!d) continue;
    const length = t.length - i - d.rest.length;
    out.push({ index: i, length });
    i += length - 1;
  }
  return out;
}

/**
 * A date sheet pasted into a one-line box loses its line breaks: "20 Nov Maths Ch 1-8 22 Nov Physics"
 * or "maths 20 nov ch 1-8 physics 22 nov". Cut it back into one piece per date.
 */
function splitAtDates(part, now) {
  const pos = datePositions(part, now);
  if (pos.length < 2) return [part];
  const dateFirst = !tidyWords(part.slice(0, pos[0].index));
  const cuts = pos.slice(1).map(({ index }) => {
    if (dateFirst) return index;
    // subject first: the cut goes before the subject word in front of the date ("… physics 22 nov")
    const before = part.slice(0, index).replace(/\s*(?:(?:exam|test|paper)\s*)?(?:(?:is|will be)\s+)?(?:on\s+)?[-–:]?\s*$/i, '');
    const w = before.search(/\S+\s*$/);
    return w > 0 ? w : index;
  });
  const out = [];
  let from = 0;
  for (const c of cuts) {
    out.push(part.slice(from, c));
    from = c;
  }
  out.push(part.slice(from));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** "maths 20 nov ch 1-8, physics 22 nov ch 1-5" / a pasted date sheet -> [{ subject, date, topics }] */
function parseExamList(text, now = Date.now()) {
  const segs = [];
  const parts = String(text || '')
    .split(/\s*(?:\n|;|,|\band\b|&)\s*/i)
    .filter(Boolean)
    .flatMap((x) => splitAtDates(x, now));
  for (const part of parts) {
    if (findDate(part, now) || !segs.length) segs.push(part);
    else segs[segs.length - 1] += `, ${part}`; // more topics of the same exam
  }
  return segs.map((x) => parseExamSegment(x, now)).filter(Boolean);
}

/** Chat message -> exam command, or null. */
function parseExamCommand(input, now = Date.now()) {
  const raw = String(input || '').trim();
  // several exams in one go (one message, or a pasted date sheet)
  if (EXAMISH.test(raw) && !/^(?:cancel|delete|remove|forget|drop)\b/i.test(clean(raw))) {
    const list = parseExamList(raw.replace(/\r/g, '').replace(/^(?:hey |ok |okay )?(?:shadow|sage|doctor strange|iron man)[,:!]?\s*/i, ''), now);
    if (list.length >= 2) return { type: 'addMany', exams: list };
  }
  const t = clean(input);
  const l = t.toLowerCase().replace(/\.$/, '');
  let m;
  if (/^(?:show |see |what'?s |whats )?(?:my |the )?(?:exams?|exam (?:plans?|schedule|timetable|list)|test (?:plans?|schedule|timetable))$|^(?:show |see )?(?:my |the )?(?:study|revision) (?:plan|schedule|timetable)$|^(?:when (?:are|is) my (?:next )?exams?)$/.test(l)) {
    return { type: 'show' };
  }
  if (/^what (?:should|do|shall) i (?:study|revise|read)(?: today)?$|^what'?s (?:on )?(?:my )?(?:study|revision)(?: plan)? (?:for )?today$|^today'?s (?:study|revision)(?: plan)?$/.test(l)) return { type: 'today' };
  if (/^(?:i'?m |i am )?(?:done|finished)(?: with)? (?:studying|study|revision|revising|today'?s (?:study|revision|chapters?|plan))(?: for today| today)?$|^(?:i )?(?:studied|revised)(?: today| everything| it all)?$/.test(l)) return { type: 'done' };
  if ((m = /^(?:cancel|delete|remove|forget|drop|clear)(?: my| the)? (.{0,30}?) ?(?:exam|test)s?(?: plans?)?$/.exec(l))) return { type: 'cancel', subject: m[1].trim() };
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

const windowDays = (topicCount) => Math.min(45, Math.max(5, topicCount * 3 + 3)); // run-up: ~3 days per chapter
const mockCount = (days) => (days >= 12 ? 2 : days >= 5 ? 1 : 0);

/** Lay one subject's topics over its study days: new topics (revision days in between), practice last. */
function layout(topics, days, mockDays = []) {
  const plan = [];
  const T = topics.length;
  const n = days.length;
  for (let i = 0; i < n; i++) {
    const date = days[i];
    if (!T) {
      plan.push({ date, kind: 'revise', topics: ['Your notes + practice questions'] });
      continue;
    }
    const a = Math.ceil((i * T) / n);
    const b = Math.ceil(((i + 1) * T) / n);
    if (b > a) plan.push({ date, kind: 'learn', topics: topics.slice(a, b) });
    else plan.push({ date, kind: 'revise', topics: topics.slice(Math.max(0, a - 2), a) });
  }
  mockDays.forEach((date, i) => plan.push({ date, kind: 'mock', topics: [i === mockDays.length - 1 ? 'Practice paper (time yourself!)' : 'Full revision of everything'] }));
  return plan;
}

/**
 * Plan every exam together from `startKey`. exams: [{ id, date, topics }] (topics still to learn).
 * Returns { [id]: [{ date, kind: 'learn'|'revise'|'mock'|'light', topics }] }.
 */
function schedule(exams, startKey) {
  const list = exams.filter((e) => e.date > startKey).sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = Object.fromEntries(exams.map((e) => [e.id, []]));
  if (!list.length) return out;
  const examDays = new Set(list.map((e) => e.date));
  const lightOf = (e) => addDays(e.date, -1);
  const lightDays = new Set(list.map(lightOf).filter((d) => d >= startKey));
  const reserved = new Map(); // day -> exam id (practice days close to that exam)
  const busy = (d) => examDays.has(d) || lightDays.has(d) || reserved.has(d);
  const st = Object.fromEntries(list.map((e) => [e.id, { ws: addDays(e.date, -windowDays(e.topics.length)), days: [], mocks: [] }]));
  // 1. full revision + practice paper go right before each exam (nearest exam first) - but only
  //    when there are days to spare after learning everything
  for (const e of list) {
    let free = 0;
    for (let d = st[e.id].ws > startKey ? st[e.id].ws : startKey; d <= addDays(e.date, -2); d = addDays(d, 1)) if (!busy(d)) free++;
    const want = Math.min(mockCount(free), Math.max(0, free - Math.max(1, e.topics.length)));
    for (let d = addDays(e.date, -2); st[e.id].mocks.length < want && d >= startKey && d >= st[e.id].ws; d = addDays(d, -1)) {
      if (!busy(d)) {
        reserved.set(d, e.id);
        st[e.id].mocks.unshift(d);
      }
    }
  }
  // 2. share the other days: whoever would run out of days first goes first
  const last = addDays(list[list.length - 1].date, -2);
  const freeLeft = (from, e) => {
    let n = 0;
    for (let d = from; d <= addDays(e.date, -2); d = addDays(d, 1)) if (!busy(d)) n++;
    return n;
  };
  for (let d = startKey; d <= last; d = addDays(d, 1)) {
    if (busy(d)) continue;
    const cands = list
      .filter((e) => d >= st[e.id].ws && d <= addDays(e.date, -2))
      .map((e) => ({ e, slack: freeLeft(d, e) - Math.max(0, Math.max(1, e.topics.length) - st[e.id].days.length) }))
      .sort((a, b) => a.slack - b.slack || (a.e.date < b.e.date ? -1 : 1));
    if (!cands.length) continue;
    st[cands[0].e.id].days.push(d);
    // a crowded day: if another subject can't finish otherwise, it shares the day
    if (cands[1] && cands[1].slack < 0) st[cands[1].e.id].days.push(d);
  }
  // 3. lay out each subject + the light day before its exam
  for (const e of list) {
    const plan = layout(e.topics, st[e.id].days, st[e.id].mocks);
    if (lightOf(e) >= startKey) plan.push({ date: lightOf(e), kind: 'light', topics: ['Light revision + early sleep 😴'] });
    out[e.id] = plan.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  return out;
}

/** One exam on its own (kept for the old API/tests). */
function buildPlan(topics, startKey, examKey) {
  return schedule([{ id: 'x', date: examKey, topics }], startKey).x;
}

const KIND_ICON = { learn: '📖', revise: '🔁', mock: '📝', light: '🌙' };
const dayText = (d) => `${KIND_ICON[d.kind] || '📖'} ${d.kind === 'revise' ? 'Revise ' : ''}${d.topics.join(', ')}`;

class ExamPlanner {
  /**
   * @param {object} o
   * @param {string} o.file   exams.json
   * @param {() => string} [o.tutor]  the tutor's name in the current theme (Sage / Doctor Strange)
   */
  constructor({ file, clock = () => Date.now(), tutor = () => 'Sage' }) {
    this.file = file;
    this.clock = clock;
    this.tutor = tutor;
    this.data = { exams: [], remindedDays: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && Array.isArray(raw.exams)) this.data.exams = raw.exams.filter((e) => e && /^\d{4}-\d\d-\d\d$/.test(e.date) && Array.isArray(e.plan));
      if (raw && Array.isArray(raw.remindedDays)) this.data.remindedDays = raw.remindedDays.filter((k) => typeof k === 'string').slice(-60);
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

  /**
   * Re-plan every upcoming exam together. Past days stay as they were (what's learned is learned);
   * today stays too once its reminder went out or something was ticked off.
   */
  replan() {
    const today = dayKey(this.clock());
    const keepToday = (this.data.remindedDays || []).includes(today) || this.data.exams.some((e) => e.plan.some((d) => d.date === today && d.done));
    const from = keepToday ? addDays(today, 1) : today;
    const exams = this.upcoming();
    const history = {};
    const input = exams.map((e) => {
      history[e.id] = e.plan.filter((d) => d.date < from);
      const learned = new Set(history[e.id].filter((d) => d.kind === 'learn').flatMap((d) => d.topics));
      return { id: e.id, date: e.date, topics: e.topics.filter((t) => !learned.has(t)) };
    });
    const plans = schedule(input, from);
    for (const e of exams) e.plan = [...history[e.id], ...(plans[e.id] || [])];
  }

  /** Today's plan entries across all exams -> [{ exam, day }]. */
  today() {
    const k = dayKey(this.clock());
    const out = [];
    for (const e of this.upcoming()) {
      for (const day of e.plan.filter((d) => d.date === k)) out.push({ exam: e, day });
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
      case 'addMany':
        return this.addMany(cmd.exams);
      case 'show':
        return this.describe();
      case 'today':
        return this.todayText() || (this.upcoming().length ? `Nothing planned for today - free day! 🎉 ${this.nextStudyText()}` : 'No exams planned, Prince. Tell me like "my exams: maths 20 nov ch 1-8, physics 22 nov ch 1-5" 📚');
      case 'done':
        return this.markDone();
      case 'cancel':
        return this.cancel(cmd.subject);
      default:
        return null;
    }
  }

  /** Checks one exam -> an error line, or '' if it's fine. */
  problem(x) {
    const today = dayKey(this.clock());
    const label = x.subject || 'that exam';
    if (x.date < today) return `${label}: that date's already gone`;
    if (x.date === today) return `${label}: that's today - all the best! 💪`;
    if (daysBetween(today, x.date) > 366) return `${label}: more than a year away - let's plan it closer to the time`;
    return '';
  }

  /** Insert or replace (same subject + date). Returns the exam, or null if the list is full. */
  put(x) {
    const same = this.data.exams.findIndex((e) => e.date === x.date && (e.subject || '').toLowerCase() === (x.subject || '').toLowerCase());
    if (same < 0 && this.data.exams.length >= MAX_EXAMS) return null;
    const exam = { id: crypto.randomBytes(4).toString('hex'), subject: x.subject || '', date: x.date, topics: x.topics || [], plan: [], created: this.clock() };
    if (same >= 0) this.data.exams[same] = exam;
    else this.data.exams.push(exam);
    return exam;
  }

  add(cmd) {
    if (cmd.error === 'date') return 'When is it, Prince? Say it like "maths exam on 20 nov chapters 1-8", or give me all of them: "my exams: maths 20 nov ch 1-8, physics 22 nov ch 1-5" 📅';
    const bad = this.problem(cmd);
    if (bad) return cmd.date === dayKey(this.clock()) ? "Today?! All the best, Prince - you've got this 💪 Quick tip: read your summary notes once, then relax." : `${cap(bad)}, Prince 🤔`;
    const exam = this.put(cmd);
    if (!exam) return `You already have ${MAX_EXAMS} exams planned, Prince - cancel one first.`;
    this.replan();
    this.save();
    const others = this.upcoming().length - 1;
    const first = exam.plan[0];
    const today = dayKey(this.clock());
    const n = exam.topics.length;
    return [
      `📅 ${cap(this.name(exam))} on ${nice(exam.date)} (${this.countdown(exam)}) - ${this.tutor()} made your plan${others ? `, together with your ${others} other exam${others === 1 ? '' : 's'}` : ''}: ${exam.plan.length} study day${exam.plan.length === 1 ? '' : 's'}${n ? ` for ${n} topic${n === 1 ? '' : 's'}` : ''}.`,
      first ? `${first.date === today ? 'Today' : `From ${nice(first.date)}`}: ${dayText(first)}.` : '',
      'I\'ll remind you every day at study time. Say "exam plan" to see it all, "quiz me" after studying, and "done studying" when you finish ✓',
    ]
      .filter(Boolean)
      .join(' ');
  }

  addMany(list) {
    const added = [];
    const skipped = [];
    for (const x of list) {
      const bad = this.problem(x);
      if (bad) skipped.push(bad);
      else if (!this.put(x)) skipped.push(`${x.subject || 'an exam'}: you already have ${MAX_EXAMS} exams planned`);
      else added.push(x);
    }
    if (!added.length) return `I couldn't plan those, Prince: ${skipped.join('; ')}.`;
    this.replan();
    this.save();
    const exams = this.upcoming();
    const days = new Set(exams.flatMap((e) => e.plan.map((d) => d.date)));
    return [
      `📅 ${this.tutor()} planned ${exams.length} exam${exams.length === 1 ? '' : 's'} together: ${exams.map((e) => `${e.subject || 'Exam'} ${nice(e.date)}`).join(' · ')}.`,
      `${days.size} study days in one timetable - every subject gets its own run-up, revision and a practice paper, and the day before each exam is light revision.`,
      this.nextStudyText(),
      skipped.length ? `(Skipped: ${skipped.join('; ')}.)` : '',
      'Say "exam plan" to see it, "done studying" each day ✓',
    ]
      .filter(Boolean)
      .join(' ');
  }

  /** "First up: Sat 24 Oct - 📖 Maths: Chapter 1." */
  nextStudyText() {
    const today = dayKey(this.clock());
    const days = this.byDay().filter(([k]) => k >= today);
    if (!days.length) return '';
    const [k, items] = days[0];
    return `${k === today ? 'Today' : `First up, ${nice(k)}`}: ${items.map(({ exam, day }) => `${dayText(day)} (${exam.subject || 'exam'})`).join(' + ')}.`;
  }

  /** [[date, [{ exam, day }]]] for every planned day, in order. */
  byDay() {
    const map = new Map();
    for (const e of this.upcoming()) for (const day of e.plan) map.set(day.date, [...(map.get(day.date) || []), { exam: e, day }]);
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  todayText() {
    const items = this.today();
    if (!items.length) return '';
    return items.map(({ exam, day }) => `📚 ${cap(this.name(exam))} (${this.countdown(exam)}): ${dayText(day)}${day.done ? ' ✓ done' : ''}`).join('\n');
  }

  describe() {
    const list = this.upcoming();
    if (!list.length) return 'No exams planned, Prince. Tell me like "my exams: maths 20 nov ch 1-8, physics 22 nov ch 1-5" 📚';
    const today = dayKey(this.clock());
    const head = `📅 ${list.length === 1 ? 'Your exam' : 'Your exams'}: ${list.map((e) => `${e.subject || 'Exam'} ${nice(e.date)} (${this.countdown(e)})`).join(' · ')}`;
    const days = this.byDay().filter(([k]) => k >= today);
    const lines = days.slice(0, 10).map(([k, items]) => `${k === today ? 'Today' : nice(k)}: ${items.map(({ exam, day }) => `${dayText(day)}${list.length > 1 ? ` (${exam.subject || 'exam'})` : ''}${day.done ? ' ✓' : ''}`).join(' + ')}`);
    const done = list.reduce((n, e) => n + e.plan.filter((d) => d.done).length, 0);
    const more = days.length > 10 ? `\n…and ${days.length - 10} more study days` : '';
    return `${head}${done ? ` · ${done} study day${done === 1 ? '' : 's'} done` : ''}\n${lines.join('\n') || 'All study days are behind you - good luck! 🍀'}${more}`;
  }

  markDone() {
    const items = this.today();
    if (!items.length) return 'Nothing was planned for today, but studying extra is always good 😼';
    items.forEach(({ day }) => (day.done = true));
    this.save();
    const all = this.upcoming().flatMap((e) => e.plan);
    const done = all.filter((d) => d.done).length;
    return `✓ Nice work, Prince! ${done}/${all.length} study days done${this.upcoming().length > 1 ? ' across your exams' : ` for your ${this.name(items[0].exam)}`} 🦉 Want a quick check? Say "quiz me".`;
  }

  cancel(subject) {
    const list = this.upcoming();
    if (!list.length) return "There's no exam to cancel, Prince.";
    const s = (subject || '').toLowerCase().replace(/^(?:my|the)\s+/, '');
    if (/^(?:all|all my|all the|every|everything)$/.test(s)) {
      this.data.exams = [];
      this.save();
      return `Removed all ${list.length} exams and their plans ✓`;
    }
    const match = s ? list.filter((e) => (e.subject || '').toLowerCase().includes(s)) : list;
    if (!match.length) return `I don't have a ${subject} exam, Prince. ${list.map((e) => cap(this.name(e))).join(', ')}?`;
    if (match.length > 1) return `Which one, Prince? ${match.map((e) => `${cap(this.name(e))} (${nice(e.date)})`).join(' · ')} - say "cancel <subject> exam" (or "cancel all exams").`;
    this.data.exams = this.data.exams.filter((e) => e !== match[0]);
    this.replan(); // the freed days go to the other subjects
    this.save();
    return `Removed your ${this.name(match[0])} on ${nice(match[0].date)} and its plan ✓${this.upcoming().length ? ' The other exams got its study days.' : ''}`;
  }

  /** Settings → REMOVE */
  remove(id) {
    const before = this.data.exams.length;
    this.data.exams = this.data.exams.filter((e) => e.id !== id);
    if (this.data.exams.length !== before) {
      this.replan();
      this.save();
    }
  }

  /** Settings → ADD EXAM. Returns the reply line. */
  addFromForm({ subject, date, topics }) {
    const subj = cap(String(subject || '').trim().replace(/\s+/g, ' ').slice(0, 30));
    if (!/^\d{4}-\d\d-\d\d$/.test(String(date || ''))) return 'Pick the exam date first.';
    return this.add({ type: 'add', subject: subj, date, topics: parseTopics(String(topics || '').slice(0, 300)) });
  }

  /**
   * The study reminder that is due now -> [{ key, message }] (at most one a day, listing every
   * subject for today). At the study time, or later that day if the PC was off - never after 11 PM.
   */
  due(studyTime = '18:00') {
    const now = this.clock();
    const [h, mi] = studyTime.split(':').map(Number);
    const at = startOfDay(now) + (h * 60 + mi) * 60 * 1000;
    if (now < at || new Date(now).getHours() >= 23) return [];
    const k = dayKey(now);
    if ((this.data.remindedDays || []).includes(k)) return [];
    const items = this.today().filter(({ day }) => !day.done);
    if (!items.length) return [];
    this.data.remindedDays = [...(this.data.remindedDays || []).slice(-60), k];
    this.save();
    const list = items.map(({ exam, day }) => `${exam.subject || 'Exam'} (${this.countdown(exam)}): ${day.topics.join(', ')}`).join(' · ');
    return [{ key: `exam|${k}`, message: `Study time! Today: ${list}. Say "quiz me" when you're done 🦉` }];
  }

  /** One line for the morning briefing ('' if there's nothing). */
  briefingLine() {
    const items = this.today();
    if (items.length) {
      const { exam } = items[0];
      const what = items.map(({ exam: e, day }) => `${items.length > 1 ? `${e.subject || 'exam'} ` : ''}${day.topics.slice(0, 2).join(', ')}${day.topics.length > 2 ? '…' : ''}`).join(' + ');
      return `📚 ${cap(this.name(exam))} ${this.countdown(exam)}: today ${what}.`;
    }
    const next = this.upcoming()[0];
    return next ? `📚 ${cap(this.name(next))} ${this.countdown(next)}.` : '';
  }

  /** What "quiz me" (no topic) should cover today, or ''. */
  quizTopic() {
    const items = this.today().filter(({ day }) => day.kind !== 'light');
    if (!items.length) return '';
    return items
      .map(({ exam, day }) => `${exam.subject ? `${exam.subject}: ` : ''}${(day.kind === 'mock' ? exam.topics : day.topics).join(', ')}`)
      .join('; ')
      .slice(0, 200);
  }

  /** For the chat AI ("when is my maths exam?"). */
  chatContext() {
    const list = this.upcoming();
    if (!list.length) return '';
    return `Prince's planned exams: ${list.map((e) => `${cap(this.name(e))} on ${nice(e.date)} (${this.countdown(e)})${e.topics.length ? `, topics: ${e.topics.slice(0, 12).join(', ')}` : ''}`).join('; ')}.${this.todayText() ? ` Today's study plan: ${this.todayText().replace(/\n/g, ' ')}` : ''}`;
  }
}

module.exports = { ExamPlanner, parseExamCommand, parseExamList, parseDate, findDate, parseTopics, buildPlan, schedule, dayKey };
