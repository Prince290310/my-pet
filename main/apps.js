'use strict';
/*
 * apps.js - Shadow opens things on your PC.
 *
 *   open spotify / launch vs code / start whatsapp   any app in your Start menu
 *   open downloads / documents / desktop / pictures  your folders
 *   open settings / wifi settings / bluetooth settings
 *   lock my pc · sleep my pc · take a screenshot · snip
 *   volume up / down / mute · brightness up / down / 60
 *
 * Safety rules:
 *  - Apps come ONLY from Windows' own Start-menu list (Get-StartApps) and are started through
 *    explorer's shell:AppsFolder - nothing you, the AI or a web page types is ever run as a command.
 *  - System actions are a fixed list of hard-coded commands.
 *  - Nothing here closes apps, shuts down or deletes anything. Sleep waits 5 seconds so you can
 *    say "cancel".
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { SITES } = require('./search');

const REFRESH_MS = 30 * 60 * 1000;
const SLEEP_DELAY_MS = 5000;

// what people say -> how the app is named in the Start menu
const ALIASES = {
  vscode: 'visual studio code',
  'vs code': 'visual studio code',
  code: 'visual studio code',
  chrome: 'google chrome',
  edge: 'microsoft edge',
  word: 'word',
  'ms word': 'word',
  excel: 'excel',
  ppt: 'powerpoint',
  powerpoint: 'powerpoint',
  calc: 'calculator',
  explorer: 'file explorer',
  files: 'file explorer',
  'file manager': 'file explorer',
  cmd: 'command prompt',
  terminal: 'terminal',
  'task manager': 'task manager',
  paint: 'paint',
  notes: 'sticky notes',
  camera: 'camera',
  store: 'microsoft store',
  'ms store': 'microsoft store',
  teams: 'microsoft teams',
};

const SETTINGS_PAGES = {
  settings: 'ms-settings:',
  'windows settings': 'ms-settings:',
  'pc settings': 'ms-settings:',
  'wifi settings': 'ms-settings:network-wifi',
  'wi-fi settings': 'ms-settings:network-wifi',
  wifi: 'ms-settings:network-wifi',
  'network settings': 'ms-settings:network',
  'internet settings': 'ms-settings:network',
  'bluetooth settings': 'ms-settings:bluetooth',
  bluetooth: 'ms-settings:bluetooth',
  'display settings': 'ms-settings:display',
  'sound settings': 'ms-settings:sound',
  'battery settings': 'ms-settings:batterysaver',
  'power settings': 'ms-settings:powersleep',
  'update settings': 'ms-settings:windowsupdate',
  'windows update': 'ms-settings:windowsupdate',
  'apps settings': 'ms-settings:appsfeatures',
  'notification settings': 'ms-settings:notifications',
  'privacy settings': 'ms-settings:privacy',
  'personalization settings': 'ms-settings:personalization',
  'wallpaper settings': 'ms-settings:personalization-background',
  'storage settings': 'ms-settings:storagesense',
  'mouse settings': 'ms-settings:mousetouchpad',
  'keyboard settings': 'ms-settings:typing',
  'date and time settings': 'ms-settings:dateandtime',
  'focus settings': 'ms-settings:quiethours',
};

const FOLDERS = {
  downloads: 'downloads',
  download: 'downloads',
  documents: 'documents',
  docs: 'documents',
  desktop: 'desktop',
  pictures: 'pictures',
  photos: 'pictures',
  music: 'music',
  videos: 'videos',
  screenshots: 'screenshots',
  home: 'home',
  'user folder': 'home',
  'recycle bin': 'recycle',
  'this pc': 'thispc',
  'my computer': 'thispc',
};

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
const squash = (s) => norm(s).replace(/ /g, '');

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** How well an app name matches what was asked (0 = not at all). */
function score(query, name) {
  const q = norm(query);
  const n = norm(name);
  if (!q || !n) return 0;
  if (/\b(uninstall|readme|help|docs|documentation|release notes|website|manual)\b/.test(n)) return 0;
  if (q === n || squash(q) === squash(n)) return 100;
  if (n.startsWith(q + ' ') || squash(n).startsWith(squash(q))) return 85 - Math.min(20, n.length - q.length) / 4;
  const words = n.split(' ');
  if (words.includes(q)) return 75;
  const qWords = q.split(' ');
  if (qWords.every((w) => words.some((x) => x.startsWith(w)))) return 65;
  if (n.includes(q) && q.length >= 3) return 55;
  if (q.length >= 4) {
    const dist = Math.min(editDistance(squash(q), squash(n)), ...words.map((w) => editDistance(squash(q), w)));
    if (dist <= (q.length >= 7 ? 2 : 1)) return 45;
  }
  return 0;
}

// ------------------------------------------------------------------ commands

const clean = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey |ok |okay )?(?:shadow)?[,:!]?\s*/i, '')
    .replace(/^(?:please|pls|plz|can you|could you|will you)\s+/i, '')
    .replace(/\s+(?:please|pls|plz|for me)$/i, '')
    .replace(/[?.!]+$/, '')
    .trim();

/** Chat message -> PC command, or null. */
function parsePcCommand(input) {
  const t = clean(input);
  const l = t.toLowerCase();
  let m;
  if (/^(?:lock|lock (?:my |the )?(?:pc|computer|laptop|screen|system))$/.test(l)) return { type: 'system', action: 'lock' };
  if (/^(?:sleep|put (?:my |the )?(?:pc|computer|laptop|system) to sleep|sleep (?:my |the )?(?:pc|computer|laptop|system)|(?:pc|computer|laptop) sleep)$/.test(l)) return { type: 'system', action: 'sleep' };
  if (/^(?:cancel|stop|don'?t|no|wait)(?: sleep| it| that)?$/.test(l)) return { type: 'cancel' };
  if (/^(?:take (?:a )?|(?:send|give|show)(?: me)? (?:an? |the )?)?(?:screenshot|screen ?shot|ss)(?: of (?:my |the )?screen)?$|^capture (?:my |the )?screen$/.test(l)) return { type: 'system', action: 'screenshot' };
  if (/^(?:snip|snipping tool|screenshot (?:an? )?(?:area|part|region)|take a snip)$/.test(l)) return { type: 'system', action: 'snip' };
  if ((m = /^(?:turn (?:the )?)?volume (up|down)(?: a bit| more)?$|^(?:increase|raise) (?:the )?volume$|^(?:decrease|lower|reduce) (?:the )?volume$/.exec(l))) {
    return { type: 'system', action: m[1] === 'down' || /^(?:decrease|lower|reduce)/.test(l) ? 'volume-down' : 'volume-up' };
  }
  if (/^(?:mute|unmute|mute (?:the )?(?:sound|volume|audio)|unmute (?:the )?(?:sound|volume|audio))$/.test(l)) return { type: 'system', action: 'mute' };
  if ((m = /^(?:set )?brightness (?:to )?(\d{1,3})(?:%| percent)?$/.exec(l))) return { type: 'system', action: 'brightness', level: Math.min(100, Math.max(0, +m[1])) };
  if ((m = /^(?:turn )?brightness (up|down)$|^(increase|decrease|raise|lower|reduce) (?:the )?brightness$/.exec(l))) {
    return { type: 'system', action: 'brightness', step: m[1] === 'down' || /^(?:decrease|lower|reduce)/.test(m[2] || '') ? -20 : 20 };
  }
  if ((m = /^(?:open|launch|start|run|fire up|open up)\s+(?:the |my )?(.+?)(?:\s+(?:app|application|folder|program))?$/i.exec(t))) {
    const target = m[1].trim();
    if (target) return { type: 'open', target };
  }
  if (/^(?:[1-9]|first|second|third|fourth|fifth)$/.test(l)) return { type: 'choose', n: ['first', 'second', 'third', 'fourth', 'fifth'].indexOf(l) + 1 || +l };
  return null;
}

// ------------------------------------------------------------------ the launcher

function runFile(file, args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve({ err, stdout: String(stdout || '') }));
  });
}

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

class AppLauncher {
  /**
   * @param {object} o
   * @param {object} o.shell        electron shell (openPath / openExternal)
   * @param {(name: string) => string} o.getPath  electron app.getPath
   * @param {object} [o.hooks]      tests: { listApps, run, launch, screenshot }
   */
  constructor({ shell, getPath, openExternal, platform = process.platform, hooks = {}, screenshotDir } = {}) {
    this.shell = shell;
    this.openExternalFn = openExternal || ((u) => shell.openExternal(u));
    this.getPath = getPath;
    this.platform = platform;
    this.hooks = hooks;
    this.screenshotDir = screenshotDir;
    this.apps = [];
    this.loadedAt = 0;
    this.loading = null;
    this.pendingChoice = null; // { options: [app], at }
    this.pendingSleep = null;
  }

  get windows() {
    return this.platform === 'win32' || !!this.hooks.listApps;
  }

  /** Start-menu apps: [{ name, id }] (id = AppUserModelID or path for shell:AppsFolder). */
  async refresh(force = false) {
    if (!this.windows) return [];
    if (!force && this.apps.length && Date.now() - this.loadedAt < REFRESH_MS) return this.apps;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let list = [];
      try {
        if (this.hooks.listApps) list = await this.hooks.listApps();
        else {
          const { stdout } = await runFile('powershell.exe', [
            ...PS,
            '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress',
          ]);
          const j = JSON.parse(stdout.trim() || '[]');
          list = (Array.isArray(j) ? j : [j]).map((a) => ({ name: String(a.Name || ''), id: String(a.AppID || '') }));
        }
      } catch (err) {
        console.warn('[apps] could not list Start menu apps:', err.message);
        list = this.scanShortcuts();
      }
      list = list.filter((a) => a.name && a.id && a.name.length < 200 && a.id.length < 1000);
      if (list.length) {
        this.apps = list;
        this.loadedAt = Date.now();
      }
      return this.apps;
    })().finally(() => (this.loading = null));
    return this.loading;
  }

  /** Fallback: .lnk shortcuts in the Start menu folders. */
  scanShortcuts() {
    const roots = [
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ];
    const out = [];
    const walk = (dir, depth) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (/\.(lnk|url|appref-ms)$/i.test(e.name)) out.push({ name: e.name.replace(/\.(lnk|url|appref-ms)$/i, ''), id: p, shortcut: true });
      }
    };
    roots.forEach((r) => walk(r, 0));
    return out;
  }

  /** Best matching apps for what was asked. */
  find(query) {
    const q = norm(query);
    const wanted = ALIASES[q] || q;
    const ranked = this.apps
      .map((a) => ({ app: a, s: Math.max(score(wanted, a.name), wanted !== q ? score(q, a.name) - 5 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.app.name.length - b.app.name.length);
    // the same app can be listed twice (e.g. per-user + all-users shortcut)
    const seen = new Set();
    return ranked.filter((x) => !seen.has(norm(x.app.name)) && seen.add(norm(x.app.name)));
  }

  async launchApp(app) {
    if (this.hooks.launch) return this.hooks.launch(app);
    if (app.shortcut) return this.shell.openPath(app.id);
    // explorer exits with code 1 even when it worked, so the result is ignored
    await runFile('explorer.exe', [`shell:AppsFolder\\${app.id}`]);
    return '';
  }

  folderPath(kind) {
    const home = this.getPath('home');
    switch (kind) {
      case 'screenshots':
        return this.screenshotsDir();
      case 'home':
        return home;
      default:
        return this.getPath(kind);
    }
  }

  screenshotsDir() {
    return this.screenshotDir || path.join(this.getPath('pictures'), 'Screenshots');
  }

  /** Handle "open …". Returns Shadow's reply. */
  async open(target) {
    const t = norm(target).replace(/^(?:the|my)\s+/, '');
    const folderKey = t.replace(/\s+folder$/, '');
    if (FOLDERS[folderKey]) {
      const kind = FOLDERS[folderKey];
      if (!this.windows && ['recycle', 'thispc'].includes(kind)) return 'That only works on Windows, Prince.';
      if (kind === 'recycle') return this.explorer('shell:RecycleBinFolder', 'Recycle Bin');
      if (kind === 'thispc') return this.explorer('shell:MyComputerFolder', 'This PC');
      const dir = this.folderPath(kind);
      fs.mkdirSync(dir, { recursive: true });
      const err = await (this.hooks.openPath ? this.hooks.openPath(dir) : this.shell.openPath(dir));
      return err ? `Couldn't open ${folderKey}, Prince (${err}).` : `Opening your ${folderKey} folder 📂`;
    }
    const page = SETTINGS_PAGES[t] || SETTINGS_PAGES[`${t} settings`.replace(/ settings settings$/, ' settings')];
    if (page && /settings|^wifi$|^bluetooth$|^windows update$/.test(t)) {
      if (!this.windows) return 'Windows settings only open on Windows, Prince.';
      await (this.hooks.openExternal ? this.hooks.openExternal(page) : this.openExternalFn(page));
      return `Opening ${t === 'settings' ? 'Settings' : t} ⚙️`;
    }
    if (!this.windows) return this.site(t) || 'Opening apps only works on Windows, Prince.';
    await this.refresh();
    let found = this.find(t);
    if (!found.length) {
      await this.refresh(true); // maybe just installed
      found = this.find(t);
    }
    if (!found.length) return this.site(t) || `I couldn't find "${target}" in your Start menu, Prince 🤔 Is it installed?`;
    const best = found[0];
    if (best.s < 100 && SITES[squash(t)]) return this.site(t); // "open google" = google.com, unless an app is named exactly that
    const close = found.filter((x) => x.s >= best.s - 3).slice(0, 4);
    if (best.s < 100 && close.length > 1) {
      this.pendingChoice = { options: close.map((x) => x.app), at: Date.now() };
      return `Which one, Prince? ${close.map((x, i) => `${i + 1}. ${x.app.name}`).join(' · ')} (say the number)`;
    }
    return this.start(best.app);
  }

  async start(app) {
    this.pendingChoice = null;
    try {
      const err = await this.launchApp(app);
      if (err) return `Couldn't open ${app.name}, Prince (${err}).`;
    } catch (e) {
      return `Couldn't open ${app.name}, Prince (${e.message}).`;
    }
    return `Opening ${app.name} 🚀`;
  }

  site(t) {
    const key = squash(t);
    if (!SITES[key]) return null;
    if (this.hooks.openExternal) this.hooks.openExternal(SITES[key]);
    else this.openExternalFn(SITES[key]);
    return `Opening ${t} in your browser 🌐`;
  }

  async explorer(target, label) {
    if (this.hooks.run) await this.hooks.run('explorer.exe', [target]);
    else await runFile('explorer.exe', [target]);
    return `Opening ${label} 📂`;
  }

  async choose(n) {
    const p = this.pendingChoice;
    if (!p || Date.now() - p.at > 5 * 60 * 1000) return null;
    const app = p.options[n - 1];
    if (!app) return `Pick a number from 1 to ${p.options.length}, Prince.`;
    return this.start(app);
  }

  cancel() {
    if (!this.pendingSleep) return null;
    clearTimeout(this.pendingSleep);
    this.pendingSleep = null;
    return 'Cancelled - your PC stays awake 😼';
  }

  // -------------------------------------------------------------- system actions
  async system(cmd, { beforeScreenshot, afterScreenshot, capture } = {}) {
    if (!this.windows && cmd.action !== 'screenshot') return 'That only works on Windows, Prince.';
    const run = (file, args) => (this.hooks.run ? this.hooks.run(file, args) : runFile(file, args));
    const sendKey = (code, times) => run('powershell.exe', [...PS, `$w = New-Object -ComObject WScript.Shell; 1..${times} | ForEach-Object { $w.SendKeys([char]${code}) }`]);
    switch (cmd.action) {
      case 'lock':
        await run('rundll32.exe', ['user32.dll,LockWorkStation']);
        return 'Locking your PC 🔒 See you soon, Prince!';
      case 'sleep':
        if (this.pendingSleep) return 'Already going to sleep... say "cancel" to stop.';
        this.pendingSleep = setTimeout(() => {
          this.pendingSleep = null;
          run('powershell.exe', [...PS, "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"]);
        }, SLEEP_DELAY_MS);
        return 'Putting your PC to sleep in 5 seconds 😴 Say "cancel" to stop.';
      case 'snip':
        await (this.hooks.openExternal ? this.hooks.openExternal('ms-screenclip:') : this.openExternalFn('ms-screenclip:'));
        return 'Snip away, Prince ✂️ (it goes to your clipboard)';
      case 'screenshot': {
        const dir = this.screenshotsDir();
        fs.mkdirSync(dir, { recursive: true });
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const file = path.join(dir, `Shadow ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.png`);
        try {
          if (beforeScreenshot) await beforeScreenshot();
          const png = await capture();
          fs.writeFileSync(file, png);
        } catch (err) {
          return `Couldn't take the screenshot, Prince (${err.message}).`;
        } finally {
          if (afterScreenshot) afterScreenshot();
        }
        this.lastScreenshot = file;
        return `📸 Saved to Pictures › Screenshots. Say "open screenshots" to see it.`;
      }
      case 'volume-up':
        await sendKey(175, 5);
        return 'Volume up 🔊';
      case 'volume-down':
        await sendKey(174, 5);
        return 'Volume down 🔉';
      case 'mute':
        await sendKey(173, 1);
        return 'Toggled mute 🔇';
      case 'brightness': {
        const target = Number.isFinite(cmd.level)
          ? `${Math.round(cmd.level)}`
          : `[Math]::Max(0,[Math]::Min(100,(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness + (${cmd.step})))`;
        const { err } = await run('powershell.exe', [
          ...PS,
          `$b = ${target}; Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=[byte]$b} | Out-Null; $b`,
        ]);
        if (err) return "This screen doesn't let me change brightness, Prince (it works on laptop screens).";
        return Number.isFinite(cmd.level) ? `Brightness set to ${cmd.level}% ☀️` : `Brightness ${cmd.step > 0 ? 'up ☀️' : 'down 🌙'}`;
      }
      default:
        return null;
    }
  }

  /** What the AI may ask for (and how). */
  aiInstructions() {
    if (!this.windows) return '';
    return [
      "You can open things on Prince's PC. End your reply with one of these lines (he never sees it) when he asks:",
      '[[open | app or folder name]]   e.g. [[open | spotify]], [[open | downloads]], [[open | wifi settings]]',
      '[[pc | lock]]  [[pc | sleep]]  [[pc | screenshot]]  [[pc | volume up]]  [[pc | volume down]]  [[pc | mute]]',
      'You cannot close apps, shut down, restart, delete files or run commands - say so if asked.',
    ].join('\n');
  }
}

/** Pull [[open | x]] / [[pc | x]] requests out of an AI reply. */
function pcRequests(reply) {
  const out = [];
  const re = /\[\[\s*(open|pc)\s*\|\s*([^\]]{1,120})\]\]/gi;
  let m;
  while ((m = re.exec(String(reply || '')))) {
    if (m[1].toLowerCase() === 'open') out.push({ type: 'open', target: m[2].trim() });
    else {
      const cmd = parsePcCommand(m[2].trim().replace(/^screenshot$/i, 'take a screenshot'));
      if (cmd && cmd.type === 'system') out.push(cmd);
    }
  }
  return out.slice(0, 3);
}

module.exports = { AppLauncher, parsePcCommand, pcRequests, score, ALIASES };
