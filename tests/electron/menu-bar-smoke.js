// Opt-in native regression test. Run npm run test:menu-bar on macOS.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, ipcMain, Tray } from 'electron';
import { createMenuBar } from '../../src/electron/menu-bar.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const data = mkdtempSync(join(tmpdir(), 'lvx-menu-test-'));
app.setPath('userData', data);
app.on('window-all-closed', () => {});
app.whenReady().then(run);

async function run() {
  let menuBar, main, nativeTray, lastMenu;
  const originalTooltip = Tray.prototype.setToolTip;
  const originalMenu = Tray.prototype.popUpContextMenu;
  const waitFor = async predicate => {
    const until = Date.now() + 5000;
    do { if (await predicate()) return; await delay(25); } while (Date.now() < until);
    throw new Error('Timed out waiting for native radio state');
  };
  const update = (event, state) => {
    if (event.sender === main.webContents) menuBar.update(state);
  };
  try {
    Tray.prototype.setToolTip = function (text) { nativeTray = this; return originalTooltip.call(this, text); };
    Tray.prototype.popUpContextMenu = function (menu) { lastMenu = menu; };
    main = new BrowserWindow({
      width: 1120, height: 720,
      webPreferences: { preload: join(root, 'src/electron/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    menuBar = createMenuBar({ root, getWindow: () => main, quit: () => app.quit() });
    ipcMain.on('radio:playback-state', update);
    await main.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><title>Test radio</title><body><script>
      let playing = true;
      function publish() { window.LvxDesktop.updatePlayback({ playing, available:true, name:'Test station', title:'Test song', frequency:102.2 }); }
      window.LvxDesktop.onTogglePlay(() => { playing = !playing; publish(); });
      publish();
    </script>`));
    const bounds = main.getBounds();
    main.hide();
    nativeTray.emit('click');
    const panel = BrowserWindow.getAllWindows().find(window => window !== main);
    const read = expression => panel.webContents.executeJavaScript(expression);
    await waitFor(async () => !panel.webContents.isLoading());
    await waitFor(async () => await read("document.querySelector('#status').textContent") === 'ON AIR');
    assert.equal(await read("document.querySelector('#track').textContent"), 'Test song');
    assert.equal(main.isVisible(), false, 'opening mini player must keep the radio hidden');
    await read("document.querySelector('#play').click()");
    await waitFor(async () => await read("document.querySelector('#status').textContent") === 'STOPPED');
    assert.equal(main.isVisible(), false);
    await read("document.querySelector('#play').click()");
    await waitFor(async () => await read("document.querySelector('#status').textContent") === 'ON AIR');
    // Main-window and unrelated senders cannot use the mini-player control channel.
    ipcMain.emit('radio:menu-action', { sender: main.webContents }, 'open');
    assert.equal(main.isVisible(), false);
    await read("document.querySelector('#open').click()");
    await waitFor(() => main.isVisible());
    assert.equal(main.isMaximized(), false, 'Open radio must not maximize');
    assert.deepEqual(main.getBounds(), bounds, 'Open radio must keep the previous window bounds');
    assert.equal(panel.isVisible(), false);
    nativeTray.emit('click');
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'reuse the existing mini player');
    await read("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
    await waitFor(() => !panel.isVisible());
    menuBar.update({ playing: false, available: false, name: 'Empty station' });
    nativeTray.emit('click');
    await waitFor(async () => await read("document.querySelector('#play').disabled"));
    await read('window.LvxMini.togglePlay()');
    await delay(50);
    assert.equal(await read("document.querySelector('#status').textContent"), 'READY');
    nativeTray.emit('right-click');
    assert.equal(panel.isVisible(), false);
    assert.equal(lastMenu.items.find(item => item.label === 'Play').enabled, false);
    assert.ok(lastMenu.items.some(item => item.label === 'Open radio'));
    assert.ok(!lastMenu.items.some(item => /Maximize/.test(item.label)));
    menuBar.destroy(); menuBar = null;
    assert.equal(panel.isDestroyed(), true);
    assert.equal(ipcMain.listenerCount('radio:menu-action'), 0);
    console.log('PASS native mini player: initial state, Play/Stop, hidden radio, same window bounds, IPC ownership, unavailable playback, Escape, cleanup.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    ipcMain.removeListener('radio:playback-state', update);
    menuBar?.destroy();
    main?.destroy();
    Tray.prototype.setToolTip = originalTooltip;
    Tray.prototype.popUpContextMenu = originalMenu;
    app.exit(process.exitCode || 0);
  }
}
