'use strict';
// Loads config/quips.json, config/reminders.json and config/personality.md,
// and hot-reloads them whenever you save an edit.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ALIASES = {
  daily: DAYS,
  everyday: DAYS,
  weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  weekends: ['Sat', 'Sun'],
};

// Used only if quips.json is missing or broken on the very first load.
const FALLBACK_QUIPS = {
  greetings: ['Haan bolo, Prince?'],
  idle: ['Still here, Prince. Still fabulous.'],
  wakeup: ['*yawn* Okay, I am up.'],
  sleepy: ['Nap time... Zzz'],
  happy: ['Purrr...'],
  drag: ['Whoa, careful!'],
  reminderDone: ['Done? Good.'],
};

function normalizeDay(d) {
  const key = String(d).trim().toLowerCase();
  if (DAY_ALIASES[key]) return DAY_ALIASES[key];
  const hit = DAYS.find((x) => x.toLowerCase() === key.slice(0, 3));
  return hit ? [hit] : [];
}

/** Returns { reminders, warnings }. Accepts either [ ... ] or { "reminders": [ ... ] }. */
function parseReminders(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json && json.reminders) ? json.reminders : null;
  if (!list) throw new Error('expected a "reminders" list');
  const reminders = [];
  const warnings = [];
  list.forEach((r, i) => {
    if (!r || typeof r !== 'object') return warnings.push(`entry ${i + 1} is not an object`);
    if (r.enabled === false) return;
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(r.time || '').trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return warnings.push(`entry ${i + 1}: time must look like "09:00"`);
    if (typeof r.message !== 'string' || !r.message.trim()) return warnings.push(`entry ${i + 1}: missing "message"`);
    let days = DAYS;
    if (r.days !== undefined) {
      const raw = Array.isArray(r.days) ? r.days : [r.days];
      days = [...new Set(raw.flatMap(normalizeDay))];
      if (!days.length) return warnings.push(`entry ${i + 1}: no valid days`);
    }
    reminders.push({ time: `${m[1].padStart(2, '0')}:${m[2]}`, days, message: r.message.trim() });
  });
  return { reminders, warnings };
}

function parseQuips(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('expected { "category": ["line", ...] }');
  const out = {};
  for (const [cat, lines] of Object.entries(json)) {
    if (cat.startsWith('_')) continue; // "_help" etc.
    if (!Array.isArray(lines)) continue;
    const clean = lines.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim());
    if (clean.length) out[cat] = clean;
  }
  if (!Object.keys(out).length) throw new Error('no quip categories found');
  return out;
}

class ConfigStore extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.quips = { ...FALLBACK_QUIPS };
    this.reminders = [];
    this.personality = '';
    this.recent = {}; // category -> recently used lines (avoid repeats)
    this.watching = [];
  }

  file(name) {
    return path.join(this.dir, name);
  }

  start(pollMs = 1000) {
    this.loadQuips();
    this.loadReminders();
    this.loadPersonality();
    const watch = (name, fn) => {
      const f = this.file(name);
      // fs.watchFile polls the file's mtime: works with every editor (including atomic saves) and OneDrive.
      fs.watchFile(f, { interval: pollMs }, (cur, prev) => {
        if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) fn();
      });
      this.watching.push(f);
    };
    watch('quips.json', () => this.loadQuips());
    watch('reminders.json', () => this.loadReminders());
    watch('personality.md', () => this.loadPersonality());
  }

  stop() {
    this.watching.forEach((f) => fs.unwatchFile(f));
    this.watching = [];
  }

  readJSON(name) {
    const text = fs.readFileSync(this.file(name), 'utf8').replace(/^﻿/, '');
    return JSON.parse(text);
  }

  loadQuips() {
    try {
      this.quips = parseQuips(this.readJSON('quips.json'));
      this.recent = {};
      this.emit('quips', this.quips);
      return true;
    } catch (err) {
      this.emit('error', { file: 'quips.json', message: err.message });
      return false;
    }
  }

  loadReminders() {
    try {
      const { reminders, warnings } = parseReminders(this.readJSON('reminders.json'));
      this.reminders = reminders;
      if (warnings.length) this.emit('warning', { file: 'reminders.json', warnings });
      this.emit('reminders', reminders);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.reminders = [];
        this.emit('reminders', []);
        return true;
      }
      this.emit('error', { file: 'reminders.json', message: err.message });
      return false;
    }
  }

  loadPersonality() {
    try {
      this.personality = fs.readFileSync(this.file('personality.md'), 'utf8');
    } catch {
      this.personality = '';
    }
  }

  /** Random line from a category, avoiding recent repeats. {name} -> pet name. */
  pick(category, vars = {}) {
    const lines = this.quips[category] || FALLBACK_QUIPS[category] || this.quips.idle || [''];
    const recent = (this.recent[category] = this.recent[category] || []);
    const fresh = lines.filter((l) => !recent.includes(l));
    const pool = fresh.length ? fresh : lines;
    const line = pool[Math.floor(Math.random() * pool.length)];
    recent.push(line);
    while (recent.length > Math.floor(lines.length / 2)) recent.shift();
    return line.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  }

  quipCount() {
    return Object.values(this.quips).reduce((n, l) => n + l.length, 0);
  }
}

module.exports = { ConfigStore, parseReminders, parseQuips, DAYS };
