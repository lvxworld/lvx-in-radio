import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import { bucketFor } from './library.js';

const FREQUENCY_COUNT = 26;
const FIRST_FREQUENCY = 6;
const MAX_TEXT_CHARS = 80;

function soundKey(config) {
  return `${config.scenario ?? ''}|${config.mood}|${bucketFor(config)}`;
}

function cleanText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT_CHARS) : fallback;
}

/** The stations a listener has created, each on its own frequency. */
export class StationStore {
  #path;
  #stations = [];
  #reserved;

  constructor(path, { reservedFrequencies = [] } = {}) {
    this.#path = path;
    this.#reserved = reservedFrequencies;
  }

  async load() {
    try {
      this.#stations = JSON.parse(await readFile(this.#path, 'utf8'));
      // A new bundled station may reserve a frequency from an older app version.
      // Move only the dial position, keeping the station id and all its songs.
      const occupied = new Set([...this.#reserved, ...this.#stations.map(station => station.k)]);
      let moved = false;
      for (const station of this.#stations) {
        if (!this.#reserved.includes(station.k)) continue;
        const free = Array.from({ length: FREQUENCY_COUNT }, (_, k) => k).filter(k => !occupied.has(k));
        free.sort((a, b) => Math.abs(a - station.k) - Math.abs(b - station.k));
        if (!free.length) throw new Error('No free frequency for this saved station');
        station.k = free[0];
        occupied.add(station.k);
        moved = true;
      }
      if (moved) await this.#save();
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read saved stations:', error.message);
    }
  }

  list() {
    return this.#stations;
  }

  /** Live stations take only unused slots, never relocate listener stations. */
  reserveFrequencies(frequencies) {
    this.#reserved = [...new Set(frequencies)];
  }

  get(id) {
    return this.#stations.find((station) => station.id === id) ?? null;
  }

  /** The same sound returns to its station; a new sound gets a new frequency. */
  async open(config, { name, quote, chosenName }) {
    let station = this.#stations.find((entry) => soundKey(entry.config) === soundKey(config));
    if (!station) {
      const k = this.#freeFrequency();
      station = {
        id: randomUUID(),
        k,
        name: cleanText(chosenName ?? name, `Station ${k + 1}`),
        quote: cleanText(quote, ''),
        firstSeed: config.seed,
        createdAt: new Date().toISOString(),
      };
      this.#stations.push(station);
    }
    Object.assign(station, { config, lastPlayedAt: new Date().toISOString() });
    if (chosenName) station.name = cleanText(chosenName, station.name);
    await this.#save();
    return station;
  }

  async rename(id, name) {
    const station = this.get(id);
    if (!station) throw new RangeError('Unknown station');
    station.name = cleanText(name, station.name);
    await this.#save();
  }

  async touch(station, changes = {}) {
    Object.assign(station, changes, { lastPlayedAt: new Date().toISOString() });
    await this.#save();
  }

  /** Takes the free frequency farthest from the others, recycling when full. */
  #freeFrequency() {
    if (this.#reserved.length >= FREQUENCY_COUNT) throw new RangeError('The radio dial is full. Turn off LVX Live to create another station.');
    if (!this.#stations.length && !this.#reserved.includes(FIRST_FREQUENCY)) return FIRST_FREQUENCY;
    if (this.#stations.length >= FREQUENCY_COUNT - this.#reserved.length) {
      const oldest = this.#stations.reduce((a, b) => (a.lastPlayedAt < b.lastPlayedAt ? a : b));
      this.#stations = this.#stations.filter((station) => station !== oldest);
      return oldest.k;
    }
    const used = [...this.#reserved, ...this.#stations.map((station) => station.k)];
    let best = 0;
    let bestGap = -1;
    for (let k = 0; k < FREQUENCY_COUNT; k += 1) {
      const gap = Math.min(...used.map((other) => Math.abs(other - k)));
      if (gap > bestGap) {
        best = k;
        bestGap = gap;
      }
    }
    return best;
  }

  async #save() {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, JSON.stringify(this.#stations));
    await rename(temporary, this.#path);
  }
}
