import { join } from 'node:path';
import { BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } from 'electron';

/** A single radio in the menu bar. Hiding the window never stops its playback. */
export function createMenuBar({ root, getWindow, quit }) {
  const icon = nativeImage.createFromPath(join(root, 'src/ui/assets/logo-symbol.png')).resize({ width: 22, height: 20 });
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  let playback = { playing: false, available: false, name: 'LVX in Radio', title: '', frequency: null };
  let panel = null;
  const show = () => {
    panel?.hide();
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
    if (panel) panel.webContents.send('radio:menu-state', playback);
  };
  const togglePanel = () => {
    if (panel?.isVisible()) { panel.hide(); return; }
    if (!panel) {
      panel = new BrowserWindow({
        width: 352, height: 314, show: false, frame: false, transparent: true, type: 'panel',
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
      panel.on('blur', () => panel?.hide());
      panel.on('closed', () => { panel = null; });
      // State is also requested by the preload, so the first frame is current.
      panel.loadFile(join(root, 'src/electron/menu-bar.html'));
    }
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
  const action = (event, command) => {
    if (!panel || event.sender !== panel.webContents) return;
    if (command === 'state') publish();
    else if (command === 'toggle-play') togglePlay();
    else if (command === 'open') show();
    else if (command === 'hide') panel.hide();
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
  tray.on('right-click', () => { panel?.hide(); tray.popUpContextMenu(menu()); });
  return {
    show,
    update(state) {
      playback = {
        playing: state.playing === true, available: state.available === true,
        name: typeof state.name === 'string' ? state.name.slice(0, 80) : '',
        title: typeof state.title === 'string' ? state.title.slice(0, 160) : '',
        frequency: Number.isFinite(state.frequency) && state.frequency >= 87.8 && state.frequency <= 107.8 ? state.frequency : null,
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
