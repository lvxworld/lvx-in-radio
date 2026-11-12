import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { startRadio } from '../src/start.js';

// Owner feedback fix1 item 2: a DJ chosen on one station is that station's choice only.
// Another station keeps what it had (its style default or no DJ) and never inherits the pick,
// live and after a restart of the server on the same data folder.

const relax = { mix: { 'Lo-fi': 70, Jazz: 30 }, energy: 20, bpm: 78, dark: 30, melody: true, mood: 'Sunday light', seed: 11 };
const edm = { mix: { EDM: 80, Techno: 20 }, energy: 80, bpm: 126, dark: 40, melody: true, mood: 'night drive', seed: 22 };
const pop = { mix: { Pop: 100 }, energy: 60, bpm: 104, dark: 20, melody: true, mood: 'bright', seed: 33 };

async function boot(root) {
  const config = loadConfig({ LVX_DATA_DIR: root, LVX_PORT: '0', LVX_NEWS_VOICE_DIR: join(root, 'voice') }, { modelDir: join(root, 'models'), engineBinary: join(root, 'missing'), modelSpecs: root, luxDir: join(root, 'lux') });
  return startRadio(config, { wrapEngine: () => ({ run() { throw new Error('No inference expected'); }, async abort() {}, async stop() {} }) });
}

/** The first SSE snapshot, which carries every station with its `dj`. */
async function snapshot(radio) {
  const controller = new AbortController();
  const response = await fetch(`${radio.address}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  return JSON.parse(text.slice(text.indexOf('data: ') + 6, text.indexOf('\n\n')));
}

const djOf = (snap, id) => {
  const station = snap.stations.find((entry) => entry.id === id);
  assert.ok(station, `station ${id} is in the snapshot`);
  return station.dj;
};

async function choose(radio, stationId, djId) {
  const response = await fetch(`${radio.address}/api/dj/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stationId, djId }) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-choice-'));
  await writeFile(join(root, 'stations.json'), JSON.stringify([
    { id: 'station-a', k: 3, name: 'Relax A', config: relax, firstSeed: 11 },
    { id: 'station-b', k: 9, name: 'EDM B', config: edm, firstSeed: 22 },
    { id: 'station-c', k: 15, name: 'Pop C', config: pop, firstSeed: 33 },
  ]));
  let radio = await boot(root);
  t.after(async () => { await radio?.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root,
    get radio() { return radio; },
    async restart() { await radio.close(); radio = await boot(root); return radio; },
    async disk() { return JSON.parse(await readFile(join(root, 'stations.json'), 'utf8')); },
  };
}

test('choosing a DJ on station A leaves station B and C unchanged, live and after restart', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.radio);
  const bBefore = djOf(before, 'station-b');
  const cBefore = djOf(before, 'station-c');

  await choose(f.radio, 'station-a', 'ryan');
  const live = await snapshot(f.radio);
  assert.equal(djOf(live, 'station-a'), 'ryan');
  assert.equal(djOf(live, 'station-b'), bBefore, 'station B keeps its own DJ');
  assert.equal(djOf(live, 'station-c'), cBefore, 'station C keeps its own DJ');
  assert.notEqual(djOf(live, 'station-b'), 'ryan');

  const disk = await f.disk();
  assert.equal(disk.find((s) => s.id === 'station-a').dj?.id, 'ryan');
  assert.equal(disk.find((s) => s.id === 'station-b').dj?.id ?? null, null, 'no explicit pick is written for station B');
  assert.equal(disk.find((s) => s.id === 'station-c').dj?.id ?? null, null, 'no explicit pick is written for station C');

  await f.restart();
  const reloaded = await snapshot(f.radio);
  assert.equal(djOf(reloaded, 'station-a'), 'ryan');
  assert.equal(djOf(reloaded, 'station-b'), bBefore, 'station B is unchanged after reload');
  assert.equal(djOf(reloaded, 'station-c'), cBefore, 'station C is unchanged after reload');
});

test('each station keeps its own pick; clearing one does not touch the others', async (t) => {
  const f = await fixture(t);
  const cBefore = djOf(await snapshot(f.radio), 'station-c');
  await choose(f.radio, 'station-a', 'serena');
  await choose(f.radio, 'station-b', 'dylan');
  await choose(f.radio, 'station-a', null);

  const check = async (label) => {
    const snap = await snapshot(f.radio);
    assert.notEqual(djOf(snap, 'station-a'), 'serena', `${label}: station A's pick was cleared`);
    assert.notEqual(djOf(snap, 'station-a'), 'dylan', `${label}: station A does not inherit B's pick`);
    assert.equal(djOf(snap, 'station-b'), 'dylan', `${label}: station B keeps its pick`);
    assert.equal(djOf(snap, 'station-c'), cBefore, `${label}: station C is unchanged`);
  };
  await check('live');
  await f.restart();
  await check('after reload');
});

test('a DJ choice for an unknown station is refused and changes nothing', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.radio);
  const response = await fetch(`${f.radio.address}/api/dj/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stationId: 'nope', djId: 'ryan' }) });
  assert.ok(response.status >= 400 && response.status < 500, `status ${response.status}`);
  const after = await snapshot(f.radio);
  for (const id of ['station-a', 'station-b', 'station-c']) assert.equal(djOf(after, id), djOf(before, id));
});
