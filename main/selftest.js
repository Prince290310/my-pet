'use strict';
/*
 * Automated end-to-end checks:  npm test   (= electron . --self-test)
 *
 * Runs the REAL app in a throwaway profile (temp settings + temp config folder), drives it with
 * synthetic mouse events and fake idle/cursor sensors, and stubs the two OS-level actions
 * (Start-with-Windows registry entry, opening Explorer) so nothing on your PC changes.
 * Prints PASS/FAIL per check, writes report.json + screenshots, exits 0 when everything passes.
 */

const { app, session } = require('electron');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 5000, every = 50) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() - t0 > timeout) return false;
    await sleep(every);
  }
}

/** Fake sensors so sleep/wake can be tested without waiting 5 real minutes. */
function makeSensors(real) {
  const fake = { idle: 0, cursor: { x: -99999, y: -99999 } };
  return {
    fake,
    idleSeconds: () => fake.idle,
    cursor: () => ({ ...fake.cursor }),
    displayAt: real.displayAt,
    primary: real.primary,
  };
}

async function run(ctx, h) {
  const outDir = process.env.SHADOW_TEST_OUT || path.join(process.env.SHADOW_TEST_DIR, 'report');
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  const section = (t) => console.log(`\n== ${t}`);
  console.log('Self-test running (~1.5 min). The test panther ignores your real mouse - just watch!');

  // record any network request a renderer tries to make (there should be none)
  const network = [];
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    if (!/^(file|data|devtools|chrome-extension|blob):/.test(d.url)) network.push(d.url);
    cb({});
  });

  // stub OS-level side effects
  let loginOn = false;
  ctx.loginItem = { get: () => loginOn, set: (on) => (loginOn = !!on) };
  const opened = [];
  ctx.stubOpenPath = (p) => opened.push(p);

  const frames = {};
  ctx.onTestFrame = ({ name, frame, facing }) => {
    const key = `${name}:${facing}`;
    (frames[key] = frames[key] || new Set()).add(frame);
  };

  const started = await waitFor(() => ctx.brain && ctx.brain.state !== 'off', 15000);
  const { pet, brain, settings, config, meta } = ctx;
  const fake = ctx.sensors.fake;
  const js = (code, wc = pet.win.webContents) => wc.executeJavaScript(code);
  const rstate = () => js('window.__shadowTest.state()');
  const wb = () => pet.win.getBounds();
  const shot = async (name, wc = pet.win.webContents) => {
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
  };
  const mouse = (type, x, y, extra = {}) => {
    const b = wb();
    const ev = { type, x: Math.round(x), y: Math.round(y), globalX: Math.round(b.x + x), globalY: Math.round(b.y + y), ...extra };
    fake.cursor = { x: ev.globalX, y: ev.globalY }; // the real cursor is wherever the event happens
    pet.win.webContents.sendInputEvent(ev);
  };
  const petPoint = async () => {
    // an opaque pixel of the current frame, in window (client) coordinates
    return js(`(() => {
      const c = document.getElementById('pet'); const r = c.getBoundingClientRect();
      const d = c.getContext('2d').getImageData(0, 0, 48, 48).data;
      let best = null;
      for (let y = 20; y < 44 && !best; y++) for (let x = 14; x < 34; x++) {
        if (d[(y * 48 + x) * 4 + 3] > 0 && d[((y - 1) * 48 + x) * 4 + 3] > 0 && d[((y + 1) * 48 + x) * 4 + 3] > 0) { best = { x, y }; break; }
      }
      if (!best) return null;
      return { x: r.left + (best.x + 0.5) * r.width / 48, y: r.top + (best.y + 0.5) * r.height / 48 };
    })()`);
  };
  const quiet = () => {
    brain.interrupt();
    brain.hideBubble();
  };

  try {
    section('Startup & window');
    check('app started and brain running', started, `state=${brain.state}`);
    await waitFor(async () => (await rstate()).frame >= 0, 5000);
    check('pet window visible', pet.win.isVisible());
    check('always on top', pet.win.isAlwaysOnTop());
    check('not resizable', !pet.win.isResizable());
    check('not focusable (never steals focus)', !pet.win.isFocusable());
    const b0 = wb();
    check('window size = sprite + bubble space (±2px DPI rounding)', Math.abs(b0.width - pet.W) <= 2 && Math.abs(b0.height - pet.H) <= 2, `${b0.width}x${b0.height}`);
    const d0 = pet.display();
    check('pet starts on the floor (above the taskbar)', Math.abs(pet.pos.y - pet.floorY(d0)) < 2, `y=${pet.pos.y} floor=${pet.floorY(d0)}`);
    check('pet inside work area', pet.pos.x >= d0.workArea.x && pet.pos.x + pet.S <= d0.workArea.x + d0.workArea.width);
    check('starts click-through (ignoring mouse)', pet.interactive === false);
    pet.win.minimize(); // e.g. Win+D "Show desktop"
    const healed = await waitFor(() => !pet.win.isMinimized() && pet.win.isVisible(), 2000);
    const hb = wb();
    check('recovers if something minimizes it (Win+D)', healed && Math.abs(hb.width - pet.W) <= 2 && Math.abs(hb.height - pet.H) <= 2, `${hb.width}x${hb.height}`);

    section('Sprites & animations');
    const names = Object.keys(meta.animations);
    const required = ['idle', 'walk_left', 'walk_right', 'sit', 'sleep', 'talk', 'happy', 'stretch', 'pounce', 'alert'];
    check('all required animations exist', required.every((n) => names.includes(n)), names.join(', '));
    check('every animation has >= 4 frames', names.every((n) => meta.animations[n].frames >= 4));
    check('every animation <= 12 fps', names.every((n) => meta.animations[n].fps <= 12));
    for (const n of names) {
      quiet();
      const a = meta.animations[n];
      const facings = a.flip ? ['right', 'left'] : ['right'];
      for (const f of facings) {
        brain.facing = f;
        brain.play(n);
        await sleep((a.frames / a.fps) * 1000 + 450);
        const seen = frames[`${n}:${f}`] || new Set();
        const late = await js('window.__shadowTest.lateness()');
        const rlog = await js('window.__shadowTest.log()');
        if (seen.size !== a.frames) console.log('   renderer log:', JSON.stringify(rlog.slice(-30)));
        check(`anim "${n}"${a.flip ? ` (${f})` : ''} played all ${a.frames} frames`, seen.size === a.frames, `saw ${[...seen].sort().join(',')}; timer lateness ms: ${late.join(',')}`);
      }
      await shot(`anim-${n}`);
    }

    section('Click-through');
    quiet();
    brain.facing = 'right';
    brain.play('sit');
    await sleep(300);
    const pp = await petPoint();
    check('found an opaque panther pixel', !!pp, JSON.stringify(pp));
    mouse('mouseMove', 8, 8); // top-left corner: transparent
    await sleep(150);
    check('transparent area stays click-through', pet.interactive === false);
    mouse('mouseMove', pp.x, pp.y);
    await waitFor(() => pet.interactive === true, 1000);
    check('hovering the panther captures the mouse', pet.interactive === true);
    mouse('mouseMove', 8, 8);
    await waitFor(() => pet.interactive === false, 1000);
    check('leaving the panther makes it click-through again', pet.interactive === false);

    section('Single click / double click');
    quiet();
    brain.play('sit');
    await sleep(200);
    let p = await petPoint();
    mouse('mouseMove', p.x, p.y);
    mouse('mouseDown', p.x, p.y, { button: 'left', clickCount: 1 });
    mouse('mouseUp', p.x, p.y, { button: 'left', clickCount: 1 });
    await waitFor(() => brain.state === 'talk', 1500);
    check('single click -> talk animation', brain.state === 'talk' && brain.anim === 'talk');
    if (brain.state !== 'talk') console.log('   renderer log:', JSON.stringify(await js('window.__shadowTest.log()')), 'brain:', brain.state, brain.anim);
    let rs = await waitFor(async () => {
      const s = await rstate();
      return s.bubble ? s : null;
    }, 1500);
    check('single click -> speech bubble with a greeting', rs && config.quips.greetings.some((g) => rs.bubble.text === g.replace('{name}', settings.get('petName'))), rs && rs.bubble.text);
    await shot('click-greeting');
    quiet();
    brain.play('sit');
    await sleep(200);
    p = await petPoint();
    mouse('mouseDown', p.x, p.y, { button: 'left', clickCount: 1 });
    mouse('mouseUp', p.x, p.y, { button: 'left', clickCount: 1 });
    await sleep(80);
    mouse('mouseDown', p.x, p.y, { button: 'left', clickCount: 2 });
    mouse('mouseUp', p.x, p.y, { button: 'left', clickCount: 2 });
    await waitFor(() => brain.state === 'happy', 1500);
    check('double click -> happy animation (hearts)', brain.state === 'happy' && brain.anim === 'happy');
    await sleep(500);
    await shot('dblclick-happy');

    section('Dragging');
    quiet();
    brain.play('sit');
    await sleep(200);
    p = await petPoint();
    const start = { ...pet.pos };
    const wStart = wb();
    const grab = { x: wStart.x + p.x, y: wStart.y + p.y }; // screen point where the press happens
    mouse('mouseDown', p.x, p.y, { button: 'left', clickCount: 1 });
    await sleep(60);
    // like a real mouse on Windows: NO mouse-move events reach the window mid-press,
    // only the cursor position changes (main follows it)
    for (let i = 1; i <= 10; i++) {
      fake.cursor = { x: grab.x - 20 * i, y: grab.y - 25 * i };
      await sleep(40);
    }
    await sleep(60);
    check('drag started', brain.dragging === true && brain.state === 'drag');
    check('pet follows the mouse while dragging', Math.abs(pet.pos.x - (start.x - 200)) < 6 && Math.abs(pet.pos.y - (start.y - 250)) < 6, `moved to ${Math.round(pet.pos.x - start.x)},${Math.round(pet.pos.y - start.y)}`);
    const bp = wb();
    mouse('mouseUp', p.x, p.y, { button: 'left', clickCount: 1, globalX: bp.x + p.x, globalY: bp.y + p.y });
    await waitFor(() => !brain.dragging, 1000);
    check('drop ends the drag (perches up high)', !brain.dragging && brain.state === 'sit', `state=${brain.state}`);
    check('drop position saved to settings', settings.get('position') && settings.get('position').x === Math.round(pet.pos.x));
    await shot('dragged-perched');
    // keep inside bounds: try to drag far off-screen
    brain.dragStart({ x: pet.pos.x + 10, y: pet.pos.y + 10 });
    brain.dragMove({ x: -50000, y: -50000 });
    const dd = pet.display();
    check('drag is clamped inside the screen', pet.pos.x >= dd.workArea.x && pet.pos.y >= dd.workArea.y, `pos=${Math.round(pet.pos.x)},${Math.round(pet.pos.y)}`);
    brain.dragMove({ x: start.x + 10, y: start.y - 300 });
    brain.dragEnd();
    brain.decide(); // decides while perched -> falls to the floor first
    check('falls back to the floor', await waitFor(() => brain.onFloor(), 4000));

    section('Wandering');
    quiet();
    const x0 = pet.pos.x;
    const [minX, maxX] = pet.xRange();
    const target = x0 + (x0 - minX > maxX - x0 ? -160 : 160);
    let arrived = false;
    brain.walkTo(target, { speed: 120, then: () => (arrived = true) });
    check('walk uses walk_left/walk_right', brain.anim === (target > x0 ? 'walk_right' : 'walk_left'), brain.anim);
    await waitFor(() => arrived, 5000);
    check('walks along the floor to the target', arrived && Math.abs(pet.pos.x - target) < 1 && brain.onFloor());
    quiet();
    const px0 = pet.pos.x;
    brain.pounce();
    await sleep(600);
    const midAir = pet.pos.y < pet.floorY() - 2;
    await waitFor(() => brain.state === 'idle', 3000);
    check('pounce leaps (airborne mid-way) and lands', midAir && brain.onFloor() && Math.abs(pet.pos.x - px0) > 30, `dx=${Math.round(pet.pos.x - px0)}`);
    // let the autonomous brain run a few decisions
    const statesSeen = new Set();
    const onState = (s) => statesSeen.add(s);
    brain.on('state', onState);
    for (let i = 0; i < 12; i++) {
      quiet();
      brain.decide();
      statesSeen.add(brain.state);
      await sleep(30);
    }
    brain.off('state', onState);
    check('autonomous decisions vary (walk/idle/sit/groom/stretch/pounce)', statesSeen.size >= 3, [...statesSeen].join(','));

    section('Sleep & wake');
    quiet();
    brain.rest(60000);
    fake.cursor = { x: pet.center().x + 900, y: pet.center().y - 600 };
    fake.idle = settings.get('sleepTimeoutMinutes') * 60 - 30;
    await sleep(900);
    check('stays awake before the idle timeout', brain.state !== 'sleep');
    fake.idle = settings.get('sleepTimeoutMinutes') * 60 + 1;
    await waitFor(() => brain.state === 'sleep', 2000);
    check(`falls asleep after ${settings.get('sleepTimeoutMinutes')} min of no activity`, brain.state === 'sleep' && brain.anim === 'sleep');
    await sleep(1600);
    await shot('sleeping');
    fake.idle = 0;
    fake.cursor = { x: pet.center().x + 700, y: pet.center().y - 400 };
    await sleep(900);
    check('mouse moving far away does not wake it', brain.state === 'sleep');
    fake.cursor = { x: pet.center().x + 40, y: pet.center().y - 20 };
    await waitFor(() => brain.state === 'waking', 2000);
    check('mouse coming near wakes it with a stretch', brain.state === 'waking' && brain.anim === 'stretch');
    await waitFor(() => brain.state === 'idle', 3000);
    check('back to normal after waking', brain.state === 'idle');
    // menu "Sleep" while the cursor is right there must not instantly wake
    brain.command('sleep');
    await sleep(2200);
    check('commanded sleep ignores the nearby cursor until it leaves', brain.state === 'sleep');
    fake.cursor = { x: pet.center().x + 900, y: pet.center().y - 600 };
    await sleep(600);
    fake.cursor = { x: pet.center().x + 30, y: pet.center().y };
    await waitFor(() => brain.state === 'waking', 2000);
    check('...and wakes when the cursor comes back', brain.state === 'waking');
    fake.cursor = { x: -99999, y: -99999 };
    await waitFor(() => brain.state === 'idle', 3000);

    section('Right-click menu');
    const tmpl = h.petMenuTemplate().filter((i) => i.label);
    check('menu has Sit, Sleep, Pounce, Tuck Away', ['Sit', 'Sleep', 'Pounce', 'Tuck Away'].every((l) => tmpl.some((i) => i.label === l)), tmpl.map((i) => i.label).join(', '));
    const item = (l) => tmpl.find((i) => i.label === l);
    item('Sit').click();
    check('Sit -> sits', brain.state === 'sit' && brain.anim === 'sit');
    item('Pounce').click();
    check('Pounce -> pounces', brain.state === 'pounce' && brain.anim === 'pounce');
    await waitFor(() => brain.state === 'idle', 3000);
    item('Sleep').click();
    check('Sleep -> sleeps', brain.state === 'sleep');
    item('Tuck Away').click();
    check('Tuck Away -> hidden', brain.state === 'hidden' && !pet.win.isVisible());
    brain.command('wake');
    await waitFor(() => pet.win.isVisible(), 1000);
    await waitFor(() => brain.state === 'idle', 3000);

    section('Chat panel (Ctrl+Click)');
    quiet();
    brain.play('sit');
    await sleep(200);
    p = await petPoint();
    mouse('mouseDown', p.x, p.y, { button: 'left', clickCount: 1, modifiers: ['control'] });
    mouse('mouseUp', p.x, p.y, { button: 'left', clickCount: 1, modifiers: ['control'] });
    const chat = await waitFor(() => h.getChatWindow(), 3000);
    check('Ctrl+Click opens the chat panel', !!chat);
    check('pet sits while chatting', brain.chatOpen && brain.state === 'sit');
    await waitFor(() => chat.isVisible(), 3000);
    await waitFor(() => js('document.querySelectorAll(".msg.pet").length > 0', chat.webContents), 3000);
    const reply = await js(`(async () => { const i = document.getElementById('msg'); i.value = 'Hello Shadow'; document.getElementById('composer').requestSubmit(); await new Promise(r => setTimeout(r, 400)); const m = [...document.querySelectorAll('.msg.pet')]; return m[m.length - 1].textContent; })()`, chat.webContents);
    check('no key yet: chat explains how to add a free key (no network call)', reply.includes('Settings → AI Brain'), reply);
    check('pet talks the reply in a bubble', brain.state === 'talk' && brain.bubble && brain.bubble.text === reply);
    await shot('chat-panel', chat.webContents);
    await shot('chat-pet-bubble');
    chat.close();
    await waitFor(() => !h.getChatWindow(), 2000);
    check('closing chat resumes normal life', !brain.chatOpen);

    section('Quips');
    check('quips.json has >= 40 lines', config.quipCount() >= 40, `${config.quipCount()} lines`);
    check('quip categories: greetings, idle, wakeup, sleepy', ['greetings', 'idle', 'wakeup', 'sleepy'].every((c) => config.quips[c] && config.quips[c].length));
    quiet();
    brain.rest(60000);
    check('idle quip shows (talk + bubble)', brain.idleQuip() && brain.state === 'talk' && config.quips.idle.some((l) => l.replace('{name}', settings.get('petName')) === brain.bubble.text));
    const nextIn = (brain.nextQuipAt - Date.now()) / 60000;
    check('next idle quip scheduled 20-40 min out', nextIn >= 19.9 && nextIn <= 40.1, `${nextIn.toFixed(1)} min`);
    settings.update({ muteQuips: true });
    quiet();
    brain.rest(60000);
    check('muted -> no idle quips', brain.idleQuip() === false);
    settings.update({ muteQuips: false });

    section('Reminders');
    quiet();
    brain.rest(60000);
    const remFile = path.join(config.dir, 'reminders.json');
    const original = fs.readFileSync(remFile, 'utf8');
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()];
    // move the panther off-centre first so it has to walk
    const dc = pet.display();
    pet.moveTo(dc.workArea.x + 40, pet.floorY(dc));
    const reloaded = new Promise((r) => config.once('reminders', r));
    fs.writeFileSync(remFile, JSON.stringify({ reminders: [{ time: hhmm, days: [day], message: 'Prince, self-test reminder!' }] }, null, 2));
    check('editing reminders.json reloads it automatically', await Promise.race([reloaded.then(() => true), sleep(4000).then(() => false)]));
    const fired = ctx.reminders.check();
    check('reminder fires at its time', fired.length === 1 && !!brain.activeReminder);
    check('reminder fires only once per day', ctx.reminders.check().length === 0);
    await waitFor(() => brain.state === 'reminder', 9000);
    const centreX = dc.workArea.x + (dc.workArea.width - pet.S) / 2;
    check('walks to the centre-bottom of the screen', brain.state === 'reminder' && Math.abs(pet.pos.x - centreX) < 2 && brain.onFloor(), `x=${Math.round(pet.pos.x)} centre=${Math.round(centreX)}`);
    check('plays the alert animation', brain.anim === 'alert');
    rs = await rstate();
    check('sticky bubble shows the message', rs.bubble && rs.bubble.sticky && rs.bubble.text.includes('self-test reminder'), rs.bubble && rs.bubble.text);
    await sleep(5000);
    check('bubble stays until clicked', !!brain.bubble && brain.state === 'reminder');
    await shot('reminder');
    rs = await rstate();
    const br = rs.bubbleRect;
    mouse('mouseMove', br.x + br.width / 2, br.y + br.height / 2);
    mouse('mouseDown', br.x + br.width / 2, br.y + br.height / 2, { button: 'left', clickCount: 1 });
    mouse('mouseUp', br.x + br.width / 2, br.y + br.height / 2, { button: 'left', clickCount: 1 });
    await waitFor(() => brain.state === 'happy', 1500);
    check('clicking the bubble dismisses it', brain.state === 'happy' && !brain.bubble.sticky);
    await waitFor(() => !brain.activeReminder, 4000);
    check('back to normal after the reminder', !brain.activeReminder);
    // hidden pet still delivers reminders
    brain.tuck();
    brain.reminder({ time: hhmm, days: [day], message: 'Hidden test' });
    await waitFor(() => brain.state === 'reminder', 9000);
    check('reminder un-hides a tucked-away pet', pet.win.isVisible() && brain.state === 'reminder');
    brain.dismissReminder();
    await waitFor(() => !brain.activeReminder, 4000);
    // broken JSON keeps the last good reminders
    const errored = new Promise((r) => config.once('error', r));
    fs.writeFileSync(remFile, '{ "reminders": [ oops ');
    check('broken reminders.json is reported, old list kept', await Promise.race([errored.then(() => true), sleep(4000).then(() => false)]) && config.reminders.length === 1);
    const back = new Promise((r) => config.once('reminders', r));
    fs.writeFileSync(remFile, original);
    await Promise.race([back, sleep(4000)]);
    check('restored reminders.json reloads', config.reminders.length === 4, `${config.reminders.length} reminders`);

    section('Tray menu');
    const tray = ctx.trayCtl;
    const find = (id, m = tray.menu()) => m.getMenuItemById(id);
    const labels = tray.menu().items.map((i) => i.label).filter(Boolean);
    check('tray icon exists', !tray.tray.isDestroyed());
    check('tray menu items', ['Tuck Away Pet', 'Mute Quips', 'Size', 'Open Settings', 'Open Config Folder', 'Start with Windows', 'Quit'].every((l) => labels.includes(l)), labels.join(' | '));
    quiet();
    brain.rest(60000);
    find('toggle').click();
    await sleep(300);
    rs = await rstate();
    check('Tuck Away Pet -> window hidden', !pet.win.isVisible() && brain.state === 'hidden');
    check('animation loop paused while tucked away (low CPU)', rs.paused && !rs.ticking && brain.mover === null && brain.timers.size === 0);
    check('menu now offers Wake Pet', find('toggle').label === 'Wake Pet');
    find('toggle').click();
    await sleep(300);
    rs = await rstate();
    check('Wake Pet -> visible and animating', pet.win.isVisible() && !rs.paused && rs.ticking);
    find('mute').click();
    check('Mute Quips toggles on', settings.get('muteQuips') === true && find('mute').checked);
    find('mute').click();
    check('Mute Quips toggles off', settings.get('muteQuips') === false);
    for (const s of [3, 1, 2]) {
      find(`size-${s}`).click();
      await sleep(250);
      rs = await rstate();
      check(`Size ${s}x resizes the pet`, Math.round(rs.canvas.width) === 48 * s && Math.abs(wb().height - (48 * s + 175)) <= 2 && brain.onFloor(), `canvas ${Math.round(rs.canvas.width)}px`);
      if (s === 3) await shot('size-3x');
    }
    find('config').click();
    check('Open Config Folder opens the config dir', opened[opened.length - 1] === config.dir);
    find('login').click();
    check('Start with Windows -> login item on', loginOn === true && find('login').checked);
    find('login').click();
    check('Start with Windows -> login item off', loginOn === false);
    find('settings').click();
    const sw = await waitFor(() => require('./windows').getSettingsWindow(), 3000);
    await waitFor(() => sw.isVisible(), 3000);
    await waitFor(() => js('document.getElementById("petName").value !== ""', sw.webContents), 3000);
    check('Open Settings opens the settings window', !!sw);
    const formOk = await js(`[document.getElementById('petName').value, document.querySelector('input[name=scale]:checked').value, document.getElementById('sleepTimeoutMinutes').value]`, sw.webContents);
    check('settings form shows current values', formOk[0] === 'Shadow' && formOk[1] === '2' && formOk[2] === '5', formOk.join(','));
    await shot('settings-window', sw.webContents);
    const saveResult = await js(`(async () => {
      document.getElementById('petName').value = 'Shadow Test';
      document.getElementById('quipMinMinutes').value = 25;
      document.getElementById('quipMaxMinutes').value = 35;
      document.getElementById('sleepTimeoutMinutes').value = 7;
      document.getElementById('apiKey').value = 'sk-test-phase2';
      document.getElementById('form').requestSubmit();
      await new Promise(r => setTimeout(r, 400));
      return document.getElementById('status').textContent;
    })()`, sw.webContents);
    const onDisk = JSON.parse(fs.readFileSync(h.paths.settingsFile(), 'utf8'));
    check('Save writes settings to the local JSON file', saveResult.includes('Saved') && onDisk.petName === 'Shadow Test' && onDisk.sleepTimeoutMinutes === 7 && onDisk.quipMinMinutes === 25, saveResult);
    check('API key saved per provider', onDisk.apiKeys && onDisk.apiKeys.gemini === 'sk-test-phase2' && onDisk.aiProvider === 'gemini');
    check('tray label follows the new pet name', tray.menu().items[0].label.includes('Shadow Test'));
    const q = (brain.nextQuipAt - Date.now()) / 60000;
    check('new quip frequency applied', q >= 24.9 && q <= 35.1, `${q.toFixed(1)} min`);
    sw.close();
    settings.update({ petName: 'Shadow', quipMinMinutes: 20, quipMaxMinutes: 40, sleepTimeoutMinutes: 5, apiKeys: {} });

    section('AI brain (fake local AI server - no real keys or internet)');
    const http = require('http');
    const ai = require('./ai');
    const seen = [];
    const mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const j = JSON.parse(body || '{}');
        seen.push({ url: req.url, auth: req.headers.authorization, body: j });
        const key = (req.headers.authorization || '').replace('Bearer ', '');
        const send = (code, obj) => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (key === 'bad') return send(401, { error: { message: 'Invalid API key' } });
        if (key === 'rate') return send(429, { error: { message: 'Rate limit reached for requests' } });
        if (j.model === 'missing') return send(404, { error: { message: 'The model `missing` does not exist' } });
        send(200, { choices: [{ message: { role: 'assistant', content: '<think>hmm, be cool</think>Arre Prince, mock brain online!' } }] });
      });
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${mock.address().port}/v1`;
    settings.update({ aiProvider: 'custom', aiBaseUrl: base, aiModel: 'mock-model', apiKeys: { custom: 'good' } });
    ctx.chatHistory.length = 0;
    quiet();
    const chat2 = h.openChatPanel();
    await waitFor(() => chat2.isVisible(), 3000);
    await waitFor(() => js('document.querySelectorAll(".msg.pet").length > 0', chat2.webContents), 3000);
    const brainLabel = await js('document.getElementById("brain").textContent', chat2.webContents);
    check('chat panel shows which brain is active', brainLabel.includes('Custom'), brainLabel);
    const say = (text) =>
      js(`(async () => {
        const replies = () => document.querySelectorAll('.msg.pet:not(.typing)');
        const n = replies().length;
        document.getElementById('msg').value = ${JSON.stringify(text)};
        document.getElementById('composer').requestSubmit();
        for (let k = 0; k < 100 && replies().length <= n; k++) await new Promise((r) => setTimeout(r, 50));
        const m = replies();
        return m[m.length - 1].textContent;
      })()`, chat2.webContents);
    const r1 = await say('Hello Shadow');
    check('chat reply comes from the AI provider', r1 === 'Arre Prince, mock brain online!', r1);
    check('reasoning <think> text is stripped from replies', !r1.includes('think'));
    const q1 = seen[seen.length - 1];
    const last = q1 && q1.body.messages[q1.body.messages.length - 1];
    check(
      'request: /chat/completions, Bearer key, model, personality as system prompt',
      q1 && q1.url === '/v1/chat/completions' && q1.auth === 'Bearer good' && q1.body.model === 'mock-model' &&
        q1.body.messages[0].role === 'system' && q1.body.messages[0].content.includes('Prince') && q1.body.messages[0].content.includes('1-2 short sentences'),
      q1 && `${q1.url} ${q1.auth} ${q1.body.model}`
    );
    check('request ends with the user message', last && last.role === 'user' && last.content === 'Hello Shadow');
    check('pet speaks the AI reply in its bubble', brain.bubble && brain.bubble.text === r1);
    await say('What did I just say?');
    const q2 = seen[seen.length - 1];
    const roles = q2.body.messages.map((m) => m.role).join(',');
    check('conversation memory: history sent as user/assistant turns', roles === 'system,user,assistant,user', roles);
    chat2.close();
    await waitFor(() => !h.getChatWindow(), 2000);

    const t = (over) => ai.testConnection({ provider: 'custom', baseUrl: base, model: 'mock-model', apiKey: 'good', petName: 'Shadow', personality: '', ...over });
    let tr = await t({ apiKey: 'bad' });
    check('bad key -> friendly "key didn\'t work" line', !tr.ok && tr.kind === 'auth' && tr.message.includes("didn't work"), tr.message);
    tr = await t({ apiKey: 'rate' });
    check('free quota used up -> friendly line', !tr.ok && tr.kind === 'rate' && tr.message.includes('quota'), tr.message);
    tr = await t({ model: 'missing' });
    check('unknown model -> friendly line', !tr.ok && tr.kind === 'model', tr.message);
    const before = seen.length;
    tr = await ai.testConnection({ provider: 'gemini', apiKey: '' });
    check('free provider without a key -> asks for a free key, makes no request', !tr.ok && tr.kind === 'no-key' && seen.length === before, tr.message);
    tr = await ai.testConnection({ provider: 'ollama', baseUrl: 'http://127.0.0.1:9/v1', model: 'gemma3:4b' });
    check('Ollama not running -> friendly line', !tr.ok && tr.kind === 'offline' && tr.message.includes('Ollama'), tr.message);
    const ok = await t({});
    check('Test Brain succeeds with a working provider', ok.ok && ok.reply === 'Arre Prince, mock brain online!');

    h.openSettings();
    const sw2 = await waitFor(() => require('./windows').getSettingsWindow(), 3000);
    await waitFor(() => js('document.querySelectorAll("#aiProvider option").length > 0', sw2.webContents), 3000);
    const opts = await js('[...document.querySelectorAll("#aiProvider option")].map(o => o.value).join(",")', sw2.webContents);
    check('Settings lists free providers (Gemini, Groq, OpenRouter, Ollama) + Claude + custom', opts === 'gemini,groq,openrouter,ollama,claude,custom', opts);
    const testText = await js(`(async () => { document.getElementById('testAi').click();
      for (let k = 0; k < 80 && !/Works|✗/.test(document.getElementById('testResult').textContent); k++) await new Promise(r => setTimeout(r, 50));
      return document.getElementById('testResult').textContent; })()`, sw2.webContents);
    check('Settings "Test brain" button works', testText.includes('Works'), testText);
    const ollamaUi = await js(`(() => { const s = document.getElementById('aiProvider'); s.value = 'ollama'; s.dispatchEvent(new Event('change'));
      return { keyHidden: document.getElementById('keyField').classList.contains('hidden'), urlShown: !document.getElementById('urlField').classList.contains('hidden'), help: document.getElementById('providerHelp').textContent }; })()`, sw2.webContents);
    check('choosing Ollama hides the key field and explains setup', ollamaUi.keyHidden && ollamaUi.urlShown && ollamaUi.help.includes('ollama pull'));
    await js("(() => { const s = document.getElementById('aiProvider'); s.value = 'gemini'; s.dispatchEvent(new Event('change')); document.querySelector('.brain').scrollIntoView(); })()", sw2.webContents);
    await sleep(400);
    await shot('settings-ai-brain', sw2.webContents);
    sw2.close();
    await new Promise((r) => mock.close(r));
    tr = await t({});
    check('AI server unreachable -> friendly line, no crash', !tr.ok && tr.kind === 'offline', tr.message);
    settings.update({ aiProvider: 'gemini', aiModel: '', aiBaseUrl: '', apiKeys: {} });

    section('Offline & performance');
    await sleep(500);
    check('no network requests made', network.length === 0, network.slice(0, 3).join(' '));
    const m = app.getAppMetrics();
    const cpu = m.reduce((s, x) => s + (x.cpu ? x.cpu.percentCPUUsage : 0), 0);
    check('CPU usage is low while idle', cpu < 25, `${cpu.toFixed(1)}% across ${m.length} processes`);
  } catch (err) {
    check('self-test crashed', false, err.stack);
  }

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ when: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` - ${failed.length} FAILED` : ''}`);
  console.log(`Report + screenshots: ${outDir}`);

  // finally exercise the tray's Quit item
  ctx.testExitCode = failed.length ? 1 : 0;
  app.on('will-quit', (e) => {
    e.preventDefault();
    app.exit(ctx.testExitCode);
  });
  const quitItem = ctx.trayCtl.menu().getMenuItemById('quit');
  quitItem.click();
  setTimeout(() => app.exit(ctx.testExitCode), 5000);
}

module.exports = { run, makeSensors };
