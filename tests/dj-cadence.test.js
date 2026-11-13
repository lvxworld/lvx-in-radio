import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { writeWav } from '../src/engine/wav.js';
import { DjDesk } from '../src/radio/dj/dj-desk.js';
import { loadConfig } from '../src/config.js';
import { startRadio } from '../src/start.js';

// Owner feedback fix1 item 3: "How often" goes down to 1 ("every 1 to N songs", 1 to 1 = after
// every song), and the DJ still never speaks on the first song after tuning in.

const GiB = 1024 ** 3;
const lineWav = writeWav({ sampleRate: 24000, samples: [Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 13) * 0.1)] });

const song = (n) => ({ id: `song-${n}`, title: `Tune Number ${n}`, status: 'ready', generation: { mix: { Pop: 100 }, mood: 'bright', bpm: 104 } });
/** The station is playing song n, with song n + 1 ready next. */
const playing = (n, extra = {}) => ({
  stationId: 'station-a', lux: false, playing: true, busy: false, djId: 'serena', playbackSessionId: 'session-1',
  current: song(n), next: song(n + 1), playbackTrackId: song(n).id,
  config: { mix: { Pop: 100 }, mood: 'bright', bpm: 104, energy: 50, dark: 20, flavors: [], seed: 7 },
  runwaySec: 300, songEstimateSec: 90, ...extra,
});

class Station {
  constructor() { this.context = playing(1); this.holds = []; this.releases = 0; }
  djContext() { return this.context; }
  snapshot() { return { stationId: this.context.stationId, tracks: [] }; }
  requestHold(callback, options) {
    this.holds.push(options);
    queueMicrotask(() => callback(() => { this.releases += 1; }));
    return () => {};
  }
}

async function desk(t, root) {
  const station = new Station();
  const ready = { snapshot: async () => ({ ready: true, status: 'ready', directory: join(root, 'model') }) };
  const engine = { requests: [], isWarm: () => true, async run(request) { this.requests.push(request); return { audio: lineWav.toString('base64') }; }, async abort() {}, async stop() {} };
  const dj = new DjDesk({ dataDir: root, station, engine, modelSetup: ready, voiceSetup: ready, freeMemory: async () => 11 * GiB, isWarm: () => true });
  await dj.load();
  t.after(() => dj.close());
  return { dj, station, engine };
}

// node:test runs after-hooks in registration order: the folder is removed after every desk closed.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-cadence-'));
  const f = { root, ...(await desk(t, root)) };
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  return f;
}

async function waitFor(predicate, timeout = 2500) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (predicate()) return; await delay(10); }
  assert.fail('DJ state did not settle before timeout');
}

/** Plays song n on the fake station and lets the DJ look at it. */
function play(f, n, extra) { f.station.context = playing(n, extra); f.dj.consider(f.station.context); }

test('the cadence accepts 1 as its minimum, also 1 to 1, and keeps it after a restart', async (t) => {
  const f = await fixture(t);
  for (const [minSongs, maxSongs] of [[1, 4], [1, 1], [1, 2]]) {
    const state = await f.dj.configure({ minSongs, maxSongs });
    assert.equal(state.minSongs, minSongs); assert.equal(state.maxSongs, maxSongs);
  }
  const saved = JSON.parse(await readFile(join(f.root, 'dj-settings.json'), 'utf8'));
  assert.equal(saved.minSongs, 1); assert.equal(saved.maxSongs, 2);
  const again = await desk(t, f.root);
  const state = await again.dj.settings();
  assert.equal(state.minSongs, 1, 'a saved minimum of 1 is not reset to the old 2-4 default');
  assert.equal(state.maxSongs, 2);
});

test('a saved 1 to 1 cadence loads as 1 to 1', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-cadence-'));
  await writeFile(join(root, 'dj-settings.json'), JSON.stringify({ version: 1, enabled: false, minSongs: 1, maxSongs: 1 }));
  const { dj } = await desk(t, root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await dj.settings();
  assert.equal(state.minSongs, 1); assert.equal(state.maxSongs, 1);
});

for (const bad of [0, -1, 1.5, '1', null]) {
  test(`the cadence refuses minSongs ${JSON.stringify(bad)} and keeps the previous range`, async (t) => {
    const f = await fixture(t);
    await f.dj.configure({ minSongs: 1, maxSongs: 3 });
    await assert.rejects(f.dj.configure({ minSongs: bad }), TypeError);
    const state = await f.dj.settings();
    assert.equal(state.minSongs, 1); assert.equal(state.maxSongs, 3);
  });
}

test('the cadence refuses a minimum above the maximum', async (t) => {
  const f = await fixture(t);
  await f.dj.configure({ minSongs: 1, maxSongs: 1 });
  await assert.rejects(f.dj.configure({ minSongs: 2 }), TypeError);
});

test('1 to 1 introduces every song, starting with the first one after tuning', async (t) => {
  const f = await fixture(t);
  await f.dj.configure({ enabled: true, minSongs: 1, maxSongs: 1 });
  for (let n = 1; n <= 4; n++) {
    play(f, n);
    assert.equal(f.station.holds.length, n, `song ${n} gets its introduction`);
    await waitFor(() => f.dj.snapshot().introduction?.state === 'armed');
    assert.equal(f.dj.snapshot().introduction.nextSongId, song(n + 1).id);
  }
  assert.equal(f.engine.requests.length, 4);
});

test('1 to 1: retuning (a new playback session) speaks on its first song too', async (t) => {
  const f = await fixture(t);
  await f.dj.configure({ enabled: true, minSongs: 1, maxSongs: 1 });
  play(f, 1);
  await waitFor(() => f.dj.snapshot().introduction?.state === 'armed');
  play(f, 10, { playbackSessionId: 'session-2' });
  assert.equal(f.station.holds.length, 2, 'the first song of the new session gets its DJ');
});

test('1 to 1: moving to another station speaks on its first song', async (t) => {
  const f = await fixture(t);
  await f.dj.configure({ enabled: true, minSongs: 1, maxSongs: 1 });
  play(f, 1);
  await waitFor(() => f.dj.snapshot().introduction?.state === 'armed');
  play(f, 20, { stationId: 'station-b', playbackSessionId: 'session-b' });
  assert.equal(f.station.holds.length, 2);
});

test('1 to N: the first slot after tuning comes after 1 to N songs, counting the first song', async (t) => {
  const due = new Set();
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const f = await fixture(t);
    await f.dj.configure({ enabled: true, minSongs: 1, maxSongs: 4 });
    play(f, 1, { config: { ...playing(1).config, seed } });
    const { afterSongs, remainingSongs } = f.dj.snapshot().nextSlot;
    assert.ok(afterSongs >= 1 && afterSongs <= 4, `seed ${seed}: afterSongs ${afterSongs}`);
    assert.equal(remainingSongs, afterSongs - 1, `seed ${seed}: the first song already counts`);
    assert.equal(f.station.holds.length, afterSongs === 1 ? 1 : 0, `seed ${seed}`);
    due.add(afterSongs);
  }
  assert.ok(due.has(1), 'some seeds speak on the very first song');
});

test('the settings API accepts a 1 to 1 cadence and refuses 0 with 400', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-cadence-api-'));
  const config = loadConfig({ LVX_DATA_DIR: root, LVX_PORT: '0', LVX_NEWS_VOICE_DIR: join(root, 'voice') }, { modelDir: join(root, 'models'), engineBinary: join(root, 'missing'), modelSpecs: root, luxDir: join(root, 'lux') });
  const radio = await startRadio(config, { wrapEngine: () => ({ run() { throw new Error('No inference expected'); }, async abort() {}, async stop() {} }) });
  t.after(async () => { await radio.close(); await rm(root, { recursive: true, force: true }); });
  const post = (body) => fetch(`${radio.address}/api/dj/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ok = await post({ minSongs: 1, maxSongs: 1 });
  assert.equal(ok.status, 200, await ok.clone().text());
  const state = await (await fetch(`${radio.address}/api/dj`)).json();
  assert.equal(state.minSongs, 1); assert.equal(state.maxSongs, 1);
  assert.equal((await post({ minSongs: 0 })).status, 400);
});
