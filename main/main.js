'use strict';
/*
 * Shadow - desktop pet.
 * Main process entry: creates the pet window, brain, tray, reminders, calendar and IPC wiring.
 */

const { app, ipcMain, screen, Menu, shell, nativeTheme, powerMonitor } = require('electron');
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
const { PetWindow } = require('./petWindow');
const { Brain } = require('./brain');
const { createTray } = require('./tray');
const { openChat, openSettings, getChatWindow } = require('./windows');
const ai = require('./ai');

const realSensors = {
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
  cursor: () => screen.getCursorScreenPoint(),
  displayAt: (pt) => screen.getDisplayNearestPoint({ x: Math.round(pt.x), y: Math.round(pt.y) }),
  primary: () => screen.getPrimaryDisplay(),
};

// "Start with Windows" uses Electron's login-item settings (registry Run key, per user).
const loginItem = {
  opts() {
    return app.isPackaged ? { path: process.execPath } : { path: process.execPath, args: [path.resolve(paths.ROOT)] };
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

const ctx = { SELF_TEST, loginItem, sensors: realSensors, chatHistory: [] };
if (SELF_TEST) ctx.sensors = require('./selftest').makeSensors(realSensors);

function loadMeta() {
  return JSON.parse(fs.readFileSync(path.join(paths.ASSETS, 'sprites.json'), 'utf8'));
}

function sheetDataUrl() {
  // Sent as a data: URL so the renderer can read pixels for click-through hit-testing.
  return 'data:image/png;base64,' + fs.readFileSync(path.join(paths.ASSETS, 'sprites.png')).toString('base64');
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
  return [
    { label: 'Sit', click: () => brain.command('sit') },
    { label: 'Sleep', click: () => brain.command('sleep') },
    { label: 'Pounce', click: () => brain.command('pounce') },
    { type: 'separator' },
    { label: 'Chat…', click: () => openChatPanel() },
    { label: 'Tuck Away', click: () => brain.command('tuck') },
  ];
}

function showPetMenu() {
  const { pet } = ctx;
  if (!pet.alive()) return;
  Menu.buildFromTemplate(petMenuTemplate()).popup({ window: pet.win });
}

function settingsPayload() {
  const { position, ...s } = ctx.settings.all(); // eslint-disable-line no-unused-vars
  return {
    settings: s,
    providers: ai.publicProviders(),
    calendar: ctx.calendar ? ctx.calendar.status() : null,
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

  const meta = (ctx.meta = loadMeta());
  const pet = (ctx.pet = new PetWindow({ scale: settings.get('scale'), isolated: SELF_TEST }));
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
  ipcMain.on('pet:ready', (e) => {
    if (!fromPet(e)) return;
    pet.send('pet:init', {
      meta,
      sheet: sheetDataUrl(),
      scale: settings.get('scale'),
      workArea: pet.display().workArea,
      test: SELF_TEST,
      debug: !!process.env.SHADOW_DEBUG,
    });
    if (brain.state === 'off') {
      brain.start();
      syncDisplay(true);
      pet.win.showInactive();
      if (ctx.onStarted) ctx.onStarted();
    } else if (brain.anim) {
      pet.send('pet:anim', { name: brain.anim, facing: brain.facing });
    }
  });
  ipcMain.on('pet:interactive', (e, on) => fromPet(e) && pet.setInteractive(on));
  ipcMain.on('pet:click', (e) => fromPet(e) && brain.click());
  ipcMain.on('pet:dblclick', (e) => fromPet(e) && brain.dblclick());
  ipcMain.on('pet:ctrl-click', (e) => fromPet(e) && openChatPanel());
  ipcMain.on('pet:context-menu', (e) => fromPet(e) && showPetMenu());
  // Press & drag: follow the real cursor from here while the button is held (a non-focusable
  // window gets no mouse-move events mid-press on Windows). Polls only during a press.
  let press = null;
  ipcMain.on('pet:press-start', (e, p) => {
    if (!fromPet(e) || !validPt(p)) return;
    if (press) clearInterval(press.timer);
    const cur = { start: { x: p.x, y: p.y }, ctrl: !!p.ctrl, dragging: false };
    cur.timer = setInterval(() => {
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
  ipcMain.handle('pet:press-end', (e) => {
    if (!fromPet(e) || !press) return { dragged: false };
    clearInterval(press.timer);
    const dragged = press.dragging;
    press = null;
    if (dragged) {
      brain.dragMove(ctx.sensors.cursor());
      brain.dragEnd();
    }
    return { dragged };
  });
  ipcMain.on('pet:bubble-click', (e) => fromPet(e) && brain.bubbleClicked());
  ipcMain.on('pet:test-frame', (e, info) => fromPet(e) && ctx.onTestFrame && ctx.onTestFrame(info));

  // chat panel -> ai.js (all AI provider logic lives there)
  const aiContext = (over = {}) => {
    const provider = over.provider || settings.get('aiProvider');
    return {
      provider,
      model: over.model !== undefined ? over.model : settings.get('aiModel'),
      baseUrl: over.baseUrl !== undefined ? over.baseUrl : settings.get('aiBaseUrl'),
      apiKey: over.apiKey !== undefined ? over.apiKey : settings.get('apiKeys')[provider] || '',
      petName: settings.get('petName'),
      personality: config.personality,
    };
  };
  ipcMain.handle('chat:info', () => {
    const c = aiContext();
    const p = ai.PROVIDERS[c.provider];
    return { petName: c.petName, provider: p.label, ready: !p.needsKey || !!c.apiKey };
  });
  ipcMain.handle('chat:ask', async (_e, message) => {
    const text = String(message || '').trim().slice(0, 2000);
    if (!text) return '';
    const history = ctx.chatHistory;
    history.push({ role: 'user', text });
    const context = { ...aiContext(), history: history.slice(-20) };
    let reply;
    try {
      reply = await ai.chat(text, context);
      history.push({ role: 'pet', text: reply });
    } catch (err) {
      history.pop(); // keep error lines out of the conversation the AI sees
      if (!(err instanceof ai.AiError)) console.warn('[ai]', err);
      reply = ai.friendly(err, context);
    }
    brain.chatReply(reply);
    return reply;
  });
  ipcMain.handle('ai:test', (_e, form = {}) => {
    const over = {};
    if (typeof form.provider === 'string' && ai.PROVIDERS[form.provider]) over.provider = form.provider;
    for (const k of ['model', 'baseUrl', 'apiKey']) if (typeof form[k] === 'string') over[k] = form[k].slice(0, 500);
    return ai.testConnection(aiContext(over));
  });
  // "Get a free key" / "Open Google Calendar settings" buttons: only ever open these known pages
  ipcMain.on('settings:open-link', (_e, url) => {
    if (url === GCAL_SETTINGS_URL || ai.publicProviders().some((p) => p.keyUrl && p.keyUrl === url)) shell.openExternal(url);
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
    const allowed = ['petName', 'scale', 'quipMinMinutes', 'quipMaxMinutes', 'sleepTimeoutMinutes', 'muteQuips', 'aiProvider', 'aiModel', 'aiBaseUrl', 'apiKeys', 'calendarUrl', 'calendarLeadMinutes', 'calendarAtStart'];
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

  settings.on('change', (all, changed) => {
    if (changed.includes('scale')) {
      pet.setScale(all.scale);
      pet.send('pet:scale', { scale: all.scale });
      syncDisplay(true);
      brain.scaleChanged();
    }
    if (changed.includes('quipMinMinutes') || changed.includes('quipMaxMinutes')) brain.scheduleQuip();
  });

  ctx.trayCtl = createTray({
    brain,
    settings,
    loginItem: { get: () => ctx.loginItem.get(), set: (on) => ctx.loginItem.set(on) },
    actions: { openSettings, openConfigFolder, openChat: openChatPanel, quit },
  });

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
    brain.reminder(r);
  });
  calendar.start();

  powerMonitor.on('resume', () => {
    reminders.check();
    calendar.check();
    calendar.sync();
  });

  const onDisplays = () => {
    brain.displaysChanged();
    syncDisplay(true);
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
    const { brain, config, reminders, calendar } = ctx;
    try {
      if (brain && !['off', 'hidden'].includes(brain.state)) brain.savePosition();
    } catch {
      /* ignore */
    }
    if (brain) brain.stop();
    if (config) config.stop();
    if (reminders) reminders.stop();
    if (calendar) calendar.stop();
  });
}

module.exports = { ctx };
