const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('LvxDesktop', {
  hideToTray: () => ipcRenderer.send('radio:hide'),
  updatePlayback: (state) => ipcRenderer.send('radio:playback-state', {
    playing: state?.playing === true, available: state?.available === true,
    name: typeof state?.name === 'string' ? state.name.slice(0, 80) : '',
    title: typeof state?.title === 'string' ? state.title.slice(0, 160) : '',
    frequency: Number.isFinite(state?.frequency) ? state.frequency : null,
    colors: Array.isArray(state?.colors) ? state.colors.filter(color => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 3) : [],
  }),
  onTogglePlay: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('radio:toggle-play', listener);
    return () => ipcRenderer.removeListener('radio:toggle-play', listener);
  },
  chooseModelFolder: (accepted) => ipcRenderer.invoke('radio:choose-model', accepted === true),
});

// The page owns which view is visible; Electron owns the window around it.
// Only these two view names cross the sandbox boundary.
window.addEventListener('DOMContentLoaded', () => {
  let previous;
  const fit = () => {
    const scale = Math.min(1, (innerHeight - 102) / 878, innerWidth / 1180);
    document.documentElement.style.setProperty('--create-scale', String(Math.max(0.1, scale)));
  };
  const viewChanged = () => {
    const frame = document.querySelector('.mac-window');
    if (!frame) return;
    const view = frame.classList.contains('create-window') ? 'create' : 'radio';
    fit();
    if (view !== previous) {
      previous = view;
      ipcRenderer.send('radio:view', view);
    }
  };
  new MutationObserver(viewChanged).observe(document.body, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['class'],
  });
  window.addEventListener('resize', fit);
  viewChanged();
});
