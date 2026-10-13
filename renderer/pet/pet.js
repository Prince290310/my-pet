'use strict';
/*
 * Pet renderer: plays sprite animations (<= 12 fps), shows speech bubbles, and handles
 * mouse input. Transparent pixels are click-through: we hit-test the drawn frame's alpha
 * and only ask main to capture the mouse while the cursor is over the panther or its bubble.
 */

const api = window.shadow;
let CELL = 48; // sprite cell size from the sheet's metadata (Shadow 48, friends 32)
const MAX_FPS = 12;

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
ctx.imageSmoothingEnabled = false;
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const tail = document.getElementById('bubble-tail');

let meta = null;
let sheet = null;
let scale = 2;
let workArea = null;
let testMode = false;
let paused = false;
let anim = { name: 'idle', facing: 'right', fps: 5, start: performance.now() };
let frameTimer = null;
let currentFrame = -1;
let frameData = null;
let interactive = false;

// ------------------------------------------------------------------ animation player
function animInfo() {
  return meta && meta.animations[anim.name];
}

function frameAt(now) {
  const a = animInfo();
  const f = Math.floor(((now - anim.start) * anim.fps) / 1000);
  return a.loop ? f % a.frames : Math.min(f, a.frames - 1);
}

function draw(a, f) {
  currentFrame = f;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, CELL, CELL);
  if (a.flip && anim.facing === 'left') ctx.setTransform(-1, 0, 0, 1, CELL, 0);
  ctx.drawImage(sheet, f * CELL, a.row * CELL, CELL, CELL, 0, 0, CELL, CELL);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  frameData = ctx.getImageData(0, 0, CELL, CELL).data;
  if (testMode) api.testFrame({ name: anim.name, frame: f, facing: anim.facing });
  dbg('draw ' + anim.name + ' ' + f);
}

let expectedAt = 0;
const dbgLog = [];
let debugMode = false;
const dbg = (m) => {
  if (testMode) dbgLog.push(Math.round(performance.now()) + ' ' + m);
  if (debugMode) console.log('[pet] ' + m);
};
const lateLog = [];

function tick() {
  clearTimeout(frameTimer);
  frameTimer = null;
  const a = animInfo();
  if (paused || !a || !sheet) return;
  const now = performance.now();
  if (testMode && expectedAt) lateLog.push(Math.round(now - expectedAt));
  expectedAt = 0;
  const f = frameAt(now);
  if (f !== currentFrame) draw(a, f);
  if (!bubble.classList.contains('hidden')) positionBubble();
  if (!a.loop && f >= a.frames - 1) return; // one-shot: hold the last frame
  const step = 1000 / anim.fps;
  const next = anim.start + (Math.floor((now - anim.start) / step) + 1) * step;
  expectedAt = now + Math.max(8, next - now);
  frameTimer = setTimeout(tick, Math.max(8, next - now));
}

function play({ name, facing, fps }) {
  dbg('play ' + name + ' fps=' + fps);
  if (!meta || !meta.animations[name]) return;
  anim = {
    name,
    facing: facing || anim.facing,
    fps: Math.min(MAX_FPS, fps || meta.animations[name].fps),
    start: performance.now(),
  };
  currentFrame = -1;
  tick();
}

function applyScale() {
  const S = CELL * scale;
  canvas.style.width = `${S}px`;
  canvas.style.height = `${S}px`;
  if (!bubble.classList.contains('hidden')) positionBubble();
}

// ------------------------------------------------------------------ speech bubble
function positionBubble() {
  const S = CELL * scale;
  const W = window.innerWidth;
  bubble.style.bottom = `${S - 6 * scale + 14}px`;
  const bw = bubble.offsetWidth;
  let visL = 8;
  let visR = W - 14;
  if (workArea) {
    // keep the bubble on-screen even when the window hangs off the screen edge
    visL = Math.max(visL, workArea.x - window.screenX + 8);
    visR = Math.min(visR, workArea.x + workArea.width - window.screenX - 14);
  }
  const petCenter = W / 2;
  let left = Math.round(petCenter - bw / 2);
  left = Math.max(visL, Math.min(left, visR - bw));
  bubble.style.left = `${left}px`;
  const tl = Math.round(Math.max(10, Math.min(bw - 31, petCenter - left - 10)));
  tail.style.left = `${tl}px`;
}

const bubbleHead = document.getElementById('bubble-head');
const bubbleHint = document.getElementById('bubble-hint');

function showBubble({ text, sticky, head, hint }) {
  bubbleText.textContent = text;
  bubbleHead.textContent = head || 'REMINDER';
  bubbleHint.textContent = hint || 'click when done ✓';
  bubble.classList.toggle('sticky', !!sticky);
  bubble.classList.remove('hidden');
  positionBubble();
}

function hideBubble() {
  bubble.classList.add('hidden');
  bubble.classList.remove('sticky');
}

// ------------------------------------------------------------------ hit testing / click-through
function hitPet(clientX, clientY) {
  if (!frameData) return false;
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((clientX - r.left) / r.width) * CELL);
  const y = Math.floor(((clientY - r.top) / r.height) * CELL);
  // forgiving 3x3 sprite-pixel test so the thin tail/legs are easy to grab
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || py < 0 || px >= CELL || py >= CELL) continue;
      if (frameData[(py * CELL + px) * 4 + 3] > 0) return true;
    }
  }
  return false;
}

function hitBubble(clientX, clientY) {
  if (bubble.classList.contains('hidden')) return false;
  const r = bubble.getBoundingClientRect();
  return clientX >= r.left - 3 && clientX <= r.right + 6 && clientY >= r.top - 3 && clientY <= r.bottom + 14;
}

function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  document.body.classList.toggle('hover', on);
  api.setInteractive(on);
}

// ------------------------------------------------------------------ mouse input
// Dragging: Windows does not deliver mouse-move events to a non-focusable window while the
// button is held, so the renderer only reports press start/end and the main process follows
// the real cursor in between (see 'pet:press-start' in main.js).
let press = null;
let clickTimer = null;

document.addEventListener('mousemove', (e) => {
  if (press) return;
  setInteractive(hitPet(e.clientX, e.clientY) || hitBubble(e.clientX, e.clientY));
});
document.addEventListener('mouseleave', () => {
  if (!press) setInteractive(false);
});
// The main process also reports the cursor ~16x/s while it's over this window, because Windows
// can stop forwarding mouse moves to a click-through window (after sleep, locking the PC or a long
// idle) - that used to leave Shadow and its reminder bubble unclickable. Each report carries the
// window's real clickable state too, so if the two ever disagree the next report fixes it.
api.onCursor((c) => {
  if (press || paused) return;
  const want = !!c.inside && (hitPet(c.x, c.y) || hitBubble(c.x, c.y));
  if (c.interactive !== want) interactive = !want; // force setInteractive() to tell main again
  setInteractive(want);
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !hitPet(e.clientX, e.clientY)) return;
  canvas.setPointerCapture(e.pointerId);
  press = { ctrl: e.ctrlKey || e.metaKey };
  document.body.classList.add('dragging');
  dbg('pointerdown');
  api.pressStart({ x: e.screenX, y: e.screenY, ctrl: press.ctrl });
});

async function endPress(e, cancelled) {
  dbg('endPress cancelled=' + cancelled + ' press=' + !!press);
  if (!press) return;
  const p = press;
  press = null;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* already released */
  }
  document.body.classList.remove('dragging');
  const { dragged } = await api.pressEnd();
  if (dragged) {
    setInteractive(hitPet(e.clientX, e.clientY));
    return;
  }
  if (cancelled) return;
  if (p.ctrl) return api.ctrlClick();
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    api.dblclick();
  } else {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      dbg('click fired');
      api.click();
    }, 260);
  }
}
// main ended a press whose button-up never arrived (released off-screen, sleep, lock...)
api.onPressReset(() => {
  press = null;
  document.body.classList.remove('dragging');
});
canvas.addEventListener('pointerup', (e) => endPress(e, false));
canvas.addEventListener('pointercancel', (e) => endPress(e, true));
canvas.addEventListener('lostpointercapture', () => dbg('lostpointercapture'));

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (hitPet(e.clientX, e.clientY)) api.contextMenu();
});

bubble.addEventListener('click', (e) => {
  e.stopPropagation();
  api.bubbleClick();
});

// ------------------------------------------------------------------ main -> renderer
let sheetVersion = 0;
api.onInit(async (init) => {
  const version = ++sheetVersion;
  clearTimeout(frameTimer);
  frameTimer = null;
  sheet = null;
  frameData = null;
  document.body.dataset.appearance = init.appearance || 'shadow';
  if (init.title) document.title = init.title;
  meta = init.meta;
  CELL = meta.frameWidth || 48;
  canvas.width = CELL;
  canvas.height = CELL;
  ctx.imageSmoothingEnabled = false;
  scale = init.scale;
  workArea = init.workArea;
  testMode = !!init.test;
  debugMode = !!init.debug;
  const img = new Image();
  img.src = init.sheet;
  await img.decode();
  if (version !== sheetVersion) return;
  sheet = img;
  applyScale();
  currentFrame = -1;
  tick();
});
api.onAnim(play);
api.onBubble(showBubble);
api.onBubbleHide(hideBubble);
api.onScale((d) => {
  scale = d.scale;
  applyScale();
});
api.onDisplay((d) => {
  workArea = d.workArea;
  if (!bubble.classList.contains('hidden')) positionBubble();
});
api.onPause(() => {
  paused = true;
  clearTimeout(frameTimer);
  frameTimer = null;
  hideBubble();
  setInteractive(false);
});
api.onResume(() => {
  paused = false;
  currentFrame = -1;
  tick();
});

// introspection used by `npm test` (self-test mode only reads these)
window.__shadowTest = {
  hitPet,
  hitBubble,
  lateness: () => lateLog.splice(0),
  log: () => dbgLog.splice(0),
  state: () => ({
    appearance: document.body.dataset.appearance,
    character: meta && meta.character,
    anim: anim.name,
    facing: anim.facing,
    fps: anim.fps,
    frame: currentFrame,
    paused,
    interactive,
    pressing: !!press,
    ticking: frameTimer !== null,
    bubble: bubble.classList.contains('hidden') ? null : { text: bubbleText.textContent, sticky: bubble.classList.contains('sticky') },
    canvas: canvas.getBoundingClientRect().toJSON(),
    bubbleRect: bubble.getBoundingClientRect().toJSON(),
  }),
};

api.ready();
setInterval(() => api.heartbeat(), 3000); // main reloads this page if these stop (crash/freeze)
