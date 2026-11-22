// Opt-in native layout regression. Run npm run test:window-fit on macOS.
// LVX_TEST_OLD_CREATE_CSS=1 restores the faulty width rule in the renderer;
// the same assertions must then fail, without changing shared source files.
// LVX_TEST_OLD_AIR_CSS=1 restores the unscaled On air hero at small heights.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow } from 'electron';
import { loadConfig } from '../../src/config.js';
import { Library } from '../../src/radio/library.js';
import { LuxCatalog, RESERVED_FREQUENCIES } from '../../src/radio/lux-catalog.js';
import { RadioStation } from '../../src/radio/station.js';
import { StationStore } from '../../src/radio/stations.js';
import { createApp, listen } from '../../src/server/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const data = mkdtempSync(join(tmpdir(), 'lvx-window-fit-'));
const sizes = [[1280, 980], [1280, 900], [1280, 800], [1180, 760]];
app.setPath('userData', join(data, 'chromium'));
app.on('window-all-closed', () => {});
app.whenReady().then(run);

async function waitFor(check, label) {
  const until = Date.now() + 10000;
  do {
    if (await check()) return;
    await delay(40);
  } while (Date.now() < until);
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  let station, server, window;
  let engineRuns = 0;
  try {
    app.dock?.hide();
    const config = loadConfig({ LVX_DATA_DIR: data, LVX_PORT: '0' });
    const library = new Library(config.libraryDir);
    await library.load();
    const stations = new StationStore(config.stationsFile, { reservedFrequencies: RESERVED_FREQUENCIES });
    await stations.load();
    const catalog = new LuxCatalog(config.lux);
    await catalog.load();
    // Match fake-radio: report simulated readiness so Create opens, but never
    // instantiate an engine or model setup, inspect weights, or launch a job.
    const engine = {
      async run() { engineRuns++; throw new Error('Window fitting must not generate audio'); },
      async abort() {},
      async stop() {},
    };
    station = new RadioStation({ engine, library, stations, catalog });
    server = createApp({ station, uiDir: config.uiDir, readGpu: async () => null });
    const address = await listen(server);
    window = new BrowserWindow({
      width: 1280, height: 980, show: false, useContentSize: true,
      titleBarStyle: 'hiddenInset', enableLargerThanScreen: true,
      webPreferences: {
        preload: join(root, 'src/electron/preload.cjs'),
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    window.webContents.setAudioMuted(true);
    const read = expression => window.webContents.executeJavaScript(expression, true);
    const resize = async (width, height) => {
      window.setContentSize(width, height);
      await waitFor(() => read(`innerWidth === ${width} && innerHeight === ${height}`), `${width}x${height} viewport`);
      // Let the view transition, preload resize handler, fonts and layout settle.
      await delay(350);
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    };
    await window.loadURL(address + '/?shell=app');
    // First launch asynchronously tunes an included station. Wait for that
    // transition before opening Create so it cannot switch views mid-check.
    await waitFor(() => read("!!document.querySelector('.air-window .fm-band')"), 'initial included station');
    await read('document.fonts.ready.then(() => true)');
    if (process.env.LVX_TEST_OLD_AIR_CSS === '1') {
      await window.webContents.insertCSS("html[data-shell='app'] .air-window .air-hero { zoom: 1 !important; }");
      console.log('Injected the old unscaled On air hero; layout assertions are expected to fail.');
    }
    const failures = [];
    const tolerance = 1; // Allow fractional CSS-pixel rounding at scaled sizes.
    for (const [width, height] of [[1120, 720], [1024, 640], [1024, 600]]) {
      await resize(width, height);
      const layout = await read(`(() => {
        const scroll = document.querySelector('.air-window .broadcast-scroll');
        const band = document.querySelector('.air-window .fm-band');
        const player = document.querySelector('.air-window .broadcast-player');
        const hero = document.querySelector('.air-window .air-hero');
        if (!scroll || !band || !player || !hero) return null;
        const rect = element => {
          const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
          return { left, top, right, bottom, width, height };
        };
        return {
          zoom: Number(getComputedStyle(hero).zoom),
          scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
          scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth,
          band: rect(band), player: rect(player),
        };
      })()`);
      console.log(`On air ${width}x${height}: ${JSON.stringify(layout)}`);
      assert.ok(layout, 'On air controls must be present');
      if (width === 1120 && layout.zoom !== 1) failures.push(`${width}x${height}: On air hero zoom must stay 1, got ${layout.zoom}`);
      if (layout.scrollHeight > layout.clientHeight) failures.push(`${width}x${height}: On air scrollHeight ${layout.scrollHeight} exceeds clientHeight ${layout.clientHeight}`);
      if (layout.scrollWidth > layout.clientWidth) failures.push(`${width}x${height}: On air scrollWidth ${layout.scrollWidth} exceeds clientWidth ${layout.clientWidth}`);
      if (layout.band.width <= 0 || layout.band.height <= 0 || layout.player.width <= 0 || layout.player.height <= 0) failures.push(`${width}x${height}: On air band and player must have nonzero size`);
      if (layout.band.bottom > layout.player.top + tolerance) failures.push(`${width}x${height}: FM band bottom ${layout.band.bottom} overlaps player top ${layout.player.top}`);
    }
    await waitFor(() => read("[...document.querySelectorAll('.window-tabs button')].some(button => button.textContent.trim() === 'Create')"), 'Create tab');
    await read("[...document.querySelectorAll('.window-tabs button')].find(button => button.textContent.trim() === 'Create').click()");
    await waitFor(() => read("!!document.querySelector('.create-window .create-columns .tune-module')"), 'Create controls');
    await read('document.fonts.ready.then(() => true)');
    if (process.env.LVX_TEST_OLD_CREATE_CSS === '1') {
      await window.webContents.insertCSS("html[data-shell='app'] .create-window .create-screen { width: calc(100% / var(--create-scale, 1)) !important; }");
      console.log('Injected the old Create width rule; layout assertions are expected to fail.');
    }

    for (const [width, height] of sizes) {
      await resize(width, height);
      const layout = await read(`(() => {
        const rect = selector => {
          const element = document.querySelector(selector);
          if (!element || getComputedStyle(element).visibility === 'hidden') return null;
          const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
          return { left, top, right, bottom, width, height };
        };
        return {
          innerWidth, innerHeight,
          scale: getComputedStyle(document.documentElement).getPropertyValue('--create-scale'),
          screen: rect('.create-window .create-screen'),
          columns: rect('.create-window .create-columns'),
          tune: rect('.create-window .tune-module'),
        };
      })()`);
      console.log(`${width}x${height}: ${JSON.stringify(layout)}`);
      for (const name of ['screen', 'columns', 'tune']) {
        const rect = layout[name];
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          failures.push(`${width}x${height}: ${name} must be visible with a nonzero size`);
          continue;
        }
        if (name === 'screen') {
          if (rect.width > layout.innerWidth + tolerance) failures.push(`${width}x${height}: .create-screen width ${rect.width} exceeds ${layout.innerWidth}`);
        } else if (rect.left < -tolerance || rect.top < -tolerance || rect.right > layout.innerWidth + tolerance || rect.bottom > layout.innerHeight + tolerance) {
          failures.push(`${width}x${height}: ${name === 'columns' ? '.create-columns' : '.tune-module'} exceeds viewport: ${JSON.stringify(rect)}`);
        }
      }
    }
    assert.equal(engineRuns, 0, 'window fitting starts no engine jobs');
    assert.deepEqual(failures, [], 'On air and Create controls must fit the native viewport without scrolling or clipping');
    console.log('PASS On air at 1120x720, 1024x640 and 1024x600; Create at 1280x980, 1280x900, 1280x800 and 1180x760 with the real preload; no engine or model.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await station?.close();
    await rm(data, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
}
