'use strict';
/*
 * Generates the pixel-art sprite sheets for Shadow's friends (same toolkit + style as the panther).
 *
 *   node scripts/generate-friends.js
 *
 * Outputs assets/friends/<id>.png + <id>.json (32x32 cells, one animation per row, facing right;
 * the renderer mirrors them for "left") and assets/preview/friends.png (big preview for humans).
 *
 * Every friend has the same animations: idle, move, work, talk, sleep, play.
 */

const fs = require('fs');
const path = require('path');
const { Bitmap, Mask, paint } = require('./lib/raster');
const { encodePNG } = require('./lib/png');

const CELL = 32;
const COLS = 8;
const OUT = path.join(__dirname, '..', 'assets', 'friends');
const OUTLINE = '#07050c';
const R = Math.round;

const pal = (base, rim, rim2, dark) => ({ base, rim, rim2, dark, seam: dark, outline: OUTLINE });

// little shared bits ----------------------------------------------------------
function zee(b, x, y, big) {
  const rows = big ? ['ZZZ', '..Z', '.Z.', 'Z..', 'ZZZ'] : ['ZZ', '.Z', 'ZZ'];
  b.stamp(R(x), R(y), rows, { Z: '#d2e3ff' }, '#1b2650');
}
function sparkle(b, x, y, color = '#fff3a0') {
  b.set(x, y, color);
  b.set(x - 1, y, color);
  b.set(x + 1, y, color);
  b.set(x, y - 1, color);
  b.set(x, y + 1, color);
}
function note(b, x, y) {
  b.stamp(R(x), R(y), ['.NN', '.N.', 'NN.'], { N: '#ffd21f' }, '#4a2c00');
}

// ============================================================================ ATLAS - parrot (researcher)
const PARROT = {
  body: pal('#2fa84f', '#7be38f', '#4cc768', '#1d6e33'),
  wing: pal('#1f8a45', '#56c46f', '#2fa84f', '#135a2b'),
  tail: pal('#2a7fd4', '#7cc0ff', '#4a9ae6', '#184f8a'),
  beak: pal('#ff5a36', '#ffb199', '#ff8566', '#b8321a'),
  ring: '#ff5c8a',
  ringDark: '#2b1030',
  eye: '#fff8e7',
  pupil: '#120a00',
  foot: '#8a8296',
};

function parrot(o = {}) {
  const b = new Bitmap(CELL, CELL);
  const dy = o.dy || 0;
  const fly = !!o.fly;
  const sleepy = o.eye === 'closed';
  if (fly) {
    // horizontal flight pose
    const tail = new Mask(CELL, CELL).spline([[11, 16 + dy], [6, 18 + dy], [2, 19 + dy]], 2.2, 0.8);
    paint(b, tail, PARROT.tail);
    const body = new Mask(CELL, CELL).capsule(11, 16 + dy, 19, 14 + dy, 4.2, 3.8);
    paint(b, body, PARROT.body);
    const head = new Mask(CELL, CELL).ellipse(22, 12 + dy, 3.8, 3.4);
    paint(b, head, PARROT.body, { cover: body });
    const beak = new Mask(CELL, CELL).poly([[24.5, 11 + dy], [28, 12.5 + dy], [25, 15 + dy]]);
    paint(b, beak, PARROT.beak, { cover: head });
    b.set(23, 11 + dy, PARROT.pupil);
    b.set(22, 10 + dy, PARROT.eye);
    b.line(19, 14 + dy, 20, 16 + dy, PARROT.ring);
    const up = o.wing === 'up';
    const mid = o.wing === 'mid';
    const wing = new Mask(CELL, CELL);
    if (up) wing.poly([[11, 14 + dy], [18, 13 + dy], [13, 3 + dy], [9, 5 + dy]]);
    else if (mid) wing.poly([[10, 15 + dy], [18, 14 + dy], [12, 9 + dy], [6, 10 + dy]]);
    else wing.poly([[11, 15 + dy], [18, 15 + dy], [13, 25 + dy], [9, 23 + dy]]);
    paint(b, wing, PARROT.wing, { cover: body });
    return b;
  }
  // standing, facing right
  const tail = new Mask(CELL, CELL).spline([[12, 22 + dy], [9, 26 + dy], [6.5, 30.5]], 2.3, 0.9);
  paint(b, tail, PARROT.tail);
  const air = Math.min(0, dy); // jumping: feet leave the ground with the body
  const feet = (x) => {
    b.line(x, 27 + dy, x, 29 + air, PARROT.foot);
    b.line(x - 1, 30 + air, x + 1, 30 + air, PARROT.foot);
  };
  feet(14);
  feet(17);
  const hy = (o.headDy || 0) + dy;
  const body = new Mask(CELL, CELL).capsule(14, 23 + dy, 17, 15 + dy, 5, 4.2);
  paint(b, body, PARROT.body);
  const head = new Mask(CELL, CELL).ellipse(19 + (o.headDx || 0), 11 + hy, 4.3, 4);
  paint(b, head, PARROT.body, { cover: body });
  const hx = 19 + (o.headDx || 0);
  // hooked beak (lower part opens when talking)
  const beak = new Mask(CELL, CELL).poly([[hx + 3, 9.5 + hy], [hx + 6.5, 11 + hy], [hx + 5, 14 + hy], [hx + 3, 13 + hy]]);
  paint(b, beak, PARROT.beak, { cover: head });
  if (o.beak === 'open') {
    b.set(hx + 4, 14 + hy, '#5c1030');
    b.set(hx + 5, 15 + hy, PARROT.beak.base);
    b.set(hx + 4, 15 + hy, OUTLINE);
  }
  // eye + neck ring
  if (sleepy) b.line(hx, 10 + hy, hx + 1, 10 + hy, PARROT.body.dark);
  else {
    b.pattern(hx, 9 + hy, ['EE', 'EK'], { E: PARROT.eye, K: PARROT.pupil });
  }
  b.line(hx - 3, 14 + hy, hx + 1, 15 + hy, PARROT.ringDark);
  b.line(hx - 3, 15 + hy, hx, 16 + hy, PARROT.ring);
  // wing on the side
  const w = o.wingUp || 0;
  const wing = new Mask(CELL, CELL).capsule(13, 22 + dy, 15, 16 + dy - w, 2.6, 3.4);
  paint(b, wing, PARROT.wing, { cover: body });
  b.set(12, 23 + dy, PARROT.tail.base);
  b.set(13, 24 + dy, PARROT.tail.rim2);
  if (o.glass) {
    // magnifying glass held in front of the face
    const [gx, gy] = o.glass;
    const lens = new Mask(CELL, CELL).ellipse(gx, gy, 3.2, 3.2);
    const hole = new Mask(CELL, CELL).ellipse(gx, gy, 2, 2);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) if (lens.get(x, y) && !hole.get(x, y)) b.set(x, y, '#c9a24a');
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) if (hole.get(x, y)) b.set(x, y, '#bfe8ff');
    b.set(gx - 1, gy - 1, '#ffffff');
    b.line(gx - 2, gy + 3, gx - 4, gy + 6, '#6b4a1e');
  }
  return b;
}

const ATLAS = {
  idle: [parrot(), parrot({ wingUp: 1 }), parrot(), parrot({ eye: 'closed' })],
  move: [parrot({ fly: true, wing: 'up' }), parrot({ fly: true, wing: 'mid', dy: 1 }), parrot({ fly: true, wing: 'down', dy: 2 }), parrot({ fly: true, wing: 'mid', dy: 1 })],
  work: [
    parrot({ glass: [26, 12], headDx: 1 }),
    (() => { const b = parrot({ glass: [26, 11], headDx: 1, headDy: -1 }); sparkle(b, 29, 6); return b; })(),
    parrot({ glass: [25, 13], headDx: 1 }),
    (() => { const b = parrot({ glass: [26, 12], headDx: 1, wingUp: 2 }); sparkle(b, 30, 9); return b; })(),
  ],
  talk: [parrot(), parrot({ beak: 'open' }), parrot({ wingUp: 1 }), parrot({ beak: 'open', wingUp: 1 })],
  sleep: [0, 1, 2, 3].map((f) => {
    const b = parrot({ eye: 'closed', headDy: 2, headDx: -1, dy: f % 2 ? 0 : 1 });
    zee(b, 25 + (f % 2), 4 - f, f > 1);
    return b;
  }),
  play: [parrot({ dy: 0, wingUp: 3 }), parrot({ dy: -3, wingUp: 5, beak: 'open' }), parrot({ dy: -4, wingUp: 3 }), parrot({ dy: -1, wingUp: 1 })],
};

// ============================================================================ DASH - rabbit (messenger)
const RABBIT = {
  body: pal('#e9e5f5', '#ffffff', '#f6f3ff', '#a9a1c2'),
  inner: '#ff9bbb',
  eye: '#1a1024',
  nose: '#ff6f91',
  tail: pal('#ffffff', '#ffffff', '#ffffff', '#cfc8e6'),
};

function rabbit(o = {}) {
  const b = new Bitmap(CELL, CELL);
  const dy = o.dy || 0;
  const stretch = o.stretch || 0; // hop pose: body longer, feet back
  const ear = o.ears || 'up'; // up | back | flat | perk
  const hx = 21 + stretch;
  const hy = 18 + dy + (o.headDy || 0);
  const tail = new Mask(CELL, CELL).ellipse(7 - stretch * 0.5, 22 + dy, 2.4, 2.2);
  paint(b, tail, RABBIT.tail);
  const body = new Mask(CELL, CELL);
  body.ellipse(13, 23 + dy, 6.5 + stretch * 0.6, 5.2);
  body.ellipse(17 + stretch * 0.6, 21 + dy, 4, 4);
  paint(b, body, RABBIT.body);
  // feet
  const feet = new Mask(CELL, CELL);
  const air = Math.min(0, dy); // in the air the feet come along
  feet.ellipse(13 - stretch * 1.5, 28.6 + air, 4.2, 1.5);
  feet.capsule(19 + stretch, 24 + dy, 19.5 + stretch * 1.8, 28.5 + air, 1.3, 1.2);
  paint(b, feet, RABBIT.body, { cover: body });
  // ears
  const ears = new Mask(CELL, CELL);
  if (ear === 'flat') {
    ears.capsule(hx - 1, hy - 2, hx - 9, hy - 1, 1.6, 1.2);
  } else if (ear === 'back') {
    ears.capsule(hx - 1, hy - 3, hx - 7, hy - 10, 1.7, 1.2);
    ears.capsule(hx + 1, hy - 3, hx - 4, hy - 11, 1.7, 1.2);
  } else {
    const tw = ear === 'perk' ? 1 : 0;
    ears.capsule(hx - 1, hy - 3, hx - 3, hy - 12 - tw, 1.7, 1.3);
    ears.capsule(hx + 1, hy - 3, hx + 1 + tw, hy - 12, 1.7, 1.3);
  }
  paint(b, ears, RABBIT.body);
  if (ear === 'up' || ear === 'perk') {
    b.line(hx + 1, hy - 5, hx + 1 + (ear === 'perk' ? 1 : 0), hy - 10, RABBIT.inner);
  }
  // head
  const head = new Mask(CELL, CELL).ellipse(hx, hy, 4.3, 3.8);
  head.ellipse(hx + 3, hy + 1.2, 2.2, 1.9);
  paint(b, head, RABBIT.body, { cover: body });
  if (o.eye === 'closed') b.line(hx, hy - 1, hx + 1, hy - 1, RABBIT.body.dark);
  else b.pattern(hx, hy - 2, ['KW', 'KK'], { K: RABBIT.eye, W: '#ffffff' });
  b.set(hx + 5, hy + 1, RABBIT.nose);
  if (o.mouth === 'open') b.pattern(hx + 3, hy + 3, ['RR'], { R: '#c2305a' });
  else b.set(hx + 4, hy + 3, RABBIT.body.dark);
  b.set(hx + 2, hy + 1, '#ffd0de'); // cheek
  if (o.letter) {
    const [lx, ly] = o.letter;
    b.stamp(R(lx), R(ly), ['WWWWWW', 'WFWWFW', 'WWFFWW', 'WWWHWW', 'WWWWWW'], { W: '#fffaf0', F: '#d8d0e8', H: '#ff3d6e' }, OUTLINE);
  }
  return b;
}

const DASH = {
  idle: [rabbit(), rabbit({ ears: 'perk' }), rabbit(), rabbit({ eye: 'closed' })],
  move: [rabbit({ dy: 1 }), rabbit({ dy: -2, stretch: 2, ears: 'back' }), rabbit({ dy: -4, stretch: 2, ears: 'back' }), rabbit({ dy: -2, stretch: 1, ears: 'back' }), rabbit({ dy: 1, ears: 'perk' }), rabbit()],
  work: [
    rabbit({ letter: [22, 22], ears: 'perk' }),
    rabbit({ letter: [22, 21], ears: 'up', dy: -1 }),
    (() => { const b = rabbit({ letter: [22, 22], ears: 'perk' }); sparkle(b, 30, 18, '#ff9bbb'); return b; })(),
    rabbit({ letter: [22, 21], ears: 'up', dy: -1 }),
  ],
  talk: [rabbit(), rabbit({ mouth: 'open', ears: 'perk' }), rabbit(), rabbit({ mouth: 'open' })],
  sleep: [0, 1, 2, 3].map((f) => {
    const b = rabbit({ ears: 'flat', eye: 'closed', dy: f % 2 ? 1 : 0, headDy: 2 });
    zee(b, 25 + (f % 2), 6 - f, f > 1);
    return b;
  }),
  play: [rabbit({ dy: 0 }), rabbit({ dy: -5, stretch: 1, ears: 'back', mouth: 'open' }), rabbit({ dy: -7, ears: 'perk' }), rabbit({ dy: -2, ears: 'back' })],
};

// ============================================================================ BOLT - monkey (launcher)
const MONKEY = {
  body: pal('#8a5a33', '#c48a55', '#a8723f', '#5a3a1f'),
  face: pal('#f2c99a', '#ffe6c7', '#f7d8b3', '#c99a66'),
  eye: '#1a0d05',
  bolt: '#ffd21f',
  boltOut: '#4a2c00',
};

function monkey(o = {}) {
  const b = new Bitmap(CELL, CELL);
  const dy = o.dy || 0;
  const step = o.step || 0; // walk phase -1..1
  const hy = 11 + dy + (o.headDy || 0);
  const hx = 17;
  // tail curl
  const tail = new Mask(CELL, CELL).spline([[10, 24 + dy], [5, 24 + dy], [3, 19 + dy], [5, 15 + dy], [8, 16 + dy + (o.tailFlick || 0)]], 1.4, 1);
  paint(b, tail, MONKEY.body);
  // legs
  const legs = new Mask(CELL, CELL);
  const air = Math.min(0, dy);
  legs.capsule(12, 25 + dy, 11 - step * 2, 29.5 + air, 1.7, 1.5);
  legs.capsule(16, 25 + dy, 17 + step * 2, 29.5 + air, 1.7, 1.5);
  paint(b, legs, MONKEY.body);
  // body + belly
  const body = new Mask(CELL, CELL).ellipse(14, 21 + dy, 5, 6);
  paint(b, body, MONKEY.body, { cover: legs });
  const belly = new Mask(CELL, CELL).ellipse(16, 22 + dy, 2.6, 3.8);
  paint(b, belly, MONKEY.face, { outline: false, rim: false });
  // arms
  const arms = new Mask(CELL, CELL);
  const hand = o.hand || [20 + step, 23 + dy];
  arms.capsule(16, 17 + dy, hand[0], hand[1], 1.6, 1.4);
  if (o.hand2) arms.capsule(12, 17 + dy, o.hand2[0], o.hand2[1], 1.6, 1.4);
  paint(b, arms, MONKEY.body, { cover: body });
  // head: ear, head, face mask
  const ear = new Mask(CELL, CELL).ellipse(hx - 4.6, hy, 2.2, 2.2);
  paint(b, ear, MONKEY.body);
  b.set(hx - 5, hy, MONKEY.face.dark);
  const head = new Mask(CELL, CELL).ellipse(hx, hy, 5, 4.6);
  paint(b, head, MONKEY.body, { cover: body });
  const face = new Mask(CELL, CELL);
  face.ellipse(hx + 2, hy - 0.6, 1.8, 1.8);
  face.ellipse(hx + 4.2, hy - 0.6, 1.6, 1.8);
  face.ellipse(hx + 3.2, hy + 2, 2.8, 2);
  paint(b, face, MONKEY.face, { outline: false, rim: false });
  if (o.eye === 'closed') {
    b.line(hx + 2, hy - 1, hx + 3, hy - 1, MONKEY.eye);
    b.set(hx + 5, hy - 1, MONKEY.eye);
  } else {
    b.set(hx + 2, hy - 1, MONKEY.eye);
    b.set(hx + 5, hy - 1, MONKEY.eye);
    b.set(hx + 2, hy - 2, '#ffffff');
  }
  if (o.mouth === 'open') b.pattern(hx + 3, hy + 2, ['RRR', '.R.'], { R: '#7a1f2a' });
  else if (o.mouth === 'grin') b.line(hx + 2, hy + 2, hx + 5, hy + 3, '#7a1f2a');
  else b.line(hx + 3, hy + 2, hx + 4, hy + 2, MONKEY.face.dark);
  if (o.bolt) {
    const [bx, by] = o.bolt;
    b.stamp(R(bx), R(by), ['..YY', '.YY.', 'YYYY', '.YY.', 'YY..'], { Y: MONKEY.bolt }, MONKEY.boltOut);
  }
  return b;
}

const BOLT = {
  idle: [monkey(), monkey({ tailFlick: -1 }), monkey({ headDy: 1 }), monkey({ eye: 'closed' })],
  move: [
    monkey({ step: 1, dy: 0 }),
    monkey({ step: 0.4, dy: -1, hand: [21, 22] }),
    monkey({ step: -1, dy: 0 }),
    monkey({ step: -0.4, dy: -1, hand: [19, 22] }),
  ],
  work: [
    monkey({ hand: [21, 8], bolt: [20, 2], mouth: 'grin' }),
    (() => { const b = monkey({ hand: [22, 9], bolt: [21, 3], mouth: 'open' }); sparkle(b, 27, 4); return b; })(),
    monkey({ hand: [23, 18], bolt: [23, 13], mouth: 'grin', dy: 1 }),
    (() => { const b = monkey({ hand: [24, 22], bolt: [24, 18], mouth: 'open', dy: 1 }); sparkle(b, 29, 18); sparkle(b, 27, 14, '#ffffff'); return b; })(),
  ],
  talk: [monkey(), monkey({ mouth: 'open' }), monkey({ hand: [21, 18] }), monkey({ mouth: 'open', hand: [21, 18] })],
  sleep: [0, 1, 2, 3].map((f) => {
    const b = monkey({ eye: 'closed', headDy: 3, hand: [18, 22], dy: f % 2 ? 1 : 0 });
    zee(b, 24 + (f % 2), 3 - (f % 2), f > 1);
    return b;
  }),
  play: [
    monkey({ hand: [21, 9], hand2: [10, 9], mouth: 'open', dy: 0 }),
    monkey({ hand: [22, 8], hand2: [9, 8], mouth: 'open', dy: -4, tailFlick: -2 }),
    monkey({ hand: [21, 10], hand2: [10, 10], mouth: 'grin', dy: -2 }),
    monkey({ hand: [20, 14], hand2: [11, 14], mouth: 'grin', dy: 0 }),
  ],
};

// ============================================================================ SAGE - owl (tutor)
const OWL = {
  body: pal('#7a5634', '#c9965f', '#a07445', '#4a321c'),
  wing: pal('#5e4127', '#a07445', '#7a5634', '#3a2715'),
  belly: '#e8d3a8',
  speck: '#b08a5c',
  iris: '#ffd21f',
  pupil: '#120a00',
  beak: '#ff9a0d',
  foot: '#ff9a0d',
};

function owl(o = {}) {
  const b = new Bitmap(CELL, CELL);
  const dy = o.dy || 0;
  const hy = 11 + dy + (o.headDy || 0);
  const air = Math.min(0, dy);
  // feet
  if (!o.fly) {
    b.line(14, 29 + air, 15, 29 + air, OWL.foot);
    b.line(18, 29 + air, 19, 29 + air, OWL.foot);
  }
  // wings (behind / spread)
  const wing = new Mask(CELL, CELL);
  if (o.fly === 'up') {
    wing.poly([[11, 17 + dy], [3, 6 + dy], [8, 16 + dy]]);
    wing.poly([[22, 17 + dy], [30, 6 + dy], [25, 16 + dy]]);
  } else if (o.fly === 'down') {
    wing.poly([[11, 17 + dy], [2, 25 + dy], [9, 22 + dy]]);
    wing.poly([[22, 17 + dy], [31, 25 + dy], [24, 22 + dy]]);
  } else {
    const w = o.wingUp || 0;
    wing.ellipse(10.5, 20 + dy - w, 2.6, 5);
    wing.ellipse(22.5, 20 + dy - w, 2.6, 5);
  }
  paint(b, wing, OWL.wing);
  // body + head (one egg shape) with ear tufts
  const body = new Mask(CELL, CELL);
  body.ellipse(16.5, 20 + dy, 6.2, 7.5);
  body.ellipse(16.5, hy, 6.3, 5.2);
  body.poly([[11, hy - 2], [11.5, hy - 7], [14, hy - 4]]);
  body.poly([[22, hy - 2], [21.5, hy - 7], [19, hy - 4]]);
  paint(b, body, OWL.body, { cover: wing });
  const belly = new Mask(CELL, CELL).ellipse(16.5, 22 + dy, 3.8, 5);
  paint(b, belly, pal(OWL.belly, '#fff3d6', OWL.belly, '#c9ad7c'), { outline: false, rim: false });
  [[15, 20], [18, 21], [16, 24], [19, 25], [14, 23]].forEach(([x, y]) => b.set(x, y + dy, OWL.speck));
  // eyes: big round discs
  const eye = (cx) => {
    if (o.eye === 'closed') return b.line(cx - 1, hy, cx + 1, hy, OWL.body.dark);
    b.pattern(cx - 1, hy - 1, ['YYY', 'YKY', 'YYY'], { Y: OWL.iris, K: OWL.pupil });
    b.set(cx - 1, hy - 1, '#ffffff');
  };
  eye(14);
  eye(19);
  if (o.glasses) {
    ['#e6e6f0'].forEach((c) => {
      b.pattern(12, hy - 2, ['GGGGG.GGGGG', 'G...G.G...G', 'G...GGG...G', 'G...G.G...G', 'GGGGG.GGGGG'], { G: c });
    });
    eye(14);
    eye(19);
  }
  // beak
  if (o.beak === 'open') b.pattern(16, hy + 2, ['BB', 'RR', 'BB'], { B: OWL.beak, R: '#5c1030' });
  else b.pattern(16, hy + 2, ['BB', '.B'], { B: OWL.beak });
  if (o.book) {
    const [bx, by] = o.book;
    b.stamp(R(bx), R(by + dy), ['RRRRRRRR', 'RWWWRWWWR'.slice(0, 8), 'RWWWWWWR', 'RWLWWLWR', 'RWWWWWWR', 'RRRRRRRR'], { R: '#b8321a', W: '#fffaf0', L: '#8a8296' }, OUTLINE);
  }
  return b;
}

const SAGE = {
  idle: [owl(), owl({ headDy: 0, wingUp: 1 }), owl(), owl({ eye: 'closed' })],
  move: [owl({ fly: 'up', dy: -2 }), owl({ fly: 'down', dy: -1 }), owl({ fly: 'up', dy: -2 }), owl({ fly: 'down', dy: -1 })],
  work: [
    owl({ glasses: true, book: [12, 23] }),
    owl({ glasses: true, book: [12, 23], beak: 'open' }),
    (() => { const b = owl({ glasses: true, book: [12, 22], headDy: -1 }); sparkle(b, 27, 5); return b; })(),
    owl({ glasses: true, book: [12, 23], beak: 'open' }),
  ],
  talk: [owl({ glasses: true }), owl({ glasses: true, beak: 'open' }), owl({ glasses: true, wingUp: 1 }), owl({ glasses: true, beak: 'open' })],
  sleep: [0, 1, 2, 3].map((f) => {
    const b = owl({ eye: 'closed', headDy: 1, dy: f % 2 ? 1 : 0 });
    zee(b, 24 + (f % 2), 3 - (f % 2), f > 1);
    return b;
  }),
  play: [owl({ wingUp: 2 }), owl({ fly: 'up', dy: -4, beak: 'open' }), owl({ fly: 'down', dy: -3 }), owl({ wingUp: 1, dy: -1 })],
};

// ============================================================================ ZEN - turtle (PC caretaker)
const TURTLE = {
  shell: pal('#3e8f5a', '#7fd39a', '#5bb377', '#265c39'),
  plate: '#2c6b42',
  skin: pal('#9fcf6e', '#d4f2a8', '#b8e08a', '#6a9a45'),
  eye: '#120a00',
};

function turtle(o = {}) {
  const b = new Bitmap(CELL, CELL);
  const dy = o.dy || 0;
  const step = o.step || 0;
  const air = Math.min(0, dy);
  const hide = !!o.hide; // head pulled in
  // legs (far pair, then near pair)
  const legs = new Mask(CELL, CELL);
  legs.ellipse(9 + step, 27 + air, 2, 2.2);
  legs.ellipse(21 - step, 27 + air, 2, 2.2);
  legs.ellipse(7, 24 + dy, 1.4, 1);
  paint(b, legs, TURTLE.skin);
  // head + neck
  const head = new Mask(CELL, CELL);
  const hx = hide ? 23 : 26;
  const hy = (hide ? 23 : 20) + dy + (o.headDy || 0);
  head.capsule(21, 23 + dy, hx, hy, 2.2, 2.4);
  head.ellipse(hx, hy, 3, 2.6);
  paint(b, head, TURTLE.skin);
  // shell dome
  const shell = new Mask(CELL, CELL).ellipse(15, 22 + dy, 8.5, 7);
  shell.rect(5, 25 + dy, 22, 8, 0);
  paint(b, shell, TURTLE.shell, { cover: head });
  b.line(7, 24 + dy, 23, 24 + dy, TURTLE.plate);
  // plates
  b.pattern(10, 18 + dy, ['..P...P..', '.P.P.P.P.', 'P...P...P'], { P: TURTLE.plate });
  b.pattern(12, 15 + dy, ['PPP'], { P: '#2c6b42' });
  // face
  if (o.eye === 'closed') b.line(hx, hy - 1, hx + 1, hy - 1, TURTLE.skin.dark);
  else b.pattern(hx, hy - 1, ['K'], { K: TURTLE.eye });
  if (o.mouth === 'open') b.pattern(hx + 1, hy + 1, ['RR'], { R: '#7a1f2a' });
  else b.set(hx + 2, hy + 1, TURTLE.skin.dark);
  if (o.wrench) {
    const [wx, wy] = o.wrench;
    b.stamp(R(wx), R(wy + dy), ['G.G', 'GGG', '.G.', '.G.', '.G.'], { G: '#c8cad6' }, OUTLINE);
  }
  if (o.heart) sparkle(b, o.heart[0], o.heart[1] + dy, '#7dffa8');
  return b;
}

const ZEN = {
  idle: [turtle(), turtle({ headDy: -1 }), turtle(), turtle({ eye: 'closed' })],
  move: [turtle({ step: 1 }), turtle({ step: 0.5, dy: -1 }), turtle({ step: -1 }), turtle({ step: -0.5, dy: -1 })],
  work: [
    turtle({ wrench: [27, 12] }),
    (() => { const b = turtle({ wrench: [27, 11], mouth: 'open' }); sparkle(b, 30, 9, '#7dffa8'); return b; })(),
    turtle({ wrench: [27, 12], headDy: -1 }),
    turtle({ wrench: [27, 11], heart: [30, 13] }),
  ],
  talk: [turtle(), turtle({ mouth: 'open' }), turtle({ headDy: -1 }), turtle({ mouth: 'open', headDy: -1 })],
  sleep: [0, 1, 2, 3].map((f) => {
    const b = turtle({ hide: true, eye: 'closed', dy: f % 2 ? 1 : 0 });
    zee(b, 24 + (f % 2), 8 - (f % 2), f > 1);
    return b;
  }),
  play: [turtle({ dy: 0 }), turtle({ dy: -3, mouth: 'open' }), turtle({ dy: -4, headDy: -1 }), turtle({ dy: -1 })],
};

// ============================================================================ TEMPO - penguin (music DJ)
const PENGUIN = {
  body: pal('#1b1f33', '#4a5578', '#2e3550', '#0e1020'),
  belly: pal('#f4f4ff', '#ffffff', '#ffffff', '#c9cbe0'),
  beak: '#ffb020',
  foot: '#ff9a0d',
  phones: '#ff3d6e',
  band: '#ffd21f',
};

function penguin(o = {}) {
  const b = new Bitmap(CELL, CELL);
  const dy = o.dy || 0;
  const dx = o.dx || 0;
  const air = Math.min(0, dy);
  const step = o.step || 0;
  b.line(13 + dx - step, 30 + air, 15 + dx - step, 30 + air, PENGUIN.foot);
  b.line(18 + dx + step, 30 + air, 20 + dx + step, 30 + air, PENGUIN.foot);
  const body = new Mask(CELL, CELL).ellipse(16.5 + dx, 20 + dy, 6.2, 9.2);
  paint(b, body, PENGUIN.body);
  const belly = new Mask(CELL, CELL).ellipse(17.5 + dx, 22 + dy, 4, 6.5);
  belly.ellipse(17.5 + dx, 13 + dy, 3.4, 2.6);
  paint(b, belly, PENGUIN.belly, { outline: false });
  // flippers
  const fl = new Mask(CELL, CELL);
  const [l, r] = o.flippers || [[9 + dx, 23 + dy], [24 + dx, 23 + dy]];
  fl.capsule(11 + dx, 16 + dy, l[0], l[1], 1.7, 1.2);
  fl.capsule(22 + dx, 16 + dy, r[0], r[1], 1.7, 1.2);
  paint(b, fl, PENGUIN.body, { cover: body });
  // face
  const ey = 11 + dy;
  if (o.eye === 'closed') {
    b.line(15 + dx, ey, 16 + dx, ey, PENGUIN.body.dark);
    b.line(19 + dx, ey, 20 + dx, ey, PENGUIN.body.dark);
  } else {
    b.pattern(15 + dx, ey - 1, ['WK', 'KK'], { W: '#ffffff', K: '#05050a' });
    b.pattern(19 + dx, ey - 1, ['WK', 'KK'], { W: '#ffffff', K: '#05050a' });
  }
  if (o.beak === 'open') b.pattern(17 + dx, ey + 2, ['BB', 'RR', 'BB'], { B: PENGUIN.beak, R: '#5c1030' });
  else b.pattern(17 + dx, ey + 2, ['BB', '.B'], { B: PENGUIN.beak });
  // headphones: band over the head + ear cups
  b.line(11 + dx, 9 + dy, 13 + dx, 5 + dy, PENGUIN.band);
  b.line(13 + dx, 5 + dy, 20 + dx, 5 + dy, PENGUIN.band);
  b.line(20 + dx, 5 + dy, 22 + dx, 9 + dy, PENGUIN.band);
  b.stamp(10 + dx, 9 + dy, ['PP', 'PP', 'PP'], { P: PENGUIN.phones }, OUTLINE);
  b.stamp(22 + dx, 9 + dy, ['PP', 'PP', 'PP'], { P: PENGUIN.phones }, OUTLINE);
  if (o.note) note(b, o.note[0], o.note[1]);
  if (o.deck) {
    b.stamp(R(o.deck[0]), R(o.deck[1]), ['DDDDDDD', 'DkkDkkD', 'DDDDDDD'], { D: '#3a3550', k: '#8f7df2' }, OUTLINE);
  }
  return b;
}

const TEMPO = {
  idle: [penguin(), penguin({ dy: 0, flippers: [[9, 22], [24, 22]] }), penguin(), penguin({ eye: 'closed' })],
  move: [penguin({ dx: -1, step: 1 }), penguin({ dx: 0, dy: -1 }), penguin({ dx: 1, step: -1 }), penguin({ dx: 0, dy: -1 })],
  work: [
    penguin({ flippers: [[9, 23], [25, 25]], deck: [21, 26], note: [26, 3] }),
    penguin({ flippers: [[9, 23], [27, 25]], deck: [21, 26], dy: -1, beak: 'open' }),
    penguin({ flippers: [[9, 23], [25, 25]], deck: [21, 26], note: [27, 1] }),
    penguin({ flippers: [[7, 15], [27, 25]], deck: [21, 26], dy: -1, note: [3, 4] }),
  ],
  talk: [penguin(), penguin({ beak: 'open' }), penguin({ flippers: [[8, 18], [24, 23]] }), penguin({ beak: 'open', flippers: [[8, 18], [24, 23]] })],
  sleep: [0, 1, 2, 3].map((f) => {
    const b = penguin({ eye: 'closed', dy: f % 2 ? 1 : 0 });
    zee(b, 25 + (f % 2), 1, f > 1);
    return b;
  }),
  play: [
    penguin({ dx: -2, flippers: [[6, 12], [25, 20]], note: [26, 3] }),
    penguin({ dx: 0, dy: -3, flippers: [[8, 9], [25, 9]], beak: 'open' }),
    penguin({ dx: 2, flippers: [[9, 20], [28, 12]], note: [3, 3] }),
    penguin({ dx: 0, dy: -1, flippers: [[7, 14], [26, 14]] }),
  ],
};

// ============================================================================ sheets
const FRIENDS = {
  atlas: { anims: ATLAS, fps: { idle: 4, move: 10, work: 6, talk: 8, sleep: 3, play: 7 } },
  dash: { anims: DASH, fps: { idle: 4, move: 10, work: 5, talk: 8, sleep: 3, play: 7 } },
  bolt: { anims: BOLT, fps: { idle: 4, move: 8, work: 6, talk: 8, sleep: 3, play: 7 } },
  sage: { anims: SAGE, fps: { idle: 3, move: 9, work: 4, talk: 8, sleep: 3, play: 7 } },
  zen: { anims: ZEN, fps: { idle: 3, move: 5, work: 5, talk: 6, sleep: 2, play: 6 } },
  tempo: { anims: TEMPO, fps: { idle: 4, move: 8, work: 8, talk: 8, sleep: 3, play: 8 } },
};
const ORDER = ['idle', 'move', 'work', 'talk', 'sleep', 'play'];

function build(id) {
  const f = FRIENDS[id];
  const sheet = new Bitmap(COLS * CELL, ORDER.length * CELL);
  const meta = { frameWidth: CELL, frameHeight: CELL, columns: COLS, animations: {} };
  ORDER.forEach((name, row) => {
    const frames = f.anims[name];
    if (!frames || frames.length < 4 || frames.length > COLS) throw new Error(`${id}.${name}: needs 4-${COLS} frames`);
    frames.forEach((bmp, col) => sheet.blit(bmp, col * CELL, row * CELL));
    meta.animations[name] = { row, frames: frames.length, fps: f.fps[name], loop: true, flip: true };
  });
  return { sheet, meta };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const built = {};
  for (const id of Object.keys(FRIENDS)) {
    const { sheet, meta } = build(id);
    built[id] = { sheet, meta };
    fs.writeFileSync(path.join(OUT, `${id}.png`), encodePNG(sheet.w, sheet.h, sheet.px));
    fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(meta, null, 2) + '\n');
  }
  // preview: every friend's frames on a dark checker, 6x
  const ids = Object.keys(built);
  const rows = ids.length * ORDER.length;
  const prev = new Bitmap(COLS * CELL, rows * CELL);
  for (let y = 0; y < prev.h; y++) for (let x = 0; x < prev.w; x++) prev.set(x, y, ((x >> 3) + (y >> 3)) % 2 ? '#2e2e38' : '#3b3b48');
  ids.forEach((id, i) => prev.blit(built[id].sheet, 0, i * ORDER.length * CELL));
  const dir = path.join(__dirname, '..', 'assets', 'preview');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'friends.png'), (() => { const big = prev.scaled(4); return encodePNG(big.w, big.h, big.px); })());
  console.log(`friends: ${ids.join(', ')} -> assets/friends/`);
}

if (require.main === module) main();
module.exports = { build, FRIENDS, ORDER, CELL };
