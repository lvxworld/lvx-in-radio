import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { catalogAddress, mediaAddress, MAX_AUDIO_BYTES, MAX_CATALOG_BYTES, remoteJson, remoteResponse } from './remote-http.js';

const ID = /^[\w-]{1,100}$/;
const INTERVALS = [0, 5, 15, 30, 60];

/** GitHub Pages serves MP3 as audio/mp3, other hosts as audio/mpeg or a generic binary type. */
export const isMp3Type = type => /^(audio\/(mpeg|mp3)|application\/octet-stream)(;|$)/i.test(type ?? '');

export function parseLiveCatalog(value, address) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.stations) || value.stations.length > 128) throw new TypeError('Unsupported station catalog. Your previous catalog has been kept.');
  const stationIds = new Set(); let total = 0;
  const stations = value.stations.map(station => {
    if (!station || !ID.test(station.id ?? '') || stationIds.has(station.id) || typeof station.name !== 'string' || !station.name.trim() || !Array.isArray(station.tracks)) throw new TypeError('Invalid or duplicate station in catalog.');
    stationIds.add(station.id);
    if (station.enabled !== undefined && typeof station.enabled !== 'boolean') throw new TypeError('Invalid station availability.');
    const ids = new Set();
    const tracks = station.tracks.map(track => {
      if (++total > 10000 || !track || !ID.test(track.id ?? '') || ids.has(track.id) || typeof track.title !== 'string' || !track.title.trim() || typeof track.url !== 'string') throw new TypeError('Invalid or duplicate song in catalog.');
      ids.add(track.id);
      if (track.durationSec !== undefined && (!Number.isFinite(track.durationSec) || track.durationSec <= 0 || track.durationSec > 86400)) throw new TypeError('Invalid song duration.');
      if (track.sizeBytes !== undefined && (!Number.isSafeInteger(track.sizeBytes) || track.sizeBytes < 1 || track.sizeBytes > MAX_AUDIO_BYTES)) throw new TypeError('Invalid song size.');
      return { id: track.id, title: track.title.trim().slice(0,160), url: mediaAddress(track.url, address), durationSec: track.durationSec ?? 0, sizeBytes: track.sizeBytes };
    });
    return { id: station.id, name: station.name.trim().slice(0,80), genre: typeof station.genre === 'string' ? station.genre.slice(0,80) : 'Radio', description: typeof station.description === 'string' ? station.description.slice(0,240) : '', enabled: station.enabled !== false, tracks };
  });
  return { schemaVersion: 1, stations };
}

/** Main-process catalog, preferences and streaming. Audio is never cached. */
export class LiveRadio extends EventEmitter {
  #path; #catalog; #stations; #fetch; #change;
  #settings; #cached = null; #positions = Object.create(null); #status = 'off'; #error = null;
  #work; #controller; #timer; #closed = false; #streams = new Set(); #saving = Promise.resolve();
  #added = 0; #overflow = 0;

  constructor({ path, defaultUrl = '', catalog, stations, fetchCatalog = remoteJson, onCatalogChange = () => {} }) {
    super(); this.#path = path; this.#catalog = catalog; this.#stations = stations; this.#fetch = fetchCatalog; this.#change = onCatalogChange;
    this.#settings = { choiceMade: false, enabled: false, url: defaultUrl ? catalogAddress(defaultUrl) : '', refreshMinutes: 30 };
  }

  async load() {
    try {
      const info = await readFile(this.#path);
      if (info.length > MAX_CATALOG_BYTES * 2) throw new Error('Saved station settings are too large.');
      const saved = JSON.parse(info);
      if (saved.version !== 1) throw new Error('Unsupported saved station settings.');
      const s = saved.settings;
      if (typeof s?.enabled !== 'boolean' || typeof s?.choiceMade !== 'boolean' || !INTERVALS.includes(s.refreshMinutes)) throw new Error('Invalid saved station settings.');
      this.#settings = { ...s, url: s.url ? catalogAddress(s.url) : '', enabled: s.enabled && s.choiceMade && !!s.url };
      this.#positions = Object.assign(Object.create(null), saved.positions && typeof saved.positions === 'object' ? saved.positions : {});
      if (saved.cache?.url === this.#settings.url) {
        this.#cached = { ...saved.cache, catalog: parseLiveCatalog(saved.cache.catalog, this.#settings.url) };
      }
      this.#status = this.#settings.enabled ? 'cached' : 'off';
    } catch (error) { if (error.code !== 'ENOENT') { this.#error = 'Saved Live settings could not be read. Choose your catalog again.'; } }
    this.#apply();
  }

  snapshot() {
    return { ...this.#settings, status: this.#status, error: this.#error, refreshing: !!this.#work, lastCheckedAt: this.#cached?.checkedAt ?? null, stationCount: this.#settings.enabled ? this.#cached?.catalog.stations.filter(station => station.enabled).length ?? 0 : 0, added: this.#added, overflow: this.#overflow };
  }

  start() { this.#schedule(); if (this.#settings.enabled) void this.refresh(); }

  configure(value) {
    const operation = this.#saving.then(() => this.#configure(value));
    this.#saving = operation.catch(() => {});
    return operation;
  }

  async #configure({ enabled, url, refreshMinutes }) {
    if (this.#closed) throw new Error('Radio is closing.');
    if (typeof enabled !== 'boolean' || !INTERVALS.includes(refreshMinutes) || typeof url !== 'string') throw new TypeError('Choose a valid Live setting and update interval.');
    const address = url.trim() ? catalogAddress(url) : '';
    if (enabled && !address) throw new TypeError('Enter the catalog URL before turning on LVX Live.');
    this.#controller?.abort(); await this.#work;
    const reset = this.#settings.enabled && (!enabled || this.#settings.url !== address);
    const previous = this.#settings;
    this.#settings = { choiceMade: true, enabled, url: address, refreshMinutes };
    try { await this.#save(); } catch (error) { this.#settings = previous; throw error; }
    if (reset) for (const controller of this.#streams) controller.abort();
    if (this.#cached?.url !== address) this.#cached = null;
    this.#status = enabled ? 'cached' : 'off'; this.#error = null;
    this.#apply(); await this.#change({ reset }); this.#schedule(); this.emit('change');
    if (enabled) void this.refresh();
    return this.snapshot();
  }

  refresh() {
    if (this.#work) return this.#work;
    if (this.#closed || !this.#settings.enabled || !this.#settings.choiceMade) return Promise.resolve(this.snapshot());
    this.#controller = new AbortController();
    this.#status = 'refreshing'; this.#error = null;
    this.#work = this.#refresh(this.#controller.signal).catch(error => {
      if (!this.#controller.signal.aborted) { this.#status = 'unavailable'; this.#error = 'Live catalog unavailable. Your saved stations and included songs are still here.'; console.error('LVX Live:', error.message); }
    }).finally(() => { this.#work = null; this.emit('change'); });
    this.emit('change');
    return this.#work;
  }

  async #refresh(signal) {
    const address = this.#settings.url;
    const cached = this.#cached?.url === address ? this.#cached : null;
    const validators = {};
    if (cached?.etag) validators['If-None-Match'] = cached.etag;
    else if (cached?.lastModified) validators['If-Modified-Since'] = cached.lastModified;
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { result = await this.#fetch(address, { validators, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }); break; }
      catch (error) { if (signal.aborted || error instanceof TypeError || error instanceof SyntaxError || error.retryable === false || attempt) throw error; await delay(350, undefined, { signal }); }
    }
    signal.throwIfAborted();
    if (result.notModified && !cached) throw new TypeError('The server returned 304 without a saved catalog.');
    const catalog = result.notModified ? cached.catalog : parseLiveCatalog(result.data, address);
    const oldIds = new Set(cached?.catalog.stations.map(station => station.id) ?? []);
    this.#added = cached ? catalog.stations.filter(station => station.enabled && !oldIds.has(station.id)).length : 0;
    const previous = this.#cached;
    this.#cached = { url: address, catalog, etag: result.etag ?? cached?.etag, lastModified: result.lastModified ?? cached?.lastModified, checkedAt: new Date().toISOString() };
    this.#apply();
    try { await this.#save(); } catch (error) { this.#cached = previous; this.#apply(); throw error; }
    signal.throwIfAborted();
    await this.#change({ reset: false }); this.#status = 'ready';
  }

  #apply() {
    const used = new Set([...this.#catalog.bundledStations().map(station => station.k), ...this.#stations.list().map(station => station.k)]);
    const records = []; this.#overflow = 0;
    if (this.#settings.enabled) for (const station of this.#cached?.catalog.stations ?? []) {
      if (!station.enabled) continue;
      if (this.#stations.get(station.id)) { this.#overflow++; continue; }
      const bundled = this.#catalog.bundledStations().find(entry => entry.id === station.id);
      let k = bundled?.k;
      if (k === undefined) {
        const saved = this.#positions[station.id];
        k = Number.isInteger(saved) && saved >= 0 && saved < 26 && !used.has(saved) ? saved : Array.from({ length:26 }, (_,index) => index).find(index => !used.has(index));
      }
      if (k === undefined) { this.#overflow++; continue; }
      used.add(k); this.#positions[station.id] = k;
      records.push({ ...station, k, catalogUrl: this.#settings.url });
    }
    this.#catalog.setLiveStations(records);
    this.#stations.reserveFrequencies([...this.#catalog.stations().map(station => station.k)]);
  }

  #schedule() {
    clearInterval(this.#timer);
    if (!this.#closed && this.#settings.enabled && this.#settings.refreshMinutes) {
      this.#timer = setInterval(() => void this.refresh(), this.#settings.refreshMinutes * 60000); this.#timer.unref();
    }
  }

  async #save() {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify({ version:1, settings:this.#settings, cache:this.#cached, positions:this.#positions });
    if (Buffer.byteLength(serialized) > MAX_CATALOG_BYTES * 2) throw new TypeError('The saved station catalog is too large.');
    await writeFile(temporary, serialized);
    await rename(temporary, this.#path);
  }

  async stream(request, response, source) {
    if (!this.#settings.enabled || this.#closed || source.origin !== this.#settings.url) throw new TypeError('LVX Live is off or this song belongs to an older catalog.');
    const controller = new AbortController(); this.#streams.add(controller);
    const abort = () => { if (!response.writableFinished) controller.abort(); }; response.once('close', abort);
    try {
      const headers = {};
      if (request.headers.range) {
        if (!/^bytes=(\d*)-(\d*)$/.test(request.headers.range)) throw new TypeError('Unsupported audio range.');
        headers.Range = request.headers.range;
      }
      const upstream = await remoteResponse(source.url, { origin: source.origin, headers, signal: controller.signal });
      if (upstream.statusCode === 416) { response.writeHead(416, { 'Content-Range': upstream.headers['content-range'] ?? 'bytes */0' }); upstream.destroy(); response.end(); return; }
      if (![200,206].includes(upstream.statusCode) || !isMp3Type(upstream.headers['content-type']) || Number(upstream.headers['content-length']) > MAX_AUDIO_BYTES) { upstream.destroy(); throw new Error('This song is not available as an MP3.'); }
      const outgoing = { 'Content-Type':'audio/mpeg', 'Cache-Control':'no-store' };
      for (const name of ['content-length','content-range','accept-ranges']) if (upstream.headers[name]) outgoing[name] = upstream.headers[name];
      response.writeHead(upstream.statusCode, outgoing);
      let bytes = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > MAX_AUDIO_BYTES ? new Error('The remote song is too large.') : null, chunk); } });
      await pipeline(upstream, limit, response, { signal: controller.signal });
    } finally { response.off('close', abort); controller.abort(); this.#streams.delete(controller); }
  }

  async close() {
    this.#closed = true; clearInterval(this.#timer); this.#controller?.abort();
    for (const controller of this.#streams) controller.abort();
    await this.#work; await this.#saving;
  }
}
