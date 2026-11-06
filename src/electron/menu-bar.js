import { join } from 'node:path';
import { BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } from 'electron';

/** A single radio in the menu bar. Hiding the window never stops its playback. */
export function createMenuBar({ root, getWindow, quit }) {
  const icon = nativeImage.createFromPath(join(root, 'src/ui/assets/logo-symbol.png')).resize({ width: 22, height: 20 });
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  let playback = { playing: false, available: false, name: 'LVX in Radio', title: '', frequency: null, colors: [] };
  let panel = null;
  let mode = 'tray';
  let compactBounds = null;
  const hidePanel = () => {
    if (mode === 'compact' && panel?.isVisible()) compactBounds = panel.getBounds();
    panel?.hide();
  };
  const show = () => {
    hidePanel();
    const window = getWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const togglePlay = () => {
    if (playback.available) getWindow()?.webContents.send('radio:toggle-play');
  };
  const publish = () => {
    if (panel) panel.webContents.send('radio:menu-state', { ...playback, compact: mode === 'compact' });
  };
  const ensurePanel = () => {
    if (!panel) {
      panel = new BrowserWindow({
        width: 352, height: 380, show: false, frame: false, transparent: true, type: 'panel',
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, alwaysOnTop: true, hasShadow: true, title: 'LVX mini player',
        webPreferences: {
          preload: join(root, 'src/electron/menu-bar-preload.cjs'),
          contextIsolation: true, nodeIntegration: false, sandbox: true,
        },
      });
      panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      panel.webContents.on('will-navigate', event => event.preventDefault());
      panel.webContents.on('did-finish-load', publish);
      const visualsActive = () => getWindow()?.webContents.send('radio:visuals-active', panel?.isVisible() === true);
      panel.on('show', visualsActive);
      panel.on('hide', visualsActive);
      panel.on('blur', () => { if (mode === 'tray') panel?.hide(); });
      panel.on('closed', () => { panel = null; visualsActive(); });
      // State is also requested by the preload, so the first frame is current.
      panel.loadFile(join(root, 'src/ui/assets/mini/panel.html'));
    }
  };
  const togglePanel = () => {
    if (panel?.isVisible()) { hidePanel(); mode = 'tray'; return; }
    ensurePanel();
    mode = 'tray';
    const anchor = tray.getBounds();
    const area = screen.getDisplayMatching(anchor).workArea;
    const { width, height } = panel.getBounds();
    panel.setPosition(
      Math.round(Math.max(area.x, Math.min(anchor.x + anchor.width / 2 - width / 2, area.x + area.width - width))),
      Math.round(Math.max(area.y, Math.min(anchor.y + anchor.height + 4, area.y + area.height - height))),
    );
    publish();
    panel.show();
    panel.focus();
  };
  const showCompact = () => {
    ensurePanel();
    const window = getWindow();
    if (!window) return;
    const anchor = compactBounds ?? window.getBounds();
    const area = screen.getDisplayMatching(anchor).workArea;
    const { width, height } = panel.getBounds();
    const x = compactBounds?.x ?? anchor.x + anchor.width - width;
    const y = compactBounds?.y ?? anchor.y + anchor.height - height;
    panel.setPosition(
      Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
      Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
    );
    mode = 'compact';
    publish();
    panel.show();
    panel.focus();
    window.hide();
  };
  const action = (event, command) => {
    if (!panel || event.sender !== panel.webContents) return;
    if (command === 'state') publish();
    else if (command === 'toggle-play') togglePlay();
    else if (command === 'open') show();
    else if (command === 'hide' || command === 'tray') { hidePanel(); mode = 'tray'; }
  };
  ipcMain.on('radio:menu-action', action);
  const menu = () => Menu.buildFromTemplate([
    { label: 'LVX in Radio', enabled: false },
    { label: playback.name || 'Ready to play', enabled: false },
    { type: 'separator' },
    { label: 'Open radio', click: () => show() },
    { label: playback.playing ? 'Stop playback' : 'Play', enabled: playback.available, click: togglePlay },
    { type: 'separator' },
    { label: 'Quit LVX in Radio', click: quit },
  ]);
  tray.setToolTip('LVX in Radio');
  tray.on('click', togglePanel);
  tray.on('right-click', () => { hidePanel(); tray.popUpContextMenu(menu()); });
  return {
    show,
    showCompact,
    updateVisuals(visuals) {
      if (!panel?.isVisible() || !Array.isArray(visuals?.levels) || visuals.levels.length !== 60) return;
      panel.webContents.send('radio:menu-visuals', {
        levels: visuals.levels.map(level => Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0),
        time: Number.isFinite(visuals.time) ? Math.max(0, visuals.time) : 0,
      });
    },
    update(state) {
      playback = {
        playing: state.playing === true, available: state.available === true,
        name: typeof state.name === 'string' ? state.name.slice(0, 80) : '',
        title: typeof state.title === 'string' ? state.title.slice(0, 160) : '',
        frequency: Number.isFinite(state.frequency) && state.frequency >= 87.8 && state.frequency <= 107.8 ? state.frequency : null,
        colors: Array.isArray(state.colors) ? state.colors.filter(color => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)).slice(0, 6) : [],
      };
      tray.setToolTip(`LVX in Radio · ${playback.playing ? 'On air' : 'Stopped'}${playback.name ? ' · ' + playback.name : ''}`);
      publish();
    },
    destroy() {
      ipcMain.removeListener('radio:menu-action', action);
      panel?.destroy();
      tray.destroy();
    },
  };
}
