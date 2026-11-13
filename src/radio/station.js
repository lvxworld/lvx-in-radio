import { EventEmitter } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';

import { EngineAbortedError } from '../engine/audiocpp.js';
import { wavDurationSeconds } from '../engine/wav.js';
import { ModelMissingError } from '../engine/availability.js';
import { scoreFromPlan } from './instrumental.js';
import { bucketFor } from './library.js';
import { buildStyle, validateConfig } from './style.js';
import { DJ_IDS, stationCoHostChoice, stationDj, styleFor } from './dj/dj-style.js';

const SEMANTIC_FRAMES_PER_SECOND = 25;
const MIN_TRACK_SECONDS = 60;
const MAX_TRACK_SECONDS = 300;
const MAX_SEED = 2 ** 47;
const DEFAULT_ESTIMATE_SECONDS = 130;
const DEFAULT_INSTRUMENTAL_ESTIMATE_SECONDS = 260;
const PLANNING_ATTEMPTS = 3;
const ESTIMATE_SMOOTHING = 0.3;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_REPLAYS_BETWEEN_NEW_SONGS = 3;
const SONGS_PER_EXTRA_REPLAY = 3;

const TITLES = [
  'Tape Dust',
  'Fogged Windows',
  'Taxi to Nowhere',
  'Sodium Light',
  'Last Metro',
  'Red Umbrellas',
  'Coffee at Four',
  'Amber Signal',
  'Warm Static',
  'Night Bus',
  'Paper Moon',
  'Slow Tide',
];

export function directRequest(config, seed) {
  return {
    lyrics: '[instrumental]',
    seed,
    options: {
      style: buildStyle(config),
      cot: config.instrumental ? 'full' : 'off',
      export_semantic: 'true',
      semantic_min_tokens: String(MIN_TRACK_SECONDS * SEMANTIC_FRAMES_PER_SECOND),
      semantic_max_tokens: String(MAX_TRACK_SECONDS * SEMANTIC_FRAMES_PER_SECOND),
    },
  };
}

export function wasTruncated(result) {
  const semantic = result.artifacts?.find((artifact) => artifact.id === 'semantic');
  return String(semantic?.meta?.truncated).toLowerCase() === 'true';
}

/**
 * The live station. The GPU works only when it must:
 * - a new song starts at the last moment that still lands before the music runs out;
 * - replays from the library fill the schedule, and their share grows with the library;
 * - pausing starts nothing new, and an idle engine is unloaded to free its memory.
 *
 * A Lux station only plays its catalog. A preparation composes the first song of
 * another station while the current one keeps playing; the listener moves over
 * when they choose.
 *
 * The engine runs one job at a time and the job does not depend on the station
 * on air, so moving station never loses a song. Only an explicit stop aborts it.
 *
 * Emits `change` whenever `snapshot()` would return something new.
 */
export class RadioStation extends EventEmitter {
  #engine;
  #library;
  #stations;
  #catalog;
  #preparation = null;
  #job = null;
  #holds = 0;
  #holdWaiters = [];
  #dj = null;
  #arrival = null;
  #availability;
  #modelReady = true;
  #leadMarginSec;
  #idleUnloadMs;
  #session = null;
  #estimates = { sung: DEFAULT_ESTIMATE_SECONDS, instrumental: DEFAULT_INSTRUMENTAL_ESTIMATE_SECONDS };
  #lastWorkAt = Date.now();
  #timer;
  #libraryOnly;

  constructor({ engine, library, stations, catalog = null, availability = async () => ({ ready: true, missing: [] }), leadMarginSec = 30, idleUnloadMs = 60_000, tickMs = 5_000, libraryOnly = false }) {
    super();
    this.#engine = engine;
    this.#libraryOnly = libraryOnly;
    this.#library = library;
    this.#stations = stations;
    this.#catalog = catalog;
    this.#availability = availability;
    this.#leadMarginSec = leadMarginSec;
    this.#idleUnloadMs = idleUnloadMs;
    this.#timer = setInterval(() => this.#tick(), tickMs);
    this.#timer.unref();
  }

  /**
   * Starts a station. With `fromLibrary` it opens on a stored song, so returning
   * needs no waiting and a song composing elsewhere carries on. Without it the
   * listener is waiting on this station alone, so whatever is composing stops.
   */
  async tune(config, { fromLibrary = false, stationId, identity = {}, paused = false } = {}) {
    await this.#dj?.cancel('station changed');
    const lux = this.#catalog?.station(stationId) ?? null;
    if (!lux) validateConfig(config);
    const saved = stationId && !lux ? this.#stations.get(stationId) : null;
    if (stationId && !lux && !saved) throw new RangeError('Unknown station');
    await this.#refreshModel();
    if (!lux && !fromLibrary) {
      if (!this.#modelReady) throw new ModelMissingError();
      await this.cancelPreparation();
      await this.#abortJob();
    }
    const station = lux ?? saved ?? (await this.#stations.open(config, identity));
    if (lux) await this.#catalog.touchStation(lux.id);
    if (saved) await this.#stations.touch(saved, { config });
    if (this.#preparation?.status === 'ready' && this.#preparation.station.id === station.id) this.#preparation = null;
    if (this.#arrival?.stationId === station.id) this.#arrival = null;
    const session = {
      id: randomUUID(),
      config: lux ? lux.config : config,
      lux: Boolean(lux),
      fromLibrary: fromLibrary || Boolean(lux),
      station,
      tracks: [],
      generationEnabled: !lux,
      held: paused,
      failures: 0,
      error: null,
      newSongs: 0,
      seed: config?.seed ?? randomInt(MAX_SEED),
      replaysSinceNewSong: 0,
      playback: { trackId: null, positionSec: 0, playing: false, at: Date.now() },
    };
    this.#session = session;
    this.#plan(session);
    this.#dj?.consider(this.djContext());
    return session.id;
  }

  attachDJ(dj) {
    this.#dj = dj;
    dj.on?.('change', () => this.emit('change'));
    this.on('change', () => dj.consider?.(this.djContext()));
  }

  djContext() {
    const session = this.#session;
    if (!session) return { stationId: null, lux: false };
    const current = session.tracks.find((track) => track.id === session.playback.trackId && track.status === 'ready') ?? null;
    const next = this.#upcoming(session).find((track) => track.status === 'ready') ?? null;
    if (session.lux) {
      // LVX: MP3s of known length, all listed; never a song job. Runway is the song on air only.
      const upcoming = this.#upcoming(session).filter((track) => track.status === 'ready');
      const { trackId, positionSec, playing, at } = session.playback;
      const played = positionSec + (playing ? (Date.now() - at) / 1000 : 0);
      const remaining = current?.durationSec > 0 ? Math.max(current.durationSec - played, 0) : 0;
      return { stationId: session.station.id, stationName: session.station.name, stationDescription: session.station.quote ?? '', playbackSessionId: session.id, lux: true, live: session.station.live === true, playing: session.playback.playing, busy: Boolean(this.#job || this.#holds), djId: this.#dj?.luxDj?.(session.station).dj ?? null, coHostChoice: this.#dj?.luxCoHostChoice?.(session.station), current, next: upcoming[0] ?? null, after: upcoming[1] ?? null, config: session.config, runwaySec: remaining, songEstimateSec: 0, playbackTrackId: trackId };
    }
    return { stationId: session.station.id, stationName: session.station.name, playbackSessionId: session.id, lux: false, playing: session.playback.playing, busy: Boolean(this.#job || this.#holds), djId: stationDj(session.station).dj, coHostChoice: stationCoHostChoice(session.station), current, next, config: session.config, runwaySec: this.#runwaySeconds(session), songEstimateSec: session.generationEnabled ? this.#estimateFor(session.config) : 0, playbackTrackId: session.playback.trackId };
  }

  /**
   * Chooses this station's DJ (role 'dj': a DJ id, null for "No DJ") or its co-host (role 'coHost':
   * a DJ id, null for "talks alone"); 'default' goes back to the automatic choice.
   */
  async setDj(id, djId, role = 'dj') {
    if (!DJ_IDS.includes(djId) && djId !== null && djId !== 'default') throw new RangeError('Unknown DJ');
    if (role !== 'dj' && role !== 'coHost') throw new RangeError('Unknown DJ role');
    const lux = this.#catalog?.station(id);
    if (lux) {
      // LVX choices live in dj-settings.json, never in stations.json.
      if (!this.#dj?.setLuxDj) throw new RangeError('Unknown station');
      const result = await this.#dj.setLuxDj(lux, djId, role);
      if (this.#session?.station.id === id) await this.#dj.cancel('station DJ changed');
      this.#dj.consider(this.djContext());
      this.emit('change');
      return result;
    }
    const record = this.#stations.get(id);
    if (!record) throw new RangeError('Unknown station');
    await this.#stations.setDj(id, djId, role);
    if (this.#session?.station.id === id) await this.#dj?.cancel('station DJ changed');
    this.#dj?.consider(this.djContext());
    this.emit('change');
    return { stationId: id, ...stationDj(record) };
  }

  /**
   * Composes the first song of a station in the background and stores it. Nothing
   * changes on air: the listener tunes in when they want, from the library.
   */
  async prepare(config, { identity = {} } = {}) {
    validateConfig(config);
    await this.#refreshModel();
    if (!this.#modelReady) throw new ModelMissingError();
    const station = await this.#stations.open(config, identity);
    if (this.#job?.preparation) this.#job.preparation = null;
    this.#preparation = {
      id: randomUUID(),
      station,
      config,
      seed: config.seed ?? randomInt(MAX_SEED),
      title: TITLES[this.#library.size % TITLES.length],
      status: 'waiting',
      startedAt: null,
      estimateSec: this.#estimateFor(config),
      error: null,
      createdAt: new Date().toISOString(),
    };
    this.#startNext();
    this.emit('change');
    return station.id;
  }

  /** Stops a preparation or forgets a finished one. Its stored song remains. */
  async cancelPreparation() {
    const preparation = this.#preparation;
    if (!preparation) return;
    this.#preparation = null;
    if (this.#job?.preparation === preparation) await this.#abortJob();
    this.#startNext();
    this.emit('change');
  }

  /** Stops whatever is composing, losing it, and starts what was waiting. */
  async cancelJob() {
    await this.#dj?.cancel('job stopped');
    const job = this.#job;
    if (!job) return;
    if (job.preparation) this.#preparation = null;
    await this.#abortJob();
    this.#startNext();
    this.emit('change');
  }

  /**
   * The listener wants the queued song now instead of when it falls due. It waits
   * only for a running job; when it ends, the schedule works out the rest as usual.
   */
  async generateNow(trackId) {
    await this.#refreshModel();
    const session = this.#requireSession();
    const track = session.tracks.at(-1);
    if (track?.id !== trackId || track.status !== 'queued' || session.lux || !this.#canGenerate(session)) {
      throw new RangeError('That song cannot be generated now');
    }
    track.requested = true;
    this.#plan(session);
    this.emit('change');
  }

  /** The listener stays where they are. The song remains on its station. */
  async dismissArrival() {
    this.#arrival = null;
    this.emit('change');
  }

  async renameStation(id, name) {
    await this.#stations.rename(id, name);
    this.emit('change');
  }

  /** Applies to songs not yet started: a running generation cannot change. */
  steer(config) {
    validateConfig(config);
    const session = this.#requireSession();
    if (session.lux) return;
    session.config = config;
    this.#stations.touch(session.station, { config }).catch((error) => console.error(error.message));
    const tail = session.tracks.at(-1);
    if (tail?.status === 'queued') tail.generation = config;
    this.emit('change');
  }

  /** Records what the listener hears, which decides when the next song is due. */
  async setPlayback({ trackId, positionSec, playing }) {
    const session = this.#requireSession();
    if (!session.tracks.some((track) => track.id === trackId && track.status === 'ready')) {
      throw new RangeError('That song is not ready');
    }
    if (!(positionSec >= 0) || typeof playing !== 'boolean') throw new TypeError('Invalid playback state');
    const changedTrack = session.playback.trackId !== trackId;
    if (!playing || changedTrack) {
      const previous = session.tracks.find((track) => track.id === session.playback.trackId);
      const previousPlayed = session.playback.positionSec + (session.playback.playing ? (Date.now() - session.playback.at) / 1000 : 0);
      const endedNaturally = changedTrack && previous && (previous.durationSec ?? 0) - previousPlayed <= 3;
      await this.#dj?.cancel(!playing ? 'playback paused' : endedNaturally ? 'song ended' : 'track skipped', { trackId });
    }
    session.playback = { trackId, positionSec, playing, at: Date.now() };
    if (playing) session.held = false;
    if (changedTrack) await this.#updateSong(trackId, { lastPlayedAt: new Date().toISOString() });
    this.#plan(session);
    this.#dj?.consider(this.djContext());
    this.emit('change');
  }

  /**
   * Turns new songs off or on. While off the station plays its library;
   * DJ and News production remain independent and may use the voice engine.
   */
  async setGenerationEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Expected on or off');
    const session = this.#requireSession();
    if (session.lux) throw new RangeError('A LVX station has no new songs to stop');
    session.generationEnabled = enabled;
    if (!enabled) {
      session.tracks = session.tracks.filter((track) => track.status === 'ready');
      if (this.#jobFor(session)) await this.#abortJob();
      // DJ or News may be using the engine: their holds protect active voice work.
      if (!this.#job && this.#holds === 0) await this.#engine.stop();
    } else {
      session.error = null;
      session.failures = 0;
    }
    this.#startNext();
    this.emit('change');
  }

  /** A liked song stays in the library until the listener removes the like. */
  async setFeedback(trackId, type) {
    const changes = {
      like: { liked: true, disliked: false },
      unlike: { liked: false },
      dislike: { liked: false, disliked: true },
    }[type];
    if (!changes) throw new TypeError('Unknown feedback');
    await this.#updateSong(trackId, changes);
    const track = this.#session?.tracks.find((entry) => entry.id === trackId);
    if (track) track.liked = changes.liked;
    if (type === 'dislike' && this.#session) {
      await this.#dj?.rejectSong(trackId);
      await this.#dj?.cancel('song rejected');
      const session = this.#session;
      if (track?.id !== session.playback.trackId) session.tracks = session.tracks.filter((entry) => entry !== track);
      this.#plan(session);
    }
    this.emit('change');
  }

  /** Deletes only generated library audio; catalog and Live feedback stay separate. */
  async deleteSong(trackId) {
    if (typeof trackId !== 'string' || !this.#library.get(trackId) || this.#catalog?.has(trackId)) throw new RangeError('Unknown generated song');
    const freedBytes = await this.#library.deleteSong(trackId);
    const session = this.#session;
    let nextTrackId = session?.playback.trackId ?? null;
    if (session) {
      const index = session.tracks.findIndex(track => track.id === trackId);
      const current = session.playback.trackId === trackId;
      const next = current ? [...session.tracks.slice(index + 1), ...session.tracks.slice(0, index)].find(track => track.status === 'ready' && track.id !== trackId) : null;
      session.tracks = session.tracks.filter(track => track.id !== trackId);
      if (current) {
        nextTrackId = next?.id ?? null;
        session.playback = { trackId: nextTrackId, positionSec: 0, playing: Boolean(next && session.playback.playing), at: Date.now() };
        if (!next) session.held = true;
      }
      // Cancel an intro aimed at the removed song before replanning the queue.
      if (index >= 0) await this.#dj?.cancel('song deleted');
    }
    await this.#dj?.rejectSong(trackId);
    if (session === this.#session && session) this.#plan(session);
    this.emit('change');
    return { trackId, freedBytes, nextTrackId, sessionId: session?.id ?? null };
  }

  audioPath(trackId) {
    return this.#catalog?.audioPath(trackId) ?? this.#library.audioPath(trackId);
  }

  audioSource(trackId, mediaKey) {
    const track = this.#session?.tracks.find(entry => entry.id === trackId);
    if (track?.remoteUrl && mediaKey === track.mediaKey) return { url:track.remoteUrl, origin:track.remoteOrigin };
    if (mediaKey) return null;
    const path = this.audioPath(trackId);
    return path ? { path } : null;
  }

  /** Reconcile only radio queues; a generation job is independent of this. */
  catalogChanged({ reset = false } = {}) {
    const session = this.#session;
    if (session?.lux) {
      const current = session.tracks.find(track => track.id === session.playback.trackId);
      let record = this.#catalog.station(session.station.id);
      if (reset && (!record || current?.remoteUrl)) {
        record ??= this.#catalog.stations().find(station => this.#catalog.countForStation(station.id) > 0);
        if (record) { session.station = record; session.config = record.config; }
        session.tracks = []; session.playback = { trackId:null, positionSec:0, playing:false, at:Date.now() };
      } else {
        if (record) session.station = record;
        session.tracks = current ? [current] : [];
      }
      const excluded = new Set(session.tracks.map(track => track.id));
      if (record) for (;;) {
        const song = this.#catalog.pick(record.id, excluded);
        if (!song) break;
        excluded.add(song.id); this.#appendSong(session, song);
      }
      session.listed = true;
      session.error = record && !session.tracks.length ? 'This station has no playable songs. Refresh stations or tune to another station.' : null;
    }
    this.emit('change');
  }

  playbackFailed(trackId, mediaKey) {
    const session = this.#session;
    const track = session?.tracks.find(entry => entry.id === trackId && entry.mediaKey === mediaKey && entry.remoteUrl);
    if (!track) return;
    this.#catalog.failRemote(trackId);
    session.tracks = session.tracks.filter(entry => entry !== track);
    if (session.playback.trackId === trackId) session.playback.trackId = null;
    this.catalogChanged();
  }

  /** A station's DJ and the co-host who talks with it, as the snapshot shows them. */
  #djPair({ id, config, lux, live, dj, coHost }) {
    const own = !lux && !live;
    const pick = own ? stationDj({ dj, config }) : this.#dj?.luxDj ? this.#dj.luxDj({ id, config }) : {};
    if (!pick.dj || !this.#dj?.coHost) return pick;
    return { ...pick, ...this.#dj.coHost(pick.dj, styleFor(config), own ? stationCoHostChoice({ coHost }) : this.#dj.luxCoHostChoice({ id })) };
  }

  engineStatus() {
    return this.#availability();
  }

  snapshot() {
    const session = this.#session;
    const stations = [...(this.#catalog?.stations() ?? []), ...this.#stations.list()].map(
      ({ id, k, name, quote, config, lastPlayedAt, firstSeed, lux = false, live = false, genre, dj, coHost }) => ({
        id,
        k,
        name,
        quote,
        config,
        lastPlayedAt,
        firstSeed,
        lux,
        live,
        genre,
        ...this.#djPair({ id, config, lux, live, dj, coHost }),
        songCount: lux ? this.#catalog.countForStation(id) : this.#library.countForStation(id),
      }),
    );
    const preparation = this.#preparationSnapshot();
    if (!session) return { stationId: null, station: null, stations, tracks: [], error: null, generation: null, preparation, job: this.#jobSnapshot(), arrival: this.#arrival };
    return {
      stationId: session.id,
      station: stations.find(({ id }) => id === session.station.id) ?? { ...session.station, unavailable:true },
      stations,
      error: session.error,
      tracks: session.tracks,
      playbackTrackId: session.playback.trackId,
      generation: {
        enabled: session.generationEnabled,
        active: this.#jobFor(session),
        waitingFor: this.#job && !this.#jobFor(session) && session.tracks.at(-1)?.status === 'queued' ? this.#job.station.name : null,
        libraryCount: this.#library.playableCount(bucketFor(session.config)),
      },
      preparation,
      job: this.#jobSnapshot(),
      arrival: this.#arrival,
    };
  }

  #preparationSnapshot() {
    if (!this.#preparation) return null;
    const { id, station, status, startedAt, estimateSec, error } = this.#preparation;
    return { id, stationId: station.id, k: station.k, name: station.name, status, startedAt, estimateSec, error };
  }

  /** A song the strip must name: elsewhere, or holding up a new station. */
  #jobSnapshot() {
    const job = this.#job;
    if (!job || job.preparation) return null;
    if (this.#jobFor(this.#session) && this.#preparation?.status !== 'waiting') return null;
    const { station, startedAt, estimateSec } = job;
    return { stationId: station.id, k: station.k, name: station.name, startedAt, estimateSec };
  }

  async close() {
    clearInterval(this.#timer);
    this.#session = null;
    this.#preparation = null;
    this.#job = null;
    await this.#dj?.close();
    await this.#engine.stop();
  }

  #requireSession() {
    if (!this.#session) throw new RangeError('No station is on air');
    return this.#session;
  }

  #estimateFor(config) {
    return this.#estimates[config.instrumental ? 'instrumental' : 'sung'];
  }

  #jobFor(session) {
    return Boolean(session) && this.#job?.station.id === session.station.id;
  }

  #canGenerate(session) {
    return !this.#libraryOnly && session.generationEnabled && !session.error && this.#modelReady;
  }

  #updateSong(trackId, changes) {
    return this.#catalog?.has(trackId) ? this.#catalog.update(trackId, changes) : this.#library.update(trackId, changes);
  }

  async #refreshModel() {
    this.#modelReady = (await this.#availability()).ready;
  }

  #tick() {
    this.#refreshModel().catch((error) => console.error('Could not check the model:', error.message));
    const session = this.#session;
    if (session) { this.#plan(session); this.#dj?.consider(this.djContext()); }
    if (!this.#job && this.#holds === 0 && Date.now() - this.#lastWorkAt > this.#idleUnloadMs) {
      this.#engine.stop().catch((error) => console.error('Could not unload the engine:', error.message));
    }
  }

  #plan(session) {
    if (session !== this.#session) return;
    const before = session.tracks.length;
    this.#fillSchedule(session);
    this.#keepPlaying(session);
    const started = this.#startGenerationIfDue(session);
    if (!started && session.tracks.length !== before) this.emit('change');
  }

  #upcoming(session) {
    const index = session.tracks.findIndex((track) => track.id === session.playback.trackId);
    return session.tracks.slice(index + 1);
  }

  /** Seconds of music available before the listener would hear silence. */
  #runwaySeconds(session) {
    const { trackId, positionSec, playing, at } = session.playback;
    const current = session.tracks.find((track) => track.id === trackId);
    const played = positionSec + (playing ? (Date.now() - at) / 1000 : 0);
    const remaining = current ? Math.max((current.durationSec ?? 0) - played, 0) : 0;
    return this.#upcoming(session)
      .filter((track) => track.status === 'ready')
      .reduce((total, track) => total + track.durationSec, remaining);
  }

  /** Returning to a station lists everything stored on it, in one go. */
  #listStationSongs(session) {
    session.listed = true;
    const composing = this.#jobFor(session) ? this.#job.track : null;
    const scheduled = new Set(composing ? [composing.id] : []);
    for (;;) {
      const song = this.#nextStored(session, bucketFor(session.config), scheduled);
      if (!song || (!session.lux && song.stationId !== session.station.id)) break;
      scheduled.add(song.id);
      this.#appendSong(session, song);
    }
    if (scheduled.size) session.replaysSinceNewSong = Infinity;
    if (composing) {
      session.tracks.push(composing);
      session.seed = composing.seed + 1;
    }
  }

  #fillSchedule(session) {
    if (session.fromLibrary && !session.listed) this.#listStationSongs(session);
    for (;;) {
      const tail = session.tracks.at(-1);
      if (tail && tail.status !== 'ready') return;
      if (!tail && this.#canGenerate(session) && !session.fromLibrary) {
        this.#queueNewSong(session);
        return;
      }
      const bucket = bucketFor(session.config);
      if (this.#libraryOnly) {
        if (this.#upcoming(session).length >= 5) return;
        if (!this.#appendReplay(session, bucket, this.#playingIds(session))) return;
        continue;
      }
      if (session.lux || !this.#canGenerate(session)) {
        // LVX keeps two songs ahead when it has them, so a DJ line can aim at the end of the next one.
        if (this.#upcoming(session).length >= (session.lux ? 2 : 1)) return;
        if (!this.#appendReplay(session, bucket, this.#playingIds(session))) return;
        continue;
      }
      const count = this.#library.playableCount(bucket);
      const usual = Math.min(MAX_REPLAYS_BETWEEN_NEW_SONGS, Math.ceil(count / SONGS_PER_EXTRA_REPLAY));
      const scheduled = new Set(session.tracks.map((track) => track.id));
      if (session.replaysSinceNewSong < usual && this.#appendReplay(session, bucket, scheduled)) {
        session.replaysSinceNewSong += 1;
        continue;
      }
      this.#queueNewSong(session);
      return;
    }
  }

  /** A song waiting for the engine must not leave the listener in silence. */
  #keepPlaying(session) {
    const tail = session.tracks.at(-1);
    if (!tail || tail.status === 'ready' || !this.#job) return;
    if (this.#upcoming(session).some((track) => track.status === 'ready')) return;
    const song = this.#nextStored(session, bucketFor(session.config), this.#playingIds(session));
    if (song) this.#listBeforeTail(session, song);
  }

  #playingIds(session) {
    return new Set([session.playback.trackId, ...this.#upcoming(session).map((track) => track.id)]);
  }

  #nextStored(session, bucket, excludedIds) {
    return session.lux
      ? this.#catalog.pick(session.station.id, excludedIds)
      : this.#library.pick(bucket, excludedIds, session.station.id);
  }

  #appendReplay(session, bucket, excludedIds) {
    const song = this.#nextStored(session, bucket, excludedIds);
    if (!song) return false;
    this.#appendSong(session, song);
    return true;
  }

  #appendSong(session, song) {
    session.tracks = session.tracks.filter((track) => track.id !== song.id);
    session.tracks.push({
      id: song.id,
      title: song.title,
      status: 'ready',
      source: 'library',
      ...(song.remoteUrl ? { source:'remote', remoteUrl:song.remoteUrl, remoteOrigin:song.remoteOrigin, mediaKey:song.mediaKey } : {}),
      generation: song.generation,
      durationSec: song.durationSec,
      sizeBytes: song.sizeBytes,
      truncated: song.truncated,
      liked: song.liked,
      createdAt: song.createdAt,
      generatedAt: song.createdAt,
      startedAt: null,
      estimateSec: null,
    });
  }

  #queueNewSong(session) {
    session.newSongs += 1;
    session.tracks.push({
      id: randomUUID(),
      seed: session.seed + session.newSongs - 1,
      title: TITLES[(this.#library.size + session.newSongs - 1) % TITLES.length],
      status: 'queued',
      source: 'new',
      generation: session.config,
      durationSec: null,
      truncated: false,
      liked: false,
      createdAt: new Date().toISOString(),
      generatedAt: null,
      startedAt: null,
      estimateSec: null,
    });
  }

  #startGenerationIfDue(session) {
    const track = session.tracks.at(-1);
    if (track?.status !== 'queued' || this.#job || this.#holds > 0 || !this.#canGenerate(session)) return false;
    if (this.#preparation?.status === 'waiting') return false;
    if (track.requested) {
      this.#startSong(session, track);
      return true;
    }
    if (session.held) return false;
    const waitingOnPause = !session.playback.playing && this.#upcoming(session).some((entry) => entry.status === 'ready');
    if (waitingOnPause) return false;
    if (this.#runwaySeconds(session) >= this.#estimateFor(session.config) + this.#leadMarginSec) return false;
    this.#startSong(session, track);
    return true;
  }

  #startSong(session, track) {
    Object.assign(track, {
      status: 'generating',
      generation: session.config,
      startedAt: Date.now(),
      estimateSec: this.#estimateFor(session.config),
    });
    this.#runJob({
      station: session.station,
      track,
      preparation: null,
      config: track.generation,
      seed: track.seed,
      song: { id: track.id, title: track.title, createdAt: track.createdAt },
      startedAt: track.startedAt,
      estimateSec: track.estimateSec,
    });
  }

  #startPreparation(preparation) {
    Object.assign(preparation, { status: 'composing', startedAt: Date.now(), estimateSec: this.#estimateFor(preparation.config) });
    this.#runJob({
      station: preparation.station,
      track: null,
      preparation,
      config: preparation.config,
      seed: preparation.seed,
      song: { id: randomUUID(), title: preparation.title, createdAt: preparation.createdAt },
      startedAt: preparation.startedAt,
      estimateSec: preparation.estimateSec,
    });
  }

  /** The next work once the engine is free: a new station first, then the one on air. */
  #startNext() {
    if (this.#job || this.#holds > 0) return;
    if (this.#grantHold()) return;
    if (this.#preparation?.status === 'waiting') this.#startPreparation(this.#preparation);
    else if (this.#session) this.#plan(this.#session);
  }

  /**
   * Lends the engine to another job (the news voice). Returns a release function, or null
   * while a song is composing: a running song is never interrupted. No song starts until released.
   */
  tryHold() {
    if (!this.#job && this.#holds === 0 && this.#session) this.#plan(this.#session);
    if (!this.#job && this.#holds === 0 && this.#holdWaiters.length) { this.#grantHold(); return null; }
    if (this.#job || this.#holds > 0) return null;
    this.#holds += 1;
    this.#lastWorkAt = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holds -= 1;
      this.#lastWorkAt = Date.now();
      this.#startNext();
    };
  }

  /**
   * Like `tryHold`, but patient: `onGranted(release)` is called as soon as the engine is
   * free, before the next song is planned, so back-to-back songs cannot starve the news.
   * Returns a function that withdraws the request.
   */
  requestHold(onGranted, { priority = 'news', expiresAt = Infinity, plan = true } = {}) {
    const waiter = { onGranted, priority: priority === 'dj' ? 1 : 2, expiresAt };
    this.#holdWaiters.push(waiter);
    this.#holdWaiters.sort((a, b) => a.priority - b.priority || a.expiresAt - b.expiresAt);
    // plan: false (a DJ voice audition) goes ahead of a song that is due but not yet started.
    if (plan && !this.#job && this.#holds === 0 && this.#session) this.#plan(this.#session);
    this.#grantHold();
    return () => { this.#holdWaiters = this.#holdWaiters.filter((entry) => entry !== waiter); };
  }

  #grantHold() {
    if (this.#job || this.#holds > 0 || !this.#holdWaiters.length) return false;
    const now = Date.now();
    this.#holdWaiters = this.#holdWaiters.filter((entry) => entry.expiresAt > now);
    const entry = this.#holdWaiters.shift();
    if (!entry) return false;
    this.#holds += 1;
    this.#lastWorkAt = Date.now();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#holds -= 1;
      this.#lastWorkAt = Date.now();
      this.#startNext();
    };
    entry.onGranted(release);
    return true;
  }

  /** True while the listener has the radio playing (as reported by the player). */
  isPlaying() {
    return Boolean(this.#session?.playback?.playing);
  }

  /** Loses the running song. The caller decides what starts next. */
  async #abortJob() {
    const job = this.#job;
    if (!job) return;
    this.#job = null;
    if (job.preparation && this.#preparation === job.preparation) this.#preparation = null;
    if (this.#session) this.#session.tracks = this.#session.tracks.filter((track) => track !== job.track);
    await this.#engine.abort();
  }

  async #runJob(job) {
    this.#job = job;
    this.#lastWorkAt = Date.now();
    this.emit('change');
    let failures = 0;
    for (;;) {
      try {
        const result = await this.#compose(job);
        if (this.#job !== job) return;
        await this.#finishJob(job, result);
        break;
      } catch (error) {
        if (this.#job !== job || error instanceof EngineAbortedError) return;
        console.error('Generation failed:', error.message);
        failures += 1;
        if (job.preparation && failures < MAX_CONSECUTIVE_FAILURES) continue;
        this.#failJob(job, error);
        break;
      }
    }
    if (this.#job !== job) return;
    this.#job = null;
    this.#lastWorkAt = Date.now();
    this.#startNext();
    this.emit('change');
  }

  #compose(job) {
    return job.config.instrumental ? this.#composeInstrumental(job) : this.#engine.run(directRequest(job.config, job.seed));
  }

  /** Plans a score, rests its vocal line and renders that. An abort ends the run. */
  async #composeInstrumental(job) {
    const request = directRequest(job.config, job.seed);
    let lastError;
    for (let attempt = 0; attempt < PLANNING_ATTEMPTS; attempt += 1) {
      const planning = { ...request, seed: job.seed + attempt, options: { ...request.options, stop_after: 'abc' } };
      const plan = await this.#engine.run(planning);
      if (this.#job !== job) throw new EngineAbortedError();
      try {
        const abc = scoreFromPlan(plan);
        return await this.#engine.run({ ...request, options: { ...request.options, abc } });
      } catch (error) {
        if (error instanceof EngineAbortedError || !/score/.test(error.message)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  async #finishJob(job, result) {
    const live = this.#jobFor(this.#session) ? this.#session : null;
    const protectedIds = new Set(this.#session?.tracks.map((track) => track.id));
    const stored = await this.#storeSong(
      { ...job.song, stationId: job.station.id, generation: job.config, seed: job.seed },
      result,
      job.startedAt,
      protectedIds,
    );
    if (job.track) {
      Object.assign(job.track, { status: 'ready', ...stored, generatedAt: new Date().toISOString() });
      if (live) Object.assign(live, { replaysSinceNewSong: 0, failures: 0 });
    }
    if (job.preparation) job.preparation.status = 'ready';
    if (live && !job.track) this.#listBeforeTail(live, this.#library.get(job.song.id));
    if (!live && !job.preparation) {
      const { id: stationId, k, name } = job.station;
      this.#arrival = { stationId, k, name, title: job.song.title };
    }
  }

  /** A stored song joins the list ahead of whatever is still to come. */
  #listBeforeTail(session, song) {
    const pending = session.tracks.filter((track) => track.status !== 'ready');
    this.#appendSong(session, song);
    session.tracks = [...session.tracks.filter((track) => !pending.includes(track)), ...pending];
  }

  #failJob(job, error) {
    if (job.preparation) Object.assign(job.preparation, { status: 'failed', error: error.message });
    if (job.track && this.#jobFor(this.#session)) this.#recordFailure(this.#session, job.track, error);
  }

  async #storeSong(song, result, startedAt, protectedIds) {
    if (!result.audio) throw new Error('The engine returned no audio');
    const wav = Buffer.from(result.audio, 'base64');
    const durationSec = wavDurationSeconds(wav);
    const truncated = wasTruncated(result);
    await this.#library.add({ ...song, bucket: bucketFor(song.generation), durationSec, truncated }, wav);
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const mode = song.generation.instrumental ? 'instrumental' : 'sung';
    this.#estimates[mode] += (elapsedSec - this.#estimates[mode]) * ESTIMATE_SMOOTHING;
    await this.#library.evict(protectedIds.add(song.id));
    return { durationSec, truncated, sizeBytes: wav.length };
  }

  #recordFailure(session, track, error) {
    session.tracks = session.tracks.filter((entry) => entry !== track);
    session.failures += 1;
    if (session.failures >= MAX_CONSECUTIVE_FAILURES) session.error = error.message;
  }
}
