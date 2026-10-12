'use strict';
/*
 * files.js - moving files between Prince's phone and this PC, through the Telegram bot.
 *
 * Phone → PC: send the bot a photo, PDF, document, video, audio or voice note and it is saved in
 *   Downloads\Shadow (a caption of "desktop", "documents" or "pictures" saves it there instead).
 *   Shadow never opens or runs what arrives, and program/script files get ".download" added to their
 *   name so a double-click can't run one by accident.
 * PC → phone:
 *   send me my maths notes · drop notes.pdf into my phone · send me notes.pdf from D drive
 *   send me D:\College\Sem 3\notes.pdf · send me my latest download · send me the College folder (zipped)
 *   browse · browse D: · what's in my downloads  → a numbered list: reply a number to open a folder
 *   or get a file, "send 3" sends a whole folder (zipped), "back", "more".
 *
 * Where Shadow may look is chosen in Settings → Phone, on the PC only (never from the phone):
 *   MAIN FOLDERS  Desktop, Documents, Downloads, Pictures, Videos, Music (default)
 *   WHOLE PC      every drive - except Windows/system folders, program folders and AppData
 * Either way: hidden files and password/key files are never sent, 50 MB max (Telegram's limit).
 * File names are looked up in a background index (a separate thread), so Shadow never freezes.
 * Settings → Phone also has a switch that turns all of this off.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');

const MAX_SEND = 50 * 1024 * 1024; // Telegram bots can send up to 50 MB
const MAX_RECEIVE = 20 * 1024 * 1024; // ...and download up to 20 MB
const RISKY = /\.(?:exe|msi|msix|appx|bat|cmd|com|scr|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|jar|lnk|reg|dll|sys|inf|scf|url|application|gadget|msc|iso|img|vhd|vhdx)$/i;
const SECRET = /(?:\.(?:kdbx?|pem|key|pfx|p12|ppk|asc|gpg|ovpn|keystore|jks)$|^id_(?:rsa|dsa|ecdsa|ed25519)|^\.env|wallet\.dat$|passwords?|credentials?|secrets?)/i;
// folders Shadow never looks into (system, programs, app data, caches)
const BLOCKED_DIRS = String.raw`^(?:windows|windows\.old|program files|program files \(x86\)|programdata|appdata|application data|local settings|\$recycle\.bin|system volume information|recovery|perflogs|msocache|config\.msi|boot|efi|windowsapps|node_modules|\.git|\.cache|cache|caches|temp|tmp)$`;
const BLOCKED_RE = new RegExp(BLOCKED_DIRS, 'i');
const SYSTEM_FILE = /^(?:pagefile|hiberfil|swapfile)\.sys$|^dumpstack\.log|^desktop\.ini$|^thumbs\.db$|^ntuser\./i;
const MAIN_FOLDERS = ['desktop', 'documents', 'downloads', 'pictures', 'videos', 'music'];
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
const PAGE = 25;

/** Runs in a separate thread: lists every folder + file under the roots (folders end with the separator). */
const INDEX_WORKER = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { roots, blocked, maxDepth, maxEntries } = workerData;
const BLOCK = new RegExp(blocked, 'i');
(async () => {
  const out = [];
  const stack = roots.map((r) => [r, 0]);
  while (stack.length && out.length < maxEntries) {
    const [dir, depth] = stack.pop();
    let d;
    try { d = await fs.promises.opendir(dir); } catch { continue; }
    try {
      for await (const e of d) {
        if (out.length >= maxEntries) break;
        const n = e.name;
        if (n[0] === '.' || n[0] === '$' || n.startsWith('~$') || e.isSymbolicLink()) continue;
        const p = path.join(dir, n);
        if (e.isDirectory()) {
          if (BLOCK.test(n)) continue;
          out.push(p + path.sep);
          if (depth < maxDepth) stack.push([p, depth + 1]);
        } else if (e.isFile()) out.push(p);
      }
    } catch { /* unreadable folder */ }
  }
  parentPort.postMessage(out);
})();
`;

const clean = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey |ok |okay )?(?:shadow|dash)?[,:!]?\s*/i, '')
    .replace(/^(?:please|pls|plz|can you|could you)\s+/i, '')
    .replace(/[?!]+$/, '')
    .replace(/\s+(?:please|pls|plz|for me|now|asap)$/i, '')
    .trim();

const VERB = String.raw`(?:send|give|share|forward|drop|transfer|move|put|copy|upload|get)`;
const DEST = String.raw`(?:(?:to|on|onto|into|in) (?:my |the )?(?:phone|mobile|cell|telegram)|to me|here)`;
const FILEISH = /\b(?:notes?|pdfs?|files?|documents?|docs?|assignments?|homework|ppts?|presentations?|slides|sheets?|excel|reports?|resume|cv|photos?|pics?|pictures?|images?|videos?|projects?|books?|ebooks?|syllabus|timetable|marksheets?|certificates?|folder|zip)\b/i;
const WHERE = String.raw`(?:[a-z]:\\?|[a-z] drive|desktop|documents|downloads|pictures|photos|videos|music|.+? (?:folder|drive))`;

/** Chat message -> file command, or null. ("send me a screenshot" is a NEW screenshot: apps.js) */
function parseFileCommand(input) {
  const t = clean(input).replace(/\.$/, '');
  const l = t.toLowerCase();
  let m;
  if ((m = new RegExp(`^${VERB}(?: me)? (?:my |the )?(?:latest|last|newest|recent|most recent) (download|downloaded file|screenshot|screen ?shot|photo|picture|pic|file)s?(?: ${DEST})?$`).exec(l))) {
    const k = m[1];
    return { type: 'latest', kind: /down/.test(k) ? 'download' : /screen/.test(k) ? 'screenshot' : /photo|pic/.test(k) ? 'photo' : 'any' };
  }
  if (new RegExp(`^${VERB}(?: me)? (?:an? |the )?(?:screen ?shot|ss)\\b`).test(l)) return null; // take a fresh one instead
  if (/^(?:send|tell) (?:the |my )?(?:gang|friends|everyone|avengers)\b/.test(l)) return null;
  if (!(m = new RegExp(`^${VERB}(?: me)? (.+?)(?: ${DEST})?(?: from (?:my |the |this )?(?:pc|laptop|computer))?$`, 'i').exec(t))) return null;
  const toPhone = new RegExp(`${DEST}$|${DEST} from`, 'i').test(t);
  let body = m[1].trim();
  let where = '';
  const w = new RegExp(`^(.+?) (?:from|in|inside|on) (?:my |the )?(${WHERE})$`, 'i').exec(body);
  if (w) {
    body = w[1].trim();
    where = w[2].trim();
  }
  body = body
    .replace(/^(?:my |the |this |that |a |an |all (?:my |the )?)+/i, '')
    .replace(/^(?:file|document|doc|pdf|photo|picture|pic) (?:called |named )?(?=\S)/i, '')
    .replace(/^(?:called |named )/i, '')
    .replace(/^["'“]|["'”]$/g, '')
    .trim();
  if (!body || body.length > 200) return null;
  if (/^(?:[a-z]:[\\/]|~[\\/]|[\\/])/i.test(body)) return { type: 'path', path: body };
  const folder = /^(.+?) folder$/i.exec(body);
  if (folder) return { type: 'send', name: folder[1].trim(), folder: true, where };
  const hasExt = /\.[a-z0-9]{1,6}$/i.test(body);
  // "send me chemistry" could be anything - only a file if one by that name exists (main.js checks)
  const loose = !hasExt && !toPhone && !FILEISH.test(t);
  return { type: 'send', name: body.slice(0, 120), where, loose };
}

/** "browse", "browse D:", "what's in my downloads", "show files in D:\College" -> { type: 'browse', target } */
function parseBrowseCommand(input) {
  const t = clean(input).replace(/\.$/, '');
  let m;
  if (/^(?:browse|explore)(?: (?:my )?(?:files|pc|computer|laptop|drives))?$|^(?:(?:show|list|see)(?: me)? )?(?:my |all )?(?:drives|folders)$|^(?:open )?(?:my )?(?:phone )?file explorer on (?:my )?phone$/i.test(t)) return { type: 'browse', target: '' };
  if ((m = /^(?:browse|explore)(?: (?:my |the )?(?:files )?(?:in|on) )?(?: ?(?:my |the ))?(.+)$/i.exec(t))) return { type: 'browse', target: m[1].trim() };
  if ((m = /^(?:show|list|see)(?: me)? (?:the |all )?(?:files|folders|everything) (?:in|on|inside) (?:my |the )?(.+)$/i.exec(t))) return { type: 'browse', target: m[1].trim() };
  if ((m = new RegExp(`^what'?s (?:in|on|inside) (?:my |the )?(${WHERE}|[a-z]:[\\\\/].*)$`, 'i').exec(t))) return { type: 'browse', target: m[1].trim() };
  return null;
}

/** While a numbered file list is open: "3", "send 3", "back", "more", "close". */
function parseNavCommand(input) {
  const l = clean(input).toLowerCase().replace(/\.$/, '');
  let m;
  if ((m = /^(?:number |no\.? ?|#)?(\d{1,3})$/.exec(l))) return { type: 'pick', n: Number(m[1]) };
  if ((m = /^(?:send|get|zip|give me)(?: me)? (?:number |no\.? ?|#)?(\d{1,3})$/.exec(l))) return { type: 'pick', n: Number(m[1]), send: true };
  if (/^(?:back|up|go back|go up|\.\.|previous folder)$/.test(l)) return { type: 'up' };
  if (/^(?:more|next|next page|show more)$/.test(l)) return { type: 'more' };
  if (/^(?:stop|close|exit|done|cancel)(?: browsing| it)?$/.test(l)) return { type: 'close' };
  return null;
}

/** A safe Windows file name from whatever the phone sent. */
function safeName(name, fallback = 'file') {
  let n = String(name || '')
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!n || RESERVED.test(n)) n = `${fallback}${n ? `-${n}` : ''}`;
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p) && i < 1000; i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

const mb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

class FileShare {
  /**
   * @param {object} o
   * @param {(name: string) => string} o.getPath  electron app.getPath
   * @param {() => string} [o.screenshotsDir]
   * @param {() => 'folders'|'pc'} [o.scope]   Settings → Phone → "Phone can get files from"
   * @param {object} [o.hooks]  tests: { drives(): string[], zip(src, dst) }
   */
  constructor({ getPath, screenshotsDir, scope = () => 'folders', platform = process.platform, hooks = {} }) {
    this.getPath = getPath;
    this.screenshotsDir = screenshotsDir || (() => path.join(getPath('pictures'), 'Screenshots'));
    this.scope = scope;
    this.platform = platform;
    this.hooks = hooks;
    this.pending = null; // { options, at } after "which one?"
    this.browsing = null; // { dir, entries, page, at } - the numbered folder listing
    this.index = null; // { at, scope, entries: string[] }
    this.indexing = null;
    this.maxAgeMs = 30 * 60 * 1000;
  }

  // ------------------------------------------------------------------ where Shadow may look
  mainFolders() {
    return MAIN_FOLDERS.map((k) => {
      try {
        return { key: k, path: fs.realpathSync(this.getPath(k)) };
      } catch {
        return null;
      }
    }).filter((x, i, a) => x && a.findIndex((y) => y.path === x.path) === i);
  }

  /** Every drive (C:\, D:\ ...) on Windows; the home folder elsewhere. */
  drives() {
    if (this.hooks.drives) return this.hooks.drives();
    if (this.platform !== 'win32') return [os.homedir()];
    const out = [];
    for (let c = 67; c <= 90; c++) {
      const d = `${String.fromCharCode(c)}:\\`;
      try {
        fs.accessSync(d);
        out.push(d);
      } catch {
        /* no such drive */
      }
    }
    return out;
  }

  roots() {
    return this.scope() === 'pc' ? this.drives() : this.mainFolders().map((x) => x.path);
  }

  where() {
    return this.scope() === 'pc' ? 'anywhere on your PC' : 'in Desktop, Documents, Downloads, Pictures, Videos or Music';
  }

  /** May this path be read and sent? Inside the roots, no system/hidden folder on the way. */
  allowed(p) {
    let real;
    try {
      real = fs.realpathSync(p);
    } catch {
      return false;
    }
    if (/^\\\\/.test(real)) return false; // network shares
    const root = this.roots().find((r) => {
      const R = lower(r.replace(/[\\/]+$/, ''));
      const X = lower(real);
      return X === R || X.startsWith(R + path.sep) || (R.length <= 3 && X.startsWith(R));
    });
    if (!root) return false;
    const rel = real.slice(root.replace(/[\\/]+$/, '').length).split(/[\\/]+/).filter(Boolean);
    return !rel.some((part, i) => part[0] === '.' || part[0] === '$' || (i < rel.length - 1 || fs.statSync(real).isDirectory() ? BLOCKED_RE.test(part) : SYSTEM_FILE.test(part)));
  }

  // ------------------------------------------------------------------ the index (background thread)
  ensureIndex(force = false) {
    const scope = this.scope();
    const same = this.index && this.index.scope === scope;
    if (same && !force && Date.now() - this.index.at < this.maxAgeMs) return Promise.resolve(this.index);
    if (same && !force) {
      // a bit old: answer from it now, refresh it in the background
      if (!this.indexing) this.build(scope);
      return Promise.resolve(this.index);
    }
    return this.indexing || this.build(scope);
  }

  build(scope) {
    const roots = this.roots();
    this.indexing = new Promise((resolve) => {
      let done = false;
      const finish = (entries) => {
        if (done) return;
        done = true;
        this.index = { at: Date.now(), scope, entries };
        this.indexing = null;
        resolve(this.index);
      };
      try {
        const w = new Worker(INDEX_WORKER, {
          eval: true,
          workerData: { roots, blocked: BLOCKED_DIRS, maxDepth: scope === 'pc' ? 14 : 8, maxEntries: scope === 'pc' ? 300000 : 150000 },
        });
        w.once('message', (entries) => {
          finish(entries);
          w.terminate();
        });
        w.once('error', () => finish([]));
        w.once('exit', () => finish(this.index && this.index.scope === scope ? this.index.entries : []));
      } catch {
        finish([]);
      }
    });
    return this.indexing;
  }

  /** Index entries matching the spoken name -> [{ path, name, dir, size, mtime, s }] best first. */
  async find(query, { where = '', folder = false } = {}) {
    let q = String(query || '').toLowerCase().trim();
    let idx = await this.ensureIndex();
    let hits = this.match(idx.entries, q, where, folder);
    if (!hits.length && Date.now() - idx.at > 60 * 1000) {
      idx = await this.ensureIndex(true); // maybe it's new - look again
      hits = this.match(idx.entries, q, where, folder);
    }
    const out = [];
    for (const h of hits.slice(0, 40)) {
      let st;
      try {
        st = fs.statSync(h.path);
      } catch {
        continue;
      }
      if (!this.allowed(h.path)) continue;
      out.push({ ...h, size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
    }
    return out.sort((a, b) => b.s - a.s || b.mtime - a.mtime).slice(0, 5);
  }

  match(entries, q, where, folder) {
    q = q.replace(/[\\/]+$/, '');
    const ext = /\.[a-z0-9]{1,6}$/.exec(q);
    const words = q.replace(/\.[a-z0-9]{1,6}$/, '').split(/[\s._-]+/).filter(Boolean);
    const w = this.whereFilter(where);
    const out = [];
    for (const e of entries) {
      const dir = e.endsWith(path.sep);
      if (folder !== dir) continue;
      const p = dir ? e.slice(0, -1) : e;
      if (w && !w(lower(p))) continue;
      const n = path.basename(p).toLowerCase();
      const stem = n.replace(/\.[a-z0-9]{1,8}$/, '');
      let s = 0;
      if (n === q) s = 100;
      else if (stem === q || stem === q.replace(/\.[a-z0-9]{1,6}$/, '')) s = 90;
      else if (n.startsWith(q)) s = 80;
      else if (words.length && words.every((x) => n.includes(x))) s = 60 + Math.min(19, words.join('').length);
      else if (words.length > 1 && words.every((x) => lower(p).includes(x))) s = 40; // "maths notes" -> Maths\notes.pdf
      if (!s) continue;
      if (ext && !n.endsWith(ext[0])) s -= 30;
      if (!dir && SECRET.test(n)) s = Math.min(s, 1); // still found, so we can say no
      if (s > 0) out.push({ path: p, name: path.basename(p), dir, s });
    }
    return out.sort((a, b) => b.s - a.s);
  }

  /** "D drive" / "D:" / "downloads" / "College folder" -> a path test, or null. */
  whereFilter(where) {
    const w = String(where || '').toLowerCase().trim();
    if (!w) return null;
    let m;
    if ((m = /^([a-z])(?::\\?| drive)$/.exec(w))) return (p) => p.startsWith(`${m[1]}:`);
    const known = this.mainFolders().find((x) => x.key === w.replace(/^photos$/, 'pictures'));
    if (known) return (p) => p.startsWith(lower(known.path));
    const name = w.replace(/ (?:folder|drive)$/, '');
    return (p) => p.split(/[\\/]+/).slice(0, -1).some((part) => part.toLowerCase() === name);
  }

  // ------------------------------------------------------------------ answering requests
  /** Newest file of a kind -> { path, name, size, mtime } or null. */
  latest(kind) {
    let files = [];
    const read = (d) => {
      try {
        return fs.readdirSync(d).map((n) => path.join(d, n));
      } catch {
        return [];
      }
    };
    if (kind === 'screenshot') files = read(this.screenshotsDir());
    else if (kind === 'download') files = [...read(this.getPath('downloads')), ...read(path.join(this.getPath('downloads'), 'Shadow'))];
    else files = this.mainFolders().flatMap((x) => read(x.path));
    const want = kind === 'photo' || kind === 'screenshot' ? /\.(?:png|jpe?g|gif|webp|heic|bmp)$/i : /./;
    let best = null;
    for (const p of files) {
      const name = path.basename(p);
      if (name.startsWith('.') || !want.test(name) || /\.(?:crdownload|part|tmp)$/i.test(name)) continue;
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path: p, name, size: st.size, mtime: st.mtimeMs };
    }
    return best;
  }

  /** Is this file OK to send to the phone? -> null (yes) or the reason it isn't. */
  refuse(f) {
    if (!f || !this.allowed(f.path)) return `I can only send files from ${this.scope() === 'pc' ? 'your drives (not Windows/system or app folders)' : 'Desktop, Documents, Downloads, Pictures, Videos and Music'}, Prince. ${this.scope() === 'pc' ? '' : '(Settings → Phone → WHOLE PC lets me look everywhere.)'}`.trim();
    if (SECRET.test(f.name)) return `"${f.name}" looks like a password or key file - I never send those, Prince 🔒`;
    if (f.size > MAX_SEND) return `"${f.name}" is ${mb(f.size)} - Telegram only lets me send up to 50 MB.`;
    if (!f.size) return `"${f.name}" is empty, Prince.`;
    return null;
  }

  /**
   * Any file command -> { text, document?, name?, temp?, notFound? } (document = path to send).
   * Several matches -> asks which one; "2" comes back as { type: 'pick' }.
   */
  async handle(cmd) {
    switch (cmd.type) {
      case 'latest': {
        const f = this.latest(cmd.kind);
        return f ? this.pick(f) : { text: `I couldn't find any ${cmd.kind === 'any' ? 'file' : cmd.kind} to send, Prince.` };
      }
      case 'path':
        return this.sendPath(cmd.path);
      case 'browse':
        return this.browse(cmd.target);
      case 'pick':
        return this.pickNumber(cmd.n, cmd.send);
      case 'up':
        return this.up();
      case 'more':
        return this.more();
      case 'close':
        this.browsing = null;
        this.pending = null;
        return { text: 'Closed the file list 📁' };
      default:
        return this.send(cmd);
    }
  }

  async send(cmd) {
    if (cmd.loose && !this.index) return { text: '', notFound: true }; // don't build a whole index for a maybe
    const found = await this.find(cmd.name, { where: cmd.where, folder: !!cmd.folder });
    const place = cmd.where ? ` in ${cmd.where}` : ` ${this.where()}`;
    if (!found.length) {
      return { notFound: true, text: `I couldn't find ${cmd.folder ? `a "${cmd.name}" folder` : `"${cmd.name}"`}${place}, Prince 🤔 Try "browse" to look around${this.scope() === 'pc' ? '' : ', or let me search the whole PC (Settings → Phone)'}.` };
    }
    const top = found[0];
    const close = found.filter((f) => f.s >= top.s - 5);
    if (top.s < 100 && close.length > 1) {
      this.pending = { options: close.slice(0, 5), at: Date.now() };
      this.browsing = null;
      return { text: `Which one, Prince?\n${this.pending.options.map((f, i) => `${i + 1}. ${f.dir ? '📁' : '📄'} ${f.name} - ${this.short(f.path)}${f.dir ? '' : ` (${mb(f.size)})`}`).join('\n')}\n(say the number)` };
    }
    return this.pick(top);
  }

  short(p) {
    const d = path.dirname(p);
    return d.length > 48 ? `…${d.slice(-46)}` : d;
  }

  async sendPath(raw) {
    let p = raw.replace(/^~(?=[\\/])/, os.homedir());
    if (!path.isAbsolute(p)) return { text: `I need the full path, like D:\\College\\notes.pdf` };
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return { notFound: true, text: `There's no "${raw}" on your PC, Prince 🤔` };
    }
    if (!this.allowed(p)) return { text: this.refuse({ path: p, name: path.basename(p) }) };
    return st.isDirectory() ? this.pick({ path: p, name: path.basename(p) || p, dir: true }) : this.pick({ path: p, name: path.basename(p), size: st.size });
  }

  /** Ready to send: { text, document, name } - folders are zipped first. */
  async pick(f) {
    this.pending = null;
    if (f.dir) return this.zipFolder(f.path);
    const no = this.refuse(f);
    if (no) return { text: no };
    return { text: `📤 Here's ${f.name} (${mb(f.size)})`, document: f.path, name: f.name };
  }

  /** "2" after "which one?" -> the same shape as handle(), or null if nothing is pending. */
  async choose(n) {
    const p = this.pending;
    if (!p || Date.now() - p.at > 10 * 60 * 1000 || !p.options[n - 1]) return null;
    return this.pick(p.options[n - 1]);
  }

  /** Is a numbered list ("which one?" / browsing) open, newer than `otherAt` (an app question)? */
  active(otherAt = 0) {
    const at = Math.max(this.pending ? this.pending.at : 0, this.browsing ? this.browsing.at : 0);
    return at > otherAt && Date.now() - at < 10 * 60 * 1000;
  }

  // ------------------------------------------------------------------ browsing like File Explorer
  async browse(target) {
    const t = String(target || '').trim().replace(/^(?:my|the)\s+/i, '');
    if (!t || /^(?:files|pc|computer|laptop|drives|folders|this pc)$/i.test(t)) return this.top();
    let m;
    let dir = null;
    if ((m = /^([a-z])(?::\\?| drive|:)$/i.exec(t))) dir = `${m[1].toUpperCase()}:\\`;
    else if (/^(?:[a-z]:[\\/]|~[\\/]|\/)/i.test(t)) dir = t.replace(/^~(?=[\\/])/, os.homedir());
    else {
      const key = t.toLowerCase().replace(/ folder$/, '').replace(/^photos$/, 'pictures');
      const known = this.mainFolders().find((x) => x.key === key);
      if (known) dir = known.path;
      else {
        const found = await this.find(key, { folder: true });
        if (found.length) dir = found[0].path;
      }
    }
    if (!dir) return { text: `I couldn't find a folder called "${t}" ${this.where()}, Prince. Say "browse" to start from the top.` };
    return this.list(dir);
  }

  top() {
    const entries = [
      ...this.mainFolders().map((x) => ({ name: x.key[0].toUpperCase() + x.key.slice(1), path: x.path, dir: true, icon: '📁' })),
      ...(this.scope() === 'pc' ? this.drives().map((d) => ({ name: d.replace(/\\$/, ''), path: d, dir: true, icon: '💽' })) : []),
    ];
    this.browsing = { dir: null, entries, page: 0, at: Date.now() };
    return { text: this.page(`📁 Your PC${this.scope() === 'pc' ? '' : ' (main folders - Settings → Phone → WHOLE PC for everything)'}`) };
  }

  async list(dir) {
    if (!this.allowed(dir)) return { text: this.refuse({ path: dir, name: path.basename(dir) || dir }) };
    let items;
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return { text: `I can't open ${dir} (${err.code || err.message}).` };
    }
    const entries = [];
    for (const e of items) {
      const n = e.name;
      if (n[0] === '.' || n[0] === '$' || n.startsWith('~$') || e.isSymbolicLink()) continue;
      const p = path.join(dir, n);
      if (e.isDirectory()) {
        if (!BLOCKED_RE.test(n)) entries.push({ name: n, path: p, dir: true, icon: '📁' });
      } else if (e.isFile() && !SYSTEM_FILE.test(n) && !SECRET.test(n)) {
        let size = 0;
        try {
          size = fs.statSync(p).size;
        } catch {
          continue;
        }
        entries.push({ name: n, path: p, dir: false, size, icon: '📄' });
      }
      if (entries.length >= 400) break;
    }
    const by = (a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    this.browsing = { dir, entries: entries.sort(by), page: 0, at: Date.now() };
    const folders = entries.filter((e) => e.dir).length;
    return { text: this.page(`📂 ${dir} - ${folders} folder${folders === 1 ? '' : 's'}, ${entries.length - folders} file${entries.length - folders === 1 ? '' : 's'}`) };
  }

  page(head) {
    const b = this.browsing;
    const from = b.page * PAGE;
    const shown = b.entries.slice(from, from + PAGE);
    if (!b.entries.length) return `${head}\n(empty)\nSay "back" to go up.`;
    const lines = shown.map((e, i) => `${from + i + 1}. ${e.icon} ${e.name}${e.dir ? '' : ` (${mb(e.size)})`}`);
    const more = from + PAGE < b.entries.length ? `\n…${b.entries.length - from - PAGE} more - say "more"` : '';
    return `${head}\n${lines.join('\n')}${more}\nReply a number to open a folder or get a file · "send 3" sends a whole folder (zipped) · "back"`;
  }

  async pickNumber(n, sendFolder = false) {
    if (this.pending && (!this.browsing || this.pending.at > this.browsing.at)) {
      const r = await this.choose(n);
      if (r) return r;
    }
    const b = this.browsing;
    if (!b) return { text: 'There is no list open - say "browse" to start.' };
    b.at = Date.now();
    const e = b.entries[n - 1];
    if (!e) return { text: `Pick a number from 1 to ${b.entries.length}, Prince.` };
    if (e.dir && !sendFolder) return this.list(e.path);
    return this.pick(e);
  }

  async up() {
    const b = this.browsing;
    if (!b || !b.dir) return this.top();
    const parent = path.dirname(b.dir);
    if (parent === b.dir || !this.allowed(parent)) return this.top();
    return this.list(parent);
  }

  more() {
    const b = this.browsing;
    if (!b) return { text: 'There is no list open - say "browse" to start.' };
    b.at = Date.now();
    if ((b.page + 1) * PAGE >= b.entries.length) return { text: "That's everything in this folder 📁" };
    b.page++;
    return { text: this.page(`📂 ${b.dir || 'Your PC'} (page ${b.page + 1})`) };
  }

  // ------------------------------------------------------------------ folders go as a .zip
  async zipFolder(dir) {
    if (!this.allowed(dir)) return { text: this.refuse({ path: dir, name: path.basename(dir) }) };
    // a quick size check before zipping (skips the same folders/files as everywhere else)
    let total = 0;
    let count = 0;
    const walk = (d, depth) => {
      if (total > 4 * MAX_SEND || count > 5000 || depth > 12) return;
      let items = [];
      try {
        items = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of items) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && !BLOCKED_RE.test(e.name) && e.name[0] !== '.') walk(p, depth + 1);
        else if (e.isFile()) {
          count++;
          try {
            total += fs.statSync(p).size;
          } catch {
            /* skip */
          }
        }
      }
    };
    walk(dir, 0);
    const name = path.basename(dir) || dir.replace(/[:\\/]/g, '');
    if (!count) return { text: `The "${name}" folder is empty, Prince.` };
    if (total > 4 * MAX_SEND || count > 5000) return { text: `The "${name}" folder is too big to send (${count > 5000 ? 'over 5000 files' : mb(total)}). Telegram's limit is 50 MB - say "browse ${dir}" and pick files instead.` };
    const tmp = path.join(os.tmpdir(), 'shadow-zips');
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of fs.readdirSync(tmp)) {
      try {
        if (Date.now() - fs.statSync(path.join(tmp, f)).mtimeMs > 60 * 60 * 1000) fs.unlinkSync(path.join(tmp, f)); // old zips
      } catch {
        /* in use */
      }
    }
    const zip = uniquePath(tmp, `${safeName(name, 'folder')}.zip`);
    try {
      if (this.hooks.zip) await this.hooks.zip(dir, zip);
      else if (this.platform === 'win32') await zipWithPowerShell(dir, zip);
      else return { text: 'Zipping folders only works on Windows, Prince.' };
    } catch (err) {
      return { text: `Couldn't zip "${name}" (${err.message}).` };
    }
    let size = 0;
    try {
      size = fs.statSync(zip).size;
    } catch {
      return { text: `Couldn't zip "${name}".` };
    }
    if (size > MAX_SEND) {
      fs.rmSync(zip, { force: true });
      return { text: `"${name}" zipped is ${mb(size)} - over Telegram's 50 MB. Say "browse ${dir}" and pick files instead.` };
    }
    this.pending = null;
    return { text: `📦 Here's the "${name}" folder, zipped (${count} files, ${mb(size)})`, document: zip, name: path.basename(zip), temp: true };
  }

  /**
   * Save a file that arrived from the phone. Returns { path, name, folder, renamed }.
   * `caption` may name a folder: desktop / documents / pictures (default Downloads\Shadow).
   */
  save(buffer, name, caption = '') {
    const c = String(caption || '').toLowerCase();
    const where = /\bdesktop\b/.test(c) ? 'desktop' : /\bdocuments?\b|\bdocs\b/.test(c) ? 'documents' : /\bpictures?\b|\bphotos?\b|\bgallery\b/.test(c) ? 'pictures' : 'downloads';
    const dir = where === 'downloads' ? path.join(this.getPath('downloads'), 'Shadow') : this.getPath(where);
    fs.mkdirSync(dir, { recursive: true });
    let n = safeName(name);
    const renamed = RISKY.test(n);
    if (renamed) n += '.download'; // can't be double-clicked into running
    const p = uniquePath(dir, n);
    fs.writeFileSync(p, buffer, { flag: 'wx' });
    const label = where === 'downloads' ? 'Downloads\\Shadow' : where[0].toUpperCase() + where.slice(1);
    return { path: p, name: path.basename(p), folder: label, size: buffer.length, renamed };
  }
}

/** PowerShell's own zipper. The paths travel as environment variables, never inside the command. */
function zipWithPowerShell(src, dst) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "Compress-Archive -LiteralPath $env:SHADOW_ZIP_SRC -DestinationPath $env:SHADOW_ZIP_DST -CompressionLevel Optimal -Force"],
      { windowsHide: true, timeout: 5 * 60 * 1000, env: { ...process.env, SHADOW_ZIP_SRC: src, SHADOW_ZIP_DST: dst } },
      (err) => (err ? reject(new Error('zip failed')) : resolve())
    );
  });
}

module.exports = { FileShare, parseFileCommand, parseBrowseCommand, parseNavCommand, safeName, MAX_SEND, MAX_RECEIVE, RISKY, SECRET, BLOCKED_RE, mb };
