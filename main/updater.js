'use strict';
/*
 * updater.js - Shadow updates itself from GitHub Releases (github.com/Prince290310/my-pet).
 *
 * Every push to main builds a new installer on GitHub (.github/workflows/release.yml).
 * The installed app checks a minute after starting and then every 4 hours, downloads quietly,
 * and Shadow walks out with a bubble: "Update 1.0.7 is ready! Click me to restart".
 * Click it to restart now; ignore it (or pick "Update Later") and it installs when Shadow quits.
 *
 * Only the installed app updates - `npm start` and the self-test never do.
 */

const { EventEmitter } = require('events');

const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

class Updater extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.autoUpdater  electron-updater's autoUpdater (or a fake in tests)
   * @param {import('./brain').Brain} o.brain
   * @param {string} o.currentVersion
   * @param {boolean} o.enabled  false in dev / self-test
   */
  constructor({ autoUpdater, brain, currentVersion, enabled }) {
    super();
    this.au = autoUpdater;
    this.brain = brain;
    this.currentVersion = currentVersion;
    this.enabled = !!enabled && !!autoUpdater;
    this.state = { status: this.enabled ? 'idle' : 'disabled', version: '', percent: 0, error: '', lastCheck: 0 };
    this.timers = [];
    this.announced = '';
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('status', this.status());
  }

  status() {
    return { ...this.state, currentVersion: this.currentVersion, enabled: this.enabled };
  }

  get ready() {
    return this.state.status === 'ready';
  }

  start() {
    if (!this.enabled) return;
    const au = this.au;
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true; // ignored updates still install the next time Shadow quits
    au.allowPrerelease = false;
    au.on('checking-for-update', () => this.set({ status: 'checking', error: '' }));
    au.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, percent: 0 }));
    au.on('download-progress', (p) => this.set({ percent: Math.round(p.percent || 0) }));
    au.on('update-not-available', () => this.set({ status: 'up-to-date', lastCheck: Date.now() }));
    au.on('update-downloaded', (info) => {
      this.set({ status: 'ready', version: info.version, percent: 100, lastCheck: Date.now() });
      this.announce();
    });
    au.on('error', (err) => {
      console.warn('[update]', (err && err.message ? err.message : String(err)).split('\n')[0]);
      // keep a finished download; otherwise show the error until the next check
      if (!this.ready) this.set({ status: 'error', error: friendly(err), lastCheck: Date.now() });
    });
    this.timers.push(setTimeout(() => this.check(), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => this.check(), CHECK_EVERY_MS));
  }

  stop() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }

  /** Settings -> "Check for updates" (and the timers). Never throws. */
  async check() {
    if (!this.enabled || this.ready || ['checking', 'downloading'].includes(this.state.status)) return this.status();
    try {
      await this.au.checkForUpdates();
    } catch (err) {
      if (!this.ready) this.set({ status: 'error', error: friendly(err), lastCheck: Date.now() });
    }
    return this.status();
  }

  /** Shadow tells Prince once per new version. */
  announce() {
    const v = this.state.version;
    if (!v || this.announced === v) return;
    this.announced = v;
    this.brain.reminder({
      time: '',
      kind: 'update',
      key: `update|${v}`,
      icon: '✨',
      message: `Update ${v} is ready, Prince! Click me to restart (or I'll update when you quit).`,
    });
  }

  /** Restart into the new version (silent installer, then Shadow starts again). */
  install() {
    if (!this.ready) return false;
    setImmediate(() => this.au.quitAndInstall(true, true));
    return true;
  }
}

function friendly(err) {
  const msg = String((err && err.message) || err || '');
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(msg)) return "Couldn't reach GitHub (no internet?). I'll try again later.";
  if (/404|Cannot find latest|No published versions/i.test(msg)) return 'No update published yet (or the repo is private).';
  return `Update check failed: ${msg.split('\n')[0].slice(0, 120)}`;
}

module.exports = { Updater, friendly };
