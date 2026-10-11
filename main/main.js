'use strict';
/*
 * Shadow - desktop pet.
 * Main process entry: creates the pet window, brain, tray, reminders, calendar and IPC wiring.
 */

const { app, ipcMain, screen, Menu, shell, nativeTheme, powerMonitor, desktopCapturer } = require('electron');
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
const { TaskStore, parseCommand } = require('./tasks');
const search = require('./search');
const { AppLauncher, parsePcCommand, pcRequests } = require('./apps');
const { FriendsManager } = require('./friends');
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
  const items = [];
  if (ctx.updater && ctx.updater.ready) items.push({ label: `✨ Restart to Update (${ctx.updater.state.version})`, click: () => ctx.updater.install() });
  if (brain.activeReminder && !brain.reminderClosing) {
    const later = brain.activeReminder.kind === 'update';
    items.push({ label: later ? 'Update Later' : 'Dismiss Reminder', click: () => brain.dismissReminder('menu') });
  }
  if (items.length) items.push({ type: 'separator' });
  if (ctx.friends) items.push({ label: 'Call the Gang 🐾', click: () => ctx.friends.callGang() }, { type: 'separator' });
  return [
    ...items,
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
    update: ctx.updater ? ctx.updater.status() : null,
    friends: ctx.friends ? ctx.friends.info() : [],
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
  // Shadow's friends (friends.js) use the same renderer in their own windows
  const friends = (ctx.friends = new FriendsManager({ settings, brain, pet, assets: paths.ASSETS, isolated: SELF_TEST }));
  const friendOf = (e) => friends.forSender(e.sender);
  const friendMenu = (f) =>
    Menu.buildFromTemplate([
      { label: `${f.def.name} the ${f.def.animal} · ${f.def.job}`, enabled: false },
      { type: 'separator' },
      { label: 'Call the Gang 🐾', click: () => friends.callGang() },
      { label: `Send ${f.def.name} Home`, click: () => f.leave() },
      { label: 'Chat with Shadow…', click: () => openChatPanel() },
    ]).popup({ window: f.win.win });
  ipcMain.on('pet:ready', (e) => {
    if (!fromPet(e)) {
      const f = friendOf(e);
      if (f) f.onReady();
      return;
    }
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
      friends.start();
      syncDisplay(true);
      pet.win.showInactive();
      if (ctx.onStarted) ctx.onStarted();
    } else if (brain.anim) {
      pet.send('pet:anim', { name: brain.anim, facing: brain.facing });
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
  // Hover check that doesn't depend on Windows forwarding mouse moves (see pet.js onCursor).
  // Only talks to the renderer while the cursor is over the pet's window, so it costs ~nothing.
  const hover = (w) => {
    const c = ctx.sensors.cursor();
    const b = w.bounds();
    const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
    if (inside || w.cursorWasInside || w.interactive) {
      w.send('pet:cursor', { inside, x: c.x - b.x, y: c.y - b.y, interactive: w.interactive });
    }
    w.cursorWasInside = inside;
  };
  setInterval(() => {
    if (press || brain.dragging) return;
    if (pet.alive() && !pet.tucked) hover(pet);
    friends.windows().forEach(hover); // the friends get the same fix
  }, 60);
  powerMonitor.on('unlock-screen', () => pet.setInteractive(pet.interactive)); // re-arm click-through after locking

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
      petName: settings.get('petName'),
      personality: config.personality,
      // calendar text for the chat ('' = not connected); left out entirely if Prince switched it off
      ...(settings.get('calendarInChat') && ctx.calendar ? { calendar: ctx.calendar.chatContext() } : {}),
      tasks: ctx.tasks ? ctx.tasks.chatContext() : '',
    };
  };
  ctx.aiContext = aiContext;
  ipcMain.handle('chat:info', () => {
    const c = aiContext();
    const p = ai.PROVIDERS[c.provider];
    return { petName: c.petName, provider: p.label, ready: !p.needsKey || !!c.apiKey };
  });
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
  if (apps.windows) setTimeout(() => apps.refresh(), 8000); // read the Start menu once Shadow has settled
  const screenshotHelpers = {
    // Shadow and the chat panel step out of the picture for a moment
    beforeScreenshot: async () => {
      ctx.screenshotHidden = [pet.win, getChatWindow(), ...friends.windows().map((w) => w.win)].filter((w) => w && !w.isDestroyed() && w.isVisible());
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

  /** "call the gang", "send the gang home", "call atlas" */
  function gangCommand(text) {
    const l = text.trim().toLowerCase().replace(/[?.!]+$/, '');
    if (/^(?:call|bring|summon|show)(?: out)? (?:the |my )?(?:gang|friends|everyone|squad|team)(?: out)?$/.test(l)) {
      const n = friends.callGang();
      return n ? 'Gang, assemble! 🐾' : 'All my friends are switched off, Prince. Turn them on in Settings → Friends.';
    }
    if (/^(?:send|tell) (?:the |my )?(?:gang|friends|everyone) (?:home|away)$|^(?:bye|goodbye) (?:gang|friends|everyone)$/.test(l)) {
      friends.sendHome();
      return 'Bye gang! 👋';
    }
    const m = /^(?:call|bring|summon) (atlas|dash|bolt)$/.exec(l);
    if (m) {
      const f = friends.get(m[1]);
      if (!friends.enabled(f.id)) return `${f.def.name} is switched off, Prince. Turn them on in Settings → Friends.`;
      f.stayUntil = Date.now() + 30000;
      f.appear(() => f.clicked());
      setTimeout(() => !f.jobs && friends.afterJob(f), 32000);
      return `${f.def.name}! Come here 🐾`;
    }
    return null;
  }

  ipcMain.handle('chat:ask', async (_e, message) => {
    const text = String(message || '').trim().slice(0, 2000);
    if (!text) return { text: '' };
    const history = ctx.chatHistory;
    history.push({ role: 'user', text });
    let reply;
    const gang = gangCommand(text);
    if (gang) {
      history.push({ role: 'pet', text: gang });
      brain.chatReply(gang);
      return { text: gang, sources: [] };
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
      if (out) {
        history.push({ role: 'pet', text: out });
        brain.chatReply(out);
        return { text: out, sources: [] };
      }
      // "cancel"/"2" with nothing pending -> just chat
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
      brain.chatReply(out.text);
      return { text: out.text, sources: out.sources || [] };
    }
    // "remind me at 6 pm to call Mom", "todo: buy milk", "done 2", ... - handled right here,
    // so they work instantly, offline and without an AI key
    const cmd = parseCommand(text);
    if (cmd) {
      reply = ctx.tasks.run(cmd);
      dashFor(cmd.type, reply);
      history.push({ role: 'pet', text: reply });
      brain.chatReply(reply);
      return { text: reply, sources: [] };
    }
    const searchOn = settings.get('webSearch');
    const context = {
      ...aiContext(),
      search: searchOn ? search.aiInstructions(!!settings.get('searchKey')) : '',
      pc: settings.get('pcControl') ? apps.aiInstructions() : '',
      history: history.slice(-20),
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
    brain.chatReply(reply);
    return { text: reply, sources };
  });
  /** Shadow says it's searching and Atlas the parrot flies in. Returns Atlas's done(line). */
  function searchingBubble() {
    if (!brain.activeReminder && brain.state !== 'hidden') brain.say('🔍 Searching the internet…', { ms: 20000 });
    return friends.job('atlas', '🔍 On it, Prince!');
  }
  /** Dash the rabbit handles reminders and the to-do list. */
  function dashFor(type, reply) {
    if (/^(?:That time|I didn't|There's no|Your list is empty|No reminders|Too many|That's too far|Add what)/.test(reply)) return;
    const line = { remind: '📨 Noted - I\'ll deliver it!', 'todo-add': '📝 On the list!', 'todo-done': '✓ Crossed off!', 'todo-remove': '🗑️ Gone!', 'reminder-cancel': '✓ Cancelled!' }[type];
    if (line) friends.quickJob('dash', line, 3500);
  }
  // Dash also delivers reminders as they fire (not update notices or the morning briefing)
  brain.on('reminder-start', (r) => {
    if (!['update', 'briefing'].includes(r.kind) && !brain.reminderClosing) friends.quickJob('dash', '📨 Delivery for Prince!', 7000);
  });
  ipcMain.handle('ai:test', (_e, form = {}) => {
    const over = {};
    if (typeof form.provider === 'string' && ai.PROVIDERS[form.provider]) over.provider = form.provider;
    for (const k of ['model', 'baseUrl', 'apiKey']) if (typeof form[k] === 'string') over[k] = form[k].slice(0, 500);
    return ai.testConnection(aiContext(over));
  });
  // "Get a free key" / "Open Google Calendar settings" buttons: only ever open these known pages
  ipcMain.on('settings:open-link', (_e, url) => {
    if (url === GCAL_SETTINGS_URL || url === search.TAVILY_KEY_URL || ai.publicProviders().some((p) => p.keyUrl && p.keyUrl === url)) shell.openExternal(url);
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
    const allowed = ['petName', 'scale', 'quipMinMinutes', 'quipMaxMinutes', 'sleepTimeoutMinutes', 'muteQuips', 'aiProvider', 'aiModel', 'aiBaseUrl', 'apiKeys', 'calendarUrl', 'calendarLeadMinutes', 'calendarAtStart', 'calendarInChat', 'morningBriefing', 'todoNudges', 'webSearch', 'searchKey', 'pcControl', 'friendsMode', 'friends'];
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
    if (changed.includes('friendsMode') || changed.includes('friends')) friends.apply();
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

  ctx.trayCtl = createTray({
    brain,
    settings,
    loginItem: { get: () => ctx.loginItem.get(), set: (on) => ctx.loginItem.set(on) },
    actions: { openSettings, openConfigFolder, openChat: openChatPanel, quit },
    getUpdater: () => ctx.updater,
    callGang: () => ctx.friends.callGang(),
  });
  ctx.updater.on('status', () => ctx.trayCtl.rebuild());
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
    brain.reminder({ time: '', kind: 'briefing', key: 'briefing', icon: '☀️', head: 'YOUR DAY', hint: 'click to close ✓', message: tasks.briefing(Date.now(), cal.url() ? cal.upcoming : null) });
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
    const { brain, config, reminders, calendar, updater, friends } = ctx;
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
  });
}

module.exports = { ctx };
