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
  ask: (text) => ipcRenderer.send('hud:ask', String(text).slice(0, 2000)),
  openConsole: () => ipcRenderer.send('hud:console'),
  scanReady: () => ipcRenderer.send('hud:scan-ready'),
  openLink: (url) => ipcRenderer.send('hud:open-link', String(url)),
  speech: (state) => ipcRenderer.send('hud:speech', String(state)),
  speakFallback: (lines) => ipcRenderer.send('hud:speak-fallback', Array.isArray(lines) ? lines.map(String).slice(0, 60) : []),
  stopFallback: () => ipcRenderer.send('hud:speak-stop'),

  onShow: on('hud:show'),
  onHide: on('hud:hide'),
  onData: on('hud:data'),
  onTimer: on('hud:timer'),
  onCursor: on('hud:cursor'),
  onMode: on('hud:mode'),
  onFocus: on('hud:focus'),
  onAnswer: on('hud:answer'),
  onScan: on('hud:scan'),
  onReport: on('hud:report'),
  onSpeechLine: on('hud:speech-line'),
  onSpeechEnd: on('hud:speech-end'),
  onMute: on('hud:mute'),
});
