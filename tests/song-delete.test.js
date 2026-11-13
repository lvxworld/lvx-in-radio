import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Library, bucketFor } from '../src/radio/library.js';
import { StationStore } from '../src/radio/stations.js';
import { RadioStation } from '../src/radio/station.js';
import { LuxCatalog } from '../src/radio/lux-catalog.js';
import { createApp, listen } from '../src/server/app.js';
import { writeWav } from '../src/engine/wav.js';

const config = { mix: { Pop: 100 }, energy: 25, bpm: 80, dark: 30, melody: true, mood: 'Sunday light', seed: 7 };
const wav = writeWav({ sampleRate: 24000, samples: [new Float32Array(24000).fill(.1)] });
async function fixture(t, count = 3) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-song-delete-'));
  const library = new Library(join(root, 'library')); await library.load();
  const stations = new StationStore(join(root, 'stations.json')); await stations.load();
  const saved = await stations.open(config, {});
  for (let i = 0; i < count; i++) await library.add({ id: `song-${i}`, title: `Song ${i}`, stationId: saved.id, bucket: bucketFor(config), generation: config, liked: i === 0, durationSec: 180, createdAt: new Date(i * 1000).toISOString() }, wav);
  const engine = { run() { throw new Error('Deletion must not generate music'); }, async abort() {}, async stop() {} };
  const station = new RadioStation({ library, stations, engine });
  t.after(async () => { await station.close(); await rm(root, { recursive: true, force: true }); });
  await station.tune(config, { stationId: saved.id, fromLibrary: true, paused: true });
  await station.setGenerationEnabled(false);
  return { root, library, stations, station, saved };
}

test('confirmed deletion removes a liked generated song, its metadata and DJ clips, and survives restart', async t => {
  const { root, library, station, saved } = await fixture(t);
  const audio = library.audioPath('song-0');
  const metadata = audio.replace(/\.wav$/, '.json');
  const bytes = (await stat(audio)).size + (await stat(metadata)).size;
  const rejected = [];
  station.attachDJ({ consider() {}, async cancel() {}, async rejectSong(id) { rejected.push(id); }, async close() {} });
  const result = await station.deleteSong('song-0');
  assert.equal(result.freedBytes, bytes);
  assert.deepEqual(rejected, ['song-0']);
  assert.equal(library.get('song-0'), null);
  await assert.rejects(stat(audio), { code: 'ENOENT' });
  await assert.rejects(stat(metadata), { code: 'ENOENT' });
  assert.ok(!station.snapshot().tracks.some(track => track.id === 'song-0'));
  assert.equal(station.snapshot().stations.find(s => s.id === saved.id).songCount, 2);
  const restored = new Library(join(root, 'library')); await restored.load();
  assert.equal(restored.get('song-0'), null);
  assert.equal(restored.size, 2);
});

for (const playing of [true, false]) test(`deleting the current song selects its successor and keeps ${playing ? 'playback' : 'pause'}`, async t => {
  const { station, library } = await fixture(t);
  const tracks = station.snapshot().tracks;
  await station.setPlayback({ trackId: tracks[1].id, positionSec: 10, playing });
  const result = await station.deleteSong(tracks[1].id);
  assert.equal(result.nextTrackId, tracks[2].id);
  assert.equal(station.djContext().playbackTrackId, tracks[2].id);
  assert.equal(station.djContext().playing, playing);
  assert.equal(library.get(tracks[0].id).liked, true);
});

test('deleting the last song pauses, removes the empty bucket and keeps the saved station', async t => {
  const { library, stations, station, saved } = await fixture(t, 1);
  const audio = library.audioPath('song-0');
  await station.setPlayback({ trackId: 'song-0', positionSec: 0, playing: true });
  const result = await station.deleteSong('song-0');
  assert.equal(result.nextTrackId, null);
  assert.equal(station.djContext().playing, false);
  assert.equal(station.snapshot().tracks.length, 0);
  assert.ok(stations.get(saved.id));
  await assert.rejects(stat(join(audio, '..')), { code: 'ENOENT' });
});

test('a disk error rejects deletion without reporting success or removing the song from the queue', async t => {
  const { library, station } = await fixture(t);
  const audio = library.audioPath('song-1');
  await rm(audio); await mkdir(audio); await writeFile(join(audio, 'blocked'), 'keep');
  await assert.rejects(station.deleteSong('song-1'));
  assert.ok(library.get('song-1'));
  assert.ok(station.snapshot().tracks.some(track => track.id === 'song-1'));
});

test('the deletion API refuses unknown songs and deletes generated audio immediately', async t => {
  const { station, library, root } = await fixture(t);
  const server = createApp({ station, uiDir: root });
  const address = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = trackId => fetch(address + '/api/songs/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackId }) });
  assert.equal((await request('missing')).status, 400);
  assert.equal((await request('../song-0')).status, 400);
  assert.equal((await request('lux-song')).status, 400);
  const response = await request('song-1');
  assert.equal(response.status, 200);
  assert.ok((await response.json()).freedBytes >= wav.length);
  assert.equal(library.get('song-1'), null);
});

test('included catalog audio cannot be deleted and keeps its normal dislike feedback', async t => {
  const { station: unused, stations, library, root } = await fixture(t);
  await unused.close();
  const catalog = new LuxCatalog({ bundledDir: resolve(import.meta.dirname, '../lux'), downloadDir: join(root, 'lux'), statePath: join(root, 'lux-state.json') });
  await catalog.load();
  const station = new RadioStation({ stations, library, catalog, engine: { async stop() {} } });
  t.after(() => station.close());
  await station.tune(config, { stationId: 'lux-edm', fromLibrary: true, paused: true });
  const song = station.snapshot().tracks[0], path = catalog.audioPath(song.id);
  const size = (await stat(path)).size;
  await assert.rejects(station.deleteSong(song.id), /generated song/);
  await station.setFeedback(song.id, 'dislike');
  assert.equal((await stat(path)).size, size);
});
