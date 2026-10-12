'use strict';
// Generate a separate complete theme. Never overwrite the original Shadow assets.
const fs = require('fs');
const path = require('path');
const { Bitmap } = require('./lib/raster');
const { encodePNG, encodeICO } = require('./lib/png');
const { hero, badge } = require('./lib/avengers-art');
const ROOT = path.join(__dirname, '..', 'assets');
const OUT = path.join(ROOT, 'themes', 'avengers');
const TEAM = { atlas: 'spiderman', dash: 'cap', bolt: 'thor', sage: 'strange', zen: 'hulk', tempo: 'starlord' };
const write = (file, b) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, encodePNG(b.w, b.h, b.px)); };
function sheet(id, meta) {
  const size = meta.frameWidth;
  const b = new Bitmap(meta.columns * size, Object.keys(meta.animations).length * size);
  for (const [name, a] of Object.entries(meta.animations)) {
    for (let f = 0; f < a.frames; f++) b.blit(hero(id, name, f, size), f * size, a.row * size, name === 'walk_left');
    a.note = id === 'ironman' ? `${name}: armored humanoid Iron Man` : `${name}: ${id}`;
  }
  meta.character = id;
  return b;
}
function main() {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'sprites.json'), 'utf8'));
  write(path.join(OUT, 'sprites.png'), sheet('ironman', meta));
  fs.writeFileSync(path.join(OUT, 'sprites.json'), JSON.stringify(meta, null, 2) + '\n');
  for (const [key, id] of Object.entries(TEAM)) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'friends', `${key}.json`), 'utf8'));
    write(path.join(OUT, 'friends', `${key}.png`), sheet(id, m));
    fs.writeFileSync(path.join(OUT, 'friends', `${key}.json`), JSON.stringify(m, null, 2) + '\n');
  }
  for (const size of [16, 32, 256]) write(path.join(OUT, size === 16 ? 'tray.png' : size === 32 ? 'tray@2x.png' : 'icon.png'), badge(size));
  fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeICO([16, 32, 48, 64, 128, 256].map(size => ({ size, rgba: badge(size).px }))));
  const preview = new Bitmap(7 * 64 + 16, 96);
  for (let y = 0; y < preview.h; y++) for (let x = 0; x < preview.w; x++) preview.set(x, y, y < 78 ? '#101b2e' : '#1a2b40');
  ['ironman', ...Object.values(TEAM)].forEach((id, i) => preview.blit(hero(id, id === 'strange' ? 'work' : 'idle').scaled(2), 8 + i * 64, 13));
  write(path.join(ROOT, 'preview', 'avengers-team.png'), preview.scaled(3));
  write(path.join(OUT, 'team.png'), preview.scaled(3));
  console.log('Avengers theme generated: Iron Man, Spider-Man, Captain America, Thor, Doctor Strange, Hulk, Star-Lord.');
}
if (require.main === module) main();
module.exports = { main, TEAM, sheet };
