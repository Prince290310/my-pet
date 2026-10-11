'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('shadow', {
  ready: () => ipcRenderer.send('pet:ready'),
  setInteractive: (interactive) => ipcRenderer.send('pet:interactive', !!interactive),
  click: () => ipcRenderer.send('pet:click'),
  dblclick: () => ipcRenderer.send('pet:dblclick'),
  ctrlClick: () => ipcRenderer.send('pet:ctrl-click'),
  contextMenu: () => ipcRenderer.send('pet:context-menu'),
  pressStart: (pt) => ipcRenderer.send('pet:press-start', pt),
  pressEnd: () => ipcRenderer.invoke('pet:press-end'), // -> { dragged }
  bubbleClick: () => ipcRenderer.send('pet:bubble-click'),
  testFrame: (info) => ipcRenderer.send('pet:test-frame', info),

  onInit: on('pet:init'),
  onAnim: on('pet:anim'),
  onBubble: on('pet:bubble'),
  onBubbleHide: on('pet:bubble-hide'),
  onScale: on('pet:scale'),
  onDisplay: on('pet:display'),
  onPause: on('pet:pause'),
  onResume: on('pet:resume'),
  onCursor: on('pet:cursor'),
});
