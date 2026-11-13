import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { writeWav } from '../src/engine/wav.js';
import { DjDesk } from '../src/radio/dj/dj-desk.js';
import { at, newsAfterBulletin, newsDesk } from './fixtures/news-clock.js';

// fix2 root cause (owner: "it says the DJ will speak, then it never does"): NewsDesk.isUrgent held
// the DJ off for 15 minutes every hour (:50 to :05) and for as long as a "news is ready" card stayed
// unanswered, and each news-urgent skip silently reset the cadence counter, so with 1-1 the slot
// was pushed past the song again and again. A cadence change also did not reach a tuned station.

const GiB = 1024 ** 3;
const lineWav = writeWav({ sampleRate: 24000, samples: [Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 13) * 0.1)] });

// --- (1) NewsDesk.isUrgent on a fake clock ---

test('News on, nothing made yet: not urgent at :30, urgent from :50 (lead of an hour not yet attempted)', async (t) => {
  const news = await newsDesk(t);
  news.state.active = false; // the radio is paused: nothing is produced, so only the clock decides
  await news.desk.configure({ enabled: true });
  news.desk.start();
  assert.equal(news.desk.isUrgent(), false, '10:30');
  await news.time.advanceTo(at(10, 49, 59));
  assert.equal(news.desk.isUrgent(), false, '10:49:59');
  await news.time.advanceTo(at(10, 50, 0));
  assert.equal(news.desk.isUrgent(), true, '10:50');
});

test('a bulletin made for 11:00 does not keep News urgent: 11:02 false, 11:30 false, 11:50 true again', async (t) => {
  const news = await newsAfterBulletin(t, 2);
  assert.ok(news.desk.snapshot().latest, 'the 11:00 bulletin was made');
  assert.equal(news.desk.snapshot().due, news.desk.snapshot().latest.id, 'its ready card is up and unanswered');
  assert.equal(news.desk.isUrgent(), false, '11:02 with the card unanswered (the old code said true until 11:05)');
  news.state.active = false; // keep the 12:00 production from starting, so only the lead window counts
  await news.time.advanceTo(at(11, 30));
  assert.equal(news.desk.isUrgent(), false, '11:30');
  assert.equal(news.desk.snapshot().due, news.desk.snapshot().latest.id, 'still unanswered at 11:30');
  await news.time.advanceTo(at(11, 50));
  assert.equal(news.desk.isUrgent(), true, '11:50: the 12:00 bulletin needs the engine');
});

test('News is urgent while producing, and false again once the bulletin is made', async (t) => {
  const news = await newsDesk(t);
  let open;
  news.state.renderGate = new Promise((resolve) => { open = resolve; });
  await news.desk.configure({ enabled: true });
  news.desk.start();
  await news.time.advanceTo(at(10, 50, 1));
  assert.equal(news.desk.snapshot().status, 'producing');
  assert.equal(news.desk.isUrgent(), true, 'producing');
  news.state.renderGate = null; open();
  await news.time.advanceTo(at(10, 52));
  assert.notEqual(news.desk.snapshot().status, 'producing');
  assert.equal(news.desk.isUrgent(), false, 'the 11:00 bulletin is made: the DJ may speak at 10:52');
});

test('News is urgent while waiting for the engine (scheduled or Make one now)', async (t) => {
  const news = await newsAfterBulletin(t, 2);
  assert.equal(news.desk.isUrgent(), false);
  news.state.canProduce = false; // a song is composing: Make one now must wait for the engine
  const made = news.desk.produceNow().catch(() => {});
  await delay(10);
  assert.ok(news.state.waiters.length >= 1, 'a hold request is waiting');
  assert.equal(news.desk.isUrgent(), true, 'manual wait');
  await news.desk.configure({ enabled: false });
  await made;
  assert.equal(news.desk.isUrgent(), false, 'News off is never urgent');

  const scheduled = await newsDesk(t);
  scheduled.state.canProduce = false;
  await scheduled.desk.configure({ enabled: true });
  scheduled.desk.start();
  await scheduled.time.advanceTo(at(10, 51));
  assert.ok(scheduled.state.waiters.length >= 1, 'the scheduled bulletin waits for the engine');
  assert.equal(scheduled.desk.isUrgent(), true, 'engine wait');
});

// --- (2)-(4) DjDesk gates ---

async function desk(t, { minSongs = 1, maxSongs = 1, newsUrgent } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-news-'));
  const track = (id, durationSec = 240) => ({ id, title: `Song ${id}`, status: 'ready', durationSec, generation: { mix: { Pop: 100 }, mood: '' } });
  const station = {
    context: null, holds: 0,
    djContext() { return this.context; },
    snapshot() { return { stationId: this.context?.stationId ?? null, tracks: [] }; },
    requestHold(callback) { this.holds += 1; queueMicrotask(() => callback(() => {})); return () => {}; },
  };
  const engine = { requests: [], isWarm: () => true, async run(request) { this.requests.push(request); return { audio: lineWav.toString('base64') }; }, async abort() {}, async stop() {} };
  const ready = { snapshot: async () => ({ ready: true, status: 'ready', directory: join(root, 'model') }) };
  const previewsDir = join(root, 'no-previews'); await mkdir(previewsDir);
  const flag = { urgent: false };
  const dj = new DjDesk({ dataDir: root, station, engine, modelSetup: ready, voiceSetup: ready, freeMemory: async () => 11 * GiB, isWarm: () => true, newsUrgent: newsUrgent ?? (() => flag.urgent), previewsDir });
  await dj.load();
  await dj.configure({ enabled: true, minSongs, maxSongs });
  t.after(async () => { await dj.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const songs = Array.from({ length: 8 }, (_, i) => track(`s${i + 1}`));
  /** The context while song n (1-based) plays on the LVX Pop session. */
  const playing = (n) => ({ stationId: 'lux-pop', stationName: 'LVX Pop', stationDescription: 'Bright', lux: true, live: false, playing: true, busy: false, djId: 'aiden', playbackSessionId: 'tune-1', current: songs[n - 1], next: songs[n], after: songs[n + 1], config: { mix: { Pop: 100 }, energy: 60, bpm: 110, dark: 20, mood: '' }, runwaySec: 240, songEstimateSec: 0, playbackTrackId: songs[n - 1].id });
  const consider = (context) => { station.context = context; dj.consider(context); };
  const log = async () => (await readFile(join(root, 'dj.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { dj, station, engine, flag, playing, consider, log, root };
}

async function waitFor(predicate, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (predicate()) return true; await delay(10); }
  return false;
}
const intro = (d) => d.dj.snapshot().introduction ?? null;

test('a news-urgent skip keeps the slot due: the DJ speaks on the same song as soon as News lets go', async (t) => {
  const d = await desk(t);
  d.flag.urgent = true;
  d.consider(d.playing(1));
  await delay(20);
  assert.equal(intro(d).state, 'refused');
  assert.equal(intro(d).reason, 'news-urgent');
  assert.equal(d.engine.requests.length, 0);
  assert.equal(d.dj.snapshot().nextSlot.remainingSongs, 0, 'still due: the skip did not reset the counter');
  d.consider(d.playing(1)); // a progress report while News is still busy
  await delay(20);
  assert.equal(d.engine.requests.length, 0);
  d.flag.urgent = false;
  d.consider(d.playing(1)); // the next report on the SAME song, News done
  assert.ok(await waitFor(() => intro(d)?.state === 'armed'), `armed after News: ${JSON.stringify(intro(d))}`);
  assert.equal(intro(d).songId, 's1');
  assert.equal(intro(d).nextSongId, 's2');
});

test('a skip writes one dj.log line per song and reason, with the gate values', async (t) => {
  const d = await desk(t);
  d.flag.urgent = true;
  for (let i = 0; i < 4; i++) d.consider(d.playing(1));
  await delay(50);
  let skips = (await d.log()).filter((line) => line.status === 'skipped');
  assert.equal(skips.length, 1, JSON.stringify(skips));
  const [skip] = skips;
  assert.equal(skip.reason, 'news-urgent');
  assert.equal(skip.songId, 's1');
  assert.equal(skip.stationId, 'lux-pop');
  assert.equal(skip.mode, 'slot');
  for (const field of ['songsSince', 'due', 'runwaySec', 'warm', 'next', 'lux']) assert.ok(field in skip, `the line has ${field}`);
  assert.equal(skip.songsSince, 1);
  // A new song with the same reason is logged again; the same song with the same reason is not.
  for (let i = 0; i < 3; i++) d.consider(d.playing(2));
  await delay(50);
  skips = (await d.log()).filter((line) => line.status === 'skipped');
  assert.deepEqual(skips.map((line) => `${line.songId}:${line.reason}`), ['s1:news-urgent', 's2:news-urgent']);
});

test('a not-enough-time skip is logged too, and it starts the cadence over', async (t) => {
  const d = await desk(t);
  // A listener station (Lux would aim at the next song instead): one second left is not enough.
  d.consider({ ...d.playing(1), stationId: 'listener-1', lux: false, runwaySec: 1 });
  await delay(50);
  const skips = (await d.log()).filter((line) => line.status === 'skipped');
  assert.deepEqual(skips.map((line) => line.reason), ['not-enough-time']);
  assert.equal(skips[0].runwaySec, 1);
  d.consider({ ...d.playing(1), stationId: 'listener-1', lux: false, runwaySec: 1 });
  assert.equal(d.dj.snapshot().nextSlot.remainingSongs, 1, 'unlike news-urgent, a refused slot waits for the next song');
});

test('changing the cadence while tuned retargets the station on air', async (t) => {
  const d = await desk(t, { minSongs: 4, maxSongs: 4 });
  d.consider(d.playing(1));
  assert.equal(d.dj.snapshot().nextSlot.afterSongs, 4);
  d.consider(d.playing(2));
  await delay(20);
  assert.equal(d.engine.requests.length, 0, 'not due at song 2 with 4-4');
  await d.dj.configure({ minSongs: 1, maxSongs: 1 });
  d.consider(d.playing(2)); // the next progress report on the same song
  assert.equal(d.dj.snapshot().nextSlot.afterSongs, 1);
  assert.equal(d.dj.snapshot().nextSlot.remainingSongs, 0);
  assert.ok(await waitFor(() => intro(d)?.state === 'armed'), 'the new 1-1 cadence speaks on song 2 without a retune');
  // After that break, 1-1 means every song.
  d.consider(d.playing(3));
  assert.equal(d.dj.snapshot().nextSlot.afterSongs, 1);
  await d.dj.configure({ minSongs: 3, maxSongs: 3 });
  d.consider(d.playing(3));
  assert.equal(d.dj.snapshot().nextSlot.afterSongs, 3, 'raising the cadence also reaches the station on air');
});

test('the 1-1 DJ is not blocked by a real NewsDesk at 11:02 with the ready card unanswered', async (t) => {
  const news = await newsAfterBulletin(t, 2);
  const d = await desk(t, { newsUrgent: () => news.desk.isUrgent() });
  d.consider(d.playing(1));
  assert.ok(await waitFor(() => intro(d)?.state === 'armed'), `armed at 11:02: ${JSON.stringify(intro(d))}`);
});
