import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_UNLIKED_PER_BUCKET = 12;
const MAX_UNLIKED_BYTES = 3 * 1024 ** 3;
const BUCKET_GENRES = 2;

function energyBand(energy) {
  if (energy < 30) return 'calm';
  if (energy < 70) return 'steady';
  return 'high';
}

function isKept(song) {
  return song.liked || Boolean(song.stationId);
}

/**
 * Groups songs that can stand in for each other: the two strongest genres and
 * the energy band. Small changes to the controls stay in the same bucket.
 */
export function bucketFor({ mix, energy, instrumental }) {
  const genres = Object.entries(mix)
    .sort(([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB))
    .slice(0, BUCKET_GENRES)
    .map(([name]) => name.toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .sort();
  return `${genres.join('+')}-${energyBand(energy)}${instrumental ? '-instrumental' : ''}`;
}

/**
 * Generated songs on disk, as `<bucket>/<id>.wav` with a `.json` beside it.
 * A song on a listener's station stays until they reject it, and a liked song
 * stays until they remove the like. The limits only apply to the other songs.
 */
export class Library {
  #root;
  #songs = new Map();
  #songWrites = new Map();

  constructor(root) {
    this.#root = root;
  }

  async load() {
    await mkdir(this.#root, { recursive: true });
    const buckets = await readdir(this.#root, { withFileTypes: true });
    for (const bucket of buckets.filter((entry) => entry.isDirectory())) {
      const directory = join(this.#root, bucket.name);
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.json')) continue;
        try {
          const song = JSON.parse(await readFile(join(directory, name), 'utf8'));
          this.#songs.set(song.id, song);
        } catch (error) {
          console.error(`Skipping unreadable song ${name}:`, error.message);
        }
      }
    }
  }

  get size() {
    return this.#songs.size;
  }

  get(id) {
    return this.#songs.get(id) ?? null;
  }

  audioPath(id) {
    const song = this.#songs.get(id);
    return song ? join(this.#root, song.bucket, `${id}.wav`) : null;
  }

  playableCount(bucket) {
    let count = 0;
    for (const song of this.#songs.values()) {
      if (song.bucket === bucket && !song.disliked) count += 1;
    }
    return count;
  }

  /**
   * The next song to replay: this station's own songs first, then liked songs,
   * then the longest unheard.
   */
  pick(bucket, excludedIds, stationId) {
    let best = null;
    for (const song of this.#songs.values()) {
      const own = song.stationId === stationId;
      if ((song.bucket !== bucket && !own) || song.disliked || excludedIds.has(song.id)) continue;
      const bestOwn = best?.stationId === stationId;
      const better =
        !best ||
        own > bestOwn ||
        (own === bestOwn &&
          (song.liked > best.liked ||
            (song.liked === best.liked && (song.lastPlayedAt ?? '') < (best.lastPlayedAt ?? ''))));
      if (better) best = song;
    }
    return best;
  }

  countForStation(stationId) {
    let count = 0;
    for (const song of this.#songs.values()) {
      if (song.stationId === stationId && !song.disliked) count += 1;
    }
    return count;
  }

  async add(song, wav) {
    return this.#writeSong(song.id, async () => {
      const stored = { liked: false, disliked: false, lastPlayedAt: null, sizeBytes: wav.length, ...song };
      await mkdir(join(this.#root, stored.bucket), { recursive: true });
      await writeFile(this.audioPath(stored.id) ?? join(this.#root, stored.bucket, `${stored.id}.wav`), wav);
      this.#songs.set(stored.id, stored);
      await this.#save(stored);
      return stored;
    });
  }

  update(id, changes) {
    return this.#writeSong(id, async () => {
      const song = this.#songs.get(id);
      if (!song) throw new RangeError('Unknown song');
      Object.assign(song, changes);
      await this.#save(song);
    });
  }

  /** Explicit listener deletion may remove a favourite too, after UI confirmation. */
  async deleteSong(id) {
    return this.#writeSong(id, async () => {
      const song = this.#songs.get(id);
      if (!song) throw new RangeError('Unknown generated song');
      return this.#remove(song);
    });
  }

  /** A pending playback/heart save must finish before deletion, and never recreate its files. */
  #writeSong(id, operation) {
    const previous = this.#songWrites.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.#songWrites.set(id, next);
    return next.finally(() => { if (this.#songWrites.get(id) === next) this.#songWrites.delete(id); });
  }

  /** Removes rejected songs, then other songs over the limits, stalest first. */
  async evict(protectedIds) {
    const removable = [...this.#songs.values()]
      .filter((song) => !protectedIds.has(song.id) && (song.disliked || !isKept(song)))
      .sort(
        (a, b) =>
          b.disliked - a.disliked ||
          (a.lastPlayedAt ?? a.createdAt).localeCompare(b.lastPlayedAt ?? b.createdAt),
      );

    const bucketCounts = new Map();
    let totalBytes = 0;
    for (const song of this.#songs.values()) {
      if (isKept(song)) continue;
      bucketCounts.set(song.bucket, (bucketCounts.get(song.bucket) ?? 0) + 1);
      totalBytes += song.sizeBytes;
    }

    for (const song of removable) {
      const count = bucketCounts.get(song.bucket);
      if (!song.disliked && count <= MAX_UNLIKED_PER_BUCKET && totalBytes <= MAX_UNLIKED_BYTES) continue;
      const removed = await this.#writeSong(song.id, async () => {
        if (this.#songs.get(song.id) !== song || (!song.disliked && isKept(song))) return false;
        await this.#remove(song);
        return true;
      });
      if (!removed) continue;
      bucketCounts.set(song.bucket, count - 1);
      totalBytes -= song.sizeBytes;
    }
  }

  async #remove(song) {
    const audio = this.audioPath(song.id);
    const paths = [audio.replace(/\.wav$/, '.json'), audio.replace(/\.wav$/, '.tmp'), audio];
    const files = [];
    // Check every file before changing anything; retain the small sidecars for rollback.
    for (const path of paths) {
      const info = await stat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (!info) continue;
      if (!info.isFile()) throw new Error('A song file is not a regular file. No files were deleted.');
      files.push({ path, size: info.size, contents: path === audio ? null : await readFile(path) });
    }
    let freedBytes = 0;
    const removed = [];
    try {
      // Audio is last: an earlier error leaves it playable, a failed audio unlink restores metadata.
      for (const file of files) {
        await rm(file.path, { force: true });
        removed.push(file);
        freedBytes += file.size;
      }
    } catch (error) {
      for (const file of removed) if (file.contents) await writeFile(file.path, file.contents);
      throw error;
    }
    this.#songs.delete(song.id);
    await rmdir(dirname(audio)).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) console.warn('Could not remove an empty library folder:', error.message); });
    return freedBytes;
  }

  /** The metadata file appears last, so a crash cannot list a partial song. */
  async #save(song) {
    const path = this.audioPath(song.id).replace(/\.wav$/, '.json');
    const temporary = join(dirname(path), `${song.id}.tmp`);
    await writeFile(temporary, JSON.stringify(song));
    await rename(temporary, path);
  }
}
