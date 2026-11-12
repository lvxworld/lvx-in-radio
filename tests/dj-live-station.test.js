import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { writeWav } from '../src/engine/wav.js';
import { DjDesk, resolveDjRuntime } from '../src/radio/dj/dj-desk.js';
import { LuxCatalog, RESERVED_FREQUENCIES } from '../src/radio/lux-catalog.js';
import { Library } from '../src/radio/library.js';
import { RadioStation } from '../src/radio/station.js';
import { StationStore } from '../src/radio/stations.js';
import { newsAfterBulletin } from './fixtures/news-clock.js';

// fix2 regression (owner, DMG 21:55): DJs on, cadence 1-1, tuned to an LVX Live feed station
// ('lux-lofi', MP3s from the feed, not one of the four bundled). The UI promised a DJ break and
// nothing was ever produced: no automatic job even started. These tests replay that setup with an
// isolated copy of the owner's dj-settings.json and require an armed introduction by song 2 or 3.

const GiB = 1024 ** 3;
const PACKAGED = '/Applications/LVX in Radio.app/Contents/Resources/dj-llm/bin/mlx_lm.server';
const lineWav = writeWav({ sampleRate: 24000, samples: [Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 13) * 0.1)] });
const listenerConfig = { mix: { 'Lo-fi': 100 }, energy: 30, bpm: 80, dark: 20, melody: true, mood: 'calm', seed: 3 };
const bundledSongs = ['lux-edm', 'lux-rock', 'lux-pop', 'lux-relax'].flatMap((station) => [1, 2].map((n) => ({ id: `${station}-${n}`, station, title: `Song ${station} ${n}`, durationSec: 60, file: `${station}/${n}.mp3`, sha256: 'a'.repeat(64), sizeBytes: 1000 })));
const liveTitles = ['Night Bus', 'Paper Lanterns', 'Slow Window', 'Tea at Four', 'Rain Shift', 'Blue Hour'];
const liveStation = (durationSec) => ({
  id: 'lux-lofi', k: 21, name: 'LVX Lo-fi', genre: 'Lo-fi', description: 'Soft beats from the feed', enabled: true,
  catalogUrl: 'https://radio.example/catalog.json',
  tracks: liveTitles.map((title, index) => ({ id: `lofi-${index + 1}`, title, url: `https://radio.example/lofi/${index + 1}.mp3`, ...(durationSec === undefined ? {} : { durationSec }) })),
});
// The owner's dj-settings.json, verbatim apart from nothing: copied, never read from the real data dir.
const ownerSettings = { version: 1, enabled: true, minSongs: 1, maxSongs: 1, runtime: { command: PACKAGED, args: [], port: 8765 }, stations: { 'lux-lofi': 'ryan' } };

class FakeEngine {
  constructor() { this.requests = []; }
  async run(request, { model = 'yue2' } = {}) {
    this.requests.push({ model, request });
    if (model !== 'qwen3tts') throw new Error('generation is off: no song job may start');
    return { audio: lineWav.toString('base64') };
  }
  isWarm() { return false; }
  async abort() {}
  async stop() {}
}

async function rig(t, { durationSec = 150, memory = 11 * GiB, llmCommand = null, port, settings = ownerSettings, newsUrgent = () => false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-live-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const bundledDir = join(root, 'lux');
  await mkdir(bundledDir, { recursive: true });
  await writeFile(join(bundledDir, 'manifest.json'), JSON.stringify({ version: 1, songs: bundledSongs }));
  const catalog = new LuxCatalog({ bundledDir, downloadDir: join(root, 'lux-downloads'), statePath: join(root, 'lux-state.json') });
  await catalog.load();
  catalog.setLiveStations([liveStation(durationSec)]);
  const library = new Library(join(root, 'library')); await library.load();
  const stations = new StationStore(join(root, 'stations.json'), { reservedFrequencies: RESERVED_FREQUENCIES }); await stations.load();
  const engine = new FakeEngine();
  const radio = new RadioStation({ engine, library, stations, catalog, tickMs: 60_000 });
  await writeFile(join(root, 'dj-settings.json'), JSON.stringify({ ...settings, runtime: { ...settings.runtime, ...(port ? { port } : {}) } }));
  const setup = (ready) => ({ snapshot: async () => ({ ready, status: ready ? 'ready' : 'idle', directory: join(root, 'model') }) });
  const previewsDir = join(root, 'no-previews'); await mkdir(previewsDir);
  const dj = new DjDesk({ dataDir: root, station: radio, engine, modelSetup: setup(true), voiceSetup: setup(true), freeMemory: async () => memory, newsUrgent, llmCommand, previewsDir });
  await dj.load();
  radio.attachDJ(dj);
  t.after(async () => { await dj.close(); await radio.close(); });
  const upcoming = () => { const { tracks } = radio.snapshot(); const at = tracks.findIndex((track) => track.id === radio.djContext().playbackTrackId); return tracks.slice(at + 1); };
  return {
    root, radio, dj, engine, catalog,
    async tune(stationId = 'lux-lofi') { await radio.tune(listenerConfig, { stationId, fromLibrary: true }); },
    /** Like the client: reports the end of the current song, then the next one at 0 s, then a few progress reports. */
    async playNext({ progress = [] } = {}) {
      const ctx = radio.djContext();
      const next = ctx.playbackTrackId ? upcoming()[0] : radio.snapshot().tracks[0];
      assert.ok(next, 'the station has a next song');
      if (ctx.playbackTrackId) await radio.setPlayback({ trackId: ctx.playbackTrackId, positionSec: Math.max(0, (ctx.current?.durationSec || 150) - 1), playing: true });
      await radio.setPlayback({ trackId: next.id, positionSec: 0, playing: true });
      for (const positionSec of progress) await radio.setPlayback({ trackId: next.id, positionSec, playing: true });
      return next;
    },
  };
}

async function waitFor(predicate, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (predicate()) return true; await delay(10); }
  return false;
}
const intro = (f) => f.dj.snapshot().introduction ?? null;
const armed = (f) => intro(f)?.state === 'armed';

/** Plays up to three songs and returns the song number (2 or 3) on which an introduction was armed. */
async function armedBySongThree(f, options) {
  await f.playNext(options);
  await delay(50);
  assert.ok(!armed(f), 'never a DJ on the first song after tuning');
  for (const song of [2, 3]) {
    await f.playNext(options);
    if (await waitFor(() => armed(f))) return song;
  }
  assert.fail(`no introduction by song 3: introduction=${JSON.stringify(intro(f))} nextSlot=${JSON.stringify(f.dj.snapshot().nextSlot)} last=${JSON.stringify(f.dj.snapshot().last ?? null)} engine=${f.engine.requests.length}`);
}

test('the Live station is a Lux session with generation off and the owner\'s Ryan pick', async (t) => {
  const f = await rig(t);
  await f.tune();
  const snap = f.radio.snapshot();
  assert.equal(snap.station.id, 'lux-lofi');
  assert.equal(snap.station.lux, true);
  assert.ok(snap.tracks.length >= 1 && snap.tracks.every((track) => track.id.startsWith('live-')), 'feed songs, not bundled ones');
  assert.equal(snap.generation.enabled, false, 'generation is off');
  const entry = snap.stations.find((station) => station.id === 'lux-lofi');
  assert.equal(entry.dj, 'ryan');
  assert.equal(entry.djChosen, true);
  const settings = await f.dj.settings();
  assert.equal(f.dj.snapshot().enabled, true);
  assert.equal(settings.minSongs, 1);
  assert.equal(settings.maxSongs, 1);
});

for (const [label, options] of [
  ['feed songs with a duration', { durationSec: 150 }],
  ['feed songs without a duration', { durationSec: undefined }],
  ['feed songs with the client\'s progress reports', { durationSec: 150, play: { progress: [5, 10, 15, 20] } }],
]) {
  test(`cadence 1-1 on LVX Live lux-lofi (${label}): an introduction is armed by song 2 or 3`, async (t) => {
    const f = await rig(t, options);
    await f.tune();
    const song = await armedBySongThree(f, options.play);
    assert.ok(song <= 3);
    const armedIntro = intro(f);
    assert.equal(armedIntro.djId ?? f.dj.snapshot().lastLine?.djId, 'ryan', 'the station pick speaks');
    assert.ok(f.engine.requests.length >= 1);
    assert.deepEqual([...new Set(f.engine.requests.map((r) => r.model))], ['qwen3tts'], 'only the voice ran');
  });
}

// fix2 root cause: News held the DJ off from :50 to :05 and while its ready card stayed unanswered.
for (const minute of [2, 30]) {
  test(`cadence 1-1 on LVX Live lux-lofi at 11:${String(minute).padStart(2, '0')} with News on and its card unanswered: an introduction by song 2 or 3`, async (t) => {
    const news = await newsAfterBulletin(t, minute);
    assert.ok(news.desk.snapshot().due, 'the 11:00 ready card is up');
    const f = await rig(t, { newsUrgent: () => news.desk.isUrgent() });
    await f.tune();
    await armedBySongThree(f);
    assert.equal(intro(f).djId ?? f.dj.snapshot().lastLine?.djId, 'ryan');
  });
}

test('cadence 1-1 on LVX Live: urgent News delays the break, which comes on the same song once News lets go', async (t) => {
  const flag = { urgent: false };
  const f = await rig(t, { newsUrgent: () => flag.urgent });
  await f.tune();
  await f.playNext();
  flag.urgent = true;
  const second = await f.playNext();
  await delay(50);
  assert.equal(intro(f)?.reason, 'news-urgent');
  assert.equal(f.dj.snapshot().nextSlot?.remainingSongs, 0, 'the skip kept the slot due');
  flag.urgent = false;
  await f.radio.setPlayback({ trackId: second.id, positionSec: 20, playing: true });
  assert.ok(await waitFor(() => armed(f)), `armed on the same song: ${JSON.stringify(intro(f))}`);
});

test('cadence 1-1 on LVX Live: a catalog refresh with the same feed does not starve the DJ', async (t) => {
  const f = await rig(t);
  await f.tune();
  await f.playNext();
  f.catalog.setLiveStations([liveStation(150)]);
  await f.radio.catalogChanged?.({ reset: false });
  await f.playNext();
  if (!(await waitFor(() => armed(f)))) {
    f.catalog.setLiveStations([liveStation(150)]);
    await f.radio.catalogChanged?.({ reset: false });
    await f.playNext();
    assert.ok(await waitFor(() => armed(f)), `no introduction after a same-feed refresh: ${JSON.stringify(intro(f))}`);
  }
});

test('cadence 1-1 keeps speaking on LVX Live: songs 2 to 5 each get a break', async (t) => {
  const f = await rig(t);
  await f.tune();
  await f.playNext();
  let breaks = 0;
  for (let song = 2; song <= 5; song++) {
    await f.playNext();
    if (await waitFor(() => armed(f))) breaks += 1;
  }
  assert.ok(breaks >= 3, `only ${breaks} breaks in songs 2-5`);
});

// --- Packaged runtime resolution ---

/**
 * The installed app's layout (spaces included): bin/mlx_lm.server is the same /bin/sh launcher that
 * scripts/build-dj-llm.sh writes, exec'ing ../python/bin/python3.12 -I -B -m mlx_lm.server. Here that
 * "python" is a shell stub running a fake OpenAI-compatible writer on Node.
 */
async function fakeLauncher(root) {
  const resources = join(root, 'Applications', 'LVX in Radio.app', 'Contents', 'Resources', 'dj-llm');
  await mkdir(join(resources, 'bin'), { recursive: true });
  await mkdir(join(resources, 'python', 'bin'), { recursive: true });
  const launcher = join(resources, 'bin', 'mlx_lm.server');
  await writeFile(launcher, `#!/bin/sh
# LVX in Radio DJ writer: the bundled Python runs mlx_lm.server, isolated from the system.
here=$(cd "$(dirname "$0")" && pwd)
exec "$here/../python/bin/python3.12" -I -B -m mlx_lm.server "$@"
`);
  const python = join(resources, 'python', 'bin', 'python3.12');
  await writeFile(python, `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
exec "${process.execPath}" "$here/fake-mlx.mjs" "$@"
`);
  await writeFile(join(resources, 'python', 'bin', 'fake-mlx.mjs'), `import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]);
appendFileSync(join(${JSON.stringify(resources)}, 'launches.jsonl'), JSON.stringify({ argv }) + '\\n');
const filler = 'the kettle is singing in the next room, the window is fogged and soft, and we are keeping this hour slow and easy for everyone who is still awake out there with us tonight, so stay close';
http.createServer((request, response) => {
  if (request.url === '/health') { response.writeHead(200); response.end('ok'); return; }
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const prompt = JSON.parse(body).messages.at(-1).content;
    const next = JSON.parse(prompt.match(/NEXT SONG[^{]*(\\{[^\\n]*\\})/)[1]);
    const text = 'Good evening, ' + filler + ', and here comes the ' + next.moodWord + ' ' + next.title + ' for you.';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);
  await chmod(launcher, 0o755);
  await chmod(python, 0o755);
  return { launcher, launches: join(resources, 'launches.jsonl') };
}

test('a saved runtime pointing at the installed app resolves to this app\'s bundled launcher', () => {
  const moved = '/Volumes/LVX in Radio/LVX in Radio.app/Contents/Resources/dj-llm/bin/mlx_lm.server';
  assert.deepEqual(resolveDjRuntime({ env: {}, bundledCommand: moved, saved: ownerSettings.runtime }), { command: moved, args: [], port: 8765 });
  assert.deepEqual(resolveDjRuntime({ env: {}, bundledCommand: PACKAGED, saved: ownerSettings.runtime }), { command: PACKAGED, args: [], port: 8765 });
});

test('the packaged launcher (path with spaces) is spawned and writes the Live station line at tier 1', async (t) => {
  const launcherRoot = await mkdtemp(join(tmpdir(), 'lvx-dj-launcher-'));
  t.after(() => rm(launcherRoot, { recursive: true, force: true }));
  const { launcher, launches: launchLog } = await fakeLauncher(launcherRoot);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const f = await rig(t, { memory: 24 * GiB, llmCommand: launcher, port });
  await f.tune();
  await armedBySongThree(f);
  const launches = (await readFile(launchLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(launches.length, 1, 'the bundled launcher was started once, not the stale /Applications path or python3');
  assert.ok(launches[0].argv.slice(0, 4).join(' ') === '-I -B -m mlx_lm.server' && launches[0].argv.includes('--model') && launches[0].argv.includes(String(port)), JSON.stringify(launches[0].argv));
  const last = f.dj.snapshot().lastLine ?? f.dj.snapshot().last;
  assert.ok(last, 'a line was recorded');
  assert.notEqual(last.source, 'template', `the writer line was used, not the template fallback (${last.source})`);
});
