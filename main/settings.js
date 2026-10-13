'use strict';
// User settings, saved as JSON in the app's user-data folder.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { PROVIDERS, DEFAULT_PROVIDER } = require('./ai');
const { cleanCalendarUrl } = require('./calendar');
const { HOTKEYS, JARVIS_HOTKEYS, HUD_SECONDS, cityName } = require('./hud');

const DEFAULTS = Object.freeze({
  appearance: 'avengers', // avengers | shadow (original theme, restored instantly)
  mainHero: 'ironman', // Selected Avengers leader; original theme ignores this preference.
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
  webSearch: true, // chat may look things up (Tavily with searchKey, otherwise Wikipedia)
  pcControl: true, // chat may open apps/folders/settings and lock/sleep/screenshot/volume (apps.js)
  whatsappAutomation: false, // explicit WhatsApp Desktop messages and calls (Windows only)
  whatsappCallType: 'voice', // voice | video, overridden by an explicit command
  pcCare: true, // Zen warns about battery, storage, RAM/CPU and internet (care.js)
  musicService: 'youtube', // where "play <song>" plays: youtube | ytmusic | spotify (music.js)
  spotifyClientId: '', // your own free app at developer.spotify.com (spotify.js)
  spotifyRefreshToken: '', // kept after you log in to Spotify (a password - stays on this PC)
  spotifyUser: '', // display name, for Settings
  spotifyProduct: '', // premium | free ('' = not connected)
  startupRoutine: [], // "open spotify", "play lofi", ... run when Windows starts (startup.js)
  startupOnWake: true, // ...and when the PC wakes up after sleeping 4+ hours
  phoneFiles: true, // Telegram: phone -> PC files, and "send me notes.pdf" (files.js)
  phoneFilesScope: 'folders', // where the phone may get files from: folders (main ones) | pc (all drives)
  examStudyTime: '18:00', // daily study reminder for the exam planner (exams.js)
  hudHotkey: 'ctrl-alt-h', // Iron Man HUD hotkey (hud.js): ctrl-alt-h | alt-shift-h | ctrl-alt-space | ctrl-shift-f12 | off
  hudSeconds: 12, // the HUD fades out after this long (0 = stays until you close it)
  hudSound: true, // short power-up sound when it opens
  weatherCity: '', // city for the HUD / "weather" (Open-Meteo - free, no key)
  jarvisHotkey: 'ctrl-alt-j', // the J.A.R.V.I.S. console in the HUD (jarvis.js)
  hudBrief: true, // the HUD briefs you some minutes after you open the laptop (briefing.js)
  hudBriefDelay: 15, // ...this many minutes after
  hudDebrief: true, // a debrief every 12 hours
  hudDebriefTime: '21:00', // ...at this time and 12 hours later
  voiceOn: true, // J.A.R.V.I.S. reads the briefings, debriefs, news and console answers aloud
  voiceAuto: true, // ...the automatic briefing/debrief too (not just when asked)
  voiceName: '', // '' = a female English voice, Indian English first
  voiceRate: 'normal', // slow | normal | fast
  newsOn: true, // headlines in the briefing (news.js - Google News, no key)
  newsTopics: { banking: true, india: true, world: true }, // RBI & banking, India, World
  newsTopic: '', // one more topic to follow, e.g. "cricket"
  telegramEnabled: false, // control Shadow from your phone (telegram.js)
  telegramToken: '', // your bot's token from @BotFather (a password - stays on this PC)
  telegramChatId: 0, // the paired Telegram chat (only this one is listened to)
  telegramNotify: true, // reminders + PC alerts also go to the phone when you're away
  friendsMode: 'occasional', // always | working | occasional (friends.js)
  friends: { atlas: true, dash: true, bolt: true, sage: true, zen: true, tempo: true, vision: true, wanda: true, widow: true, panther: true, hawkeye: true, antman: true, falcon: true, warmachine: true }, // which friends are switched on
  searchKey: '', // free Tavily key (app.tavily.com)
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
    appearance: ['avengers', 'shadow'].includes(s.appearance) ? s.appearance : DEFAULTS.appearance,
    mainHero: ['ironman', 'spiderman', 'cap', 'thor', 'strange', 'hulk', 'quicksilver'].includes(s.mainHero) ? s.mainHero : DEFAULTS.mainHero,
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
    webSearch: s.webSearch === undefined ? DEFAULTS.webSearch : Boolean(s.webSearch),
    pcControl: s.pcControl === undefined ? DEFAULTS.pcControl : Boolean(s.pcControl),
    whatsappAutomation: s.whatsappAutomation === true,
    whatsappCallType: ['voice', 'video'].includes(s.whatsappCallType) ? s.whatsappCallType : 'voice',
    pcCare: s.pcCare === undefined ? DEFAULTS.pcCare : Boolean(s.pcCare),
    musicService: ['youtube', 'ytmusic', 'spotify'].includes(s.musicService) ? s.musicService : DEFAULTS.musicService,
    spotifyClientId: typeof s.spotifyClientId === 'string' && /^[0-9a-f]{32}$/i.test(s.spotifyClientId.trim()) ? s.spotifyClientId.trim() : '',
    spotifyRefreshToken: typeof s.spotifyRefreshToken === 'string' && /^[\w.~+/=-]{20,2000}$/.test(s.spotifyRefreshToken) ? s.spotifyRefreshToken : '',
    spotifyUser: typeof s.spotifyUser === 'string' ? s.spotifyUser.slice(0, 60) : '',
    spotifyProduct: ['premium', 'free'].includes(s.spotifyProduct) ? s.spotifyProduct : '',
    startupRoutine: Array.isArray(s.startupRoutine)
      ? s.startupRoutine.filter((x) => typeof x === 'string' && /^(?:open|play) \S/.test(x) && x.length <= 90).slice(0, 10)
      : [],
    startupOnWake: s.startupOnWake === undefined ? DEFAULTS.startupOnWake : Boolean(s.startupOnWake),
    phoneFiles: s.phoneFiles === undefined ? DEFAULTS.phoneFiles : Boolean(s.phoneFiles),
    phoneFilesScope: ['folders', 'pc'].includes(s.phoneFilesScope) ? s.phoneFilesScope : DEFAULTS.phoneFilesScope,
    examStudyTime: typeof s.examStudyTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.examStudyTime) ? s.examStudyTime : DEFAULTS.examStudyTime,
    hudHotkey: Object.prototype.hasOwnProperty.call(HOTKEYS, s.hudHotkey) ? s.hudHotkey : DEFAULTS.hudHotkey,
    hudSeconds: HUD_SECONDS.includes(Number(s.hudSeconds)) ? Number(s.hudSeconds) : DEFAULTS.hudSeconds,
    hudSound: s.hudSound === undefined ? DEFAULTS.hudSound : Boolean(s.hudSound),
    weatherCity: typeof s.weatherCity === 'string' ? cityName(s.weatherCity) : '',
    jarvisHotkey: Object.prototype.hasOwnProperty.call(JARVIS_HOTKEYS, s.jarvisHotkey) ? s.jarvisHotkey : DEFAULTS.jarvisHotkey,
    hudBrief: s.hudBrief === undefined ? DEFAULTS.hudBrief : Boolean(s.hudBrief),
    hudBriefDelay: [0, 5, 10, 15, 30, 60].includes(Number(s.hudBriefDelay)) ? Number(s.hudBriefDelay) : DEFAULTS.hudBriefDelay,
    hudDebrief: s.hudDebrief === undefined ? DEFAULTS.hudDebrief : Boolean(s.hudDebrief),
    hudDebriefTime: typeof s.hudDebriefTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.hudDebriefTime) ? s.hudDebriefTime : DEFAULTS.hudDebriefTime,
    voiceOn: s.voiceOn === undefined ? DEFAULTS.voiceOn : Boolean(s.voiceOn),
    voiceAuto: s.voiceAuto === undefined ? DEFAULTS.voiceAuto : Boolean(s.voiceAuto),
    voiceName: typeof s.voiceName === 'string' ? s.voiceName.slice(0, 120) : '',
    voiceRate: ['slow', 'normal', 'fast'].includes(s.voiceRate) ? s.voiceRate : DEFAULTS.voiceRate,
    newsOn: s.newsOn === undefined ? DEFAULTS.newsOn : Boolean(s.newsOn),
    newsTopics: Object.fromEntries(['banking', 'india', 'world'].map((k) => [k, s.newsTopics && typeof s.newsTopics[k] === 'boolean' ? s.newsTopics[k] : true])),
    newsTopic: typeof s.newsTopic === 'string' ? s.newsTopic.replace(/[^\p{L}\p{N}\s&'.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '',
    telegramEnabled: Boolean(s.telegramEnabled),
    telegramToken: typeof s.telegramToken === 'string' && /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(s.telegramToken.trim()) ? s.telegramToken.trim() : '',
    telegramChatId: Number.isSafeInteger(Number(s.telegramChatId)) ? Number(s.telegramChatId) : 0,
    telegramNotify: s.telegramNotify === undefined ? DEFAULTS.telegramNotify : Boolean(s.telegramNotify),
    friendsMode: ['always', 'working', 'occasional'].includes(s.friendsMode) ? s.friendsMode : DEFAULTS.friendsMode,
    friends: Object.fromEntries(Object.keys(DEFAULTS.friends).map((id) => [id, s.friends && typeof s.friends[id] === 'boolean' ? s.friends[id] : true])),
    searchKey: typeof s.searchKey === 'string' && /^[\w-]{0,200}$/.test(s.searchKey.trim()) ? s.searchKey.trim() : '',
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
    const next = validate({ ...this.data, ...patch, ...(patch.friends ? { friends: { ...this.data.friends, ...patch.friends } } : {}) });
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
