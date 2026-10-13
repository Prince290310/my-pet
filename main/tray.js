'use strict';
// System tray icon (small panther head) + its menu.

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { ASSETS } = require('./paths');
const appearance = require('./appearance');

/**
 * @param {object} o
 * @param {import('./brain').Brain} o.brain
 * @param {import('./settings').Settings} o.settings
 * @param {{get(): boolean, set(on: boolean): void}} o.loginItem
 * @param {object} o.actions { openSettings, openConfigFolder, openChat, quit }
 */
function createTray({ brain, settings, loginItem, actions, getUpdater = () => null, callGang = null }) {
  const icon = nativeImage.createFromPath(path.join(appearance.mainAssetsDir(ASSETS, settings), 'tray.png')); // tray@2x.png picked up automatically
  const tray = new Tray(icon);

  function template() {
    const hidden = brain.state === 'hidden';
    const sleeping = brain.state === 'sleep';
    const scale = settings.get('scale');
    const items = [
      { label: `${appearance.presentation(settings).icon} ${appearance.displayName(settings)}`, enabled: false },
      { type: 'separator' },
    ];
    const updater = getUpdater();
    if (updater && updater.ready) {
      items.push({ id: 'update', label: `✨ Restart to Update (${updater.state.version})`, click: () => updater.install() });
    }
    if (brain.activeReminder && !brain.reminderClosing) {
      const later = brain.activeReminder.kind === 'update';
      items.push({ id: 'dismiss', label: later ? 'Update Later' : '⏰ Dismiss Reminder', click: () => brain.dismissReminder('menu') });
    }
    if (items.length > 2) items.push({ type: 'separator' });
    items.push(
      hidden
        ? { id: 'toggle', label: 'Wake Pet', click: () => brain.command('wake') }
        : { id: 'toggle', label: 'Tuck Away Pet', click: () => brain.command('tuck') }
    );
    if (sleeping) items.push({ id: 'wake', label: 'Wake Pet', click: () => brain.command('wake') });
    if (actions.rescue) items.push({ id: 'rescue', label: `Unstick ${settings.get('petName')} (can't click?)`, click: () => actions.rescue() });
    if (callGang) items.push({ id: 'gang', label: appearance.isAvengers(settings) ? 'Avengers, Assemble! ⚡' : 'Call the Gang 🐾', click: () => callGang() });
    items.push(
      { id: 'chat', label: 'Chat… (Ctrl+Click pet)', click: () => actions.openChat() },
      {
        id: 'mute',
        label: 'Mute Quips',
        type: 'checkbox',
        checked: settings.get('muteQuips'),
        click: (item) => settings.update({ muteQuips: item.checked }),
      },
      {
        id: 'size',
        label: 'Size',
        submenu: [1, 2, 3].map((s) => ({
          id: `size-${s}`,
          label: `${s}x`,
          type: 'radio',
          checked: scale === s,
          click: () => settings.update({ scale: s }),
        })),
      },
      { type: 'separator' },
      { id: 'settings', label: 'Open Settings', click: () => actions.openSettings() },
      { id: 'config', label: 'Open Config Folder', click: () => actions.openConfigFolder() },
      {
        id: 'login',
        label: 'Start with Windows',
        type: 'checkbox',
        checked: loginItem.get(),
        click: (item) => {
          loginItem.set(item.checked);
          rebuild();
        },
      },
      { type: 'separator' },
      { id: 'quit', label: 'Quit', click: () => actions.quit() }
    );
    return items;
  }

  let menu = null;
  function rebuild() {
    if (tray.isDestroyed()) return;
    menu = Menu.buildFromTemplate(template());
    tray.setContextMenu(menu);
    tray.setImage(nativeImage.createFromPath(path.join(appearance.mainAssetsDir(ASSETS, settings), 'tray.png')));
    tray.setToolTip(`${appearance.displayName(settings)} - ${appearance.isAvengers(settings) ? 'Avengers desktop companion' : 'your panther'}${brain.state === 'hidden' ? ' (tucked away)' : ''}`);
  }

  tray.on('click', () => tray.popUpContextMenu());
  brain.on('state', (s, prev) => {
    if (['hidden', 'sleep'].includes(s) || ['hidden', 'sleep'].includes(prev)) rebuild();
  });
  brain.on('reminder-start', rebuild);
  brain.on('reminder-dismissed', rebuild);
  brain.on('reminder-done', rebuild);
  settings.on('change', (_all, changed) => {
    if (changed.some((k) => ['muteQuips', 'scale', 'petName', 'appearance', 'mainHero'].includes(k))) rebuild();
  });
  rebuild();

  return { tray, rebuild, menu: () => menu };
}

module.exports = { createTray };
