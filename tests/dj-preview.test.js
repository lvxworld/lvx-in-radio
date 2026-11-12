import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { writeWav } from '../src/engine/wav.js';
import { DjDesk } from '../src/radio/dj/dj-desk.js';

// Owner feedback fix1 item 1: a DJ voice preview (Settings -> DJs Listen, popover tiles) must
// work with DJs on or off, with or without a station playing, and fail with a clear error text.

const GiB = 1024 ** 3;
const lineWav = writeWav({ sampleRate: 24000, samples: [Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 13) * 0.1)] });

class Station {
  constructor({ stationId = 'station-a', playing = true } = {}) { this.stationId = stationId; this.playing = playing; this.holds = 0; this.releases = 0; }
  djContext() { return this.stationId ? { stationId: this.stationId, lux: false, playing: this.playing, djId: null, current: null, next: null, config: {} } : { stationId: null, lux: false }; }
  snapshot() { return { stationId: this.stationId, tracks: [] }; }
  requestHold(callback) { this.holds += 1; queueMicrotask(() => callback(() => { this.releases += 1; })); return () => {}; }
}

async function fixture(t, { enabled = true, station = new Station(), modelReady = true, voiceReady = true, memory = 11 * GiB, engineError = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-preview-'));
  const model = { ready: modelReady, async snapshot() { return { ready: this.ready, status: this.ready ? 'ready' : 'idle', directory: join(root, 'model') }; } };
  const voice = { ready: voiceReady, async snapshot() { return { ready: this.ready, status: this.ready ? 'ready' : 'idle' }; } };
  const engine = { requests: [], isWarm: () => false, async run(request) { this.requests.push(request); if (engineError) throw new Error(engineError); return { audio: lineWav.toString('base64') }; }, async abort() {}, async stop() {} };
  // Empty previews folder: these tests cover live synthesis; bundled clips are in dj-preview-bundle.test.js.
  const previewsDir = join(root, 'no-previews'); await mkdir(previewsDir);
  const dj = new DjDesk({ dataDir: root, station, engine, modelSetup: model, voiceSetup: voice, freeMemory: async () => memory, previewsDir });
  await dj.load();
  if (enabled && modelReady && voiceReady) await dj.configure({ enabled: true });
  t.after(async () => { await dj.close(); await rm(root, { recursive: true, force: true }); });
  return { dj, station, engine, root };
}

async function settled(dj, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const preview = dj.snapshot().preview;
    if (preview && ['ready', 'error'].includes(preview.status)) return preview;
    await delay(10);
  }
  assert.fail(`preview did not settle: ${JSON.stringify(dj.snapshot().preview)}`);
}

async function expectAudio(f, djId = 'sohee', style = 'relax') {
  const started = await f.dj.preview({ djId, style });
  assert.match(started.id, /^[a-f0-9]{64}$/);
  const preview = await settled(f.dj);
  assert.equal(preview.status, 'ready', `preview error: ${preview.error}`);
  assert.equal(preview.id, started.id);
  const path = f.dj.audioPath(preview.audioId);
  assert.ok(path, 'the preview exposes a playable audio id');
  assert.ok((await stat(path)).size > 44, 'the preview WAV is on disk');
  assert.equal(f.engine.requests.length, 1);
  assert.equal(f.station.releases, f.station.holds, 'the engine hold is released');
  return preview;
}

for (const [label, options] of [
  ['DJs on, station playing', {}],
  ['DJs off', { enabled: false }],
  ['DJs on, station paused', { station: new Station({ playing: false }) }],
  ['no station tuned', { station: new Station({ stationId: null }) }],
  ['low memory (template tier)', { memory: 9 * GiB }],
  ['script model missing (voice only)', { modelReady: false }],
]) {
  test(`DJ preview produces audio with ${label}`, async (t) => {
    await expectAudio(await fixture(t, options));
  });
}

test('every catalog DJ can be previewed in its own style', async (t) => {
  const f = await fixture(t, { enabled: false });
  const { djs } = await f.dj.catalog();
  for (const entry of djs) {
    const style = entry.bestFor?.[0] ?? 'generic';
    await f.dj.preview({ djId: entry.id, style });
    const preview = await settled(f.dj);
    assert.equal(preview.status, 'ready', `${entry.id}: ${preview.error}`);
  }
  assert.equal(f.engine.requests.length, djs.length);
});

test('a preview without the voice model is refused with a clear message', async (t) => {
  const f = await fixture(t, { voiceReady: false });
  await assert.rejects(f.dj.preview({ djId: 'sohee', style: 'relax' }), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /voice/i);
    return true;
  });
  assert.equal(f.engine.requests.length, 0);
});

test('a failing voice engine ends the preview in error with a readable text, not silence', async (t) => {
  const f = await fixture(t, { engineError: 'voice failed' });
  await f.dj.preview({ djId: 'sohee', style: 'relax' });
  const preview = await settled(f.dj);
  assert.equal(preview.status, 'error');
  assert.equal(typeof preview.error, 'string');
  assert.ok(preview.error.trim().length > 0, 'the error has words the UI can show');
  assert.equal(preview.audioId ?? null, null);
  assert.equal(f.station.releases, f.station.holds, 'the engine hold is released after a failure');
});

test('an unknown DJ or style is refused before any engine work', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.dj.preview({ djId: 'nobody', style: 'relax' }), RangeError);
  await assert.rejects(f.dj.preview({ djId: 'sohee', style: 'nope' }), RangeError);
  assert.equal(f.engine.requests.length, 0);
});

test('a second preview after the first one finishes works too', async (t) => {
  const f = await fixture(t);
  await f.dj.preview({ djId: 'sohee', style: 'relax' });
  assert.equal((await settled(f.dj)).status, 'ready');
  const second = await f.dj.preview({ djId: 'vivian', style: 'edm' });
  await delay(0);
  const preview = await settled(f.dj);
  assert.equal(preview.id, second.id);
  assert.equal(preview.status, 'ready');
});
