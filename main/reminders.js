'use strict';
// Checks reminders.json entries against the clock and emits 'fire' once per reminder per day.

const { EventEmitter } = require('events');
const { DAYS } = require('./config');

const pad = (n) => String(n).padStart(2, '0');

class ReminderScheduler extends EventEmitter {
  constructor(store, { intervalMs = 10000, clock = () => new Date() } = {}) {
    super();
    this.store = store;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.fired = new Set();
    this.timer = null;
  }

  start() {
    this.check();
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  check(now = this.clock()) {
    const day = DAYS[now.getDay()];
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const dateKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const due = [];
    for (const r of this.store.reminders) {
      if (r.time !== hhmm || !r.days.includes(day)) continue;
      const key = `${dateKey}|${r.time}|${r.message}`;
      if (this.fired.has(key)) continue;
      this.fired.add(key);
      due.push(r);
    }
    // forget keys from previous days
    for (const k of this.fired) if (!k.startsWith(dateKey)) this.fired.delete(k);
    due.forEach((r) => this.emit('fire', r));
    return due;
  }
}

module.exports = { ReminderScheduler };
