'use strict';
/*
 * care.js - Zen the turtle, Shadow's PC caretaker.
 *
 * Watches quietly (every 2 minutes) and speaks up only when it matters:
 *   battery low (20% / 10%) or fully charged · storage almost full · RAM or CPU maxed out for
 *   a few minutes (names the biggest app) · internet down / back
 * Chat:
 *   pc health (also "how is my pc", "battery", "storage")   one-line health report
 *   tidy my downloads    shows a plan (Images, Documents, Installers, ...), moves files only after
 *                        you say "yes" - never deletes anything - and "undo tidy" puts them back
 */

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const MIN = 60 * 1000;
const GB = 1024 ** 3;
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

const CATEGORIES = {
  Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'ico', 'tif', 'tiff'],
  Documents: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'md', 'epub'],
  Installers: ['exe', 'msi', 'msix', 'appx', 'apk', 'dmg'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz', 'iso'],
  Videos: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv'],
  Music: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'],
  Code: ['js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'html', 'css', 'json', 'ipynb', 'sql'],
};
const CAT_OF = Object.fromEntries(Object.entries(CATEGORIES).flatMap(([cat, exts]) => exts.map((e) => [e, cat])));
const PARTIAL = /\.(crdownload|part|partial|tmp|download|opdownload)$/i;

function run(file, args, timeout = 15000) {
  return new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout }, (err, stdout) => resolve({ err, stdout: String(stdout || '') })));
}

const gb = (b) => (b >= 100 * GB ? `${Math.round(b / GB)} GB` : `${(b / GB).toFixed(1)} GB`);

const clean = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey |ok |okay )?(?:shadow|zen)?[,:!]?\s*/i, '')
    .replace(/^(?:please|pls|plz|can you|could you)\s+/i, '')
    .replace(/[?.!]+$/, '')
    .trim();

/** Chat message -> care command, or null. */
function parseCareCommand(input) {
  const l = clean(input);
  if (/^(?:pc|computer|laptop|system)(?: health| status| check(?:up)?)$|^(?:check|scan) (?:my |the )?(?:pc|computer|laptop|system)(?: health)?$|^how(?:'s| is) my (?:pc|computer|laptop|system)(?: doing)?$|^health check$/.test(l)) return { type: 'report' };
  if (/^(?:battery|how much battery(?: is left)?|battery (?:level|status|percentage)|how(?:'s| is) (?:my |the )?battery)$/.test(l)) return { type: 'report' };
  if (/^(?:storage|disk space|how much (?:storage|space)(?: is left| do i have)?|is my (?:disk|storage) full)$/.test(l)) return { type: 'report' };
  if (/^(?:tidy|clean|organi[sz]e|sort)(?: up)? (?:my |the )?downloads?(?: folder)?$/.test(l)) return { type: 'tidy' };
  if (/^undo (?:the )?(?:tidy|clean ?up|organi[sz]ing|sorting)$/.test(l)) return { type: 'undo' };
  return null;
}

const YES = /^(?:yes|yeah|yep|yup|ok|okay|sure|go|go ahead|do it|haan|ha|han)$/;

class PcCare extends EventEmitter {
  /**
   * @param {object} o
   * @param {(name: string) => string} o.getPath  electron app.getPath
   * @param {string} o.logFile   where the last tidy-up is remembered (for undo)
   * @param {object} [o.hooks]   tests: { battery, disk, mem, cpu, online, top, uptime }
   */
  constructor({ getPath, logFile, platform = process.platform, hooks = {}, clock = () => Date.now() } = {}) {
    super();
    this.getPath = getPath;
    this.logFile = logFile;
    this.platform = platform;
    this.hooks = hooks;
    this.clock = clock;
    this.timer = null;
    this.last = {}; // alert key -> time
    this.streak = { mem: 0, cpu: 0, offline: 0 };
    this.offline = false;
    this.batteryState = { band: 100, charging: null, fullSaid: false };
    this.cpuPrev = null;
    this.pendingPlan = null;
  }

  // -------------------------------------------------------------- readings (all hookable)
  async battery() {
    if (this.hooks.battery) return this.hooks.battery();
    if (this.platform !== 'win32') return null;
    const { err, stdout } = await run('powershell.exe', [...PS, 'Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress']);
    if (err || !stdout.trim()) return null; // desktop PC: no battery
    try {
      const j = JSON.parse(stdout);
      return { percent: Number(j.EstimatedChargeRemaining), charging: [2, 6, 7, 8, 9].includes(Number(j.BatteryStatus)) };
    } catch {
      return null;
    }
  }

  async disk() {
    if (this.hooks.disk) return this.hooks.disk();
    const root = this.platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/';
    const s = fs.statfsSync(root);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  }

  async mem() {
    if (this.hooks.mem) return this.hooks.mem();
    return { free: os.freemem(), total: os.totalmem() };
  }

  async cpu() {
    if (this.hooks.cpu) return this.hooks.cpu();
    const t = os.cpus().reduce((a, c) => {
      const all = Object.values(c.times).reduce((x, y) => x + y, 0);
      return { idle: a.idle + c.times.idle, all: a.all + all };
    }, { idle: 0, all: 0 });
    const prev = this.cpuPrev;
    this.cpuPrev = t;
    if (!prev || t.all === prev.all) return 0;
    return Math.round(100 * (1 - (t.idle - prev.idle) / (t.all - prev.all)));
  }

  async online() {
    if (this.hooks.online) return this.hooks.online();
    const tryHost = (host, port) =>
      new Promise((resolve) => {
        const s = net.connect({ host, port, timeout: 4000 });
        const done = (ok) => {
          s.destroy();
          resolve(ok);
        };
        s.once('connect', () => done(true));
        s.once('timeout', () => done(false));
        s.once('error', () => done(false));
      });
    return (await tryHost('1.1.1.1', 443)) || (await tryHost('8.8.8.8', 53));
  }

  /** Biggest apps by memory: [{ name, mb }] */
  async top() {
    if (this.hooks.top) return this.hooks.top();
    if (this.platform !== 'win32') return [];
    const { stdout } = await run('powershell.exe', [...PS, "Get-Process | Group-Object ProcessName | ForEach-Object { [pscustomobject]@{name=$_.Name; mb=[int](($_.Group | Measure-Object WorkingSet64 -Sum).Sum/1MB)} } | Sort-Object mb -Descending | Select-Object -First 3 | ConvertTo-Json -Compress"]);
    try {
      const j = JSON.parse(stdout);
      return (Array.isArray(j) ? j : [j]).map((x) => ({ name: String(x.name), mb: Number(x.mb) }));
    } catch {
      return [];
    }
  }

  uptimeDays() {
    return (this.hooks.uptime ? this.hooks.uptime() : os.uptime()) / 86400;
  }

  // -------------------------------------------------------------- background watch
  start(everyMs = 2 * MIN) {
    this.timer = setInterval(() => this.check().catch((e) => console.warn('[care]', e.message)), everyMs);
    setTimeout(() => this.check().catch(() => {}), 30 * 1000);
  }

  stop() {
    clearInterval(this.timer);
  }

  alert(key, text, { every = 30 * MIN, sticky = false } = {}) {
    const now = this.clock();
    if (this.last[key] && now - this.last[key] < every) return null;
    this.last[key] = now;
    const a = { key, text, sticky };
    this.emit('alert', a);
    return a;
  }

  /** One round of checks. Returns the alerts raised. */
  async check() {
    const out = [];
    const add = (a) => a && out.push(a);
    const bat = await this.battery();
    if (bat && Number.isFinite(bat.percent)) {
      const st = this.batteryState;
      if (bat.charging) {
        st.band = 100;
        if (st.charging === false) st.fullSaid = false; // just plugged in
        if (bat.percent >= 100 && !st.fullSaid) {
          st.fullSaid = true;
          add(this.alert('battery-full', '🔋 Fully charged, Prince - you can unplug.', { every: 0 }));
        }
      } else {
        if (bat.percent <= 10 && st.band > 10) {
          st.band = 10;
          add(this.alert('battery-10', `🪫 Battery at ${bat.percent}%! Plug in now, Prince.`, { every: 0, sticky: true }));
        } else if (bat.percent <= 20 && st.band > 20) {
          st.band = 20;
          add(this.alert('battery-20', `🔋 Battery at ${bat.percent}% - time to plug in, Prince.`, { every: 0, sticky: true }));
        }
      }
      st.charging = bat.charging;
    }
    const d = await this.disk();
    if (d && d.total && (d.free < 10 * GB || d.free / d.total < 0.08)) {
      add(this.alert('disk', `💾 Storage almost full: only ${gb(d.free)} left. Say "tidy my downloads" and I'll help.`, { every: 24 * 60 * MIN, sticky: true }));
    }
    const m = await this.mem();
    const memPct = Math.round(100 * (1 - m.free / m.total));
    this.streak.mem = memPct >= 90 ? this.streak.mem + 1 : 0;
    if (this.streak.mem >= 2) {
      const t = (await this.top())[0];
      add(this.alert('mem', `🧠 RAM is ${memPct}% full${t ? ` - ${t.name} is using ${(t.mb / 1024).toFixed(1)} GB` : ''}. Close something you're not using?`));
    }
    const c = await this.cpu();
    this.streak.cpu = c >= 90 ? this.streak.cpu + 1 : 0;
    if (this.streak.cpu >= 3) add(this.alert('cpu', `⚙️ CPU has been at ${c}% for a few minutes - your PC may feel slow. Say "pc health" for details.`));
    const on = await this.online();
    if (!on) {
      this.streak.offline++;
      if (this.streak.offline >= 2 && !this.offline) {
        this.offline = true;
        add(this.alert('offline', '📡 Internet is down, Prince. I\'ll tell you when it\'s back.', { every: 0 }));
      }
    } else {
      this.streak.offline = 0;
      if (this.offline) {
        this.offline = false;
        add(this.alert('online', '🌐 Internet is back! ✓', { every: 0 }));
      }
    }
    return out;
  }

  /** "pc health" */
  async report() {
    const parts = [];
    const bat = await this.battery();
    if (bat && Number.isFinite(bat.percent)) parts.push(`🔋 ${bat.percent}%${bat.charging ? ' (charging)' : ''}`);
    const d = await this.disk();
    if (d && d.total) parts.push(`💾 ${gb(d.free)} free of ${gb(d.total)}`);
    const m = await this.mem();
    parts.push(`🧠 RAM ${Math.round(100 * (1 - m.free / m.total))}%`);
    await this.cpu();
    await new Promise((r) => setTimeout(r, this.hooks.cpu ? 0 : 500));
    parts.push(`⚙️ CPU ${await this.cpu()}%`);
    parts.push((await this.online()) ? '🌐 Online' : '📡 Offline');
    const days = this.uptimeDays();
    parts.push(`⏱️ up ${days >= 1 ? `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}` : `${Math.max(1, Math.round(days * 24))} h`}`);
    let tip = '';
    if (days >= 7) tip = ` Restart soon, Prince - it's been ${Math.floor(days)} days.`;
    else if (d && d.total && d.free / d.total < 0.1) tip = ' Storage is getting full - try "tidy my downloads".';
    return `${parts.join(' · ')}.${tip}`;
  }

  // -------------------------------------------------------------- tidy Downloads
  downloads() {
    return this.getPath('downloads');
  }

  plan() {
    const dir = this.downloads();
    const now = this.clock();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return { error: err.message };
    }
    const moves = [];
    const counts = {};
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.') || /^desktop\.ini$/i.test(e.name) || PARTIAL.test(e.name)) continue;
      const cat = CAT_OF[path.extname(e.name).slice(1).toLowerCase()];
      if (!cat) continue; // unknown types stay where they are
      const from = path.join(dir, e.name);
      try {
        if (now - fs.statSync(from).mtimeMs < 10 * MIN) continue; // might still be downloading / in use
      } catch {
        continue;
      }
      moves.push({ from, to: path.join(dir, cat, e.name), cat });
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return { dir, moves, counts };
  }

  /** "tidy my downloads": show the plan, wait for "yes". */
  tidy() {
    const p = this.plan();
    if (p.error) return `I couldn't read your Downloads folder, Prince (${p.error}).`;
    if (!p.moves.length) return 'Your Downloads already look tidy, Prince ✨';
    this.pendingPlan = { ...p, at: this.clock() };
    const list = Object.entries(p.counts)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c} ${n}`)
      .join(', ');
    return `🐢 I can sort ${p.moves.length} file${p.moves.length === 1 ? '' : 's'} into folders: ${list}. Nothing gets deleted. Say "yes" to go.`;
  }

  /** Did the user just say yes to a pending tidy-up? Returns the reply or null. */
  confirm(text) {
    const p = this.pendingPlan;
    if (!p || this.clock() - p.at > 5 * MIN || !YES.test(clean(text))) return null;
    this.pendingPlan = null;
    return this.apply(p);
  }

  apply(p) {
    const done = [];
    for (const mv of p.moves) {
      try {
        if (!fs.existsSync(mv.from)) continue;
        fs.mkdirSync(path.dirname(mv.to), { recursive: true });
        let to = mv.to;
        for (let i = 1; fs.existsSync(to); i++) {
          const ext = path.extname(mv.to);
          to = path.join(path.dirname(mv.to), `${path.basename(mv.to, ext)} (${i})${ext}`);
        }
        fs.renameSync(mv.from, to);
        done.push({ from: mv.from, to });
      } catch (err) {
        console.warn('[care] could not move a file:', err.message);
      }
    }
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.writeFileSync(this.logFile, JSON.stringify({ at: this.clock(), moves: done }, null, 2));
    } catch (err) {
      console.warn('[care] could not save the undo list:', err.message);
    }
    return `✨ Done! Sorted ${done.length} file${done.length === 1 ? '' : 's'} into folders in Downloads. Say "undo tidy" to put them back.`;
  }

  undo() {
    let log;
    try {
      log = JSON.parse(fs.readFileSync(this.logFile, 'utf8'));
    } catch {
      return "There's no tidy-up to undo, Prince.";
    }
    let n = 0;
    for (const mv of log.moves || []) {
      try {
        if (fs.existsSync(mv.to) && !fs.existsSync(mv.from)) {
          fs.renameSync(mv.to, mv.from);
          n++;
        }
      } catch {
        /* skip */
      }
    }
    fs.rmSync(this.logFile, { force: true });
    return `↩️ Put ${n} file${n === 1 ? '' : 's'} back where they were.`;
  }
}

module.exports = { PcCare, parseCareCommand, CATEGORIES };
