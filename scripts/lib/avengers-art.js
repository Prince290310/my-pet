'use strict';
// Actual humanoid comic-book heroes, drawn on the same pixel grid as the existing app.
const { Bitmap, Mask, paint } = require('./raster');
const OUTLINE = '#101421';
const pal = (base, light, dark) => ({ base, rim: light, rim2: base, dark, outline: OUTLINE });
const P = {
  red: pal('#c53236', '#ff7770', '#752331'), gold: pal('#e4ac48', '#ffe39a', '#a96a31'),
  blue: pal('#2764ad', '#66a8ec', '#183863'), silver: pal('#9cb4c9', '#e5f5ff', '#536a85'),
  cyan: pal('#48a5d5', '#bceaff', '#27617e'),
  skin: pal('#e4ad85', '#ffe0ba', '#aa715a'), green: pal('#65b64a', '#a4e76c', '#357241'),
  purple: pal('#7353a7', '#be96ed', '#43316b'), black: pal('#28313e', '#596676', '#151c29'),
  auburn: pal('#a9442e', '#ed8a51', '#632733'), brownSkin: pal('#885f49', '#c5916d', '#51382d'),
};

function hero(id, animation = 'idle', frame = 0, size = 32) {
  if (id === 'ironman' && /^(fly|move|walk_left|walk_right|arrive)$/.test(animation)) return ironManFlight(frame, size);
  const b = new Bitmap(32, 32);
  const phase = Math.sin(frame * Math.PI / 2);
  const moving = /move|walk|arrive/.test(animation);
  const flying = animation === 'pounce' || (moving && ['ironman', 'spiderman', 'strange', 'thor', 'hulk', 'vision', 'falcon', 'warmachine'].includes(id));
  const landing = animation === 'land' || (animation === 'pounce' && frame >= 6);
  const action = moving || animation === 'pounce';
  const resting = animation === 'sleep' || animation === 'sit';
  const raised = /work|play|happy|stretch|alert/.test(animation);
  const dy = landing ? 2 - Math.min(2, frame % 4) : flying ? (id === 'hulk' ? -Math.abs(phase) * 4 : id === 'spiderman' ? -4 + phase * 2 : -3 + (frame % 2)) : resting ? 3 : frame % 4 === 1 ? -1 : 0;
  const shape = (mask, palette) => paint(b, mask, palette);
  const ellipse = (x, y, rx, ry, palette) => shape(new Mask(32, 32).ellipse(x, y + dy, rx, ry), palette);
  const poly = (points, palette) => shape(new Mask(32, 32).poly(points.map(([x, y]) => [x, y + dy])), palette);
  const line = (x, y, xx, yy, color) => b.line(x, y + dy, xx, yy + dy, color);
  const dot = (x, y, color) => b.set(x, y + dy, color);
  const limb = (x, y, xx, yy, width, palette) => shape(new Mask(32, 32).capsule(x, y + dy, xx, yy + dy, width), palette);
  const torso = id === 'vision' ? P.green : ['widow', 'panther', 'warmachine'].includes(id) ? P.black : id === 'hawkeye' ? P.purple : id === 'falcon' ? P.silver : id === 'quicksilver' ? P.cyan : id === 'hulk' ? P.green : id === 'cap' || id === 'strange' ? P.blue : id === 'thor' ? P.black : P.red;
  const leg = id === 'hulk' ? P.purple : id === 'spiderman' ? P.blue : id === 'quicksilver' ? P.black : torso;
  const spread = id === 'hulk' ? 2 : 0;
  const footY = resting ? 29 - dy : 29;
  const stride = moving ? phase * (id === 'quicksilver' ? 4 : id === 'hulk' ? 3 : 2) : 0;
  if (id === 'thor' || id === 'strange' || id === 'wanda' || id === 'vision') poly([[9, 14], [23, 14], [27 + phase, 28], [6, 28]], id === 'vision' ? P.gold : P.red);
  if (id === 'wanda' || id === 'widow') {
    poly([[8, 5], [23, 5], [25, 11], [24, 20], [20, 18], [12, 18], [7, 20], [6, 12]], P.auburn);
  }
  if (id === 'falcon') {
    const tip = flying || raised ? 8 + phase * 2 : 18;
    poly([[10, 17], [1, tip], [0, tip + 7], [9, 23]], P.silver);
    poly([[22, 17], [30, tip], [31, tip + 7], [23, 23]], P.silver);
    for (const x of [3, 6, 25, 28]) line(x, tip + 3, x, tip + 7, '#c53236');
  }
  if (id === 'hawkeye') {
    line(8, 14, 19, 6, '#b4c0d1');
    for (const x of [16, 19, 22]) { line(x, 7, x - 4, 15, '#d6c49d'); dot(x, 6, '#ce9eea'); }
  }
  if (id === 'warmachine') {
    poly([[21, 12], [30, 12], [30, 15], [21, 15]], P.black);
    line(24, 12, 29, 12, '#a2b5c8');
  }
  if (id === 'strange' && /arrive|move|walk|land/.test(animation)) {
    for (let a = 0; a < Math.PI * 2; a += 0.16) b.set(16 + Math.cos(a) * 13, 16 + Math.sin(a) * 14, frame % 2 ? '#ffb653' : '#ff8142');
  }
  if (id === 'quicksilver' && action) {
    for (let y = 9; y < 30; y += 4) {
      b.line(frame % 3, y, 9, y, '#6bd7ef');
      b.line(3 + frame % 2, y + 1, 7, y + 1, '#d2f6ff');
    }
  }
  limb(12, 23, 12 - stride, footY, 2.2, leg);
  limb(20, 23, 20 + stride, footY, 2.2, leg);
  const boot = id === 'hulk' ? P.green : ['strange', 'widow', 'panther', 'hawkeye', 'antman', 'warmachine'].includes(id) ? P.black : id === 'vision' ? P.gold : P.red;
  ellipse(11 - stride, footY, 3, 1.3, boot);
  ellipse(21 + stride, footY, 3, 1.3, boot);
  poly([[10 - spread, 16], [22 + spread, 16], [23, 21], [20, 25], [12, 25], [9, 21]], torso);
  const arm = id === 'hulk' ? P.green : id === 'thor' ? P.skin : torso;
  const leftY = landing && id === 'hulk' ? 28 : animation === 'stretch' ? 8 : raised ? 16 + phase * 2 : 24 + (moving ? stride : 0);
  const rightY = landing && ['hulk','thor'].includes(id) ? 28 : id === 'spiderman' && action ? 5 : animation === 'groom' ? 19 : animation === 'talk' ? 20 + phase : raised ? 12 + phase : 24 - (moving ? stride : 0);
  limb(9 - spread, 17, 6 - spread, leftY, id === 'hulk' ? 2.8 : 2, arm);
  limb(23 + spread, 17, 26 + spread, rightY, id === 'hulk' ? 2.8 : 2, arm);
  ellipse(6 - spread, leftY, 2, 2, id === 'ironman' ? P.gold : arm);
  ellipse(26 + spread, rightY, 2, 2, id === 'ironman' ? P.gold : arm);
  const headPal = id === 'vision' ? P.red : id === 'panther' || id === 'warmachine' ? P.black : id === 'antman' ? P.silver : id === 'falcon' ? P.brownSkin : id === 'ironman' || id === 'spiderman' ? P.red : id === 'cap' ? P.blue : id === 'hulk' ? P.green : P.skin;
  poly([[10, 4], [21, 4], [24, 7], [24, 12], [21, 15], [10, 15], [7, 12], [7, 7]], headPal);
  const closed = animation === 'sleep';
  if (id === 'ironman') {
    poly([[10, 6], [14, 6], [14, 7], [18, 7], [18, 6], [21, 6], [22, 9], [21, 12], [19, 14], [12, 14], [10, 12], [9, 9]], P.gold);
    line(10, 9, 14, 10, closed ? '#735835' : '#b8f9ff');
    line(18, 10, 22, 9, closed ? '#735835' : '#b8f9ff');
    line(13, 13, 19, 13, '#654135');
    ellipse(16, 20, 2.3, 2.3, pal('#49ddec', '#e7ffff', '#148aaf'));
    dot(16, 20, '#ffffff');
    line(11, 24, 21, 24, '#f1bd58');
    if (raised || flying) {
      ellipse(26, rightY, 1.2 + (frame % 2) * 0.4, 1.2, P.silver);
      dot(26, rightY, '#c5ffff');
    }
    if (flying || moving) for (const x of [11 - stride, 21 + stride]) {
      line(x, footY + 1, x, 31 - dy, '#7feaff');
      line(x - 1, footY + 1, x - 1, 30 - dy, '#258ec4');
      dot(x, footY + 1, '#f4ffff');
    }
  } else if (id === 'spiderman') {
    poly([[9, 8], [14, 10], [12, 12], [9, 11]], P.black);
    poly([[17, 10], [22, 8], [22, 11], [19, 12]], P.black);
    line(10, 9, 12, 10, closed ? '#a34545' : '#ffffff');
    line(19, 10, 21, 9, closed ? '#a34545' : '#ffffff');
    for (const y of [6, 13]) line(10, y, 21, y, '#7a2630');
    line(16, 5, 16, 14, '#7a2630');
    line(16, 18, 16, 23, '#171e32');
    for (const y of [19, 21]) { line(12, y - 1, 20, y + 1, '#171e32'); line(12, y + 1, 20, y - 1, '#171e32'); }
    if (raised || flying) { line(27, rightY - 2, 29 - frame % 3, -dy, '#deefff'); line(26, rightY - 2, 28 - frame % 3, -dy, '#859bac'); }
  } else if (id === 'cap') {
    poly([[9, 11], [23, 11], [21, 14], [11, 14]], P.skin);
    b.pattern(14, 5 + dy, ['.W.', 'W.W', 'WWW', 'W.W'], { W: '#f4f6e9' });
    line(10, 10, 12, 10, closed ? '#39618a' : '#f0f6ff'); line(19, 10, 21, 10, closed ? '#39618a' : '#f0f6ff');
    b.stamp(13, 17 + dy, ['..W..', 'WWWWW', '.WWW.', '.W.W.'], { W: '#ffffff' });
    for (let x = 11; x <= 21; x += 2) line(x, 22, x, 24, '#faf4ec');
    const shieldX = moving ? 24 + phase : 25, shieldY = moving ? 19 : 22;
    ellipse(shieldX, shieldY, 5.5, 5.5, P.red); ellipse(shieldX, shieldY, 4, 4, P.silver); ellipse(shieldX, shieldY, 3, 3, P.red); ellipse(shieldX, shieldY, 2, 2, P.blue);
    b.pattern(Math.round(shieldX) - 1, shieldY - 2 + dy, ['.W.', 'WWW', '.W.'], { W: '#ffffff' });
  } else if (['vision', 'panther', 'antman', 'warmachine'].includes(id)) {
    const eye = closed ? '#596676' : id === 'antman' || id === 'warmachine' ? '#ff605d' : '#e5faff';
    line(10, 9, 13, 10, eye); line(18, 10, 21, 9, eye);
    if (id === 'vision') {
      poly([[16, 5], [18, 7], [16, 9], [14, 7]], P.gold);
      line(11, 13, 20, 13, '#682332');
      poly([[16, 17], [20, 21], [16, 24], [12, 21]], P.gold);
      line(11, 24, 21, 24, '#e2b74d');
    } else if (id === 'panther') {
      poly([[8, 7], [9, 2], [13, 5]], P.black); poly([[19, 5], [23, 2], [24, 7]], P.black);
      line(11, 5, 14, 7, '#99acbf'); line(20, 5, 17, 7, '#99acbf');
      for (const x of [10, 13, 16, 19, 22]) line(x, 16, x, 19 - Math.abs(16 - x) / 3, '#dbe7f6');
      line(12, 23, 16, 24, '#957acc'); line(16, 24, 20, 23, '#957acc');
    } else if (id === 'antman') {
      poly([[14, 4], [18, 4], [18, 14], [14, 14]], P.red);
      line(9, 5, 6, 1, '#d5e7f4'); line(22, 5, 25, 1, '#d5e7f4');
      ellipse(9, 12, 1.6, 1.6, P.black); ellipse(22, 12, 1.6, 1.6, P.black);
      line(12, 13, 20, 13, '#172536');
      line(12, 18, 16, 21, '#d5e7f4'); line(20, 18, 16, 21, '#d5e7f4');
      line(10, 24, 22, 24, '#d5e7f4');
    } else {
      poly([[10, 6], [21, 6], [22, 12], [19, 14], [12, 14], [9, 12]], P.silver);
      line(10, 9, 14, 9, eye); line(18, 9, 21, 9, eye);
      line(13, 13, 19, 13, '#28313e');
      poly([[13, 18], [19, 18], [19, 22], [13, 22]], P.silver);
      dot(16, 20, '#efffff');
      line(10, 24, 22, 24, '#a9bbc9');
      if (flying) for (const x of [11 - stride, 21 + stride]) line(x, footY + 1, x, 31 - dy, '#ecf2ff');
    }
  } else {
    const hair = ['wanda', 'widow'].includes(id) ? P.auburn : id === 'hawkeye' ? P.gold : id === 'quicksilver' ? P.silver : id === 'thor' ? P.gold : P.black;
    poly([[9, 4], [22, 4], [23, 7], [19, 6], [16, 7], [12, 6], [8, 8]], hair);
    line(10, 9, 13, 9, closed ? '#947855' : '#172536'); line(18, 9, 21, 9, closed ? '#947855' : '#172536');
    line(14, 12, 18, 12 + (animation === 'talk' ? frame % 2 : 0), '#824835');
    if (id === 'wanda') {
      poly([[8, 4], [12, 7], [16, 5], [20, 7], [24, 4], [23, 9], [19, 8], [16, 7], [12, 8], [9, 9]], P.red);
      poly([[11, 17], [16, 19], [21, 17], [20, 23], [16, 24], [12, 23]], P.black);
      line(11, 18, 16, 21, '#ff8175'); line(21, 18, 16, 21, '#ff8175');
    } else if (id === 'widow') {
      limb(8, 8, 8, 16, 1.4, P.auburn); limb(23, 8, 23, 16, 1.4, P.auburn);
      line(16, 17, 16, 23, '#9cacbe');
      line(10, 24, 22, 24, '#e4ac48');
      b.pattern(14, 22 + dy, ['RRR', '.R.', 'RRR'], { R: '#fa6655' });
      line(5, leftY - 2, 7, leftY - 2, '#66b7ec'); line(25, rightY - 2, 27, rightY - 2, '#66b7ec');
    } else if (id === 'hawkeye') {
      line(9, 9, 22, 9, '#674487'); line(10, 10, 13, 10, '#181d2e'); line(18, 10, 21, 10, '#181d2e');
      line(11, 17, 20, 24, '#18212d'); line(10, 24, 22, 24, '#b7a4d6');
      poly([[3, leftY - 8], [1, leftY - 3], [1, leftY + 3], [3, leftY + 7], [5, leftY + 7], [3, leftY + 2], [3, leftY - 3], [5, leftY - 8]], P.gold);
      line(5, leftY - 7, 5, leftY + 6, '#dce3ec');
    } else if (id === 'falcon') {
      line(9, 9, 22, 9, '#cf353e'); line(10, 10, 13, 10, '#ff807a'); line(18, 10, 21, 10, '#ff807a');
      line(12, 12, 20, 12, '#352e31');
      poly([[11, 17], [16, 21], [21, 17], [21, 20], [16, 24], [11, 20]], P.red);
      line(10, 24, 22, 24, '#2e3948');
    } else if (id === 'thor') {
      limb(9, 8, 9, 15, 1.1, P.gold); limb(22, 8, 22, 15, 1.1, P.gold);
      for (const x of [12, 20]) for (const y of [18, 22]) ellipse(x, y, 1.4, 1.4, P.silver);
      line(26, rightY - 1, 26, rightY - 8, '#98623b');
      poly([[22, rightY - 9], [30, rightY - 9], [30, rightY - 4], [22, rightY - 4]], P.silver);
      if (raised || action || landing) {
        line(29, -dy, 27, 7, '#b7f9ff'); line(27, 7, 30, 10, '#b7f9ff'); line(30, 10, 28, 19, '#b7f9ff');
        if (landing) { b.line(4, 30, 9, 28, '#71dbff'); b.line(9, 28, 16, 31, '#e3faff'); b.line(16, 31, 26, 29, '#71dbff'); }
      }
    } else if (id === 'strange') {
      poly([[8, 14], [13, 17], [16, 19], [19, 17], [24, 14], [25, 18], [16, 22], [7, 18]], P.red);
      line(13, 12, 18, 12, '#332329'); dot(16, 14, '#332329');
      ellipse(16, 20, 1.4, 1.4, P.gold); dot(16, 20, '#68df8e');
      if (raised || animation === 'talk') {
        for (let a = 0; a < Math.PI * 2; a += 0.3) dot(27 + Math.cos(a) * 3, 12 + Math.sin(a) * 3, frame % 2 ? '#ffb653' : '#ff8142');
        line(25, 12, 29, 12, '#ffdc8f'); line(27, 10, 27, 14, '#ffdc8f');
      }
    } else if (id === 'hulk') {
      line(10, 8, 13, 9, '#213124'); line(18, 9, 21, 8, '#213124');
      line(12, 20, 20, 20, '#38773e'); line(16, 18, 16, 24, '#38773e');
      line(12, 13, 19, 13, '#f2e9c6');
      if (landing) for (const x of [2, 6, 24, 29]) {
        b.set(x, 29 - frame % 3, '#b8a58b'); b.set(x + 1, 31 - frame % 2, '#e0d3b8');
      }
    } else if (id === 'quicksilver') {
      b.pattern(13, 17 + dy, ['..WW', '.WW.', '..W.', '.WW.', 'WW..'], { W: '#f2fdff' });
      line(11, 24, 21, 24, '#c8f2ff');
      if (/work|play|happy/.test(animation)) b.stamp(26, 3 + dy, ['.NN', '.N.', 'NN.'], { N: '#bcefff' }, OUTLINE);
    }
  }
  if (animation === 'sleep') b.stamp(25, 2, ['ZZZ', '..Z', '.Z.', 'ZZZ'], { Z: '#c0e5ff' }, OUTLINE);
  if (animation === 'alert') b.stamp(28, 1, ['Y', 'Y', 'Y', '.', 'Y'], { Y: '#ffe69a' }, OUTLINE);
  if (/play|happy/.test(animation)) {
    const x = 2 + frame % 3, y = 5 + frame % 2;
    b.line(x - 1, y, x + 1, y, '#ffe59a'); b.line(x, y - 1, x, y + 1, '#ffe59a');
  }
  return size === 32 ? b : b.scaled(size / 32);
}

// Sideways flight: boots and exhaust trail behind the helmet, with no walking stride.
function ironManFlight(frame, size) {
  const b = new Bitmap(32, 32);
  const dy = frame % 4 === 1 ? -1 : frame % 4 === 3 ? 1 : 0;
  const shape = (mask, palette) => paint(b, mask, palette);
  const poly = (points, palette) => shape(new Mask(32, 32).poly(points.map(([x, y]) => [x, y + dy])), palette);
  const limb = (x, y, xx, yy, width, palette) => shape(new Mask(32, 32).capsule(x, y + dy, xx, yy + dy, width), palette);
  const line = (x, y, xx, yy, color) => b.line(x, y + dy, xx, yy + dy, color);
  for (const y of [17, 23]) {
    line(frame % 2, y, 7, y, '#56c9f0');
    line(2 + frame % 3, y - 1, 6, y - 1, '#d4ffff');
    line(3, y + 1, 6, y + 1, '#2389c2');
  }
  limb(15, 17, 7, 17, 2.3, P.red);
  limb(15, 21, 8, 23, 2.2, P.red);
  limb(6, 16, 6, 19, 1.5, P.gold);
  limb(7, 22, 7, 25, 1.5, P.gold);
  poly([[12, 14], [21, 12], [24, 16], [21, 22], [13, 23], [11, 19]], P.red);
  line(14, 14, 14, 21, '#e4ac48');
  shape(new Mask(32, 32).ellipse(20, 18 + dy, 2, 2), P.cyan);
  b.set(20, 18 + dy, '#ffffff');
  limb(16, 22, 23, 24, 1.7, P.red);
  limb(23, 24, 28, 23, 1.5, P.gold);
  poly([[22, 7], [28, 7], [31, 10], [31, 15], [28, 18], [22, 18], [20, 15], [20, 10]], P.red);
  poly([[25, 9], [29, 9], [30, 11], [30, 15], [27, 17], [23, 15], [23, 11]], P.gold);
  line(26, 11, 30, 11, '#d4ffff');
  line(27, 15, 30, 14, '#714832');
  return size === 32 ? b : b.scaled(size / 32);
}

function badge(size = 32, id = 'ironman') {
  const b = new Bitmap(32, 32);
  paint(b, new Mask(32, 32).ellipse(16, 16, 15, 15), pal('#1b3048', '#69dbef', '#112032'));
  b.blit(hero(id).crop(7, 3, 18, 13), 7, 9);
  return size === 32 ? b : b.scaled(size / 32);
}
module.exports = { hero, badge };
