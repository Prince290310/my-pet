'use strict';
// Where everything lives, in dev (`npm start`) and in the installed app.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const RENDERER = path.join(ROOT, 'renderer');
const PRELOAD = path.join(__dirname, 'preload');

// Default config shipped with the app (copied to the user's config folder on first run).
const DEFAULT_CONFIG = app.isPackaged ? path.join(process.resourcesPath, 'config') : path.join(ROOT, 'config');

/**
 * Editable config folder (quips.json, reminders.json, personality.md):
 *  - dev:       <project>/config            (edit the files right in the project)
 *  - installed: %APPDATA%/Shadow/config     (Program Files is read-only)
 */
function configDir() {
  if (process.env.SHADOW_CONFIG_DIR) return process.env.SHADOW_CONFIG_DIR;
  return app.isPackaged ? path.join(app.getPath('userData'), 'config') : DEFAULT_CONFIG;
}

/** Settings (name, size, timers, API key) live outside the project so keys never end up in it. */
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Make sure the config folder exists and has every default file (never overwrites user edits). */
function ensureConfig() {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  if (path.resolve(dir) === path.resolve(DEFAULT_CONFIG)) return dir;
  for (const name of fs.readdirSync(DEFAULT_CONFIG)) {
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(DEFAULT_CONFIG, name), target);
  }
  return dir;
}

module.exports = { ROOT, ASSETS, RENDERER, PRELOAD, DEFAULT_CONFIG, configDir, settingsFile, ensureConfig };
