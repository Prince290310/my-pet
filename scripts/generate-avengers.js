'use strict';
// Generate a separate complete theme. Never overwrite the original Shadow assets.
const fs = require('fs');
const path = require('path');
const { Bitmap } = require('./lib/raster');
const { encodePNG, encodeICO } = require('./lib/png');
const { hero, badge } = require('./lib/avengers-art');
const { PROFILES } = require('../main/hero-motion');
const ROOT = path.join(__dirname, '..', 'assets');
const OUT = path.join(ROOT, 'themes', 'avengers');
const TEAM = { atlas: 'spiderman', dash: 'cap', bolt: 'thor', sage: 'strange', zen: 'hulk', tempo: 'quicksilver' };
const write = (file, b) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, encodePNG(b.w, b.h, b.px)); };
function sheet(id, meta) {
  const size = meta.frameWidth;
  const b = new Bitmap(meta.columns * size, Object.keys(meta.animations).length * size);
  for (const [name, a] of Object.entries(meta.animations)) {
    for (let f = 0; f < a.frames; f++) b.blit(hero(id, name, f, size), f * size, a.row * size, name === 'walk_left');
    a.note = `${name}: ${id}, ${PROFILES[id].kind}`;
  }
  meta.character = id;
  meta.motion = PROFILES[id].kind;
  return b;
}
function main() {
  const mainTemplate = JSON.parse(fs.readFileSync(path.join(ROOT, 'sprites.json'), 'utf8'));
  const friendTemplate = JSON.parse(fs.readFileSync(path.join(ROOT, 'friends', 'atlas.json'), 'utf8'));
  for (const id of Object.keys(PROFILES)) {
    const dir = path.join(OUT, 'heroes', id);
    for (const [file, template] of [['sprites', mainTemplate], ['friend', friendTemplate]]) {
      const meta = JSON.parse(JSON.stringify(template));
      const row = Object.keys(meta.animations).length;
      meta.animations.arrive = { row, frames: 4, fps: 8, loop: false, flip: true };
      meta.animations.land = { row: row + 1, frames: 4, fps: 10, loop: false, flip: true };
      if (id === 'ironman') meta.animations.fly = { row: row + 2, frames: 8, fps: 12, loop: true, flip: true };
      if (file === 'friend') meta.animations.move.fps = id === 'quicksilver' ? 12 : id === 'hulk' ? 7 : 10;
      write(path.join(dir, `${file}.png`), sheet(id, meta));
      fs.writeFileSync(path.join(dir, `${file}.json`), JSON.stringify(meta, null, 2) + '\n');
    }
    for (const size of [16, 32, 256]) write(path.join(dir, size === 16 ? 'tray.png' : size === 32 ? 'tray@2x.png' : 'icon.png'), badge(size, id));
  }
  // Keep the original Avengers asset paths working for installers and existing tooling.
  for (const file of ['sprites.png', 'sprites.json', 'tray.png', 'tray@2x.png', 'icon.png']) fs.copyFileSync(path.join(OUT, 'heroes', 'ironman', file), path.join(OUT, file));
  for (const [key, id] of Object.entries(TEAM)) {
    for (const extension of ['png', 'json']) fs.copyFileSync(path.join(OUT, 'heroes', id, `friend.${extension}`), path.join(OUT, 'friends', `${key}.${extension}`));
  }
  fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeICO([16, 32, 48, 64, 128, 256].map(size => ({ size, rgba: badge(size).px }))));
  const characters = Object.keys(PROFILES);
  const columns = 8;
  const preview = new Bitmap(columns * 64 + 16, Math.ceil(characters.length / columns) * 80 + 16);
  for (let y = 0; y < preview.h; y++) for (let x = 0; x < preview.w; x++) preview.set(x, y, y % 80 < 76 ? '#101b2e' : '#1a2b40');
  characters.forEach((id, i) => preview.blit(hero(id, id === 'strange' ? 'work' : 'idle').scaled(2), 8 + (i % columns) * 64, 8 + Math.floor(i / columns) * 80));
  write(path.join(ROOT, 'preview', 'avengers-team.png'), preview.scaled(3));
  write(path.join(OUT, 'team.png'), preview.scaled(3));
  const moves = new Bitmap(8 * 32, characters.length * 32);
  Object.keys(PROFILES).forEach((id, row) => { for (let frame = 0; frame < 8; frame++) moves.blit(hero(id, frame < 4 ? 'move' : 'land', frame), frame * 32, row * 32); });
  write(path.join(ROOT, 'preview', 'avengers-movement.png'), moves.scaled(4));
  const flight = new Bitmap(8 * 32, 2 * 32);
  for (let frame = 0; frame < 8; frame++) {
    flight.blit(hero('ironman', 'fly', frame), frame * 32, 0);
    flight.blit(hero('ironman', 'fly', frame), frame * 32, 32, true);
  }
  write(path.join(ROOT, 'preview', 'ironman-flight.png'), flight.scaled(4));
  console.log('Fifteen Avengers generated: seven selectable leads and eight visual teammates with no assigned jobs.');
}
if (require.main === module) main();
module.exports = { main, TEAM, sheet };
