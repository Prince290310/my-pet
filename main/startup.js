'use strict';
/*
 * startup.js - Shadow's startup routine: when Windows starts (or the PC wakes up after a long
 * sleep), Shadow opens your usual apps, folders and sites, puts music on, then gives the briefing.
 *
 *   add vs code to my startup        add "play lofi" to startup        when my pc starts open chrome and spotify
 *   remove spotify from startup      show my startup routine           run my startup routine
 *   clear my startup routine
 *
 * Every step is an ordinary "open …" or "play …" command, so it goes through the same safe app
 * launcher (apps.js) and music player (music.js) as the chat. Nothing else (lock, sleep, ...) can
 * be part of it.
 */

const { parsePcCommand } = require('./apps');
const { parseMusicCommand } = require('./music');

const MAX_ITEMS = 10;
const STARTUP = '(?:startup|start ?up|morning)(?: routine| list| apps)?';

const clean = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey |ok |okay )?(?:shadow|bolt)?[,:!]?\s*/i, '')
    .replace(/^(?:please|pls|plz|can you|could you)\s+/i, '')
    .replace(/[?.!]+$/, '')
    .trim();

/** "spotify" / "open spotify" / "play lofi" -> the stored step ("open spotify" / "play lofi"), or null. */
function normalize(item) {
  let t = clean(item).replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!t || t.length > 80) return null;
  if (/^play\b/i.test(t)) {
    const m = parseMusicCommand(t);
    return m && m.action === 'search' ? `play ${m.query}${m.where ? ` on ${m.where === 'ytmusic' ? 'youtube music' : m.where}` : ''}` : null;
  }
  const sys = parsePcCommand(t);
  if (sys && sys.type !== 'open') return null; // lock / sleep / screenshot / volume are never part of it
  if (!/^(?:open|launch|start|run)\b/i.test(t)) t = `open ${t}`;
  const c = parsePcCommand(t);
  return c && c.type === 'open' ? `open ${c.target}` : null;
}

/** "chrome, spotify and downloads" -> ['chrome', 'spotify', 'downloads'] */
function splitList(s) {
  return String(s || '')
    .split(/\s*(?:,|\band\b|\bthen\b|&|\+)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Chat message -> startup command, or null. */
function parseStartupCommand(input) {
  const t = clean(input);
  const l = t.toLowerCase();
  let m;
  if ((m = new RegExp(`^(?:add|put|include) (.+?) (?:to|in|into|on) (?:my |the )?${STARTUP}$`, 'i').exec(t))) return { type: 'add', items: splitList(m[1]) };
  if ((m = /^when (?:my |the )?(?:pc|laptop|computer|windows) (?:starts|turns on|boots|switches on|wakes up)(?: up)?,? (?:open|launch|start|run|also open) (.+)$/i.exec(t))) {
    return { type: 'add', items: splitList(m[1]) };
  }
  if ((m = new RegExp(`^(?:remove|delete|take|drop) (.+?) (?:from|off|out of) (?:my |the )?${STARTUP}$`, 'i').exec(t))) return { type: 'remove', item: m[1].trim() };
  if (new RegExp(`^(?:clear|empty|reset|delete) (?:my |the )?${STARTUP}$`).test(l)) return { type: 'clear' };
  if (new RegExp(`^(?:run|do|start|test|play) (?:my |the )?${STARTUP}(?: now)?$`).test(l)) return { type: 'run' };
  if (new RegExp(`^(?:show|list|see|view|what'?s in|what is in|whats in)? ?(?:my |the )?(?:startup|start ?up) (?:routine|list|apps)$`).test(l)) return { type: 'show' };
  return null;
}

class StartupRoutine {
  /** @param {{ settings: import('./settings').Settings, loginOn?: () => boolean }} o */
  constructor({ settings, loginOn = () => true }) {
    this.settings = settings;
    this.loginOn = loginOn; // is "Start with Windows" on?
  }

  items() {
    return this.settings.get('startupRoutine') || [];
  }

  /** The reply for a parsed command (not 'run' - main.js runs the routine). */
  edit(cmd) {
    const items = this.items();
    if (cmd.type === 'show') return this.describe();
    if (cmd.type === 'clear') {
      this.settings.update({ startupRoutine: [] });
      return items.length ? 'Startup routine cleared 🧹' : 'Your startup routine is already empty, Prince.';
    }
    if (cmd.type === 'remove') {
      const want = normalize(cmd.item);
      const key = (s) => s.toLowerCase().replace(/^(?:open|play) /, '');
      const i = items.findIndex((x) => x.toLowerCase() === (want || '').toLowerCase() || key(x) === key(cmd.item.toLowerCase()));
      if (i < 0) return `"${cmd.item}" isn't in your startup routine, Prince. ${this.describe()}`;
      const next = items.filter((_, j) => j !== i);
      this.settings.update({ startupRoutine: next });
      return `Removed "${items[i]}" from your startup routine ✓`;
    }
    // add
    const added = [];
    const bad = [];
    const next = [...items];
    for (const raw of cmd.items || []) {
      const step = normalize(raw);
      if (!step) bad.push(raw);
      else if (!next.some((x) => x.toLowerCase() === step.toLowerCase())) {
        if (next.length >= MAX_ITEMS) {
          bad.push(raw);
          continue;
        }
        next.push(step);
        added.push(step);
      }
    }
    if (added.length) this.settings.update({ startupRoutine: next });
    const parts = [];
    if (added.length) parts.push(`Added to your startup routine: ${added.join(', ')} ✓`);
    if (bad.length) parts.push(next.length >= MAX_ITEMS ? `(${MAX_ITEMS} steps max, so I skipped ${bad.join(', ')})` : `I can only open apps, folders and sites or play music at startup - skipped: ${bad.join(', ')}`);
    if (!parts.length) return 'Those are already in your startup routine, Prince 👍';
    if (added.length && !this.loginOn()) parts.push('(Turn on "Start with Windows" in Settings so it runs by itself.)');
    return parts.join(' ');
  }

  describe() {
    const items = this.items();
    if (!items.length) return 'Your startup routine is empty. Try "add vs code to my startup" or "add play lofi to startup" 🌅';
    return `🌅 When your PC starts I: ${items.map((x, i) => `${i + 1}. ${x}`).join(' · ')}`;
  }

  /**
   * Run every step with `runStep(text)` (main.js: the app launcher / music player), apps first and
   * music last. Returns the replies.
   */
  async run(runStep, { gapMs = 1200 } = {}) {
    const steps = [...this.items()].sort((a, b) => /^play /i.test(a) - /^play /i.test(b));
    const out = [];
    for (const [i, step] of steps.entries()) {
      if (i && gapMs) await new Promise((r) => setTimeout(r, gapMs)); // one at a time, so the PC doesn't choke
      try {
        out.push({ step, reply: await runStep(step) });
      } catch (err) {
        out.push({ step, reply: `couldn't (${err.message})`, failed: true });
      }
    }
    return out;
  }
}

module.exports = { StartupRoutine, parseStartupCommand, normalize, MAX_ITEMS };
