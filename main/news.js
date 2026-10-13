'use strict';
/*
 * news.js - the headlines for the HUD briefing (and "news" / "rbi news" in chat).
 *
 * Google News RSS feeds - free, no key, no account:
 *   India top stories · World · RBI & banking (a search: RBI / Reserve Bank of India / banking, last day)
 *   + one topic of your own (Settings → HUD → "Also follow", e.g. "cricket").
 * Only these fixed feed addresses (and your topic word) are requested; nothing about you is sent.
 */

const FEEDS = {
  india: { label: 'INDIA', path: '/rss?hl=en-IN&gl=IN&ceid=IN:en' },
  world: { label: 'WORLD', path: '/rss/headlines/section/topic/WORLD?hl=en-IN&gl=IN&ceid=IN:en' },
  banking: { label: 'RBI & BANKING', path: `/rss/search?q=${encodeURIComponent('RBI OR "Reserve Bank of India" OR banking OR "repo rate" when:1d')}&hl=en-IN&gl=IN&ceid=IN:en` },
};
const topicPath = (topic) => `/rss/search?q=${encodeURIComponent(`${topic} when:1d`)}&hl=en-IN&gl=IN&ceid=IN:en`;

const decode = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** RSS text -> [{ title, source, url, at }] */
function parseRss(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) && items.length < 40) {
    const body = m[1];
    const tag = (name) => {
      const t = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(body);
      return t ? decode(t[1]) : '';
    };
    let title = tag('title');
    let source = tag('source');
    // Google News titles end with " - Source"
    const dash = / - ([^-]{2,60})$/.exec(title);
    if (dash) {
      if (!source) source = dash[1].trim();
      if (dash[1].trim() === source) title = title.slice(0, dash.index).trim();
    }
    const url = tag('link');
    const at = Date.parse(tag('pubDate')) || 0;
    if (!title || !/^https?:\/\//i.test(url)) continue;
    items.push({ title: title.slice(0, 200), source: source.slice(0, 60), url: url.slice(0, 1000), at });
  }
  return items;
}

/** "news" / "world news" / "rbi news" / "banking news" -> { type: 'news', only? } */
function parseNewsCommand(input) {
  const l = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:hey |ok )?(?:jarvis|shadow)[,:!]?\s*/, '')
    .replace(/^(?:please|pls|can you|could you)\s+/, '')
    .replace(/[?.!]+$/, '');
  const m = /^(?:(?:tell me|give me|read(?: me)?|show(?: me)?|what'?s|whats|what is|any|get me)(?: the)? )?(?:(?:today'?s|todays|latest|top|daily|breaking) )?(rbi|banking|bank|rbi (?:and|&) banking|world|india|indian)? ?(?:news|headlines)(?: today| now| update| updates)?$/.exec(l);
  if (!m) return null;
  const w = m[1] || '';
  return { type: 'news', only: /rbi|bank/.test(w) ? 'banking' : w === 'world' ? 'world' : /india/.test(w) ? 'india' : '' };
}

class NewsFeed {
  /**
   * @param {object} o
   * @param {object} o.settings   newsOn, newsTopics: { world, india, banking }, newsTopic
   */
  constructor({ settings, fetchImpl, base = 'https://news.google.com', clock = () => Date.now() }) {
    this.settings = settings;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.base = base;
    this.clock = clock;
    this.cache = new Map(); // path -> { at, items }
  }

  async feed(path) {
    const hit = this.cache.get(path);
    if (hit && this.clock() - hit.at < 30 * 60 * 1000) return hit.items;
    const res = await this.fetch(`${this.base}${path}`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Shadow/1.0', Accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseRss(await res.text());
    this.cache.set(path, { at: this.clock(), items });
    return items;
  }

  /** Which feeds, in order: [{ key, label, path }] */
  wanted(only = '') {
    const t = this.settings.get('newsTopics') || {};
    const list = [];
    for (const key of ['banking', 'india', 'world']) if (only ? only === key : t[key] !== false) list.push({ key, ...FEEDS[key] });
    const own = !only && this.settings.get('newsTopic');
    if (own) list.push({ key: 'topic', label: own.toUpperCase(), path: topicPath(own) });
    return list;
  }

  /**
   * Headlines from the last day, newest first, no repeats across sections.
   * -> { ok, sections: [{ key, label, items: [{ title, source, url }] }] }  (ok:false = offline)
   */
  async headlines({ only = '', per = 4 } = {}) {
    const feeds = this.wanted(only);
    const got = await Promise.all(feeds.map((f) => this.feed(f.path).then((items) => ({ f, items }), () => ({ f, items: null }))));
    if (got.length && got.every((g) => g.items === null)) return { ok: false, sections: [] };
    const seen = new Set();
    const dayAgo = this.clock() - 36 * 60 * 60 * 1000;
    const sections = [];
    for (const { f, items } of got) {
      if (!items) continue;
      const fresh = items
        .filter((i) => !i.at || i.at >= dayAgo)
        .sort((a, b) => b.at - a.at)
        .filter((i) => {
          const k = i.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 60);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, per);
      if (fresh.length) sections.push({ key: f.key, label: f.label, items: fresh });
    }
    return { ok: true, sections };
  }
}

module.exports = { NewsFeed, parseRss, parseNewsCommand, FEEDS };
