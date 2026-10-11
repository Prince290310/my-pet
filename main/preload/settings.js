'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  load: () => ipcRenderer.invoke('settings:load'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  openConfigFolder: () => ipcRenderer.send('settings:open-config'),
  testAi: (form) => ipcRenderer.invoke('ai:test', form),
  openLink: (url) => ipcRenderer.send('settings:open-link', String(url)),
  testCalendar: (url) => ipcRenderer.invoke('calendar:test', String(url)),
  syncCalendar: () => ipcRenderer.invoke('calendar:sync'),
  callGang: () => ipcRenderer.send('friends:call'),
  testTelegram: (token) => ipcRenderer.invoke('telegram:test', String(token)),
  telegramInfo: () => ipcRenderer.invoke('telegram:info'),
  unpairTelegram: () => ipcRenderer.invoke('telegram:unpair'),
  testSearch: (key) => ipcRenderer.invoke('search:test', String(key)),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
});
