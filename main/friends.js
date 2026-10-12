'use strict';
/*
 * friends.js - Shadow's gang. Each friend is a small pixel animal in its own click-through window
 * (same renderer as Shadow) with one job:
 *
 *   Atlas  parrot  Researcher  flies in with a magnifying glass while Shadow searches the internet
 *   Dash   rabbit  Messenger   hops in with a letter for reminders and to-do changes
 *   Bolt   monkey  Launcher    swings in with a lightning bolt when opening apps / PC controls
 *
 * Display (Settings -> Friends):
 *   always      the enabled friends hang around Shadow all the time
 *   working     a friend only appears while it has a job, then leaves
 *   occasional  jobs + a short playdate with Shadow now and then
 * "Call the gang" (tray, right-click menu, Settings, or say "call the gang") brings everyone out.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { PetWindow } = require('./petWindow');
const appearance = require('./appearance');

const CELL = 32;
const STEP_MS = 33;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const DEFS = [
  {
    id: 'atlas',
    name: 'Atlas',
    animal: 'parrot',
    job: 'Researcher',
    blurb: 'searches the internet for you',
    flies: true,
    slot: -1,
    speed: 220,
    hello: ['Atlas here! Ask me anything - I fly fast 🦜', 'Need facts? I\'ll fetch them, Prince 🔍', 'Squawk! Research department, at your service.'],
    play: ['Wheee! 🦜', 'Catch me if you can, Shadow!', 'Squawk squawk!'],
  },
  {
    id: 'dash',
    name: 'Dash',
    animal: 'rabbit',
    job: 'Messenger',
    blurb: 'delivers your reminders and keeps your to-do list',
    slot: 1,
    speed: 170,
    hello: ['Dash, at your service! Got any notes for me? 📨', 'I never forget a reminder, Prince 🐇', 'Hop hop! Messenger reporting.'],
    play: ['Hop hop hop! 🐇', 'Bet I can jump higher, Shadow!', 'Zoomies!'],
  },
  {
    id: 'bolt',
    name: 'Bolt',
    animal: 'monkey',
    job: 'Launcher',
    blurb: 'opens your apps, folders and PC controls',
    slot: -2,
    speed: 150,
    hello: ['Bolt here! Need an app opened? ⚡', 'Say "open spotify" and watch me go 🐒', 'Lightning-fast launcher, reporting!'],
    play: ['Ooh ooh aah aah! 🐒', 'Tag, Shadow - you\'re it!', 'Banana break!'],
  },
  {
    id: 'sage',
    name: 'Sage',
    animal: 'owl',
    job: 'Tutor',
    blurb: 'teaches you step by step, quizzes you and checks homework',
    flies: true,
    perch: true, // sits on Shadow's head while teaching
    slot: 2,
    speed: 200,
    hello: ['Hoo! Sage here. Say "teach me ..." or "quiz me on ..." 🦉', 'Knowledge is power, Prince. What shall we learn? 📚', 'Hoo hoo! Homework trouble? Say "check my answer: ..."'],
    play: ['Hoo hoo! 🦉', 'Did you know owls can turn their heads 270°?', 'Wise AND fun!'],
  },
  {
    id: 'zen',
    name: 'Zen',
    animal: 'turtle',
    job: 'PC caretaker',
    blurb: 'watches battery, storage, RAM and internet, and tidies your Downloads',
    slot: -3,
    speed: 90,
    hello: ['Zen here. Slow and steady keeps your PC healthy 🐢', 'Say "pc health" for a checkup, Prince.', 'Messy Downloads? Say "tidy my downloads".'],
    play: ['Slow... and... steady 🐢', 'Race you, Shadow! ...eventually.', 'Zen mode: on.'],
  },
  {
    id: 'tempo',
    name: 'Tempo',
    animal: 'penguin',
    job: 'Music DJ',
    blurb: 'plays, pauses and skips your music and finds playlists',
    slot: 3,
    speed: 140,
    hello: ['Tempo on the decks! Say "play something chill" 🎧', 'DJ Tempo in the house! 🐧🎵', 'Say "next song" or "what\'s playing" anytime.'],
    play: ['🎵 Untz untz untz 🎵', 'Dance with me, Shadow!', 'Drop the beat! 🐧'],
  },
];

class Friend {
  constructor(def, mgr) {
    this.def = def;
    this.mgr = mgr;
    this.win = null;
    this.ready = false;
    this.state = 'away'; // away | arriving | here | leaving
    this.jobs = 0; // jobs in progress (stay while > 0)
    this.stayUntil = 0;
    this.pos = { x: 0, y: 0 };
    this.facing = 'right';
    this.anim = null;
    this.mover = null;
    this.timers = new Set();
    this.meta = JSON.parse(fs.readFileSync(path.join(mgr.assets, 'friends', `${def.id}.json`), 'utf8'));
  }

  get id() {
    return this.def.id;
  }

  ensureWindow() {
    if (this.win && this.win.alive()) return this.win;
    this.ready = false;
    this.win = new PetWindow({ scale: this.mgr.scale(), isolated: this.mgr.isolated, cell: CELL, bubbleSpace: 120, minWidth: 220, title: this.def.name });
    this.win.pos = { ...this.pos };
    this.win.create();
    return this.win;
  }

  onReady() {
    this.ready = true;
    const w = this.win;
    w.send('pet:init', { meta: this.meta, sheet: this.mgr.sheet(this.id), scale: this.mgr.scale(), workArea: w.display().workArea, appearance: this.mgr.settings.get('appearance'), test: false });
    if (this.state !== 'away') {
      w.win.showInactive();
      w.win.setAlwaysOnTop(true, 'screen-saver');
      if (this.anim) this.play(this.anim.name, true);
    }
  }

  after(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.stopMove();
  }

  play(name, force = false) {
    if (!force && this.anim && this.anim.name === name && this.anim.facing === this.facing) return;
    this.anim = { name, facing: this.facing };
    if (this.ready) this.win.send('pet:anim', { name, facing: this.facing });
  }

  /** Say it now, or as soon as the friend has arrived. */
  sayWhenHere(text, ms) {
    if (this.state === 'here') return this.say(text, ms);
    this.pendingSay = { text, ms };
    return 0;
  }

  say(text, ms) {
    if (!text || !this.ready || this.state === 'away') return 0;
    const dur = ms || Math.min(7000, 2200 + text.length * 50);
    this.win.send('pet:bubble', { text, sticky: false });
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => this.ready && this.win && this.win.alive() && this.win.send('pet:bubble-hide'), dur);
    return dur;
  }

  floorY() {
    const wa = this.mgr.display().workArea;
    return wa.y + wa.height - (this.win ? this.win.S : CELL * this.mgr.scale());
  }

  stopMove() {
    clearInterval(this.mover);
    this.mover = null;
  }

  place(x, y) {
    this.pos = { x, y };
    if (this.win && this.win.alive()) this.win.moveTo(x, y);
  }

  /** Walk/hop/fly to x (and y), then call then(). */
  moveTo(tx, ty, then) {
    this.stopMove();
    this.facing = tx >= this.pos.x ? 'right' : 'left';
    this.play('move', true);
    const sx = this.pos.x;
    const sy = this.pos.y;
    const dist = Math.hypot(tx - sx, ty - sy);
    const speed = this.def.speed * this.mgr.scale() * 0.5;
    const total = Math.min(3500, Math.max(400, (dist / speed) * 1000)); // long trips go faster
    const t0 = Date.now();
    this.mover = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / total);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      // flyers swoop in along an arc; walkers stay on the floor
      const arc = this.def.flies ? Math.sin(k * Math.PI) * -Math.min(160, dist * 0.35) : 0;
      this.place(sx + (tx - sx) * e, sy + (ty - sy) * e + arc);
      if (k >= 1) {
        this.stopMove();
        if (then) then();
      }
    }, STEP_MS);
  }

  /** Come on screen next to Shadow. */
  appear(then) {
    if (this.state === 'here' || this.state === 'arriving') {
      if (then) (this.state === 'here' ? then() : (this.arrived = then));
      return;
    }
    this.clearTimers();
    const w = this.ensureWindow();
    const d = this.mgr.display();
    const wa = d.workArea;
    const perch = this.def.perch && this.jobs > 0;
    const target = perch ? this.mgr.perchX(this) : this.mgr.slotX(this);
    const fromLeft = target < wa.x + wa.width / 2;
    const startX = fromLeft ? wa.x - w.S - 10 : wa.x + wa.width + 10;
    const floor = perch ? this.mgr.perchY(this) : wa.y + wa.height - w.S;
    this.place(startX, this.def.flies ? floor - 220 : floor);
    this.state = 'arriving';
    this.arrived = then;
    if (this.ready) {
      w.send('pet:resume');
      w.win.showInactive();
      w.win.setAlwaysOnTop(true, 'screen-saver');
    }
    this.moveTo(target, floor, () => {
      this.state = 'here';
      this.facing = this.mgr.shadowX() >= this.pos.x ? 'right' : 'left';
      this.play('idle', true);
      const cb = this.arrived;
      this.arrived = null;
      this.mgr.emit('arrived', this);
      if (cb) cb();
      this.scheduleIdle();
    });
  }

  /** Walk off the nearest screen edge and hide. */
  leave(then) {
    if (this.state === 'away' || this.state === 'leaving') return then && then();
    this.clearTimers();
    this.state = 'leaving';
    const w = this.win;
    const wa = this.mgr.display().workArea;
    const goLeft = this.pos.x + w.S / 2 < wa.x + wa.width / 2;
    const tx = goLeft ? wa.x - w.S - 10 : wa.x + wa.width + 10;
    this.moveTo(tx, this.def.flies ? this.pos.y - 200 : this.pos.y, () => this.hideNow(then));
  }

  hideNow(then) {
    this.clearTimers();
    this.state = 'away';
    this.jobs = 0;
    if (this.win && this.win.alive()) {
      this.win.send('pet:bubble-hide');
      this.win.send('pet:pause');
      this.win.setInteractive(false);
      this.win.win.hide();
    }
    this.mgr.emit('left', this);
    if (then) then();
  }

  /** Do a job: come over, play the work animation, say the line. Returns a done(text) function. */
  work(line) {
    this.jobs++;
    let finished = false;
    const start = () => {
      if (finished) return;
      this.clearTimers();
      this.facing = this.mgr.shadowX() >= this.pos.x ? 'right' : 'left';
      this.play('work', true);
      const later = this.pendingSay; // something to say that arrived while flying in
      this.pendingSay = null;
      if (later) this.say(later.text, later.ms);
      else this.say(line, 60000);
    };
    const toPerch = () => {
      // Sage teaches from Shadow's head
      const px = this.mgr.perchX(this);
      const py = this.mgr.perchY(this);
      if (Math.hypot(this.pos.x - px, this.pos.y - py) < 4) return start();
      this.moveTo(px, py, start);
    };
    if (this.state === 'here') (this.def.perch ? toPerch() : start());
    else this.appear(start);
    return (doneLine) => {
      if (finished) return;
      finished = true;
      this.jobs = Math.max(0, this.jobs - 1);
      const wrapUp = () => {
        this.play('talk', true);
        const ms = doneLine ? this.say(doneLine) : 1500;
        this.after(Math.max(1800, ms), () => {
          if (this.jobs) return;
          this.play('idle', true);
          this.mgr.afterJob(this);
        });
      };
      if (this.state === 'here') wrapUp();
      else this.arrived = wrapUp;
    };
  }

  /** A job with a fixed duration. */
  quickJob(line, ms = 4000) {
    const done = this.work(line);
    this.jobTimer = setTimeout(() => done(), ms);
  }

  /** While on screen: idle, wander a little, stay near Shadow, sleep when Shadow sleeps. */
  scheduleIdle() {
    this.after(rand(4000, 9000), () => {
      if (this.state !== 'here' || this.jobs) return this.state === 'here' && this.scheduleIdle();
      if (!this.mgr.shouldStay(this)) return this.leave(); // job/playdate/gang time is over
      const shadow = this.mgr.shadowState();
      if (shadow === 'sleep') {
        this.play('sleep');
        return this.scheduleIdle();
      }
      if (this.dancing) {
        this.play('play');
        return this.scheduleIdle();
      }
      const want = this.mgr.slotX(this);
      if (Math.abs(this.pos.x - want) > 140 || Math.abs(this.pos.y - this.floorY()) > 2) {
        return this.moveTo(want, this.floorY(), () => {
          this.play('idle', true);
          this.scheduleIdle();
        });
      }
      const r = Math.random();
      if (r < 0.2) {
        const wa = this.mgr.display().workArea;
        const nx = Math.max(wa.x, Math.min(wa.x + wa.width - this.win.S, this.pos.x + rand(-60, 60)));
        return this.moveTo(nx, this.floorY(), () => {
          this.play('idle', true);
          this.scheduleIdle();
        });
      }
      this.facing = this.mgr.shadowX() >= this.pos.x ? 'right' : 'left';
      this.play(r < 0.3 ? 'play' : 'idle', true);
      this.scheduleIdle();
    });
  }

  playdate(ms = 4000) {
    if (this.state !== 'here' || this.jobs) return;
    this.clearTimers();
    this.facing = this.mgr.shadowX() >= this.pos.x ? 'right' : 'left';
    this.play('play', true);
    if (Math.random() < 0.6) this.say(pick(this.def.play), 2500);
    this.after(ms, () => {
      this.play('idle', true);
      this.scheduleIdle();
    });
  }

  clicked() {
    if (this.state !== 'here') return;
    this.clearTimers();
    this.play('talk', true);
    const ms = this.say(`${pick(this.def.hello)} (${appearance.friendLabel(this.def)})`, 5000);
    this.after(ms, () => {
      this.play('idle', true);
      this.scheduleIdle();
    });
  }

  destroy() {
    this.clearTimers();
    clearTimeout(this.jobTimer);
    clearTimeout(this.bubbleTimer);
    if (this.win && this.win.alive()) this.win.win.destroy();
  }
}

class FriendsManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./settings').Settings} o.settings
   * @param {import('./brain').Brain} o.brain
   * @param {import('./petWindow').PetWindow} o.pet
   * @param {string} o.assets  assets folder
   */
  constructor({ settings, brain, pet, assets, isolated = false }) {
    super();
    this.settings = settings;
    this.brain = brain;
    this.pet = pet;
    this.rootAssets = assets;
    this.assets = appearance.assetsDir(assets, settings);
    this.isolated = isolated;
    this.list = DEFS.map((d) => new Friend(appearance.friendDef(d, settings), this));
    this.sheets = {};
    this.gangUntil = 0;
    this.playTimer = null;
    this.tick = null;
  }

  get(id) {
    return this.list.find((f) => f.id === id);
  }

  // Keep the same Friend objects, jobs and switches when changing appearance.
  setAppearance() {
    this.assets = appearance.assetsDir(this.rootAssets, this.settings);
    this.sheets = {};
    this.list.forEach((f, i) => {
      f.def = appearance.friendDef(DEFS[i], this.settings);
      f.meta = JSON.parse(fs.readFileSync(path.join(this.assets, 'friends', `${f.id}.json`), 'utf8'));
      if (f.win && f.win.alive()) {
        f.win.win.setTitle(f.def.name);
        f.onReady();
      }
    });
  }

  enabled(id) {
    const map = this.settings.get('friends') || {};
    return map[id] !== false;
  }

  mode() {
    return this.settings.get('friendsMode');
  }

  scale() {
    return this.settings.get('scale');
  }

  display() {
    return this.pet.display();
  }

  shadowX() {
    return this.pet.pos.x + this.pet.S / 2;
  }

  shadowState() {
    return this.brain.state;
  }

  sheet(id) {
    if (!this.sheets[id]) this.sheets[id] = 'data:image/png;base64,' + fs.readFileSync(path.join(this.assets, 'friends', `${id}.png`)).toString('base64');
    return this.sheets[id];
  }

  /** Where a friend stands: next to Shadow, each on its own side/slot. */
  slotX(friend) {
    const wa = this.display().workArea;
    const S = friend.win ? friend.win.S : CELL * this.scale();
    const gap = S + 6 * this.scale();
    const cx = this.shadowX();
    const side = friend.def.slot;
    let x = side < 0 ? cx - this.pet.S / 2 - gap * -side : cx + this.pet.S / 2 + gap * (side - 1) + 6;
    // no room on that side (Shadow at the screen edge)? use the other side
    if (x < wa.x || x > wa.x + wa.width - S) x = side < 0 ? cx + this.pet.S / 2 + gap * (-side - 1) + 6 : cx - this.pet.S / 2 - gap * side;
    return Math.max(wa.x, Math.min(wa.x + wa.width - S, x));
  }

  /** Sage's perch: on top of Shadow's head. */
  perchX(friend) {
    const S = friend.win ? friend.win.S : CELL * this.scale();
    return this.shadowX() - S / 2 + 4 * this.scale();
  }

  perchY(friend) {
    const S = friend.win ? friend.win.S : CELL * this.scale();
    return this.pet.pos.y - S + 12 * this.scale();
  }

  forSender(wc) {
    return this.list.find((f) => f.win && f.win.alive() && f.win.win.webContents === wc) || null;
  }

  windows() {
    return this.list.filter((f) => f.win && f.win.alive() && f.state !== 'away').map((f) => f.win);
  }

  start() {
    this.apply();
    this.scheduleOccasional();
    this.brain.on('state', (s, prev) => {
      if (s === 'hidden') this.list.forEach((f) => f.state !== 'away' && f.hideNow());
      else if (prev === 'hidden') this.apply();
    });
  }

  stop() {
    clearTimeout(this.playTimer);
    this.list.forEach((f) => f.destroy());
  }

  /** Bring friends out / send them home to match the mode and switches. */
  apply() {
    const hidden = this.brain.state === 'hidden';
    this.list.forEach((f, i) => {
      const wanted = !hidden && this.enabled(f.id) && (this.mode() === 'always' || f.jobs > 0 || Date.now() < this.gangUntil);
      if (wanted && f.state === 'away') setTimeout(() => f.appear(), i * 700);
      else if (!wanted && f.state !== 'away' && !f.jobs) f.leave();
    });
  }

  /** Should this friend still be on screen? */
  shouldStay(f) {
    if (!this.enabled(f.id) || this.brain.state === 'hidden') return false;
    return f.jobs > 0 || this.mode() === 'always' || Date.now() < this.gangUntil || Date.now() < f.stayUntil;
  }

  /** After a job: stay (always / gang time) or go home. */
  afterJob(f) {
    if (this.shouldStay(f)) return f.scheduleIdle();
    f.leave();
  }

  /** Start a job for a friend. Returns done(line) - or a no-op if that friend is switched off. */
  job(id, line) {
    const f = this.get(id);
    if (!f || !this.enabled(id) || this.brain.state === 'hidden') return () => {};
    return f.work(line);
  }

  quickJob(id, line, ms) {
    const f = this.get(id);
    if (!f || !this.enabled(id) || this.brain.state === 'hidden') return false;
    f.quickJob(line, ms);
    return true;
  }

  /** Everyone out together for a while; they say hi and play with Shadow. */
  callGang(ms = 45000) {
    const out = this.list.filter((f) => this.enabled(f.id));
    if (!out.length || this.brain.state === 'hidden') return 0;
    this.gangUntil = Date.now() + ms;
    let arrived = 0;
    this.gangTimers = (this.gangTimers || []).concat(out.map((f, i) =>
      setTimeout(
        () =>
          Date.now() < this.gangUntil &&
          f.appear(() => {
            arrived++;
            f.after(i * 1500, () => {
              f.play('talk', true);
              f.say(pick(f.def.hello), 3500);
              f.after(3500, () => f.playdate(3000));
            });
            if (arrived === out.length) this.shadowJoins();
          }),
        i * 500
      )
    ));
    clearTimeout(this.gangTimer);
    this.gangTimer = setTimeout(() => this.apply(), ms + 500);
    return out.length;
  }

  sendHome() {
    this.gangUntil = 0;
    (this.gangTimers || []).forEach(clearTimeout); // friends who hadn't set off yet stay home
    this.gangTimers = [];
    // friends still on a job finish it first, then leave (afterJob)
    this.list.forEach((f) => {
      f.stayUntil = 0;
      if (f.state !== 'away' && !f.jobs) f.leave();
    });
  }

  /** Shadow plays along when the gang is around. */
  shadowJoins() {
    const b = this.brain;
    if (b.busy() || ['sleep', 'hidden', 'off', 'drag', 'fall', 'pounce'].includes(b.state)) return;
    b.interrupt();
    b.setState('happy');
    b.play('happy');
    b.say(appearance.isAvengers(this.settings) ? 'Avengers, assemble! ⚡' : 'The gang is here! 🐾', { ms: 3000 });
    b.after(3200, () => b.rest());
  }

  /** "Occasional" mode: a short playdate now and then. */
  scheduleOccasional() {
    clearTimeout(this.playTimer);
    this.playTimer = setTimeout(() => {
      this.scheduleOccasional();
      if (this.mode() !== 'occasional' || this.brain.state !== 'idle' && this.brain.state !== 'sit' && this.brain.state !== 'walk') return;
      const out = this.list.filter((f) => this.enabled(f.id) && f.state === 'away');
      if (!out.length) return;
      const who = out.sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.5 ? 1 : 2);
      who.forEach((f) => {
        f.stayUntil = Date.now() + 70000;
        f.appear(() => f.playdate(4000));
        setTimeout(() => !f.jobs && this.mode() !== 'always' && Date.now() > this.gangUntil && f.leave(), 75000);
      });
    }, rand(40, 80) * 60 * 1000);
  }

  setScale(scale) {
    this.list.forEach((f) => {
      if (!f.win || !f.win.alive()) return;
      f.win.setScale(scale);
      f.pos = { ...f.win.pos };
      f.win.send('pet:scale', { scale });
    });
  }

  info() {
    return this.list.map((f) => ({ id: f.id, name: f.def.name, animal: f.def.animal, icon: f.def.icon, job: f.def.job, blurb: f.def.blurb, enabled: this.enabled(f.id), state: f.state }));
  }
}

module.exports = { FriendsManager, DEFS };
