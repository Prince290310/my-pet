'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('game', {
  onState: (cb) => ipcRenderer.on('game:state', (_e, s) => cb(s)),
});
