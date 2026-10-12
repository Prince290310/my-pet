'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chat', {
  info: () => ipcRenderer.invoke('chat:info'),
  ask: (message) => ipcRenderer.invoke('chat:ask', String(message)),
  close: () => ipcRenderer.send('chat:close'),
  openLink: (url) => ipcRenderer.send('chat:open-link', String(url)),
  onPush: (cb) => ipcRenderer.on('chat:push', (_e, m) => cb(m)), // lines that come later (quiz race)
});
