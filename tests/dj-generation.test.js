import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { writeWav } from '../src/engine/wav.js';
import { Library, bucketFor } from '../src/radio/library.js';
import { StationStore } from '../src/radio/stations.js';
import { RadioStation } from '../src/radio/station.js';
import { DjDesk } from '../src/radio/dj/dj-desk.js';
import { clipToArm, djMayStart } from '../src/ui/assets/dj-flow.js';
import { planTalkOver, decideTalkOver } from '../src/ui/assets/dj-audio.js';

const config = { mix: { Pop: 100 }, energy: 25, bpm: 80, dark: 30, melody: true, mood: 'Sunday light', seed: 7 };
const wav = writeWav({ sampleRate: 24000, samples: [Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 13) * 0.1)] });

class PendingEngine {
  requests = [];
  pending = [];
  stops = 0;
  aborts = 0;
  run(request, options) {
    this.requests.push({ request, options });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  finish() { this.pending.shift().resolve({ audio: wav.toString('base64') }); }
  async stop() { this.stops += 1; }
  async abort() {
    this.aborts += 1;
    for (const job of this.pending.splice(0)) job.reject(new Error('aborted'));
  }
}

async function waitFor(predicate) {
  const until = Date.now() + 2500;
  while (Date.now() < until) { if (predicate()) return; await delay(5); }
  assert.fail('DJ integration state did not settle');
}

async function fixture(t, { generation = false, idleUnloadMs = 60_000, songDurationSec = 180 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-generation-'));
  const engine = new PendingEngine();
  const library = new Library(join(root, 'library')); await library.load();
  const stations = new StationStore(join(root, 'stations.json')); await stations.load();
  const saved = await stations.open(config, {});
  await stations.setDj(saved.id, 'serena');
  for (let i = 0; i < 4; i += 1) {
    // Scheduler duration is metadata; the small WAV is a valid offline audio fixture.
    await library.add({ id: `song-${i}`, title: `Sunday Song ${i}`, stationId: saved.id, bucket: bucketFor(config), generation: config, durationSec: songDurationSec, createdAt: new Date(i * 1000).toISOString() }, wav);
  }
  const station = new RadioStation({ engine, library, stations, idleUnloadMs, tickMs: 5 });
  const setup = { snapshot: async () => ({ ready: true, status: 'ready', directory: root }) };
  const desk = new DjDesk({ dataDir: root, station, engine, modelSetup: setup, voiceSetup: setup, freeMemory: async () => 11 * 1024 ** 3 });
  await desk.load();
  await desk.configure({ enabled: true, minSongs: 2, maxSongs: 2 });
  t.after(async () => { await station.close(); await desk.close(); await rm(root, { recursive: true, force: true }); });
  await station.tune(config, { fromLibrary: true, stationId: saved.id, paused: true });
  if (!generation) await station.setGenerationEnabled(false);
  station.attachDJ(desk);
  const tracks = station.snapshot().tracks.filter((track) => track.status === 'ready');
  await station.setPlayback({ trackId: tracks[0].id, positionSec: 0, playing: true });
  return { station, desk, engine, tracks, stationId: saved.id };
}

function assertOnlyVoiceRequests(engine, count = 1) {
  assert.equal(engine.requests.length, count);
  assert.ok(engine.requests.every(({ request, options }) => typeof request.text === 'string' && options?.model === 'qwen3tts'), 'no song generation uses the engine');
}

test('retuning a real station changes its playback session and skips the first automatic DJ slot', async (t) => {
  const f = await fixture(t);
  const previous = f.station.djContext();
  assert.equal(typeof previous.playbackSessionId, 'string');
  assert.equal(f.desk.snapshot().nextSlot.remainingSongs, 1);
  const sessionId = await f.station.tune(config, { fromLibrary: true, stationId: f.stationId, paused: true });
  await f.station.setGenerationEnabled(false);
  const first = f.station.snapshot().tracks.find((track) => track.status === 'ready' && track.id !== previous.current.id);
  await f.station.setPlayback({ trackId: first.id, positionSec: 0, playing: true });
  const current = f.station.djContext();
  assert.equal(current.playbackSessionId, sessionId);
  assert.notEqual(current.playbackSessionId, previous.playbackSessionId);
  await delay(30);
  assert.equal(f.engine.requests.length, 0);
  assert.equal(f.desk.snapshot().nextSlot.remainingSongs, 1);
  await f.station.setPlayback({ trackId: current.next.id, positionSec: 0, playing: true });
  await waitFor(() => f.engine.pending.length === 1);
  f.engine.finish();
  await waitFor(() => f.desk.snapshot().introduction?.state === 'armed');
  assertOnlyVoiceRequests(f.engine);
});

test('DJ context reserves song production only while song generation is enabled', async (t) => {
  const f = await fixture(t, { generation: true });
  const estimate = f.station.djContext().songEstimateSec;
  assert.equal(estimate, 130);
  await f.station.setGenerationEnabled(false);
  assert.equal(f.station.djContext().songEstimateSec, 0);
  await f.station.setGenerationEnabled(true);
  assert.equal(f.station.djContext().songEstimateSec, estimate);
  assert.equal(f.engine.requests.length, 0);
});

for (const generation of [false, true]) {
  test(`short library runway ${generation ? 'reserves song cost and skips' : 'produces an automatic introduction'} with generation ${generation ? 'on' : 'off'}`, async (t) => {
    const f = await fixture(t, { generation, songDurationSec: 60 });
    await f.station.setPlayback({ trackId: f.tracks[1].id, positionSec: 0, playing: true });
    const context = f.station.djContext();
    assert.ok(context.runwaySec > 179 && context.runwaySec <= 180);
    assert.equal(context.songEstimateSec, generation ? 130 : 0);
    if (generation) {
      assert.equal(f.desk.snapshot().introduction.reason, 'not-enough-time');
      assert.equal(f.engine.requests.length, 0);
    } else {
      await waitFor(() => f.engine.pending.length === 1);
      f.engine.finish();
      await waitFor(() => f.desk.snapshot().introduction?.state === 'armed');
      assertOnlyVoiceRequests(f.engine);
    }
  });
}

test('generation-off automatic introduction produces and arms the next library song for renderer tail playback', async (t) => {
  const f = await fixture(t);
  await f.station.setPlayback({ trackId: f.tracks[1].id, positionSec: 0, playing: true });
  const context = f.station.djContext();
  assert.equal('enabled' in context, false);
  assert.equal('generationEnabled' in context, false);
  assert.equal(context.next.source, 'library');
  await waitFor(() => f.engine.pending.length === 1);
  f.engine.finish();
  await waitFor(() => f.desk.snapshot().introduction?.state === 'armed');
  const clip = clipToArm({ dj: f.desk.snapshot(), stationIds: f.stationId, currentSongId: f.station.djContext().current.id, nextSongId: context.next.id });
  assert.ok(clip);
  const plan = planTalkOver({ songDurationSec: context.current.durationSec, clipDurationSec: clip.durationSec });
  assert.equal(djMayStart({ playing: context.playing, newsPlaying: false }), true);
  assert.deepEqual(decideTalkOver({ plan, position: plan.startAt }), { action: 'start' });
  assertOnlyVoiceRequests(f.engine);
});

test('automatic DJ slots produce for ready library songs while generation is off', async (t) => {
  const f = await fixture(t);
  assert.equal(f.engine.requests.length, 0, 'first song has no automatic DJ');
  await f.station.setPlayback({ trackId: f.tracks[1].id, positionSec: 0, playing: true });
  const nextId = f.station.djContext().next.id;
  await waitFor(() => f.engine.pending.length === 1);
  f.engine.finish();
  await waitFor(() => f.desk.snapshot().last?.status === 'ready');
  assert.equal(f.desk.snapshot().last.mode, 'slot');
  assert.equal(f.desk.snapshot().lastLine.songId, nextId);
  assert.ok(clipToArm({ dj: f.desk.snapshot(), stationIds: f.stationId, currentSongId: f.station.djContext().current.id, nextSongId: nextId }));
  assertOnlyVoiceRequests(f.engine);
});

test('turning generation off preserves a pending automatic DJ hold', async (t) => {
  const f = await fixture(t, { generation: true });
  const release = f.station.tryHold();
  assert.equal(typeof release, 'function');
  await f.station.setPlayback({ trackId: f.tracks[1].id, positionSec: 0, playing: true });
  assert.equal(f.engine.requests.length, 0, 'DJ waits behind the existing hold');
  await f.station.setGenerationEnabled(false);
  release();
  await waitFor(() => f.engine.pending.length === 1);
  f.engine.finish();
  await waitFor(() => f.desk.snapshot().last?.status === 'ready');
  assert.equal(f.desk.snapshot().last.mode, 'slot');
  assert.equal(f.engine.aborts, 0);
  assertOnlyVoiceRequests(f.engine);
});

test('turning generation off preserves running and armed automatic introduction; holds defer idle unload until release', async (t) => {
  const idleUnloadMs = 80; // Inject a short equivalent of the production 60-second idle timeout.
  const f = await fixture(t, { generation: true, idleUnloadMs });
  await f.station.setPlayback({ trackId: f.tracks[1].id, positionSec: 0, playing: true });
  await waitFor(() => f.engine.pending.length === 1);
  const stops = f.engine.stops;
  await f.station.setGenerationEnabled(false);
  assert.equal(f.desk.snapshot().introduction.state, 'preparing');
  await delay(idleUnloadMs * 2);
  assert.equal(f.engine.stops, stops, 'the held engine cannot unload during DJ synthesis');
  assert.equal(f.engine.aborts, 0);
  f.engine.finish();
  await waitFor(() => f.desk.snapshot().introduction?.state === 'armed' && f.desk.snapshot().last?.status === 'ready');
  assert.equal(f.engine.stops, stops, 'releasing the DJ hold starts a fresh idle period');
  await waitFor(() => f.engine.stops > stops);
  assert.equal(f.desk.snapshot().introduction.state, 'armed', 'unloading the engine preserves the completed clip');
  await f.station.setGenerationEnabled(false);
  assert.equal(f.desk.snapshot().introduction.state, 'armed');
  assertOnlyVoiceRequests(f.engine);
});

test('paused library playback blocks automatic introductions with generation off', async (t) => {
  const f = await fixture(t);
  await f.station.setPlayback({ trackId: f.tracks[1].id, positionSec: 0, playing: false });
  assert.equal(f.desk.snapshot().introduction?.reason, 'not-playing');
  await delay(30);
  assert.equal(f.engine.requests.length, 0);
  assert.equal(djMayStart({ playing: false, newsPlaying: false }), false);
});

test('a due song retains priority ahead of a pending automatic DJ hold', async (t) => {
  const f = await fixture(t, { generation: true });
  const queued = f.station.snapshot().tracks.find((track) => track.status === 'queued');
  assert.ok(queued);
  await f.station.generateNow(queued.id);
  assert.equal(f.engine.requests.length, 1);
  assert.equal(f.engine.requests[0].request.text, undefined);
  await f.station.setPlayback({ trackId: f.tracks[1].id, positionSec: 0, playing: true });
  assert.equal(f.desk.snapshot().introduction.state, 'preparing');
  assert.equal(f.engine.requests.length, 1, 'the automatic DJ cannot interrupt a song');
  assert.equal(f.engine.aborts, 0);
  f.engine.finish();
  await waitFor(() => f.engine.requests.length === 2);
  assert.equal(f.engine.requests[1].options.model, 'qwen3tts');
  f.engine.finish();
  await waitFor(() => f.desk.snapshot().introduction?.state === 'armed');
});

test('global DJ switch-off withdraws a pending automatic slot without aborting the held engine', async (t) => {
  const f = await fixture(t);
  const release = f.station.tryHold();
  assert.equal(typeof release, 'function');
  await f.station.setPlayback({ trackId: f.tracks[1].id, positionSec: 0, playing: true });
  assert.equal(f.engine.requests.length, 0, 'the automatic slot waits behind an existing hold');
  await f.desk.configure({ enabled: false });
  assert.equal(f.engine.aborts, 0, 'switch-off must not abort the unrelated hold owner');
  assert.equal(f.station.tryHold(), null, 'the unrelated hold remains owned');
  release();
  await delay(30);
  assert.equal(f.engine.requests.length, 0, 'the withdrawn slot never starts after the engine becomes free');
  assert.equal(f.desk.snapshot().enabled, false);
  assert.equal(f.desk.snapshot().introduction, null);
  assert.equal(f.desk.snapshot().nextSlot, null);
  const releaseAfter = f.station.tryHold();
  assert.equal(typeof releaseAfter, 'function', 'the cancelled waiter leaves no held engine');
  releaseAfter();
});

for (const action of ['global switch-off', 'station None choice']) {
  test(`${action} awaits active DJ cancellation and releases the engine hold`, async (t) => {
    const f = await fixture(t);
    await f.station.setPlayback({ trackId: f.tracks[1].id, positionSec: 0, playing: true });
    await waitFor(() => f.engine.pending.length === 1);
    const abort = f.engine.abort.bind(f.engine);
    let finishAbort;
    let abortStarted = false;
    f.engine.abort = async () => {
      abortStarted = true;
      await new Promise((resolve) => { finishAbort = resolve; });
      await abort();
    };
    let settled = false;
    const cancellation = f.desk.configure(action === 'global switch-off' ? { enabled: false } : { stationId: f.stationId, djId: null });
    cancellation.then(() => { settled = true; });
    try {
      await waitFor(() => abortStarted);
      assert.equal(settled, false, 'the settings operation waits for voice cancellation');
      assert.equal(f.station.tryHold(), null, 'the DJ retains its hold until voice cancellation completes');
    } finally {
      finishAbort?.();
      await cancellation;
    }
    const result = await cancellation;
    assert.equal(f.engine.aborts, 1);
    assert.equal(f.engine.pending.length, 0);
    assert.equal(f.desk.snapshot().lastLine, null, 'aborted voice work cannot arm a clip');
    assert.ok(!['preparing', 'armed'].includes(f.desk.snapshot().introduction?.state));
    if (action === 'global switch-off') {
      assert.equal(result.enabled, false);
      assert.equal(f.desk.snapshot().introduction, null);
    } else {
      assert.deepEqual(result, { stationId: f.stationId, dj: null, djChosen: true });
      assert.equal(f.station.djContext().djId, null);
      assert.equal(f.desk.snapshot().enabled, true, 'the station choice leaves the global switch on');
    }
    const release = f.station.tryHold();
    assert.equal(typeof release, 'function', 'cancellation releases the DJ hold before returning');
    release();
    await delay(30);
    assertOnlyVoiceRequests(f.engine);
  });
}

test('global DJ switch-off clears the armed introduction and blocks later slots', async (t) => {
  const f = await fixture(t);
  await f.station.setPlayback({ trackId: f.tracks[1].id, positionSec: 0, playing: true });
  await waitFor(() => f.engine.pending.length === 1);
  f.engine.finish();
  await waitFor(() => f.desk.snapshot().introduction?.state === 'armed' && f.desk.snapshot().last?.status === 'ready');
  assert.ok(f.desk.snapshot().lastLine);
  await f.desk.configure({ enabled: false });
  assert.equal(f.desk.snapshot().lastLine, null, 'switch-off clears the clip so a renderer cannot rearm it');
  assert.ok(!['preparing', 'armed'].includes(f.desk.snapshot().introduction?.state));
  assert.equal(f.desk.snapshot().introduction, null);
  assert.equal(f.desk.snapshot().enabled, false);
  assert.equal(f.engine.aborts, 0, 'a completed clip needs no engine abort');
  await f.station.setPlayback({ trackId: f.tracks[2].id, positionSec: 0, playing: true });
  await delay(30);
  assertOnlyVoiceRequests(f.engine);
});

test('station None clears the armed clip and blocks later automatic slots', async (t) => {
  const f = await fixture(t);
  await f.station.setPlayback({ trackId: f.tracks[1].id, positionSec: 0, playing: true });
  await waitFor(() => f.engine.pending.length === 1);
  f.engine.finish();
  await waitFor(() => f.desk.snapshot().introduction?.state === 'armed' && f.desk.snapshot().last?.status === 'ready');
  const nextSongId = f.station.djContext().next.id;
  assert.ok(clipToArm({ dj: f.desk.snapshot(), stationIds: f.stationId, currentSongId: f.station.djContext().current.id, nextSongId }));
  assert.deepEqual(await f.desk.configure({ stationId: f.stationId, djId: null }), { stationId: f.stationId, dj: null, djChosen: true });
  assert.equal(f.desk.snapshot().lastLine, null);
  assert.equal(clipToArm({ dj: f.desk.snapshot(), stationIds: f.stationId, currentSongId: f.station.djContext().current.id, nextSongId }), null, 'the stale clip cannot be rearmed');
  assert.ok(!['preparing', 'armed'].includes(f.desk.snapshot().introduction?.state));
  assert.equal(f.desk.snapshot().enabled, true);
  assert.equal(f.station.djContext().djId, null);
  assert.equal(f.engine.aborts, 0, 'a completed clip needs no engine abort');
  for (const track of f.tracks.slice(2)) {
    await f.station.setPlayback({ trackId: track.id, positionSec: 0, playing: true });
  }
  await delay(30);
  assert.equal(f.desk.snapshot().lastLine, null);
  assertOnlyVoiceRequests(f.engine);
});
