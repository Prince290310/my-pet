'use strict';
/*
 * music.js - Tempo the penguin, Shadow's DJ.
 *
 *   play / pause / next song / previous song   controls whatever is playing (Spotify, YouTube in
 *                                               the browser, VLC, ...) through Windows' media session
 *   what's playing                             title + artist from Windows' "now playing" info
 *   play something chill / play gym music /
 *   play arijit singh                          opens a search in Spotify (if installed) or YouTube
 *
 * Only fixed PowerShell scripts run here; the song you ask for only ever goes into a
 * spotify:search: / YouTube URL, never into a command.
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
  if ((m = /^play (.+?)(?: (?:on|in) (spotify|youtube))?$/.exec(t))) {
    const query = m[1].replace(/^(?:the |some )/i, '').trim().slice(0, 120);
    if (query) return { action: 'search', query, where: m[2] ? m[2].toLowerCase() : null };
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
  constructor({ openExternal, hasSpotify = async () => false, platform = process.platform, hooks = {} } = {}) {
    this.openExternal = openExternal;
    this.hasSpotify = hasSpotify;
    this.platform = platform;
    this.hooks = hooks; // tests: { media(action) -> result }
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

  async search({ query, where }) {
    const spotify = where !== 'youtube' && (where === 'spotify' || (await this.hasSpotify()));
    const url = spotify ? `spotify:search:${encodeURIComponent(query)}` : `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    await this.openExternal(url);
    return `🎧 Finding "${query}" on ${spotify ? 'Spotify' : 'YouTube'} - pick one and enjoy!`;
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
      '[[music | play]]  [[music | pause]]  [[music | next]]  [[music | previous]]  [[music | play <what to search, e.g. arijit singh romantic>]]',
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

module.exports = { MusicControl, parseMusicCommand, musicRequests, appName, MOODS };
