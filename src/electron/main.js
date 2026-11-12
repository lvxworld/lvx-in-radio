import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';

import { loadConfig } from '../config.js';
import { startRadio } from '../start.js';
import { createMenuBar } from './menu-bar.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

app.setName('LVX in Radio');
// Keep the data from the first desktop preview when the display name changes.
const userData = process.env.LVX_DATA_DIR ?? join(app.getPath('appData'), 'LVX Radio');
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let radio = null;
let window = null;
let menuBar = null;
let quitting = false;

/** Where the engine and bundled songs are, in the built app and when run from source. */
function radioConfig() {
  const dataDir = process.env.LVX_DATA_DIR ?? app.getPath('userData');
  const engineDir = app.isPackaged ? join(process.resourcesPath, 'engine') : join(ROOT, 'vendor/audio.cpp');
  const packaged = app.isPackaged
    ? { luxDir: join(process.resourcesPath, 'lux'), modelDir: join(dataDir, 'models'), djLlmCommand: join(process.resourcesPath, 'dj-llm/bin/mlx_lm.server') }
    : {};
  const config = loadConfig(process.env, {
    dataDir,
    engineBinary: join(engineDir, 'audiocpp_server'),
    modelSpecs: join(engineDir, 'model_specs'),
    ...packaged,
  });
  return { ...config, port: 0 };
}

function openWindow(address) {
  ipcMain.on('radio:hide', (event) => {
    if (window && event.sender === window.webContents) window.hide();
  });
  ipcMain.on('radio:mini', (event) => {
    if (window && event.sender === window.webContents) menuBar?.showCompact();
  });
  ipcMain.on('radio:playback-state', (event, state) => {
    if (window && event.sender === window.webContents && state && typeof state === 'object') menuBar?.update(state);
  });
  ipcMain.on('radio:visuals', (event, visuals) => {
    if (window && event.sender === window.webContents) menuBar?.updateVisuals(visuals);
  });
  ipcMain.handle('radio:choose-model', async (event, accepted) => {
    if (!window || event.sender !== window.webContents) throw new Error('Unknown window');
    if (!accepted) throw new Error('Please accept the model terms first');
    const result = await dialog.showOpenDialog(window, { title: 'Choose your YuE2 model folder', properties: ['openDirectory'] });
    if (result.canceled) return null;
    await radio.setup.useDirectory(result.filePaths[0], true);
    return radio.setup.snapshot();
  });
  ipcMain.handle('radio:choose-dj-model', async (event) => {
    if (!window || event.sender !== window.webContents) throw new Error('Unknown window');
    const result = await dialog.showOpenDialog(window, { title: 'Choose your DJ script model folder', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0b0a09',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 25 },
    webPreferences: { preload: join(ROOT, 'src/electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  // The layout is built for fixed sizes: dragging an edge only makes it brittle.
  // Maximize and restore (even from the green button) still work; the app's own
  // resizing between On air and Create goes through setBounds, which never fires this.
  window.on('will-resize', (event) => {
    if (!window.isMaximized() && !window.isFullScreen()) event.preventDefault();
  });
  let view = 'radio';
  let radioBounds = window.getBounds();
  ipcMain.on('radio:view', (event, next) => {
    if (!window || event.sender !== window.webContents || !['create', 'radio'].includes(next) || next === view) return;
    if (window.isFullScreen() || window.isMaximized()) { view = next; return; }
    const current = window.getBounds();
    if (next === 'create') radioBounds = current;
    const area = screen.getDisplayMatching(current).workArea;
    const desired = next === 'create' ? { width: 1280, height: 980 } : radioBounds;
    const width = Math.min(desired.width, area.width);
    const height = Math.min(desired.height, area.height);
    const x = next === 'create' ? Math.round(current.x + (current.width - width) / 2) : radioBounds.x;
    const y = next === 'create' ? Math.round(current.y + (current.height - height) / 2) : radioBounds.y;
    view = next;
    window.setBounds({
      width, height,
      x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
    }, true);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== address) event.preventDefault();
  });
  window.loadURL(`${address}/?shell=app`);
  window.on('minimize', (event) => { event.preventDefault(); window.hide(); });
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); window.hide(); }
  });
  window.on('closed', () => {
    window = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.on('window-all-closed', () => app.quit());

  let closing = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (!radio) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    radio.close().finally(() => { menuBar?.destroy(); app.exit(0); });
  });

  app.whenReady().then(async () => {
    try {
      radio = await startRadio(radioConfig());
      openWindow(radio.address);
      menuBar = createMenuBar({ root: ROOT, getWindow: () => window, quit: () => app.quit() });
      app.on('activate', () => menuBar?.show());
    } catch (error) {
      dialog.showErrorBox('LVX in Radio could not start', error.message);
      app.exit(1);
    }
  });
}
