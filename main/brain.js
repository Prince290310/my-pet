'use strict';
/*
 * brain.js - Shadow's behaviour state machine (runs in the main process).
 *
 * States: idle | walk | sit | groom | stretch | pounce | fall | talk | happy |
 *         sleep | waking | drag | reminder | hidden | game
 *
 * The brain decides what to do, moves the window, and tells the renderer which animation
 * to play / what to say through events:
 *   'anim'        { name, facing, fps? }
 *   'bubble'      { text, sticky }
 *   'bubble-hide'
 *   'visibility'  true | false        (tuck away / wake)
 *   'state'       (state, prevState)
 *   'reminder-start' | 'reminder-shown' | 'reminder-dismissed'  (reminder)
 */

const { EventEmitter } = require('events');
const appearance = require('./appearance');
const heroMotion = require('./hero-motion');

const MOVE_HZ = 30; // window movement updates per second (pixel animation itself is capped at 12 fps)

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function pickWeighted(items) {
  let r = Math.random() * items.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of items) if ((r -= w) <= 0) return v;
  return items[0][0];
}

class Brain extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./petWindow').PetWindow} o.pet
   * @param {import('./settings').Settings} o.settings
   * @param {import('./config').ConfigStore} o.config
   * @param {object} o.meta     sprite metadata (assets/sprites.json)
   * @param {object} o.sensors  { idleSeconds(): number, cursor(): {x,y}, displayAt({x,y}) }
   */
  constructor({ pet, settings, config, meta, sensors }) {
    super();
    this.pet = pet;
    this.settings = settings;
    this.config = config;
    this.meta = meta;
    this.sensors = sensors;

    this.state = 'off';
    this.facing = 'right';
    this.anim = null;
    this.timers = new Set();
    this.mover = null;
    this.dragging = false;
    this.chatOpen = false;
    this.reminderQueue = [];
    this.activeReminder = null;
    this.reminderClosing = false;
    this.bubble = null;
    this.sleepInfo = null;
    this.gaming = false; // catch the treat (games.js) is steering
  }

  // ------------------------------------------------------------------ plumbing
  get scale() {
    return this.settings.get('scale');
  }
  get muted() {
    return this.settings.get('muteQuips');
  }
  get pos() {
    return this.pet.pos;
  }

  after(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  /** Cancel whatever the panther was doing (timers + movement). */
  interrupt() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.stopMove();
  }

  setState(s) {
    if (this.state === s) return;
    const prev = this.state;
    this.state = s;
    this.emit('state', s, prev);
  }

  animMs(name, loops = 1) {
    const a = this.meta.animations[name];
    return a ? Math.round((a.frames / a.fps) * 1000 * loops) : 1000;
  }

  play(name, opts = {}) {
    this.anim = name;
    this.emit('anim', { name, facing: this.facing, fps: opts.fps });
  }

  /** Show a speech bubble. Returns how long it stays (ms). Sticky bubbles stay until clicked. */
  say(text, { sticky = false, ms, head, hint } = {}) {
    if (!text) return 0;
    const dur = ms || clamp(2600 + text.length * 55, 2600, 9000);
    this.bubble = { text, sticky, head, hint };
    clearTimeout(this.bubbleTimer);
    this.emit('bubble', { text, sticky, head, hint });
    if (!sticky) this.bubbleTimer = setTimeout(() => this.hideBubble(), dur);
    return dur;
  }

  hideBubble() {
    clearTimeout(this.bubbleTimer);
    if (!this.bubble) return;
    this.bubble = null;
    this.emit('bubble-hide');
  }

  quip(category) {
    return appearance.quip(this.settings, category, () => this.config.pick(category, { name: this.settings.get('petName') }));
  }

  startMove(step) {
    this.stopMove();
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      step(dt);
    }, 1000 / MOVE_HZ);
    this.mover = id;
  }

  stopMove() {
    if (this.mover) clearInterval(this.mover);
    this.mover = null;
  }

  display() {
    return this.pet.display();
  }
  floorY() {
    return this.pet.floorY(this.display());
  }
  onFloor() {
    return Math.abs(this.pos.y - this.floorY()) < 2;
  }
  cursorDist(c = this.sensors.cursor()) {
    const m = this.pet.center();
    return Math.hypot(c.x - m.x, c.y - m.y);
  }
  wakeRadius() {
    return this.pet.S / 2 + 70;
  }
  busy() {
    return !!(this.activeReminder || this.chatOpen || this.dragging || this.gaming);
  }

  // ------------------------------------------------------------------ lifecycle
  start() {
    this.place();
    this.sensorTimer = setInterval(() => this.sense(), 400);
    this.scheduleQuip();
    this.setState('waking');
    this.facing = Math.random() < 0.5 ? 'left' : 'right';
    const intro = appearance.isAvengers(this.settings) ? 'arrive' : 'stretch';
    this.play(intro);
    this.after(this.animMs(intro) + 150, () => {
      if (!this.muted) this.say(this.quip('greetings'));
      this.rest(rand(2500, 4500));
    });
  }

  stop() {
    this.interrupt();
    clearInterval(this.sensorTimer);
    clearTimeout(this.quipTimer);
    clearTimeout(this.bubbleTimer);
    clearTimeout(this.closeTimer);
  }

  /** Put the panther somewhere valid: last saved spot if it's still on a screen, else the primary floor. */
  place() {
    const saved = this.settings.get('position');
    if (saved) {
      const d = this.sensors.displayAt({ x: saved.x + this.pet.S / 2, y: saved.y + this.pet.S / 2 });
      const wa = d.workArea;
      if (saved.x >= wa.x - 10 && saved.x <= wa.x + wa.width && saved.y >= wa.y - 10 && saved.y <= wa.y + wa.height) {
        const p = this.pet.clamp(saved.x, saved.y, d);
        return this.pet.moveTo(p.x, p.y);
      }
    }
    const d = this.sensors.primary();
    const [minX, maxX] = this.pet.xRange(d);
    this.pet.moveTo(rand(minX + (maxX - minX) * 0.55, minX + (maxX - minX) * 0.85), this.pet.floorY(d));
  }

  savePosition() {
    this.settings.update({ position: { x: Math.round(this.pos.x), y: Math.round(this.pos.y) } });
  }

  // ------------------------------------------------------------------ autonomous behaviour
  decide() {
    if (this.state === 'hidden' || this.state === 'sleep' || this.busy()) return;
    this.interrupt();
    if (!this.onFloor()) return this.fall(() => this.decide());

    const choice = pickWeighted([
      ['walk', 46],
      ['idle', 16],
      ['sit', 14],
      ['groom', 9],
      ['stretch', 6],
      ['pounce', 9],
    ]);
    switch (choice) {
      case 'walk': {
        const [minX, maxX] = this.pet.xRange(this.display());
        const span = maxX - minX;
        const dist = rand(40, Math.max(60, Math.min(260, span * 0.3))) * this.scale;
        let dir = Math.random() < 0.5 ? -1 : 1;
        if (this.pos.x + dir * dist < minX || this.pos.x + dir * dist > maxX) dir = -dir;
        return this.walkTo(this.pos.x + dir * dist, { then: () => this.rest() });
      }
      case 'idle':
        return this.rest(rand(3000, 9000));
      case 'sit':
        return this.sit(rand(8000, 25000));
      case 'groom':
        return this.groom();
      case 'stretch':
        return this.stretch(() => this.rest());
      default:
        return this.pounce();
    }
  }

  rest(ms = rand(1200, 5000)) {
    this.setState('idle');
    this.play('idle');
    this.after(ms, () => this.decide());
  }

  sit(ms) {
    this.setState('sit');
    this.play('sit');
    this.after(ms, () => this.decide());
  }

  groom() {
    this.setState('groom');
    this.play('groom');
    this.after(rand(2400, 4800), () => this.rest());
  }

  stretch(then) {
    this.setState('stretch');
    this.play('stretch');
    this.after(this.animMs('stretch') + 200, then);
  }

  /** Travel to targetX: Iron Man cruises horizontally; other characters use their normal motion. */
  walkTo(targetX, { speed, then, hurry = false } = {}) {
    const [minX, maxX] = this.pet.xRange(this.display());
    targetX = clamp(targetX, minX, maxX);
    const dir = targetX >= this.pos.x ? 1 : -1;
    this.facing = dir > 0 ? 'right' : 'left';
    const s = this.scale;
    const hero = appearance.isAvengers(this.settings) ? appearance.mainHero(this.settings) : null;
    const motion = heroMotion.profile(hero);
    const base = speed || rand(11, 22) * s * (motion ? motion.speed : 1); // screen px / second
    const startX = this.pos.x;
    const distance = Math.abs(targetX - startX);
    // stride ~1.6 sprite px per frame -> feet don't slide; capped at 12 fps
    const fps = clamp(Math.round(base / s / 1.6), 5, 12);
    this.setState('walk');
    this.play(hero === 'ironman' ? 'fly' : dir > 0 ? 'walk_right' : 'walk_left', { fps });
    const seed = Math.random() * 10;
    const y = this.floorY();
    let t = 0;
    this.startMove((dt) => {
      t += dt;
      const remaining = Math.abs(targetX - this.pos.x);
      const ease = Math.min(1, 0.25 + t / 0.6) * Math.min(1, 0.4 + remaining / (16 * s));
      const wobble = hurry ? 1 : 1 + 0.15 * Math.sin(t * 0.8 + seed);
      let nx = this.pos.x + dir * base * ease * wobble * dt;
      const arrived = dir > 0 ? nx >= targetX : nx <= targetX;
      if (arrived) nx = targetX;
      const progress = distance ? Math.min(1, Math.abs(nx - startX) / distance) : 1;
      const liftedY = y - heroMotion.lift(hero, progress, s);
      this.pet.moveTo(nx, Math.max(this.display().workArea.y, arrived ? y : liftedY));
      if (arrived) {
        this.stopMove();
        if (motion && this.meta.animations.land) {
          this.play('land');
          this.after(this.animMs('land'), () => then ? then() : this.rest());
        } else if (then) then();
      }
    });
  }

  flyAcross() {
    if (!appearance.isAvengers(this.settings) || appearance.mainHero(this.settings) !== 'ironman') return;
    this.interrupt();
    const [minX, maxX] = this.pet.xRange(this.display());
    const right = maxX - this.pos.x >= this.pos.x - minX;
    const target = right ? maxX - 12 * this.scale : minX + 12 * this.scale;
    this.walkTo(target, { speed: 150 * this.scale, hurry: true, then: () => this.rest() });
  }

  pounce() {
    if (appearance.isAvengers(this.settings) && appearance.mainHero(this.settings) === 'ironman') return this.flyAcross();
    this.interrupt();
    this.setState('pounce');
    const [minX, maxX] = this.pet.xRange(this.display());
    const s = this.scale;
    const hero = appearance.isAvengers(this.settings) ? appearance.mainHero(this.settings) : null;
    const motion = heroMotion.profile(hero);
    const leap = (hero === 'quicksilver' ? 100 : hero === 'hulk' ? 48 : 34) * s;
    if (this.facing === 'right' && this.pos.x + leap > maxX) this.facing = 'left';
    else if (this.facing === 'left' && this.pos.x - leap < minX) this.facing = 'right';
    const dir = this.facing === 'right' ? 1 : -1;
    const fps = this.meta.animations.pounce.fps;
    this.play('pounce');
    // frames 4..6 are the leap: move the window along an arc in sync with them
    this.after((4 * 1000) / fps, () => {
      const x0 = this.pos.x;
      const y0 = this.floorY();
      const dur = 3 / fps;
      let t = 0;
      this.startMove((dt) => {
        t = Math.min(dur, t + dt);
        const u = t / dur;
        this.pet.moveTo(clamp(x0 + dir * leap * u, minX, maxX), Math.max(this.display().workArea.y, y0 - Math.sin(Math.PI * u) * (motion ? motion.leap : 14) * s));
        if (u >= 1) {
          this.stopMove();
          if (motion) this.play('land');
        }
      });
    });
    this.after(this.animMs('pounce') + 200, () => this.rest(rand(900, 2500)));
  }

  /** Drop to the floor (after being left mid-air). */
  fall(then) {
    this.setState('fall');
    this.play('alert');
    let v = 0;
    this.startMove((dt) => {
      v = Math.min(v + 2600 * dt, 1600);
      const fy = this.floorY();
      const ny = this.pos.y + v * dt;
      if (ny >= fy) {
        this.pet.moveTo(this.pos.x, fy);
        this.stopMove();
        this.play('idle');
        this.after(350, then);
      } else {
        this.pet.moveTo(this.pos.x, ny);
      }
    });
  }

  // ------------------------------------------------------------------ sleep / wake
  sleep(reason = 'idle') {
    if (this.state === 'sleep' || this.state === 'hidden') return;
    this.interrupt();
    this.hideBubble();
    this.setState('sleep');
    this.play('sleep');
    const c = this.sensors.cursor();
    this.sleepInfo = { reason, start: c, armed: this.cursorDist(c) > this.wakeRadius(), since: Date.now() };
    if (!this.muted) this.after(700, () => this.say(this.quip('sleepy'), { ms: 4500 }));
  }

  checkWake() {
    const info = this.sleepInfo;
    if (!info || Date.now() - info.since < 1500) return;
    const c = this.sensors.cursor();
    const near = this.cursorDist(c) < this.wakeRadius();
    if (!info.armed) {
      if (!near) info.armed = true;
      // dozed off with the cursor parked nearby: any movement close to it wakes it up
      else if (info.reason === 'idle' && Math.hypot(c.x - info.start.x, c.y - info.start.y) > 6) this.wake('mouse');
      return;
    }
    if (near) this.wake('mouse');
  }

  wake(source = 'mouse') {
    if (this.state !== 'sleep') return;
    this.interrupt();
    this.hideBubble();
    this.sleepInfo = null;
    this.setState('waking');
    const c = this.sensors.cursor();
    this.facing = c.x < this.pet.center().x ? 'left' : 'right';
    this.play('stretch');
    this.after(this.animMs('stretch') + 150, () => {
      if (source !== 'mouse' || !this.muted) this.say(this.quip('wakeup'));
      this.rest(rand(2500, 4500));
    });
  }

  // ------------------------------------------------------------------ sensors & quips
  sense() {
    if (this.state === 'off' || this.state === 'hidden') return;
    if (this.state === 'sleep') return this.checkWake();
    if (this.busy() || this.state === 'waking') return;
    const idle = this.sensors.idleSeconds();
    if (idle >= this.settings.get('sleepTimeoutMinutes') * 60) this.sleep('idle');
  }

  scheduleQuip() {
    clearTimeout(this.quipTimer);
    const min = this.settings.get('quipMinMinutes');
    const max = this.settings.get('quipMaxMinutes');
    const ms = rand(min, Math.max(min, max)) * 60000;
    this.nextQuipAt = Date.now() + ms;
    this.quipTimer = setTimeout(() => {
      this.idleQuip();
      this.scheduleQuip();
    }, ms);
  }

  /** Spontaneous idle quip. Skipped when muted, asleep, hidden or busy. */
  idleQuip() {
    if (this.muted || this.busy()) return false;
    if (['off', 'hidden', 'sleep', 'waking', 'fall', 'pounce'].includes(this.state)) return false;
    this.interrupt();
    const line = (this.nudge && this.nudge()) || this.quip('idle'); // nudge: to-do reminder (main.js)
    this.talkThen(line, () => this.decide());
    return true;
  }

  /** Talk animation while the line is "spoken", then sit until the bubble is gone. */
  talkThen(text, then) {
    this.setState('talk');
    this.play('talk');
    const ms = this.say(text);
    const talkMs = clamp(text.length * 45, 1200, 3200);
    this.after(talkMs, () => {
      this.setState('sit');
      this.play('sit');
      this.after(Math.max(800, ms - talkMs) + rand(800, 2500), then);
    });
    return ms;
  }

  // ------------------------------------------------------------------ interactions
  click() {
    if (this.dragging || this.gaming || this.state === 'hidden') return;
    if (this.activeReminder) return this.dismissReminder();
    if (this.state === 'sleep') return this.wake('click');
    this.interrupt();
    this.talkThen(this.quip('greetings'), () => (this.chatOpen ? this.chatIdle() : this.decide()));
  }

  dblclick() {
    if (this.dragging || this.gaming || this.state === 'hidden') return;
    if (this.activeReminder) return this.dismissReminder();
    if (this.state === 'sleep') return this.wake('click');
    this.interrupt();
    this.setState('happy');
    this.play('happy');
    const ms = this.say(this.quip('happy'));
    this.after(Math.max(3200, ms), () => (this.chatOpen ? this.chatIdle() : this.rest()));
  }

  /** Right-click menu + tray commands: sit | sleep | pounce | tuck | wake */
  command(cmd) {
    if (cmd === 'tuck') return this.tuck();
    if (cmd === 'wake') return this.state === 'hidden' ? this.untuck() : this.wake('command');
    if (this.state === 'hidden' || this.activeReminder) return;
    if (cmd === 'sleep') return this.sleep('command');
    this.interrupt();
    this.hideBubble();
    if (cmd === 'sit') return this.sit(rand(60000, 120000));
    if (cmd === 'fly') return this.onFloor() ? this.flyAcross() : this.fall(() => this.flyAcross());
    if (cmd === 'pounce') return this.onFloor() ? this.pounce() : this.fall(() => this.pounce());
  }

  dragStart(cursor) {
    if (this.state === 'hidden') return;
    this.interrupt();
    this.dragging = true;
    this.sleepInfo = null;
    this.grab = { dx: cursor.x - this.pos.x, dy: cursor.y - this.pos.y };
    this.setState('drag');
    this.play('alert');
    if (!this.activeReminder) {
      this.hideBubble();
      if (Math.random() < 0.4) this.say(this.quip('drag'), { ms: 2500 });
    }
  }

  dragMove(cursor) {
    if (!this.dragging) return;
    const d = this.sensors.displayAt(cursor);
    const p = this.pet.clamp(cursor.x - this.grab.dx, cursor.y - this.grab.dy, d);
    this.pet.moveTo(p.x, p.y);
  }

  dragEnd() {
    if (!this.dragging) return;
    this.dragging = false;
    this.savePosition();
    if (!this.activeReminder && this.reminderQueue.length) return this.nextReminder();
    if (this.activeReminder && !this.reminderClosing) return this.presentReminder();
    const gap = this.floorY() - this.pos.y;
    if (gap < 30 * this.scale) return this.fall(() => (this.chatOpen ? this.chatIdle() : this.rest()));
    // dropped high up: perch there for a while (sitting), then hop down on the next decision
    this.setState('sit');
    this.play('sit');
    if (!this.chatOpen) this.after(rand(6000, 15000), () => this.decide());
  }

  // ------------------------------------------------------------------ mini-game (games.js)
  startGame() {
    this.interrupt();
    this.hideBubble();
    this.sleepInfo = null;
    this.gaming = true;
    this.setState('game');
    if (!this.onFloor()) this.pet.moveTo(this.pos.x, this.floorY());
    this.play('alert');
    this.gameAnim = 'alert';
  }

  /** Run along the floor towards x (the mouse), fast but not instantly. */
  gameMove(targetX, dt) {
    if (!this.gaming || this.state !== 'game') return;
    const [minX, maxX] = this.pet.xRange(this.display());
    const tx = clamp(targetX, minX, maxX);
    const dx = tx - this.pos.x;
    const step = 900 * dt; // px per second
    const moving = Math.abs(dx) > 3;
    const nx = moving ? this.pos.x + clamp(dx, -step, step) : this.pos.x;
    this.pet.moveTo(nx, this.floorY());
    const anim = moving ? (dx > 0 ? 'walk_right' : 'walk_left') : 'alert';
    if (anim !== this.gameAnim) {
      this.gameAnim = anim;
      this.facing = dx > 0 ? 'right' : dx < 0 ? 'left' : this.facing;
      this.play(anim, { fps: moving ? 12 : undefined });
    }
  }

  endGame(line) {
    if (!this.gaming) return;
    this.gaming = false;
    if (this.state !== 'game') return; // a reminder, drag or Tuck Away took over
    this.setState('happy');
    this.play('happy');
    const ms = line ? this.say(line, { ms: 6000 }) : 0;
    this.after(Math.max(3000, ms), () => (this.chatOpen ? this.chatIdle() : this.rest()));
  }

  // ------------------------------------------------------------------ tuck away / wake
  tuck() {
    if (this.state === 'hidden') return;
    this.interrupt();
    this.hideBubble();
    this.dragging = false;
    this.setState('hidden');
    this.emit('visibility', false);
  }

  untuck() {
    if (this.state !== 'hidden') return;
    const p = this.pet.clamp(this.pos.x, this.pos.y, this.display());
    this.pet.moveTo(p.x, p.y);
    this.emit('visibility', true);
    if (this.activeReminder && !this.reminderClosing) return this.presentReminder();
    this.setState('waking');
    this.play('stretch');
    this.after(this.animMs('stretch') + 150, () => {
      if (!this.muted) this.say(this.quip('wakeup'));
      this.rest(rand(2000, 4000));
    });
  }

  // ------------------------------------------------------------------ reminders
  reminder(r) {
    // a newer reminder for the same calendar event replaces the old one instead of piling up
    if (r.key) this.reminderQueue = this.reminderQueue.filter((q) => q.key !== r.key);
    const cur = this.activeReminder;
    if (r.key && cur && cur.key === r.key && !this.reminderClosing) {
      this.activeReminder = r;
      if (this.state === 'reminder') this.say(`${r.icon || '⏰'} ${r.message}`, { sticky: true, head: r.head, hint: r.hint });
      this.emit('reminder-start', r);
      return;
    }
    this.reminderQueue.push(r);
    if (!this.activeReminder) this.nextReminder();
  }

  nextReminder() {
    const r = this.reminderQueue.shift();
    if (!r) {
      this.activeReminder = null;
      return;
    }
    this.activeReminder = r;
    this.reminderClosing = false;
    this.interrupt();
    this.hideBubble();
    this.sleepInfo = null;
    if (this.state === 'hidden') this.emit('visibility', true);
    this.emit('reminder-start', r);
    const d = this.display();
    const target = d.workArea.x + (d.workArea.width - this.pet.S) / 2;
    const arrive = () => this.presentReminder();
    const go = () => {
      const dist = Math.abs(target - this.pos.x);
      if (dist < 3) return arrive();
      this.walkTo(target, { speed: Math.max(28 * this.scale, dist / 5), hurry: true, then: arrive });
    };
    if (!this.onFloor()) this.fall(go);
    else go();
  }

  /** Stand still with the gold reminder bubble until Prince clicks it. */
  presentReminder() {
    const r = this.activeReminder;
    if (!r) return;
    this.setState('reminder');
    this.facing = 'right';
    this.play('alert');
    this.say(`${r.icon || '⏰'} ${r.message}`, { sticky: true, head: r.head, hint: r.hint });
    this.emit('reminder-shown', r);
  }

  /** @param {'click'|'menu'} how  click = bubble/pet clicked, menu = "Dismiss"/"Update Later" picked */
  dismissReminder(how = 'click') {
    const r = this.activeReminder;
    if (!r || this.reminderClosing) return;
    this.reminderClosing = true;
    this.emit('reminder-dismissed', r, how);
    this.interrupt();
    this.hideBubble();
    this.setState('happy');
    this.play('happy');
    this.say(this.quip('reminderDone'), { ms: 2600 });
    // Its own timer, NOT this.after(): a drag or Tuck Away during the happy dance calls interrupt(),
    // which used to leave the reminder half-closed forever - after that no click did anything.
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.finishReminder(r), 2600);
  }

  finishReminder(r) {
    clearTimeout(this.closeTimer);
    if (this.activeReminder !== r) return;
    this.activeReminder = null;
    this.reminderClosing = false;
    this.emit('reminder-done', r);
    if (this.dragging || this.state === 'hidden' || this.state === 'fall') return; // they carry on by themselves
    if (this.reminderQueue.length) this.nextReminder();
    else if (this.chatOpen) this.chatIdle();
    else this.rest();
  }

  bubbleClicked() {
    // any click on the bubble closes an open reminder, even if another line replaced its text
    if (this.activeReminder) return this.dismissReminder();
    this.hideBubble();
  }

  // ------------------------------------------------------------------ chat panel
  chatOpened() {
    this.chatOpen = true;
    if (this.activeReminder || this.gaming || this.state === 'hidden') return;
    this.interrupt();
    if (this.state === 'sleep') this.sleepInfo = null;
    this.chatIdle();
  }

  chatIdle() {
    this.setState('sit');
    this.play('sit');
  }

  chatClosed() {
    this.chatOpen = false;
    if (this.activeReminder || this.state === 'hidden' || this.dragging) return;
    this.after(1500, () => this.decide());
  }

  chatReply(text) {
    if (this.activeReminder || this.gaming || this.state === 'hidden' || this.dragging) return;
    this.interrupt();
    this.talkThen(text, () => (this.chatOpen ? this.chatIdle() : this.decide()));
  }

  // ------------------------------------------------------------------ environment changes
  displaysChanged() {
    const p = this.pet.clamp(this.pos.x, this.pos.y, this.display());
    this.pet.moveTo(p.x, p.y);
    if (this.state === 'walk' && !this.activeReminder) this.decide();
  }

  scaleChanged() {
    if (this.state === 'walk' && !this.activeReminder) this.decide();
  }
}

module.exports = { Brain };
