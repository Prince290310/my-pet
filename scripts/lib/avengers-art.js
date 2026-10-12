'use strict';
// Actual humanoid comic-book heroes, drawn on the same pixel grid as the existing app.
const { Bitmap, Mask, paint } = require('./raster');
const OUTLINE = '#101421';
const pal = (base, light, dark) => ({ base, rim: light, rim2: base, dark, outline: OUTLINE });
const P = {
  red: pal('#c53236', '#ff7770', '#752331'), gold: pal('#e4ac48', '#ffe39a', '#a96a31'),
  blue: pal('#2764ad', '#66a8ec', '#183863'), silver: pal('#9cb4c9', '#e5f5ff', '#536a85'),
  skin: pal('#e4ad85', '#ffe0ba', '#aa715a'), green: pal('#65b64a', '#a4e76c', '#357241'),
  purple: pal('#7353a7', '#be96ed', '#43316b'), black: pal('#28313e', '#596676', '#151c29'),
};

function hero(id, animation = 'idle', frame = 0, size = 32) {
  const b = new Bitmap(32, 32);
  const phase = Math.sin(frame * Math.PI / 2);
  const moving = /move|walk/.test(animation);
  const flying = animation === 'pounce' || (animation === 'move' && id === 'spiderman');
  const resting = animation === 'sleep' || animation === 'sit';
  const raised = /work|play|happy|stretch|alert/.test(animation);
  const dy = flying ? -3 + (frame % 2) : resting ? 3 : frame % 4 === 1 ? -1 : 0;
  const shape = (mask, palette) => paint(b, mask, palette);
  const ellipse = (x, y, rx, ry, palette) => shape(new Mask(32, 32).ellipse(x, y + dy, rx, ry), palette);
  const poly = (points, palette) => shape(new Mask(32, 32).poly(points.map(([x, y]) => [x, y + dy])), palette);
  const line = (x, y, xx, yy, color) => b.line(x, y + dy, xx, yy + dy, color);
  const dot = (x, y, color) => b.set(x, y + dy, color);
  const limb = (x, y, xx, yy, width, palette) => shape(new Mask(32, 32).capsule(x, y + dy, xx, yy + dy, width), palette);
  const torso = id === 'hulk' ? P.green : id === 'cap' || id === 'strange' ? P.blue : id === 'thor' ? P.black : P.red;
  const leg = id === 'hulk' ? P.purple : id === 'spiderman' || id === 'starlord' ? P.blue : torso;
  const spread = id === 'hulk' ? 2 : 0;
  const footY = resting ? 29 - dy : 29;
  const stride = moving ? phase * 2 : 0;
  if (id === 'thor' || id === 'strange') poly([[9, 14], [23, 14], [27 + phase, 28], [6, 28]], P.red);
  if (id === 'starlord') poly([[9, 15], [23, 15], [24, 28], [18, 27], [16, 23], [13, 28], [8, 28]], P.red);
  limb(12, 23, 12 - stride, footY, 2.2, leg);
  limb(20, 23, 20 + stride, footY, 2.2, leg);
  ellipse(11 - stride, footY, 3, 1.3, id === 'hulk' ? P.green : id === 'strange' ? P.black : P.red);
  ellipse(21 + stride, footY, 3, 1.3, id === 'hulk' ? P.green : id === 'strange' ? P.black : P.red);
  poly([[10 - spread, 16], [22 + spread, 16], [23, 21], [20, 25], [12, 25], [9, 21]], torso);
  const arm = id === 'hulk' ? P.green : id === 'thor' ? P.skin : torso;
  const leftY = animation === 'stretch' ? 8 : raised ? 16 + phase * 2 : 24 + (moving ? stride : 0);
  const rightY = animation === 'groom' ? 19 : animation === 'talk' ? 20 + phase : raised ? 12 + phase : 24 - (moving ? stride : 0);
  limb(9 - spread, 17, 6 - spread, leftY, id === 'hulk' ? 2.8 : 2, arm);
  limb(23 + spread, 17, 26 + spread, rightY, id === 'hulk' ? 2.8 : 2, arm);
  ellipse(6 - spread, leftY, 2, 2, id === 'ironman' ? P.gold : arm);
  ellipse(26 + spread, rightY, 2, 2, id === 'ironman' ? P.gold : arm);
  const headPal = id === 'ironman' || id === 'spiderman' ? P.red : id === 'cap' ? P.blue : id === 'hulk' ? P.green : P.skin;
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
      line(x, footY + 1, x, footY + 2 + frame % 2, '#7feaff');
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
    if (raised || flying) { line(27, rightY - 2, 30, 1, '#deefff'); line(26, rightY - 2, 29, 1, '#859bac'); }
  } else if (id === 'cap') {
    poly([[9, 11], [23, 11], [21, 14], [11, 14]], P.skin);
    b.pattern(14, 5 + dy, ['.W.', 'W.W', 'WWW', 'W.W'], { W: '#f4f6e9' });
    line(10, 10, 12, 10, closed ? '#39618a' : '#f0f6ff'); line(19, 10, 21, 10, closed ? '#39618a' : '#f0f6ff');
    b.stamp(13, 17 + dy, ['..W..', 'WWWWW', '.WWW.', '.W.W.'], { W: '#ffffff' });
    for (let x = 11; x <= 21; x += 2) line(x, 22, x, 24, '#faf4ec');
    ellipse(25, 22, 5.5, 5.5, P.red); ellipse(25, 22, 4, 4, P.silver); ellipse(25, 22, 3, 3, P.red); ellipse(25, 22, 2, 2, P.blue);
    b.pattern(24, 20 + dy, ['.W.', 'WWW', '.W.'], { W: '#ffffff' });
  } else {
    const hair = id === 'thor' ? P.gold : P.black;
    poly([[9, 4], [22, 4], [23, 7], [19, 6], [16, 7], [12, 6], [8, 8]], hair);
    line(10, 9, 13, 9, closed ? '#947855' : '#172536'); line(18, 9, 21, 9, closed ? '#947855' : '#172536');
    line(14, 12, 18, 12 + (animation === 'talk' ? frame % 2 : 0), '#824835');
    if (id === 'thor') {
      limb(9, 8, 9, 15, 1.1, P.gold); limb(22, 8, 22, 15, 1.1, P.gold);
      for (const x of [12, 20]) for (const y of [18, 22]) ellipse(x, y, 1.4, 1.4, P.silver);
      line(26, rightY - 1, 26, rightY - 8, '#98623b');
      poly([[22, rightY - 9], [30, rightY - 9], [30, rightY - 4], [22, rightY - 4]], P.silver);
      if (raised) { line(29, 1, 27, 4, '#b7f9ff'); line(27, 4, 30, 5, '#b7f9ff'); line(30, 5, 28, 8, '#b7f9ff'); }
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
    } else if (id === 'starlord') {
      poly([[8, 7], [23, 7], [24, 12], [20, 15], [11, 15], [7, 12]], P.silver);
      line(9, 9, 13, 9, '#ff494c'); line(18, 9, 22, 9, '#ff494c');
      line(13, 12, 19, 12, '#252b38'); line(14, 14, 18, 14, '#252b38');
      line(16, 16, 16, 25, '#f6bf68'); line(11, 24, 21, 24, '#bac7d0');
      if (raised || animation === 'talk') b.stamp(26, 3 + dy, ['.NN', '.N.', 'NN.'], { N: '#b89cff' }, OUTLINE);
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

function badge(size = 32) {
  const b = new Bitmap(32, 32);
  paint(b, new Mask(32, 32).ellipse(16, 16, 15, 15), pal('#1b3048', '#69dbef', '#112032'));
  b.blit(hero('ironman').crop(7, 3, 18, 13), 7, 9);
  return size === 32 ? b : b.scaled(size / 32);
}
module.exports = { hero, badge };
