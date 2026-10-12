'use strict';
/*
 * spotify.js - play songs on Prince's own Spotify, through the official Spotify Web API.
 *
 * One-time setup (Settings → Music): make a free app at developer.spotify.com/dashboard with the
 * Redirect URI http://127.0.0.1:8971/callback, paste its Client ID here and click CONNECT SPOTIFY.
 * The login happens on Spotify's own page (PKCE - no client secret, Shadow never sees the password).
 * Only a refresh token is kept, in the settings file on this PC. DISCONNECT forgets it.
 *
 * Spotify Premium: Shadow finds the song and starts it in your Spotify app.
 * Spotify Free: Spotify doesn't let any app start songs, so Shadow opens that exact song in
 * Spotify and you press play once.
 */

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PORT = 8971;
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-private';
const CLIENT_ID_RE = /^[0-9a-f]{32}$/i;
const DASHBOARD_URL = 'https://developer.spotify.com/dashboard';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const SPOTIFY_URI = /^spotify:(track|playlist|album):[A-Za-z0-9]{10,40}$/;

const PAGE = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;background:#150f22;color:#fffaf0;display:grid;place-items:center;height:90vh;text-align:center"><div><h1>🐾 ${title}</h1><p>${text}</p></div>`;

class SpotifyLink extends EventEmitter {
  constructor({
    settings,
    openExternal,
    fetchImpl,
    accountsBase = 'https://accounts.spotify.com',
    apiBase = 'https://api.spotify.com/v1',
    port = PORT,
    deviceWaitMs = 12000,
  }) {
    super();
    this.settings = settings;
    this.openExternal = openExternal;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.accountsBase = accountsBase;
    this.apiBase = apiBase;
    this.port = port;
    this.deviceWaitMs = deviceWaitMs;
    this.access = null; // { token, expiresAt }
    this.server = null;
  }

  redirectUri() {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  connected() {
    return CLIENT_ID_RE.test(this.settings.get('spotifyClientId')) && !!this.settings.get('spotifyRefreshToken');
  }

  info() {
    return {
      connected: this.connected(),
      clientId: this.settings.get('spotifyClientId'),
      user: this.settings.get('spotifyUser'),
      premium: this.settings.get('spotifyProduct') === 'premium',
      product: this.settings.get('spotifyProduct'),
      redirectUri: this.redirectUri(),
      dashboard: DASHBOARD_URL,
      waiting: !!this.server,
    };
  }

  // ------------------------------------------------------------------ login (PKCE)
  /** Opens Spotify's login page and waits (up to 5 min) for Prince to approve. */
  async connect(clientId) {
    clientId = String(clientId || '').trim();
    if (!CLIENT_ID_RE.test(clientId)) return { ok: false, message: "That doesn't look like a Client ID - it's 32 letters and digits, on your app's page at developer.spotify.com." };
    this.stopServer();
    this.access = null;
    this.settings.update({ spotifyClientId: clientId, spotifyRefreshToken: '', spotifyUser: '', spotifyProduct: '' });
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const code = await new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(timer);
        this.stopServer();
        resolve(v);
      };
      const timer = setTimeout(() => done({ error: 'timeout' }), 5 * 60 * 1000);
      this.server = http.createServer((req, res) => {
        const u = new URL(req.url, this.redirectUri());
        if (u.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ok ? PAGE('Connected!', 'Shadow can play your Spotify now. You can close this tab.') : PAGE('Not connected', 'Spotify said no (or the link was old). Try CONNECT SPOTIFY again.'));
        done(ok ? { code: u.searchParams.get('code') } : { error: u.searchParams.get('error') || 'bad state' });
      });
      this.server.on('error', (err) => done({ error: err.code === 'EADDRINUSE' ? `port ${this.port} is busy` : err.message }));
      this.server.listen(this.port, '127.0.0.1', () => {
        const q = new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: this.redirectUri(),
          code_challenge_method: 'S256',
          code_challenge: challenge,
          scope: SCOPES,
          state,
        });
        this.openExternal(`${this.accountsBase}/authorize?${q}`);
        this.emit('waiting');
      });
    });
    if (code.error) {
      const msg = {
        timeout: 'No answer from Spotify in 5 minutes.',
        access_denied: 'You clicked Cancel on the Spotify page.',
      }[code.error] || `Spotify said: ${code.error}. Check that the Redirect URI is exactly ${this.redirectUri()}.`;
      return { ok: false, message: msg };
    }
    try {
      await this.tokenRequest({ grant_type: 'authorization_code', code: code.code, redirect_uri: this.redirectUri(), client_id: clientId, code_verifier: verifier });
      const me = await this.api('GET', '/me');
      this.settings.update({ spotifyUser: String((me.json && (me.json.display_name || me.json.id)) || '').slice(0, 60), spotifyProduct: me.json && me.json.product === 'premium' ? 'premium' : 'free' });
    } catch (err) {
      this.settings.update({ spotifyRefreshToken: '' });
      return { ok: false, message: `Couldn't finish the login (${err.message}).` };
    }
    this.emit('connected', this.info());
    return { ok: true, ...this.info() };
  }

  stopServer() {
    if (this.server) this.server.close();
    this.server = null;
  }

  disconnect() {
    this.stopServer();
    this.access = null;
    this.settings.update({ spotifyRefreshToken: '', spotifyUser: '', spotifyProduct: '' });
    return this.info();
  }

  async tokenRequest(form) {
    const res = await this.fetch(`${this.accountsBase}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15000),
    });
    let j = {};
    try {
      j = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok || !j.access_token) {
      const err = new Error(j.error_description || j.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = j.error;
      throw err;
    }
    this.access = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    if (j.refresh_token) this.settings.update({ spotifyRefreshToken: j.refresh_token });
    return this.access.token;
  }

  async token() {
    if (this.access && Date.now() < this.access.expiresAt - 60000) return this.access.token;
    try {
      return await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.settings.get('spotifyRefreshToken'), client_id: this.settings.get('spotifyClientId') });
    } catch (err) {
      if (err.code === 'invalid_grant') this.settings.update({ spotifyRefreshToken: '' }); // revoked: connect again
      throw err;
    }
  }

  /** Spotify Web API call -> { status, json }. Retries once with a fresh token. */
  async api(method, path, body, retried = false) {
    const res = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 && !retried) {
      this.access = null;
      return this.api(method, path, body, true);
    }
    let json = null;
    try {
      json = res.status === 204 ? null : await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  // ------------------------------------------------------------------ playing
  async find(query, kind) {
    const r = await this.api('GET', `/search?${new URLSearchParams({ q: query, type: kind, limit: '1' })}`);
    const item = r.json && r.json[`${kind}s`] && (r.json[`${kind}s`].items || []).filter(Boolean)[0];
    if (!item || !SPOTIFY_URI.test(item.uri || '')) return null;
    const by = kind === 'track' ? (item.artists || []).map((a) => a.name).slice(0, 2).join(', ') : '';
    return { uri: item.uri, name: `${String(item.name || '').slice(0, 80)}${by ? ` – ${by}` : ''}` };
  }

  async device() {
    const r = await this.api('GET', '/me/player/devices');
    const list = (r.json && r.json.devices) || [];
    return list.find((d) => d.is_active) || list.find((d) => d.type === 'Computer') || list[0] || null;
  }

  /**
   * Play a song (or a mood playlist) on Prince's Spotify. Returns { ok, reply }.
   * Never throws for Spotify errors - they come back as a friendly reply.
   */
  async play({ query, mood }) {
    const kind = mood ? 'playlist' : 'track';
    let item;
    try {
      item = await this.find(query, kind);
    } catch (err) {
      return { ok: false, reply: this.friendly(err) };
    }
    if (!item) return { ok: false, reply: `Spotify has nothing for "${query}", Prince 🤔` };
    const openIt = async (why) => {
      await this.openExternal(item.uri); // the exact song/playlist, one click from playing
      return { ok: true, opened: true, reply: `🎧 Opened "${item.name}" in Spotify - press ▶ to start it. ${why}` };
    };
    if (this.settings.get('spotifyProduct') !== 'premium') return openIt("(Spotify Free doesn't let apps press play - Premium does.)");
    try {
      let dev = await this.device();
      if (!dev) {
        // Spotify isn't open anywhere: start the app on this PC and wait for it to show up
        await this.openExternal('spotify:');
        for (let waited = 0; !dev && waited < this.deviceWaitMs; waited += 1000) {
          await new Promise((r) => setTimeout(r, 1000));
          dev = await this.device();
        }
        if (!dev) return openIt("(Spotify didn't wake up in time.)");
      }
      const body = kind === 'track' ? { uris: [item.uri] } : { context_uri: item.uri };
      const r = await this.api('PUT', `/me/player/play?device_id=${encodeURIComponent(dev.id)}`, body);
      if (r.status === 204 || r.status === 202 || r.status === 200) return { ok: true, reply: `▶️ Playing "${item.name}" on Spotify${dev.name ? ` (${dev.name})` : ''} 🎧` };
      const reason = (r.json && r.json.error && (r.json.error.reason || r.json.error.message)) || `HTTP ${r.status}`;
      if (r.status === 403 && /premium/i.test(reason)) {
        this.settings.update({ spotifyProduct: 'free' });
        return openIt("(Spotify says this account isn't Premium, so I can't press play.)");
      }
      return openIt(`(Spotify said: ${reason}.)`);
    } catch (err) {
      return openIt(`(${this.friendly(err)})`);
    }
  }

  friendly(err) {
    if (err.code === 'invalid_grant') return 'Spotify logged Shadow out - connect it again in Settings → Music.';
    if (err.name === 'TimeoutError' || /fetch failed|ENOTFOUND|ECONN/i.test(err.message)) return "Can't reach Spotify - is the internet on?";
    return `Spotify hiccup: ${err.message}`;
  }
}

module.exports = { SpotifyLink, CLIENT_ID_RE, DASHBOARD_URL, PORT };
