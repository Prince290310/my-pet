'use strict';
// Copies the bundled pixel fonts (OFL licensed, from @fontsource) into renderer/fonts
// so the app never needs the network. Run once after `npm install` (already done in the repo).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'renderer', 'fonts');
const FILES = [
  ['@fontsource/pixelify-sans/files/pixelify-sans-latin-400-normal.woff2', 'pixelify-sans-400.woff2'],
  ['@fontsource/pixelify-sans/files/pixelify-sans-latin-600-normal.woff2', 'pixelify-sans-600.woff2'],
  ['@fontsource/pixelify-sans/files/pixelify-sans-latin-700-normal.woff2', 'pixelify-sans-700.woff2'],
  ['@fontsource/press-start-2p/files/press-start-2p-latin-400-normal.woff2', 'press-start-2p-400.woff2'],
  ['@fontsource/pixelify-sans/LICENSE', 'LICENSE-PixelifySans.txt'],
  ['@fontsource/press-start-2p/LICENSE', 'LICENSE-PressStart2P.txt'],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [from, to] of FILES) {
  fs.copyFileSync(path.join(ROOT, 'node_modules', from), path.join(OUT, to));
  console.log(`copied ${to}`);
}
