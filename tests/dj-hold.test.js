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
function wavBase64() {
  const byteRate = 192_000, size = 2 * byteRate, wav = Buffer.alloc(44 + size);
  wav.write('RIFF', 0, 'latin1'); wav.writeUInt32LE(36 + size, 4); wav.write('WAVE', 8, 'latin1'); wav.write('fmt ', 12, 'latin1');
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(byteRate, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36, 'latin1'); wav.writeUInt32LE(size, 40);
  for (let i = 0; i < size / 2; i += 1) wav.writeInt16LE(Math.round(Math.sin(i / 11) * 8000), 44 + i * 2);
  return wav.toString('base64');
}

class PendingEngine {
  requests = [];
  pending = [];
  run(request) { this.requests.push(request); return new Promise((resolve, reject) => this.pending.push({ resolve, reject })); }
  finish() { this.pending.shift()?.resolve({ audio: wavBase64() }); }
  async abort() { for (const job of this.pending.splice(0)) job.reject(new Error('aborted')); }
  async stop() {}
}

async function waitFor(predicate) {
  const until = Date.now() + 1500;
  while (Date.now() < until) { if (predicate()) return; await delay(10); }
  assert.fail('hold queue did not advance');
}

test('a pending song job is never interrupted; DJ hold wins over a waiting News hold after it finishes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-hold-'));
  const engine = new PendingEngine();
  const library = new Library(root); await library.load();
  const station = new RadioStation({ engine, library, stations: new StationStore(join(root, 'stations.json')) });
  t.after(async () => { await station.close(); await rm(root, { recursive: true, force: true }); });
  await station.tune(config);
  await waitFor(() => engine.requests.length === 1);
  const granted = [];
  let releaseNews, releaseDj;
  station.requestHold((release) => { granted.push('news'); releaseNews = release; }, { priority: 'news', expiresAt: Date.now() + 5000 });
  station.requestHold((release) => { granted.push('dj'); releaseDj = release; }, { priority: 'dj', expiresAt: Date.now() + 5000 });
  assert.deepEqual(granted, [], 'neither hold cancels or jumps the running song');
  assert.equal(engine.requests.length, 1);
  engine.finish();
  await waitFor(() => granted.length === 1);
  assert.deepEqual(granted, ['dj']);
  releaseDj();
  await waitFor(() => granted.length === 2);
  assert.deepEqual(granted, ['dj', 'news']);
  releaseNews();
});
