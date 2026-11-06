import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Library } from '../src/radio/library.js';
import { RadioStation } from '../src/radio/station.js';
import { StationStore } from '../src/radio/stations.js';

const config = { mix: { Jazz: 30, 'Lo-fi': 70 }, energy: 25, bpm: 80, dark: 30, melody: true, mood: 'Sunday light' };

class PendingEngine {
  requests = [];
  stops = 0;
  run(request) { this.requests.push(request); return new Promise(() => {}); }
  async abort() {}
  async stop() { this.stops += 1; }
}

async function radio(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-hold-'));
  const engine = new PendingEngine();
  const library = new Library(root);
  await library.load();
  const station = new RadioStation({ engine, library, stations: new StationStore(join(root, 'stations.json')), ...options });
  t.after(async () => { await station.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return { station, engine };
}

test('tryHold refuses while a song is composing and never interrupts it', async (t) => {
  const { station, engine } = await radio(t);
  await station.tune(config);
  await delay(20);
  assert.equal(engine.requests.length, 1);
  assert.equal(station.tryHold(), null);
  assert.equal(engine.requests.length, 1);
});

test('while the engine is held no song starts, and releasing lets the station go on', async (t) => {
  const { station, engine } = await radio(t);
  const release = station.tryHold();
  assert.equal(typeof release, 'function');
  assert.equal(station.tryHold(), null, 'only one holder at a time');
  await station.tune(config);
  await delay(30);
  assert.equal(engine.requests.length, 0, 'no song may start while the news uses the engine');
  release();
  release();
  await delay(30);
  assert.equal(engine.requests.length, 1);
});

test('the idle unload never stops the engine while the news is using it', async (t) => {
  const { station, engine } = await radio(t, { idleUnloadMs: 0, tickMs: 5 });
  await delay(40);
  assert.ok(engine.stops > 0, 'without a hold an idle engine is unloaded');
  const release = station.tryHold();
  assert.equal(typeof release, 'function');
  const stopsBefore = engine.stops;
  await delay(60);
  assert.equal(engine.stops, stopsBefore, 'the voice would be killed mid-sentence');
  release();
});

function wavBase64(seconds) {
  const byteRate = 192_000, size = seconds * byteRate, wav = Buffer.alloc(44 + size);
  wav.write('RIFF', 0, 'latin1'); wav.write('WAVE', 8, 'latin1'); wav.write('fmt ', 12, 'latin1');
  wav.writeUInt32LE(16, 16); wav.writeUInt32LE(byteRate, 28); wav.write('data', 36, 'latin1'); wav.writeUInt32LE(size, 40);
  return wav.toString('base64');
}

class ControlledEngine {
  requests = [];
  pending = [];
  run(request) { this.requests.push(request); return new Promise((resolve) => this.pending.push(resolve)); }
  finish() { this.pending.shift()({ audio: wavBase64(2) }); }
  async abort() {}
  async stop() {}
}

async function busyRadio(t) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-hold-wait-'));
  const engine = new ControlledEngine();
  const library = new Library(root);
  await library.load();
  const station = new RadioStation({ engine, library, stations: new StationStore(join(root, 'stations.json')), tickMs: 20 });
  t.after(async () => { await station.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return { station, engine };
}

/** A station that is playing, so the next song is due as soon as one ends. */
async function playingRadio(t) {
  const { station, engine } = await busyRadio(t);
  await station.tune(config);
  await delay(20);
  engine.finish();
  await delay(60);
  const [track] = station.snapshot().tracks;
  await station.setPlayback({ trackId: track.id, positionSec: 0, playing: true });
  await delay(80);
  assert.equal(engine.requests.length, 2, 'the next song is composing, as on a busy station');
  return { station, engine };
}

test('a waiting request gets the engine the moment a song ends, before the next song starts', async (t) => {
  const { station, engine } = await playingRadio(t);
  let granted = null;
  station.requestHold((release) => { granted = release; });
  assert.equal(granted, null, 'a running song is not interrupted');
  engine.finish();
  await delay(80);
  assert.equal(typeof granted, 'function', 'the engine was lent when the song ended');
  assert.equal(engine.requests.length, 2, 'the next song waits for the release');
  granted();
  await delay(80);
  assert.equal(engine.requests.length, 3, 'songs go on after the release');
});

test('a withdrawn request is never served', async (t) => {
  const { station, engine } = await playingRadio(t);
  let called = false;
  const withdraw = station.requestHold(() => { called = true; });
  withdraw();
  engine.finish();
  await delay(80);
  assert.equal(called, false);
  assert.equal(engine.requests.length, 3);
});

test('isPlaying follows what the listener is doing', async (t) => {
  const { station, engine } = await busyRadio(t);
  assert.equal(station.isPlaying(), false);
  await station.tune(config);
  engine.finish();
  await delay(60);
  const [track] = station.snapshot().tracks;
  assert.equal(station.isPlaying(), false);
  await station.setPlayback({ trackId: track.id, positionSec: 0, playing: true });
  assert.equal(station.isPlaying(), true);
  await station.setPlayback({ trackId: track.id, positionSec: 1, playing: false });
  assert.equal(station.isPlaying(), false);
});
