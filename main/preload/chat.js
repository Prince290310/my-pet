'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chat', {
  info: () => ipcRenderer.invoke('chat:info'),
  ask: (message) => ipcRenderer.invoke('chat:ask', String(message)),
  close: () => ipcRenderer.send('chat:close'),
});
