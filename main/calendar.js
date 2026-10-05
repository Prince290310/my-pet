'use strict';
/*
 * calendar.js - Google Calendar reminders.
 *
 * Reads your calendar through its private "Secret address in iCal format" link (Settings ->
 * Google Calendar) and turns upcoming events into Shadow reminders:
 *   "Maths class" in 10 min   ...   "Maths class" is starting now
 * All-day events get one heads-up in the morning.
 *
 * Read-only: Shadow never changes your calendar. No link set -> no network calls at all.
 * The link is a secret, so it is never logged; the cache stores only upcoming events.
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const SYNC_EVERY_MS = 5 * MIN;
const CHECK_EVERY_MS = 15 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const MAX_ICS_BYTES = 30 * 1024 * 1024;
const CACHE_DAYS = 14; // events kept for offline use
const ALL_DAY_HOUR = 9; // all-day events: heads-up at 9:00
const START_GRACE_MS = 5 * MIN; // "starting now" still shows if the PC woke up a bit late
const GCAL_SETTINGS_URL = 'https://calendar.google.com/calendar/r/settings';

class CalendarError extends Error {
  constructor(kind, detail = '') {
    super(detail || kind);
    this.kind = kind; // no-url | bad-url | not-found | auth | http | offline | timeout | not-ical | too-big
  }
}

// ------------------------------------------------------------------ iCal parsing

/** Undo iCal line folding (long lines continue on the next line after a space). */
const unfold = (text) => String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');

const unescapeText = (s) => s.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? ' ' : c));

/** "DTSTART;TZID=Asia/Kolkata:20261005T100000" -> { name, params, value } */
function parseLine(line) {
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i).split(';');
  const params = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(i + 1) };
}

/** iCal date/date-time -> wall-clock parts { allDay, y, mo, d, h, mi, s, tz } */
function parseDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const date = { y: +m[1], mo: +m[2], d: +m[3] };
  if (!m[4] || params.VALUE === 'DATE') return { allDay: true, ...date, h: 0, mi: 0, s: 0, tz: null };
  return { allDay: false, ...date, h: +m[4], mi: +m[5], s: +(m[6] || 0), tz: m[7] ? 'UTC' : params.TZID || null };
}

const formatters = new Map();
function zoneFormatter(tz) {
  if (!formatters.has(tz)) {
    let f = null;
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      f = null; // e.g. Outlook's "India Standard Time" - fall back to this PC's time zone
    }
    formatters.set(tz, f);
  }
  return formatters.get(tz);
}

function zoneOffset(ms, f) {
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, +x.value]));
  const sec = Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - sec;
}

/** Wall-clock parts -> epoch ms. All-day dates count from local midnight. */
function toMs(w) {
  if (w.allDay) return new Date(w.y, w.mo - 1, w.d).getTime();
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  if (w.tz === 'UTC') return guess;
  const f = w.tz && zoneFormatter(w.tz);
  if (!f) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();
  const first = guess - zoneOffset(guess, f);
  return guess - zoneOffset(first, f);
}

function parseRule(value) {
  const r = {};
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) r[k.toUpperCase()] = v;
  }
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(r.FREQ)) return null; // hourly etc.: not for a pet
  const ints = (s) => (s ? s.split(',').map(Number).filter(Number.isFinite) : null);
  const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  let until = null;
  if (r.UNTIL) {
    const u = parseDate(r.UNTIL);
    if (u) until = u.allDay ? toMs(u) + DAY - 1 : toMs(u.tz ? u : { ...u, tz: 'UTC' });
  }
  return {
    freq: r.FREQ,
    interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1),
    count: parseInt(r.COUNT, 10) || 0,
    until,
    byday: r.BYDAY
      ? r.BYDAY.split(',')
          .map((x) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim()))
          .filter(Boolean)
          .map((x) => ({ n: x[1] ? +x[1] : 0, wd: WD[x[2]] }))
      : null,
    bymonthday: ints(r.BYMONTHDAY),
    bymonth: ints(r.BYMONTH),
    wkst: WD[r.WKST] !== undefined ? WD[r.WKST] : 1,
  };
}

/** Owner's address from a Google iCal link (.../calendar/ical/<email>/private-.../basic.ics). */
function ownerFromUrl(url) {
  const m = /\/calendar\/ical\/([^/]+)\//.exec(String(url || ''));
  try {
    return m ? decodeURIComponent(m[1]).toLowerCase() : '';
  } catch {
    return '';
  }
}

/** Parse an .ics file into a list of VEVENTs. */
function parseIcs(text, { owner = '' } = {}) {
  const events = [];
  const stack = [];
  let ev = null;
  for (const raw of unfold(text).split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:')) {
      const what = upper.slice(6);
      stack.push(what);
      if (what === 'VEVENT') ev = { exdates: new Set() };
      continue;
    }
    if (upper.startsWith('END:')) {
      const what = stack.pop();
      if (what === 'VEVENT' && ev) {
        if (ev.uid && ev.start) events.push(ev);
        ev = null;
      }
      continue;
    }
    if (!ev || stack[stack.length - 1] !== 'VEVENT') continue; // skip VALARM, VTIMEZONE, ...
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID':
        ev.uid = p.value.trim();
        break;
      case 'SUMMARY':
        ev.title = unescapeText(p.value).trim();
        break;
      case 'LOCATION':
        ev.location = unescapeText(p.value).trim();
        break;
      case 'STATUS':
        ev.status = p.value.trim().toUpperCase();
        break;
      case 'DTSTART':
        ev.start = parseDate(p.value, p.params);
        break;
      case 'RRULE':
        ev.rule = parseRule(p.value);
        break;
      case 'EXDATE':
        for (const v of p.value.split(',')) {
          const d = parseDate(v, p.params);
          if (d) ev.exdates.add(toMs(d));
        }
        break;
      case 'RECURRENCE-ID': {
        const d = parseDate(p.value, p.params);
        if (d) ev.recurrenceId = toMs(d);
        break;
      }
      case 'ATTENDEE':
        // skip events you said "No" to
        if (owner && p.value.toLowerCase() === `mailto:${owner}` && (p.params.PARTSTAT || '').toUpperCase() === 'DECLINED') {
          ev.declined = true;
        }
        break;
      default:
    }
  }
  return events;
}

// ------------------------------------------------------------------ recurring events

// Day numbers: whole days since 1970-01-01 on the wall calendar (time zones don't matter here).
const dayNum = (y, mo, d) => Date.UTC(y, mo - 1, d) / DAY;
function fromDayNum(n) {
  const t = new Date(n * DAY);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
}
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

function nthMatches(n, dt) {
  if (!n) return true;
  if (n > 0) return Math.floor((dt.d - 1) / 7) + 1 === n;
  return Math.floor((daysInMonth(dt.y, dt.mo) - dt.d) / 7) + 1 === -n;
}

function monthDayMatches(list, dt) {
  const dim = daysInMonth(dt.y, dt.mo);
  return list.some((v) => (v > 0 ? dt.d === v : dt.d === dim + v + 1));
}

/** Does the rule produce an event on this wall-clock day? */
function ruleMatches(r, s, startDay, dt, dn) {
  if (dn === startDay) return true; // the first event always counts
  if (r.bymonth && !r.bymonth.includes(dt.mo)) return false;
  const sameDayOfMonth = () => {
    if (r.byday) return r.byday.some((b) => b.wd === dt.wd && nthMatches(b.n, dt));
    if (r.bymonthday) return monthDayMatches(r.bymonthday, dt);
    return dt.d === s.d;
  };
  switch (r.freq) {
    case 'DAILY':
      if ((dn - startDay) % r.interval) return false;
      if (r.byday && !r.byday.some((b) => b.wd === dt.wd)) return false;
      return !r.bymonthday || monthDayMatches(r.bymonthday, dt);
    case 'WEEKLY': {
      const weekStart = (x) => x - ((fromDayNum(x).wd - r.wkst + 7) % 7);
      if (((weekStart(dn) - weekStart(startDay)) / 7) % r.interval) return false;
      const days = r.byday ? r.byday.map((b) => b.wd) : [fromDayNum(startDay).wd];
      return days.includes(dt.wd);
    }
    case 'MONTHLY':
      if (((dt.y - s.y) * 12 + dt.mo - s.mo) % r.interval) return false;
      return sameDayOfMonth();
    case 'YEARLY':
      if ((dt.y - s.y) % r.interval) return false;
      if (!r.bymonth && dt.mo !== s.mo) return false;
      return sameDayOfMonth();
    default:
      return false;
  }
}

/** Start times (ms) of one recurring event between fromMs and toMs. */
function expand(ev, fromMs, toMs_) {
  const r = ev.rule;
  const s = ev.start;
  const startDay = dayNum(s.y, s.mo, s.d);
  const lastDay = Math.floor(toMs_ / DAY) + 2;
  // with COUNT we must count from the very first event; otherwise jump close to the window
  let dn = r.count ? startDay : Math.max(startDay, Math.floor(fromMs / DAY) - 2);
  const out = [];
  let n = 0;
  for (let guard = 0; dn <= lastDay && guard < 60000; dn++, guard++) {
    const dt = fromDayNum(dn);
    if (!ruleMatches(r, s, startDay, dt, dn)) continue;
    const ms = toMs({ ...s, y: dt.y, mo: dt.mo, d: dt.d });
    if (r.until !== null && ms > r.until) break;
    if (r.count && ++n > r.count) break;
    if (ms >= fromMs && ms <= toMs_) out.push(ms);
  }
  return out;
}

/** Every event (recurring ones expanded) that starts between fromMs and toMs, soonest first. */
function occurrences(events, fromMs, toMs_) {
  const out = [];
  const replaced = new Set(); // "uid|ms" of recurring events that were moved or edited individually
  const add = (ev, start) => {
    if (start < fromMs || start > toMs_) return;
    if (ev.status === 'CANCELLED' || ev.declined) return;
    out.push({
      key: `${ev.uid}|${start}`,
      title: (ev.title || '(no title)').slice(0, 120),
      location: (ev.location || '').slice(0, 80),
      start,
      allDay: ev.start.allDay,
    });
  };
  for (const ev of events) {
    if (ev.recurrenceId === undefined) continue;
    replaced.add(`${ev.uid}|${ev.recurrenceId}`);
    add(ev, toMs(ev.start));
  }
  for (const ev of events) {
    if (ev.recurrenceId !== undefined) continue;
    const starts = ev.rule ? expand(ev, fromMs, toMs_) : [toMs(ev.start)];
    for (const ms of starts) {
      if (ev.exdates.has(ms) || replaced.has(`${ev.uid}|${ms}`)) continue;
      add(ev, ms);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------------ link + download

/** Accepts https:// and webcal:// links; returns a clean https URL or ''. */
function cleanCalendarUrl(v) {
  let s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 1000) return '';
  s = s.replace(/^webcals?:\/\//i, 'https://');
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) ? u.href : '';
  } catch {
    return '';
  }
}

async function download(url, { fetchImpl = fetch } = {}) {
  const clean = cleanCalendarUrl(url);
  if (!url) throw new CalendarError('no-url');
  if (!clean) throw new CalendarError('bad-url');
  let res;
  try {
    res = await fetchImpl(clean, { headers: { Accept: 'text/calendar, */*' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new CalendarError('timeout');
    throw new CalendarError('offline', (err && err.cause && err.cause.code) || (err && err.message) || 'network error');
  }
  if (res.status === 404) throw new CalendarError('not-found', 'HTTP 404');
  if (res.status === 401 || res.status === 403) throw new CalendarError('auth', `HTTP ${res.status}`);
  if (!res.ok) throw new CalendarError('http', `HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_ICS_BYTES) throw new CalendarError('too-big');
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 2000))) throw new CalendarError('not-ical');
  return text;
}

function friendly(err) {
  switch (err && err.kind) {
    case 'no-url':
      return 'Paste your calendar\'s "Secret address in iCal format" first, Prince.';
    case 'bad-url':
      return 'That doesn\'t look like a calendar link, Prince. It should start with https://';
    case 'not-found':
      return 'Google says that link doesn\'t exist, Prince. Did you reset the secret address? Copy it again.';
    case 'auth':
      return 'Google won\'t let me read that link, Prince. Use the SECRET address (not the public one).';
    case 'not-ical':
      return 'That link isn\'t a calendar file, Prince. Copy the "Secret address in iCal format".';
    case 'too-big':
      return 'That calendar is too huge for my little paws, Prince 😿';
    case 'offline':
      return 'I can\'t reach Google Calendar right now, Prince 📡 Is the internet on?';
    case 'timeout':
      return 'Google Calendar took too long to answer, Prince ⏳ Try again?';
    default:
      return `Calendar trouble, Prince (${(err && err.message) || 'unknown error'}). Try again in a bit?`;
  }
}

// ------------------------------------------------------------------ sync + reminders

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** How many events are still ahead (all-day ones count until the day ends) and which is next. */
function summary(list, now) {
  const ahead = list.filter((o) => (o.allDay ? o.start + DAY > now : o.start > now));
  const next = ahead[0];
  return { count: ahead.length, next: next ? { title: next.title, start: next.start, allDay: next.allDay } : null };
}

const urlId = (url) => (url ? crypto.createHash('sha256').update(url).digest('hex').slice(0, 16) : '');

/**
 * Keeps upcoming events in memory (and in a small cache file for offline restarts) and emits
 * 'fire' with { time, message, source: 'calendar' } when Shadow should remind you.
 * Settings used: calendarUrl, calendarLeadMinutes (0 = no early heads-up), calendarAtStart.
 */
class CalendarSync extends EventEmitter {
  constructor({ settings, cacheFile, clock = () => Date.now(), fetchImpl } = {}) {
    super();
    this.settings = settings;
    this.cacheFile = cacheFile;
    this.clock = clock;
    this.fetchImpl = fetchImpl || ((...a) => fetch(...a));
    this.upcoming = [];
    this.lastSync = 0;
    this.lastError = null;
    this.fired = new Map(); // "uid|start|kind" -> when it fired
    this.timers = [];
    this.syncing = null;
    this.loadCache();
  }

  url() {
    return cleanCalendarUrl(this.settings.get('calendarUrl'));
  }

  start() {
    this.check();
    this.sync();
    this.timers.push(setInterval(() => this.sync(), SYNC_EVERY_MS));
    this.timers.push(setInterval(() => this.check(), CHECK_EVERY_MS));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** Download + parse the calendar. Never throws; keeps the last good events on failure. */
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const url = this.url();
      if (!url) {
        this.upcoming = [];
        this.lastError = null;
        this.lastSync = 0;
        this.saveCache();
        return this.status();
      }
      try {
        const text = await download(url, { fetchImpl: this.fetchImpl });
        if (url !== this.url()) return this.status(); // link changed while downloading
        const now = this.clock();
        this.upcoming = occurrences(parseIcs(text, { owner: ownerFromUrl(url) }), now - DAY, now + CACHE_DAYS * DAY);
        this.lastSync = now;
        this.lastError = null;
        this.saveCache();
        this.check();
      } catch (err) {
        this.lastError = err;
        console.warn(`[calendar] sync failed: ${err.kind || 'error'} ${err.kind ? '' : err.message}`.trim());
      }
      this.emit('status', this.status());
      return this.status();
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  /** Settings -> "Test link": checks a link without saving anything. */
  async test(url) {
    try {
      const clean = cleanCalendarUrl(url);
      const text = await download(url, { fetchImpl: this.fetchImpl });
      const now = this.clock();
      const list = occurrences(parseIcs(text, { owner: ownerFromUrl(clean) }), now - DAY, now + CACHE_DAYS * DAY);
      return { ok: true, ...summary(list, now) };
    } catch (err) {
      return { ok: false, kind: err.kind || 'error', message: friendly(err) };
    }
  }

  /** Fire any reminder that is due now. Returns the reminders fired. */
  check(now = this.clock()) {
    const lead = this.settings.get('calendarLeadMinutes') * MIN;
    const atStart = this.settings.get('calendarAtStart');
    const due = [];
    const fire = (occ, kind, message) => {
      this.fired.set(`${occ.key}|${kind}`, now);
      due.push({ time: hhmm(occ.start), message, source: 'calendar', key: occ.key });
    };
    const where = (occ) => (occ.location ? ` (${occ.location})` : '');
    for (const occ of this.upcoming) {
      if (occ.start > now + lead + MIN) break; // sorted: nothing later is due yet
      if (occ.allDay) {
        const at = occ.start + ALL_DAY_HOUR * 60 * MIN;
        if (now >= at && now < occ.start + DAY && !this.fired.has(`${occ.key}|day`)) fire(occ, 'day', `Today: "${occ.title}" 📅${where(occ)}`);
        continue;
      }
      if (lead > 0 && now >= occ.start - lead && now < occ.start - MIN && !this.fired.has(`${occ.key}|lead`)) {
        const mins = Math.ceil((occ.start - now) / MIN);
        fire(occ, 'lead', `Prince! "${occ.title}" in ${mins} min${mins === 1 ? '' : 's'}${where(occ)}`);
      }
      if (atStart && now >= occ.start && now < occ.start + START_GRACE_MS && !this.fired.has(`${occ.key}|now`)) {
        const leadAt = this.fired.get(`${occ.key}|lead`);
        if (leadAt && now - leadAt < 3 * MIN) this.fired.set(`${occ.key}|now`, now); // just told you - don't nag twice
        else fire(occ, 'now', `Prince! "${occ.title}" is starting now${where(occ)}`);
      }
    }
    for (const [k, t] of this.fired) if (now - t > 2 * DAY) this.fired.delete(k);
    due.forEach((r) => this.emit('fire', r));
    return due;
  }

  status() {
    return {
      configured: !!this.url(),
      lastSync: this.lastSync,
      error: this.lastError ? friendly(this.lastError) : '',
      ...summary(this.upcoming, this.clock()),
    };
  }

  loadCache() {
    if (!this.cacheFile) return;
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (c.urlId && c.urlId === urlId(this.url()) && Array.isArray(c.upcoming)) {
        this.upcoming = c.upcoming.filter((o) => o && typeof o.key === 'string' && Number.isFinite(o.start));
        this.lastSync = Number(c.savedAt) || 0;
      }
    } catch {
      /* no cache yet */
    }
  }

  saveCache() {
    if (!this.cacheFile) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify({ urlId: urlId(this.url()), savedAt: this.lastSync, upcoming: this.upcoming }));
    } catch (err) {
      console.warn('[calendar] could not save cache:', err.message);
    }
  }
}

module.exports = {
  CalendarSync,
  CalendarError,
  parseIcs,
  occurrences,
  cleanCalendarUrl,
  ownerFromUrl,
  friendly,
  toMs,
  GCAL_SETTINGS_URL,
};
