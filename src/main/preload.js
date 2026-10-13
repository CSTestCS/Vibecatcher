'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vibe', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  getCharacters: () => ipcRenderer.invoke('characters:get'),
  setCharacters: (d) => ipcRenderer.invoke('characters:set', d),
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  openVrm: () => ipcRenderer.invoke('vrm:open'),
  readVrm: (p) => ipcRenderer.invoke('vrm:read', p),
  saveFbx: (bytes, name) => ipcRenderer.invoke('fbx:save', bytes, name),
  listUserBottoms: () => ipcRenderer.invoke('bottoms:list'),
  openBottomsFolder: () => ipcRenderer.invoke('bottoms:openFolder'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('mouse:ignore', ignore),
  quit: () => ipcRenderer.send('app:quit'),
  onToggleMenu: (fn) => ipcRenderer.on('toggle-menu', () => fn()),
});
