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
      window.LvxDesktop.onVisualsActive(active => { window.visualsActive = active; });
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
    await waitFor(async () => await main.webContents.executeJavaScript('window.visualsActive===true'));
    await waitFor(async () => await read("document.querySelector('#dial').width>0"));
    const alignment = await read(`(()=>{
      const selectors=['.station-dial','.frequency','#station','#track','#play'];
      const centers=selectors.map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.left+r.width/2});
      return {centered:Math.max(...centers)-Math.min(...centers)<1,fits:document.querySelector('#open').getBoundingClientRect().bottom<=innerHeight-8};
    })()`);
    assert.equal(alignment.centered, true, 'the dial, frequency, station, song and play button share a center');
    assert.equal(alignment.fits, true, 'all controls fit below the semicircle');
    await read('window.testVisuals=null;window.LvxMini.onVisuals(visuals=>{window.testVisuals=visuals});true');
    menuBar.updateVisuals({ levels: [Infinity,-1,2,...Array(57).fill(.5)], time:-1 });
    await waitFor(async () => await read('!!window.testVisuals'));
    assert.deepEqual(await read('window.testVisuals.levels.slice(0,3)'), [0,0,1]);
    assert.equal(await read('window.testVisuals.time'), 0);
    menuBar.updateVisuals({ levels: Array(60).fill(0), time:0 });
    await delay(100);
    const quietDial = await read("document.querySelector('#dial').toDataURL()");
    menuBar.updateVisuals({ levels: Array(60).fill(1), time:0 });
    await delay(100);
    assert.notEqual(await read("document.querySelector('#dial').toDataURL()"),quietDial,'the EQ responds to the received audio spectrum');
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
    await waitFor(async () => await main.webContents.executeJavaScript('window.visualsActive===false'));
    menuBar.showCompact();
    await waitFor(async () => await read("document.body.classList.contains('is-compact')&&!document.querySelector('#tray').hidden"));
    assert.equal(main.isVisible(), false, 'compact mode hides the normal window');
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'compact mode reuses the menu-bar panel');
    panel.emit('blur');
    assert.equal(panel.isVisible(), true, 'compact mode stays visible when another app gains focus');
    assert.equal(await read("document.querySelector('#status').textContent"), 'ON AIR', 'opening compact mode preserves playback');
    await read("document.querySelector('#play').click()");
    await waitFor(async () => await read("document.querySelector('#status').textContent") === 'STOPPED');
    await read("document.querySelector('#play').click()");
    await waitFor(async () => await read("document.querySelector('#status').textContent") === 'ON AIR');
    const compactBounds = panel.getBounds();
    await read("document.querySelector('#tray').click()");
    await waitFor(() => !panel.isVisible());
    assert.equal(main.isVisible(), false, 'Move to menu bar keeps the normal window hidden');
    menuBar.showCompact();
    assert.deepEqual(panel.getBounds(), compactBounds, 'compact mode remembers its position');
    await read("document.querySelector('#open').click()");
    await waitFor(() => main.isVisible());
    assert.deepEqual(main.getBounds(), bounds, 'compact mode restores the same normal window');
    assert.equal(panel.isVisible(), false);
    nativeTray.emit('click');
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'reuse the existing mini player');
    await waitFor(async () => await read("!document.body.classList.contains('is-compact')&&document.querySelector('#tray').hidden"));
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
    console.log('PASS native mini player: centered semicircle and controls, real spectrum response, validated levels, visible-only animation, compact mode, blur, Play/Stop, menu bar, restoration, IPC ownership, cleanup.');
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
