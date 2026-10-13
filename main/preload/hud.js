'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('hud', {
  ready: () => ipcRenderer.send('hud:ready'),
  interactive: (on) => ipcRenderer.send('hud:interactive', !!on),
  media: (action) => ipcRenderer.send('hud:media', String(action)),
  todoDone: (id) => ipcRenderer.send('hud:todo-done', String(id)),
  close: () => ipcRenderer.send('hud:close'),
  hidden: () => ipcRenderer.send('hud:hidden'),

  onShow: on('hud:show'),
  onHide: on('hud:hide'),
  onData: on('hud:data'),
  onTimer: on('hud:timer'),
  onCursor: on('hud:cursor'),
});
