'use strict';
/*
 * files.js - moving files between Prince's phone and this PC, through the Telegram bot.
 *
 * Phone → PC: send the bot a photo, PDF, document, video, audio or voice note and it is saved in
 *   Downloads\Shadow (a caption of "desktop", "documents" or "pictures" saves it there instead).
 *   Shadow never opens or runs what arrives, and program/script files get ".download" added to their
 *   name so a double-click can't run one by accident.
 * PC → phone: "send me notes.pdf", "send me my latest download", "send me the last screenshot".
 *   Shadow only looks in Downloads, Documents, Desktop and Pictures (a few folders deep), skips hidden
 *   files, never sends password/key files, and stops at 50 MB (Telegram's limit for bots).
 *
 * Settings → Phone has a switch that turns all of this off.
 */

const fs = require('fs');
const path = require('path');

const MAX_SEND = 50 * 1024 * 1024; // Telegram bots can send up to 50 MB
const MAX_RECEIVE = 20 * 1024 * 1024; // ...and download up to 20 MB
const RISKY = /\.(?:exe|msi|msix|appx|bat|cmd|com|scr|pif|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|jar|lnk|reg|dll|sys|inf|scf|url|application|gadget|msc|iso|img|vhd|vhdx)$/i;
const SECRET = /(?:\.(?:kdbx?|pem|key|pfx|p12|ppk|asc|gpg|ovpn|keystore|jks)$|^id_(?:rsa|dsa|ecdsa|ed25519)|^\.env|wallet\.dat$|passwords?|credentials?|secrets?)/i;
const SKIP_DIRS = /^(?:node_modules|\.git|\$recycle\.bin|system volume information|appdata|cache|temp|tmp)$/i;
const ROOTS = ['downloads', 'documents', 'desktop', 'pictures'];
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

const clean = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey |ok |okay )?(?:shadow|dash)?[,:!]?\s*/i, '')
    .replace(/^(?:please|pls|plz|can you|could you)\s+/i, '')
    .replace(/[?!]+$/, '')
    .replace(/\s+(?:please|pls|plz|for me|now|asap)$/i, '')
    .trim();

/** Chat message -> file command, or null. ("send me a screenshot" is a NEW screenshot: apps.js) */
function parseFileCommand(input) {
  const t = clean(input).replace(/\.$/, '');
  const l = t.toLowerCase();
  let m;
  if ((m = /^(?:send|give|share|forward)(?: me)? (?:my |the )?(?:latest|last|newest|recent|most recent) (download|downloaded file|screenshot|screen ?shot|photo|picture|pic|file)s?(?: (?:to (?:my )?phone|to me|here|on telegram))?$/.exec(l))) {
    const k = m[1];
    return { type: 'latest', kind: /down/.test(k) ? 'download' : /screen/.test(k) ? 'screenshot' : /photo|pic/.test(k) ? 'photo' : 'any' };
  }
  if (/^(?:send|give|share)(?: me)? (?:an? |the )?(?:screen ?shot|ss)\b/.test(l)) return null; // take a fresh one instead
  if ((m = /^(?:send|give|share|forward)(?: me)? (?:my |the |this |that |a )?(?:file |document |doc |pdf |photo |picture |pic )?(?:called |named )?["'“]?(.+?)["'”]?(?: file| document| doc)?(?: (?:to (?:my )?phone|to me|here|on telegram|from (?:my |the )?(?:pc|laptop|computer)))*$/i.exec(t))) {
    const name = m[1].trim();
    // must look like a file: has an extension, or says file/document/pdf/photo
    if (name && (/\.[a-z0-9]{1,6}$/i.test(name) || /^(?:send|give|share|forward)(?: me)? (?:my |the |this |that |a )?(?:file|document|doc|pdf|photo|picture|pic)\b/i.test(t))) {
      return { type: 'send', name: name.slice(0, 120) };
    }
  }
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

class FileShare {
  /**
   * @param {object} o
   * @param {(name: string) => string} o.getPath  electron app.getPath
   * @param {() => string} [o.screenshotsDir]
   */
  constructor({ getPath, screenshotsDir }) {
    this.getPath = getPath;
    this.screenshotsDir = screenshotsDir || (() => path.join(getPath('pictures'), 'Screenshots'));
    this.pending = null; // { options, at } after "which one?"
  }

  roots() {
    return ROOTS.map((k) => {
      try {
        return fs.realpathSync(this.getPath(k));
      } catch {
        return null;
      }
    }).filter((p, i, a) => p && a.indexOf(p) === i);
  }

  inRoots(p) {
    let real;
    try {
      real = fs.realpathSync(p);
    } catch {
      return false;
    }
    return this.roots().some((r) => real === r || real.startsWith(r + path.sep));
  }

  /** Every ordinary file in the allowed folders (a few levels deep, capped). */
  walk({ maxDepth = 4, maxFiles = 20000 } = {}) {
    const out = [];
    const visit = (dir, depth) => {
      if (out.length >= maxFiles) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= maxFiles) return;
        if (e.name.startsWith('.') || e.name.startsWith('~$') || e.isSymbolicLink()) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < maxDepth && !SKIP_DIRS.test(e.name)) visit(p, depth + 1);
        } else if (e.isFile()) {
          out.push(p);
        }
      }
    };
    for (const r of this.roots()) visit(r, 0);
    return out;
  }

  /** Best matches for a spoken file name -> [{ path, name, size, mtime }] (best first). */
  find(query) {
    const q = String(query || '').toLowerCase().trim();
    const words = q.replace(/\.[a-z0-9]{1,6}$/, '').split(/[\s._-]+/).filter(Boolean);
    const scored = [];
    for (const p of this.walk()) {
      const name = path.basename(p);
      const n = name.toLowerCase();
      const stem = n.replace(/\.[a-z0-9]{1,8}$/, '');
      let s = 0;
      if (n === q) s = 100;
      else if (stem === q || stem === q.replace(/\.[a-z0-9]{1,6}$/, '')) s = 90;
      else if (n.startsWith(q)) s = 80;
      else if (words.length && words.every((w) => n.includes(w))) s = 60 + Math.min(19, words.join('').length);
      if (!s) continue;
      // the same extension as asked for, if any
      const ext = /\.[a-z0-9]{1,6}$/.exec(q);
      if (ext && !n.endsWith(ext[0])) s -= 30;
      if (s <= 0) continue;
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      scored.push({ path: p, name, size: st.size, mtime: st.mtimeMs, s });
    }
    return scored.sort((a, b) => b.s - a.s || b.mtime - a.mtime).slice(0, 5);
  }

  /** Newest file of a kind -> { path, name, size, mtime } or null. */
  latest(kind) {
    let files = [];
    if (kind === 'screenshot') {
      const dir = this.screenshotsDir();
      try {
        files = fs.readdirSync(dir).map((n) => path.join(dir, n));
      } catch {
        files = [];
      }
    } else if (kind === 'download') {
      const dir = this.getPath('downloads');
      const read = (d) => {
        try {
          return fs.readdirSync(d).map((n) => path.join(d, n));
        } catch {
          return [];
        }
      };
      files = [...read(dir), ...read(path.join(dir, 'Shadow'))];
    } else {
      files = this.walk();
    }
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

  /**
   * Is this file OK to send to the phone? -> null (yes) or the reason it isn't.
   * Inside the allowed folders only, no secrets, not too big.
   */
  refuse(f) {
    if (!f || !this.inRoots(f.path)) return "I only send files from Downloads, Documents, Desktop and Pictures, Prince.";
    if (SECRET.test(f.name)) return `"${f.name}" looks like a password or key file - I never send those, Prince 🔒`;
    if (f.size > MAX_SEND) return `"${f.name}" is ${mb(f.size)} - Telegram only lets me send up to 50 MB.`;
    if (!f.size) return `"${f.name}" is empty, Prince.`;
    return null;
  }

  /**
   * "send me …" -> { text } or { text, document } (document = path to send).
   * Several matches -> asks which one; the reply "2" comes back through choose().
   */
  request(cmd) {
    if (cmd.type === 'latest') {
      const f = this.latest(cmd.kind);
      if (!f) return { text: `I couldn't find any ${cmd.kind === 'any' ? 'file' : cmd.kind} to send, Prince.` };
      return this.pick(f);
    }
    const found = this.find(cmd.name);
    if (!found.length) return { text: `I couldn't find "${cmd.name}" in your Downloads, Documents, Desktop or Pictures, Prince 🤔` };
    const top = found[0];
    const close = found.filter((f) => f.s >= top.s - 5);
    if (top.s < 100 && close.length > 1) {
      this.pending = { options: close.slice(0, 4), at: Date.now() };
      return { text: `Which one, Prince? ${this.pending.options.map((f, i) => `${i + 1}. ${f.name} (${mb(f.size)})`).join(' · ')} (say the number)` };
    }
    return this.pick(top);
  }

  pick(f) {
    this.pending = null;
    const no = this.refuse(f);
    if (no) return { text: no };
    return { text: `📤 Here's ${f.name} (${mb(f.size)})`, document: f.path, name: f.name };
  }

  /** "2" after "which one?" -> the same shape as request(), or null if nothing is pending. */
  choose(n) {
    const p = this.pending;
    if (!p || Date.now() - p.at > 5 * 60 * 1000 || !p.options[n - 1]) return null;
    return this.pick(p.options[n - 1]);
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

module.exports = { FileShare, parseFileCommand, safeName, MAX_SEND, MAX_RECEIVE, RISKY, SECRET, mb };
