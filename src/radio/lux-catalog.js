import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

import { GENRES, validateConfig } from './style.js';

export const MANIFEST_VERSION = 1;

const SAFE_ID = /^[\w-]{1,80}$/;
const SAFE_FILE = /^[\w/-]+\.mp3$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_TITLE_CHARS = 80;
const MAX_DURATION_SEC = 900;
const MAX_SONG_BYTES = 40 * 1024 ** 2;

function stationConfig(genre, energy, bpm, dark) {
  return { mix: { [genre]: 100 }, energy, bpm, dark, melody: true, mode: 'Direct', mood: '', flavors: [] };
}

/**
 * The stations that ship with the app. Frequencies are reserved, so a listener's
 * own stations never land on them. The feed adds songs, never stations.
 */
export const LUX_STATIONS = [
  { id: 'lux-edm', k: 11, name: 'LVX EDM', quote: 'The room goes dark, and the first kick lands.', config: stationConfig('EDM', 80, 124, 60) },
  { id: 'lux-rock', k: 21, name: 'LVX Rock', quote: 'Amps warm, windows open, nobody asks you to turn it down.', config: stationConfig('Rock', 72, 124, 40) },
  { id: 'lux-pop', k: 2, name: 'LVX Pop', quote: 'The chorus you know by the second time around.', config: stationConfig('Pop', 68, 112, 20) },
  { id: 'lux-relax', k: 18, name: 'LVX Relax', quote: 'Soft light, open space, a little room to breathe.', config: { ...stationConfig('Ambient', 24, 74, 20), mix: { Ambient: 70, Classical: 20, Pop: 10 } } },
];

export const RESERVED_FREQUENCIES = LUX_STATIONS.map((station) => station.k);

/**
 * Validates a manifest and returns its usable songs. A feed is remote input, so
 * a bad entry is dropped on its own and never reaches the file system or the UI.
 */
export function parseManifest(manifest) {
  if (manifest?.version !== MANIFEST_VERSION || !Array.isArray(manifest.songs)) {
    throw new TypeError('Unsupported station manifest');
  }
  const songs = [];
  for (const entry of manifest.songs) {
    const station = LUX_STATIONS.find(({ id }) => id === entry?.station);
    const validSource = entry?.file ? SAFE_FILE.test(entry.file) && !entry.file.includes('..') : isDownloadUrl(entry?.url);
    if (
      !station ||
      !SAFE_ID.test(entry.id ?? '') ||
      !validSource ||
      typeof entry.title !== 'string' ||
      !entry.title.trim() ||
      !(entry.durationSec > 0 && entry.durationSec <= MAX_DURATION_SEC) ||
      !SHA256.test(entry.sha256 ?? '') ||
      !(entry.sizeBytes > 0 && entry.sizeBytes <= MAX_SONG_BYTES)
    ) {
      console.error(`Skipping an invalid station song: ${String(entry?.id).slice(0, MAX_TITLE_CHARS)}`);
      continue;
    }
    let generation = station.config;
    try {
      validateConfig(entry.generation);
      generation = entry.generation;
    } catch {
      // The station's own settings describe a song that carries none of its own.
    }
    // Optional mood for the DJ (one word is spoken): remote input, letters and spaces only.
    const mood = typeof entry.mood === 'string' ? entry.mood.trim() : '';
    if (mood && mood.length <= 40 && /^[A-Za-z][A-Za-z ]*$/.test(mood)) generation = { ...generation, mood };
    songs.push({
      id: entry.id,
      station: station.id,
      title: entry.title.trim().slice(0, MAX_TITLE_CHARS),
      durationSec: entry.durationSec,
      truncated: entry.truncated === true,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      generation,
      ...(entry.file ? { file: entry.file } : { url: entry.url }),
    });
  }
  return songs;
}

function isDownloadUrl(value) {
  try {
    const { protocol, hostname } = new URL(value);
    return protocol === 'https:' || (protocol === 'http:' && hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * Songs for the Lux stations: some inside the app, more added by the feed. They
 * stay apart from the listener's library, so its limits never remove them and
 * they never replay on a station the listener made.
 */
export class LuxCatalog {
  #bundledDir;
  #downloadDir;
  #statePath;
  #songs = new Map();
  #liveStations = [];
  #liveSongs = new Map();
  #retired = new Map();
  #failed = new Set();
  #state = { songs: {}, stations: {} };

  constructor({ bundledDir, downloadDir, statePath }) {
    this.#bundledDir = bundledDir;
    this.#downloadDir = downloadDir;
    this.#statePath = statePath;
  }

  async load() {
    await this.#loadManifest(this.#bundledDir);
    await this.#loadManifest(this.#downloadDir);
    try {
      const saved = JSON.parse(await readFile(this.#statePath, 'utf8'));
      this.#state = { songs: saved.songs ?? {}, stations: saved.stations ?? {} };
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read Lux station state:', error.message);
    }
  }

  async #loadManifest(directory) {
    try {
      const songs = parseManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
      for (const song of songs) {
        const path = resolve(directory, song.file ?? `${song.id}.mp3`);
        if (path.startsWith(resolve(directory) + sep)) this.#songs.set(song.id, { ...song, path });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read a station manifest:', error.message);
    }
  }

  /** Station records in the same shape as a listener's saved stations. */
  bundledStations() {
    return LUX_STATIONS.map((station) => ({
      ...station,
      lux: true,
      lastPlayedAt: this.#state.stations[station.id] ?? null,
    }));
  }

  stations() {
    const all = new Map(this.bundledStations().map(station => [station.id, station]));
    for (const station of this.#liveStations) all.set(station.id, { ...station, lastPlayedAt: this.#state.stations[station.id] ?? null });
    return [...all.values()];
  }

  setLiveStations(stations) {
    for (const [id, song] of this.#liveSongs) this.#retired.set(id, song);
    while (this.#retired.size > 10000) this.#retired.delete(this.#retired.keys().next().value);
    this.#liveSongs = new Map(); this.#failed.clear();
    this.#liveStations = stations.map(station => {
      const bundled = LUX_STATIONS.find(entry => entry.id === station.id);
      // Remote genre names never become generation controls or model requests.
      const genre = GENRES.find(genre => genre.toLowerCase() === station.genre.toLowerCase()) ?? 'Pop';
      const config = bundled?.config ?? stationConfig(genre,50,100,30);
      for (const track of station.tracks) {
        const existing = this.#songs.get(track.id);
        const id = existing?.station === station.id ? track.id : `live-${createHash('sha256').update(station.id + '\0' + track.id).digest('hex').slice(0,32)}`;
        this.#liveSongs.set(id, { ...track, id, station: station.id, generation: config, createdAt: new Date(0).toISOString(), remoteUrl: track.url, remoteOrigin: station.catalogUrl, mediaKey: createHash('sha256').update(station.catalogUrl + '\0' + track.url).digest('hex').slice(0,24) });
      }
      return { id: station.id, k: station.k, name: station.name, quote: station.description, genre: station.genre, config, lux:true, live:true };
    });
  }

  failRemote(id) { this.#failed.add(id); }

  #stationSongs(id) {
    const live = [...this.#liveSongs.values()].filter(song => song.station === id && !this.#failed.has(song.id));
    return live.length ? live : [...this.#songs.values()].filter(song => song.station === id);
  }

  station(id) {
    return this.stations().find((station) => station.id === id) ?? null;
  }

  has(songId) {
    return this.#songs.has(songId) || this.#liveSongs.has(songId) || this.#retired.has(songId);
  }

  audioPath(songId) {
    return this.#songs.get(songId)?.path ?? null;
  }

  countForStation(stationId) {
    let count = 0;
    for (const song of this.#stationSongs(stationId)) {
      if (song.station === stationId && !this.#state.songs[song.id]?.disliked) count += 1;
    }
    return count;
  }

  /**
   * The longest unheard song, liked songs first. A station whose songs were all
   * disliked keeps playing them: a radio should not fall silent over that.
   */
  pick(stationId, excludedIds) {
    const all = this.#stationSongs(stationId).filter((song) => !excludedIds.has(song.id));
    const liked = all.filter((song) => !this.#state.songs[song.id]?.disliked);
    const candidates = (liked.length ? liked : all).map((song) => ({ ...song, ...this.#state.songs[song.id] }));
    candidates.sort(
      (a, b) => Boolean(b.liked) - Boolean(a.liked) || (a.lastPlayedAt ?? '').localeCompare(b.lastPlayedAt ?? ''),
    );
    const [best] = candidates;
    return best ? { liked: false, ...best } : null;
  }

  /** Lists a song the feed has finished downloading. */
  add(song, path) {
    this.#songs.set(song.id, { ...song, path });
  }

  downloadedPath(songId) {
    return join(this.#downloadDir, `${songId}.mp3`);
  }

  /** Records a downloaded song, so it survives a restart without the network. */
  async saveDownloads() {
    const downloaded = [...this.#songs.values()].filter((song) => song.url);
    const songs = downloaded.map(({ path, ...song }) => song);
    await this.#write(join(this.#downloadDir, 'manifest.json'), { version: MANIFEST_VERSION, songs });
  }

  update(songId, changes) {
    if (!this.has(songId)) throw new RangeError('Unknown song');
    this.#state.songs[songId] = { ...this.#state.songs[songId], ...changes };
    return this.#saveState();
  }

  touchStation(stationId) {
    this.#state.stations[stationId] = new Date().toISOString();
    return this.#saveState();
  }

  #saveState() {
    return this.#write(this.#statePath, this.#state);
  }

  async #write(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, path);
  }
}
