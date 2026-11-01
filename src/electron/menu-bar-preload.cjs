const { contextBridge, ipcRenderer } = require('electron');

// The mini player can only control playback and restore its owning radio.
contextBridge.exposeInMainWorld('LvxMini', {
  togglePlay: () => ipcRenderer.send('radio:menu-action', 'toggle-play'),
  open: () => ipcRenderer.send('radio:menu-action', 'open'),
  hide: () => ipcRenderer.send('radio:menu-action', 'hide'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('radio:menu-state', listener);
    ipcRenderer.send('radio:menu-action', 'state');
    return () => ipcRenderer.removeListener('radio:menu-state', listener);
  },
});
