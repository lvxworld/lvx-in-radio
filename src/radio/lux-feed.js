import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseManifest } from './lux-catalog.js';

const MANIFEST_TIMEOUT_MS = 20_000;
const SONG_TIMEOUT_MS = 5 * 60_000;

async function download(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

/**
 * Downloads the songs the catalog does not have, one at a time. Runs in the
 * background and never blocks the radio: on any failure the stations simply keep
 * what they have, and the next launch tries again.
 */
export async function syncFeed({ url, catalog, onSong = () => {} }) {
  if (!url) return 0;
  const response = await download(url, MANIFEST_TIMEOUT_MS);
  const songs = parseManifest(await response.json()).filter((song) => song.url && !catalog.has(song.id));
  let added = 0;
  for (const song of songs) {
    const path = catalog.downloadedPath(song.id);
    const temporary = `${path}.part`;
    try {
      const audio = Buffer.from(await (await download(song.url, SONG_TIMEOUT_MS)).arrayBuffer());
      const digest = createHash('sha256').update(audio).digest('hex');
      if (audio.length !== song.sizeBytes || digest !== song.sha256) throw new Error('the file does not match the manifest');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, audio);
      await rename(temporary, path);
      catalog.add(song, path);
      await catalog.saveDownloads();
      added += 1;
      onSong(song);
    } catch (error) {
      await rm(temporary, { force: true });
      console.error(`Could not download ${song.title}:`, error.message);
    }
  }
  return added;
}
