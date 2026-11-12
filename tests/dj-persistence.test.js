import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StationStore } from '../src/radio/stations.js';
import { Library } from '../src/radio/library.js';
import { RadioStation } from '../src/radio/station.js';

const config = { mix: { Jazz: 30, 'Lo-fi': 70 }, energy: 25, bpm: 80, dark: 30, melody: true, mood: 'Sunday light', seed: 7 };

test('listener station DJ choice persists, can be cleared, and does not alter sound identity or seed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-persist-'));
  const path = join(root, 'stations.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const stations = new StationStore(path);
  await stations.load();
  const station = await stations.open(config, {});
  const identity = { id: station.id, k: station.k, firstSeed: station.firstSeed, config: station.config };
  await stations.setDj(station.id, 'serena');
  const disk = JSON.parse(await readFile(path, 'utf8'))[0];
  assert.deepEqual(disk.dj, { id: 'serena' });
  const restored = new StationStore(path);
  await restored.load();
  assert.equal(restored.get(station.id).dj.id, 'serena');
  assert.deepEqual({ id: restored.get(station.id).id, k: restored.get(station.id).k, firstSeed: restored.get(station.id).firstSeed, config: restored.get(station.id).config }, identity);
  // fix1: null is an explicit "No DJ" that is saved and wins over the style default; "default" clears the choice.
  await restored.setDj(station.id, null);
  assert.deepEqual(restored.get(station.id).dj, { id: null });
  const reloaded = new StationStore(path);
  await reloaded.load();
  assert.deepEqual(reloaded.get(station.id).dj, { id: null }, 'an explicit No DJ survives a restart');
  await reloaded.setDj(station.id, 'default');
  assert.equal('dj' in reloaded.get(station.id), false);
});

test('unknown legacy station DJ ids are tolerated when loading older saved stations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-legacy-'));
  const path = join(root, 'stations.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path, JSON.stringify([{ id: 'legacy', k: 6, name: 'Old station', config, dj: { id: 'removed-dj' } }]));
  const stations = new StationStore(path);
  await stations.load();
  assert.equal(stations.get('legacy').dj.id, 'removed-dj');
  const library = new Library(join(root, 'library')); await library.load();
  const station = new RadioStation({ engine: { run: async () => { throw new Error('unused'); }, stop: async () => {} }, library, stations });
  t.after(() => station.close());
  // fix1: an unknown id counts as no choice, so the station gets its style default (Lo-fi leads: relax -> sohee).
  assert.equal(station.snapshot().stations[0].dj, 'sohee', 'an unknown persisted catalog id falls back to the style default');
  assert.equal(station.snapshot().stations[0].djChosen, false);
});
