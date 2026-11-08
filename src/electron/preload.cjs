const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('LvxDesktop', {
  hideToTray: () => ipcRenderer.send('radio:hide'),
  openMiniPlayer: () => ipcRenderer.send('radio:mini'),
  updatePlayback: (state) => ipcRenderer.send('radio:playback-state', {
    generation: state?.generation,
    generationAvailable: state?.generationAvailable === true, generationEnabled: state?.generationEnabled === true,
    playing: state?.playing === true, available: state?.available === true,
    name: typeof state?.name === 'string' ? state.name.slice(0, 80) : '',
    title: typeof state?.title === 'string' ? state.title.slice(0, 160) : '',
    frequency: Number.isFinite(state?.frequency) ? state.frequency : null,
    colors: Array.isArray(state?.colors) ? state.colors.filter(color => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 6) : [],
  }),
  updateVisuals: (visuals) => {
    if (!Array.isArray(visuals?.levels) || visuals.levels.length !== 60) return;
    ipcRenderer.send('radio:visuals', {
      levels: visuals.levels.map(level => Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0),
      time: Number.isFinite(visuals.time) ? Math.max(0, visuals.time) : 0,
    });
  },
  onVisualsActive: (callback) => {
    const listener = (_event, active) => callback(active === true);
    ipcRenderer.on('radio:visuals-active', listener);
    return () => ipcRenderer.removeListener('radio:visuals-active', listener);
  },
  onTogglePlay: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('radio:toggle-play', listener);
    return () => ipcRenderer.removeListener('radio:toggle-play', listener);
  },
  onGenerationHover: (callback) => {
    const listener = (_event, active) => callback(active === true);
    ipcRenderer.on('radio:generation-hover', listener);
    return () => ipcRenderer.removeListener('radio:generation-hover', listener);
  },
  onToggleGeneration: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('radio:toggle-generation', listener);
    return () => ipcRenderer.removeListener('radio:toggle-generation', listener);
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
