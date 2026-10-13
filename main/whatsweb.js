'use strict';
/*
 * whatsweb.js - the WhatsApp Web engine: WhatsApp Web running invisibly in the background (the
 * whatsapp-web.js library driving the Microsoft Edge / Chrome already on this PC), linked once by
 * scanning a QR code - exactly like WhatsApp Web in a browser ("Linked devices" on the phone).
 *
 *   messages   found by name in your real WhatsApp contacts and groups (or by number), sent inside
 *              WhatsApp Web, confirmed when WhatsApp's server accepts them - nothing on screen is
 *              clicked or typed
 *   calls      WhatsApp Web can't place calls, so this only looks up the person's number; whatsapp.js
 *              then opens their chat in the WhatsApp app by number and presses Call
 *
 * Only commands Prince gives are carried out. Nothing is read, watched or answered automatically,
 * chats aren't marked as read, and the session doesn't show Prince as "online".
 * The link (session) is kept in %APPDATA%\Shadow\whatsapp-web; UNLINK logs it out and deletes it.
 * It is an unofficial client: used one message at a time like this it behaves like WhatsApp Web.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const CONTACTS_MS = 5 * 60 * 1000;
const ACK_MS = 20 * 1000;
const QR_TRIES = 8; // a fresh code every ~20 s; after ~3 min unscanned the background browser closes

/** Edge (always on Windows 10/11) or Chrome - whatever this PC has. */
function findBrowser(env = process.env, exists = fs.existsSync) {
  const roots = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean);
  const paths = [];
  for (const root of roots) paths.push(path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  for (const root of roots) paths.push(path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return paths.find((p) => exists(p)) || '';
}

const fold = (s) =>
  String(s || '')
    .normalize('NFC')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') // invisible direction marks WhatsApp puts around names
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

class WhatsWeb extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataPath   where the linked session is kept
   * @param {object} [o.hooks]    tests: { createClient(options) -> fake client, browserPath }
   */
  constructor({ settings, dataPath, platform = process.platform, hooks = {}, clock = () => Date.now() }) {
    super();
    this.settings = settings;
    this.dataPath = dataPath;
    this.platform = platform;
    this.hooks = hooks;
    this.clock = clock;
    this.client = null;
    this.state = 'off'; // off | starting | qr | linking | ready | error
    this.qr = ''; // the current QR code text (Settings draws it)
    this.me = null; // { name, number } once linked
    this.error = '';
    this.cache = null; // { at, entries }
    this.acks = new Map(); // message id -> resolve(ack)
    this.presence = null; // re-sends "offline" now and then while linked
  }

  available() {
    return this.platform === 'win32' || !!this.hooks.createClient;
  }

  ready() {
    return this.state === 'ready' && !!this.client;
  }

  status() {
    return { state: this.state, qr: this.qr, me: this.me, error: this.error, linked: !!this.settings.get('waWebLinked') };
  }

  set(state, extra = {}) {
    Object.assign(this, { state, ...extra });
    this.emit('status', this.status());
  }

  /** Start WhatsApp Web (shows a QR code the first time, reconnects by itself afterwards). */
  async start() {
    if (this.client) return this.status();
    if (!this.available()) return this.set('error', { error: 'The WhatsApp Web engine runs on Windows.' }), this.status();
    let client;
    try {
      client = this.hooks.createClient ? this.hooks.createClient() : this.createClient();
    } catch (err) {
      this.set('error', { error: err.message });
      return this.status();
    }
    this.client = client;
    this.set('starting', { error: '', qr: '' });
    client.on('qr', (qr) => {
      if (this.client !== client) return;
      if (this.settings.get('waWebLinked')) this.settings.update({ waWebLinked: false }); // a QR code means the old link is gone
      this.set('qr', { qr });
    });
    client.on('authenticated', () => this.client === client && this.set('linking', { qr: '' }));
    client.on('auth_failure', (msg) => this.client === client && this.fail(`WhatsApp refused the link (${String(msg).slice(0, 80)}). Click LINK WHATSAPP to scan a new code.`, true));
    client.on('ready', () => {
      if (this.client !== client) return;
      const wid = client.info && client.info.wid;
      this.settings.update({ waWebLinked: true });
      this.cache = null;
      this.set('ready', { qr: '', me: { name: (client.info && client.info.pushname) || '', number: (wid && wid.user) || '' } });
      this.offline();
      clearInterval(this.presence);
      this.presence = setInterval(() => this.offline(), 4 * 60 * 1000);
      if (this.presence.unref) this.presence.unref();
    });
    client.on('disconnected', (reason) => {
      if (this.client !== client) return;
      if (this.state === 'qr') return this.fail('The QR code timed out. Click LINK WHATSAPP for a new one.');
      this.fail(`WhatsApp Web disconnected (${String(reason).slice(0, 60)}).`, /logout|unpaired/i.test(String(reason)));
    });
    client.on('message_ack', (msg, ack) => {
      const id = msg && msg.id && msg.id._serialized;
      const done = id && this.acks.get(id);
      if (done && ack !== 0) done(ack);
    });
    client
      .initialize()
      .then(() => {
        // the hidden browser closed (crash, Task Manager) - the next command starts it again
        const browser = client.pupBrowser;
        if (browser && browser.on) browser.on('disconnected', () => this.client === client && this.fail('The background WhatsApp Web browser closed.'));
      })
      .catch((err) => this.client === client && this.fail(`WhatsApp Web couldn't start: ${String((err && err.message) || err).slice(0, 140)}`));
    return this.status();
  }

  createClient() {
    const browser = this.hooks.browserPath || findBrowser();
    if (!browser) throw new Error('Microsoft Edge or Google Chrome is needed for the WhatsApp Web engine.');
    const { Client, LocalAuth } = require('whatsapp-web.js');
    return new Client({
      authStrategy: new LocalAuth({ dataPath: this.dataPath }),
      webVersionCache: { type: 'none' }, // always today's WhatsApp Web; nothing cached next to the app
      qrMaxRetries: QR_TRIES,
      puppeteer: {
        executablePath: browser,
        headless: true,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio'],
      },
    });
  }

  /** A background session must not keep Prince showing as "online" in WhatsApp all day. */
  offline() {
    if (this.client && this.client.sendPresenceUnavailable) this.client.sendPresenceUnavailable().catch(() => {});
  }

  async fail(error, unlinked = false) {
    const client = this.client;
    this.client = null;
    this.cache = null;
    clearInterval(this.presence);
    if (unlinked) this.settings.update({ waWebLinked: false });
    this.set('error', { error, qr: '' });
    if (client) client.destroy().catch(() => {});
  }

  /** Close the background browser (the link stays: next start reconnects without a QR). */
  async stop() {
    const client = this.client;
    this.client = null;
    this.cache = null;
    clearInterval(this.presence);
    if (client) await client.destroy().catch(() => {});
    this.set('off', { qr: '' });
  }

  /** Log this PC out of WhatsApp and delete the saved session. */
  async unlink() {
    const client = this.client;
    this.client = null;
    this.cache = null;
    clearInterval(this.presence);
    if (client) {
      if (this.state === 'ready') await client.logout().catch(() => {});
      await client.destroy().catch(() => {});
    }
    try {
      fs.rmSync(this.dataPath, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
    this.settings.update({ waWebLinked: false });
    this.set('off', { qr: '', me: null });
  }

  /** Contacts on WhatsApp + group chats, each { id, name, alt: [other names], number, group } (cached 5 min). */
  async entries() {
    if (this.cache && this.clock() - this.cache.at < CONTACTS_MS) return this.cache.entries;
    const [contacts, chats] = await Promise.all([this.client.getContacts(), this.client.getChats().catch(() => [])]);
    const entries = [];
    for (const c of contacts || []) {
      if (!c || !c.id || c.isGroup || c.isMe || c.isWAContact === false || !c.id._serialized || !/@c\.us$/.test(c.id._serialized)) continue;
      const names = [c.name, c.pushname, c.shortName].filter(Boolean);
      if (!names.length) continue;
      entries.push({ id: c.id._serialized, name: c.name || c.pushname || c.shortName, alt: names, number: c.number || c.id.user || '', group: false, saved: !!c.isMyContact });
    }
    for (const ch of chats || []) {
      if (ch && ch.isGroup && ch.id && ch.id._serialized && ch.name) entries.push({ id: ch.id._serialized, name: ch.name, alt: [ch.name], number: '', group: true, saved: true });
    }
    this.cache = { at: this.clock(), entries };
    return entries;
  }

  /**
   * "Mom" / "family group" / "919876543210" -> { ok, id, name, number, group }
   *  | { ok:false, reason: 'not_found' | 'ambiguous' | 'not_on_whatsapp', options? }
   * Exact names first (your saved name, their profile name, or a group's name), then - only among
   * people you saved and your groups - a name that starts with what you said ("Rahul" -> "Rahul Sharma").
   */
  async resolve(target, { number = '' } = {}) {
    if (number) {
      const wid = await this.client.getNumberId(number);
      if (!wid || !wid._serialized) return { ok: false, reason: 'not_on_whatsapp' };
      const known = (await this.entries()).find((e) => e.id === wid._serialized);
      return { ok: true, id: wid._serialized, name: target || (known && known.name) || '', number: wid.user || number, group: false };
    }
    const full = fold(target);
    if (!full) return { ok: false, reason: 'not_found' };
    const bare = full.replace(/\s+group$/, ''); // "family group" -> the group "Family"
    const all = await this.entries();
    const exact = (e, w) => e.alt.some((n) => fold(n) === w);
    const starts = (e, w) => e.saved && e.alt.some((n) => fold(n).split(' ').some((_, i, words) => words.slice(i).join(' ').startsWith(w)));
    const tries = [(e) => exact(e, full), (e) => bare !== full && e.group && exact(e, bare), (e) => starts(e, full), (e) => bare !== full && e.group && starts(e, bare)];
    for (const test of tries) {
      const hits = [...new Map(all.filter(test).map((e) => [e.id, e])).values()];
      const saved = hits.filter((e) => e.saved);
      const pick = saved.length === 1 && hits.length > 1 ? saved : hits; // a name you saved beats someone's own profile name
      if (pick.length === 1) return { ok: true, id: pick[0].id, name: pick[0].name, number: pick[0].number, group: pick[0].group };
      if (pick.length > 1) return { ok: false, reason: 'ambiguous', options: pick.slice(0, 5).map((e) => e.name) };
    }
    return { ok: false, reason: 'not_found' };
  }

  /** Send a message. -> { ok, code: 'sent'|'queued'|'failed'|..., name } */
  async send(target, text, opts = {}) {
    if (!this.ready()) return { ok: false, code: 'web_not_ready' };
    const r = await this.resolve(target, opts);
    if (!r.ok) return { ok: false, code: r.reason, options: r.options };
    let msg;
    try {
      msg = await this.client.sendMessage(r.id, text, { sendSeen: false }); // never mark their messages as read
    } catch (err) {
      return { ok: false, code: 'failed', name: r.name, error: String((err && err.message) || err).slice(0, 120) };
    }
    this.offline();
    const id = msg && msg.id && msg.id._serialized;
    if (msg && msg.ack >= 1) return { ok: true, code: 'sent', name: r.name, group: r.group };
    if (!id) return { ok: true, code: 'queued', name: r.name, group: r.group };
    const ack = await new Promise((resolve) => {
      const timer = setTimeout(() => (this.acks.delete(id), resolve(0)), this.hooks.ackMs || ACK_MS);
      this.acks.set(id, (a) => (clearTimeout(timer), this.acks.delete(id), resolve(a)));
    });
    if (ack < 0) return { ok: false, code: 'failed', name: r.name };
    return { ok: true, code: ack >= 1 ? 'sent' : 'queued', name: r.name, group: r.group };
  }
}

module.exports = { WhatsWeb, findBrowser };
