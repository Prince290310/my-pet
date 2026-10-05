'use strict';
/*
 * Generates Shadow's ORIGINAL pixel-art black panther sprite sheet + icons.
 *
 *   node scripts/generate-sprites.js
 *
 * Outputs (in assets/):
 *   sprites.png        - sprite sheet, 48x48 cells, one animation per row
 *   sprites.json       - animation metadata (row, frames, fps, loop, flip)
 *   icon.png/.ico      - app icon (panther head badge), 256px + multi-size ico
 *   tray.png/@2x.png   - 16/32px tray icon (panther head)
 *   preview/*.png      - big scaled previews for humans (not shipped in the app)
 *
 * Everything is drawn procedurally: shapes -> masks -> rim-lit shading + outline -> details.
 */

const fs = require('fs');
const path = require('path');
const { Bitmap, Mask, paint, ik } = require('./lib/raster');
const { encodePNG, encodeICO } = require('./lib/png');

const OUT = path.join(__dirname, '..', 'assets');
const CELL = 48;
const COLS = 8;

// ---------------------------------------------------------------- palette
const C = {
  outline: '#07050c',
  base: '#161221',
  dark: '#0c0a13',
  seam: '#0b0812',
  rim: '#5747b4',
  rim2: '#2a2152',
  gloss: '#8f7df2',
  gloss2: '#c4b8ff',
  farBase: '#100d18',
  farRim: '#2a2148',
  farDark: '#0a0810',
  muzzle: '#272036',
  innerEar: '#5a2f73',
  eye: '#ffd21f',
  eyeHi: '#fff7c2',
  eyeEdge: '#ff9a0d',
  eyeDim: '#a8790c',
  eyeGlow: '#4a3210',
  pupil: '#170b00',
  nose: '#3d3354',
  noseHi: '#6d5d94',
  mouthLine: '#0a0710',
  mouthIn: '#5c1030',
  tongue: '#ff6f91',
  fang: '#f6f2ff',
  whisker: '#7b72a0',
  heart: '#ff3d6e',
  heartHi: '#ffc2d1',
  heartOut: '#4d0820',
  zzz: '#d2e3ff',
  zzzOut: '#1b2650',
  alert: '#ffe14d',
  alertOut: '#4a2c00',
  blush: '#ff5c8a',
};
const BODY = { base: C.base, rim: C.rim, rim2: C.rim2, dark: C.dark, seam: C.seam, outline: C.outline };
const FAR = { base: C.farBase, rim: C.farRim, rim2: C.farBase, dark: C.farDark, outline: C.outline };

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const R = Math.round;

function glossTop(bmp, mask, x0, x1, color = C.gloss) {
  for (let x = x0; x <= x1; x++) {
    const y = mask.top(x);
    if (y >= 0) bmp.set(x, y, color);
  }
}

// ---------------------------------------------------------------- side view (facing right)
const SIDE = {
  hip: [15, 29],
  shoulder: [31, 30],
  head: [37, 20],
  paws: { hn: [17, 45.5], hf: [14, 45.5], fn: [33, 45.5], ff: [30, 45.5] },
  elbows: {},
  hocks: {},
  tail: [[11, 27], [6.5, 28.5], [4, 25], [3.5, 19.5], [5.5, 15.5], [8, 14.5]],
  tailR: [1.9, 1.0],
  eye: 'open',
  mouth: 'closed',
  ears: 'normal',
};

function frontLeg(m, s, p, elbow) {
  const e = elbow || ik(s, p, 7.2, 7.6, 1);
  m.capsule(s[0], s[1], e[0], e[1], 2.6, 2.0);
  m.capsule(e[0], e[1], p[0], p[1], 1.9, 1.5);
  m.ellipse(p[0] + 0.8, p[1], 2.2, 1.25);
}

function backLeg(m, h, p, hock) {
  const k2 = hock || [p[0] - 2.0, p[1] - 4.5];
  const knee = ik(h, k2, 6.2, 6.4, -1);
  m.capsule(h[0], h[1], knee[0], knee[1], 3.4, 2.3);
  m.capsule(knee[0], knee[1], k2[0], k2[1], 2.0, 1.6);
  m.capsule(k2[0], k2[1], p[0], p[1], 1.5, 1.4);
  m.ellipse(p[0] + 0.8, p[1], 2.2, 1.2);
}

function sideEars(P) {
  const h = P.head;
  if (P.ears === 'back') {
    return {
      near: [add(h, [-3.2, -2.6]), add(h, [-5.6, -6.4]), add(h, [0.6, -4.0])],
      far: [add(h, [-5.0, -2.0]), add(h, [-7.2, -5.2]), add(h, [-2.4, -3.6])],
    };
  }
  if (P.ears === 'up') {
    return {
      near: [add(h, [-2.0, -3.6]), add(h, [-0.4, -10.0]), add(h, [2.2, -3.8])],
      far: [add(h, [-4.4, -2.4]), add(h, [-3.4, -8.8]), add(h, [-1.2, -3.6])],
    };
  }
  return {
    near: [add(h, [-2.6, -3.2]), add(h, [-0.8, -7.8]), add(h, [2.6, -3.4])],
    far: [add(h, [-4.6, -2.2]), add(h, [-3.8, -7.6]), add(h, [-1.2, -3.4])],
  };
}

function side(over = {}) {
  const P = {
    ...SIDE,
    ...over,
    paws: { ...SIDE.paws, ...(over.paws || {}) },
    elbows: { ...(over.elbows || {}) },
    hocks: { ...(over.hocks || {}) },
  };
  const bmp = new Bitmap(CELL, CELL);
  const ears = sideEars(P);
  const [hx, hy] = P.head;
  const drop = P.mouth === 'yawn' ? 2 : 0;

  // far side: legs + ear (darker, behind everything)
  const far = new Mask(CELL, CELL);
  frontLeg(far, add(P.shoulder, [-2.5, 0.5]), P.paws.ff, P.elbows.ff);
  backLeg(far, add(P.hip, [-2.5, 0.5]), P.paws.hf, P.hocks.hf);
  far.poly(ears.far);
  paint(bmp, far, FAR);

  // tail (behind the body)
  const tail = new Mask(CELL, CELL).spline(P.tail, P.tailR[0], P.tailR[1]);
  paint(bmp, tail, BODY);

  // body
  const body = new Mask(CELL, CELL);
  body.capsule(P.hip[0], P.hip[1], P.shoulder[0], P.shoulder[1], 5.2, 5.2);
  body.ellipse(P.hip[0], P.hip[1] + 0.5, 6.2, 6.0);
  body.ellipse(P.shoulder[0] + 0.5, P.shoulder[1] + 0.5, 5.0, 6.0);
  body.capsule(P.shoulder[0] + 1, P.shoulder[1] - 2, hx - 3, hy + 2, 3.8, 3.4);
  paint(bmp, body, BODY);
  const mid = R((P.hip[0] + P.shoulder[0]) / 2);
  glossTop(bmp, body, mid - 5, mid + 2);
  bmp.set(mid - 2, body.top(mid - 2), C.gloss2);

  // near legs
  const near = new Mask(CELL, CELL);
  frontLeg(near, add(P.shoulder, [0.5, 1]), P.paws.fn, P.elbows.fn);
  backLeg(near, add(P.hip, [1, 1]), P.paws.hn, P.hocks.hn);
  paint(bmp, near, BODY, { cover: body });

  // head
  const head = new Mask(CELL, CELL);
  head.ellipse(hx, hy, 5.3, 4.6);
  head.ellipse(hx + 4.8, hy + 2.0, 3.2, 2.4); // muzzle
  head.ellipse(hx + 3.2, hy + 3.4 + drop, 2.8, 1.6); // jaw
  if (drop) head.rect(R(hx + 1), R(hy + 2), 6, 3);
  head.poly(ears.near);
  paint(bmp, head, BODY, { cover: body });
  glossTop(bmp, head, R(hx - 2), R(hx + 1));

  // inner ear
  const ec = [(ears.near[0][0] + ears.near[1][0] + ears.near[2][0]) / 3, (ears.near[0][1] + ears.near[1][1] + ears.near[2][1]) / 3];
  bmp.set(ec[0], ec[1], C.innerEar);
  bmp.set(ec[0], ec[1] + 1, C.innerEar);

  // muzzle tone + nose + mouth
  bmp.set(hx + 5, hy + 2, C.muzzle);
  bmp.set(hx + 6, hy + 2, C.muzzle);
  bmp.set(hx + 7, hy + 1, C.nose);
  bmp.set(hx + 7, hy + 0, C.noseHi);
  if (P.mouth === 'yawn') {
    bmp.pattern(R(hx + 2), R(hy + 2), ['.RRRRR', 'RRPPRR', '.RRRRR'], { R: C.mouthIn, P: C.tongue });
    bmp.set(hx + 6, hy + 2, C.fang);
    bmp.set(hx + 6, hy + 4, C.fang);
  } else if (P.mouth === 'open') {
    bmp.pattern(R(hx + 4), R(hy + 3), ['RRR'], { R: C.mouthIn });
  } else {
    bmp.line(hx + 4, hy + 3, hx + 6, hy + 3, C.mouthLine);
  }

  // eye
  const ex = R(hx + 1), ey = R(hy - 1);
  const eyeMap = { Y: C.eye, W: C.eyeHi, K: C.pupil, a: C.eyeEdge, d: C.eyeDim, g: C.eyeGlow };
  if (P.eye === 'closed') {
    bmp.pattern(ex, ey, ['...', 'ddd'], eyeMap);
  } else if (P.eye === 'wide') {
    bmp.pattern(ex - 1, ey - 1, ['.aYY', 'gYKW', 'gYKY', '.aYY'], eyeMap);
  } else {
    bmp.pattern(ex - 1, ey, ['gaYW', 'gYKY'], eyeMap);
  }

  // whiskers
  bmp.line(hx + 6, hy + 2, hx + 10, hy + 1, C.whisker);
  bmp.line(hx + 6, hy + 3, hx + 10, hy + 4, C.whisker);

  return bmp;
}

// ---------------------------------------------------------------- front view (sitting)
const TAILS = {
  curl: [[31, 43], [36.5, 42.5], [40, 39], [40.6, 33.5], [39, 29.5]],
  flick: [[31, 43], [36.5, 42.5], [40.5, 38.5], [42, 33], [42.4, 28.4]],
  flick2: [[31, 43], [36.5, 42.5], [40.2, 39], [41.2, 34], [43.5, 31]],
  up: [[31, 41], [36, 39.5], [38.6, 33.5], [39.2, 26.5], [38.6, 20.5]],
  wrap: [[35.5, 40.5], [37.6, 43.6], [34.5, 46], [27, 46.4], [20, 46.2], [15.6, 44.6]],
  wrap2: [[35.5, 40.5], [37.6, 43.6], [34.5, 46], [27, 46.4], [19.6, 45.8], [15.8, 42.8]],
};

function front(o = {}) {
  const P = {
    dx: 0,
    dy: 0,
    headD: [0, 0],
    ears: 'normal',
    eyes: 'open',
    mouth: 'closed',
    tail: 'curl',
    tailR: [2.0, 1.1],
    pawL: null,
    blush: false,
    ...o,
  };
  const bmp = new Bitmap(CELL, CELL);
  const dx = P.dx, dy = P.dy;
  const hx = 24 + dx + P.headD[0], hy = 17 + dy + P.headD[1];
  const tailPts = (TAILS[P.tail] || P.tail).map(([x, y]) => [x + dx, y]);
  const tailInFront = P.tail === 'wrap' || P.tail === 'wrap2';

  if (!tailInFront) paint(bmp, new Mask(CELL, CELL).spline(tailPts, P.tailR[0], P.tailR[1]), BODY);

  // body: haunches + chest + hind feet
  const body = new Mask(CELL, CELL);
  body.ellipse(24 + dx, 39.5 + dy * 0.5, 11, 7);
  body.ellipse(24 + dx, 30 + dy, 7.2, 9.5);
  body.ellipse(24 + dx, 23.5 + dy, 6.2, 4);
  body.ellipse(13.8 + dx, 45.2, 3.2, 1.4);
  body.ellipse(34.2 + dx, 45.2, 3.2, 1.4);
  paint(bmp, body, BODY);
  glossTop(bmp, body, 14 + dx, 16 + dx);
  glossTop(bmp, body, 32 + dx, 34 + dx);

  // front legs
  const legs = new Mask(CELL, CELL);
  const lx = 20.3 + dx, rx = 27.7 + dx;
  if (!P.pawL) {
    legs.capsule(lx, 31 + dy, lx, 44.2, 2.6, 2.1);
    legs.ellipse(lx, 45.2, 2.7, 1.5);
  }
  legs.capsule(rx, 31 + dy, rx, 44.2, 2.6, 2.1);
  legs.ellipse(rx, 45.2, 2.7, 1.5);
  paint(bmp, legs, BODY, { cover: body });
  // chest gloss between the legs
  bmp.set(24 + dx, 27 + dy, C.rim2);
  bmp.set(24 + dx, 28 + dy, C.rim2);

  if (tailInFront) paint(bmp, new Mask(CELL, CELL).spline(tailPts, P.tailR[0], P.tailR[1]), BODY);

  // head
  const head = new Mask(CELL, CELL);
  head.ellipse(hx, hy, 8.4, 6.6);
  head.ellipse(hx, hy + 2.6, 9.2, 4.4);
  let earL = [[hx - 8, hy - 2.2], [hx - 6.6, hy - 10], [hx - 2.4, hy - 5.4]];
  let earR = [[hx + 8, hy - 2.2], [hx + 6.6, hy - 10], [hx + 2.4, hy - 5.4]];
  if (P.ears === 'up') {
    earL = [[hx - 7.6, hy - 3], [hx - 6.4, hy - 12], [hx - 3, hy - 5.6]];
    earR = [[hx + 7.6, hy - 3], [hx + 6.4, hy - 12], [hx + 3, hy - 5.6]];
  } else if (P.ears === 'twitch') {
    earR = [[hx + 8, hy - 2.2], [hx + 8.8, hy - 9.2], [hx + 2.6, hy - 5.2]];
  } else if (P.ears === 'flat') {
    earL = [[hx - 8.6, hy - 1.6], [hx - 9, hy - 7.4], [hx - 3, hy - 5.2]];
    earR = [[hx + 8.6, hy - 1.6], [hx + 9, hy - 7.4], [hx + 3, hy - 5.2]];
  }
  head.poly(earL);
  head.poly(earR);
  paint(bmp, head, BODY);
  glossTop(bmp, head, R(hx - 4), R(hx - 2));
  bmp.set(hx - 3, head.top(R(hx - 3)), C.gloss2);

  // inner ears
  for (const ear of [earL, earR]) {
    const cx = (ear[0][0] + ear[1][0] + ear[2][0]) / 3, cy = (ear[0][1] + ear[1][1] + ear[2][1]) / 3;
    bmp.set(cx, cy, C.innerEar);
    bmp.set(cx, cy + 1, C.innerEar);
  }

  // muzzle patch
  const mz = new Mask(CELL, CELL).ellipse(hx, hy + 3.8, 3.6, 2.3);
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) if (mz.get(x, y)) bmp.set(x, y, C.muzzle);

  // eyes
  const eyeMap = { Y: C.eye, W: C.eyeHi, K: C.pupil, a: C.eyeEdge, d: C.eyeDim, g: C.eyeGlow };
  const lx0 = R(hx - 6), rx0 = R(hx + 2), ey = R(hy - 1);
  const EYES = {
    open: { L: ['aYY.', 'YWKY', '.YKY'], R: ['.YYa', 'YKWY', 'YKY.'] },
    wide: { L: ['.YY.', 'YWYY', 'YYKY', '.YY.'], R: ['.YY.', 'YYWY', 'YKYY', '.YY.'] },
    closed: { L: ['....', '....', 'dddd'], R: ['....', '....', 'dddd'] },
    happy: { L: ['....', '.dd.', 'd..d'], R: ['....', '.dd.', 'd..d'] },
    half: { L: ['....', 'dddd', '.YKY'], R: ['....', 'dddd', 'YKY.'] },
  };
  const eyes = EYES[P.eyes];
  const eyOff = P.eyes === 'wide' ? -1 : 0;
  bmp.pattern(lx0, ey + eyOff, eyes.L, eyeMap);
  bmp.pattern(rx0, ey + eyOff, eyes.R, eyeMap);
  if (P.eyes === 'open' || P.eyes === 'wide') {
    bmp.set(lx0 - 1, ey + 1, C.eyeGlow);
    bmp.set(rx0 + 4, ey + 1, C.eyeGlow);
  }
  if (P.blush) {
    bmp.set(lx0, ey + 3, C.blush);
    bmp.set(lx0 + 1, ey + 3, C.blush);
    bmp.set(rx0 + 2, ey + 3, C.blush);
    bmp.set(rx0 + 3, ey + 3, C.blush);
  }

  // nose + mouth
  bmp.pattern(R(hx - 1), R(hy + 2), ['hN', 'NN'], { N: C.nose, h: C.noseHi });
  const mx = R(hx - 2), my = R(hy + 4);
  const mouthMap = { m: C.mouthLine, R: C.mouthIn, P: C.tongue, F: C.fang };
  const MOUTHS = {
    closed: ['m..m', '.mm.'],
    open1: ['mRRm', '.mm.'],
    open2: ['FRRF', 'mRRm', 'mPPm', '.mm.'],
    smile: ['m..m', 'mPPm', '.mm.'],
    tongue: ['m..m', '.PP.', '.PP.'],
    o: ['.mm.', 'mRRm', '.mm.'],
  };
  bmp.pattern(mx, my, MOUTHS[P.mouth], mouthMap);

  // whiskers
  bmp.line(hx - 4, hy + 4, hx - 10, hy + 3, C.whisker);
  bmp.line(hx - 4, hy + 5, hx - 10, hy + 6, C.whisker);
  bmp.line(hx + 4, hy + 4, hx + 10, hy + 3, C.whisker);
  bmp.line(hx + 4, hy + 5, hx + 10, hy + 6, C.whisker);

  if (P.pawL) {
    // raised (grooming) left paw, in front of the face; tongue drawn on top
    const paw = new Mask(CELL, CELL);
    paw.capsule(lx, 33 + dy, P.pawL[0] + dx, P.pawL[1] + dy, 2.4, 2.1);
    paw.ellipse(P.pawL[0] + dx, P.pawL[1] + dy - 0.5, 2.4, 2.0);
    paint(bmp, paw, BODY);
    if (P.mouth === 'tongue') bmp.pattern(mx, my, MOUTHS.tongue, mouthMap);
  }

  return bmp;
}

// ---------------------------------------------------------------- effects
const HEART = ['.H.H.', 'HhHHH', 'HHHHH', '.HHH.', '..H..'];
function heart(bmp, x, y) {
  bmp.stamp(R(x), R(y), HEART, { H: C.heart, h: C.heartHi }, C.heartOut);
}
// thick 2px diagonals so the Z still reads as a "Z" at 1x
const ZS = {
  4: ['ZZZZ', '..ZZ', '.ZZ.', 'ZZ..', 'ZZZZ'],
  5: ['ZZZZZ', '...ZZ', '..ZZ.', '.ZZ..', 'ZZZZZ'],
  6: ['ZZZZZZ', '....ZZ', '...ZZ.', '..ZZ..', '.ZZ...', 'ZZZZZZ'],
};
function zee(bmp, x, y, size) {
  bmp.stamp(R(x), R(y), ZS[size], { Z: C.zzz }, C.zzzOut);
}
function bang(bmp, x, y) {
  bmp.stamp(R(x), R(y), ['AA', 'AA', 'AA', 'AA', '..', 'AA'], { A: C.alert }, C.alertOut);
}

// ---------------------------------------------------------------- sleeping (curled up)
function sleeping(f) {
  const bmp = new Bitmap(CELL, CELL);
  const breath = [0, 0.3, 0.7, 0.7, 0.3, 0][f];
  const body = new Mask(CELL, CELL);
  body.ellipse(21, 40.4 - breath * 0.5, 13.4, 6.2 + breath);
  body.ellipse(18, 37.6 - breath * 0.6, 10.2, 8 + breath);
  body.ellipse(27, 38.6 - breath * 0.5, 7, 6.4 + breath);
  paint(bmp, body, BODY);
  glossTop(bmp, body, 12, 18);
  bmp.set(15, body.top(15), C.gloss2);
  // haunch curve
  const haunch = new Mask(CELL, CELL).ellipse(13.5, 40.5, 5.6, 5);
  paint(bmp, haunch, BODY, { cover: body });

  // front paw peeking out under the chin
  const paw = new Mask(CELL, CELL).ellipse(36, 44.8, 3.6, 1.6);
  paint(bmp, paw, BODY);

  // tail wrapped around the front, tip curling up
  const tail = new Mask(CELL, CELL).spline([[8, 38.5], [7, 43.5], [12, 46.2], [20, 46.4], [27, 45.6], [30.5, 43.4]], 2.2, 1.2);
  paint(bmp, tail, BODY);

  // head resting on the right, facing the viewer, eyes closed
  const hx = 33.5, hy = 37 + breath * 0.3;
  const head = new Mask(CELL, CELL);
  head.ellipse(hx, hy, 7.2, 5.4);
  head.ellipse(hx, hy + 1.8, 7.8, 3.8);
  head.poly([[hx - 7, hy - 1.6], [hx - 6.2, hy - 8.4], [hx - 2, hy - 4.8]]);
  head.poly([[hx + 7, hy - 1.6], [hx + 6.2, hy - 8.4], [hx + 2, hy - 4.8]]);
  paint(bmp, head, BODY);
  glossTop(bmp, head, R(hx - 3), R(hx - 1));
  bmp.set(hx - 4.7, hy - 4.4, C.innerEar);
  bmp.set(hx + 4.7, hy - 4.4, C.innerEar);
  const mz = new Mask(CELL, CELL).ellipse(hx, hy + 2.6, 2.8, 1.8);
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) if (mz.get(x, y)) bmp.set(x, y, C.muzzle);
  const d = { d: C.eyeDim };
  bmp.pattern(R(hx - 5), R(hy), ['d..d', '.dd.'], d);
  bmp.pattern(R(hx + 1), R(hy), ['d..d', '.dd.'], d);
  bmp.pattern(R(hx - 1), R(hy + 2), ['hN'], { N: C.nose, h: C.noseHi });
  bmp.set(hx - 1, hy + 3.5, C.mouthLine);
  bmp.set(hx, hy + 3.5, C.mouthLine);
  bmp.line(hx + 4, hy + 2, hx + 9, hy + 1, C.whisker);
  bmp.line(hx + 4, hy + 3, hx + 9, hy + 4, C.whisker);

  // floating Zzz stream
  const POS = [[38.5, 23], [39.5, 15.5], [40.5, 8], [41, 1]];
  const SIZE = [4, 5, 5, 6];
  for (let k = 0; k < 2; k++) {
    const t = (f + 3 * k) % 6;
    if (t < 4) zee(bmp, POS[t][0], POS[t][1], SIZE[t]);
  }
  return bmp;
}

// ---------------------------------------------------------------- animations
function walkFrame(f, n = 8) {
  const ph = (f / n) * Math.PI * 2;
  const leg = (off, base) => {
    const th = ph + off * Math.PI * 2;
    const dx = 3.3 * Math.cos(th);
    const lift = Math.max(0, -Math.sin(th)) * 2.2;
    return [base[0] + dx, base[1] - lift];
  };
  const bob = f % 4 === 1 || f % 4 === 2 ? -0.6 : 0;
  const s = Math.sin(ph);
  return side({
    hip: [15, 29 + bob],
    shoulder: [31, 30 + bob * 0.6],
    head: [37, 20 + bob * 0.6],
    paws: {
      hn: leg(0, [17, 45.5]),
      fn: leg(0.25, [33, 45.5]),
      hf: leg(0.5, [14, 45.5]),
      ff: leg(0.75, [30, 45.5]),
    },
    tail: [[11, 27.5], [6.5, 29.5 + s * 0.8], [3.5, 28.5 + s], [2.5, 25 + s * 0.6], [3.5, 21.5 + s * 0.3]],
  });
}

const ANIMS = [];
function anim(name, frames, fps, loop, flip, note) {
  ANIMS.push({ name, frames, fps, loop, flip, note });
}

// idle: standing side view with tail flicks + a blink
anim('idle', [
  side(),
  side({ tail: [[11, 27], [6.5, 28.5], [4, 25], [3.5, 19.5], [5, 15.2], [7.6, 13.8]] }),
  side({ tail: [[11, 27], [6.5, 28.5], [4, 25], [3.4, 19.5], [4.2, 15], [6.6, 12.4]] }),
  side({ tail: [[11, 27], [6.5, 28.2], [3.8, 24], [3, 18.5], [2.6, 14], [3.6, 10.6]] }),
  side(),
  side({ eye: 'closed' }),
  side({ hip: [15, 28.6], shoulder: [31, 29.6] }),
  side(),
], 5, true, true, 'standing, blink + tail flick');

const walk = Array.from({ length: 8 }, (_, f) => walkFrame(f));
anim('walk_right', walk, 10, true, false, 'walk cycle facing right');
anim('walk_left', walk.map((b) => {
  const m = new Bitmap(CELL, CELL);
  m.blit(b, 0, 0, true);
  return m;
}), 10, true, false, 'mirrored walk cycle');

anim('sit', [
  front({ tail: 'wrap' }),
  front({ tail: 'wrap' }),
  front({ tail: 'wrap2' }),
  front({ tail: 'wrap', ears: 'twitch' }),
  front({ tail: 'wrap', eyes: 'closed' }),
  front({ tail: 'wrap' }),
], 3, true, false, 'sitting, tail wrapped around paws');

anim('sleep', Array.from({ length: 6 }, (_, f) => sleeping(f)), 3, true, false, 'curled up, breathing, Zzz');

anim('talk', [
  front({ mouth: 'closed' }),
  front({ mouth: 'open1', headD: [0, -0.4] }),
  front({ mouth: 'open2', headD: [0, -0.4] }),
  front({ mouth: 'open1', tail: 'flick' }),
], 8, true, false, 'mouth moving');

anim('happy', Array.from({ length: 6 }, (_, f) => {
  const b = front({ eyes: 'happy', mouth: 'smile', blush: true, dx: [0, 1, 0, -1, 0, 1][f], tail: f % 2 ? 'flick' : 'curl' });
  for (let k = 0; k < 2; k++) {
    const t = (f + 3 * k) % 6;
    if (t >= 5) continue;
    if (k === 0) heart(b, 6 - t * 0.4, 22 - t * 4.4);
    else heart(b, 38 + t * 0.4, 18 - t * 3.6);
  }
  return b;
}), 7, true, false, 'purring with hearts');

const bowTail = [[11, 26], [8, 22.5], [6.5, 17.5], [7.2, 12.8], [9.8, 10.2]];
anim('stretch', [
  side(),
  side({ shoulder: [32, 33], head: [38, 25], paws: { fn: [37, 45.5], ff: [35, 45.5] }, tail: [[11, 26.5], [7, 26], [5, 21], [5.2, 16], [7.5, 13]] }),
  side({ shoulder: [33, 37], head: [39, 31.5], eye: 'closed', paws: { fn: [42, 45.5], ff: [40, 45.5] }, elbows: { fn: [34.5, 44], ff: [32.5, 44] }, tail: bowTail }),
  side({ shoulder: [33, 37], head: [39, 31.5], eye: 'closed', mouth: 'yawn', paws: { fn: [42, 45.5], ff: [40, 45.5] }, elbows: { fn: [34.5, 44], ff: [32.5, 44] }, tail: bowTail }),
  side({ shoulder: [33, 37], head: [39, 31.5], eye: 'closed', mouth: 'yawn', paws: { fn: [42, 45.5], ff: [40, 45.5] }, elbows: { fn: [34.5, 44], ff: [32.5, 44] }, tail: [[11, 26], [8, 22.5], [6.2, 17.5], [6.2, 12.6], [7.8, 9.6]] }),
  side({ shoulder: [32, 33], head: [38, 25], paws: { fn: [37, 45.5], ff: [35, 45.5] }, tail: [[11, 26.5], [7, 26], [5, 21], [5.2, 16], [7.5, 13]] }),
], 5, false, true, 'play-bow stretch + yawn');

const crouchTail = [[10, 31], [6, 33], [2.5, 33.6], [1, 32]];
anim('pounce', [
  side({ hip: [15, 33], shoulder: [31, 35], head: [37.5, 28], eye: 'wide', ears: 'back', tail: crouchTail }),
  side({ hip: [14, 32.4], shoulder: [31, 35], head: [37.5, 28], eye: 'wide', ears: 'back', tail: [[10, 30.5], [6, 32], [2.5, 31], [1.5, 28.5]] }),
  side({ hip: [16, 33.2], shoulder: [31, 35], head: [37.5, 28], eye: 'wide', ears: 'back', tail: crouchTail }),
  side({ hip: [14.5, 32.6], shoulder: [31, 35], head: [37.5, 28], eye: 'wide', ears: 'back', tail: [[10, 30.5], [6, 32], [2.5, 31], [1.5, 28.5]] }),
  side({ hip: [14, 30], shoulder: [31, 26], head: [38, 19], eye: 'wide', paws: { fn: [39.5, 32], ff: [37.5, 34], hn: [9, 45.5], hf: [11, 45.5] }, elbows: { fn: [36, 31.5], ff: [34, 33] }, hocks: { hn: [11, 41], hf: [13, 41] }, tail: [[10, 29.5], [5, 31.5], [1.5, 33]] }),
  side({ hip: [13, 26], shoulder: [30, 24], head: [37, 18], eye: 'wide', mouth: 'open', paws: { fn: [44, 27], ff: [42, 29.5], hn: [4.5, 33], hf: [6.5, 35] }, elbows: { fn: [37, 26.5], ff: [35, 28.5] }, hocks: { hn: [7.5, 31.5], hf: [9.5, 33.5] }, tail: [[9, 26], [4.5, 26], [0.5, 24.5]] }),
  side({ hip: [16, 27], shoulder: [32, 33], head: [38.5, 26], eye: 'wide', paws: { fn: [37, 45.5], ff: [35, 45.5], hn: [13, 38], hf: [15, 39] }, hocks: { hn: [11, 35], hf: [13, 36] }, tail: [[11, 25.5], [6.5, 24], [3, 22]] }),
  side({ hip: [15, 31], shoulder: [31, 33], head: [37.5, 25], tail: [[10.5, 29], [6, 30.5], [3, 28.5], [2.5, 25]] }),
], 8, false, true, 'crouch, butt wiggle, leap, land');

anim('alert', [
  (() => { const b = front({ ears: 'up', eyes: 'wide', mouth: 'o', tail: 'up', tailR: [2.5, 1.7], dy: -0.5 }); bang(b, 41, 3); return b; })(),
  (() => { const b = front({ ears: 'up', eyes: 'wide', mouth: 'o', tail: 'up', tailR: [2.5, 1.7], dy: -0.5 }); bang(b, 41, 1); return b; })(),
  (() => { const b = front({ ears: 'up', eyes: 'wide', mouth: 'closed', tail: 'up', tailR: [2.5, 1.7], dy: -0.5 }); bang(b, 41, 2); return b; })(),
  (() => { const b = front({ ears: 'up', eyes: 'wide', mouth: 'closed', tail: 'up', tailR: [2.5, 1.7], dy: -0.5 }); bang(b, 41, 3); return b; })(),
], 6, true, false, 'ears up, eyes wide, "!"');

anim('groom', [
  front({ pawL: [19.5, 31], headD: [0, 0.4] }),
  front({ pawL: [19, 25.5], headD: [-0.6, 0.8], eyes: 'closed' }),
  front({ pawL: [19, 24.5], headD: [-0.6, 0.8], eyes: 'closed', mouth: 'tongue' }),
  front({ pawL: [19, 25.5], headD: [-0.6, 0.8], eyes: 'closed' }),
  front({ pawL: [19, 24.5], headD: [-0.6, 0.8], eyes: 'closed', mouth: 'tongue' }),
  front({ pawL: [19.5, 31], headD: [0, 0.4], eyes: 'half' }),
], 6, true, false, 'licking a paw');

// ---------------------------------------------------------------- sheet
function buildSheet() {
  const sheet = new Bitmap(COLS * CELL, ANIMS.length * CELL);
  const meta = { frameWidth: CELL, frameHeight: CELL, columns: COLS, animations: {} };
  ANIMS.forEach((a, row) => {
    if (a.frames.length > COLS) throw new Error(`${a.name}: too many frames`);
    if (a.frames.length < 4) throw new Error(`${a.name}: needs at least 4 frames`);
    a.frames.forEach((b, col) => sheet.blit(b, col * CELL, row * CELL));
    meta.animations[a.name] = { row, frames: a.frames.length, fps: Math.min(12, a.fps), loop: a.loop, flip: a.flip, note: a.note };
  });
  return { sheet, meta };
}

// ---------------------------------------------------------------- icons
const TRAY16 = [
  '................',
  '.OOO........OOO.',
  '.OPHO......OHPO.',
  '.OPBBOOOOOOBBPO.',
  'OBBBBHHHHHHBBBBO',
  'OBBBBBBBBBBBBBBO',
  'OBYYYBBBBBBYYYBO',
  'OBYWKYBBBBYKWYBO',
  'OBBYKBBBBBBKYBBO',
  'OBBBBBBBBBBBBBBO',
  '.OBBBBBNNBBBBBO.',
  '.OBBBBBMMBBBBBO.',
  '..OBBBMBBMBBBO..',
  '...OOBBBBBBOO...',
  '.....OOOOOO.....',
  '................',
];
const TRAY_MAP = {
  O: '#a08cff', B: C.base, H: C.rim, P: '#7a4a9c', Y: C.eye, W: C.eyeHi, K: C.pupil, N: C.noseHi, M: '#4b4166',
};

function icon32() {
  const b = new Bitmap(32, 32);
  // bold round badge
  const disc = new Mask(32, 32).ellipse(16, 16, 15.6, 15.6);
  const inner = new Mask(32, 32).ellipse(16, 16, 14.4, 14.4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (inner.get(x, y)) b.set(x, y, y < 9 ? '#6a55c8' : y < 18 ? '#5341a8' : '#3f3088');
      else if (disc.get(x, y)) b.set(x, y, '#c9bcff');
    }
  }
  const face = front({ eyes: "open" }).crop(12, 5, 24, 20);
  b.blit(face, 4, 7);
  return b;
}

// ---------------------------------------------------------------- previews
function checker(w, h, a = '#3b3b48', bcol = '#2e2e38', size = 8) {
  const b = new Bitmap(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set(x, y, ((x / size) ^ (y / size)) & 1 ? a : bcol);
  return b;
}

function writePNG(file, bmp) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePNG(bmp.w, bmp.h, bmp.px));
}

function main() {
  const { sheet, meta } = buildSheet();
  writePNG(path.join(OUT, 'sprites.png'), sheet);
  fs.writeFileSync(path.join(OUT, 'sprites.json'), JSON.stringify(meta, null, 2) + '\n');

  // tray icons
  const t16 = new Bitmap(16, 16);
  t16.pattern(0, 0, TRAY16, TRAY_MAP);
  writePNG(path.join(OUT, 'tray.png'), t16);
  writePNG(path.join(OUT, 'tray@2x.png'), t16.scaled(2));

  // app icon
  const i32 = icon32();
  writePNG(path.join(OUT, 'icon.png'), i32.scaled(8));
  const ico = encodeICO([
    { size: 16, rgba: t16.px },
    { size: 32, rgba: i32.px },
    { size: 48, rgba: t16.scaled(3).px },
    { size: 64, rgba: i32.scaled(2).px },
    { size: 128, rgba: i32.scaled(4).px },
    { size: 256, rgba: i32.scaled(8).px },
  ]);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);

  // previews: on dark and light backgrounds, 5x
  const pv = (bg) => {
    const b = bg;
    b.blit(sheet, 0, 0);
    return b.scaled(5);
  };
  writePNG(path.join(OUT, 'preview', 'sheet-dark.png'), pv(checker(sheet.w, sheet.h)));
  writePNG(path.join(OUT, 'preview', 'sheet-light.png'), pv(checker(sheet.w, sheet.h, '#f2f2f7', '#dcdce6')));
  const ip = checker(64, 32, '#f2f2f7', '#dcdce6', 4);
  ip.blit(i32, 0, 0);
  ip.blit(t16, 40, 8);
  writePNG(path.join(OUT, 'preview', 'icons.png'), ip.scaled(8));

  console.log(`Sprite sheet: ${sheet.w}x${sheet.h}, ${ANIMS.length} animations`);
  for (const a of ANIMS) console.log(`  ${a.name.padEnd(11)} ${a.frames.length} frames @ ${a.fps}fps ${a.loop ? 'loop' : 'once'}  - ${a.note}`);
}

main();
