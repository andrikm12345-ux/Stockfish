'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bot', {
  start:  (opts) => ipcRenderer.invoke('start-bot', opts),
  stop:   ()     => ipcRenderer.invoke('stop-bot'),
  cmd:    (text) => ipcRenderer.invoke('cmd', text),
  onLog:  (cb)   => ipcRenderer.on('log', (_, m) => cb(m)),
  onStop: (cb)   => ipcRenderer.on('bot-stopped', () => cb()),
})
