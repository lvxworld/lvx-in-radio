import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { EngineAbortedError, stopStaleEngine } from '../src/engine/audiocpp.js';
import { engineAvailability, ModelMissingError } from '../src/engine/availability.js';
import { wavDurationSeconds } from '../src/engine/wav.js';
import { bucketFor, Library } from '../src/radio/library.js';
import { muteVocals } from '../src/radio/instrumental.js';
import { parseGpuPercent } from '../src/engine/gpu.js';
import { loadConfig } from '../src/config.js';
import { startRadio } from '../src/start.js';
import { LuxCatalog, parseManifest, RESERVED_FREQUENCIES } from '../src/radio/lux-catalog.js';
import { syncFeed } from '../src/radio/lux-feed.js';
import { RadioStation } from '../src/radio/station.js';
import { StationStore } from '../src/radio/stations.js';
import { decodeCode, encodeCode } from '../src/ui/assets/lvx-code.js';
import { answerFrom, createDeck, tempoFromTaps } from '../src/ui/assets/signal-game.js';
import { buildStyle, GENRES } from '../src/radio/style.js';
import { createApp, listen } from '../src/server/app.js';

const config = { mix: { Jazz: 30, 'Lo-fi': 70 }, energy: 25, bpm: 80, dark: 30, melody: true, mood: 'Sunday light' };

function wavBase64(seconds) {
  const byteRate = 192_000;
  const size = seconds * byteRate;
  const wav = Buffer.alloc(44 + size);
  wav.write('RIFF', 0, 'latin1');
  wav.write('WAVE', 8, 'latin1');
  wav.write('fmt ', 12, 'latin1');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt32LE(byteRate, 28);
  wav.write('data', 36, 'latin1');
  wav.writeUInt32LE(size, 40);
  return wav.toString('base64');
}

/** Engine double whose requests finish only when the test says so. */
class FakeEngine {
  requests = [];
  pending = [];
  aborts = 0;
  stops = 0;

  run(request) {
    this.requests.push(request);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  finish(result = { audio: wavBase64(2) }) {
    this.pending.shift().resolve(result);
  }

  fail(message = 'engine failure') {
    this.pending.shift().reject(new Error(message));
  }

  async abort() {
    this.aborts += 1;
    for (const { reject } of this.pending.splice(0)) reject(new EngineAbortedError());
  }

  async stop() {
    this.stops += 1;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const statuses = (station) => station.snapshot().tracks.map((track) => track.status);

let root;
let engine;
let library;
let station;
let stations;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lvx-station-'));
  engine = new FakeEngine();
  library = new Library(root);
  await library.load();
  stations = new StationStore(join(root, 'stations.json'));
  station = new RadioStation({ engine, library, stations });
});

afterEach(async () => {
  await station.close();
  await rm(root, { recursive: true, force: true });
});

/** Tunes in and starts listening to the first finished song. */
async function goOnAir(seconds = 2) {
  await station.tune(config);
  engine.finish({ audio: wavBase64(seconds) });
  await settle();
  const [first] = station.snapshot().tracks;
  await station.setPlayback({ trackId: first.id, positionSec: 0, playing: true });
  return first;
}

async function seedLibrary(count, changes = {}) {
  const songs = [];
  for (let index = 0; index < count; index += 1) {
    const id = `seed-${index}`;
    songs.push(
      await library.add(
        {
          id,
          title: id,
          bucket: bucketFor(config),
          generation: config,
          durationSec: 300,
          truncated: false,
          createdAt: new Date(2026, 0, index + 1).toISOString(),
          ...changes,
        },
        Buffer.from('wav'),
      ),
    );
  }
  return songs;
}

test('the mix percentages decide the genre line and the instruments', () => {
  const style = buildStyle(config);
  assert.ok(style.startsWith('English, instrumental, lo-fi with jazz influences, Sunday light, 80 BPM'));
  const lofi = ['dusty electric piano', 'soft tape-saturated drums', 'mellow nylon guitar', 'vinyl crackle'];
  assert.ok(lofi.every((sound) => style.includes(sound)), 'seventy percent earns four of six sounds');
  assert.ok(style.includes('brushed drums') && !style.includes('muted trumpet'), 'thirty percent earns two');
});

test('dance genres use a dark cinematic melodic techno sound', () => {
  const style = buildStyle({ ...config, mix: { EDM: 50, Techno: 50 }, energy: 85, bpm: 124, dark: 80 });
  assert.match(style, /melodic techno, dark progressive house, cinematic/);
  assert.match(style, /pulsing rolling bassline/);
  assert.match(style, /massive festival drop/);
  assert.match(style, /polished club master$/);
  assert.equal(style.match(/four-on-the-floor kick/g).length, 1, 'a shared sound is named once');
});

test('balanced genres blend and small ones become hints', () => {
  assert.match(buildStyle({ ...config, mix: { Pop: 50, Rock: 50 } }), /, pop rock,/);
  assert.match(buildStyle({ ...config, mix: { EDM: 45, 'Hip-hop': 40, Metal: 15 } }), /melodic techno, hip-hop with hints of metal/);
});

test('every style prompt stays between a useful and an excessive length', () => {
  const names = GENRES;
  for (const first of names) {
    for (const second of names) {
      const mix = first === second ? { [first]: 100 } : { [first]: 60, [second]: 40 };
      const words = buildStyle({ ...config, mix, scenario: 'Relax', mood: '' }).split(/\s+/).length;
      assert.ok(words >= 18 && words <= 47, `${first}/${second} has ${words} words`);
    }
  }
});

test('tuning game answers reach the prompt, and unknown values are refused', async () => {
  const style = buildStyle({ ...config, flavors: ['techno-acid', 'lofi-tape', 'jazz-smoky'], hint: 'Techno' });
  assert.match(style, /squelching acid lines, warped old tape, a touch of dark progressive house/);
  assert.ok(!style.includes('smoky'), 'only the two latest flavors are used');
  assert.ok(!buildStyle({ ...config, hint: 'Jazz' }).includes('a touch of'), 'a genre in the mix needs no hint');
  await assert.rejects(station.tune({ ...config, flavors: ['nope'] }), TypeError);
});

test('the tuning game only asks about the chosen genres and never runs out', () => {
  const deck = createDeck({ genres: [{ name: 'Jazz', color: '#ffffff' }, { name: 'Lo-fi', color: '#ffffff' }] });
  const rounds = Array.from({ length: 60 }, () => deck.next());
  assert.deepEqual([...new Set(rounds.map((round) => round.kind))].sort(), ['signal', 'tempo']);
  const answers = rounds.flatMap((round) => round.sides ?? []).map(answerFrom);
  const flavors = answers.filter((answer) => answer.type === 'flavor').map((answer) => answer.id);
  assert.ok(flavors.length > 20);
  assert.ok(flavors.every((id) => id.startsWith('jazz-') || id.startsWith('lofi-')));
  assert.ok(answers.some((answer) => answer.type === 'lead' && answer.genre === 'Lo-fi'));
  assert.ok(rounds.filter((round) => round.kind === 'tempo').every((round) => ['Jazz', 'Lo-fi'].includes(round.genre)));
});

test('a single genre gets its own rounds, and every answer is a valid prompt flavor', async () => {
  for (const name of GENRES) {
    const deck = createDeck({ genres: [{ name, color: '#ffffff' }] });
    const flavors = Array.from({ length: 8 }, () => deck.next())
      .flatMap((round) => round.sides ?? [])
      .map(answerFrom)
      .filter((answer) => answer.type === 'flavor')
      .map((answer) => answer.id);
    assert.ok(flavors.length >= 6, name);
    assert.doesNotThrow(() => buildStyle({ ...config, flavors }));
    await station.tune({ ...config, flavors });
  }
});

test('tapped intervals become a tempo', () => {
  assert.equal(tempoFromTaps([0, 500, 1000, 1500]), 120);
});

test('a Lux code carries every station setting', () => {
  const shared = {
    mix: { 'R&B': 40, 'Hip-hop': 35, 'Lo-fi': 25 },
    energy: 42,
    bpm: 91,
    dark: 70,
    melody: false,
    scenario: 'Road trip',
    flavors: ['neon', 'raw'],
    hint: 'Jazz',
    seed: 2 ** 46 + 5,
    mood: 'rain ~ on glass',
  };
  assert.deepEqual(decodeCode(encodeCode(shared)), shared);
});

test('a Lux code without options still decodes, and other text is refused', () => {
  const plain = decodeCode(encodeCode({ ...config, scenario: undefined, mood: '', seed: 7 }));
  assert.deepEqual(plain.flavors, []);
  assert.equal(plain.hint, undefined);
  assert.throws(() => decodeCode('https://example.com'), /Not a Lux code/);
  assert.throws(() => decodeCode('LVX1~Pop50~900~124~30~1~0~~~7~'), /Not a Lux code/);
});

test('a shared seed gives the same sequence of song seeds', async () => {
  await station.tune({ ...config, seed: 1000 });
  assert.equal(engine.requests[0].seed, 1000);
  engine.finish();
  await settle();
  const [first] = station.snapshot().tracks;
  await station.setPlayback({ trackId: first.id, positionSec: 0, playing: true });
  assert.equal(engine.requests[1].seed, 1001);
});

test('small control changes stay in the same bucket', () => {
  assert.equal(bucketFor(config), bucketFor({ ...config, mix: { Jazz: 40, 'Lo-fi': 60 }, energy: 10 }));
  assert.notEqual(bucketFor(config), bucketFor({ ...config, energy: 90 }));
  assert.notEqual(bucketFor(config), bucketFor({ ...config, mix: { Rock: 100 } }));
});

test('tune sends a Direct instrumental request with a length cap', async () => {
  await station.tune(config);
  const [request] = engine.requests;
  assert.equal(request.lyrics, '[instrumental]');
  assert.equal(request.options.cot, 'off');
  assert.ok(Number(request.options.semantic_max_tokens) > 0);
});

test('invalid configuration is refused before any generation', async () => {
  await assert.rejects(station.tune({ ...config, mix: { Polka: 100 } }), TypeError);
  assert.equal(engine.requests.length, 0);
});

test('a finished song records its real duration and truncation', async () => {
  await station.tune(config);
  engine.finish({ audio: wavBase64(2), artifacts: [{ id: 'semantic', meta: { truncated: 'true' } }] });
  await settle();
  const [track] = station.snapshot().tracks;
  assert.equal(track.durationSec, 2);
  assert.equal(track.truncated, true);
  assert.equal(wavDurationSeconds(await readFile(station.audioPath(track.id))), 2);
});

test('the first song on a new station is always new, even with a full library', async () => {
  await seedLibrary(3);
  await station.tune(config);
  const [first] = station.snapshot().tracks;
  assert.equal(first.source, 'new');
  assert.equal(first.status, 'generating');
});

test('a stored song plays second, giving the next new song time', async () => {
  await seedLibrary(1);
  await goOnAir();
  const [, second, third] = station.snapshot().tracks;
  assert.equal(second.id, 'seed-0');
  assert.equal(second.source, 'library');
  assert.equal(third.source, 'new');
});

test('returning to a station opens on a stored song without generating', async () => {
  await seedLibrary(2);
  await station.tune(config, { fromLibrary: true });
  const [first, second] = station.snapshot().tracks;
  assert.equal(first.source, 'library');
  assert.equal(first.status, 'ready');
  assert.equal(second.source, 'new');
  assert.equal(engine.requests.length, 0);
});

test('returning to a station with no stored songs generates one', async () => {
  await station.tune(config, { fromLibrary: true });
  assert.equal(station.snapshot().tracks[0].source, 'new');
  assert.equal(engine.requests.length, 1);
});

test('each new sound gets its own frequency and the same sound returns to it', async () => {
  await station.tune(config, { identity: { name: 'Low Tide', quote: 'Sunday' } });
  const first = station.snapshot().station;
  assert.equal(first.name, 'Low Tide');
  await station.tune({ ...config, seed: 9 });
  assert.equal(station.snapshot().station.id, first.id);
  assert.equal(station.snapshot().stations.length, 1);
  await station.tune({ ...config, energy: 90 }, { identity: { name: 'Red Line' } });
  const { station: second, stations: list } = station.snapshot();
  assert.notEqual(second.k, first.k);
  assert.equal(list.length, 2);
});

test('a station reopens on its own songs, ahead of others in the bucket', async () => {
  await seedLibrary(3);
  await station.tune(config);
  const { id } = station.snapshot().station;
  await library.add(
    { id: 'mine', title: 'mine', bucket: bucketFor(config), stationId: id, generation: config, durationSec: 300, truncated: false, createdAt: new Date(2026, 5, 1).toISOString() },
    Buffer.from('wav'),
  );
  await station.tune(config, { fromLibrary: true, stationId: id });
  assert.equal(station.snapshot().tracks[0].id, 'mine');
  assert.equal(station.snapshot().stations[0].songCount, 1);
});

test('saved stations survive a restart and are listed before any tuning', async () => {
  await station.tune(config, { identity: { name: 'Low Tide' } });
  const store = new StationStore(join(root, 'stations.json'));
  await store.load();
  const fresh = new RadioStation({ engine, library, stations: store });
  assert.deepEqual(fresh.snapshot().stations.map(({ name }) => name), ['Low Tide']);
  assert.equal(fresh.snapshot().stationId, null);
  await fresh.close();
});

test('a reopened station plays all its stored songs before a new one', async () => {
  await station.tune(config);
  const { id } = station.snapshot().station;
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    await library.add(
      { id: name, title: name, bucket: bucketFor(config), stationId: id, generation: config, durationSec: 300, truncated: false, createdAt: new Date(2026, 5, 1).toISOString() },
      Buffer.from('wav'),
    );
  }
  await station.tune(config, { fromLibrary: true, stationId: id });
  const sources = station.snapshot().tracks.map((track) => track.source);
  assert.deepEqual(sources, ['library', 'library', 'library', 'library', 'library', 'new']);
});

test('an unknown station is refused', async () => {
  await assert.rejects(station.tune(config, { stationId: 'nope' }), RangeError);
});

test('with plenty of music ahead the GPU stays idle', async () => {
  await seedLibrary(1);
  await goOnAir();
  assert.equal(engine.requests.length, 1);
  assert.equal(engine.pending.length, 0);
  assert.equal(station.snapshot().tracks.at(-1).status, 'queued');
});

test('a new song starts once the music ahead runs short', async () => {
  await goOnAir(2);
  assert.equal(engine.pending.length, 1, 'two seconds of music is below the lead time');
  engine.finish({ audio: wavBase64(300) });
  while (station.snapshot().tracks[1].status !== 'ready') await settle();
  assert.equal(engine.pending.length, 0, 'five minutes ahead needs no generation');
  const [, second] = station.snapshot().tracks;
  await station.setPlayback({ trackId: second.id, positionSec: 280, playing: true });
  assert.equal(engine.pending.length, 1, 'twenty seconds left is below the lead time');
});

test('playback cannot point at a song that is not ready', async () => {
  await station.tune(config);
  const [track] = station.snapshot().tracks;
  await assert.rejects(station.setPlayback({ trackId: track.id, positionSec: 0, playing: true }), RangeError);
});

test('replays take a larger share as the library grows', async () => {
  await seedLibrary(7);
  await goOnAir();
  const sources = station.snapshot().tracks.map((track) => track.source);
  assert.deepEqual(sources, ['new', 'library', 'library', 'library', 'new']);
});

test('liked songs are replayed first and a disliked song never returns', async () => {
  await seedLibrary(3);
  await station.setFeedback('seed-2', 'like');
  await station.setFeedback('seed-0', 'dislike');
  await goOnAir();
  const ids = station.snapshot().tracks.map((track) => track.id);
  assert.equal(ids[1], 'seed-2');
  assert.ok(!ids.includes('seed-0'));
});

test('a disliked song leaves the songs still to come', async () => {
  await seedLibrary(2);
  await goOnAir();
  const [, second] = station.snapshot().tracks;
  await station.setFeedback(second.id, 'dislike');
  assert.ok(!station.snapshot().tracks.some((track) => track.id === second.id));
});

test('eviction keeps liked songs and enforces the bucket limit', async () => {
  await seedLibrary(14);
  await library.update('seed-0', { liked: true });
  await library.evict(new Set());
  assert.ok(library.get('seed-0'), 'the oldest song survives because it is liked');
  assert.equal(library.get('seed-1'), null, 'the oldest unliked song is removed');
  assert.equal(library.playableCount(bucketFor(config)), 13);
});

test('the library and its likes survive a restart', async () => {
  await seedLibrary(1);
  await library.update('seed-0', { liked: true });
  const reloaded = new Library(root);
  await reloaded.load();
  assert.equal(reloaded.get('seed-0').liked, true);
  assert.equal(await readFile(reloaded.audioPath('seed-0'), 'utf8'), 'wav');
});

test('pausing starts no new song while music is ready', async () => {
  const first = await goOnAir(2);
  engine.finish({ audio: wavBase64(2) });
  await settle();
  const requests = engine.requests.length;
  await station.setPlayback({ trackId: first.id, positionSec: 1, playing: false });
  await settle();
  assert.equal(engine.requests.length, requests);
});

test('stop generating ends the running song and keeps the library playing', async () => {
  await seedLibrary(1);
  const first = await goOnAir(2);
  const [, stored] = station.snapshot().tracks;
  await station.setPlayback({ trackId: stored.id, positionSec: 299, playing: true });
  assert.equal(engine.pending.length, 1);
  await station.setGenerationEnabled(false);
  await settle();
  assert.equal(engine.aborts, 1);
  const snapshot = station.snapshot();
  assert.equal(snapshot.generation.enabled, false);
  assert.equal(snapshot.tracks.at(-1).id, first.id, 'the station loops what it has');
  assert.equal(snapshot.tracks.at(-1).status, 'ready');
  assert.equal(engine.pending.length, 0);
});

test('resuming generation queues new songs again', async () => {
  await goOnAir(2);
  await station.setGenerationEnabled(false);
  await settle();
  const requests = engine.requests.length;
  await station.setGenerationEnabled(true);
  await settle();
  assert.equal(engine.requests.length, requests + 1);
});

test('an idle engine is unloaded', async () => {
  const quick = new RadioStation({ engine, library, stations, idleUnloadMs: 0, tickMs: 5 });
  await settle();
  await quick.close();
  assert.ok(engine.stops > 0);
});

test('steering changes songs not started yet, not the running one', async () => {
  await station.tune(config);
  station.steer({ ...config, energy: 90 });
  const [running] = station.snapshot().tracks;
  assert.equal(running.generation.energy, 25);
  engine.finish();
  await settle();
  await station.setPlayback({ trackId: running.id, positionSec: 0, playing: true });
  assert.match(engine.requests[1].options.style, /massive drop/);
});

test('retune aborts the running song and keeps stored songs', async () => {
  await goOnAir(2);
  assert.equal(library.size, 1);
  const first = station.snapshot().stationId;
  await station.tune({ ...config, energy: 90 });
  await settle();
  assert.equal(engine.aborts, 1);
  assert.notEqual(station.snapshot().stationId, first);
  assert.equal(library.size, 1);
});

test('a failed song is retried, and repeated failures stop the station', async () => {
  await station.tune(config);
  engine.fail();
  await settle();
  assert.equal(station.snapshot().error, null);
  assert.equal(engine.pending.length, 1);
  engine.fail();
  await settle();
  engine.fail('model missing');
  await settle();
  assert.equal(station.snapshot().error, 'model missing');
  assert.equal(engine.pending.length, 0);
});

test('audio is served with byte ranges for seeking', async () => {
  const server = createApp({ station, uiDir: root });
  const base = await listen(server);
  try {
    await station.tune(config);
    engine.finish();
    await settle();
    const [track] = station.snapshot().tracks;
    const response = await fetch(`${base}/audio/${track.id}`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 10);
    const missing = await fetch(`${base}/audio/not-a-song`);
    assert.equal(missing.status, 404);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('the API refuses other hosts and non-JSON writes', async () => {
  const server = createApp({ station, uiDir: root });
  const base = await listen(server);
  try {
    const plain = await fetch(`${base}/api/tune`, { method: 'POST', body: '{}' });
    assert.equal(plain.status, 415);
    const { port } = new URL(base);
    const forged = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: 'evil.example' } }, resolve).on('error', reject);
    });
    forged.resume();
    assert.equal(forged.statusCode, 403);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---------- Lux stations ----------

const luxSong = (id, station, overrides = {}) => ({
  id,
  station,
  title: `Song ${id}`,
  durationSec: 120,
  file: `${station}/${id}.mp3`,
  sha256: 'a'.repeat(64),
  sizeBytes: 1000,
  ...overrides,
});

async function luxFixture(songs) {
  const bundledDir = join(root, 'lux');
  await mkdir(bundledDir, { recursive: true });
  await writeFile(join(bundledDir, 'manifest.json'), JSON.stringify({ version: 1, songs }));
  const luxCatalog = new LuxCatalog({
    bundledDir,
    downloadDir: join(root, 'lux-downloads'),
    statePath: join(root, 'lux-state.json'),
  });
  await luxCatalog.load();
  const engine = new FakeEngine();
  const library = new Library(join(root, 'library'));
  await library.load();
  const stations = new StationStore(join(root, 'stations.json'), { reservedFrequencies: RESERVED_FREQUENCIES });
  const radio = new RadioStation({ engine, library, stations, catalog: luxCatalog, tickMs: 60_000 });
  return { radio, engine, library, stations, luxCatalog };
}

const twoLuxSongs = [luxSong('a', 'lux-edm'), luxSong('b', 'lux-edm')];

test('a Lux station plays its songs in a loop and never uses the engine', async () => {
  const { radio, engine } = await luxFixture(twoLuxSongs);
  await radio.tune(config, { stationId: 'lux-edm', fromLibrary: true });
  const seen = [];
  for (let turn = 0; turn < 4; turn += 1) {
    const { tracks } = radio.snapshot();
    const next = seen.length ? tracks.at(-1) : tracks[0];
    seen.push(next.id);
    await radio.setPlayback({ trackId: next.id, positionSec: 0, playing: true });
  }
  assert.equal(new Set(seen).size, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.notEqual(seen[1], seen[2]);
  assert.equal(engine.requests.length, 0);
  assert.equal(radio.snapshot().station.lux, true);
  await radio.close();
});

test('a Lux station uses its own settings, not the ones being edited', async () => {
  const { radio } = await luxFixture(twoLuxSongs);
  await radio.tune(config, { stationId: 'lux-edm', fromLibrary: true });
  assert.deepEqual(Object.keys(radio.snapshot().tracks[0].generation.mix), ['EDM']);
  await assert.rejects(radio.setGenerationEnabled(false), RangeError);
  await radio.close();
});

test('feedback on a Lux song is remembered and a disliked song stops playing', async () => {
  const { radio, luxCatalog } = await luxFixture(twoLuxSongs);
  await radio.tune(config, { stationId: 'lux-edm', fromLibrary: true });
  await radio.setFeedback('b', 'dislike');
  assert.equal(luxCatalog.pick('lux-edm', new Set()).id, 'a');
  assert.equal(luxCatalog.countForStation('lux-edm'), 1);
  await radio.setFeedback('a', 'dislike');
  assert.ok(luxCatalog.pick('lux-edm', new Set()), 'a station whose songs were all disliked still plays');
  await radio.close();
});

test('a listener station never takes a frequency reserved for a Lux station', async () => {
  const stations = new StationStore(join(root, 'stations.json'), { reservedFrequencies: RESERVED_FREQUENCIES });
  for (let index = 0; index < 30; index += 1) {
    const station = await stations.open({ ...config, scenario: undefined, mood: `sound ${index}`, energy: 25, mix: { [GENRES[index % GENRES.length]]: 60, [GENRES[(index + 1 + (index % 5)) % GENRES.length]]: 40 } }, { name: `S${index}` });
    assert.ok(!RESERVED_FREQUENCIES.includes(station.k), `station landed on ${station.k}`);
  }
});

test('a bad manifest entry is dropped on its own', () => {
  const songs = parseManifest({
    version: 1,
    songs: [
      luxSong('good', 'lux-rock'),
      luxSong('../../evil', 'lux-rock'),
      luxSong('escape', 'lux-rock', { file: '../../../evil.mp3' }),
      luxSong('unknown', 'lux-jazz'),
      luxSong('plain-http', 'lux-rock', { file: undefined, url: 'http://example.com/a.mp3' }),
      luxSong('too-big', 'lux-rock', { sizeBytes: 10 ** 10 }),
    ],
  });
  assert.deepEqual(songs.map(({ id }) => id), ['good']);
  assert.throws(() => parseManifest({ version: 99, songs: [] }), TypeError);
});

// ---------- Composing a station while another plays ----------

test('preparing a station leaves the current one playing, then stores its song', async () => {
  const { radio, engine, library } = await luxFixture(twoLuxSongs);
  await radio.tune(config, { stationId: 'lux-edm', fromLibrary: true });
  const onAir = radio.snapshot().stationId;
  await radio.prepare(config, { identity: { name: 'Low Tide' } });
  assert.equal(radio.snapshot().stationId, onAir);
  assert.equal(radio.snapshot().preparation.status, 'composing');
  assert.equal(radio.snapshot().preparation.name, 'Low Tide');
  assert.equal(engine.requests.length, 1);
  engine.finish();
  await settle();
  assert.equal(radio.snapshot().stationId, onAir);
  const { preparation, stations } = radio.snapshot();
  assert.equal(preparation.status, 'ready');
  assert.equal(library.countForStation(preparation.stationId), 1);
  assert.equal(stations.find(({ id }) => id === preparation.stationId).songCount, 1);
  await radio.close();
});

test('tuning in to a prepared station plays its stored song at once, without generating', async () => {
  const { radio, engine } = await luxFixture(twoLuxSongs);
  await radio.tune(config, { stationId: 'lux-edm', fromLibrary: true });
  await radio.prepare(config, { identity: { name: 'Low Tide' } });
  engine.finish();
  await settle();
  const { stationId } = radio.snapshot().preparation;
  await radio.tune(config, { stationId, fromLibrary: true });
  const snapshot = radio.snapshot();
  assert.equal(snapshot.preparation, null);
  assert.equal(snapshot.station.name, 'Low Tide');
  assert.equal(snapshot.tracks[0].status, 'ready');
  assert.equal(engine.requests.length, 1);
  await radio.close();
});

test('changing Lux station does not interrupt a preparation', async () => {
  const { radio, engine } = await luxFixture([...twoLuxSongs, luxSong('c', 'lux-rock'), luxSong('d', 'lux-rock')]);
  await radio.tune(config, { stationId: 'lux-edm', fromLibrary: true });
  await radio.prepare(config);
  await radio.tune(config, { stationId: 'lux-rock', fromLibrary: true });
  assert.equal(engine.aborts, 0);
  assert.equal(radio.snapshot().preparation.status, 'composing');
  await radio.close();
});

test('a preparation waits for the station on air, which resumes afterwards', async () => {
  const { radio, engine } = await luxFixture(twoLuxSongs);
  await radio.tune(config);
  await settle();
  assert.equal(radio.snapshot().generation.active, true);
  const other = { ...config, mix: { Rock: 100 }, energy: 80 };
  await radio.prepare(other);
  await settle();
  assert.equal(engine.aborts, 0);
  assert.equal(radio.snapshot().preparation.status, 'waiting');
  engine.finish();
  await settle();
  assert.equal(radio.snapshot().preparation.status, 'composing');
  assert.equal(engine.requests.length, 2);
  engine.finish();
  await settle();
  assert.equal(radio.snapshot().preparation.status, 'ready');
  await radio.setPlayback({ trackId: radio.snapshot().tracks[0].id, positionSec: 0, playing: true });
  assert.equal(engine.requests.length, 3, 'the station on air goes back to composing');
  await radio.close();
});

test('stopping a preparation aborts the engine and clears it', async () => {
  const { radio, engine } = await luxFixture(twoLuxSongs);
  await radio.tune(config, { stationId: 'lux-edm', fromLibrary: true });
  await radio.prepare(config);
  await radio.cancelPreparation();
  await settle();
  assert.equal(engine.aborts, 1);
  assert.equal(radio.snapshot().preparation, null);
  await radio.close();
});

test('a preparation that keeps failing reports it and lets go of the engine', async () => {
  const { radio, engine } = await luxFixture(twoLuxSongs);
  await radio.tune(config, { stationId: 'lux-edm', fromLibrary: true });
  await radio.prepare(config);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await settle();
    engine.fail('out of memory');
  }
  await settle();
  assert.equal(radio.snapshot().preparation.status, 'failed');
  assert.equal(radio.snapshot().preparation.error, 'out of memory');
  await radio.close();
});

test('a paused return to a station starts no generation until the listener presses play', async () => {
  const { radio, engine, library } = await luxFixture(twoLuxSongs);
  await radio.prepare(config, { identity: { name: 'Low Tide' } });
  engine.finish();
  await settle();
  const { stationId } = radio.snapshot().preparation;
  const songs = engine.requests.length;
  await radio.tune(config, { stationId, fromLibrary: true, paused: true });
  const [first] = radio.snapshot().tracks;
  await radio.setPlayback({ trackId: first.id, positionSec: 0, playing: false });
  await settle();
  assert.equal(engine.requests.length, songs);
  await radio.setPlayback({ trackId: first.id, positionSec: 0, playing: true });
  await settle();
  assert.equal(engine.requests.length, songs + 1);
  assert.equal(library.countForStation(stationId), 1);
  await radio.close();
});

test('the feed downloads new songs, checks them, and survives a restart', async () => {
  const good = Buffer.from('good song');
  const sha256 = createHash('sha256').update(good).digest('hex');
  const server = http.createServer((request, response) => {
    if (request.url === '/manifest.json') {
      const base = `http://127.0.0.1:${server.address().port}`;
      response.end(JSON.stringify({
        version: 1,
        songs: [
          { ...luxSong('fresh', 'lux-pop', { file: undefined, url: `${base}/fresh.mp3`, sha256, sizeBytes: good.length }) },
          { ...luxSong('tampered', 'lux-pop', { file: undefined, url: `${base}/fresh.mp3`, sha256: 'b'.repeat(64), sizeBytes: good.length }) },
          { ...luxSong('missing', 'lux-pop', { file: undefined, url: `${base}/nothing.mp3`, sha256, sizeBytes: good.length }) },
        ],
      }));
    } else if (request.url === '/fresh.mp3') response.end(good);
    else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const paths = { bundledDir: join(root, 'none'), downloadDir: join(root, 'downloads'), statePath: join(root, 'state.json') };
  const catalog = new LuxCatalog(paths);
  await catalog.load();
  const added = [];
  const originalError = console.error;
  console.error = () => {};
  const count = await syncFeed({ url: `http://127.0.0.1:${server.address().port}/manifest.json`, catalog, onSong: (song) => added.push(song.id) });
  console.error = originalError;
  server.close();
  assert.equal(count, 1);
  assert.deepEqual(added, ['fresh']);
  assert.equal(catalog.has('tampered'), false);
  assert.equal((await readFile(catalog.audioPath('fresh'))).toString(), 'good song');
  const restarted = new LuxCatalog(paths);
  await restarted.load();
  assert.equal(restarted.has('fresh'), true);
  assert.equal(restarted.countForStation('lux-pop'), 1);
});

test('Lux songs are served as MP3', async () => {
  const { radio, luxCatalog } = await luxFixture(twoLuxSongs);
  const path = luxCatalog.audioPath('a');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'mp3 bytes');
  const server = createApp({ station: radio, uiDir: join(root, 'ui') });
  const address = await listen(server);
  const response = await fetch(`${address}/audio/a`);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await response.text(), 'mp3 bytes');
  server.closeAllConnections();
  server.close();
  await radio.close();
});

test('the short questions never ask the listener to tap over the radio', () => {
  const deck = createDeck({ genres: [{ name: 'Pop', color: '#fff' }, { name: 'Rock', color: '#000' }], signalsOnly: true });
  for (let turn = 0; turn < 30; turn += 1) assert.equal(deck.next().kind, 'signal');
});

// ---------- A station keeps its songs ----------

async function storedOnStation(id, stationId, generation = config, changes = {}) {
  return library.add({ id, title: id, bucket: bucketFor(generation), stationId, generation, durationSec: 300, truncated: false, createdAt: new Date(2026, 0, 1).toISOString(), ...changes }, Buffer.from(wavBase64(1), 'base64'));
}

test('returning to a station lists all its songs, even from another bucket', async () => {
  const own = await stations.open(config, { name: 'Mine' });
  await storedOnStation('one', own.id);
  await storedOnStation('two', own.id);
  await storedOnStation('moved', own.id, { ...config, mix: { Rock: 100 }, energy: 90 });
  await storedOnStation('rejected', own.id, config, { disliked: true });
  await station.tune(config, { fromLibrary: true, stationId: own.id });
  const ready = station.snapshot().tracks.filter((track) => track.status === 'ready').map((track) => track.id);
  assert.deepEqual(ready.sort(), ['moved', 'one', 'two']);
});

test('every song is listed while generation is stopped or another station composes', async () => {
  const own = await stations.open(config, { name: 'Mine' });
  await storedOnStation('one', own.id);
  await storedOnStation('two', own.id);
  await station.prepare({ ...config, mix: { Rock: 100 }, energy: 90 }, { identity: { name: 'Other' } });
  await station.tune(config, { fromLibrary: true, stationId: own.id });
  assert.equal(station.snapshot().tracks.filter((track) => track.status === 'ready').length, 2);
});

test('the limits never remove a song on a station, and a rejected one does go', async () => {
  const own = await stations.open(config, { name: 'Mine' });
  for (let index = 0; index < 20; index += 1) await storedOnStation(`kept-${index}`, own.id);
  await storedOnStation('rejected', own.id, config, { disliked: true });
  await library.evict(new Set());
  assert.equal(library.countForStation(own.id), 20);
  assert.equal(library.get('rejected'), null);
});

test('a rejected song leaves the list even after it has played', async () => {
  const own = await stations.open(config, { name: 'Mine' });
  await storedOnStation('one', own.id);
  await storedOnStation('two', own.id);
  await station.tune(config, { fromLibrary: true, stationId: own.id });
  const [first, second] = station.snapshot().tracks;
  await station.setPlayback({ trackId: first.id, positionSec: 0, playing: true });
  await station.setPlayback({ trackId: second.id, positionSec: 0, playing: true });
  await station.setFeedback(first.id, 'dislike');
  assert.ok(!station.snapshot().tracks.some((track) => track.id === first.id));
});

test('a name the listener chooses names the station, and renames one with the same sound', async () => {
  const first = await stations.open(config, { name: 'Automatic', chosenName: 'Casa mia' });
  assert.equal(first.name, 'Casa mia');
  const same = await stations.open(config, { name: 'Automatic' });
  assert.equal(same.id, first.id);
  assert.equal(same.name, 'Casa mia');
  await stations.open(config, { name: 'Automatic', chosenName: 'Notte' });
  assert.equal(stations.get(first.id).name, 'Notte');
  await station.renameStation(first.id, 'Alba');
  assert.equal(stations.get(first.id).name, 'Alba');
});

// ---------- A started song always finishes ----------

const otherSound = { ...config, mix: { Rock: 100 }, energy: 90 };
const thirdSound = { ...config, mix: { Metal: 100 }, energy: 90 };
const fourthSound = { ...config, mix: { Ambient: 100 }, energy: 10 };

/** Station A composing its first song, and station B with a stored song. */
async function composingOnA(songSeconds = 300) {
  await station.tune(config);
  const a = station.snapshot().station;
  const [track] = station.snapshot().tracks;
  const b = await stations.open(otherSound, { name: 'Other' });
  await storedOnStation('b-song', b.id, otherSound, { durationSec: songSeconds });
  return { a, b, track };
}

const toB = (b) => station.tune(otherSound, { fromLibrary: true, stationId: b.id });
const hear = (trackId) => station.setPlayback({ trackId, positionSec: 0, playing: true });

test('moving to another station leaves the running song alone', async () => {
  const { a, b, track } = await composingOnA();
  await toB(b);
  assert.equal(engine.aborts, 0);
  engine.finish();
  await settle();
  assert.equal(library.get(track.id).stationId, a.id);
  assert.equal(station.snapshot().station.id, b.id);
});

test('returning during a song shows the same track without a second request', async () => {
  const { a, b, track } = await composingOnA();
  await toB(b);
  await station.tune(config, { fromLibrary: true, stationId: a.id });
  assert.equal(engine.requests.length, 1);
  const listed = station.snapshot().tracks.filter(({ id }) => id === track.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'generating');
  assert.equal(listed[0].startedAt, track.startedAt);
  engine.finish();
  await settle();
  assert.equal(station.snapshot().tracks.find(({ id }) => id === track.id).status, 'ready');
  assert.notEqual(engine.requests[1]?.seed, engine.requests[0].seed);
});

test('returning at the moment a song finishes lists it once, as ready', async () => {
  const { a, b, track } = await composingOnA();
  await toB(b);
  engine.finish();
  await station.tune(config, { fromLibrary: true, stationId: a.id });
  await settle();
  const listed = station.snapshot().tracks.filter(({ id }) => id === track.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'ready');
});

test('a station left behind starts nothing more', async () => {
  const { b } = await composingOnA();
  await toB(b);
  engine.finish();
  await settle();
  assert.equal(engine.requests.length, 1);
});

test('a song due on B waits for the song on A, while B keeps its songs', async () => {
  const { b } = await composingOnA(5);
  await toB(b);
  await hear('b-song');
  assert.equal(engine.requests.length, 1);
  assert.equal(station.snapshot().tracks[0].status, 'ready');
  engine.finish();
  await settle();
  assert.equal(engine.requests.length, 2);
  assert.equal(station.snapshot().tracks[0].id, 'b-song');
});

test('while another station composes, the one on air keeps replaying what it has', async () => {
  const { b } = await composingOnA(5);
  await storedOnStation('b-two', b.id, otherSound, { durationSec: 5 });
  await toB(b);
  const [first, second] = station.snapshot().tracks;
  await hear(first.id);
  await hear(second.id);
  const upcoming = station.snapshot().tracks.slice(station.snapshot().tracks.findIndex(({ id }) => id === second.id) + 1);
  assert.equal(upcoming[0].status, 'ready');
  assert.equal(upcoming[0].id, first.id);
});

test('a song failing on a station left behind is not retried and the next work starts', async () => {
  const { b } = await composingOnA(5);
  await toB(b);
  await hear('b-song');
  const silence = console.error;
  console.error = () => {};
  engine.fail();
  await settle();
  console.error = silence;
  assert.equal(engine.requests.length, 2);
  assert.equal(engine.requests[1].options.style, buildStyle(otherSound));
  assert.equal(station.snapshot().error, null);
});

test('a song in progress survives a dislike of another song', async () => {
  const { a, b, track } = await composingOnA();
  await storedOnStation('a-song', a.id);
  await toB(b);
  await station.tune(config, { fromLibrary: true, stationId: a.id });
  await station.setFeedback('a-song', 'dislike');
  engine.finish();
  await settle();
  assert.equal(station.snapshot().tracks.find(({ id }) => id === track.id).status, 'ready');
});

test('the engine is not unloaded while a song on another station composes', async () => {
  const eager = new RadioStation({ engine, library, stations, idleUnloadMs: 0, tickMs: 5 });
  await eager.tune(config);
  const b = await stations.open(otherSound, { name: 'Other' });
  await storedOnStation('b-song', b.id, otherSound);
  await eager.tune(otherSound, { fromLibrary: true, stationId: b.id });
  const stopsBefore = engine.stops;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(engine.stops, stopsBefore);
  await eager.close();
});

test('a preparation waits for a running song, then goes first', async () => {
  const { b } = await composingOnA(5);
  await toB(b);
  await hear('b-song');
  await station.prepare(thirdSound, { identity: { name: 'Third' } });
  assert.equal(engine.aborts, 0);
  assert.equal(station.snapshot().preparation.status, 'waiting');
  engine.finish();
  await settle();
  assert.equal(engine.requests.at(-1).options.style, buildStyle(thirdSound));
  assert.equal(station.snapshot().preparation.status, 'composing');
});

test('a second preparation lets the first finish as a stored song', async () => {
  await station.prepare(thirdSound, { identity: { name: 'Third' } });
  const firstId = station.snapshot().preparation.stationId;
  await station.prepare(fourthSound, { identity: { name: 'Fourth' } });
  assert.equal(engine.aborts, 0);
  assert.equal(station.snapshot().preparation.name, 'Fourth');
  assert.equal(station.snapshot().preparation.status, 'waiting');
  engine.finish();
  await settle();
  assert.equal(library.countForStation(firstId), 1);
  assert.equal(station.snapshot().preparation.name, 'Fourth');
  assert.equal(station.snapshot().preparation.status, 'composing');
});

test('a third preparation replaces the waiting one', async () => {
  await station.prepare(config, { identity: { name: 'First' } });
  await station.prepare(thirdSound, { identity: { name: 'Second' } });
  const secondId = station.snapshot().preparation.stationId;
  await station.prepare(fourthSound, { identity: { name: 'Third' } });
  engine.finish();
  await settle();
  assert.equal(engine.requests.length, 2);
  assert.equal(engine.requests[1].options.style, buildStyle(fourthSound));
  engine.finish();
  await settle();
  assert.equal(library.countForStation(secondId), 0);
});

test('preparing the sound already composing waits, one request at a time', async () => {
  await station.prepare(config, { identity: { name: 'Same' } });
  const { stationId } = station.snapshot().preparation;
  await station.prepare(config, { identity: { name: 'Same' } });
  assert.equal(engine.requests.length, 1);
  assert.equal(station.snapshot().preparation.stationId, stationId);
  engine.finish();
  await settle();
  assert.equal(engine.requests.length, 2);
});

test('cancelling a waiting preparation leaves the running song', async () => {
  const { b } = await composingOnA();
  await toB(b);
  await station.prepare(thirdSound);
  await station.cancelPreparation();
  assert.equal(engine.aborts, 0);
  assert.equal(station.snapshot().preparation, null);
  assert.equal(engine.pending.length, 1);
});

test('stop on the composing station aborts', async () => {
  await station.tune(config);
  await station.setGenerationEnabled(false);
  assert.equal(engine.aborts, 1);
});

test('stop on another station leaves the song running', async () => {
  const { b } = await composingOnA();
  await toB(b);
  const stopsBefore = engine.stops;
  await station.setGenerationEnabled(false);
  assert.equal(engine.aborts, 0);
  assert.equal(engine.stops, stopsBefore);
  assert.equal(engine.pending.length, 1);
});

test('cancelJob aborts and starts what was waiting', async () => {
  const { a, b } = await composingOnA();
  await toB(b);
  await station.prepare(thirdSound);
  await station.cancelJob();
  assert.equal(engine.aborts, 1);
  assert.equal(engine.requests.at(-1).options.style, buildStyle(thirdSound));
  assert.equal(library.countForStation(a.id), 0);
});

test('cancelJob and cancelPreparation with nothing running do nothing', async () => {
  await station.cancelJob();
  await station.cancelPreparation();
  assert.equal(engine.aborts, 0);
});

test('the snapshot names a song on another station', async () => {
  const { a, b } = await composingOnA(5);
  assert.equal(station.snapshot().job, null);
  assert.equal(station.snapshot().generation.active, true);
  await toB(b);
  await hear('b-song');
  const snapshot = station.snapshot();
  assert.equal(snapshot.job.name, a.name);
  assert.equal(snapshot.job.stationId, a.id);
  assert.equal(snapshot.generation.active, false);
  assert.equal(snapshot.generation.waitingFor, a.name);
  await station.tune(config, { fromLibrary: true, stationId: a.id });
  assert.equal(station.snapshot().job, null);
  assert.equal(station.snapshot().generation.active, true);
  assert.equal(station.snapshot().generation.waitingFor, null);
});

test('a preparation waiting behind the station on air names that song too', async () => {
  const { a } = await composingOnA();
  await station.prepare(thirdSound);
  assert.equal(station.snapshot().job.stationId, a.id);
});

test('a song left behind arriving while Lux plays starts no engine work', async () => {
  const fixture = await luxFixture(twoLuxSongs);
  await fixture.radio.tune(config);
  await fixture.radio.tune(config, { stationId: 'lux-edm', fromLibrary: true });
  const before = fixture.radio.snapshot().tracks.map(({ id }) => id);
  fixture.engine.finish();
  await settle();
  assert.equal(fixture.engine.requests.length, 1);
  assert.deepEqual(fixture.radio.snapshot().tracks.map(({ id }) => id), before);
  await fixture.radio.close();
});

test('the song on another station can be cancelled over HTTP', async () => {
  const { b } = await composingOnA();
  await toB(b);
  const server = createApp({ station, uiDir: join(root, 'ui') });
  const address = await listen(server);
  const response = await fetch(`${address}/api/job/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(engine.aborts, 1);
  server.closeAllConnections();
  server.close();
});

test('stop on a station composing as a new station clears the preparation', async () => {
  const own = await stations.open(config, { name: 'Mine' });
  await storedOnStation('one', own.id);
  await station.prepare(config, { identity: { name: 'Mine' } });
  await station.tune(config, { fromLibrary: true, stationId: own.id });
  await station.setGenerationEnabled(false);
  assert.equal(engine.aborts, 1);
  assert.equal(station.snapshot().preparation, null);
});

test('a superseded new station lists its song when the listener is on it', async () => {
  await station.prepare(thirdSound, { identity: { name: 'First' } });
  const firstId = station.snapshot().preparation.stationId;
  await station.prepare(fourthSound, { identity: { name: 'Second' } });
  await station.tune(thirdSound, { fromLibrary: true, stationId: firstId });
  engine.finish();
  await settle();
  const [first] = station.snapshot().tracks;
  assert.equal(first.status, 'ready');
  assert.equal(library.get(first.id).stationId, firstId);
});

test('returning to a station while it composes keeps replaying its stored songs', async () => {
  const { a, b } = await composingOnA();
  await storedOnStation('a-one', a.id, config, { durationSec: 5 });
  await storedOnStation('a-two', a.id, config, { durationSec: 5 });
  await toB(b);
  await station.tune(config, { fromLibrary: true, stationId: a.id });
  const [first, second] = station.snapshot().tracks;
  await hear(first.id);
  await hear(second.id);
  const { tracks } = station.snapshot();
  const next = tracks[tracks.findIndex(({ id }) => id === second.id) + 1];
  assert.equal(next.status, 'ready');
  assert.equal(next.id, first.id);
});

// ---------- Vocals by default, instrumental on request ----------

const SCORE = `X:1
T:
M:4/4
L:1/8
Q:1/4=120
V: Vocal clef=treble
V: Ins clef=bass
K:C
% verse
V: Vocal
"C"c2 d2 e2 f2|Z|
V: Ins
C8|D8|
V: Vocal
Z2|
V: Ins
Z2|
`;
const scoreResult = (text = SCORE, truncated = 'false') => ({
  artifacts: [{ id: 'score', payload: Buffer.from(text).toString('base64'), meta: { truncated } }],
});
const instrumentalSound = { ...config, instrumental: true };

test('muting a score rests the vocal line and keeps its chords and the instruments', () => {
  const muted = muteVocals(SCORE).split('\n');
  assert.equal(muted[9], 'V: Vocal');
  assert.equal(muted[10], '"C"z8|z8|');
  assert.equal(muted[12], 'C8|D8|');
  assert.equal(muted[14], 'z8|z8|');
  assert.equal(muted[16], 'Z2|');
  assert.throws(() => muteVocals('not a score'), /score/i);
});

test('a song with vocals sends exactly the same request as before', async () => {
  await station.tune(config);
  const [request] = engine.requests;
  assert.equal(request.lyrics, '[instrumental]');
  assert.equal(request.options.cot, 'off');
  assert.equal(request.options.abc, undefined);
  assert.equal(request.options.stop_after, undefined);
});

test('an instrumental song plans a score, then renders it with the vocals muted', async () => {
  await station.tune(instrumentalSound);
  assert.equal(engine.requests[0].options.cot, 'full');
  assert.equal(engine.requests[0].options.stop_after, 'abc');
  engine.finish(scoreResult());
  await settle();
  const render = engine.requests[1];
  assert.equal(render.options.abc, muteVocals(SCORE));
  assert.equal(render.options.stop_after, undefined);
  assert.equal(render.seed, engine.requests[0].seed);
  engine.finish();
  await settle();
  assert.equal(station.snapshot().tracks[0].status, 'ready');
});

test('a truncated or unusable plan is tried again with another seed, up to three times', async () => {
  await station.tune(instrumentalSound);
  engine.finish(scoreResult(SCORE, 'true'));
  await settle();
  engine.finish(scoreResult('nonsense'));
  await settle();
  assert.equal(engine.requests.length, 3);
  assert.notEqual(engine.requests[2].seed, engine.requests[0].seed);
  assert.equal(engine.requests[2].options.stop_after, 'abc');
  engine.finish(scoreResult());
  await settle();
  assert.equal(engine.requests[3].options.abc, muteVocals(SCORE));
});

test('stopping between the plan and the render starts no render', async () => {
  await station.tune(instrumentalSound);
  await station.setGenerationEnabled(false);
  assert.equal(engine.requests.length, 1);
  assert.equal(engine.aborts, 1);
});

test('instrumental songs get their own station and do not replay among sung ones', () => {
  assert.notEqual(bucketFor(config), bucketFor(instrumentalSound));
  assert.equal(bucketFor({ ...config, instrumental: false }), bucketFor(config));
});

test('a Lux code keeps the instrumental choice, and old codes still open', () => {
  const shared = { ...config, scenario: undefined, seed: 7 };
  assert.equal(decodeCode(encodeCode({ ...shared, instrumental: true })).instrumental, true);
  const plain = encodeCode(shared);
  assert.equal(plain.split('~').length, 11, 'a code without the choice stays as it was');
  assert.equal(decodeCode(plain).instrumental, undefined);
});

test('an invalid instrumental value is refused', async () => {
  await assert.rejects(station.tune({ ...config, instrumental: 'yes' }), TypeError);
});

test('the GPU percentage is read from the system statistics', () => {
  assert.equal(parseGpuPercent('"PerformanceStatistics" = {"Tiler Utilization %"=100,"Device Utilization %"=37,"x"=1}'), 37);
  assert.equal(parseGpuPercent('nothing here'), null);
});

test('a station remembers the seed of its first song, whatever comes later', async () => {
  const first = await stations.open({ ...config, seed: 111 }, { name: 'Mine' });
  assert.equal(first.firstSeed, 111);
  await stations.touch(first, { config: { ...config, seed: 222 } });
  await stations.open({ ...config, seed: 333 }, { name: 'Mine' });
  await station.tune({ ...config, seed: 444 }, { fromLibrary: true, stationId: first.id });
  assert.equal(station.snapshot().station.firstSeed, 111);
  assert.equal(station.snapshot().stations.find(({ id }) => id === first.id).firstSeed, 111);
});

test('words the listener activates join the scenario in the prompt', () => {
  const style = buildStyle({ ...config, scenario: 'Have fun', mood: 'rain on a tin roof' });
  assert.ok(style.includes('playful, feel-good'));
  assert.ok(style.includes('rain on a tin roof'));
  assert.ok(!buildStyle({ ...config, scenario: 'Have fun', mood: '' }).includes('rain'));
});

test('different words on the same scenario make a different station', async () => {
  const sound = { ...config, scenario: 'Relax', mood: '' };
  const plain = await stations.open(sound, { name: 'Plain' });
  const worded = await stations.open({ ...sound, mood: 'rain on a tin roof' }, { name: 'Worded' });
  assert.notEqual(plain.id, worded.id);
  assert.equal((await stations.open(sound, { name: 'Again' })).id, plain.id);
});

// ---------- Language, Progressive metal, Generate now ----------

test('sung songs ask for English in every genre, instrumental songs do not need to', () => {
  for (const name of GENRES) {
    const style = buildStyle({ ...config, mix: { [name]: 100 }, scenario: undefined, mood: '' });
    assert.ok(style.startsWith('English, '), name);
    assert.ok(!buildStyle({ ...config, mix: { [name]: 100 }, instrumental: true }).includes('English'), name);
  }
});

test('Progressive metal is a genre with its own sound, station bucket and questions', () => {
  assert.ok(GENRES.includes('Progressive metal'));
  const sound = { ...config, mix: { 'Progressive metal': 100 } };
  assert.ok(buildStyle(sound).includes('progressive metal'));
  assert.equal(bucketFor(sound), 'progressivemetal-calm');
  const deck = createDeck({ genres: [{ name: 'Progressive metal', color: '#fff' }], signalsOnly: true });
  assert.equal(deck.next().kind, 'signal');
  const code = { ...sound, scenario: undefined, seed: 7 };
  assert.deepEqual(decodeCode(encodeCode(code)).mix, sound.mix);
});

/** A station with plenty of music ahead and a song that is not due yet. */
async function notDueYet() {
  const own = await stations.open(config, { name: 'Mine' });
  await storedOnStation('long', own.id, config, { durationSec: 300 });
  await station.tune(config, { fromLibrary: true, stationId: own.id });
  await hear('long');
  const tail = station.snapshot().tracks.at(-1);
  assert.equal(tail.status, 'queued');
  assert.equal(engine.requests.length, 0);
  return { own, tail };
}

test('Generate now starts the queued song at once, and the schedule then works it out again', async () => {
  const { tail } = await notDueYet();
  await station.generateNow(tail.id);
  assert.equal(engine.requests.length, 1);
  assert.equal(station.snapshot().tracks.find(({ id }) => id === tail.id).status, 'generating');
  engine.finish({ audio: wavBase64(2) });
  await settle();
  assert.equal(station.snapshot().tracks.find(({ id }) => id === tail.id).status, 'ready');
  assert.equal(engine.requests.length, 1, 'plenty of music ahead, so nothing else starts');
});

test('Generate now with the engine busy waits its turn, one job at a time', async () => {
  const { a, b } = await composingOnA();
  await toB(b);
  await hear('b-song');
  const tail = station.snapshot().tracks.at(-1);
  await station.generateNow(tail.id);
  assert.equal(engine.requests.length, 1);
  assert.equal(station.snapshot().tracks.at(-1).requested, true);
  engine.finish();
  await settle();
  assert.equal(engine.requests.length, 2);
  assert.equal(engine.requests[1].options.style, buildStyle(otherSound));
  assert.ok(a);
});

test('Generate now also works while paused, because the listener asked for it', async () => {
  const { tail } = await notDueYet();
  await station.setPlayback({ trackId: 'long', positionSec: 1, playing: false });
  await station.generateNow(tail.id);
  assert.equal(engine.requests.length, 1);
});

test('Generate now is refused for anything but the queued song of a station making songs', async () => {
  const { tail } = await notDueYet();
  await assert.rejects(station.generateNow('long'), RangeError);
  await assert.rejects(station.generateNow('nothing'), RangeError);
  await station.setGenerationEnabled(false);
  await assert.rejects(station.generateNow(tail.id), RangeError);
  const fixture = await luxFixture(twoLuxSongs);
  await fixture.radio.tune(config, { stationId: 'lux-edm', fromLibrary: true });
  await assert.rejects(fixture.radio.generateNow(fixture.radio.snapshot().tracks[0].id), RangeError);
  assert.equal(fixture.engine.requests.length, 0);
  await fixture.radio.close();
});

test('a request left behind on another station is forgotten', async () => {
  const { own, tail } = await notDueYet();
  const { b } = await composingElsewhere();
  await station.generateNow(tail.id).catch(() => {});
  await toB(b);
  engine.finish();
  await settle();
  assert.equal(library.countForStation(own.id), 1);
});

async function composingElsewhere() {
  const b = await stations.open(otherSound, { name: 'Other' });
  await storedOnStation('b-song', b.id, otherSound);
  await station.prepare(thirdSound, { identity: { name: 'Third' } });
  return { b };
}

test('Generate now is available over HTTP', async () => {
  const { tail } = await notDueYet();
  const server = createApp({ station, uiDir: join(root, 'ui') });
  const address = await listen(server);
  const response = await fetch(`${address}/api/generate-now`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackId: tail.id }) });
  assert.equal(response.status, 202);
  assert.equal(engine.requests.length, 1);
  server.closeAllConnections();
  server.close();
});

// ---------- A song arriving on another station ----------

test('a song finishing on a station left behind waits for the listener to decide', async () => {
  const { a, b, track } = await composingOnA();
  await toB(b);
  assert.equal(station.snapshot().arrival, null);
  engine.finish();
  await settle();
  const { arrival } = station.snapshot();
  assert.equal(arrival.stationId, a.id);
  assert.equal(arrival.title, track.title);
  assert.equal(arrival.k, a.k);
  await settle();
  assert.ok(station.snapshot().arrival, 'it does not go away by itself');
  await station.dismissArrival();
  assert.equal(station.snapshot().arrival, null);
});

test('going to that station answers the question', async () => {
  const { a, b } = await composingOnA();
  await toB(b);
  engine.finish();
  await settle();
  await station.tune(config, { fromLibrary: true, stationId: a.id });
  assert.equal(station.snapshot().arrival, null);
});

test('no question for a song on the station on air, or for a stopped song', async () => {
  const { b } = await composingOnA();
  engine.finish();
  await settle();
  assert.equal(station.snapshot().arrival, null);
  await station.dismissArrival();
  const again = await stations.open(thirdSound, { name: 'Third' });
  await station.tune(thirdSound);
  await toB(b);
  await station.cancelJob();
  assert.equal(station.snapshot().arrival, null);
  assert.ok(again);
});

test('a new station superseded by another also asks, a ready one keeps its own card', async () => {
  await station.prepare(thirdSound, { identity: { name: 'First' } });
  await station.prepare(fourthSound, { identity: { name: 'Second' } });
  engine.finish();
  await settle();
  assert.equal(station.snapshot().arrival.name, 'First');
  engine.finish();
  await settle();
  assert.equal(station.snapshot().preparation.status, 'ready');
  assert.equal(station.snapshot().arrival.name, 'First');
});

test('the answer can be given over HTTP', async () => {
  const server = createApp({ station, uiDir: join(root, 'ui') });
  const address = await listen(server);
  const response = await fetch(`${address}/api/arrival/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  server.closeAllConnections();
  server.close();
});

// ---------- App entry points ----------

test('loadConfig uses overrides above the environment', () => {
  const overridden = loadConfig({ LVX_DATA_DIR: '/env' }, { dataDir: '/x y', luxDir: '/l', engineBinary: '/b', modelSpecs: '/s', modelDir: '/m' });
  assert.equal(overridden.libraryDir, '/x y/library');
  assert.equal(overridden.lux.bundledDir, '/l');
  assert.equal(overridden.engine.binary, '/b');
  assert.equal(overridden.engine.modelSpecs, '/s');
  assert.equal(overridden.engine.modelDir, '/m');
  assert.equal(overridden.engine.dataDir, '/x y');
});

test('loadConfig keeps its defaults without overrides', () => {
  const { engine: defaults } = loadConfig({});
  assert.match(defaults.binary, /lux-in-music.*audiocpp_server$/);
  assert.match(defaults.modelDir, /lux-in-music/);
});

test('startRadio serves the API and closes', async () => {
  const empty = join(root, 'empty');
  const radio = await startRadio({ ...loadConfig({}, { dataDir: empty, luxDir: join(root, 'no-lux'), modelDir: join(root, 'no-model') }), port: 0 });
  const response = await fetch(`${radio.address}/api/gpu`);
  assert.equal(response.status, 200);
  await radio.close();
  await assert.rejects(fetch(`${radio.address}/api/gpu`));
});

// ---------- Without the model ----------

const MODEL_FILES = ['yue2-3b-q8_0.gguf', 'yue2-vae-f16.gguf', 'sidecars/yue2-generation-config.json', 'sidecars/yue2-model-config.json', 'sidecars/yue2-qwen.tiktoken', 'sidecars/yue2-vae-config.json'];

async function modelFolder() {
  const modelDir = join(root, 'model folder');
  await mkdir(join(modelDir, 'sidecars'), { recursive: true });
  for (const name of MODEL_FILES) await writeFile(join(modelDir, name), '{}');
  await truncate(join(modelDir, MODEL_FILES[0]), 4264195616);
  await truncate(join(modelDir, MODEL_FILES[1]), 265218656);
  const binary = join(root, 'audiocpp_server');
  await writeFile(binary, '');
  await chmod(binary, 0o755);
  return { binary, modelDir, modelFile: MODEL_FILES[0], vaeFile: MODEL_FILES[1] };
}

test('availability lists exactly what is missing', async () => {
  const paths = await modelFolder();
  assert.deepEqual(await engineAvailability(paths), { ready: true, missing: [] });
  for (const name of MODEL_FILES) {
    const path = join(paths.modelDir, name);
    await rename(path, `${path}.away`);
    const result = await engineAvailability(paths);
    assert.equal(result.ready, false);
    assert.deepEqual(result.missing, [name]);
    await rename(`${path}.away`, path);
  }
  await rm(paths.binary);
  assert.deepEqual((await engineAvailability(paths)).missing, ['audiocpp_server']);
});

test('a truncated model counts as missing', async () => {
  const paths = await modelFolder();
  await truncate(join(paths.modelDir, MODEL_FILES[0]), 1000);
  assert.deepEqual((await engineAvailability(paths)).missing, [MODEL_FILES[0]]);
  await truncate(join(paths.modelDir, MODEL_FILES[0]), 4264195616);
  await truncate(join(paths.modelDir, MODEL_FILES[1]), 1000);
  assert.deepEqual((await engineAvailability(paths)).missing, [MODEL_FILES[1]]);
});

const noModel = async () => ({ ready: false, missing: [MODEL_FILES[0]] });

async function radioWithoutModel() {
  const fixture = await luxFixture(twoLuxSongs);
  const radio = new RadioStation({ engine: fixture.engine, library: fixture.library, stations: fixture.stations, catalog: fixture.luxCatalog, availability: noModel, tickMs: 60_000 });
  return { ...fixture, radio };
}

test('no model refuses a new station and Generate now', async () => {
  const { radio, engine, stations: store, library: songs } = await radioWithoutModel();
  await assert.rejects(radio.prepare(config), ModelMissingError);
  await assert.rejects(radio.tune(config), ModelMissingError);
  const own = await store.open(otherSound, { name: 'Mine' });
  await songs.add({ id: 'kept', title: 'kept', bucket: bucketFor(otherSound), stationId: own.id, generation: otherSound, durationSec: 5, truncated: false, createdAt: new Date().toISOString() }, Buffer.from(wavBase64(1), 'base64'));
  await radio.tune(otherSound, { fromLibrary: true, stationId: own.id });
  const tail = radio.snapshot().tracks.at(-1);
  await assert.rejects(radio.generateNow(tail.id), RangeError);
  assert.equal(engine.requests.length, 0);
  await radio.close();
});

test('no model still plays Lux and stored songs, and starts no engine', async () => {
  const { radio, engine, stations: store, library: songs } = await radioWithoutModel();
  await radio.tune(config, { stationId: 'lux-edm', fromLibrary: true });
  assert.equal(radio.snapshot().tracks[0].status, 'ready');
  const own = await store.open(otherSound, { name: 'Mine' });
  await songs.add({ id: 'kept', title: 'kept', bucket: bucketFor(otherSound), stationId: own.id, generation: otherSound, durationSec: 5, truncated: false, createdAt: new Date().toISOString() }, Buffer.from(wavBase64(1), 'base64'));
  await radio.tune(otherSound, { fromLibrary: true, stationId: own.id });
  await radio.setPlayback({ trackId: 'kept', positionSec: 4, playing: true });
  await settle();
  assert.equal(radio.snapshot().tracks[0].id, 'kept');
  assert.equal(engine.requests.length, 0);
  await radio.close();
});

test('the API reports the engine, and a refused station is a clear error', async () => {
  const { radio } = await radioWithoutModel();
  const server = createApp({ station: radio, uiDir: join(root, 'ui') });
  const address = await listen(server);
  assert.deepEqual(await (await fetch(`${address}/api/engine`)).json(), { ready: false, missing: [MODEL_FILES[0]] });
  const refused = await fetch(`${address}/api/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) });
  assert.equal(refused.status, 409);
  server.closeAllConnections();
  server.close();
  await radio.close();
});

test('a stale engine is stopped only if it is ours', async () => {
  const record = (pid) => writeFile(join(root, 'engine-process.json'), JSON.stringify({ pid }));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const stranger = spawn('sleep', ['60']);
  await record(stranger.pid);
  assert.equal(await stopStaleEngine(root), false);
  assert.ok(alive(stranger.pid), 'an unrelated program with that id survives');
  stranger.kill();
  const copy = join(root, 'audiocpp_server');
  await copyFile('/bin/sleep', copy);
  const engineLeft = spawn(copy, ['60']);
  await once(engineLeft, 'spawn');
  await record(engineLeft.pid);
  assert.equal(await stopStaleEngine(root), true);
  await once(engineLeft, 'exit');
  assert.equal(await stopStaleEngine(root), false, 'the record is gone');
});

test('Get lost keeps the existing scenario codes stable and shares Progressive metal', () => {
  const base = { ...config, seed: 123, scenario: 'Get lost', mix: { 'Progressive metal': 60, Rock: 25, Ambient: 15 } };
  const code = encodeCode(base);
  assert.equal(code.split('~')[6], '8');
  assert.deepEqual(decodeCode(code).mix, base.mix);
  assert.equal(decodeCode(code).scenario, 'Get lost');
  assert.match(buildStyle(base), /immersive, adventurous, cinematic/);
  for (const [scenario, id] of ['Have fun','Relax','Concentrate','Workout','Party','Road trip','Sleep','Romance'].map((name,index)=>[name,String(index)])) {
    assert.equal(encodeCode({ ...base, scenario }).split('~')[6], id);
  }
});

test('adding a bundled frequency relocates an existing user station without losing it', async () => {
  const path=join(root,'saved-stations.json');
  const old=new StationStore(path);
  const own=await old.open(config,{name:'Keep me'});
  const id=own.id,seed=own.firstSeed;
  const upgraded=new StationStore(path,{reservedFrequencies:[own.k]});
  await upgraded.load();
  assert.equal(upgraded.list().length,1);
  assert.equal(upgraded.get(id).name,'Keep me');
  assert.equal(upgraded.get(id).firstSeed,seed);
  assert.notEqual(upgraded.get(id).k,own.k);
  const reloaded=new StationStore(path,{reservedFrequencies:[own.k]});await reloaded.load();assert.equal(reloaded.get(id).k,upgraded.get(id).k);
});

test('every asset the interface loads is present', async () => {
  const uiDir = new URL('../src/ui/', import.meta.url);
  const page = await readFile(new URL('index.html', uiDir), 'utf8');
  const assets = new Set([...page.matchAll(/assets\/[\w./-]+\.\w+/g)].map(([path]) => path));
  assert.ok(assets.size > 5);
  for (const path of assets) await readFile(new URL(path, uiDir));
});
