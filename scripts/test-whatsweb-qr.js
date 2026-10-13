'use strict';
/*
 * Windows CI check for the WhatsApp Web engine (main/whatsweb.js) with the real library:
 * it finds Edge/Chrome, opens WhatsApp Web headless and gets as far as the QR code a phone would scan.
 * Nothing is linked, sent or kept. Run with Electron's Node (ELECTRON_RUN_AS_NODE=1) to match the app.
 * SHADOW_APP_DIR=<...>/resources/app.asar runs the copy packed inside a built app instead of the source.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const MAIN = process.env.SHADOW_APP_DIR ? path.join(process.env.SHADOW_APP_DIR, 'main') : path.join(__dirname, '..', 'main');
const { WhatsWeb, findBrowser } = require(path.join(MAIN, 'whatsweb'));
const fromApp = (name) => require(require.resolve(name, { paths: [MAIN] }));

const LIMIT_MS = 150 * 1000;
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsweb-ci-'));
const values = {};
const settings = { get: (k) => values[k], update: (p) => Object.assign(values, p) };

const browser = findBrowser();
if (process.platform !== 'win32' || !browser) {
  console.log(`SKIP no Windows Edge/Chrome here (${process.platform})`);
  process.exit(0);
}
console.log(`PASS browser found: ${path.basename(browser)}`);
console.log(`PASS runtime: ${process.versions.electron ? `Electron ${process.versions.electron}` : 'Node'} ${process.version}`);
if (process.env.SHADOW_APP_DIR) {
  const lib = require.resolve('whatsapp-web.js', { paths: [MAIN] });
  if (!lib.includes('app.asar')) {
    console.log(`FAIL whatsapp-web.js was not loaded from the packaged app (${lib})`);
    process.exit(1);
  }
  console.log('PASS whatsapp-web.js and puppeteer load from inside the packaged app.asar');
}

const web = new WhatsWeb({ settings, dataPath });
let finished = false;
async function finish(code, line) {
  if (finished) return;
  finished = true;
  console.log(line);
  await web.stop().catch(() => {});
  fs.rmSync(dataPath, { recursive: true, force: true });
  process.exit(code);
}
const timer = setTimeout(() => finish(1, `FAIL no QR code within ${LIMIT_MS / 1000} s (state ${web.state}${web.error ? `: ${web.error}` : ''})`), LIMIT_MS);
const started = Date.now();
web.on('status', async (s) => {
  if (s.state === 'starting') console.log('PASS engine started');
  if (s.state === 'qr' && s.qr) {
    clearTimeout(timer);
    const image = await fromApp('qrcode').toDataURL(s.qr, { margin: 1, width: 264 });
    const ok = /^data:image\/png;base64,/.test(image) && s.qr.length > 20;
    await finish(ok ? 0 : 1, `${ok ? 'PASS' : 'FAIL'} WhatsApp Web loaded headless and showed a QR code after ${Math.round((Date.now() - started) / 1000)} s (code ${s.qr.length} chars, image ${image.length} bytes)`);
  }
  if (s.state === 'error') {
    clearTimeout(timer);
    await finish(1, `FAIL ${s.error}`);
  }
});
web.start();
