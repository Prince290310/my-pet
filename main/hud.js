'use strict';
/*
 * hud.js - the Iron Man HUD: a see-through "helmet display" over your screen.
 *
 *   Ctrl+Alt+H (Settings → HUD)         show / hide it - it fades out by itself after a few seconds
 *   hud · show my hud · status report    the same from chat ("status report" from the phone = a text summary)
 *   hide hud
 *   weather · weather in Mumbai · will it rain tomorrow?     Open-Meteo - free, no key, no account
 *   set my city to Jaipur                                    the weather city for the HUD
 *
 * Everything on it comes from what Shadow already knows - exams.js, tasks.js, calendar.js, music.js,
 * care.js - plus CPU / RAM / disk readings. Only the city name ever leaves the PC (for the weather).
 * The window itself is click-through; only its panels take the mouse while the cursor is on them
 * (song controls, ticking off a to-do), and hovering a panel keeps the HUD open.
 */

const { EventEmitter } = require('events');
const os = require('os');
const { appName } = require('./music');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const GB = 1024 ** 3;

/** Settings → HUD hotkey choices (id -> Electron accelerator / label). */
const HOTKEYS = {
  'ctrl-alt-h': { accel: 'CommandOrControl+Alt+H', label: 'Ctrl+Alt+H' },
  'alt-shift-h': { accel: 'Alt+Shift+H', label: 'Alt+Shift+H' },
  'ctrl-alt-space': { accel: 'CommandOrControl+Alt+Space', label: 'Ctrl+Alt+Space' },
  'ctrl-shift-f12': { accel: 'CommandOrControl+Shift+F12', label: 'Ctrl+Shift+F12' },
  off: { accel: '', label: '' },
};
/** Settings → HUD → J.A.R.V.I.S. console hotkey. */
const JARVIS_HOTKEYS = {
  'ctrl-alt-j': { accel: 'CommandOrControl+Alt+J', label: 'Ctrl+Alt+J' },
  'alt-shift-j': { accel: 'Alt+Shift+J', label: 'Alt+Shift+J' },
  'ctrl-alt-k': { accel: 'CommandOrControl+Alt+K', label: 'Ctrl+Alt+K' },
  'ctrl-shift-f11': { accel: 'CommandOrControl+Shift+F11', label: 'Ctrl+Shift+F11' },
  off: { accel: '', label: '' },
};
const HUD_SECONDS = [0, 8, 12, 20, 30, 60]; // 0 = stays until you close it

// WMO weather codes (Open-Meteo) -> words + icon
const SKY = [
  [[0], 'Clear', '☀️', '🌙'],
  [[1], 'Mainly clear', '🌤️', '🌙'],
  [[2], 'Partly cloudy', '⛅', '☁️'],
  [[3], 'Overcast', '☁️', '☁️'],
  [[45, 48], 'Fog', '🌫️', '🌫️'],
  [[51, 53, 55, 56, 57], 'Drizzle', '🌦️', '🌧️'],
  [[61, 63, 65, 66, 67], 'Rain', '🌧️', '🌧️'],
  [[71, 73, 75, 77], 'Snow', '❄️', '❄️'],
  [[80, 81, 82], 'Rain showers', '🌦️', '🌧️'],
  [[85, 86], 'Snow showers', '🌨️', '🌨️'],
  [[95, 96, 99], 'Thunderstorm', '⛈️', '⛈️'],
];
function sky(code, isDay = true) {
  const row = SKY.find(([codes]) => codes.includes(Number(code)));
  return row ? { text: row[1], icon: isDay ? row[2] : row[3] } : { text: 'Unknown', icon: '🌡️' };
}

const clean = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey |ok |okay )?(?:shadow|jarvis|iron ?man|tony)?[,:!]?\s*/i, '')
    .replace(/^(?:please|pls|plz|can you|could you)\s+/i, '')
    .replace(/\s+(?:please|pls|plz|for me)$/i, '')
    .replace(/[?.!]+$/, '')
    .trim();

/** "Jaipur", "new delhi, india" -> a tidy city name ('' if it doesn't look like one). */
function cityName(s) {
  const t = String(s || '')
    .replace(/^(?:the city of|city of)\s+/i, '')
    .replace(/\s+(?:city|today|now|right now|tomorrow|tmrw|please)$/i, '')
    .replace(/[^\p{L}\p{M}\s,.'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length >= 2 && t.length <= 60 ? t : '';
}

/** Chat message -> HUD / weather command, or null. */
function parseHudCommand(input) {
  const t = clean(input);
  const l = t.toLowerCase();
  let m;
  if (/^(?:(?:show|open|bring up|pull up|launch|start|activate|turn on|display)(?: up)? (?:the |my )?)?(?:iron ?man |stark |helmet )?hud(?: display| view| mode)?(?: on)?$/.test(l)) return { type: 'show' };
  if (/^(?:status report|(?:system|systems|pc) (?:status|check|report)|give me (?:a )?status report)$/.test(l)) return { type: 'show', report: true };
  if (/^(?:hide|close|turn off|dismiss|exit) (?:the |my )?(?:iron ?man |stark )?hud$|^hud off$/.test(l)) return { type: 'hide' };
  if ((m = /^(?:set|change|update|make) (?:my |the )?(?:weather )?(?:city|location|town)(?: for (?:the )?weather)? (?:to|as) (.+)$/i.exec(t)) || (m = /^(?:my city is|i live in) (.+)$/i.exec(t))) {
    const city = cityName(m[1]);
    return city ? { type: 'city', city } : null;
  }
  const day = (s) => (/\b(?:tomorrow|tmrw|tmr|kal)\b/i.test(s) ? 'tomorrow' : 'today');
  const where = (s) => {
    const w = /\b(?:in|at|for) ([\p{L}][\p{L}\p{M}\s,.'-]{1,60})$/iu.exec(s.replace(/\s+(?:today|now|right now|tomorrow|tmrw|tmr)$/i, ''));
    return w ? cityName(w[1]) : '';
  };
  if (/^(?:will it|is it going to|is it gonna|does it look like it(?:'ll| will)|chance of|any chance of) rain\b|^(?:do i need|should i (?:take|carry)) (?:an? )?umbrella\b|^rain (?:today|tomorrow)$/i.test(l)) {
    return { type: 'weather', ask: 'rain', day: day(l), city: where(t) };
  }
  if (/^(?:(?:what'?s|whats|what is|how'?s|hows|how is) (?:the )?(?:weather|temperature|temp)(?: like)?|weather(?: report| update| forecast)?|(?:the )?forecast|temperature|how (?:hot|cold) is it(?: outside)?|is it (?:hot|cold) (?:today|outside))(?: (?:today|now|right now|outside|tomorrow|tmrw))?(?: (?:in|at|for) .+)?(?: (?:today|now|tomorrow))?$/i.test(l)) {
    return { type: 'weather', day: day(l), city: where(t) };
  }
  return null;
}

const pct = (n) => (Number.isFinite(n) ? `${Math.round(n)}%` : '–');
const gb = (b) => `${(b / GB).toFixed(b >= 100 * GB ? 0 : 1)} GB`;
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const keyMs = (k) => {
  const [y, mo, d] = k.split('-').map(Number);
  return new Date(y, mo - 1, d).getTime();
};
function clock12(ms) {
  const d = new Date(ms);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
function whenText(ms, now, allDay = false) {
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : new Date(ms).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  return allDay ? day : `${day} ${clock12(ms)}`;
}
const timeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
const KIND = { learn: '📖', revise: '🔁', mock: '📝', light: '🌙' };

/** The data behind the HUD (and "status report" / "weather" in chat). */
class HudData {
  /**
   * @param {object} o
   * @param {import('./settings').Settings} o.settings
   * @param {object} o.sources  { exams, tasks, calendar, music, care } - any may be missing
   * @param {object} [o.hooks]  tests: { cpu() }
   */
  constructor({ settings, sources = {}, fetchImpl, clock = () => Date.now(), hooks = {}, geoBase = 'https://geocoding-api.open-meteo.com', weatherBase = 'https://api.open-meteo.com' }) {
    this.settings = settings;
    this.sources = sources;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.clock = clock;
    this.hooks = hooks;
    this.geoBase = geoBase;
    this.weatherBase = weatherBase;
    this.cpuPrev = null; // our own CPU baseline (care.js keeps its own for its 2-minute checks)
    this.cache = { battery: null, online: null, music: null, geo: new Map(), weather: new Map() };
  }

  // ------------------------------------------------------------------ system
  /** CPU % since the last call (null on the very first). */
  cpu() {
    if (this.hooks.cpu) return this.hooks.cpu();
    const t = os.cpus().reduce(
      (a, c) => {
        const all = Object.values(c.times).reduce((x, y) => x + y, 0);
        return { idle: a.idle + c.times.idle, all: a.all + all };
      },
      { idle: 0, all: 0 }
    );
    const prev = this.cpuPrev;
    this.cpuPrev = t;
    if (!prev || t.all === prev.all) return null;
    return Math.max(0, Math.min(100, Math.round(100 * (1 - (t.idle - prev.idle) / (t.all - prev.all)))));
  }

  /** Fast readings: CPU, RAM, disk, uptime (+ the last battery/online readings). */
  async quickSystem() {
    const { care } = this.sources;
    const mem = care ? await care.mem() : { free: os.freemem(), total: os.totalmem() };
    let disk = null;
    try {
      disk = care ? await care.disk() : null;
    } catch {
      disk = null;
    }
    const uptime = care && care.hooks && care.hooks.uptime ? care.hooks.uptime() : os.uptime();
    return {
      cpu: this.cpu(),
      ram: { used: mem.total - mem.free, total: mem.total, pct: Math.round((100 * (mem.total - mem.free)) / mem.total) },
      disk: disk ? { free: disk.free, total: disk.total, pct: Math.round((100 * (disk.total - disk.free)) / disk.total) } : null,
      uptimeH: Math.round((uptime / 3600) * 10) / 10,
      battery: this.cache.battery ? this.cache.battery.value : undefined,
      online: this.cache.online ? this.cache.online.value : undefined,
    };
  }

  /** Slow readings (battery through PowerShell, an internet check), cached for a minute. */
  async slowSystem({ fresh = false } = {}) {
    const { care } = this.sources;
    const now = this.clock();
    const stale = (c, ms) => fresh || !c || now - c.at > ms;
    const jobs = [];
    if (care && stale(this.cache.battery, MIN)) {
      jobs.push(timeout(care.battery().catch(() => null), 8000, null).then((value) => (this.cache.battery = { at: now, value })));
    }
    if (care && stale(this.cache.online, 30 * 1000)) {
      jobs.push(timeout(care.online().catch(() => false), 6000, false).then((value) => (this.cache.online = { at: now, value })));
    }
    await Promise.all(jobs);
    return { battery: this.cache.battery ? this.cache.battery.value : null, online: this.cache.online ? this.cache.online.value : null };
  }

  // ------------------------------------------------------------------ missions
  missions() {
    const { exams, tasks, calendar } = this.sources;
    const now = this.clock();
    const today = dayKey(now);
    let exam = null;
    let nextExams = [];
    if (exams) {
      const list = exams.upcoming();
      nextExams = list.slice(0, 4).map((e) => ({ subject: e.subject || 'Exam', date: e.date, days: Math.round((keyMs(e.date) - keyMs(today)) / DAY) }));
      const e = list[0];
      if (e) {
        const total = list.reduce((n, x) => n + x.plan.length, 0);
        const done = list.reduce((n, x) => n + x.plan.filter((d) => d.done).length, 0);
        exam = {
          subject: e.subject || 'Exam',
          date: e.date,
          dateText: new Date(keyMs(e.date)).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }),
          days: Math.round((keyMs(e.date) - keyMs(today)) / DAY),
          countdown: exams.countdown(e),
          progress: { done, total },
          today: exams.today().map(({ exam: x, day }) => ({ subject: x.subject || 'Exam', icon: KIND[day.kind] || '📖', text: `${day.kind === 'revise' ? 'Revise ' : day.kind === 'mock' ? 'Mock test: ' : ''}${day.topics.join(', ')}`.slice(0, 90), done: !!day.done })),
        };
      }
    }
    let event = null;
    if (calendar && calendar.url && calendar.url()) {
      const next = (calendar.upcoming || []).find((o) => (o.allDay ? o.start + DAY > now : o.start > now - 5 * MIN));
      if (next) event = { title: String(next.title || 'Event').slice(0, 60), when: whenText(next.start, now, next.allDay), soon: !next.allDay && next.start - now < 60 * MIN };
    }
    const open = tasks ? tasks.openTodos() : [];
    const reminders = tasks ? tasks.pendingReminders() : [];
    return {
      exam,
      nextExams,
      event,
      todos: open.slice(0, 5).map((t) => ({ id: t.id, text: t.text.slice(0, 70), repeat: !!(tasks.repeatOf && tasks.repeatOf(t)) })),
      todoCount: open.length,
      reminders: reminders.slice(0, 3).map((r) => ({ text: r.text.slice(0, 60), when: whenText(r.at, now) })),
    };
  }

  // ------------------------------------------------------------------ music
  /** What's playing ({ title, artist, app, playing } / { none: true } / null when there are no music controls). */
  async music({ fresh = true } = {}) {
    const { music } = this.sources;
    if (!music || !music.available) return null;
    if (!fresh && this.cache.music) return this.cache.music;
    let r;
    try {
      r = await timeout(music.media('status'), 8000, { ok: false });
    } catch {
      r = { ok: false };
    }
    const value = r && r.ok && (r.title || r.app) ? { title: String(r.title || '').slice(0, 90), artist: String(r.artist || '').slice(0, 60), app: appName(r.app), playing: /playing/i.test(r.status || '') } : { none: true };
    this.cache.music = value;
    return value;
  }

  /** Play/pause toggle, next, previous -> the new state. */
  async mediaControl(action) {
    const { music } = this.sources;
    if (!music || !music.available || !['toggle', 'next', 'previous'].includes(action)) return this.music();
    let a = action;
    if (action === 'toggle') {
      const now = this.cache.music || (await this.music());
      a = now && now.playing ? 'pause' : 'play';
    }
    try {
      await music.media(a);
    } catch {
      /* the player didn't answer */
    }
    return this.music();
  }

  // ------------------------------------------------------------------ weather
  async getJson(url) {
    const res = await this.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: 'http' });
    return res.json();
  }

  /** "Jaipur" -> { name, country, lat, lon } (null = no such place). */
  async place(city) {
    const key = city.toLowerCase();
    if (this.cache.geo.has(key)) return this.cache.geo.get(key);
    const [name, country] = city.split(',').map((s) => s.trim());
    const j = await this.getJson(`${this.geoBase}/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`);
    const list = Array.isArray(j && j.results) ? j.results : [];
    const hit = (country && list.find((r) => [r.country, r.country_code, r.admin1].some((v) => String(v || '').toLowerCase() === country.toLowerCase()))) || list[0];
    const p = hit && Number.isFinite(hit.latitude) && Number.isFinite(hit.longitude) ? { name: String(hit.name).slice(0, 60), region: String(hit.admin1 || '').slice(0, 60), country: String(hit.country || '').slice(0, 60), lat: hit.latitude, lon: hit.longitude } : null;
    this.cache.geo.set(key, p);
    return p;
  }

  /**
   * Weather for a city (default: Settings → HUD → city). Cached for 15 minutes.
   * -> { ok:true, place, now:{temp, feels, humidity, wind, text, icon}, today:{min,max,rain,text,icon}, tomorrow }
   *  | { ok:false, reason: 'no-city' | 'unknown-city' | 'offline' }
   */
  async weather(cityAsked = '') {
    const city = cityName(cityAsked) || this.settings.get('weatherCity');
    if (!city) return { ok: false, reason: 'no-city' };
    let place;
    try {
      place = await this.place(city);
    } catch {
      return { ok: false, reason: 'offline', city };
    }
    if (!place) return { ok: false, reason: 'unknown-city', city };
    const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
    const hit = this.cache.weather.get(key);
    if (hit && this.clock() - hit.at < 15 * MIN) return hit.value;
    let j;
    try {
      j = await this.getJson(
        `${this.weatherBase}/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=2`
      );
    } catch {
      return { ok: false, reason: 'offline', city };
    }
    const c = (j && j.current) || {};
    const d = (j && j.daily) || {};
    const at = (arr, i) => (Array.isArray(arr) && Number.isFinite(Number(arr[i])) ? Math.round(Number(arr[i])) : null);
    const day = (i) => ({ min: at(d.temperature_2m_min, i), max: at(d.temperature_2m_max, i), rain: at(d.precipitation_probability_max, i), ...sky(at(d.weather_code, i), true) });
    if (!Number.isFinite(Number(c.temperature_2m))) return { ok: false, reason: 'offline', city };
    const value = {
      ok: true,
      place: place.name,
      region: place.region,
      country: place.country,
      now: { temp: Math.round(c.temperature_2m), feels: Math.round(Number(c.apparent_temperature ?? c.temperature_2m)), humidity: Math.round(Number(c.relative_humidity_2m) || 0), wind: Math.round(Number(c.wind_speed_10m) || 0), ...sky(c.weather_code, c.is_day !== 0) },
      today: day(0),
      tomorrow: day(1),
    };
    this.cache.weather.set(key, { at: this.clock(), value });
    return value;
  }

  /** The chat reply for a weather question. */
  async weatherText(cmd = {}) {
    const w = await this.weather(cmd.city);
    if (!w.ok) {
      if (w.reason === 'no-city') return 'Which city, Prince? Say "set my city to Jaipur" once (or Settings → HUD) and I\'ll always know 🌍';
      if (w.reason === 'unknown-city') return `I couldn't find a place called "${w.city}" 🤔 Try the nearest big city.`;
      return "Couldn't reach the weather service right now, Prince 🌐 Try again in a bit.";
    }
    const d = cmd.day === 'tomorrow' ? w.tomorrow : w.today;
    const range = d.min !== null && d.max !== null ? `${d.min}–${d.max}°C` : '';
    if (cmd.ask === 'rain') {
      const p = d.rain;
      if (p === null) return `${d.icon} ${w.place} ${cmd.day}: ${d.text.toLowerCase()}${range ? `, ${range}` : ''}.`;
      const verdict = p >= 60 ? '☔ Yes, most likely' : p >= 30 ? '🌦️ Maybe' : '🌤️ Probably not';
      return `${verdict} - ${p}% chance of rain in ${w.place} ${cmd.day}${p >= 50 ? '. Take an umbrella ☂️' : '.'}`;
    }
    if (cmd.day === 'tomorrow') return `${d.icon} ${w.place} tomorrow: ${d.text.toLowerCase()}${range ? `, ${range}` : ''}${d.rain !== null ? ` · ${d.rain}% chance of rain` : ''}`;
    return `${w.now.icon} ${w.place}: ${w.now.temp}°C (feels ${w.now.feels}°C), ${w.now.text.toLowerCase()}${range ? ` · today ${range}` : ''}${w.today.rain !== null ? ` · ${w.today.rain}% chance of rain` : ''}`;
  }

  /** "set my city to Jaipur": checks the place exists, saves it, answers with its weather. */
  async setCity(city) {
    let place;
    try {
      place = await this.place(city);
    } catch {
      this.settings.update({ weatherCity: city }); // offline right now: keep it, check later
      return `Saved ${city} as your city 🌍 (I couldn't check the weather just now.)`;
    }
    if (!place) return `I couldn't find a place called "${city}" 🤔 Try the nearest big city.`;
    this.settings.update({ weatherCity: place.name });
    const w = await this.weather(place.name);
    return `Got it - ${place.name}${place.region && place.region !== place.name ? `, ${place.region}` : ''} is your city now 🌍${w.ok ? ` Right now: ${w.now.icon} ${w.now.temp}°C, ${w.now.text.toLowerCase()}.` : ''}`;
  }

  // ------------------------------------------------------------------ text summary
  /** "status report" as text (the phone, or when the HUD can't be shown). */
  async statusText() {
    this.cpu();
    await new Promise((r) => setTimeout(r, this.hooks.cpu ? 0 : 600));
    const [sys, slow, music, weather] = await Promise.all([this.quickSystem(), this.slowSystem(), this.music(), this.weather().catch(() => ({ ok: false }))]);
    const m = this.missions();
    const lines = [];
    const bat = slow.battery ? ` · 🔋 ${slow.battery.percent}%${slow.battery.charging ? ' (charging)' : ''}` : '';
    lines.push(`💻 CPU ${pct(sys.cpu)} · RAM ${gb(sys.ram.used)}/${gb(sys.ram.total)}${sys.disk ? ` · ${gb(sys.disk.free)} free` : ''}${bat} · ${slow.online ? '🌐 online' : '📴 offline'}`);
    if (music && !music.none) lines.push(`🎵 ${music.title || 'Something'}${music.artist ? ` – ${music.artist}` : ''} (${music.app}${music.playing ? '' : ', paused'})`);
    if (m.exam) lines.push(`📚 ${m.exam.subject} exam ${m.exam.countdown}${m.exam.today.length ? ` - today: ${m.exam.today.map((x) => x.text).join(' + ')}` : ''}`);
    if (m.event) lines.push(`📅 ${m.event.title} - ${m.event.when}`);
    if (m.todoCount) lines.push(`📝 ${m.todoCount} to-do${m.todoCount === 1 ? '' : 's'} (top: ${m.todos[0].text})`);
    if (m.reminders.length) lines.push(`⏰ Next reminder: ${m.reminders[0].text} - ${m.reminders[0].when}`);
    if (weather && weather.ok) lines.push(`${weather.now.icon} ${weather.place} ${weather.now.temp}°C, ${weather.now.text.toLowerCase()}`);
    return `📊 Status report, Prince:\n${lines.join('\n')}`;
  }
}

/**
 * The HUD overlay window: show / hide / auto-fade, the hover check that makes its panels clickable,
 * and live refreshes while it's open. The window comes from windows.js (openHudWindow).
 */
class HudDisplay extends EventEmitter {
  /**
   * @param {object} o
   * @param {HudData} o.data
   * @param {(bounds) => object} o.createWindow   -> { win, send(channel, payload), alive() }
   * @param {object} o.sensors   { cursor(), displayAt(pt) }
   * @param {() => object} o.head   title, theme, greeting, hotkey label
   * @param {() => number} o.seconds   auto-fade after (0 = stays)
   */
  constructor({ data, createWindow, sensors, head, seconds = () => 12, test = false, timing = {} }) {
    super();
    this.data = data;
    this.createWindow = createWindow;
    this.sensors = sensors;
    this.head = head;
    this.seconds = seconds;
    this.test = test;
    this.timing = { system: 1500, music: 5000, pollMs: 50, leaveMs: 450, ...timing };
    this.w = null;
    this.ready = false;
    this.visible = false;
    this.hovering = false;
    this.deadline = 0;
    this.timers = [];
    this.pending = null; // the show() waiting for the page to load
    this.shownAt = 0;
    this.closing = null;
    this.cursorWasInside = false;
    this.busy = new Set(); // parts being fetched right now
    this.lastMusic = 0;
    this.mode = 'hud'; // hud | jarvis (the console, takes the keyboard) | brief | debrief (report card)
    this.report = null;
  }

  alive() {
    return !!(this.w && this.w.alive());
  }

  window() {
    return this.alive() ? this.w.win : null;
  }

  toggle(why = 'hotkey') {
    return this.visible ? this.hide(why) : this.show(why);
  }

  /**
   * Bring the HUD up on the screen the mouse is on.
   * mode: 'hud' | 'jarvis' (console, focused) | 'brief' / 'debrief' (with `report` in the centre)
   */
  show(why = 'chat', { mode = 'hud', report = null, speak = false } = {}) {
    if (this.visible && this.ready && this.alive()) return this.switchTo(mode, report, speak);
    this.mode = mode;
    this.report = report;
    this.speakIt = speak;
    clearTimeout(this.closing);
    this.closing = null;
    const display = this.sensors.displayAt(this.sensors.cursor());
    const wa = display.workArea;
    if (!this.alive()) {
      this.ready = false;
      this.w = this.createWindow(wa);
      const w = this.w;
      const gone = () => {
        if (this.w !== w) return;
        this.visible = false;
        this.stopTimers();
        this.w = null; // a fresh window next time
        if (!w.win.isDestroyed()) w.win.destroy();
      };
      w.win.webContents.on('render-process-gone', gone);
      w.win.on('closed', gone);
      // the console has the keyboard: clicking into another app starts the fade, coming back stops it
      w.win.on('blur', () => this.visible && this.mode === 'jarvis' && !this.hovering && this.fadeIn(10000));
      w.win.on('focus', () => this.visible && this.mode === 'jarvis' && this.fadeIn(0));
    } else {
      this.w.win.setBounds(wa);
    }
    this.visible = true;
    this.hovering = false;
    this.shownAt = Date.now();
    this.emit('show', why);
    const go = () => {
      if (!this.visible || !this.alive()) return;
      this.w.win.showInactive();
      this.w.win.setAlwaysOnTop(true, 'screen-saver');
      this.w.win.moveTop();
      this.w.send('hud:show', { head: this.head(), test: this.test, width: wa.width, height: wa.height, mode: this.mode, report: this.report, speak: this.speakIt });
      this.focusConsole(this.mode === 'jarvis');
      this.refresh(true);
      this.startTimers();
    };
    if (this.ready) go();
    else this.pending = go;
    return true;
  }

  onReady() {
    this.ready = true;
    const go = this.pending;
    this.pending = null;
    if (go) go();
  }

  /** Fade out (the page plays its closing animation, then the window hides). */
  hide(why = 'chat') {
    if (!this.visible) return false;
    this.visible = false;
    this.pending = null;
    this.stopTimers();
    this.setInteractive(false);
    this.talking = false;
    this.emit('hide', why);
    if (!this.alive()) return true;
    this.focusConsole(false);
    this.w.send('hud:hide');
    clearTimeout(this.closing);
    this.closing = setTimeout(() => this.hidden(), this.timing.leaveMs + 400); // in case the page never answers
    return true;
  }

  /** The page finished its closing animation. */
  hidden() {
    clearTimeout(this.closing);
    this.closing = null;
    if (this.visible || !this.alive()) return;
    this.w.win.hide();
  }

  setInteractive(on) {
    if (!this.alive()) return;
    on = !!on && this.visible;
    if (this.hovering === on) return;
    this.hovering = on;
    this.w.win.setIgnoreMouseEvents(!on, { forward: !this.test });
    if (!on && this.deadline) this.extend(3000); // moved off a panel: a little more time to read
    if (!on && this.mode === 'jarvis' && !this.w.win.isFocused() && !this.deadline) this.fadeIn(10000); // left the console for another app
  }

  /** Make sure the HUD stays up at least `ms` more (only while it's fading by itself). */
  extend(ms) {
    if (!this.visible || !this.deadline) return;
    this.deadline = Math.max(this.deadline, Date.now() + ms);
    if (this.alive()) this.w.send('hud:timer', { ms: this.deadline - Date.now() });
  }

  /** Start fading out in `ms` (0 = stay up). */
  fadeIn(ms) {
    if (!this.visible) return;
    this.deadline = ms ? Date.now() + ms : 0;
    if (this.alive()) this.w.send('hud:timer', { ms });
  }

  /** How long this mode stays up by itself (0 = until closed). The console stays while it's in use. */
  fadeMs() {
    const secs = this.seconds();
    if (this.mode === 'jarvis' || !secs) return 0;
    if (this.talking) return 0; // she's still speaking
    if (['brief', 'debrief', 'news'].includes(this.mode)) return Math.max(60, secs) * 1000; // time to read it
    return secs * 1000;
  }

  /** Already up: switch what it shows (and who has the keyboard). */
  switchTo(mode, report = null, speak = false) {
    this.mode = mode;
    if (report) this.report = report;
    if (!this.alive()) return true;
    this.w.send('hud:mode', { mode, report: report || null, speak });
    this.focusConsole(mode === 'jarvis');
    this.fadeIn(this.fadeMs());
    return true;
  }

  /** The console takes the keyboard (the HUD is otherwise never focusable). */
  focusConsole(on) {
    if (!this.alive()) return;
    const win = this.w.win;
    if (on) {
      win.setFocusable(true);
      win.focus();
      win.webContents.focus();
      this.w.send('hud:focus');
    } else if (win.isFocusable()) {
      win.setFocusable(false);
    }
  }

  /** She started / stopped talking: stay up while she speaks, then the usual fade (30 s for a report). */
  speaking(on) {
    this.talking = !!on;
    if (!this.visible) return;
    if (on) return this.fadeIn(0);
    if (this.mode === 'jarvis' || !this.seconds()) return;
    this.fadeIn(['brief', 'debrief', 'news'].includes(this.mode) ? 30000 : this.fadeMs());
  }

  /** The AI's nicer summary arrived after the report was already up. */
  updateReport(patch) {
    if (!this.report) return;
    Object.assign(this.report, patch);
    if (this.visible && this.alive()) this.w.send('hud:report', patch);
  }

  startTimers() {
    this.stopTimers();
    const ms = this.fadeMs();
    this.deadline = ms ? Date.now() + ms : 0;
    if (this.alive()) this.w.send('hud:timer', { ms });
    const every = (ms, fn) => this.timers.push(setInterval(fn, ms));
    every(this.timing.system, () => this.push('system'));
    // the song: every 5 s at first, then every 15 s if the HUD is left open (each check runs PowerShell)
    every(this.timing.music, () => {
      if (Date.now() - this.shownAt < 30 * 1000 || Date.now() - (this.lastMusic || 0) >= 3 * this.timing.music - 100) this.push('music');
    });
    every(this.timing.pollMs, () => this.poll());
    every(250, () => {
      if (this.deadline && !this.hovering && Date.now() >= this.deadline) this.hide('timeout');
    });
  }

  stopTimers() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.deadline = 0;
  }

  /** Cursor over the HUD -> tell the page where, so it can tell us whether that's a panel. */
  poll() {
    if (!this.visible || !this.alive()) return;
    const c = this.sensors.cursor();
    const b = this.w.win.getBounds();
    const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
    if (inside || this.cursorWasInside || this.hovering) this.w.send('hud:cursor', { inside, x: c.x - b.x, y: c.y - b.y, interactive: this.hovering });
    this.cursorWasInside = inside;
  }

  /** Send one part (or everything) to the page. */
  async push(part) {
    if (!this.visible || !this.alive() || this.busy.has(part)) return; // the last one is still running
    if (part === 'music') this.lastMusic = Date.now();
    const send = (d) => this.visible && this.alive() && this.w.send('hud:data', d);
    this.busy.add(part);
    try {
      if (part === 'system') send({ system: await this.data.quickSystem() });
      else if (part === 'missions') send({ missions: this.data.missions() });
      else if (part === 'music') send({ music: await this.data.music() });
      else if (part === 'slow') send({ slow: await this.data.slowSystem() });
      else if (part === 'weather') send({ weather: await this.data.weather() });
    } catch (err) {
      console.warn(`[hud] ${part}:`, err.message);
    } finally {
      this.busy.delete(part);
    }
  }

  /** Everything, fast parts first. */
  refresh(first = false) {
    if (first) this.data.cpu(); // baseline, so the first real CPU reading comes ~0.5 s later
    this.push('missions');
    this.push('system');
    setTimeout(() => this.push('system'), 500);
    this.push('slow');
    this.push('music');
    this.push('weather');
  }

  async media(action) {
    this.extend(4000);
    const now = await this.data.mediaControl(action);
    if (this.visible && this.alive()) this.w.send('hud:data', { music: now });
    return now;
  }

  destroy() {
    this.stopTimers();
    if (this.alive()) this.w.win.destroy();
    this.w = null;
  }
}

module.exports = { HudData, HudDisplay, parseHudCommand, cityName, sky, HOTKEYS, JARVIS_HOTKEYS, HUD_SECONDS };
