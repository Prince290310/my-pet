'use strict';
// User settings, saved as JSON in the app's user-data folder.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { PROVIDERS, DEFAULT_PROVIDER } = require('./ai');
const { cleanCalendarUrl } = require('./calendar');

const DEFAULTS = Object.freeze({
  petName: 'Shadow',
  scale: 2, // 1x / 2x / 3x
  quipMinMinutes: 20, // random idle quip every min..max minutes
  quipMaxMinutes: 40,
  sleepTimeoutMinutes: 5, // no mouse/keyboard activity for this long -> nap
  muteQuips: false,
  aiProvider: DEFAULT_PROVIDER, // chat brain: gemini | groq | openrouter | ollama | claude | custom
  aiModel: '', // blank = the provider's recommended model
  aiBaseUrl: '', // custom/ollama only; blank = default
  apiKeys: {}, // one key per provider, e.g. { gemini: '...' }
  calendarUrl: '', // Google Calendar "Secret address in iCal format" (blank = calendar off)
  calendarLeadMinutes: 10, // heads-up this many minutes before each event (0 = off)
  calendarAtStart: true, // also remind when the event starts
  calendarInChat: true, // chat AI can see upcoming events ("what's on tomorrow?")
  morningBriefing: true, // first time at the PC each day: today's events, to-dos, reminders
  todoNudges: true, // idle quips sometimes nudge about an open to-do
  position: null, // last pet position {x, y}
});

function cleanKeys(raw, legacyKey, provider) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, key] of Object.entries(raw)) {
      if (PROVIDERS[id] && typeof key === 'string' && key.trim()) out[id] = key.trim().slice(0, 500);
    }
  }
  // settings from the first version had a single "apiKey"
  if (typeof legacyKey === 'string' && legacyKey.trim() && !out[provider]) out[provider] = legacyKey.trim().slice(0, 500);
  return out;
}

function cleanUrl(v) {
  const s = typeof v === 'string' ? v.trim().slice(0, 300) : '';
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : '';
}

const int = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function validate(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const name = typeof s.petName === 'string' ? s.petName.trim().slice(0, 24) : '';
  const out = {
    petName: name || DEFAULTS.petName,
    scale: [1, 2, 3].includes(Number(s.scale)) ? Number(s.scale) : DEFAULTS.scale,
    quipMinMinutes: int(s.quipMinMinutes, 1, 720, DEFAULTS.quipMinMinutes),
    quipMaxMinutes: int(s.quipMaxMinutes, 1, 720, DEFAULTS.quipMaxMinutes),
    sleepTimeoutMinutes: int(s.sleepTimeoutMinutes, 1, 240, DEFAULTS.sleepTimeoutMinutes),
    muteQuips: Boolean(s.muteQuips),
    aiProvider: PROVIDERS[s.aiProvider] ? s.aiProvider : DEFAULT_PROVIDER,
    aiModel: typeof s.aiModel === 'string' ? s.aiModel.trim().slice(0, 120) : '',
    aiBaseUrl: cleanUrl(s.aiBaseUrl),
    apiKeys: {},
    calendarUrl: cleanCalendarUrl(s.calendarUrl),
    calendarLeadMinutes: int(s.calendarLeadMinutes, 0, 1440, DEFAULTS.calendarLeadMinutes),
    calendarAtStart: s.calendarAtStart === undefined ? DEFAULTS.calendarAtStart : Boolean(s.calendarAtStart),
    calendarInChat: s.calendarInChat === undefined ? DEFAULTS.calendarInChat : Boolean(s.calendarInChat),
    morningBriefing: s.morningBriefing === undefined ? DEFAULTS.morningBriefing : Boolean(s.morningBriefing),
    todoNudges: s.todoNudges === undefined ? DEFAULTS.todoNudges : Boolean(s.todoNudges),
    position:
      s.position && Number.isFinite(s.position.x) && Number.isFinite(s.position.y)
        ? { x: Math.round(s.position.x), y: Math.round(s.position.y) }
        : null,
  };
  if (out.quipMaxMinutes < out.quipMinMinutes) out.quipMaxMinutes = out.quipMinMinutes;
  out.apiKeys = cleanKeys(s.apiKeys, s.apiKey, out.aiProvider);
  return out;
}

class Settings extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[settings] could not read, using defaults:', err.message);
    }
    this.data = validate(raw);
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return { ...this.data };
  }

  /** Merge a patch, validate, save, and emit 'change' with the list of changed keys. */
  update(patch) {
    const next = validate({ ...this.data, ...patch });
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(this.data[k]));
    this.data = next;
    if (changed.length) {
      this.save();
      this.emit('change', this.all(), changed);
    }
    return this.all();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, DEFAULTS, validate };
