import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { writeWav } from '../src/engine/wav.js';
import { DjDesk } from '../src/radio/dj/dj-desk.js';
import { DjLlm } from '../src/radio/dj/dj-llm.js';
import { AudioCppEngine } from '../src/engine/audiocpp.js';
import { createApp, listen } from '../src/server/app.js';

const GiB = 1024 ** 3;
const lineWav = writeWav({ sampleRate: 24000, samples: [Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 13) * 0.1)] });
const baseContext = () => ({
  stationId: 'station-a', lux: false, playing: true, busy: false, djId: 'serena',
  current: { id: 'current-a', title: 'Previous Tune', status: 'ready' },
  next: { id: 'next-a', title: 'Blue Hour, Open Window', status: 'ready', generation: { mix: { Pop: 100 }, mood: 'calm and reflective', bpm: 92 } },
  config: { mix: { Pop: 100 }, mood: 'calm', bpm: 92, energy: 22, dark: 35, flavors: [], seed: 7 },
  runwaySec: 300, songEstimateSec: 90, playbackTrackId: 'current-a',
});

class HoldStation {
  constructor(context = baseContext(), { autoGrant = false } = {}) { this.context = context; this.autoGrant = autoGrant; this.waiters = []; this.holds = []; this.releases = 0; this.withdrawals = 0; }
  djContext() { return this.context; }
  snapshot() { return { stationId: this.context.stationId, tracks: [] }; }
  requestHold(callback, options) {
    const waiter = { callback, options, active: true };
    this.waiters.push(waiter); this.holds.push(options);
    if (this.autoGrant === 'sync') this.grant(waiter);
    else if (this.autoGrant) queueMicrotask(() => this.grant(waiter));
    return () => { if (waiter.active) { waiter.active = false; this.withdrawals += 1; } };
  }
  grant(waiter = this.waiters.find((item) => item.active)) {
    if (!waiter?.active) return false;
    waiter.active = false;
    let released = false;
    waiter.callback(() => { if (!released) { released = true; this.releases += 1; } });
    return true;
  }
}

async function fixture(t, { context = baseContext(), autoGrant = false, memory = 11 * GiB, engineError = null, modelReady = true, voiceReady = true, voiceWarm = false, isWarm, slotEverySong = false, newsUrgent = () => false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-slots-'));
  const station = new HoldStation(context, { autoGrant });
  const model = { ready: modelReady, snapshot: async function () { return { ready: this.ready, status: this.ready ? 'ready' : 'idle', directory: join(root, 'model') }; } };
  const voice = { ready: voiceReady, snapshot: async function () { return { ready: this.ready, status: this.ready ? 'ready' : 'idle' }; } };
  const engine = { requests: [], aborts: 0, isWarm: (model) => model === 'qwen3tts' && voiceWarm, run: async function (request) { this.requests.push(request); if (engineError) throw new Error(engineError); return { audio: lineWav.toString('base64') }; }, abort: async function () { this.aborts += 1; }, stop: async function () {} };
  // An empty previews folder: auditions here exercise live synthesis, not the bundled clips (see dj-preview-bundle).
  const previewsDir = join(root, 'no-previews'); await mkdir(previewsDir);
  const desk = new DjDesk({ dataDir: root, station, engine, modelSetup: model, voiceSetup: voice, freeMemory: async () => memory, newsUrgent, isWarm, slotEverySong, previewsDir });
  await desk.load();
  if (modelReady && voiceReady) await desk.configure({ enabled: true, minSongs: 2, maxSongs: 2 });
  t.after(async () => { await desk.close(); await rm(root, { recursive: true, force: true }); });
  return { root, desk, station, model, voice, engine };
}

async function waitFor(predicate, timeout = 2500) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (predicate()) return; await delay(10); }
  assert.fail('DJ state did not settle before timeout');
}


// Count a preceding song, then let the real current song make the default two-song slot due.
function startSlot(f) {
  const context = f.station.context;
  f.desk.consider({ ...context, playbackTrackId: 'lead-in', current: context.current ? { ...context.current, id: 'lead-in' } : null });
  f.desk.consider(context);
}

const blockedCases = [
  ['DJs off', async f => f.desk.configure({ enabled: false })],
  ['LLM missing', async f => { f.model.ready = false; await f.desk.settings(); }],
  ['voice missing', async f => { f.voice.ready = false; await f.desk.settings(); }],
  ['paused', async f => { f.station.context.playing = false; }],
  ['no playback report', async f => { Object.assign(f.station.context, { playing: false, current: null, playbackTrackId: null }); }],
  ['no station DJ', async f => { f.station.context.djId = null; }],
];
for (const [label, prepare] of blockedCases) {
  test(`automatic DJ starts no work with ${label}`, async t => {
    const f = await fixture(t);
    await prepare(f); startSlot(f);
    assert.equal(f.station.holds.length, 0);
    assert.equal(f.engine.requests.length, 0);
    assert.ok(!['preparing', 'armed'].includes(f.desk.snapshot().introduction?.state));
  });
}
for (const [label, change, reason] of [
  ['next song absent', { next: null }, 'next-song-not-ready'],
  ['short runway', { runwaySec: 179.99 }, 'not-enough-time'],
]) {
  test(`automatic slot refuses ${label} and does not retry the same song`, async t => {
    const f = await fixture(t, { context: { ...baseContext(), ...change } });
    startSlot(f);
    assert.equal(f.desk.snapshot().introduction.state, 'refused');
    assert.equal(f.desk.snapshot().introduction.reason, reason);
    for (let i = 0; i < 5; i++) f.desk.consider(f.station.context);
    assert.equal(f.station.holds.length, 0);
  });
}

test('urgent News skips an automatic slot without starting the engine', async t => {
  const f = await fixture(t, { newsUrgent: () => true });
  startSlot(f);
  assert.equal(f.desk.snapshot().introduction.reason, 'news-urgent');
  assert.equal(f.station.holds.length, 0);
});

for (const flags of [{ enabled: false }, { generationEnabled: false }, { enabled: false, generationEnabled: false }]) {
  test(`automatic slots ignore legacy generation gates ${JSON.stringify(flags)}`, async t => {
    const f = await fixture(t, { autoGrant: true, context: { ...baseContext(), ...flags } });
    startSlot(f);
    await waitFor(() => f.desk.snapshot().introduction?.state === 'armed');
    assert.equal(f.engine.requests.length, 1);
  });
}

test('global DJ enablement and cadence survive restart', async t => {
  const f = await fixture(t);
  await f.desk.configure({ minSongs: 3, maxSongs: 4 });
  await f.desk.close();
  const desk = new DjDesk({ dataDir: f.root, station: f.station, engine: f.engine, modelSetup: f.model, voiceSetup: f.voice });
  await desk.load(); t.after(() => desk.close());
  const state = await desk.settings();
  assert.equal(state.enabled, true); assert.equal(state.minSongs, 3); assert.equal(state.maxSongs, 4);
});

for (const [temperature, warm, productionSec] of [['cold', false, 60], ['warm', true, 25]]) {
  for (const songEstimateSec of [0, 90]) {
    const threshold = productionSec + songEstimateSec + 30;
    test(`${temperature} automatic slot threshold is ${threshold}s with ${songEstimateSec}s song reserve`, async t => {
      for (const enough of [false, true]) {
        const f = await fixture(t, { isWarm: () => warm, context: { ...baseContext(), songEstimateSec, runwaySec: threshold - (enough ? 0 : 0.01) } });
        const before = Date.now(); startSlot(f); const after = Date.now();
        assert.equal(f.station.holds.length, enough ? 1 : 0);
        assert.equal(f.desk.snapshot().introduction.state, enough ? 'preparing' : 'refused');
        if (!enough) { assert.equal(f.desk.snapshot().introduction.reason, 'not-enough-time'); continue; }
        const hold = f.station.holds[0];
        assert.equal(hold.priority, 'dj');
        assert.ok(hold.expiresAt >= before + productionSec * 1000 && hold.expiresAt <= after + productionSec * 1000);
        f.station.grant(); await waitFor(() => f.station.releases === 1);
        assert.equal(f.desk.snapshot().introduction.state, 'armed');
      }
    });
  }
}

test('late automatic grant rechecks warmth and releases a budget that no longer fits', async t => {
  let warm = true;
  const f = await fixture(t, { isWarm: () => warm, context: { ...baseContext(), songEstimateSec: 0, runwaySec: 55 } });
  startSlot(f); warm = false; f.station.grant();
  assert.equal(f.station.releases, 1);
  assert.equal(f.desk.snapshot().introduction.reason, 'not-enough-time');
  assert.equal(f.engine.requests.length, 0);
});

for (const songEstimateSec of [0, 90]) {
  test(`automatic deadline retains 25s production with ${songEstimateSec}s song reserve`, async t => {
    const f = await fixture(t, { isWarm: () => true, context: { ...baseContext(), songEstimateSec, runwaySec: 55 + songEstimateSec } });
    let rejectVoice;
    f.engine.run = function(request) { this.requests.push(request); return new Promise((resolve, reject) => { rejectVoice = reject; }); };
    f.engine.abort = async function() { this.aborts++; rejectVoice?.(new Error('deadline aborted')); };
    startSlot(f); t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      f.station.grant();
      for (let i = 0; i < 200 && !f.engine.requests.length; i++) await new Promise(setImmediate);
      assert.equal(f.engine.requests.length, 1);
      t.mock.timers.tick(24_999); assert.equal(f.engine.aborts, 0);
      t.mock.timers.tick(1);
      for (let i = 0; i < 200 && !f.station.releases; i++) await new Promise(setImmediate);
      assert.equal(f.engine.aborts, 1); assert.equal(f.station.releases, 1);
      assert.equal(f.desk.snapshot().introduction.reason, 'not-enough-time');
      assert.equal(f.desk.snapshot().lastLine, null);
    } finally { t.mock.timers.reset(); }
  });
}

test('waiting automatic slot expires and resets cadence without retrying the same song', async t => {
  const f = await fixture(t, { isWarm: () => true, context: { ...baseContext(), songEstimateSec: 0, runwaySec: 55 } });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    startSlot(f); t.mock.timers.tick(25_000);
    assert.equal(f.station.withdrawals, 1);
    assert.equal(f.desk.snapshot().introduction.reason, 'expired');
    for (let i = 0; i < 5; i++) f.desk.consider(f.station.context);
    assert.equal(f.station.holds.length, 1);
    assert.equal(f.engine.requests.length, 0);
  } finally { t.mock.timers.reset(); }
});

test('a synchronously granted slot has no leftover waiting expiry after it arms', async t => {
  const f = await fixture(t, { autoGrant: 'sync', isWarm: () => true, context: { ...baseContext(), songEstimateSec: 0, runwaySec: 55 } });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    startSlot(f);
    const until = performance.now() + 1500;
    while (performance.now() < until && f.desk.snapshot().introduction?.state !== 'armed') await new Promise(setImmediate);
    assert.equal(f.desk.snapshot().introduction.state, 'armed');
    t.mock.timers.tick(25_001);
    assert.equal(f.desk.snapshot().introduction.state, 'armed', 'completed audio cannot be refused by an obsolete waiter timer');
    assert.equal(f.engine.aborts, 0);
    assert.equal(f.station.releases, 1);
  } finally { t.mock.timers.reset(); }
});

test('only the explicit demo cadence flag makes a slot due on the first reported song', async t => {
  const f = await fixture(t, { slotEverySong: true });
  f.desk.consider(f.station.context);
  assert.equal(f.station.holds.length, 1);
  assert.equal(f.desk.snapshot().introduction.state, 'preparing');
});

test('default template warmth needs the resident voice and tier-one warmth needs both voice and writer', async t => {
  let writerWarm = true;
  t.mock.method(DjLlm.prototype, 'complete', async () => 'Take a breath and let the day slow down around this station. Even the clock could use a tea break instead of another meeting. Stay comfortable for the reflective Blue Hour, Open Window, coming up next for a little company.');
  t.mock.method(DjLlm.prototype, 'isWarm', () => writerWarm);
  for (const tier of [2, 1]) {
    for (const [voiceWarm, llmWarm] of [[true, true], [false, true], [true, false]]) {
      writerWarm = true;
      const f = await fixture(t, { autoGrant: true, voiceWarm: true, memory: (tier === 1 ? 20 : 11) * GiB, context: { ...baseContext(), songEstimateSec: 0 } });
      startSlot(f); await waitFor(() => f.desk.snapshot().introduction?.state === 'armed');
      assert.equal(f.desk.snapshot().tier, tier);
      f.station.autoGrant = false; f.engine.isWarm = () => voiceWarm; writerWarm = llmWarm;
      f.station.context = { ...f.station.context, current: { ...f.station.context.current, id: 'second-current' }, playbackTrackId: 'second-current', runwaySec: 55 };
      startSlot(f);
      assert.equal(f.desk.snapshot().introduction.state, voiceWarm && (tier === 2 || llmWarm) ? 'preparing' : 'refused');
    }
  }
});

test('repeated automatic snapshots cannot queue a duplicate introduction', async t => {
  const f = await fixture(t, { autoGrant: true }); startSlot(f);
  for (let i = 0; i < 5; i++) f.desk.consider(f.station.context);
  assert.equal(f.station.holds.length, 1);
  await waitFor(() => f.desk.snapshot().introduction?.state === 'armed');
  for (let i = 0; i < 5; i++) f.desk.consider(f.station.context);
  assert.equal(f.station.holds.length, 1);
  assert.equal(f.desk.snapshot().introduction.songId, 'current-a');
  assert.equal(f.desk.snapshot().lastLine.songId, 'next-a');
  assert.equal(f.desk.snapshot().lastLine.durationSec, 1);
});

for (const [reason, options] of [['error', { engineError: 'voice failed' }], ['low-memory', { memory: 9 * GiB }]]) {
  test(`${reason} refuses the slot and resets cadence`, async t => {
    const f = await fixture(t, { autoGrant: true, ...options }); startSlot(f);
    await waitFor(() => f.station.releases === 1);
    assert.equal(f.desk.snapshot().introduction.state, 'refused');
    assert.equal(f.desk.snapshot().introduction.reason, reason);
    for (let i = 0; i < 5; i++) f.desk.consider(f.station.context);
    assert.equal(f.station.holds.length, 1);
    if (reason === 'low-memory') assert.equal(f.engine.requests.length, 0);
  });
}

test('default cadence is seeded 2-4 songs with no first-song slot and reports remaining songs', async t => {
  for (const [seed, target] of [[0, 2], [1, 3], [2, 4]]) {
    const context = baseContext(); context.config.seed = seed;
    const f = await fixture(t, { context }); await f.desk.configure({ minSongs: 2, maxSongs: 4 });
    f.desk.consider(context);
    assert.equal(f.desk.snapshot().nextSlot.afterSongs, target);
    assert.equal(f.desk.snapshot().nextSlot.remainingSongs, target - 1);
    assert.equal(f.station.holds.length, 0);
  }
});

test('a new playback session resets an almost-due counter across the full 2-4 song cadence', async t => {
  for (const target of [2, 3, 4]) {
    const f = await fixture(t, { context: { ...baseContext(), playbackSessionId: 'session-before' } });
    await f.desk.configure({ minSongs: target, maxSongs: target });
    for (let song = 0; song < target - 1; song++) {
      f.station.context = { ...f.station.context, playbackTrackId: `before-${song}`, current: { ...f.station.context.current, id: `before-${song}` } };
      f.desk.consider(f.station.context);
    }
    assert.equal(f.desk.snapshot().nextSlot.remainingSongs, 1);
    f.station.context = { ...f.station.context, playbackSessionId: 'session-after', playbackTrackId: 'after-0', current: { ...f.station.context.current, id: 'after-0' } };
    f.desk.consider(f.station.context);
    assert.equal(f.station.holds.length, 0, 'retuning never inherits the due counter on its first song');
    assert.equal(f.desk.snapshot().nextSlot.remainingSongs, target - 1);
    for (let song = 1; song < target; song++) {
      f.station.context = { ...f.station.context, playbackTrackId: `after-${song}`, current: { ...f.station.context.current, id: `after-${song}` } };
      f.desk.consider(f.station.context);
      assert.equal(f.station.holds.length, song === target - 1 ? 1 : 0);
    }
    assert.equal(f.desk.snapshot().introduction.state, 'preparing');
  }
});

test('fake contexts without a playback session ID retain cadence across ordinary song reports', async t => {
  const f = await fixture(t);
  assert.equal('playbackSessionId' in f.station.context, false);
  f.desk.consider(f.station.context);
  assert.equal(f.desk.snapshot().nextSlot.remainingSongs, 1);
  f.station.context = { ...f.station.context, playbackTrackId: 'another-song', current: { ...f.station.context.current, id: 'another-song' } };
  f.desk.consider(f.station.context);
  assert.equal(f.station.holds.length, 1);
  assert.equal(f.desk.snapshot().introduction.state, 'preparing');
});

test('automatic boundary marks done briefly, resets cadence and never speaks twice in a row', async t => {
  const f = await fixture(t, { autoGrant: true }); startSlot(f);
  await waitFor(() => f.desk.snapshot().introduction?.state === 'armed');
  const next = f.station.context.next;
  f.station.context = { ...f.station.context, current: next, playbackTrackId: next.id, next: { ...next, id: 'next-b' } };
  f.desk.consider(f.station.context);
  assert.equal(f.desk.snapshot().introduction.state, 'done');
  assert.equal(f.station.holds.length, 1);
  assert.equal(f.desk.snapshot().nextSlot.remainingSongs, 1);
  await delay(4100); assert.equal(f.desk.snapshot().introduction, null);
  f.station.context = { ...f.station.context, current: f.station.context.next, playbackTrackId: 'next-b', next: { ...next, id: 'next-c' } };
  f.desk.consider(f.station.context);
  await waitFor(() => f.station.releases === 2);
  assert.equal(f.desk.snapshot().introduction.state, 'armed');
});

for (const [label, change] of [
  ['pause', c => ({ ...c, playing: false })],
  ['skip', c => ({ ...c, playbackTrackId: 'other-song' })],
  ['retune', c => ({ ...c, stationId: 'other-station' })],
]) {
  test(`${label} withdraws an automatic pending hold`, async t => {
    const f = await fixture(t); startSlot(f);
    f.station.context = change(f.station.context); f.desk.consider(f.station.context);
    assert.equal(f.station.withdrawals, 1);
    assert.ok(!['preparing', 'armed'].includes(f.desk.snapshot().introduction?.state));
  });
}

test('pause during automatic synthesis aborts voice and releases the hold', async t => {
  const f = await fixture(t, { autoGrant: true });
  let rejectVoice;
  f.engine.run = function(request) { this.requests.push(request); return new Promise((resolve, reject) => { rejectVoice = reject; }); };
  f.engine.abort = async function() { this.aborts++; rejectVoice?.(new Error('aborted')); };
  startSlot(f); await waitFor(() => f.engine.requests.length === 1);
  f.station.context.playing = false; f.desk.consider(f.station.context);
  await waitFor(() => f.station.releases === 1);
  assert.equal(f.engine.aborts, 1);
});

test('Settings audition remains available and cannot replace an active automatic slot', async t => {
  const f = await fixture(t, { autoGrant: true }); startSlot(f);
  await assert.rejects(f.desk.preview({ djId: 'serena', style: 'relax' }), { status: 409 });
  await waitFor(() => f.station.releases === 1);
  const audition = await f.desk.preview({ djId: 'serena', style: 'relax' });
  await waitFor(() => f.desk.snapshot().preview?.status === 'ready');
  assert.equal(f.desk.snapshot().preview.id, audition.id, 'the snapshot reports the request id the POST returned');
  assert.match(f.desk.snapshot().preview.audioId, /^[a-f0-9]{64}$/, 'audio is keyed per DJ and style, not per request');
  assert.equal(f.engine.requests.length, 2);
});

test('removed manual DJ endpoint rejects POST and SSE exposes only automatic introduction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-api-'));
  const ui = join(root, 'ui'); const { mkdir } = await import('node:fs/promises');
  await mkdir(ui); await writeFile(join(ui, 'index.html'), '<!doctype html>');
  const station = Object.assign(new EventEmitter(), { snapshot: () => ({ stationId: 'station-a', tracks: [] }) });
  const introduction = { stationId: 'station-a', songId: 'current-a', nextSongId: 'next-a', state: 'preparing' };
  const dj = { settings: async () => ({ enabled: true, ready: true }), snapshot: () => ({ enabled: true, introduction }) };
  const server = createApp({ station, uiDir: ui, dj }); const address = await listen(server);
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); });
  const response = await fetch(`${address}/api/dj/now`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stationId: 'station-a' }) });
  assert.equal(response.status, 405);
  assert.equal(typeof DjDesk.prototype.requestNow, 'undefined');
  const controller = new AbortController(); t.after(() => controller.abort());
  const events = await fetch(`${address}/api/events`, { signal: controller.signal });
  const { value } = await events.body.getReader().read();
  const snapshot = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''));
  assert.deepEqual(snapshot.dj.introduction, introduction);
  assert.equal('now' in snapshot.dj, false); controller.abort();
});
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

test('writer warmth follows health readiness, stop and unexpected child exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-writer-warm-'));
  const script = join(root, 'writer.mjs');
  const port = await freePort();
  await writeFile(script, `
import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer(async (req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  if (req.url === '/exit') { res.end('bye'); setTimeout(() => process.exit(0), 10); return; }
  for await (const chunk of req) {}
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: 'A fake writer line.' } }] }));
}).listen(port, '127.0.0.1');
`);
  const writer = new DjLlm({ command: process.execPath, args: [script], port, modelDir: root });
  t.after(async () => { await writer.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(writer.isWarm(), false);
  assert.equal(await writer.complete({ system: 'test', prompt: 'test' }), 'A fake writer line.');
  assert.equal(writer.isWarm(), true);
  const stopping = writer.stop();
  assert.equal(writer.isWarm(), false, 'warmth clears as soon as stop starts');
  await stopping;
  await writer.complete({ system: 'test', prompt: 'test again' });
  assert.equal(writer.isWarm(), true);
  await fetch(`http://127.0.0.1:${port}/exit`);
  await waitFor(() => !writer.isWarm());
});

test('engine warmth needs a successful same-model request and clears on failure, stop or exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-engine-warm-'));
  const binary = join(root, 'engine.mjs');
  await writeFile(binary, `#!${process.execPath}
import http from 'node:http';
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
http.createServer(async (req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const { request } = JSON.parse(body);
  if (request.fail) { res.writeHead(500); res.end('fake failure'); return; }
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true }));
  if (request.exit) setTimeout(() => process.exit(0), 10);
}).listen(config.port, '127.0.0.1');
`);
  await chmod(binary, 0o755);
  const engine = new AudioCppEngine({ binary, dataDir: root, modelDir: root, modelFile: 'fake.gguf', vaeFile: 'fake.gguf', modelSpecs: root, tts: { modelDir: root } });
  t.after(async () => { await engine.stop(); await rm(root, { recursive: true, force: true }); });
  assert.equal(engine.isWarm('qwen3tts'), false);
  await engine.run({}, { model: 'qwen3tts' });
  assert.equal(engine.isWarm('qwen3tts'), true);
  assert.equal(engine.isWarm('yue2'), false);
  await engine.run({}, { model: 'yue2' });
  assert.equal(engine.isWarm('qwen3tts'), false);
  assert.equal(engine.isWarm('yue2'), true);
  await assert.rejects(engine.run({ fail: true }, { model: 'yue2' }), /500/);
  assert.equal(engine.isWarm('yue2'), false);
  await engine.run({}, { model: 'qwen3tts' });
  await engine.stop();
  assert.equal(engine.isWarm('qwen3tts'), false);
  await engine.run({ exit: true }, { model: 'qwen3tts' });
  await waitFor(() => !engine.isWarm('qwen3tts'));
});

test('the LLM retries once, then accepts a valid retry result', async (t) => {
  const f = await fixture(t, { autoGrant: true, memory: 20 * GiB });
  const responseScript = join(f.root, 'fake-llm.mjs');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(responseScript, `
import http from 'node:http';
const arg = process.argv.indexOf('--port'); const port = Number(process.argv[arg + 1]); let calls = 0;
const outputs = ['Blue Hour, Open Window is delightful.', 'Coming up is Blue Hour, Open Window, with a calm reflective mood and warm piano in the blend. It has good timing, unlike my last joke. Here it is, so take a moment, get comfortable, and enjoy the sound as it unfolds.'];
http.createServer(async (req, res) => { if (req.url === '/health') { res.end('ok'); return; } let body=''; for await (const chunk of req) body += chunk; calls++; res.setHeader('content-type','application/json'); res.end(JSON.stringify({choices:[{message:{content:outputs[Math.min(calls-1, outputs.length-1)]}}]})); }).listen(port, '127.0.0.1');
`));
  const probe = await import('node:net').then(({ createServer }) => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }));
  await f.desk.configure({ runtime: { command: process.execPath, args: [responseScript], port: probe } });
  startSlot(f);
  await waitFor(() => f.desk.snapshot().introduction?.state === 'armed');
  assert.equal(f.desk.snapshot().lastLine.source, 'llm');
  assert.equal(f.engine.requests.length, 1);
  assert.equal(f.station.releases, 1);
});

test('two invalid LLM responses use the style template fallback', async (t) => {
  const f = await fixture(t, { autoGrant: true, memory: 20 * GiB });
  const responseScript = join(f.root, 'fake-llm-invalid.mjs');
  const outputs = JSON.stringify(['Blue Hour is calm.', 'Still not enough words to pass the DJ script validator.']);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(responseScript, `
import http from 'node:http';
const arg = process.argv.indexOf('--port'); const port = Number(process.argv[arg + 1]); const outputs = ${outputs}; let calls = 0;
http.createServer(async (req, res) => { if (req.url === '/health') { res.end('ok'); return; } if (req.url === '/calls') { res.end(String(calls)); return; } let body=''; for await (const chunk of req) body += chunk; calls++; res.setHeader('content-type','application/json'); res.end(JSON.stringify({choices:[{message:{content:outputs[Math.min(calls-1, outputs.length-1)]}}]})); }).listen(port, '127.0.0.1');
`);
  const port = await import('node:net').then(({ createServer }) => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); }));
  await f.desk.configure({ runtime: { command: process.execPath, args: [responseScript], port } });
  startSlot(f);
  await waitFor(() => f.desk.snapshot().introduction?.state === 'armed');
  assert.equal(f.desk.snapshot().lastLine.source, 'template');
  assert.equal(f.desk.snapshot().tier, 2);
});

