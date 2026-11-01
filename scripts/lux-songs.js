#!/usr/bin/env node
/**
 * Makes the songs for the Lux stations.
 *
 *   generate   Composes songs until each station has --count. Safe to stop and rerun.
 *   import     Converts existing audio files into a station, without generating.
 *   manifest   Writes manifest.json for a folder of songs.
 *
 * Run `node scripts/lux-songs.js help` for the options.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig } from '../src/config.js';
import { AudioCppEngine } from '../src/engine/audiocpp.js';
import { wavDurationSeconds } from '../src/engine/wav.js';
import { LUX_STATIONS, MANIFEST_VERSION, parseManifest } from '../src/radio/lux-catalog.js';
import { directRequest, wasTruncated } from '../src/radio/station.js';
import { validateConfig } from '../src/radio/style.js';

const HELP = `Usage: node scripts/lux-songs.js <command> [options]

generate   --count 20 --stations edm,rock,pop --out lux-songs
           Composes until each station has --count songs. Stop it at any time with
           Ctrl-C and rerun the same command to continue.

import     --station edm --out lux [--title "Name"] file.wav [more files]
           Converts audio you already have. Without generating anything.

manifest   --out lux-songs [--base-url https://example.com/songs]
           Writes manifest.json. With --base-url the songs are listed for download;
           without it they are listed as files beside the manifest, as the app ships them.
           Delete a song's .mp3 first to leave it out.
`;

const MP3_BITRATE = '256k';
const MAX_FAILURES_IN_A_ROW = 3;
const SEED_LIMIT = 2 ** 47;

/** Each station cycles through these, so a long run does not sound like one song. */
const VARIATIONS = {
  'lux-edm': [
    { flavors: ['edm-festival'], energy: 86, bpm: 126, dark: 45 },
    { flavors: ['edm-journey'], energy: 62, bpm: 122, dark: 60 },
    { flavors: ['edm-ethereal'], energy: 70, bpm: 124, dark: 35 },
    { flavors: ['edm-warehouse'], energy: 88, bpm: 128, dark: 80 },
    { flavors: ['edm-drop', 'techno-melodic'], energy: 92, bpm: 126, dark: 55, mix: { EDM: 75, Techno: 25 } },
  ],
  'lux-rock': [
    { flavors: ['rock-arena'], energy: 82, bpm: 128, dark: 30 },
    { flavors: ['rock-garage'], energy: 86, bpm: 142, dark: 55 },
    { flavors: ['rock-blues'], energy: 55, bpm: 96, dark: 45 },
    { flavors: ['rock-alt'], energy: 70, bpm: 118, dark: 50 },
    { flavors: ['rock-soar'], energy: 66, bpm: 110, dark: 25 },
  ],
  'lux-pop': [
    { flavors: ['pop-stadium'], energy: 82, bpm: 120, dark: 15 },
    { flavors: ['pop-neon'], energy: 72, bpm: 116, dark: 35 },
    { flavors: ['pop-sun'], energy: 74, bpm: 108, dark: 10 },
    { flavors: ['pop-dream'], energy: 45, bpm: 92, dark: 30 },
    { flavors: ['pop-hook'], energy: 78, bpm: 124, dark: 15 },
  ],
  'lux-relax': [
    { energy: 18, bpm: 70, dark: 20 },
    { energy: 28, bpm: 78, dark: 30 },
    { energy: 22, bpm: 74, dark: 15 },
  ],
};

const TITLE_WORDS = {
  'lux-edm': [
    ['Midnight', 'Glass', 'Afterglow', 'Pulse', 'Violet', 'Silver', 'Distant', 'Electric', 'Hollow', 'Solar'],
    ['Cathedral', 'Horizon', 'Machine', 'Bloom', 'Current', 'Signal', 'Mirage', 'Orbit', 'Rapture', 'Tide'],
  ],
  'lux-rock': [
    ['Broken', 'Burning', 'Rust', 'Wild', 'Black', 'Last', 'Loud', 'Southern', 'Iron', 'Runaway'],
    ['Highway', 'Amplifier', 'Summer', 'Saints', 'Motel', 'Thunder', 'Engine', 'Canyon', 'Radio', 'Skyline'],
  ],
  'lux-pop': [
    ['Sugar', 'Golden', 'Paper', 'Neon', 'Sunday', 'Velvet', 'Cherry', 'Lucky', 'Crystal', 'Summer'],
    ['Heart', 'Parade', 'Daydream', 'Balloon', 'Weekend', 'Postcard', 'Kiss', 'Satellite', 'Lights', 'Rollercoaster'],
  ],
  'lux-relax': [
    ['Quiet', 'Soft', 'Morning', 'Warm', 'Distant'],
    ['Light', 'Tide', 'Garden', 'Air', 'Window'],
  ],
};

function stationNamed(short) {
  const station = LUX_STATIONS.find(({ id }) => id === `lux-${short}` || id === short);
  if (!station) throw new Error(`Unknown station "${short}". Use ${LUX_STATIONS.map(({ id }) => id.slice(4)).join(', ')}.`);
  return station;
}

function requireTool(tool, args, hint) {
  if (spawnSync(tool, args, { stdio: 'ignore' }).status !== 0) throw new Error(`${tool} is required. ${hint}`);
}

function convertToMp3(source, target) {
  // An MP3 is copied as it is: encoding it again would only lose quality.
  const codec = source.toLowerCase().endsWith('.mp3') ? ['-c:a', 'copy'] : ['-c:a', 'libmp3lame', '-b:a', MP3_BITRATE];
  const { status, stderr } = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', source, '-vn', '-map_metadata', '-1', '-id3v2_version', '0', ...codec, target],
    { encoding: 'utf8' },
  );
  if (status !== 0) throw new Error(`ffmpeg could not convert ${source}: ${stderr}`);
}

function audioDuration(path) {
  const { status, stdout } = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  const seconds = Number(stdout);
  if (status !== 0 || !(seconds > 0)) throw new Error(`Could not read the length of ${path}`);
  return seconds;
}

/** Songs already made for a station, read from the metadata beside each MP3. */
async function storedSongs(out, station) {
  const directory = join(out, station.id);
  if (!existsSync(directory)) return [];
  const songs = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    if (existsSync(path.replace(/\.json$/, '.mp3'))) songs.push(JSON.parse(await readFile(path, 'utf8')));
  }
  return songs;
}

function titleFor(station, seed, taken) {
  const [first, second] = TITLE_WORDS[station.id];
  for (let offset = 0; offset < first.length * second.length; offset += 1) {
    const value = seed + offset;
    const title = `${first[value % first.length]} ${second[Math.floor(value / first.length) % second.length]}`;
    if (!taken.has(title)) return title;
  }
  return `${station.name} ${seed % 10_000}`;
}

async function storeSong(out, station, song, sourceAudio) {
  const directory = join(out, station.id);
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${song.id}.mp3`);
  convertToMp3(sourceAudio, target);
  await writeFile(join(directory, `${song.id}.json`), JSON.stringify(song, null, 2));
  return target;
}

/** The variation for the next song, built so the app accepts it as a real station. */
function nextGeneration(station, index) {
  const variations = VARIATIONS[station.id];
  const generation = { ...station.config, ...variations[index % variations.length] };
  validateConfig(generation);
  return generation;
}

function keepMacAwake() {
  if (process.platform !== 'darwin') return;
  const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

async function generate(values) {
  const out = resolve(values.out ?? 'lux-songs');
  const count = Number(values.count ?? 20);
  if (!(count > 0)) throw new Error('--count must be a positive number');
  const stations = (values.stations ?? 'edm,rock,pop').split(',').map((name) => stationNamed(name.trim()));
  requireTool('ffmpeg', ['-version'], 'Install it with: brew install ffmpeg');

  const { engine: engineConfig } = loadConfig();
  for (const path of [engineConfig.binary, join(engineConfig.modelDir, engineConfig.modelFile), join(engineConfig.modelDir, engineConfig.vaeFile)]) {
    if (!existsSync(path)) throw new Error(`Not found: ${path}\nSee "Making Lux songs" in README.md for what this Mac needs.`);
  }
  const engine = new AudioCppEngine({ ...engineConfig, dataDir: join(out, '.engine') });
  const workDir = join(out, '.work');
  await mkdir(workDir, { recursive: true });

  let stopping = false;
  const stop = () => {
    stopping = true;
    console.log('\nStopping. Run the same command again to continue.');
    engine.abort().catch(() => {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  keepMacAwake();

  const started = Date.now();
  let made = 0;
  let failures = 0;
  for (;;) {
    const progress = await Promise.all(stations.map(async (station) => ({ station, songs: await storedSongs(out, station) })));
    const next = progress.filter(({ songs }) => songs.length < count).sort((a, b) => a.songs.length - b.songs.length)[0];
    if (!next || stopping) break;
    const { station, songs } = next;
    const remaining = progress.reduce((total, entry) => total + Math.max(count - entry.songs.length, 0), 0);
    const eta = made ? ` · about ${Math.round((((Date.now() - started) / made) * remaining) / 60_000)} min left` : '';
    console.log(`${station.name}: song ${songs.length + 1} of ${count} · ${remaining} to go${eta}`);

    const seed = randomInt(SEED_LIMIT);
    const generation = nextGeneration(station, songs.length);
    const songStarted = Date.now();
    try {
      const result = await engine.run(directRequest(generation, seed));
      if (!result.audio) throw new Error('The engine returned no audio');
      const wav = Buffer.from(result.audio, 'base64');
      const id = randomUUID();
      const source = join(workDir, `${id}.wav`);
      await writeFile(source, wav);
      const title = titleFor(station, seed, new Set(songs.map((song) => song.title)));
      const durationSec = wavDurationSeconds(wav);
      await storeSong(
        out,
        station,
        { id, station: station.id, title, durationSec, truncated: wasTruncated(result), createdAt: new Date().toISOString(), seed, generation },
        source,
      );
      await rm(source, { force: true });
      made += 1;
      failures = 0;
      console.log(`  ${title} · ${Math.round(durationSec)} s · composed in ${Math.round((Date.now() - songStarted) / 1000)} s`);
    } catch (error) {
      if (stopping) break;
      failures += 1;
      console.error(`  Failed: ${error.message}`);
      if (failures >= MAX_FAILURES_IN_A_ROW) {
        await engine.stop();
        throw new Error(`Stopped after ${failures} failures in a row. See ${join(out, '.engine', 'engine.log')}.`);
      }
    }
  }
  await engine.stop();
  await rm(workDir, { recursive: true, force: true });
  console.log(`Made ${made} songs in ${Math.round((Date.now() - started) / 60_000)} min, in ${out}`);
  if (!stopping) await writeManifest({ out, baseUrl: null });
}

async function importSongs(values, files) {
  if (!values.station) throw new Error('import needs --station');
  if (!values.out) throw new Error('import needs --out');
  if (!files.length) throw new Error('import needs at least one audio file');
  requireTool('ffmpeg', ['-version'], 'Install it with: brew install ffmpeg');
  const station = stationNamed(values.station);
  const out = resolve(values.out);
  const taken = new Set((await storedSongs(out, station)).map((song) => song.title));
  for (const file of files) {
    const seed = randomInt(SEED_LIMIT);
    const title = (files.length === 1 && values.title) || titleFor(station, seed, taken);
    taken.add(title);
    const song = {
      id: randomUUID(),
      station: station.id,
      title,
      durationSec: audioDuration(file),
      truncated: false,
      createdAt: new Date().toISOString(),
      generation: station.config,
    };
    await storeSong(out, station, song, file);
    console.log(`${station.name}: ${title} · ${Math.round(song.durationSec)} s`);
  }
  await writeManifest({ out, baseUrl: null });
}

async function writeManifest({ out, baseUrl }) {
  const songs = [];
  for (const station of LUX_STATIONS) {
    for (const song of await storedSongs(out, station)) {
      const path = join(out, station.id, `${song.id}.mp3`);
      const audio = await readFile(path);
      const { seed, ...listed } = song;
      songs.push({
        ...listed,
        sizeBytes: (await stat(path)).size,
        sha256: createHash('sha256').update(audio).digest('hex'),
        ...(baseUrl ? { url: `${baseUrl.replace(/\/$/, '')}/${song.id}.mp3` } : { file: relative(out, path) }),
      });
    }
  }
  const manifest = { version: MANIFEST_VERSION, songs };
  if (parseManifest(manifest).length !== songs.length) throw new Error('Some songs did not pass validation; see above.');
  const target = join(out, 'manifest.json');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(manifest, null, 2));
  console.log(`${target}: ${songs.length} songs`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      count: { type: 'string' },
      stations: { type: 'string' },
      station: { type: 'string' },
      out: { type: 'string' },
      title: { type: 'string' },
      'base-url': { type: 'string' },
    },
  });
  const [command, ...files] = positionals;
  if (command === 'generate') await generate(values);
  else if (command === 'import') await importSongs(values, files);
  else if (command === 'manifest') await writeManifest({ out: resolve(values.out ?? 'lux-songs'), baseUrl: values['base-url'] ?? null });
  else console.log(HELP);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
