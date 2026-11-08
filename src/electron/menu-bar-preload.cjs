const { contextBridge, ipcRenderer } = require('electron');

// The mini player controls playback and generation through its owning radio.
contextBridge.exposeInMainWorld('LvxMini', {
  togglePlay: () => ipcRenderer.send('radio:menu-action', 'toggle-play'),
  toggleGeneration: () => ipcRenderer.send('radio:menu-action', 'toggle-generation'),
  generationHover: active => ipcRenderer.send('radio:menu-action', active === true ? 'generation-enter' : 'generation-leave'),
  open: () => ipcRenderer.send('radio:menu-action', 'open'),
  hide: () => ipcRenderer.send('radio:menu-action', 'hide'),
  toTray: () => ipcRenderer.send('radio:menu-action', 'tray'),
  onVisuals: (callback) => {
    const listener = (_event, visuals) => callback(visuals);
    ipcRenderer.on('radio:menu-visuals', listener);
    return () => ipcRenderer.removeListener('radio:menu-visuals', listener);
  },
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('radio:menu-state', listener);
    ipcRenderer.send('radio:menu-action', 'state');
    return () => ipcRenderer.removeListener('radio:menu-state', listener);
  },
});
