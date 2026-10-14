'use strict';
/*
 * Shadow - desktop pet.
 * Main process entry: creates the pet window, brain, tray, reminders, calendar and IPC wiring.
 */

const { app, ipcMain, screen, Menu, shell, nativeTheme, powerMonitor, desktopCapturer, globalShortcut, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SELF_TEST = process.argv.includes('--self-test');
if (SELF_TEST) {
  // Run the automated checks in a throwaway profile so your real settings/config are untouched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-selftest-'));
  app.setPath('userData', path.join(dir, 'userData'));
  process.env.SHADOW_CONFIG_DIR = path.join(dir, 'config');
  process.env.SHADOW_TEST_DIR = dir;
}

const paths = require('./paths');
const { Settings } = require('./settings');
const { ConfigStore } = require('./config');
const { ReminderScheduler } = require('./reminders');
const { CalendarSync, GCAL_SETTINGS_URL } = require('./calendar');
const { Updater } = require('./updater');
const { TaskStore, parseCommand, parseDaySpec } = require('./tasks');
const search = require('./search');
const { AppLauncher, parsePcCommand, pcRequests } = require('./apps');
const { WhatsAppControl, parseWhatsAppCommand } = require('./whatsapp');
const { WhatsWeb } = require('./whatsweb');
const { FriendsManager } = require('./friends');
const { MusicControl, parseMusicCommand, musicRequests } = require('./music');
const { PcCare, parseCareCommand } = require('./care');
const { Tutor, parseTutorCommand, bubbleLine } = require('./tutor');
const { TelegramLink } = require('./telegram');
const { SpotifyLink, DASHBOARD_URL: SPOTIFY_DASHBOARD } = require('./spotify');
const { StartupRoutine, parseStartupCommand } = require('./startup');
const { FileShare, parseFileCommand, parseBrowseCommand, parseNavCommand, mb } = require('./files');
const { ExamPlanner, parseExamCommand } = require('./exams');
const { CatchGame, QuizRace, Scores, parseGameCommand } = require('./games');
const { HudData, HudDisplay, parseHudCommand, HOTKEYS, JARVIS_HOTKEYS } = require('./hud');
const { Jarvis, parseJarvisOpen, isScreenRequest, boxToWindow, consoleRules, screenRules } = require('./jarvis');
const { ActivityLog, ReportScheduler, buildBrief, buildDebrief, buildNews, reportText, parseReportCommand } = require('./briefing');
const { NewsFeed, parseNewsCommand } = require('./news');
const { WindowsVoice } = require('./voice');
const { PetWindow } = require('./petWindow');
const { Brain } = require('./brain');
const { createTray } = require('./tray');
const { openChat, openSettings, getChatWindow, getSettingsWindow, openGameLayer, openHudWindow } = require('./windows');
const ai = require('./ai');
const appearance = require('./appearance');

const realSensors = {
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
  cursor: () => screen.getCursorScreenPoint(),
  displayAt: (pt) => screen.getDisplayNearestPoint({ x: Math.round(pt.x), y: Math.round(pt.y) }),
  primary: () => screen.getPrimaryDisplay(),
};

// "Start with Windows" uses Electron's login-item settings (registry Run key, per user).
// It starts Shadow with --startup, so the startup routine (startup.js) knows Windows just started.
const loginItem = {
  opts(old = false) {
    const args = [...(app.isPackaged ? [] : [path.resolve(paths.ROOT)]), ...(old ? [] : ['--startup'])];
    return { path: process.execPath, args };
  },
  /** Entries made by older versions (no --startup) are switched to the new form once. */
  migrate() {
    try {
      if (!app.getLoginItemSettings(this.opts()).openAtLogin && app.getLoginItemSettings(this.opts(true)).openAtLogin) this.set(true);
    } catch {
      /* not supported here */
    }
  },
  get() {
    try {
      return app.getLoginItemSettings(this.opts()).openAtLogin;
    } catch {
      return false;
    }
  },
  set(on) {
    app.setLoginItemSettings({ openAtLogin: !!on, ...this.opts() });
  },
};

const ctx = { SELF_TEST, loginItem, realLoginItem: loginItem, sensors: realSensors, chatHistory: [] };
if (SELF_TEST) ctx.sensors = require('./selftest').makeSensors(realSensors);

function loadMeta() {
  return JSON.parse(fs.readFileSync(path.join(appearance.mainAssetsDir(paths.ASSETS, ctx.settings), 'sprites.json'), 'utf8'));
}

function sheetDataUrl() {
  // Sent as a data: URL so the renderer can read pixels for click-through hit-testing.
  return 'data:image/png;base64,' + fs.readFileSync(path.join(appearance.mainAssetsDir(paths.ASSETS, ctx.settings), 'sprites.png')).toString('base64');
}

function openConfigFolder() {
  if (ctx.stubOpenPath) return ctx.stubOpenPath(paths.configDir());
  return shell.openPath(paths.configDir());
}

function openChatPanel() {
  const { brain, pet } = ctx;
  if (brain.state === 'hidden') brain.command('wake');
  return openChat(pet, { onOpen: () => brain.chatOpened(), onClose: () => brain.chatClosed() });
}

function petMenuTemplate() {
  const { brain } = ctx;
  const items = [];
  if (ctx.updater && ctx.updater.ready) items.push({ label: `✨ Restart to Update (${ctx.updater.state.version})`, click: () => ctx.updater.install() });
  if (brain.activeReminder && !brain.reminderClosing) {
    const later = brain.activeReminder.kind === 'update';
    items.push({ label: later ? 'Update Later' : 'Dismiss Reminder', click: () => brain.dismissReminder('menu') });
  }
  if (items.length) items.push({ type: 'separator' });
  if (ctx.friends) items.push({ label: appearance.isAvengers(ctx.settings) ? 'Avengers, Assemble! ⚡' : 'Call the Gang 🐾', click: () => ctx.friends.callGang() }, { type: 'separator' });
  return [
    ...items,
    { label: 'Sit', click: () => brain.command('sit') },
    { label: 'Sleep', click: () => brain.command('sleep') },
    ...(appearance.isAvengers(ctx.settings) && appearance.mainHero(ctx.settings) === 'ironman' ? [{ label: 'Fly Across Screen', click: () => brain.command('fly') }] : []),
    { label: 'Pounce', click: () => brain.command('pounce') },
    { type: 'separator' },
    { label: 'Chat…', click: () => openChatPanel() },
    ...(ctx.hud ? [{ label: `${appearance.isAvengers(ctx.settings) ? 'Iron Man HUD' : 'HUD'}${ctx.hudKey ? ` (${hudKeyLabel()})` : ''}`, click: () => ctx.hud.show('menu') }] : []),
    ...(ctx.hud ? [{ label: `${consoleName()} Console${ctx.jarvisKey ? ` (${jarvisKeyLabel()})` : ''}`, click: () => ctx.hud.show('menu', { mode: 'jarvis' }) }] : []),
    { label: 'Tuck Away', click: () => brain.command('tuck') },
  ];
}

const hudKeyLabel = () => (HOTKEYS[ctx.settings.get('hudHotkey')] || HOTKEYS.off).label;
const jarvisKeyLabel = () => (JARVIS_HOTKEYS[ctx.settings.get('jarvisHotkey')] || JARVIS_HOTKEYS.off).label;
/** J.A.R.V.I.S. in the Avengers theme, the pet's own name otherwise. */
const consoleName = () => (appearance.isAvengers(ctx.settings) ? 'J.A.R.V.I.S.' : appearance.displayName(ctx.settings).toUpperCase());

function showPetMenu() {
  const { pet } = ctx;
  if (!pet.alive()) return;
  Menu.buildFromTemplate(petMenuTemplate()).popup({ window: pet.win });
}

function settingsPayload() {
  const { position, spotifyRefreshToken, ...s } = ctx.settings.all(); // eslint-disable-line no-unused-vars
  return {
    settings: s,
    spotify: ctx.spotify ? ctx.spotify.info() : null,
    exams: ctx.exams ? ctx.exams.upcoming().map((e) => ({ id: e.id, subject: e.subject, date: e.date, days: e.plan.length, done: e.plan.filter((d) => d.done).length })) : [],
    appearance: appearance.presentation(ctx.settings),
    hud: { key: hudKeyLabel(), bound: !!ctx.hudKey, taken: !!ctx.hudKeyTaken, jarvisKey: jarvisKeyLabel(), jarvisBound: !!ctx.jarvisKey, jarvisTaken: !!ctx.jarvisKeyTaken, consoleName: consoleName() },
    providers: ai.publicProviders(),
    calendar: ctx.calendar ? ctx.calendar.status() : null,
    update: ctx.updater ? ctx.updater.status() : null,
    friends: ctx.friends ? ctx.friends.info() : [],
    telegram: ctx.telegram ? ctx.telegram.info() : null,
    startWithWindows: ctx.loginItem.get(),
    configDir: paths.configDir(),
    settingsFile: paths.settingsFile(),
    version: app.getVersion(),
  };
}

function quit() {
  app.quit();
}

function init() {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  paths.ensureConfig();

  const settings = (ctx.settings = new Settings(paths.settingsFile()));
  // Run original regressions first; the self-test then explicitly exercises both themes.
  if (SELF_TEST) settings.update({ appearance: 'shadow' });
  require('./windows').setAppearance(appearance.displayName(settings), appearance.mainAssetsDir(paths.ASSETS, settings));
  const config = (ctx.config = new ConfigStore(paths.configDir()));
  config.on('error', ({ file, message }) => {
    console.warn(`[config] ${file}: ${message}`);
    const brain = ctx.brain;
    if (brain && !['off', 'hidden'].includes(brain.state) && !brain.activeReminder) {
      brain.say(`Prince, ${file} has a typo 😾 I'm keeping the last good version. (${message.slice(0, 70)})`, { ms: 8000 });
    }
  });
  config.on('warning', ({ file, warnings }) => console.warn(`[config] ${file}: ${warnings.join('; ')}`));
  config.on('reminders', (list) => console.log(`[config] reminders loaded: ${list.length}`));
  config.start();

  let meta = (ctx.meta = loadMeta());
  const pet = (ctx.pet = new PetWindow({ scale: settings.get('scale'), isolated: SELF_TEST, title: appearance.displayName(settings) }));
  const brain = (ctx.brain = new Brain({ pet, settings, config, meta, sensors: ctx.sensors }));
  pet.create();

  // brain -> renderer
  brain.on('anim', (a) => pet.send('pet:anim', a));
  brain.on('bubble', (b) => pet.send('pet:bubble', b));
  brain.on('bubble-hide', () => pet.send('pet:bubble-hide'));
  brain.on('visibility', (visible) => {
    if (!pet.alive()) return;
    pet.tucked = !visible;
    if (visible) {
      pet.send('pet:resume');
      pet.win.showInactive();
      pet.win.setBounds(pet.bounds());
      pet.win.setAlwaysOnTop(true, 'screen-saver');
    } else {
      pet.send('pet:pause'); // renderer stops its animation loop while tucked away
      pet.setInteractive(false);
      pet.win.hide();
    }
  });

  // Other "always on top" apps that get activated later would cover the pet; quietly
  // re-assert our spot at the top of the always-on-top band every few seconds.
  setInterval(() => {
    if (pet.alive() && !pet.tucked && pet.win.isVisible() && !brain.dragging) pet.win.moveTop();
  }, 4000);

  // tell the renderer when the panther crosses onto another monitor (for bubble placement)
  let lastDisplayId = null;
  const syncDisplay = (force = false) => {
    const d = pet.display();
    if (force || d.id !== lastDisplayId) {
      lastDisplayId = d.id;
      pet.send('pet:display', { workArea: d.workArea });
    }
  };
  const moveTo = pet.moveTo.bind(pet);
  pet.moveTo = (x, y) => {
    moveTo(x, y);
    syncDisplay();
  };

  // renderer -> main
  const fromPet = (e) => pet.alive() && e.sender === pet.win.webContents;
  const validPt = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  // Shadow's friends (friends.js) use the same renderer in their own windows
  const friends = (ctx.friends = new FriendsManager({ settings, brain, pet, assets: paths.ASSETS, isolated: SELF_TEST }));
  const friendOf = (e) => friends.forSender(e.sender);
  const friendMenu = (f) =>
    Menu.buildFromTemplate([
      { label: appearance.friendLabel(f.def), enabled: false },
      { type: 'separator' },
      { label: appearance.isAvengers(settings) ? 'Avengers, Assemble! ⚡' : 'Call the Gang 🐾', click: () => friends.callGang() },
      { label: `Send ${f.def.name} Home`, click: () => f.leave() },
      { label: `Chat with ${appearance.displayName(settings)}…`, click: () => openChatPanel() },
    ]).popup({ window: f.win.win });
  ipcMain.on('pet:ready', (e) => {
    if (!fromPet(e)) {
      const f = friendOf(e);
      if (f) f.onReady();
      return;
    }
    pet.send('pet:init', {
      meta,
      title: appearance.displayName(settings),
      sheet: sheetDataUrl(),
      scale: settings.get('scale'),
      workArea: pet.display().workArea,
      appearance: settings.get('appearance'),
      test: SELF_TEST,
      debug: !!process.env.SHADOW_DEBUG,
    });
    if (brain.state === 'off') {
      brain.start();
      friends.start();
      syncDisplay(true);
      pet.win.showInactive();
      if (ctx.onStarted) ctx.onStarted();
    } else {
      // the page was reloaded (crash/freeze recovery): give it back what it was showing
      if (brain.anim) pet.send('pet:anim', { name: brain.anim, facing: brain.facing });
      if (brain.bubble) pet.send('pet:bubble', brain.bubble);
      if (brain.state === 'hidden') pet.send('pet:pause');
    }
  });
  const onFriend = (fn) => (e, ...a) => {
    const f = friendOf(e);
    if (f) fn(f, ...a);
  };
  ipcMain.on('pet:interactive', (e, on) => (fromPet(e) ? pet.setInteractive(on) : onFriend((f) => f.win.setInteractive(on))(e)));
  ipcMain.on('pet:click', (e) => (fromPet(e) ? brain.click() : onFriend((f) => f.clicked())(e)));
  ipcMain.on('pet:dblclick', (e) => (fromPet(e) ? brain.dblclick() : onFriend((f) => f.playdate(3000))(e)));
  ipcMain.on('pet:ctrl-click', (e) => (fromPet(e) || friendOf(e)) && openChatPanel());
  ipcMain.on('pet:context-menu', (e) => (fromPet(e) ? showPetMenu() : onFriend(friendMenu)(e)));
  // Press & drag: follow the real cursor from here while the button is held (a non-focusable
  // window gets no mouse-move events mid-press on Windows). Polls only during a press.
  // A press must always end: if Windows swallows the button-up (released off-screen or outside the
  // window), the next press, a timeout or "Unstick Shadow" closes it. A press or drag left open used
  // to freeze Shadow for good - every click ignored and the hover check switched off.
  let press = null;
  const endPress = (tellPage = true) => {
    if (!press) {
      if (brain.dragging) brain.dragEnd();
      return false;
    }
    clearInterval(press.timer);
    const dragged = press.dragging;
    press = null;
    if (dragged) brain.dragMove(ctx.sensors.cursor());
    if (brain.dragging) brain.dragEnd();
    if (tellPage) pet.send('pet:press-reset');
    return dragged;
  };
  ipcMain.on('pet:press-start', (e, p) => {
    if (!fromPet(e) || !validPt(p)) return;
    endPress(false);
    const cur = { start: { x: p.x, y: p.y }, ctrl: !!p.ctrl, dragging: false, since: Date.now() };
    cur.timer = setInterval(() => {
      if (Date.now() - cur.since > (ctx.pressMaxMs || 20000)) return endPress();
      const c = ctx.sensors.cursor();
      if (!cur.dragging) {
        if (cur.ctrl || Math.hypot(c.x - cur.start.x, c.y - cur.start.y) <= 4) return;
        cur.dragging = true;
        brain.dragStart(cur.start);
      }
      brain.dragMove(c);
    }, 16);
    press = cur;
  });
  ipcMain.handle('pet:press-end', (e) => (fromPet(e) ? { dragged: endPress(false) } : { dragged: false }));
  // Hover check that doesn't depend on Windows forwarding mouse moves (see pet.js onCursor).
  // Only talks to the renderer while the cursor is over the pet's window, so it costs ~nothing.
  const hover = (w) => {
    const c = ctx.sensors.cursor();
    const b = w.win.getBounds(); // where the window really is, not where we think it is
    const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
    if (inside || w.cursorWasInside || w.interactive) {
      w.send('pet:cursor', { inside, x: c.x - b.x, y: c.y - b.y, interactive: w.interactive });
    }
    w.cursorWasInside = inside;
  };
  let strayDrag = 0;
  setInterval(() => {
    if (press) return;
    if (brain.dragging) {
      // dragging with no mouse button held behind it is a leftover - finish it
      if (!strayDrag) strayDrag = Date.now();
      else if (Date.now() - strayDrag > 3000) endPress();
      return;
    }
    strayDrag = 0;
    if (pet.alive() && !pet.tucked) hover(pet);
    friends.windows().forEach(hover); // the friends get the same fix
  }, 60);
  // Windows can move a window on its own (screen off/on, sleep, monitor or DPI changes) while Shadow
  // sits still - then he'd be drawn in one place but clickable in another. Put it back.
  const keepInPlace = (w) => {
    if (!w.alive() || !w.win.isVisible() || w.win.isMinimized()) return;
    const want = w.bounds();
    const got = w.win.getBounds();
    if (['x', 'y', 'width', 'height'].some((k) => Math.abs(want[k] - got[k]) > 4)) w.win.setBounds(want);
  };
  setInterval(() => {
    if (press || brain.dragging) return;
    if (pet.alive() && !pet.tucked) keepInPlace(pet);
    friends.windows().forEach(keepInPlace);
  }, 1000);
  // after sleep / unlock / screen changes: drop any half-finished press and start clean
  const rearm = () => {
    endPress();
    for (const w of [pet, ...friends.windows()]) {
      if (!w.alive()) continue;
      w.send('pet:press-reset');
      w.setInteractive(false); // the hover check turns it back on the moment the cursor is over him
      w.cursorWasInside = false;
      keepInPlace(w);
    }
  };
  powerMonitor.on('unlock-screen', rearm);
  powerMonitor.on('resume', rearm);
  // The pet page itself: if it crashes or stops answering, load it again (Shadow carries on).
  pet.lastBeat = Date.now();
  ipcMain.on('pet:heartbeat', (e) => fromPet(e) && (pet.lastBeat = Date.now()));
  const reloadPet = () => {
    if (!pet.alive()) return;
    pet.lastBeat = Date.now();
    endPress(false);
    pet.setInteractive(false);
    if (!pet.win.webContents.isCrashed()) pet.win.webContents.forcefullyCrashRenderer();
    pet.win.webContents.reload();
  };
  ctx.reloadPet = reloadPet;
  let lastWatch = Date.now();
  setInterval(() => {
    const now = Date.now();
    const slept = now - lastWatch > 15000; // the PC was asleep - give the page a moment first
    lastWatch = now;
    if (slept || !pet.alive() || pet.tucked) return void (pet.lastBeat = now);
    if (now - pet.lastBeat > (ctx.heartbeatMaxMs || 30000)) {
      console.warn('[pet] page stopped answering - reloading it');
      reloadPet();
    }
  }, 5000);
  // tray -> "Unstick Shadow": everything above at once, plus a fresh page and a spot on screen
  ctx.rescue = () => {
    rearm();
    if (brain.state === 'hidden') brain.command('wake');
    brain.displaysChanged();
    reloadPet();
    pet.win.showInactive();
    pet.win.setAlwaysOnTop(true, 'screen-saver');
    pet.win.moveTop();
  };

  ipcMain.on('pet:bubble-click', (e) => (fromPet(e) ? brain.bubbleClicked() : onFriend((f) => f.win.send('pet:bubble-hide'))(e)));
  ipcMain.on('pet:test-frame', (e, info) => fromPet(e) && ctx.onTestFrame && ctx.onTestFrame(info));

  // chat panel -> ai.js (all AI provider logic lives there)
  const aiContext = (over = {}) => {
    const provider = over.provider || settings.get('aiProvider');
    return {
      provider,
      model: over.model !== undefined ? over.model : settings.get('aiModel'),
      baseUrl: over.baseUrl !== undefined ? over.baseUrl : settings.get('aiBaseUrl'),
      apiKey: over.apiKey !== undefined ? over.apiKey : settings.get('apiKeys')[provider] || '',
      petName: appearance.displayName(settings),
      personality: appearance.personality(settings, config.personality),
      // calendar text for the chat ('' = not connected); left out entirely if Prince switched it off
      ...(settings.get('calendarInChat') && ctx.calendar ? { calendar: ctx.calendar.chatContext() } : {}),
      tasks: [ctx.tasks ? ctx.tasks.chatContext() : '', ctx.exams ? ctx.exams.chatContext() : ''].filter(Boolean).join('\n'),
    };
  };
  ctx.aiContext = aiContext;
  const chatInfo = () => {
    const c = aiContext();
    const p = ai.PROVIDERS[c.provider];
    return { petName: c.petName, provider: p.label, ready: !p.needsKey || !!c.apiKey, appearance: appearance.presentation(settings) };
  };
  ipcMain.handle('chat:info', chatInfo);
  // links Shadow may open: our own search URLs and the sources it just showed in chat
  const openUrl = (url) => (ctx.stubOpenExternal ? ctx.stubOpenExternal(url) : shell.openExternal(url));
  const sourceUrls = new Set();
  const searchOpts = () => ({ tavilyKey: settings.get('searchKey'), ...(ctx.searchBases || {}) });
  const showSources = (results) => {
    const list = results.slice(0, 3).map((r) => ({ title: r.title, url: r.url }));
    list.forEach((r) => sourceUrls.add(r.url));
    return list;
  };

  /** "google …", "youtube …", "open whatsapp", "wiki …", "search for …" */
  async function runSearchCommand(cmd, text, history) {
    if (cmd.type === 'open' || cmd.type === 'open-site') {
      openUrl(cmd.url);
      return { text: cmd.type === 'open' ? `Opening ${cmd.label} for "${cmd.query}" 🔍` : `Opening ${cmd.name} 🐾` };
    }
    if (!settings.get('webSearch')) return { text: 'Internet search is switched off, Prince. Turn it on in Settings → Internet search.' };
    let found;
    try {
      found = await search.webSearch(cmd.query, cmd.type === 'wiki' ? { ...searchOpts(), tavilyKey: '' } : searchOpts());
    } catch (err) {
      return { text: search.friendly(err, { hasKey: !!settings.get('searchKey') }) };
    }
    if (!found.results.length) return { text: `Couldn't find anything for "${found.query}", Prince 🤔` };
    if (cmd.type === 'wiki') {
      const first = found.results[0];
      const sentences = first.content.match(/[^.!?]+[.!?]+/g) || [first.content];
      return { text: sentences.slice(0, 2).join('').trim().slice(0, 300), sources: showSources(found.results) };
    }
    const c = aiContext();
    const p = ai.PROVIDERS[c.provider];
    if (p.needsKey && !c.apiKey) {
      // no AI brain: just show the top results
      return { text: `Top results: ${found.results.slice(0, 3).map((r, i) => `${i + 1}. ${r.title}`).join(' · ')}`, sources: showSources(found.results) };
    }
    const answer = await ai.chat(text, { ...c, tasks: '', searchResults: search.resultsForAi(found), history: history.slice(-20) });
    return { text: search.stripCommands(answer) || 'The internet had nothing useful on that, Prince 🤔', sources: showSources(found.results) };
  }

  ipcMain.on('chat:open-link', (_e, url) => {
    if (sourceUrls.has(url) && /^https?:\/\//i.test(url)) openUrl(url);
  });
  ipcMain.handle('search:test', async (_e, key) => {
    const k = typeof key === 'string' ? key.trim().slice(0, 200) : '';
    try {
      const found = await search.webSearch(k ? 'latest news India today' : 'Black panther', { ...searchOpts(), tavilyKey: k });
      return { ok: true, engine: found.engine, count: found.results.length, first: found.results[0] ? found.results[0].title : '' };
    } catch (err) {
      return { ok: false, kind: err.kind || 'error', message: search.friendly(err, { hasKey: !!k }) };
    }
  });

  // ---- opening apps / folders / settings + lock, sleep, screenshot, volume, brightness (apps.js)
  const apps = (ctx.apps = new AppLauncher({ shell, getPath: (k) => app.getPath(k), openExternal: openUrl, hooks: ctx.appHooks || {} }));
  // WhatsApp Web engine (whatsweb.js): linked once by QR in Settings, then sends in the background
  const waweb = (ctx.waweb = new WhatsWeb({ settings, dataPath: path.join(app.getPath('userData'), 'whatsapp-web'), hooks: ctx.waWebHooks || {} }));
  async function waWebView() {
    const s = waweb.status();
    let qrImage = '';
    if (s.qr) {
      try {
        qrImage = await require('qrcode').toDataURL(s.qr, { margin: 1, width: 264, color: { dark: '#000000', light: '#ffffff' } });
      } catch {
        /* the text is still there for the next refresh */
      }
    }
    return { state: s.state, me: s.me, error: s.error, linked: s.linked, available: waweb.available(), qrImage };
  }
  waweb.on('status', async () => {
    const w = getSettingsWindow();
    if (w) w.webContents.send('waweb:status', await waWebView());
  });
  ipcMain.handle('waweb:status', () => waWebView());
  /** LINK WHATSAPP (Settings or "link whatsapp" in chat) - linking means you want WhatsApp automation on. */
  async function linkWhatsApp() {
    if (!settings.get('whatsappAutomation')) settings.update({ whatsappAutomation: true });
    await waweb.start();
  }
  ipcMain.handle('waweb:link', async () => {
    await linkWhatsApp();
    return waWebView();
  });
  ipcMain.handle('waweb:unlink', async () => {
    await waweb.unlink();
    return waWebView();
  });
  const waWebWanted = () => !SELF_TEST && settings.get('waWebLinked') && settings.get('whatsappAutomation') && waweb.available();
  if (waWebWanted()) setTimeout(() => waWebWanted() && waweb.start(), 20 * 1000); // reconnect once Shadow has settled

  const whatsapp = (ctx.whatsapp = new WhatsAppControl({ settings, web: waweb, onLink: () => {
    openSettings();
    linkWhatsApp();
  }, launch: async () => {
    const matches = (await apps.refresh()).filter(a => /^whatsapp(?: beta)?$/i.test(a.name));
    if (matches.length !== 1) return false;
    return (await apps.start(matches[0])).startsWith('Opening');
  } }));
  /** App sends and calls: Shadow's always-on-top chat panel and HUD step out of WhatsApp's way meanwhile. */
  async function runWhatsApp(cmd) {
    const onScreen = cmd.type === 'call' || (cmd.type === 'send' && whatsapp.route() === 'app'); // WhatsApp Web sends need no screen
    if (!onScreen || !whatsapp.enabled()) return whatsapp.run(cmd);
    const chat = getChatWindow();
    if (chat) chat.setAlwaysOnTop(false);
    if (ctx.hud && ctx.hud.visible) ctx.hud.hide('whatsapp');
    ctx.whatsappAside = true;
    try {
      return await whatsapp.run(cmd);
    } finally {
      ctx.whatsappAside = false;
      if (chat && !chat.isDestroyed()) chat.setAlwaysOnTop(true);
    }
  }
  ipcMain.handle('whatsapp:check', () => whatsapp.check());
  // Settings → WhatsApp contacts: add / remove a saved number
  ipcMain.handle('whatsapp:contacts', (_e, cmd = {}) => {
    const type = ['contact-add', 'contact-remove'].includes(cmd && cmd.type) ? cmd.type : 'contacts';
    const reply = whatsapp.editContacts({ type, name: String((cmd && cmd.name) || '').slice(0, 80), phone: String((cmd && cmd.phone) || '').slice(0, 30) });
    return { reply, list: whatsapp.contacts() };
  });
  ipcMain.handle('whatsapp:stop', () => whatsapp.stop());
  if (apps.windows) setTimeout(() => apps.refresh(), 8000); // read the Start menu once Shadow has settled
  const screenshotHelpers = {
    // Shadow and the chat panel step out of the picture for a moment
    beforeScreenshot: async () => {
      ctx.screenshotHidden = [pet.win, getChatWindow(), ...friends.windows().map((w) => w.win), ctx.hud && ctx.hud.window()].filter((w) => w && !w.isDestroyed() && w.isVisible());
      ctx.screenshotHidden.forEach((w) => w.hide());
      await new Promise((r) => setTimeout(r, 250));
    },
    afterScreenshot: () => {
      (ctx.screenshotHidden || []).forEach((w) => !w.isDestroyed() && w.showInactive());
      ctx.screenshotHidden = null;
    },
    capture: async () => {
      const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) },
      });
      const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
      if (!src) throw new Error('no screen found');
      return src.thumbnail.toPNG();
    },
  };
  /** Runs a parsed PC command; returns Shadow's reply, or null if it isn't one right now. */
  async function runPcCommand(cmd) {
    if (cmd.type === 'cancel') return apps.cancel();
    if (cmd.type === 'choose') return apps.choose(cmd.n);
    if (!settings.get('pcControl')) return 'Opening apps and PC controls are switched off, Prince. Turn them on in Settings → Behaviour.';
    const out = cmd.type === 'open' ? await apps.open(cmd.target) : await apps.system(cmd, screenshotHelpers);
    // Bolt the monkey handles launches (not failures, questions or the countdown before sleep)
    if (out && /^(Opening|Locking|Snip|📸|Volume|Toggled|Brightness)/.test(out)) {
      const line = { lock: '🔒 Locked tight!', screenshot: '📸 Click!', snip: '✂️ Snip snip!', mute: '🔇 Shh!' }[cmd.action] || (cmd.type === 'open' ? '⚡ Launching!' : '⚡ Done!');
      friends.quickJob('bolt', line, 3500);
    }
    return out;
  }

  // ---- Tempo the penguin: music (music.js)
  // Prince's own Spotify account (spotify.js) - "play <song>" starts it there once connected
  const spotify = (ctx.spotify = new SpotifyLink({ settings, openExternal: (u) => openUrl(u) }));
  ipcMain.handle('spotify:info', () => spotify.info());
  ipcMain.handle('spotify:connect', async (_e, clientId) => {
    const r = await spotify.connect(typeof clientId === 'string' ? clientId : '');
    if (r.ok) {
      settings.update({ musicService: 'spotify' }); // that's why he connected it
      if (!brain.activeReminder && brain.state !== 'hidden') brain.say(`🎧 Spotify connected${r.user ? ` (${r.user})` : ''}! Say "play kesariya" 🐧`, { ms: 6000 });
    }
    return r;
  });
  ipcMain.handle('spotify:disconnect', () => {
    const info = spotify.disconnect();
    if (settings.get('musicService') === 'spotify') settings.update({ musicService: 'youtube' });
    return info;
  });
  const music = (ctx.music = new MusicControl({
    openExternal: (u) => openUrl(u),
    spotify,
    service: () => settings.get('musicService'),
    nudgeMs: SELF_TEST ? 0 : 6000,
    hooks: ctx.musicHooks || {},
  }));
  const TEMPO_LINES = { play: '▶️ Hit it!', pause: '⏸️ Pausing!', next: '⏭️ Next track!', previous: '⏮️ Rewind!', status: '🎵 Let me listen…', search: '🎧 Digging the crates…' };
  async function runMusic(cmd) {
    const done = friends.job('tempo', TEMPO_LINES[cmd.action]);
    if (cmd.action === 'search' && ctx.activity) ctx.activity.note('song', cmd.query);
    let out;
    try {
      out = await music.run(cmd);
    } catch (err) {
      out = `The music didn't listen to me, Prince (${err.message}).`;
    }
    done();
    return out;
  }
  // Tempo dances while music is playing (when he's on screen)
  setInterval(async () => {
    const t = friends.get('tempo');
    if (SELF_TEST || t.state !== 'here' || t.jobs || !music.available) return;
    t.dancing = await music.playing();
  }, 30 * 1000);

  // ---- Zen the turtle: PC care (care.js)
  const care = (ctx.care = new PcCare({ getPath: (k) => app.getPath(k), logFile: path.join(app.getPath('userData'), 'tidy-log.json'), hooks: ctx.careHooks || {} }));
  care.on('alert', (a) => {
    if (!settings.get('pcCare')) return;
    friends.quickJob('zen', '🩺 Heads up!', 6000);
    if (a.sticky) brain.reminder({ time: '', kind: 'care', key: `care|${a.key}`, icon: '🐢', head: 'PC CARE', hint: 'click to close ✓', message: a.text });
    else if (!brain.activeReminder && brain.state !== 'hidden') brain.say(a.text, { ms: 6000 });
    if (!a.sticky && ctx.telegram && ctx.sensors.idleSeconds() > 120) ctx.telegram.notify(a.text); // sticky ones go via reminder-start
  });
  if (!SELF_TEST) care.start();
  async function runCare(cmd) {
    friends.quickJob('zen', cmd.type === 'report' ? '🩺 Checkup time!' : cmd.type === 'undo' ? '↩️ Putting it back…' : '🧹 Let me look…', 5000);
    if (cmd.type === 'report') return care.report();
    if (cmd.type === 'undo') return care.undo();
    return care.tidy();
  }

  // ---- Sage the owl: tutor (tutor.js)
  const tutor = (ctx.tutor = new Tutor());
  let sageDone = null;
  const endClass = (line) => {
    if (sageDone) sageDone(line);
    sageDone = null;
  };
  setInterval(() => sageDone && !tutor.active() && endClass('Class over - good job! 🦉'), 60 * 1000);
  /** One tutor turn (a new lesson/quiz, or Prince's reply inside one). Returns the reply. */
  async function tutorTurn(text, cmd, history) {
    if (cmd && cmd.type === 'stop') {
      const was = tutor.stop();
      endClass('Class dismissed! 🦉');
      return was ? 'Class dismissed! Great work today, Prince 🦉' : "There's no class going on, Prince.";
    }
    const c = aiContext();
    const p = ai.PROVIDERS[c.provider];
    if (p.needsKey && !c.apiKey) return `${friends.get('sage').def.name} needs an AI brain to teach, Prince - add a free key in Settings → AI Brain (2 minutes) ${friends.get('sage').def.icon || '🦉'}`;
    if (cmd) {
      tutor.start(cmd);
      if (!sageDone) sageDone = friends.job('sage', cmd.type === 'quiz' ? '📝 Pop quiz time!' : '📚 Class is on!');
      history[history.length - 1].text = tutor.firstMessage(cmd); // what the AI should answer
    }
    tutor.touch();
    const answer = await ai.chat(history[history.length - 1].text, { ...c, ...tutor.context(appearance.isAvengers(settings) ? friends.get('sage').def.name : null), history: history.slice(-20) });
    return search.stripCommands(answer) || 'Hoo? Ask me that again, Prince 🦉';
  }
  /** Sage says tutor replies in his own bubble (Shadow just listens). */
  function tutorBubble(reply) {
    const sage = friends.get('sage');
    const icon = sage.def.icon || '🦉';
    if (friends.enabled('sage') && sage.state !== 'away') sage.sayWhenHere(`${icon} ${bubbleLine(reply)}`, 9000);
    else brain.chatReply(`${icon} ${bubbleLine(reply)}`);
  }

  /** "call the gang", "send the gang home", "call atlas" */
  function gangCommand(text) {
    const l = text.trim().toLowerCase().replace(/[?.!]+$/, '');
    if (/^(?:call|bring|summon|show)(?: out)? (?:the |my )?(?:gang|friends|everyone|squad|team|avengers)(?: out)?$|^avengers[, ]+assemble$/.test(l)) {
      const n = friends.callGang();
      return n ? (appearance.isAvengers(settings) ? 'Avengers, assemble! ⚡' : 'Gang, assemble! 🐾') : 'All my friends are switched off, Prince. Turn them on in Settings → Friends.';
    }
    if (/^(?:send|tell) (?:the |my )?(?:gang|friends|everyone|avengers|team) (?:home|away)$|^(?:bye|goodbye) (?:gang|friends|everyone|avengers|team)$/.test(l)) {
      friends.sendHome();
      return appearance.isAvengers(settings) ? 'Stand down, Avengers! 👋' : 'Bye gang! 👋';
    }
    const m = /^(?:call|bring|summon) (.+)$/.exec(l);
    if (m) {
      if (appearance.isAvengers(settings) && appearance.ROSTER[appearance.mainHero(settings)].aliases.includes(m[1])) {
        if (brain.state === 'hidden') brain.command('wake');
        else if (brain.state === 'sleep') brain.wake('command');
        return `${appearance.displayName(settings)} is here, Prince! ${appearance.presentation(settings).icon}`;
      }
      const f = friends.list.find(f => f.id === m[1] || (appearance.isAvengers(settings) && f.def.aliases.includes(m[1])));
      if (!f) return null;
      if (!friends.enabled(f.id)) return `${f.def.name} is switched off, Prince. Turn them on in Settings → Friends.`;
      f.stayUntil = Date.now() + 30000;
      f.appear(() => f.clicked());
      setTimeout(() => !f.jobs && friends.afterJob(f), 32000);
      return `${f.def.name}! Come here 🐾`;
    }
    return null;
  }

  // ---- Sage's exam planner (exams.js)
  const exams = (ctx.exams = new ExamPlanner({ file: path.join(app.getPath('userData'), 'exams.json'), tutor: () => friends.get('sage').def.name }));
  ctx.examTimer = setInterval(() => {
    for (const r of exams.due(settings.get('examStudyTime'))) {
      friends.quickJob('sage', '📚 Study time!', 6000);
      brain.reminder({ time: '', kind: 'exam', key: r.key, icon: '📚', head: 'STUDY TIME', hint: 'click when you start ✓', message: r.message });
    }
  }, SELF_TEST ? 1000 : 30 * 1000);

  // ---- mini-games (games.js)
  const scores = (ctx.scores = new Scores(path.join(app.getPath('userData'), 'games.json')));
  const catchGame = (ctx.catchGame = new CatchGame({ brain, pet, sensors: ctx.sensors, scores, openLayer: (wa) => openGameLayer(wa, pet) }));
  brain.on('state', (st) => catchGame.running() && st !== 'game' && catchGame.stop('interrupted')); // reminder, drag, tuck...
  const race = (ctx.race = new QuizRace({ scores }));
  let raceDone = null; // Sage's job while a race runs
  const raceEnded = () => {
    if (race.active() || !raceDone) return;
    raceDone('GG! 🏁');
    raceDone = null;
  };
  /** A line that arrives on its own (Sage buzzing in) into the chat panel. */
  const pushChat = (text) => {
    ctx.chatHistory.push({ role: 'pet', text });
    const w = getChatWindow();
    if (w) w.webContents.send('chat:push', { text });
  };
  async function runGame(cmd, origin) {
    if (cmd.type === 'menu') return '🎮 Pick a game: "catch the treat" (move your mouse - Shadow catches falling treats) or "quiz race" (beat Sage to the answers - try "quiz race on planets"). "my high scores" shows your records.';
    if (cmd.type === 'scores') return scores.text();
    if (cmd.type === 'stop') {
      const a = catchGame.stop('stopped');
      const b = race.stop();
      raceEnded();
      return a || b || 'There\'s no game running, Prince. Say "catch the treat" or "quiz race" 🎮';
    }
    if (cmd.type === 'catch') {
      if (origin === 'phone') return 'Catch the treat is played with the mouse on your PC, Prince 🖱️ Try "quiz race" from here!';
      ctx.activity.note('game', 'Catch the treat');
      return catchGame.start();
    }
    ctx.activity.note('game', `Quiz race${cmd.topic ? ` on ${cmd.topic}` : ''}`);
    const c = aiContext();
    const p = ai.PROVIDERS[c.provider];
    const askAi = p.needsKey && !c.apiKey ? null : (prompt) => ai.chat(prompt, { ...c, history: [] });
    const deliver =
      origin === 'phone'
        ? (t) => tg.owner() && tg.send(tg.owner(), t).catch(() => {})
        : (t) => {
            pushChat(t);
            brain.chatReply(t);
          };
    if (!raceDone) raceDone = friends.job('sage', '🏁 Race on!');
    return race.start({
      topic: cmd.topic,
      askAi,
      push: (t) => {
        deliver(t);
        raceEnded();
      },
    });
  }

  // ---- files between the phone and this PC (files.js + telegram.js)
  const files = (ctx.files = new FileShare({
    getPath: (k) => app.getPath(k),
    screenshotsDir: () => apps.screenshotsDir(),
    scope: () => settings.get('phoneFilesScope'), // only ever changed in Settings on the PC
    hooks: ctx.fileHooks || {},
  }));
  // the file index is built in the background once the phone is set up, so "send me …" is quick
  if (!SELF_TEST) {
    setTimeout(() => settings.get('phoneFiles') && settings.get('telegramChatId') && files.ensureIndex(), 90 * 1000);
    settings.on('change', (_all, changed) => changed.includes('phoneFilesScope') && settings.get('phoneFiles') && files.ensureIndex(true));
  }
  /** "send me notes.pdf": from the phone the file comes back as the reply; typed here it goes to the paired phone. */
  async function sendFile(r, origin) {
    if (!r.document) return { text: r.text };
    friends.quickJob('dash', '📤 Delivering!', 4000);
    if (origin === 'phone') return { text: r.text, document: r.document, temp: r.temp };
    const drop = () => r.temp && fs.rm(r.document, { force: true }, () => {});
    if (!settings.get('telegramEnabled') || !tg.owner() || !tg.running) {
      drop();
      return { text: 'Your phone isn\'t connected yet, Prince 📱 Set it up once in Settings → Phone (Telegram, about 3 minutes), then "send notes.pdf to my phone" works.' };
    }
    try {
      await tg.sendFileToOwner(r.document, r.text);
    } catch (err) {
      return { text: `Couldn't send ${r.name}: ${err.message}` };
    } finally {
      drop();
    }
    return { text: `📤 Sent ${r.name} to your phone ✓` };
  }

  // ---- startup routine (startup.js)
  const startup = (ctx.startup = new StartupRoutine({ settings, loginOn: () => ctx.loginItem.get() }));
  const OK_STEP = /^(?:Opening|▶️|🎧)/;
  async function runStartupRoutine(why = 'asked') {
    if (!startup.items().length) return startup.describe();
    const show = (t, ms) => !brain.activeReminder && brain.state !== 'hidden' && brain.say(t, { ms });
    if (why !== 'asked') show(`🌅 ${why === 'wake' ? 'Welcome back' : 'Hey'} Prince! Setting up your stuff…`, 5000);
    const results = await startup.run(
      async (step) => {
        if (/^play /i.test(step)) {
          const m = parseMusicCommand(step);
          return m ? runMusic(m) : 'skipped';
        }
        const c = parsePcCommand(step);
        return c && c.type === 'open' ? (await runPcCommand(c)) || 'skipped' : 'skipped';
      },
      { gapMs: SELF_TEST ? 50 : 1200 }
    );
    const ok = results.filter((r) => OK_STEP.test(r.reply)).map((r) => r.step.replace(/^open /, '').replace(/^play /, '🎵 '));
    const bad = results.filter((r) => !OK_STEP.test(r.reply)).map((r) => r.step);
    const line = `🌅 Startup routine done: ${ok.length ? ok.join(', ') : 'nothing opened'}${bad.length ? ` · couldn't: ${bad.join(', ')}` : ''}`;
    if (why !== 'asked') {
      show(line, 7000);
      setTimeout(() => ctx.tryBriefing && ctx.tryBriefing(), 8000); // then the day's briefing
    }
    return line;
  }
  ctx.runStartupRoutine = runStartupRoutine;
  ipcMain.handle('startup:edit', (_e, cmd = {}) => {
    const ok = cmd && ['add', 'remove', 'clear'].includes(cmd.type);
    const reply = ok
      ? startup.edit({ type: cmd.type, items: Array.isArray(cmd.items) ? cmd.items.map(String).slice(0, 10) : [], item: String(cmd.item || '').slice(0, 90) })
      : '';
    return { reply, items: startup.items() };
  });
  ipcMain.handle('startup:run', () => runStartupRoutine('asked'));
  ipcMain.handle('exams:add', (_e, form = {}) => {
    const reply = exams.addFromForm({ subject: String(form.subject || ''), date: String(form.date || ''), topics: String(form.topics || '') });
    return { reply, exams: settingsPayload().exams };
  });
  // Settings → Repeating tasks (tasks.js): the same as "every day: …" / "stop repeating 2" in the chat
  const repeatList = () => (ctx.tasks ? ctx.tasks.repeats().map((r) => ({ id: r.id, todo: r.todo, label: ctx.tasks.describeRepeat(r) })) : []);
  ipcMain.handle('repeats:list', () => repeatList());
  ipcMain.handle('repeats:add', (_e, form = {}) => {
    const d = parseDaySpec(String((form && form.days) || ''));
    const time = typeof form.time === 'string' && /^\d{2}:\d{2}$/.test(form.time) ? form.time : '';
    const reply = ctx.tasks.run(d ? { type: 'repeat-add', todo: form.kind !== 'remind', text: String(form.text || '').slice(0, 200), days: d.days, time } : { type: 'repeat-error', error: 'days' });
    return { reply, list: repeatList() };
  });
  ipcMain.handle('repeats:remove', (_e, id) => {
    const i = ctx.tasks.repeats().findIndex((r) => r.id === String(id));
    if (i >= 0) ctx.tasks.stopRepeat({ n: i + 1 });
    return repeatList();
  });
  ipcMain.handle('exams:remove', (_e, id) => {
    exams.remove(String(id));
    return settingsPayload().exams;
  });
  // Windows just started (--startup), or the PC woke up after 4+ hours: run it once Prince is at the PC
  const whenActive = (fn, giveUpMs = 30 * 60 * 1000) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (Date.now() - t0 > giveUpMs) return clearInterval(iv);
      if (ctx.sensors.idleSeconds() <= 5 && !['off', 'hidden'].includes(brain.state)) {
        clearInterval(iv);
        fn();
      }
    }, 3000);
  };
  if (!SELF_TEST) {
    ctx.loginItem.migrate();
    if (process.argv.includes('--startup') && startup.items().length) setTimeout(() => whenActive(() => runStartupRoutine('boot')), 15000);
  }
  let suspendedAt = 0;
  powerMonitor.on('suspend', () => (suspendedAt = Date.now()));
  powerMonitor.on('resume', () => {
    const long = suspendedAt && Date.now() - suspendedAt >= 4 * 60 * 60 * 1000;
    suspendedAt = 0;
    if (long && settings.get('startupOnWake') && startup.items().length) whenActive(() => runStartupRoutine('wake'));
  });

  ipcMain.handle('chat:ask', (_e, message) => handleMessage(message, ctx.chatHistory));
  ctx.handleMessage = handleMessage;

  // ---- control from the phone through your own Telegram bot (telegram.js)
  ctx.tgHistory = [];
  const tg = (ctx.telegram = new TelegramLink({
    settings,
    apiBase: ctx.telegramBase || 'https://api.telegram.org',
    handle: async (text) => {
      const shot = apps.lastScreenshot;
      const r = await handleMessage(text, ctx.tgHistory, 'phone');
      if (ctx.tgHistory.length > 40) ctx.tgHistory.splice(0, ctx.tgHistory.length - 40);
      // "take a screenshot" from the phone: send the picture back
      if (apps.lastScreenshot && apps.lastScreenshot !== shot) r.photo = apps.lastScreenshot;
      return r;
    },
    // a photo / PDF / file sent to the bot -> Downloads\Shadow (files.js)
    onFile: async ({ buffer, name, caption }) => {
      if (!settings.get('phoneFiles')) return 'File transfer is switched off on the PC (Settings → Phone).';
      const saved = files.save(buffer, name, caption);
      ctx.activity.note('file-received', saved.name);
      friends.quickJob('dash', '📥 Delivery from your phone!', 5000);
      if (!brain.activeReminder && brain.state !== 'hidden') brain.say(`📥 ${saved.name} arrived from your phone → ${saved.folder}`, { ms: 6000 });
      return `📥 Saved ${saved.name} (${mb(saved.size)}) to ${saved.folder} on your PC${saved.renamed ? '. It\'s a program/script file, so I added ".download" to its name - it can\'t run by accident' : ''} ✓`;
    },
  }));
  tg.on('file-sent', (name) => !brain.activeReminder && brain.state !== 'hidden' && brain.say(`📤 Sent ${name} to your phone`, { ms: 5000 }));
  tg.on('file-sent', (name) => ctx.activity.note('file-sent', name));
  tg.on('paired', () => brain.state !== 'hidden' && !brain.activeReminder && brain.say('📱 Phone paired! Text me anytime, Prince 🐾', { ms: 5000 }));
  tg.on('message', (text) => console.log(`[telegram] message (${text.length} chars)`)); // content stays private
  const away = () => ctx.sensors.idleSeconds() > 120;
  ipcMain.handle('telegram:test', (_e, token) => tg.test(typeof token === 'string' ? token : ''));
  ipcMain.handle('telegram:info', () => tg.info());
  ipcMain.handle('telegram:unpair', () => (tg.unpair(), tg.info()));

  /**
   * Everything Shadow can do from a message - used by the chat panel and by Telegram (telegram.js).
   * Returns { text, sources }.
   */
  /**
   * origin: 'pc' (chat panel), 'phone' (Telegram) or 'hud' (the J.A.R.V.I.S. console - the answer shows
   * in the HUD, so Shadow doesn't say it too). opts.image / opts.rules: a screenshot and answer format
   * for the AI (jarvis.js).
   */
  async function handleMessage(message, history, origin = 'pc', opts = {}) {
    // Parse before the general chat length limit so outgoing messages are never silently truncated.
    const whatsappCmd = parseWhatsAppCommand(message);
    const text = String(message || '').trim().slice(0, 2000);
    if (!text) return { text: '' };
    history.push({ role: 'user', text });
    let reply;
    const speak = (out) => origin !== 'hud' && brain.chatReply(out);
    const done1 = (out, { animate = true } = {}) => {
      history.push({ role: 'pet', text: out });
      if (origin === 'hud') return { text: out, sources: [] };
      if (animate) brain.chatReply(out);
      else brain.say(out, { ms: 3500 });
      return { text: out, sources: [] };
    };
    if (whatsappCmd) return done1(await runWhatsApp(whatsappCmd));
    // during a quiz race everything Prince types is an answer (games.js)
    if (race.active()) {
      const g = parseGameCommand(text);
      if (!g || g.type !== 'race') {
        const out = g && g.type === 'stop' ? race.stop() : race.answer(text);
        raceEnded();
        return done1(out);
      }
    }
    if (/^(?:iron man[, ]+)?fly(?: horizontally| across (?:the )?screen)?[?.!]*$/i.test(text) && appearance.isAvengers(settings) && appearance.mainHero(settings) === 'ironman') {
      if (brain.activeReminder) return done1('Dismiss the reminder first, then I can fly, Prince.');
      if (brain.state === 'hidden') brain.command('wake');
      brain.command('fly');
      return done1('Iron Man taking off! ⚡', { animate: false });
    }
    const gang = gangCommand(text);
    if (gang) return done1(gang);
    // Avenger/team summons retain precedence; a remaining "call NAME" is a WhatsApp call.
    const bareCall = parseWhatsAppCommand(message, { allowBareCall: true });
    if (bareCall) return done1(await runWhatsApp(bareCall));
    const gameCmd = parseGameCommand(text);
    if (gameCmd) return done1(await runGame(gameCmd, origin));
    const startupCmd = parseStartupCommand(text);
    if (startupCmd) {
      friends.quickJob('bolt', startupCmd.type === 'run' ? '⚡ Morning routine!' : '📝 Noted!', 4000);
      return done1(startupCmd.type === 'run' ? await runStartupRoutine('asked') : startup.edit(startupCmd));
    }
    const examCmd = parseExamCommand(text);
    if (examCmd) {
      if (examCmd.type === 'add' && !examCmd.error) friends.quickJob('sage', '📅 Making your plan!', 5000);
      if (examCmd.type === 'done' && exams.today().length) ctx.activity.note('study', exams.today().map(({ exam, day }) => `${exam.subject || 'Exam'}: ${day.topics.slice(0, 3).join(', ')}`).join(' + '));
      return done1(exams.run(examCmd));
    }
    const hudCmd = parseHudCommand(text);
    if (hudCmd) return done1(await runHud(hudCmd, origin));
    // "brief me" / "debrief" (briefing.js) and "jarvis" (the HUD console)
    const reportCmd = parseReportCommand(text);
    if (reportCmd) {
      if (origin === 'phone') return done1(reportText(await reportData(reportCmd.type)));
      await showReport(reportCmd.type, 'chat');
      return done1(reportCmd.type === 'brief' ? '☀️ Your briefing is up on the HUD, Prince.' : '📊 Your debrief is up on the HUD, Prince.');
    }
    const newsCmd = parseNewsCommand(text);
    if (newsCmd) {
      if (origin === 'phone') return done1(reportText(await reportData('news', newsCmd.only)));
      await showReport('news', 'chat', newsCmd.only);
      return done1(`📰 ${newsCmd.only === 'banking' ? 'RBI & banking news' : 'The news'} is up on the HUD, Prince.`);
    }
    if (/^(?:(?:jarvis|shadow)[, ]+)?(?:stop talking|stop speaking|be quiet|quiet|shut up|silence|enough|mute (?:jarvis|yourself|the voice))[.!]*$/i.test(text) && hud.visible) {
      hud.w.send('hud:mute');
      voice.stop();
      return done1('🔇 Okay, Prince.');
    }
    if (parseJarvisOpen(text)) {
      if (origin === 'phone') return done1(`${consoleName()} lives in the HUD on your PC, Prince - but ask me anything right here.`);
      if (origin === 'hud') return done1("Right here, Prince. What's the mission?");
      hud.show('chat', { mode: 'jarvis' });
      return done1(`⚡ ${consoleName()} online - type in the HUD console.${ctx.jarvisKey ? ` (${jarvisKeyLabel()} anytime)` : ''}`);
    }
    // files for the phone: "send me my notes", "browse D:", and "3" / "back" / "more" in an open list
    const appAsked = apps.pendingChoice ? apps.pendingChoice.at : 0;
    const fileCmd = (files.active(appAsked) && parseNavCommand(text)) || parseFileCommand(text) || parseBrowseCommand(text);
    if (fileCmd && !(fileCmd.loose && !settings.get('phoneFiles'))) {
      if (!settings.get('phoneFiles')) return done1('Sending files is switched off, Prince (Settings → Phone).');
      let r;
      try {
        r = await files.handle(fileCmd);
      } catch (err) {
        console.warn('[files]', err);
        r = { text: `Something went wrong looking for that file (${err.message}).` };
      }
      if (!(r.notFound && fileCmd.loose)) {
        const out = await sendFile(r, origin);
        return { ...done1(out.text), document: out.document, temp: out.temp };
      }
    }
    const pcCmd = parsePcCommand(text);
    if (pcCmd) {
      let out = null;
      try {
        out = await runPcCommand(pcCmd);
      } catch (err) {
        console.warn('[apps]', err);
        out = `That didn't work, Prince (${err.message}).`;
      }
      if (out) return done1(out);
      // "cancel"/"2" with nothing pending -> just chat
    }
    const tidied = care.confirm(text); // "yes" to a pending Downloads tidy-up
    if (tidied) {
      friends.quickJob('zen', '🧹 Tidying!', 5000);
      return done1(tidied);
    }
    const musicCmd = parseMusicCommand(text);
    if (musicCmd) return done1(await runMusic(musicCmd));
    const careCmd = parseCareCommand(text);
    if (careCmd) return done1(await runCare(careCmd));
    const tutorCmd = parseTutorCommand(text);
    // "quiz me" with no topic on a study day = today's chapters
    if (tutorCmd && tutorCmd.type === 'quiz' && !tutorCmd.topic && !tutor.active() && exams.quizTopic()) tutorCmd.topic = exams.quizTopic();
    if (tutorCmd || (tutor.active() && !parseCommand(text) && !search.parseSearchCommand(text))) {
      let out;
      try {
        out = await tutorTurn(text, tutorCmd, history);
      } catch (err) {
        if (!(err instanceof ai.AiError)) console.warn('[tutor]', err);
        out = err instanceof ai.AiError ? ai.friendly(err, aiContext()) : 'Sage lost his notes, Prince. Try again? 🦉';
      }
      history.push({ role: 'pet', text: out });
      if (origin !== 'hud') tutorBubble(out);
      return { text: out, sources: [] };
    }
    const searchCmd = search.parseSearchCommand(text);
    if (searchCmd) {
      const atlasDone = searchCmd.type === 'wiki' || searchCmd.type === 'search' ? searchingBubble() : null;
      let out;
      try {
        out = await runSearchCommand(searchCmd, text, history);
      } catch (err) {
        if (!(err instanceof ai.AiError)) console.warn('[search]', err);
        out = { text: err instanceof ai.AiError ? ai.friendly(err, aiContext()) : 'Search glitched, Prince. Try again?' };
      }
      if (atlasDone) atlasDone(out.sources && out.sources.length ? 'Found it! 📰' : 'Hmm, nothing good 😕');
      history.push({ role: 'pet', text: out.text });
      speak(out.text);
      return { text: out.text, sources: out.sources || [] };
    }
    // "remind me at 6 pm to call Mom", "todo: buy milk", "done 2", ... - handled right here,
    // so they work instantly, offline and without an AI key
    const cmd = parseCommand(text);
    if (cmd) {
      reply = ctx.tasks.run(cmd);
      dashFor(cmd.type, reply);
      history.push({ role: 'pet', text: reply });
      speak(reply);
      return { text: reply, sources: [] };
    }
    const searchOn = settings.get('webSearch');
    const context = {
      ...aiContext(),
      search: searchOn ? search.aiInstructions(!!settings.get('searchKey')) : '',
      pc: settings.get('pcControl') ? apps.aiInstructions() : '',
      music: music.available ? music.aiInstructions() : '',
      history: history.slice(-20),
      ...(opts.rules ? { rules: opts.rules } : {}),
      ...(opts.image ? { image: opts.image } : {}),
    };
    let sources = [];
    try {
      const raw = await ai.chat(text, context);
      const q = searchOn ? search.searchRequest(raw) : null;
      if (q) {
        // the AI wants to look something up: search, then ask again with the results
        const atlasDone = searchingBubble();
        let found = null;
        try {
          found = await search.webSearch(q, searchOpts());
        } catch (err) {
          reply = search.friendly(err, { hasKey: !!settings.get('searchKey') });
        }
        atlasDone(found && found.results.length ? 'Found it! 📰' : 'Hmm, nothing good 😕');
        if (found) {
          const answer = await ai.chat(text, { ...context, tasks: '', search: '', searchResults: search.resultsForAi(found) });
          reply = search.stripCommands(answer) || 'The internet had nothing useful on that, Prince 🤔';
          sources = showSources(found.results);
        }
      } else {
        // the AI may end its reply with hidden commands: [[open | spotify]], [[pc | lock]] (apps.js),
        // [[remind | ...]] / [[todo ...]] (tasks.js)
        const done = [];
        if (settings.get('pcControl')) {
          for (const req of pcRequests(raw)) done.push(await runPcCommand(req));
        }
        for (const req of musicRequests(raw)) done.push(await runMusic(req));
        const tagged = ctx.tasks.applyTags(raw);
        reply = tagged.text;
        if (tagged.actions.some((a) => a.ok)) dashFor(tagged.actions.some((a) => a.note.startsWith('⏰')) ? 'remind' : 'todo-add', '');
        if (done.length) reply = `${reply ? `${reply} ` : ''}${done.filter(Boolean).join(' · ')}`;
        reply = reply || '😼';
      }
      history.push({ role: 'pet', text: reply });
    } catch (err) {
      history.pop(); // keep error lines out of the conversation the AI sees
      if (!(err instanceof ai.AiError)) console.warn('[ai]', err);
      reply = ai.friendly(err, context);
      if (err.kind === 'no-key' && /remind|to-?do|my list/i.test(text)) {
        reply = 'I didn\'t get that one, Prince. Try "remind me at 6 pm to call Mom", "remind me in 20 min to drink water" or "todo: physics homework".';
      }
    }
    speak(reply);
    return { text: reply, sources, vision: !!opts.image };
  }
  /** Shadow says it's searching and Atlas the parrot flies in. Returns Atlas's done(line). */
  function searchingBubble() {
    if (!brain.activeReminder && brain.state !== 'hidden') brain.say('🔍 Searching the internet…', { ms: 20000 });
    return friends.job('atlas', '🔍 On it, Prince!');
  }
  /** Dash the rabbit handles reminders and the to-do list. */
  function dashFor(type, reply) {
    if (/^(?:That time|I didn't|There's no|Your list is empty|No reminders|Too many|That's too far|Add what|What time|Which days|Repeat what|More than one|I couldn't|Nothing repeats|That's \d+)/.test(reply)) return;
    const line = { remind: '📨 Noted - I\'ll deliver it!', 'todo-add': '📝 On the list!', 'todo-done': '✓ Crossed off!', 'todo-remove': '🗑️ Gone!', 'reminder-cancel': '✓ Cancelled!', 'repeat-add': '🔁 Every time, got it!', 'repeat-stop': '✓ No more repeats!' }[type];
    if (line) friends.quickJob('dash', line, 3500);
  }
  // Dash also delivers reminders as they fire (not update notices or the morning briefing)
  brain.on('reminder-start', (r) => {
    if (!['update', 'briefing', 'care'].includes(r.kind) && ctx.activity) ctx.activity.note('reminder', r.message);
    if (!['update', 'briefing', 'care', 'exam'].includes(r.kind) && !brain.reminderClosing) friends.quickJob('dash', '📨 Delivery for Prince!', 7000);
    if (!['update', 'briefing'].includes(r.kind) && ctx.telegram && away()) ctx.telegram.notify(`${r.icon || '⏰'} ${r.message}`);
  });
  ipcMain.handle('ai:test', (_e, form = {}) => {
    const over = {};
    if (typeof form.provider === 'string' && ai.PROVIDERS[form.provider]) over.provider = form.provider;
    for (const k of ['model', 'baseUrl', 'apiKey']) if (typeof form[k] === 'string') over[k] = form[k].slice(0, 500);
    return ai.testConnection(aiContext(over));
  });
  // "Get a free key" / "Open Google Calendar settings" buttons: only ever open these known pages
  ipcMain.on('settings:open-link', (_e, url) => {
    if (/^https:\/\/t\.me\/[A-Za-z0-9_]{4,40}(\?start=\d{6})?$/.test(url)) return shell.openExternal(url); // @BotFather / pairing link
    if (url === GCAL_SETTINGS_URL || url === search.TAVILY_KEY_URL || url === SPOTIFY_DASHBOARD || ai.publicProviders().some((p) => p.keyUrl && p.keyUrl === url)) shell.openExternal(url);
  });
  ipcMain.handle('calendar:test', (_e, url) => ctx.calendar.test(typeof url === 'string' ? url.slice(0, 1000) : ''));
  ipcMain.handle('calendar:sync', () => ctx.calendar.sync());
  ipcMain.on('chat:close', () => {
    const w = getChatWindow();
    if (w) w.close();
  });

  // settings window
  ipcMain.handle('settings:load', () => settingsPayload());
  ipcMain.handle('settings:save', async (_e, patch = {}) => {
    const allowed = ['appearance', 'mainHero', 'petName', 'scale', 'quipMinMinutes', 'quipMaxMinutes', 'sleepTimeoutMinutes', 'muteQuips', 'aiProvider', 'aiModel', 'aiBaseUrl', 'apiKeys', 'calendarUrl', 'calendarLeadMinutes', 'calendarAtStart', 'calendarInChat', 'morningBriefing', 'todoNudges', 'webSearch', 'searchKey', 'pcControl', 'pcCare', 'whatsappAutomation', 'whatsappCallType', 'musicService', 'startupOnWake', 'phoneFiles', 'phoneFilesScope', 'examStudyTime', 'hudHotkey', 'hudSeconds', 'hudSound', 'weatherCity', 'jarvisHotkey', 'hudBrief', 'hudBriefDelay', 'hudDebrief', 'hudDebriefTime', 'voiceOn', 'voiceAuto', 'voiceName', 'voiceRate', 'newsOn', 'newsTopics', 'newsTopic', 'friendsMode', 'friends', 'telegramEnabled', 'telegramToken', 'telegramNotify'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    const before = settings.get('calendarUrl');
    settings.update(clean);
    if (settings.get('calendarUrl') !== before) await ctx.calendar.sync(); // so Settings shows the new status
    if (typeof patch.startWithWindows === 'boolean' && patch.startWithWindows !== ctx.loginItem.get()) {
      ctx.loginItem.set(patch.startWithWindows);
      ctx.trayCtl.rebuild();
    }
    return settingsPayload();
  });
  ipcMain.on('settings:open-config', () => openConfigFolder());
  ipcMain.on('friends:call', () => ctx.friends.callGang());
  ipcMain.handle('update:check', () => ctx.updater.check());
  ipcMain.handle('update:status', () => ctx.updater.status());
  ipcMain.handle('update:install', () => ctx.updater.install());

  settings.on('change', (all, changed) => {
    if ((changed.includes('whatsappAutomation') || changed.includes('pcControl')) && !whatsapp.enabled()) whatsapp.stop();
    if (changed.includes('whatsappAutomation')) {
      // the WhatsApp Web engine only runs while WhatsApp automation is on (the link itself stays)
      if (!settings.get('whatsappAutomation')) ctx.waweb.state !== 'off' && ctx.waweb.stop();
      else if (waWebWanted()) ctx.waweb.start();
    }
    if (changed.includes('appearance') || changed.includes('mainHero') || changed.includes('petName')) {
      require('./windows').setAppearance(appearance.displayName(settings), appearance.mainAssetsDir(paths.ASSETS, settings));
      pet.win.setTitle(appearance.displayName(settings));
      const chat = getChatWindow();
      if (chat) chat.webContents.send('chat:appearance', chatInfo());
    }
    if (changed.includes('appearance') || changed.includes('mainHero')) {
      meta = ctx.meta = loadMeta();
      brain.meta = meta;
      pet.win.setTitle(appearance.displayName(settings));
      pet.send('pet:init', { meta, title: appearance.displayName(settings), sheet: sheetDataUrl(), scale: all.scale, workArea: pet.display().workArea, appearance: all.appearance, test: SELF_TEST, debug: !!process.env.SHADOW_DEBUG });
      if (brain.anim) pet.send('pet:anim', { name: brain.anim, facing: brain.facing });
      friends.setAppearance();
    }
    if (changed.includes('friendsMode') || changed.includes('friends')) friends.apply();
    if ((changed.includes('telegramToken') || changed.includes('telegramEnabled')) && ctx.telegram) {
      if (changed.includes('telegramToken')) settings.update({ telegramChatId: 0 }); // new bot = pair again
      ctx.telegram.restart();
    }
    if (changed.includes('scale')) {
      friends.setScale(all.scale);
      pet.setScale(all.scale);
      pet.send('pet:scale', { scale: all.scale });
      syncDisplay(true);
      brain.scaleChanged();
    }
    if (changed.includes('quipMinMinutes') || changed.includes('quipMaxMinutes')) brain.scheduleQuip();
  });

  // Self-updates from GitHub Releases - installed app only (see updater.js)
  let autoUpdater = null;
  if (app.isPackaged && !SELF_TEST) {
    try {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.logger = null;
    } catch (err) {
      console.warn('[update] updater unavailable:', err.message);
    }
  }
  ctx.updater = new Updater({ autoUpdater, brain, currentVersion: app.getVersion(), enabled: !!autoUpdater });
  // clicking the "update ready" bubble restarts into the new version; "Update Later" just closes it
  brain.on('reminder-dismissed', (r, how) => {
    if (r.kind === 'update' && how === 'click') setTimeout(() => ctx.updater.install(), 1200);
  });

  // ---- the Iron Man HUD (hud.js): Ctrl+Alt+H, "hud", "status report", "weather"
  const hudData = (ctx.hudData = new HudData({
    settings,
    sources: {
      get exams() {
        return ctx.exams;
      },
      get tasks() {
        return ctx.tasks;
      },
      get calendar() {
        return ctx.calendar;
      },
      get music() {
        return ctx.music;
      },
      get care() {
        return ctx.care;
      },
    },
    hooks: ctx.hudHooks || {},
    ...(ctx.hudBases || {}),
  }));
  const hud = (ctx.hud = new HudDisplay({
    data: hudData,
    createWindow: (wa) => openHudWindow(wa, { test: SELF_TEST }),
    sensors: ctx.sensors,
    seconds: () => (ctx.hudSecondsOverride !== undefined ? ctx.hudSecondsOverride : settings.get('hudSeconds')),
    test: SELF_TEST,
    head: () => {
      const avengers = appearance.isAvengers(settings);
      return {
        title: avengers ? 'STARK HUD' : `${appearance.displayName(settings).toUpperCase()} HUD`,
        sub: [avengers ? 'MARK 85' : 'PANTHER OS', 'ONLINE', ctx.hudKey ? hudKeyLabel().toUpperCase() : ''].filter(Boolean).join(' · '),
        theme: avengers ? 'stark' : 'shadow',
        name: 'Prince',
        tutor: friends.get('sage').def.name,
        sound: settings.get('hudSound'),
        consoleName: consoleName(),
        voice: settings.get('voiceOn'),
        voiceName: settings.get('voiceName'),
        voiceRate: { slow: 0.9, normal: 1, fast: 1.15 }[settings.get('voiceRate')] || 1,
      };
    },
  }));
  const fromHud = (e) => hud.alive() && e.sender === hud.window().webContents;
  ipcMain.on('hud:ready', (e) => fromHud(e) && hud.onReady());
  ipcMain.on('hud:show', () => hud.show('settings')); // Settings → SHOW HUD NOW
  ipcMain.on('hud:interactive', (e, on) => fromHud(e) && hud.setInteractive(on));
  ipcMain.on('hud:hidden', (e) => fromHud(e) && hud.hidden());
  ipcMain.on('hud:close', (e) => fromHud(e) && hud.hide('button'));
  ipcMain.on('hud:media', (e, action) => fromHud(e) && ['toggle', 'next', 'previous'].includes(action) && hud.media(action));
  ipcMain.on('hud:todo-done', (e, id) => {
    if (!fromHud(e) || typeof id !== 'string' || !ctx.tasks) return;
    const r = ctx.tasks.completeTodo(1, [id]);
    if (!r.todo) return;
    friends.quickJob('dash', '✓ Crossed off!', 3500);
    hud.extend(3000);
    setTimeout(() => hud.push('missions'), 1500); // after the strike-through animation
  });
  /** "hud", "status report", "hide hud", "weather", "set my city to …" */
  async function runHud(cmd, origin) {
    if (cmd.type === 'weather') return hudData.weatherText(cmd);
    if (cmd.type === 'city') return hudData.setCity(cmd.city);
    if (cmd.type === 'hide') return hud.hide('chat') ? 'HUD closed.' : "The HUD isn't open, Prince.";
    if (origin === 'phone') return hudData.statusText(); // there's no screen to show it on
    hud.show(cmd.report ? 'report' : 'chat');
    if (cmd.report) return '📊 Status report is up on your HUD, Prince.';
    return `${appearance.isAvengers(settings) ? '⚡ HUD online' : '🐾 HUD up'}, Prince.${ctx.hudKey ? ` (${hudKeyLabel()} opens it anytime)` : ''}`;
  }
  // the hotkeys (Settings → HUD); another app may already own one - Settings then says so
  const bindKey = (name, map, settingKey, fn) => {
    if (ctx[`${name}Key`]) globalShortcut.unregister(ctx[`${name}Key`]);
    ctx[`${name}Key`] = '';
    ctx[`${name}KeyTaken`] = false;
    const accel = (map[settings.get(settingKey)] || map.off).accel;
    if (!accel) return;
    let ok = false;
    try {
      ok = globalShortcut.register(accel, fn);
    } catch {
      ok = false;
    }
    if (ok) ctx[`${name}Key`] = accel;
    else ctx[`${name}KeyTaken`] = true;
  };
  const toggleJarvis = () => (hud.visible && hud.mode === 'jarvis' ? hud.hide('hotkey') : hud.show('hotkey', { mode: 'jarvis' }));
  const bindHudKey = () => bindKey('hud', HOTKEYS, 'hudHotkey', () => hud.toggle('hotkey'));
  const bindJarvisKey = () => bindKey('jarvis', JARVIS_HOTKEYS, 'jarvisHotkey', toggleJarvis);
  ctx.bindHudKey = bindHudKey;
  bindHudKey();
  bindJarvisKey();
  settings.on('change', (_all, changed) => {
    if (changed.includes('hudHotkey')) bindHudKey();
    if (changed.includes('jarvisHotkey')) bindJarvisKey();
    if (changed.includes('weatherCity')) hudData.cache.weather.clear();
  });

  // ---- J.A.R.V.I.S. (jarvis.js): the HUD's command console - type anything, or ask about the screen
  ctx.jarvisHistory = [];
  let scanWaiter = null;
  ipcMain.on('hud:scan-ready', (e) => {
    if (!fromHud(e) || !scanWaiter) return;
    scanWaiter();
    scanWaiter = null;
  });
  /** Tell the HUD page what the scan is doing; 'capture' waits until it has gone see-through. */
  const onScan = (phase) =>
    new Promise((resolve) => {
      if (!hud.visible || !hud.alive()) return resolve();
      hud.w.send('hud:scan', { phase });
      if (phase !== 'capture') return resolve();
      scanWaiter = resolve;
      setTimeout(() => scanWaiter === resolve && (scanWaiter = null, resolve()), 700);
    });
  /** The screen the HUD is on, as a JPEG for the AI (max 1600 px wide). Shadow & co. step aside. */
  async function captureScreen() {
    const display = hud.window() ? screen.getDisplayMatching(hud.window().getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const others = [pet.win, getChatWindow(), ...friends.windows().map((w) => w.win)].filter((w) => w && !w.isDestroyed() && w.isVisible());
    others.forEach((w) => w.hide());
    let img;
    try {
      await new Promise((r) => setTimeout(r, 160)); // the HUD's see-through frame reaches the screen
      if (ctx.jarvisHooks && ctx.jarvisHooks.capture) {
        const raw = await ctx.jarvisHooks.capture(display);
        img = Buffer.isBuffer(raw) ? nativeImage.createFromBuffer(raw) : raw;
      } else {
        const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
        const src = sources.find((x) => String(x.display_id) === String(display.id)) || sources[0];
        if (!src) throw new Error('no screen found');
        img = src.thumbnail;
      }
    } finally {
      others.forEach((w) => !w.isDestroyed() && w.showInactive());
    }
    if (!img || img.isEmpty()) throw new Error('the screenshot came out empty');
    if (img.getSize().width > 1600) img = img.resize({ width: 1600, quality: 'good' });
    return { image: { mime: 'image/jpeg', data: img.toJPEG(80).toString('base64') }, display: display.bounds };
  }
  const jarvis = (ctx.jarvis = new Jarvis({
    capture: captureScreen,
    see: (question, image, history) => ai.chat(question, { ...aiContext(), rules: screenRules(consoleName()), image, history: history.slice(-8) }),
    handle: async (text, { image } = {}) => {
      const r = await handleMessage(text, ctx.jarvisHistory, 'hud', { image, rules: image ? screenRules(consoleName()) : consoleRules(consoleName()) });
      if (ctx.jarvisHistory.length > 40) ctx.jarvisHistory.splice(0, ctx.jarvisHistory.length - 40);
      return r;
    },
  }));
  ipcMain.on('hud:console', (e) => fromHud(e) && hud.show('button', { mode: 'jarvis' }));
  ipcMain.on('hud:report-now', (_e, kind) => ['brief', 'debrief', 'news'].includes(kind) && showReport(kind, 'settings').catch(() => {})); // Settings buttons
  ipcMain.on('hud:open-link', (e, url) => fromHud(e) && sourceUrls.has(url) && /^https?:\/\//i.test(url) && openUrl(url));
  // her voice: the HUD page speaks; this is the backup (voice.js) and the "keep the HUD up while she talks"
  const voice = (ctx.voice = new WindowsVoice({ hooks: ctx.voiceHooks || {} }));
  ipcMain.on('hud:speech', (e, state) => fromHud(e) && hud.speaking(state === 'start'));
  ipcMain.on('hud:speak-fallback', (e, lines) => {
    if (!fromHud(e) || !Array.isArray(lines)) return;
    const send = (ch, d) => hud.alive() && hud.w.send(ch, d);
    if (!voice.speak(lines.map(String), { rate: settings.get('voiceRate'), onLine: (i) => send('hud:speech-line', { i }), onEnd: () => send('hud:speech-end', {}) })) send('hud:speech-end', {});
  });
  ipcMain.on('hud:speak-stop', (e) => fromHud(e) && voice.stop());
  hud.on('hide', () => voice.stop());
  ipcMain.on('hud:ask', async (e, text) => {
    if (!fromHud(e) || typeof text !== 'string') return;
    let r;
    const c = aiContext();
    if (isScreenRequest(text) && ai.PROVIDERS[c.provider].needsKey && !c.apiKey) {
      r = { text: `To read your screen I need an AI brain that can see, Prince - add a free Google Gemini key in Settings → AI Brain (2 minutes).`, error: true };
    } else {
      try {
        r = await jarvis.ask(text, { onScan });
      } catch (err) {
        if (!(err instanceof ai.AiError)) console.warn('[jarvis]', err);
        r = { text: err instanceof ai.AiError ? ai.friendly(err, c) : `That didn't work, Prince (${err.message}).`, error: true };
      }
    }
    if (!hud.alive()) return;
    hud.w.send('hud:scan', { phase: 'done' });
    const out = { text: r.text || '…', sources: r.sources || [], screen: !!r.screen, error: !!r.error };
    if (r.box && r.display && hud.window()) out.rect = boxToWindow(r.box, r.display, hud.window().getBounds());
    hud.w.send('hud:answer', out);
  });

  // ---- the briefing (15 min after the laptop opens) and the debrief every 12 hours (briefing.js)
  const activity = (ctx.activity = new ActivityLog({ file: path.join(app.getPath('userData'), 'activity.json') }));
  setInterval(() => activity.minute(ctx.sensors.idleSeconds() < 120), 60 * 1000);
  const news = (ctx.news = new NewsFeed({ settings, ...(ctx.newsBases || {}) }));
  async function reportData(kind, only = '') {
    if (kind === 'news') return remember(buildNews({ now: Date.now(), news: await news.headlines({ only, per: 5 }).catch(() => ({ ok: false, sections: [] })) }));
    const wantNews = kind === 'brief' && settings.get('newsOn');
    const [weather, quick, slow, headlines] = await Promise.all([
      hudData.weather().catch(() => null),
      hudData.quickSystem().catch(() => ({})),
      hudData.slowSystem().catch(() => ({})),
      wantNews ? news.headlines({ per: 3 }).catch(() => null) : null,
    ]);
    const base = { now: Date.now(), tasks: ctx.tasks, exams, calendar: ctx.calendar, weather, sys: { ...quick, ...slow }, studyTime: settings.get('examStudyTime'), updateReady: !!(ctx.updater && ctx.updater.ready) };
    return remember(kind === 'brief' ? buildBrief({ ...base, news: headlines }) : buildDebrief({ ...base, log: activity }));
  }
  /** Headline links on the card may be opened (and only those - see hud:open-link). */
  function remember(report) {
    for (const sec of report.sections) for (const it of sec.items) if (it.url) sourceUrls.add(it.url);
    return report;
  }
  /** A nicer, spoken-style summary from the AI (if there is one) replaces the built-in sentence. */
  async function polishReport(report) {
    if (ctx.noPolish) return;
    const c = aiContext();
    if (ai.PROVIDERS[c.provider].needsKey && !c.apiKey) return;
    try {
      const rules = `\nYou are ${consoleName()}, Prince's assistant. Write the summary line for this ${report.kind === 'brief' ? 'morning briefing' : 'debrief'} in 2 short sentences (max 45 words), speaking to Prince. Plain text, no lists, no emojis. Use only facts from the report.`;
      const line = await Promise.race([ai.chat(reportText(report), { ...c, rules, history: [] }), new Promise((_r, no) => setTimeout(() => no(new Error('slow')), 12000))]);
      if (line && line.length < 400) hud.updateReport({ summary: line });
    } catch {
      /* keep the built-in sentence */
    }
  }
  async function showReport(kind, why, only = '') {
    const report = await reportData(kind, only);
    const speak = settings.get('voiceOn') && (why !== 'auto' || settings.get('voiceAuto'));
    hud.show(why, { mode: kind, report, speak });
    if (kind !== 'news') polishReport(report);
    return report;
  }
  ctx.showReport = showReport;
  const reports = (ctx.reports = new ReportScheduler({
    settings,
    log: activity,
    idleSeconds: () => ctx.sensors.idleSeconds(),
    busy: () => catchGame.running() || brain.state === 'off' || (hud.visible && hud.mode === 'jarvis'), // never over a game, or while he types
    show: (kind) => {
      showReport(kind, 'auto').catch((err) => console.warn('[reports]', err.message));
      return true;
    },
    phone: (kind) => {
      if (!settings.get('telegramEnabled') || !settings.get('telegramNotify') || !tg.owner() || !tg.running) return false;
      reportData(kind)
        .then((r) => tg.send(tg.owner(), reportText(r)))
        .catch(() => {});
      return true;
    },
  }));
  if (!SELF_TEST) {
    setInterval(() => reports.tick(), 30 * 1000);
    if (process.argv.includes('--startup')) reports.opened('boot'); // Windows just started
  }
  let lockedAt = 0;
  powerMonitor.on('resume', () => reports.opened('resume')); // the lid opened
  powerMonitor.on('lock-screen', () => (lockedAt = Date.now()));
  powerMonitor.on('unlock-screen', () => lockedAt && Date.now() - lockedAt >= 30 * 60 * 1000 && reports.opened('unlock'));
  powerMonitor.on('suspend', () => reports.suspended());

  app.on('will-quit', () => globalShortcut.unregisterAll());
  powerMonitor.on('suspend', () => hud.hide('sleep'));

  ctx.trayCtl = createTray({
    brain,
    settings,
    loginItem: { get: () => ctx.loginItem.get(), set: (on) => ctx.loginItem.set(on) },
    actions: { openSettings, openConfigFolder, openChat: openChatPanel, quit, rescue: () => ctx.rescue(), showHud: () => hud.show('tray'), hudKey: () => (ctx.hudKey ? hudKeyLabel() : ''), showJarvis: () => hud.show('tray', { mode: 'jarvis' }), jarvisLabel: () => `${consoleName()} Console${ctx.jarvisKey ? ` (${jarvisKeyLabel()})` : ''}` },
    getUpdater: () => ctx.updater,
    callGang: () => ctx.friends.callGang(),
  });
  ctx.updater.on('status', () => ctx.trayCtl.rebuild());
  ctx.telegram.restart(); // does nothing until a bot token is set and switched on
  ctx.updater.start();

  const reminders = (ctx.reminders = new ReminderScheduler(config));
  reminders.on('fire', (r) => {
    console.log(`[reminder] ${r.time} ${r.message}`);
    brain.reminder(r);
  });
  reminders.start();

  // Google Calendar -> the same reminder bubbles
  const calendar = (ctx.calendar = new CalendarSync({ settings, cacheFile: path.join(app.getPath('userData'), 'calendar-cache.json') }));
  calendar.on('fire', (r) => {
    console.log(`[calendar] ${r.time} reminder`); // titles stay out of the log
    brain.reminder(r); // "starting now" replaces a still-open "in 10 mins" for the same event
  });
  calendar.start();

  // one-time reminders + to-do list from chat (tasks.js), saved outside the project
  const tasks = (ctx.tasks = new TaskStore({ file: path.join(app.getPath('userData'), 'tasks.json') }));
  tasks.on('fire', (r) => {
    console.log(`[tasks] ${r.time} reminder`);
    brain.reminder(r);
  });
  ctx.tasksTimer = setInterval(() => tasks.check(), 10 * 1000);
  tasks.check();
  // idle quips sometimes become a nudge about an open to-do
  brain.nudge = () => (settings.get('todoNudges') ? tasks.nudge() : null);

  // Morning briefing: the first time Prince is at the PC each day (from 5 AM), Shadow walks out
  // with today's calendar, open to-dos and reminders. Waits for the calendar's first sync.
  const startedAt = Date.now();
  ctx.tryBriefing = (force = false) => {
    if (SELF_TEST && !force) return false; // the self-test triggers it on purpose
    if (!settings.get('morningBriefing') || !tasks.briefingDue() || brain.state === 'off') return false;
    if (ctx.sensors.idleSeconds() > 120) return false; // wait until Prince is actually here
    const cal = ctx.calendar;
    if (cal.url() && !cal.lastSync && Date.now() - startedAt < 3 * 60 * 1000) return false;
    tasks.markBriefed();
    brain.reminder({ time: '', kind: 'briefing', key: 'briefing', icon: '☀️', head: 'YOUR DAY', hint: 'click to close ✓', message: tasks.briefing(Date.now(), cal.url() ? cal.upcoming : null, [exams.briefingLine()]) });
    return true;
  };
  ctx.briefingTimer = setInterval(() => ctx.tryBriefing(), 30 * 1000);

  powerMonitor.on('resume', () => {
    tasks.check();
    reminders.check();
    calendar.check();
    calendar.sync();
  });

  const onDisplays = () => {
    hud.hide('display');
    brain.displaysChanged();
    syncDisplay(true);
    if (!press && !brain.dragging) rearm(); // never cut off a drag that's in progress
  };
  screen.on('display-added', onDisplays);
  screen.on('display-removed', onDisplays);
  screen.on('display-metrics-changed', onDisplays);

  if (SELF_TEST) require('./selftest').run(ctx, { petMenuTemplate, openChatPanel, openSettings, getChatWindow, paths });
  // Dev-only diagnostics: SHADOW_DEBUG=1 logs state/position; SHADOW_DEBUG=still also keeps the
  // panther sitting in one spot (handy for manual click-through testing).
  if (process.env.SHADOW_DEBUG) {
    pet.win.webContents.on('console-message', (e) => console.log(e.message));
    if (/still/.test(process.env.SHADOW_DEBUG)) {
      const stay = () => brain.sit(10 * 60 * 1000);
      brain.decide = function () {
        if (this.state === 'hidden' || this.state === 'sleep' || this.busy()) return;
        this.interrupt();
        return this.onFloor() ? stay() : this.fall(stay);
      };
    }
    setInterval(() => {
      if (!pet.alive()) return;
      const t = new Date().toISOString().slice(11, 23);
      console.log(`[debug ${t}] state=${brain.state} anim=${brain.anim} interactive=${pet.interactive} pos=${Math.round(pet.pos.x)},${Math.round(pet.pos.y)} bounds=${JSON.stringify(pet.win.getBounds())}`);
    }, 500);
  }
}

if (!SELF_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (ctx.brain && ctx.brain.state === 'hidden') ctx.brain.command('wake');
  });
  app.whenReady().then(init);
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });
  app.on('before-quit', () => {
    const { brain, config, reminders, calendar, updater, friends, care, telegram, whatsapp, waweb } = ctx;
    try {
      if (brain && !['off', 'hidden'].includes(brain.state)) brain.savePosition();
    } catch {
      /* ignore */
    }
    if (brain) brain.stop();
    if (config) config.stop();
    if (reminders) reminders.stop();
    if (calendar) calendar.stop();
    if (updater) updater.stop();
    if (friends) friends.stop();
    if (care) care.stop();
    if (telegram) telegram.stop();
    if (whatsapp) whatsapp.stop();
    if (waweb) waweb.stop(); // closes the background browser; the link stays
  });
}

module.exports = { ctx };
