'use strict';
// Secondary windows: the mini chat panel (Ctrl+Click) and the Settings window.

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { PRELOAD, RENDERER, ASSETS } = require('./paths');

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function lockDown(win) {
  // No navigation, no popups: these windows only ever show our local pages.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

let chatWin = null;
let settingsWin = null;
let identity = { name: 'Shadow', assets: ASSETS };
function setAppearance(name, assets) {
  identity = { name, assets };
  if (chatWin && !chatWin.isDestroyed()) { chatWin.setTitle(`Chat with ${name}`); chatWin.setIcon(path.join(assets, 'icon.png')); }
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.setTitle(`${name} Settings`); settingsWin.setIcon(path.join(assets, 'icon.png')); }
}

/** Open (or focus) the chat panel next to the panther. */
function openChat(pet, { onOpen, onClose } = {}) {
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.show();
    chatWin.focus();
    return chatWin;
  }
  const W = 360, H = 480;
  const d = pet.display();
  const wa = d.workArea;
  const c = pet.center();
  // prefer the side of the panther with more room
  const x = c.x - wa.x > wa.x + wa.width - c.x ? c.x - pet.S / 2 - W - 10 : c.x + pet.S / 2 + 10;
  const y = pet.pos.y + pet.S - H;
  chatWin = new BrowserWindow({
    x: Math.round(clamp(x, wa.x, wa.x + wa.width - W)),
    y: Math.round(clamp(y, wa.y, wa.y + wa.height - H)),
    width: W,
    height: H,
    minWidth: 300,
    minHeight: 360,
    frame: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#120e1c',
    title: `Chat with ${identity.name}`,
    icon: path.join(identity.assets, 'icon.png'),
    webPreferences: {
      preload: path.join(PRELOAD, 'chat.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  lockDown(chatWin);
  chatWin.loadFile(path.join(RENDERER, 'chat', 'index.html'));
  chatWin.once('ready-to-show', () => chatWin.show());
  chatWin.on('closed', () => {
    chatWin = null;
    if (onClose) onClose();
  });
  if (onOpen) onOpen();
  return chatWin;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  const { workArea: wa } = screen.getPrimaryDisplay();
  const W = 520, H = 720;
  settingsWin = new BrowserWindow({
    width: W,
    height: Math.min(H, wa.height - 40),
    x: Math.round(wa.x + (wa.width - W) / 2),
    y: Math.round(wa.y + Math.max(20, (wa.height - H) / 2)),
    minWidth: 440,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#120e1c',
    title: `${identity.name} Settings`,
    icon: path.join(identity.assets, 'icon.png'),
    webPreferences: {
      preload: path.join(PRELOAD, 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  settingsWin.setMenu(null);
  lockDown(settingsWin);
  settingsWin.loadFile(path.join(RENDERER, 'settings', 'index.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => (settingsWin = null));
  return settingsWin;
}

const getChatWindow = () => (chatWin && !chatWin.isDestroyed() ? chatWin : null);

/**
 * The see-through layer the "catch the treat" treats fall in (games.js). Covers the work area,
 * ignores the mouse completely (clicks go through) and never takes focus.
 */
function openGameLayer(wa, pet) {
  const win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    title: 'Catch the treat',
    webPreferences: {
      preload: path.join(PRELOAD, 'game.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  lockDown(win);
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  let ready = false;
  win.loadFile(path.join(RENDERER, 'game', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    ready = true;
    if (win.isDestroyed()) return;
    win.showInactive();
    if (pet && pet.alive()) pet.win.moveTop(); // Shadow stays in front of the treats
  });
  return {
    win,
    send: (state) => ready && !win.isDestroyed() && win.webContents.send('game:state', state),
    close: () => !win.isDestroyed() && win.destroy(),
  };
}
const getSettingsWindow = () => (settingsWin && !settingsWin.isDestroyed() ? settingsWin : null);

/**
 * The Iron Man HUD (hud.js): a see-through layer over the work area. Click-through and never takes
 * focus; HudDisplay turns the mouse on only while the cursor is over one of its panels.
 */
function openHudWindow(wa, { test = false } = {}) {
  const win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    title: 'HUD',
    webPreferences: {
      preload: path.join(PRELOAD, 'hud.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required', // the short power-up sound
    },
  });
  lockDown(win);
  win.setIgnoreMouseEvents(true, { forward: !test });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.on('minimize', () => setTimeout(() => !win.isDestroyed() && win.restore(), 60)); // Win+D
  win.loadFile(path.join(RENDERER, 'hud', 'index.html'));
  return {
    win,
    alive: () => !win.isDestroyed(),
    send: (channel, payload) => !win.isDestroyed() && win.webContents.send(channel, payload),
  };
}

module.exports = { openChat, openSettings, getChatWindow, getSettingsWindow, lockDown, openGameLayer, openHudWindow, setAppearance };
