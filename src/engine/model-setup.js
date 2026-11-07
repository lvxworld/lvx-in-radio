import { createReadStream } from 'node:fs';
import { access, constants, mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import manifest from './model-manifest.json' with { type: 'json' };

const MARGIN_BYTES = 256 * 1024 ** 2;

async function sizeOf(path) {
  try { const s = await stat(path); return s.isFile() ? s.size : 0; } catch { return 0; }
}

/** The Hugging Face hub cache, where other tools may already hold the pinned weights. */
export function huggingFaceHub(env = process.env) {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME) return join(env.HF_HOME, 'hub');
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'huggingface', 'hub');
}

/** Owns the resumable model installation, not the music engine or the player. */
export class ModelSetup {
  #engine;
  #files;
  #settings;
  #ownedDir;
  #fetch;
  #hub;
  #space;
  #controller;
  #work;
  #state = { status: 'idle', bytes: 0, error: null, file: '', accepted: false };
  #verified = {};
  #closed = false;

  constructor(engine, { files = manifest.files, fetchFile = fetch, freeSpace, hub = huggingFaceHub() } = {}) {
    this.#hub = hub;
    this.#engine = engine;
    this.#ownedDir = engine.modelDir;
    this.#settings = join(engine.dataDir, 'model-settings.json');
    this.#files = files;
    this.#fetch = fetchFile;
    this.#space = freeSpace ?? (async (path) => { const s = await statfs(path); return s.bavail * s.bsize; });
  }

  async initialize() {
    await mkdir(this.#engine.dataDir, { recursive: true });
    let fresh = false;
    try {
      const saved = JSON.parse(await readFile(this.#settings, 'utf8'));
      if (saved.directory) this.#engine.modelDir = saved.directory;
      this.#state.accepted = saved.accepted === true;
      this.#verified = saved.verified ?? {};
    } catch (e) { if (e.code === 'ENOENT') fresh = true; else this.#state.error = 'The saved model settings could not be read. Choose the folder again.'; }
    const stamps = await this.#stamps();
    if (stamps && JSON.stringify(stamps) === JSON.stringify(this.#verified)) this.#state.status = 'ready';
    else if (stamps) this.#launch(() => this.#verifyDirectory());
    else if (fresh) { const cached = await this.#cachedSnapshot(); if (cached) this.#launch(() => this.#useCache(cached)); }
    await this.#progress();
  }

  // The pinned revision's snapshot in the Hugging Face cache, when it holds every file at its size.
  async #cachedSnapshot() {
    const pin = /^https:\/\/huggingface\.co\/([^/]+)\/([^/]+)\/resolve\/([0-9a-f]{40})\//.exec(this.#files[0]?.url ?? '');
    if (!pin || !this.#hub) return null;
    const dir = join(this.#hub, `models--${pin[1]}--${pin[2]}`, 'snapshots', pin[3]);
    for (const file of this.#files) if (await sizeOf(join(dir, file.path)) !== file.size) return null;
    return dir;
  }

  // Used in place like a chosen folder, after the same hash check; a bad copy falls back to downloading.
  async #useCache(dir) {
    this.#engine.modelDir = dir;
    try { await this.#verifyDirectory(); } catch (error) {
      this.#engine.modelDir = this.#ownedDir;
      if (this.#controller.signal.aborted) throw error;
      Object.assign(this.#state, { status: 'idle', file: '' });
      await this.#progress();
    }
  }

  async snapshot() {
    if (this.#state.status === 'ready' && JSON.stringify(await this.#stamps()) !== JSON.stringify(this.#verified)) {
      this.#state.status = 'idle';
      this.#state.error = 'The model files have changed or are missing. Choose the folder again or resume setup.';
    }
    const components = [];
    for (const [name, path] of [['Music engine', this.#engine.binary], ['Engine configuration', join(this.#engine.modelSpecs, 'yue2.json')]]) {
      try { await access(path, name === 'Music engine' ? constants.X_OK : constants.R_OK); if (!(await stat(path)).isFile()) throw new Error('Not a file'); components.push({ name, ready: true }); } catch { components.push({ name, ready: false }); }
    }
    const ready = this.#state.status === 'ready' && components.every(c => c.ready);
    return { ...this.#state, ready, components, total: this.#files.reduce((s, f) => s + f.size, 0), directory: this.#engine.modelDir };
  }

  #launch(action) {
    if (this.#work) throw new Error('Setup is already running');
    this.#controller = new AbortController();
    this.#state.error = null;
    this.#work = action().catch(error => {
      if (this.#controller.signal.aborted) this.#state.status = 'paused';
      else { this.#state.status = 'error'; this.#state.error = error.code === 'ENOSPC' ? 'Not enough free space. Free some space and resume setup.' : /fetch|ECONN|ENOTFOUND|network/i.test(error.message) ? 'Network connection lost. Your progress is saved. Check your connection and resume.' : error.message; }
    }).finally(() => { this.#work = null; });
  }

  async download(accepted) {
    if (!accepted && !this.#state.accepted) throw new Error('Please accept the model terms before downloading');
    if (this.#work) throw new Error('Setup is already running');
    if (this.#closed) throw new Error('Setup is closing');
    this.#state.accepted = true;
    this.#engine.modelDir = this.#ownedDir;
    this.#launch(async () => {
      await mkdir(this.#ownedDir, { recursive: true });
      await this.#save();
      this.#state.status = 'verifying';
      const complete = new Set();
      for (const file of this.#files) {
        const target = join(this.#ownedDir, file.path);
        if (await sizeOf(target) === file.size) {
          this.#state.file = file.path;
          if (await this.#verify(target, file)) complete.add(file.path);
          else await rm(target, { force: true });
        }
      }
      let remaining = 0;
      for (const f of this.#files) if (!complete.has(f.path)) remaining += Math.max(0, f.size - Math.min(f.size, await sizeOf(join(this.#ownedDir, f.path + '.part'))));
      if (await this.#space(this.#ownedDir) < remaining + MARGIN_BYTES) throw new Error('Not enough free space. Free some space and try again.');
      for (const file of this.#files) {
        this.#controller.signal.throwIfAborted();
        this.#state.file = file.path;
        const target = join(this.#ownedDir, file.path);
        await mkdir(dirname(target), { recursive: true });
        if (complete.has(file.path)) continue;
        await this.#downloadFile(file, target);
      }
      await this.#complete();
    });
  }

  async #downloadFile(file, target) {
    const part = target + '.part';
    let offset = await sizeOf(part);
    if (offset > file.size) { await rm(part, { force: true }); offset = 0; }
    if (offset < file.size) {
      this.#state.status = 'downloading';
      const response = await this.#fetch(file.url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: this.#controller.signal });
      if (!response.ok) throw new Error(`Could not download ${file.path} (HTTP ${response.status}). Check your connection and resume.`);
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
        if (!range || Number(range[1]) !== offset || Number(range[3]) !== file.size) { await response.body?.cancel(); throw new Error('The download server returned an invalid resume position. Try again.'); }
      } else if (response.status === 200) offset = 0;
      else { await response.body?.cancel(); throw new Error('Unexpected download response. Please try again.'); }
      const handle = await open(part, offset ? 'a' : 'w');
      try {
        let count = offset;
        for await (const chunk of response.body) {
          this.#controller.signal.throwIfAborted();
          if (count + chunk.length > file.size) throw new Error('The downloaded file is larger than expected');
          let written = 0;
          while (written < chunk.length) { const r = await handle.write(chunk, written, chunk.length - written); written += r.bytesWritten; }
          count += chunk.length;
          await this.#progress();
        }
      } finally { await handle.close(); }
    }
    if (await sizeOf(part) < file.size) throw new Error('The download ended early. Your progress is saved; resume to continue.');
    this.#state.status = 'verifying';
    if (!(await this.#verify(part, file))) { await rm(part, { force: true }); throw new Error(`The integrity check failed for ${file.path}. Resume to download a fresh copy.`); }
    await rename(part, target);
    await this.#progress();
  }

  async #verify(path, file) {
    if (await sizeOf(path) !== file.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { signal: this.#controller.signal })) hash.update(chunk);
    return hash.digest('hex') === file.sha256;
  }

  async useDirectory(directory, accepted) {
    if (!accepted && !this.#state.accepted) throw new Error('Please accept the model terms first');
    if (this.#work) throw new Error('Pause the download before choosing another folder');
    this.#engine.modelDir = resolve(directory);
    this.#state.accepted = true;
    this.#launch(() => this.#verifyDirectory());
  }

  async #verifyDirectory() {
    this.#state.status = 'verifying';
    for (const file of this.#files) {
      this.#controller.signal.throwIfAborted();
      this.#state.file = file.path;
      if (!(await this.#verify(join(this.#engine.modelDir, file.path), file))) throw new Error(`This folder is missing a complete, valid ${file.path}. Select the folder containing both weights and sidecars.`);
      await this.#progress();
    }
    await this.#complete();
  }

  async #stamps() {
    const stamps = {};
    for (const file of this.#files) {
      try { const s = await stat(join(this.#engine.modelDir, file.path)); if (!s.isFile() || s.size !== file.size) return null; stamps[file.path] = { size: s.size, mtime: s.mtimeMs }; } catch { return null; }
    }
    return stamps;
  }

  async #complete() {
    this.#verified = await this.#stamps();
    if (!this.#verified) throw new Error('The model files changed during setup. Please verify the folder again.');
    await this.#save();
    this.#state.status = 'ready';
    this.#state.file = '';
    this.#state.bytes = this.#files.reduce((sum, f) => sum + f.size, 0);
  }

  async #save() {
    const temp = this.#settings + '.tmp';
    await writeFile(temp, JSON.stringify({ directory: this.#engine.modelDir, accepted: this.#state.accepted, verified: this.#verified }));
    await rename(temp, this.#settings);
  }

  async #progress() {
    let bytes = 0;
    for (const f of this.#files) bytes += Math.min(f.size, await sizeOf(join(this.#engine.modelDir, f.path)) + await sizeOf(join(this.#engine.modelDir, f.path + '.part')));
    this.#state.bytes = bytes;
  }

  async pause() {
    this.#controller?.abort();
    await this.#work;
  }

  async close() { this.#closed = true; await this.pause(); }
}
