// Puppeteer (used by whatsapp-web.js) drives the Microsoft Edge / Chrome already on the PC.
// Never download its own ~170 MB browser - not on install, not in CI builds.
module.exports = { skipDownload: true };
