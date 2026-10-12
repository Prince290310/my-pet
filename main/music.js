'use strict';
/*
 * music.js - Tempo the penguin, Shadow's DJ.
 *
 *   play / pause / next song / previous song   controls whatever is playing (Spotify, YouTube in
 *                                               the browser, VLC, ...) through Windows' media session
 *   what's playing                             title + artist from Windows' "now playing" info
 *   play something chill / play gym music /
 *   play arijit singh                          finds the top YouTube video for it and plays it
 *                                              (Settings → Music: YouTube, YouTube Music, or your own
 *                                              Spotify once it's connected - see spotify.js)
 *
 * Only fixed PowerShell scripts run here; the song you ask for only ever goes into a
 * search URL, never into a command. The video id read back from YouTube must look like one
 * (11 letters/digits/-/_) before it goes into the watch URL.
 */

const { execFile } = require('child_process');

const MOODS = {
  chill: 'chill lofi',
  relaxing: 'relaxing music',
  relax: 'relaxing music',
  calm: 'calm music',
  study: 'lofi study beats',
  focus: 'deep focus music',
  gym: 'gym workout motivation',
  workout: 'gym workout motivation',
  party: 'party hits',
  sad: 'sad songs',
  happy: 'happy songs',
  sleep: 'sleep music',
  romantic: 'romantic songs',
  bollywood: 'bollywood hits',
  punjabi: 'punjabi hits',
  lofi: 'lofi',
  english: 'top english hits',
  hindi: 'top hindi songs',
};

const SERVICES = ['youtube', 'ytmusic', 'spotify'];
const SERVICE_NAME = { youtube: 'YouTube', ytmusic: 'YouTube Music', spotify: 'Spotify' };
const BROWSERS = /chrome|msedge|edge|firefox|brave|opera|vivaldi/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** First real video in a YouTube results page -> { id, title } or null. */
function firstVideo(html) {
  const re = /"videoRenderer":\{"videoId":"([\w-]{11})"/g;
  const m = re.exec(String(html || ''));
  if (!m) return null;
  const near = html.slice(m.index, m.index + 4000);
  const t = /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.){1,200})"/.exec(near);
  let title = '';
  try {
    title = t ? JSON.parse(`"${t[1]}"`) : '';
  } catch {
    title = '';
  }
  return { id: m[1], title: title.replace(/\s+/g, ' ').trim().slice(0, 100) };
}

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** Windows media session control. ACTION is replaced with one fixed word from the list. */
const MEDIA_SCRIPT = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$g=([System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'})[0]
function Aw($op,$t){$task=$g.MakeGenericMethod($t).Invoke($null,@($op));$task.Wait(-1)|Out-Null;$task.Result}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]|Out-Null
$m=Aw ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s=$m.GetCurrentSession()
if(-not $s){'{"ok":false}';exit}
switch('ACTION'){
 'play'{Aw ($s.TryPlayAsync()) ([bool])|Out-Null; Start-Sleep -Milliseconds 300}
 'pause'{Aw ($s.TryPauseAsync()) ([bool])|Out-Null; Start-Sleep -Milliseconds 300}
 'next'{Aw ($s.TrySkipNextAsync()) ([bool])|Out-Null; Start-Sleep -Milliseconds 1200}
 'previous'{Aw ($s.TrySkipPreviousAsync()) ([bool])|Out-Null; Start-Sleep -Milliseconds 1200}
}
$p=Aw ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
[pscustomobject]@{ok=$true;title=$p.Title;artist=$p.Artist;app=$s.SourceAppUserModelId;status="$($s.GetPlaybackInfo().PlaybackStatus)"}|ConvertTo-Json -Compress
`;
const ACTIONS = ['status', 'play', 'pause', 'next', 'previous'];
const KEYS = { play: 179, pause: 179, next: 176, previous: 177 }; // fallback media keys

const clean = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey |ok |okay )?(?:shadow|tempo)?[,:!]?\s*/i, '')
    .replace(/^(?:please|pls|plz|can you|could you)\s+/i, '')
    .replace(/\s+(?:please|pls|plz|for me)$/i, '')
    .replace(/[?.!]+$/, '')
    .trim();

/** Chat message -> music command, or null. */
function parseMusicCommand(input) {
  const t = clean(input);
  const l = t.toLowerCase();
  let m;
  if (/^(?:play|resume|unpause|continue)(?: (?:the |my )?(?:music|song|songs|track))?$/.test(l)) return { action: 'play' };
  if (/^(?:pause|stop)(?: (?:the |my )?(?:music|song|songs|track))$|^pause$/.test(l)) return { action: 'pause' };
  if (/^(?:next|skip)(?: (?:the )?(?:song|track|one|this))?$|^(?:play )?(?:the )?next (?:song|track|one)$|^change (?:the )?song$/.test(l)) return { action: 'next' };
  if (/^(?:previous|prev|last|back)(?: (?:song|track|one))?$|^(?:play )?(?:the )?(?:previous|last) (?:song|track|one)( again)?$|^go back$/.test(l)) return { action: 'previous' };
  if (/^(?:what'?s|what is|whats|which) (?:song )?(?:this|playing|this song|the song|song is this)(?: song)?$|^now playing$|^what song is (?:this|playing)$|^which song is (?:this|playing)$/.test(l)) return { action: 'status' };
  if ((m = /^play (?:some(?:thing)? )?(chill|relaxing|relax|calm|study|focus|gym|workout|party|sad|happy|sleep|romantic|bollywood|punjabi|lofi|english|hindi)(?: (?:music|songs|beats|vibes|playlist|mix))?$/.exec(l))) {
    return { action: 'search', query: MOODS[m[1]], mood: m[1] };
  }
  if (/^play (?:some )?(?:something|some music|music|songs)(?: nice| good)?$/.test(l)) return { action: 'search', query: MOODS.chill, mood: 'chill' };
  if ((m = /^play (.+?)(?: (?:on|in) (spotify|youtube music|yt music|youtube))?$/i.exec(t))) {
    const query = m[1].replace(/^(?:the |some )/i, '').trim().slice(0, 120);
    const where = m[2] ? { spotify: 'spotify', youtube: 'youtube' }[m[2].toLowerCase()] || 'ytmusic' : null;
    if (query) return { action: 'search', query, where };
  }
  return null;
}

function run(file, args, timeout = 15000) {
  return new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout }, (err, stdout) => resolve({ err, stdout: String(stdout || '') })));
}

function appName(id) {
  const s = String(id || '');
  if (/spotify/i.test(s)) return 'Spotify';
  if (/chrome/i.test(s)) return 'Chrome';
  if (/msedge|edge/i.test(s)) return 'Edge';
  if (/firefox/i.test(s)) return 'Firefox';
  if (/brave/i.test(s)) return 'Brave';
  if (/vlc/i.test(s)) return 'VLC';
  if (/zune|music/i.test(s)) return 'Media Player';
  return s.replace(/\.exe$/i, '').replace(/!.*$/, '').split(/[.\\]/).pop() || 'your player';
}

const song = (r) => (r.title ? `${r.title}${r.artist ? ` – ${r.artist}` : ''}` : '');

class MusicControl {
  constructor({
    openExternal,
    service = () => 'youtube',
    platform = process.platform,
    hooks = {},
    fetchImpl,
    ytBase = 'https://www.youtube.com',
    ytMusicBase = 'https://music.youtube.com',
    nudgeMs = 6000,
    spotify = null,
  } = {}) {
    this.openExternal = openExternal;
    this.service = service; // Settings → Music
    this.platform = platform;
    this.hooks = hooks; // tests: { media(action) -> result }
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.ytBase = ytBase;
    this.ytMusicBase = ytMusicBase;
    this.nudgeMs = nudgeMs;
    this.spotify = spotify; // spotify.js - Prince's own Spotify account, once connected
  }

  get available() {
    return this.platform === 'win32' || !!this.hooks.media;
  }

  /** Talk to Windows' media session. Returns { ok, title, artist, app, status } ({ ok:false } = nothing playing). */
  async media(action) {
    if (!ACTIONS.includes(action)) throw new Error('bad action');
    if (this.hooks.media) return this.hooks.media(action);
    const { err, stdout } = await run('powershell.exe', [...PS, MEDIA_SCRIPT.replace('ACTION', action)]);
    try {
      if (!err) return JSON.parse(stdout.trim());
    } catch {
      /* fall through */
    }
    // older Windows / no WinRT: press the media key instead
    if (KEYS[action]) {
      await run('powershell.exe', [...PS, `(New-Object -ComObject WScript.Shell).SendKeys([char]${KEYS[action]})`]);
      return { ok: true, fallback: true };
    }
    return { ok: false };
  }

  /** Run a parsed command; returns Shadow's reply. */
  async run(cmd) {
    if (cmd.action === 'search') return this.search(cmd);
    if (!this.available) return 'Music controls only work on Windows, Prince.';
    const r = await this.media(cmd.action);
    if (!r.ok) return "Nothing's playing right now, Prince. Say \"play something chill\" and I'll start some 🎧";
    const now = song(r);
    switch (cmd.action) {
      case 'play':
        return `▶️ Playing${now ? `: ${now}` : ''}`;
      case 'pause':
        return `⏸️ Paused${now ? `: ${now}` : ''}`;
      case 'next':
        return `⏭️ Next up${now ? `: ${now}` : '!'}`;
      case 'previous':
        return `⏮️ Back${now ? `: ${now}` : '!'}`;
      default:
        return now ? `🎵 ${now} (${appName(r.app)}${/paus/i.test(r.status) ? ', paused' : ''})` : `Something's playing in ${appName(r.app)}, but it didn't say what.`;
    }
  }

  /** Top YouTube video for a search -> { id, title } (null if YouTube can't be read). */
  async findVideo(query) {
    const url = `${this.ytBase}/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`; // videos only
    const res = await this.fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return firstVideo(await res.text());
  }

  /** Pause whatever is playing (unless it's `except`) so two songs don't play at once. Returns the paused app. */
  async pauseOthers(except) {
    if (!this.available) return '';
    const now = await this.media('status').catch(() => null);
    if (!now || !now.ok || !/playing/i.test(now.status) || (except && except.test(now.app || ''))) return '';
    await this.media('pause').catch(() => null);
    return now.app || '';
  }

  async search({ query, where, mood }) {
    const svc = SERVICES.includes(where) ? where : SERVICES.includes(this.service()) ? this.service() : 'youtube';
    if (svc === 'spotify') {
      if (this.spotify && this.spotify.connected()) {
        await this.pauseOthers(/spotify/i); // a new Spotify song replaces Spotify's own anyway
        return (await this.spotify.play({ query, mood })).reply;
      }
      // not connected: Spotify only lets apps open a search
      await this.openExternal(`spotify:search:${encodeURIComponent(query)}`);
      return `🎧 Opened "${query}" in Spotify - tap the top result. (Connect your Spotify in Settings → Music and I'll start songs myself.)`;
    }
    let video = null;
    try {
      video = await this.findVideo(query);
    } catch {
      video = null;
    }
    if (!video || !/^[\w-]{11}$/.test(video.id)) {
      await this.openExternal(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`);
      return `🎧 I couldn't pick a video by myself, so I opened YouTube's search for "${query}" - click the first one!`;
    }
    const paused = await this.pauseOthers(); // don't play two things at once
    const base = svc === 'ytmusic' ? this.ytMusicBase : this.ytBase;
    await this.openExternal(`${base}/watch?v=${video.id}`);
    this.nudge(paused);
    return `▶️ Playing "${video.title || query}" on ${SERVICE_NAME[svc]} 🎧`;
  }

  /** Browsers sometimes hold a new video paused (autoplay rules): press play on it once. */
  nudge(pausedApp) {
    if (!this.available || !this.nudgeMs) return;
    setTimeout(async () => {
      try {
        const r = await this.media('status');
        // only a browser that we didn't just pause ourselves
        if (r.ok && BROWSERS.test(r.app || '') && r.app !== pausedApp && /paus/i.test(r.status)) await this.media('play');
      } catch {
        /* nothing to do */
      }
    }, this.nudgeMs);
  }

  /** Is music playing? (for Tempo's dancing). Never throws. */
  async playing() {
    if (!this.available) return false;
    try {
      const r = await this.media('status');
      return !!(r.ok && /playing/i.test(r.status));
    } catch {
      return false;
    }
  }

  aiInstructions() {
    return [
      'You can control music. End your reply with one of these lines when Prince asks:',
      '[[music | play]]  [[music | pause]]  [[music | next]]  [[music | previous]]  [[music | play <song, artist or mood, e.g. kesariya arijit singh>]]',
      'A song request starts playing by itself (the top YouTube result).',
    ].join('\n');
  }
}

/** [[music | ...]] requests in an AI reply -> parsed commands. */
function musicRequests(reply) {
  const out = [];
  const re = /\[\[\s*music\s*\|\s*([^\]]{1,120})\]\]/gi;
  let m;
  while ((m = re.exec(String(reply || '')))) {
    const v = m[1].trim();
    const cmd = /^(play|pause|next|previous)$/i.test(v) ? { action: v.toLowerCase() } : parseMusicCommand(/^play /i.test(v) ? v : `play ${v}`);
    if (cmd) out.push(cmd);
  }
  return out.slice(0, 2);
}

module.exports = { MusicControl, parseMusicCommand, musicRequests, appName, firstVideo, MOODS, SERVICES };
