'use strict';
// The transparent, frameless, always-on-top, click-through window the panther lives in.
//
// Geometry: the window is wider/taller than the panther so speech bubbles fit above it.
// The panther sprite box (S x S, S = 48 * scale) sits at the bottom-centre of the window.
// `pos` is the top-left of that sprite box in screen (DIP) coordinates.

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { PRELOAD, RENDERER } = require('./paths');

const CELL = 48;
const BUBBLE_SPACE = 175; // px above the sprite reserved for speech bubbles
const MIN_WIDTH = 320;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

class PetWindow {
  constructor({ scale = 2, isolated = false, cell = CELL, bubbleSpace = BUBBLE_SPACE, minWidth = MIN_WIDTH, title = 'Shadow' } = {}) {
    this.scale = scale;
    this.cell = cell; // sprite cell size (Shadow 48, friends 32)
    this.bubbleSpace = bubbleSpace;
    this.minWidth = minWidth;
    this.title = title;
    this.pos = { x: 0, y: 0 };
    this.win = null;
    this.interactive = false;
    this.tucked = false; // hidden on purpose (Tuck Away) - don't auto-restore
    // self-test: ignore the REAL mouse completely so a curious human can't disturb the
    // scripted (synthetic) input; the interactive flag is still tracked for the checks.
    this.isolated = isolated;
  }

  get S() {
    return this.cell * this.scale;
  }
  get W() {
    return Math.max(this.minWidth, this.S + 40);
  }
  get H() {
    return this.S + this.bubbleSpace;
  }

  create() {
    const b = this.bounds();
    this.win = new BrowserWindow({
      ...b,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      focusable: false, // clicking the pet never steals focus from your work
      title: this.title,
      webPreferences: {
        preload: path.join(PRELOAD, 'pet.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setIgnoreMouseEvents(true, { forward: !this.isolated });
    // If anything minimizes the pet (Win+D "Show desktop", Win+M, other tools) Windows collapses
    // it to a tiny ~160x28 iconic window and the panther vanishes. Pop straight back.
    this.win.on('minimize', () => {
      setTimeout(() => {
        if (!this.alive() || this.tucked) return;
        this.win.showInactive();
        this.win.setBounds(this.bounds());
        this.win.setAlwaysOnTop(true, 'screen-saver');
      }, 60);
    });
    this.win.on('restore', () => this.alive() && this.win.setBounds(this.bounds()));
    // the page crashed (GPU hiccup after sleep, low memory...): load it again instead of leaving a
    // frozen, unclickable picture on screen
    this.win.webContents.on('render-process-gone', () => {
      setTimeout(() => this.alive() && this.win.webContents.isCrashed() && this.win.webContents.reload(), 400);
    });
    this.win.loadFile(path.join(RENDERER, 'pet', 'index.html'));
    return this.win;
  }

  alive() {
    return this.win && !this.win.isDestroyed();
  }

  bounds() {
    return {
      x: Math.round(this.pos.x - (this.W - this.S) / 2),
      y: Math.round(this.pos.y - (this.H - this.S)),
      width: this.W,
      height: this.H,
    };
  }

  moveTo(x, y) {
    this.pos = { x, y };
    // Always pass width/height too: avoids size drift on fractional DPI scaling.
    if (this.alive()) this.win.setBounds(this.bounds());
  }

  center() {
    return { x: Math.round(this.pos.x + this.S / 2), y: Math.round(this.pos.y + this.S / 2) };
  }

  display() {
    return screen.getDisplayNearestPoint(this.center());
  }

  /** y (top of sprite box) where the panther stands on the bottom edge of the work area (above the taskbar). */
  floorY(d = this.display()) {
    return d.workArea.y + d.workArea.height - this.S;
  }

  xRange(d = this.display()) {
    return [d.workArea.x, d.workArea.x + d.workArea.width - this.S];
  }

  /** Keep the panther inside a display's work area (and leave room for its bubble above). */
  clamp(x, y, d = this.display()) {
    const wa = d.workArea;
    const floor = this.floorY(d);
    const top = Math.min(floor, wa.y + (this.H - this.S));
    return { x: clamp(x, wa.x, wa.x + wa.width - this.S), y: clamp(y, top, floor) };
  }

  setScale(scale) {
    const cx = this.pos.x + this.S / 2;
    const bottom = this.pos.y + this.S;
    const d = this.display();
    this.scale = scale;
    const p = this.clamp(cx - this.S / 2, bottom - this.S, d);
    this.moveTo(p.x, p.y);
  }

  setInteractive(on) {
    this.interactive = !!on;
    if (this.alive() && !this.isolated) this.win.setIgnoreMouseEvents(!on, { forward: true });
  }

  send(channel, data) {
    if (this.alive()) this.win.webContents.send(channel, data);
  }
}

module.exports = { PetWindow, CELL, BUBBLE_SPACE };
