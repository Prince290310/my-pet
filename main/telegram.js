'use strict';
/*
 * telegram.js - control Shadow from your phone through your own Telegram bot.
 *
 * Setup (Settings -> Phone): make a bot with @BotFather, paste its token, then open the pairing
 * link (or send "/start <code>" to the bot). From then on ONLY your Telegram account is listened to;
 * messages from anyone else are ignored.
 *
 * Every message goes through the same handler as Shadow's chat panel, so everything works:
 * "open spotify", "lock my pc", "take a screenshot" (the picture is sent back), "pc health",
 * "remind me at 6 to call mom", questions, searches, music...
 *
 * Files: send the bot a photo / PDF / document / video / voice note and it lands in Downloads\Shadow;
 * "send me notes.pdf" sends a file from the PC back (see files.js for the rules).
 *
 * - Long polling (getUpdates): no server, no open ports - Shadow asks Telegram for new messages.
 * - Messages older than 10 minutes (PC was asleep/off) are NOT run - you get told instead.
 * - The bot token is a password: it stays in your settings file and is never logged.
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const POLL_TIMEOUT_S = 50;
const STALE_S = 10 * 60;
const MAX_TEXT = 4000;
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const MAX_DOWNLOAD = 20 * 1024 * 1024; // Telegram lets bots download files up to 20 MB

/** The file in a message (document, photo, video, ...) -> { id, name, size } or null. */
function fileOf(m, now = new Date()) {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const pick = (f, fallback) => f && { id: f.file_id, name: f.file_name || fallback, size: Number(f.file_size) || 0 };
  if (m.document) return pick(m.document, `file-${stamp}`);
  if (Array.isArray(m.photo) && m.photo.length) return pick(m.photo[m.photo.length - 1], `photo-${stamp}.jpg`); // largest size
  if (m.video) return pick(m.video, `video-${stamp}.mp4`);
  if (m.audio) return pick(m.audio, `audio-${stamp}.${/ogg/.test(m.audio.mime_type || '') ? 'ogg' : 'mp3'}`);
  if (m.voice) return pick(m.voice, `voice-note-${stamp}.ogg`);
  if (m.video_note) return pick(m.video_note, `video-note-${stamp}.mp4`);
  if (m.animation) return pick(m.animation, `animation-${stamp}.mp4`);
  return null;
}

const HELP = [
  "🐾 Shadow here! Text me like you'd chat on the PC. Some ideas:",
  '• open spotify / open downloads / lock my pc',
  '• take a screenshot (I send you the picture)',
  '• pc health · tidy my downloads',
  '• play something chill · next song · what\'s playing',
  '• remind me at 6 pm to call mom · todo: physics homework · show my list',
  '• call the gang · teach me photosynthesis · any question',
  '• send me a photo/PDF/file → saved to Downloads\\Shadow on the PC',
  '• send me my maths notes · send me notes.pdf from D drive · send me the College folder (zipped)',
  '• browse → your folders as a numbered list (reply a number, "back", "more")',
  "Your PC has to be on with me running. Messages older than 10 minutes are skipped (I'll tell you).",
].join('\n');

class TelegramLink extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./settings').Settings} o.settings
   * @param {(text: string) => Promise<{text: string, sources?: Array, photo?: string, document?: string}>} o.handle
   * @param {(f: {buffer: Buffer, name: string, caption: string}) => Promise<string>} [o.onFile]  a file from the phone -> reply
   */
  constructor({ settings, handle, onFile = null, apiBase = 'https://api.telegram.org', fetchImpl, clock = () => Date.now() }) {
    super();
    this.settings = settings;
    this.handle = handle;
    this.onFile = onFile;
    this.apiBase = apiBase;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.clock = clock;
    this.running = false;
    this.offset = 0;
    this.abort = null;
    this.bot = null; // { username, first_name }
    this.status = { state: 'off', error: '' };
    this.pairCode = String(crypto.randomInt(100000, 1000000));
    this.busy = Promise.resolve();
  }

  token() {
    const t = this.settings.get('telegramToken');
    return TOKEN_RE.test(t) ? t : '';
  }

  owner() {
    return this.settings.get('telegramChatId') || 0;
  }

  async api(method, body, { token = this.token(), timeoutMs = 20000, form = null } = {}) {
    const res = await this.fetch(`${this.apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: form ? undefined : { 'Content-Type': 'application/json' },
      body: form || JSON.stringify(body || {}),
      signal: this.abort ? AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    let j = {};
    try {
      j = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok || !j.ok) {
      const err = new Error(j.description || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return j.result;
  }

  setStatus(state, error = '') {
    this.status = { state, error };
    this.emit('status', this.info());
  }

  info() {
    return {
      state: this.status.state, // off | connecting | waiting-pair | paired | error
      error: this.status.error,
      bot: this.bot ? this.bot.username : '',
      paired: !!this.owner(),
      pairCode: this.pairCode,
      pairLink: this.bot ? `https://t.me/${this.bot.username}?start=${this.pairCode}` : '',
    };
  }

  /** Settings -> "Test": is this token valid? */
  async test(token) {
    if (!TOKEN_RE.test(String(token || '').trim())) return { ok: false, message: "That doesn't look like a bot token. It looks like 1234567890:AAH…" };
    try {
      const me = await this.api('getMe', {}, { token: String(token).trim() });
      return { ok: true, bot: me.username };
    } catch (err) {
      return { ok: false, message: err.status === 401 || err.status === 404 ? 'Telegram says that token is wrong. Copy it again from @BotFather.' : `Couldn't reach Telegram (${err.message}).` };
    }
  }

  /** (Re)start polling with the current settings. */
  async restart() {
    this.stop();
    if (!this.settings.get('telegramEnabled') || !this.token()) return this.setStatus('off');
    this.running = true;
    this.abort = new AbortController();
    this.setStatus('connecting');
    try {
      this.bot = await this.api('getMe');
    } catch (err) {
      this.running = false;
      return this.setStatus('error', err.status === 401 || err.status === 404 ? 'The bot token is wrong.' : `Can't reach Telegram (${err.message}).`);
    }
    this.setStatus(this.owner() ? 'paired' : 'waiting-pair');
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.abort) this.abort.abort();
    this.abort = null;
  }

  async loop() {
    let backoff = 2000;
    while (this.running) {
      try {
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] }, { timeoutMs: (POLL_TIMEOUT_S + 15) * 1000 });
        backoff = 2000;
        if (this.status.state === 'error') this.setStatus(this.owner() ? 'paired' : 'waiting-pair');
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          // one message at a time, in order
          this.busy = this.busy.then(() => this.onUpdate(u)).catch((e) => console.warn('[telegram]', e.message));
        }
      } catch (err) {
        if (!this.running) break;
        if (err.status === 401 || err.status === 404) {
          this.running = false;
          this.setStatus('error', 'The bot token is wrong.');
          break;
        }
        if (err.status === 409) this.setStatus('error', 'Another program is using this bot (only one Shadow per bot).');
        else this.setStatus('error', `Can't reach Telegram - retrying (${err.message}).`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(60000, backoff * 2);
      }
    }
  }

  send(chatId, text) {
    return this.api('sendMessage', { chat_id: chatId, text: String(text).slice(0, MAX_TEXT), disable_web_page_preview: true });
  }

  async sendPhoto(chatId, file, caption) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption.slice(0, 1000));
    form.append('photo', new Blob([fs.readFileSync(file)], { type: 'image/png' }), path.basename(file));
    return this.api('sendPhoto', null, { form, timeoutMs: 60000 });
  }

  async sendDocument(chatId, file, caption) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption.slice(0, 1000));
    form.append('document', new Blob([fs.readFileSync(file)]), path.basename(file));
    return this.api('sendDocument', null, { form, timeoutMs: 5 * 60 * 1000 });
  }

  /** "send notes.pdf to my phone" typed on the PC: deliver it to the paired phone. */
  async sendFileToOwner(file, caption) {
    const owner = this.owner();
    if (!owner || !this.running) return false;
    await this.sendDocument(owner, file, caption);
    return true;
  }

  /** A file arrived from the phone: download it (≤ 20 MB) and hand it to onFile. */
  async receiveFile(chatId, m, f) {
    if (!this.onFile) return this.send(chatId, "I can't take files right now 🐾");
    const label = `"${f.name}"`;
    if (f.size > MAX_DOWNLOAD) return this.send(chatId, `📦 ${label} is too big - Telegram only lets bots download files up to 20 MB. Try Google Drive for big ones.`);
    this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    let buffer;
    try {
      const info = await this.api('getFile', { file_id: f.id });
      if (!info || !/^[\w./-]{1,300}$/.test(info.file_path || '') || info.file_path.includes('..')) throw new Error('Telegram gave no file');
      const res = await this.fetch(`${this.apiBase}/file/bot${this.token()}/${info.file_path}`, { signal: AbortSignal.timeout(5 * 60 * 1000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_DOWNLOAD) throw new Error('too big');
    } catch (err) {
      return this.send(chatId, `Couldn't download ${label} (${err.message}). Send it again?`);
    }
    let reply;
    try {
      reply = await this.onFile({ buffer, name: f.name, caption: String(m.caption || '') });
    } catch (err) {
      reply = `Couldn't save ${label} (${err.message}).`;
    }
    return this.send(chatId, reply);
  }

  async onUpdate(u) {
    const m = u.message;
    if (!m || !m.chat) return;
    const chatId = m.chat.id;
    const text = String(m.text || '').trim();
    const owner = this.owner();

    // pairing: "/start 123456" (from the link) or just "123456"
    if (!owner) {
      if (m.chat.type !== 'private') return;
      const code = (/^\/start\s+(\d{6})$/.exec(text) || /^(\d{6})$/.exec(text) || [])[1];
      if (code && code === this.pairCode) {
        this.settings.update({ telegramChatId: chatId });
        this.pairCode = String(crypto.randomInt(100000, 1000000)); // one-time
        this.setStatus('paired');
        this.emit('paired', { name: (m.from && m.from.first_name) || '' });
        return this.send(chatId, `✅ Paired! Hi ${(m.from && m.from.first_name) || 'Prince'} - I'm Shadow 🐾\n\n${HELP}`);
      }
      return this.send(chatId, "🔒 This is a private Shadow. Open Shadow's Settings → Phone on the PC and use the pairing link or code.");
    }
    if (chatId !== owner) return; // strangers are ignored completely

    if (/^\/(start|help)\b/.test(text)) return this.send(chatId, HELP);
    // files are saved even if they waited while the PC was off - saving one is harmless
    const file = fileOf(m, new Date(this.clock()));
    if (file) return this.receiveFile(chatId, m, file);
    if (!text) return this.send(chatId, 'I can only read text messages and files for now 🐾');
    const ageS = Math.floor(this.clock() / 1000) - Number(m.date || 0);
    if (ageS > STALE_S) {
      const mins = Math.round(ageS / 60);
      return this.send(chatId, `⏳ Skipped "${text.slice(0, 60)}" - it's ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`} old (your PC was probably asleep). Send it again if you still want it.`);
    }
    this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    this.emit('message', text);
    let r;
    try {
      r = await this.handle(text);
    } catch (err) {
      r = { text: `Something went wrong, Prince (${err.message}).` };
    }
    let out = r.text || '😼';
    if (r.sources && r.sources.length) out += `\n\n${r.sources.map((s) => `🔗 ${s.title}\n${s.url}`).join('\n')}`;
    if (r.photo && fs.existsSync(r.photo)) {
      try {
        await this.sendPhoto(chatId, r.photo, out);
        return;
      } catch (err) {
        out += `\n(Couldn't send the picture: ${err.message})`;
      }
    }
    if (r.document && fs.existsSync(r.document)) {
      try {
        await this.sendDocument(chatId, r.document, out);
        this.emit('file-sent', path.basename(r.document));
        return;
      } catch (err) {
        out = `Couldn't send ${path.basename(r.document)}: ${err.message}`;
      } finally {
        if (r.temp) fs.rm(r.document, { force: true }, () => {}); // a zipped folder made just for this
      }
    }
    await this.send(chatId, out);
  }

  /** Push a note to the phone (reminders, PC alerts) - only when paired and switched on. */
  async notify(text) {
    const owner = this.owner();
    if (!owner || !this.running || !this.settings.get('telegramNotify')) return false;
    try {
      await this.send(owner, text);
      return true;
    } catch {
      return false;
    }
  }

  unpair() {
    this.settings.update({ telegramChatId: 0 });
    this.pairCode = String(crypto.randomInt(100000, 1000000));
    this.setStatus(this.running ? 'waiting-pair' : 'off');
  }
}

module.exports = { TelegramLink, TOKEN_RE, HELP, fileOf, MAX_DOWNLOAD };
