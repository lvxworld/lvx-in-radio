import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readWav, wavDurationSeconds } from '../../engine/wav.js';
import { buildDjWriterRequest, djTitle, loadDjPrompts, nextSongMoodWord } from '../dj/prompts.js';
import { DjLlm } from './dj-llm.js';
import { buildDuoRequest, buildNewsRequest, coHostFor, headlineLine, joinTurns, parseDuo, validateDuo, validateNewsLine } from './dj-duo.js';
import djLlmManifest from '../../engine/dj-llm-manifest.json' with { type: 'json' };
import { DJ_IDS, luxStationDj, styleFor } from './dj-style.js';
import { PREVIEW_TEXT, VOICE_VERSION, loadBundledPreviews } from './dj-preview.js';

// v2: two-host breaks made before hosts stopped naming themselves are never replayed.
const LINE_VERSION = 'dj-duo-v2';
// A break mentions at most one news story per hour, from the newest bulletin, never the same one twice.
const NEWS_EVERY_MS = 60 * 60_000;
const MARGIN_SEC = 30;
const DJ_COLD_ESTIMATE_SEC = 60;
const DJ_WARM_ESTIMATE_SEC = 25;
const MAX_CACHE_BYTES = 512 * 1024 ** 2;
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60_000;
const ID = /^[a-f0-9]{64}$/;
// How often a DJ speaks: every minSongs..maxSongs songs; 1 to 1 is after every song.
const CADENCE = [1, 2, 3, 4];
const PREVIEW_WAIT_MS = 5 * 60_000;
const LOG_MAX_BYTES = 256 * 1024;
// A cached LVX line is reused this many times before a new variant is written (few songs, many repeats).
const LUX_LINE_REUSE = 2;
const LUX_LINE_VARIANTS = 10;
const words = (text) => text.trim().split(/\s+/).filter(Boolean);
// llama-server from PATH (Homebrew's llama.cpp) when no bundled copy exists.
const DEFAULT_RUNTIME = { command: 'llama-server', args: [] };
// Runtimes saved by v0.2.0 (python3 -m mlx_lm.server, or its bundled launcher) and bundled
// llama-server paths: defaults, not choices, so they never shadow the bundle.
const OLD_DEFAULTS = [{ command: 'python3', args: ['-m', 'mlx_lm.server'] }, DEFAULT_RUNTIME];
const BUNDLED_LAUNCHER = /(^|\/)dj-llm\/(bin\/mlx_lm\.server|llama-server)$/;
// The writer model is one GGUF file inside the setup's folder.
export const WRITER_MODEL_FILE = djLlmManifest.files[0].path;

/**
 * Which writer process the DJ runs. LVX_DJ_LLM_COMMAND wins, then a runtime the listener set
 * through the API, then the llama-server bundled with the app (vendor/dj-llm or Resources/dj-llm),
 * then llama-server from PATH.
 */
export function resolveDjRuntime({ env = process.env, bundledCommand = null, saved = null } = {}) {
  const port = Number(env.LVX_DJ_LLM_PORT ?? saved?.port ?? 8765);
  if (env.LVX_DJ_LLM_COMMAND) return { command: env.LVX_DJ_LLM_COMMAND, args: [], port };
  const old = OLD_DEFAULTS.some((entry) => saved?.command === entry.command && JSON.stringify(saved?.args ?? entry.args) === JSON.stringify(entry.args));
  const bundled = typeof saved?.command === 'string' && BUNDLED_LAUNCHER.test(saved.command);
  if (typeof saved?.command === 'string' && saved.command.trim() && !old && !bundled) {
    return { command: saved.command, args: Array.isArray(saved.args) ? [...saved.args] : [], port };
  }
  if (bundledCommand) return { command: bundledCommand, args: [], port };
  return { command: DEFAULT_RUNTIME.command, args: [], port };
}

function rssBytes(dataDir) {
  try {
    const { pid } = JSON.parse(requireReadFile(join(dataDir, 'engine-process.json')));
    const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    return Number.isFinite(rss) ? rss * 1024 : 0;
  } catch { return 0; }
}

function requireReadFile(path) {
  // Kept synchronous: this is called only immediately before a resource-tier decision.
  return execFileSync('cat', [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function readMacMemory() {
  try {
    const output = execFileSync('vm_stat', [], { encoding: 'utf8' });
    const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1] ?? 4096);
    const pages = (name) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(output)?.[1] ?? 0);
    const availableBytes = (pages('free') + pages('inactive') + pages('purgeable')) * pageSize;
    const pressure = execFileSync('memory_pressure', ['-Q'], { encoding: 'utf8' });
    const freePercent = Number(/free percentage:\s*(\d+)%/i.exec(pressure)?.[1] ?? 100);
    return { availableBytes, freePercent };
  } catch { return { availableBytes: 0, freePercent: 0 }; }
}

function clean(value, fallback) {
  const text = String(value ?? '').replace(/[\r\n{}<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 100) : fallback;
}

export function validateDjLine(text, title) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  const count = (trimmed.match(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) ?? []).length;
  return words(trimmed).length >= 35 && words(trimmed).length <= 60 && count === 1 &&
    !/[\[\]<>*_`#]/.test(trimmed) && !/\b(?:previous track|last song)\b/i.test(trimmed) &&
    !/\b(?:[A-Z][a-z]+\s+(?:Park|Arena|City|Festival))\b/.test(trimmed);
}


function metadata(config) {
  const genre = Object.entries(config?.mix ?? {}).sort((a, b) => b[1] - a[1]).map(([name]) => name).slice(0, 2).join(' and ') || 'music';
  const bpm = Number.isFinite(config?.bpm) ? Math.round(config.bpm) : 100;
  return { genre, bpm, mood: clean(config?.mood, 'an easygoing') };
}

function renderFallback(template, { title, genre, bpm, mood }) {
  return template.replaceAll('{title}', title).replaceAll('{genre}', genre).replaceAll('{bpm}', String(bpm)).replaceAll('{mood}', mood);
}

async function atomic(path, data) {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
}

/** DJ orchestration, persistence, caching, writer and shared Qwen voice adapter. */
export class DjDesk extends EventEmitter {
  #dataDir; #cacheDir; #settingsFile; #station; #engine; #model; #voice; #llm; #llmModelDir = null;
  #prompts; #freeMemory; #isWarm; #newsUrgent; #settings; #llmCommand;
  #lastLine = null; #last = null; #nextSlot = null; #preview = null; #tier = null; #active = null; #introduction = null; #introductionTimer = null; #modelPoll = null;
  #states = new Map(); #openers = []; #writerStructures = []; #writerHumour = []; #closed = false; #ready = false; #missing = ['llm', 'voice'];

  #slotEverySong; #bundledPreviews = new Map(); #previewsDir; #luxChoices = {}; #headlines; #newsAt = 0; #mentioned = new Set(); #luxCoHosts = {};
  constructor({ dataDir, cacheDir = join(dataDir, 'dj'), station, engine, modelSetup, voiceSetup, freeMemory = readMacMemory, newsUrgent = () => false, headlines = () => [], promptFolders, slotEverySong = false, isWarm, llmCommand = null, previewsDir } = {}) {
    super();
    this.#headlines = headlines;
    this.#previewsDir = previewsDir;
    this.#llmCommand = llmCommand;
    this.#settings = { enabled: false, minSongs: 2, maxSongs: 4, runtime: resolveDjRuntime({ bundledCommand: llmCommand }) }; this.#dataDir = dataDir; this.#cacheDir = cacheDir; this.#settingsFile = join(dataDir, 'dj-settings.json');
    this.#station = station; this.#engine = engine; this.#model = modelSetup; this.#voice = voiceSetup;
    this.#freeMemory = freeMemory; this.#newsUrgent = newsUrgent;
    this.#slotEverySong = slotEverySong;
    this.#isWarm = isWarm ?? (() => this.#engine.isWarm?.('qwen3tts') === true && (this.#tier === 2 || this.#llm?.isWarm() === true));
    this.promptFolders = promptFolders; this.#llm = null;
  }

  async load() {
    this.#prompts = await loadDjPrompts(this.promptFolders);
    this.#bundledPreviews = loadBundledPreviews(this.#prompts, this.#previewsDir ? { dir: this.#previewsDir } : {});
    try {
      const saved = JSON.parse(await readFile(this.#settingsFile, 'utf8'));
      if (saved.version === 1) {
        this.#settings = { ...this.#settings, enabled: saved.enabled === true, minSongs: saved.minSongs ?? 2, maxSongs: saved.maxSongs ?? 4 };
        this.#settings.runtime = resolveDjRuntime({ bundledCommand: this.#llmCommand, saved: saved.runtime ?? null });
        // LVX stations' choices; listener stations keep theirs in stations.json. Unknown ids mean "default".
        for (const [id, choice] of Object.entries(saved.stations && typeof saved.stations === 'object' ? saved.stations : {})) {
          if (/^[\w:-]{1,80}$/.test(id) && (choice === null || DJ_IDS.includes(choice))) this.#luxChoices[id] = choice;
        }
        for (const [id, choice] of Object.entries(saved.coHosts && typeof saved.coHosts === 'object' ? saved.coHosts : {})) {
          if (/^[\w:-]{1,80}$/.test(id) && (choice === null || DJ_IDS.includes(choice))) this.#luxCoHosts[id] = choice;
        }
      }
    } catch {}
    if (!CADENCE.includes(this.#settings.minSongs) || !CADENCE.includes(this.#settings.maxSongs) || this.#settings.minSongs > this.#settings.maxSongs) {
      this.#settings.minSongs = 2; this.#settings.maxSongs = 4;
    }
    await mkdir(this.#cacheDir, { recursive: true });
    const candidates = (await readdir(this.#cacheDir).catch(() => [])).filter((name) => name.endsWith('.json'));
    for (const name of candidates) {
      try {
        const metadata = JSON.parse(await readFile(join(this.#cacheDir, name), 'utf8'));
        if (!ID.test(metadata.id) || metadata.id !== name.slice(0, -5) || typeof metadata.text !== 'string' || !Number.isFinite(metadata.durationSec)) await rm(join(this.#cacheDir, name), { force: true });
      } catch { await rm(join(this.#cacheDir, name), { force: true }); }
    }
    await this.#save();
    await this.settings();
    if (!this.#ready) { this.#settings.enabled = false; await this.#save(); }
    let modelStamp = '';
    this.#modelPoll = setInterval(async () => {
      const [model, voice] = await Promise.all([this.#model.snapshot(), this.#voice.snapshot()]);
      const stamp = JSON.stringify([model, voice]);
      if (stamp !== modelStamp) { modelStamp = stamp; await this.settings(); this.emit('change'); }
    }, 500);
    this.#modelPoll.unref?.();
  }

  async #save() { await atomic(this.#settingsFile, JSON.stringify({ version: 1, ...this.#settings, stations: this.#luxChoices, coHosts: this.#luxCoHosts })); }

  /** An LVX station's effective DJ: its own choice, else the style default (bundled four only). */
  luxDj(station) { return luxStationDj(station, this.#luxChoices); }

  /** An LVX station's chosen co-host: an id, null (talks alone), undefined (automatic). */
  luxCoHostChoice(station) { return Object.hasOwn(this.#luxCoHosts, station.id) ? this.#luxCoHosts[station.id] : undefined; }

  /** Chooses one LVX station's DJ or co-host (role): a catalog id, null for none, 'default' to forget the choice. */
  async setLuxDj(station, djId, role = 'dj') {
    if (!DJ_IDS.includes(djId) && djId !== null && djId !== 'default') throw new RangeError('Unknown DJ');
    const choices = role === 'coHost' ? this.#luxCoHosts : this.#luxChoices;
    if (djId === 'default') delete choices[station.id];
    else choices[station.id] = djId;
    await this.#save(); this.emit('change');
    return { stationId: station.id, ...this.luxDj(station) };
  }

  /**
   * Who talks with `djId`: a chosen DJ of the other sex, nobody when the choice is null, otherwise
   * the automatic co-host (a choice left invalid by a new DJ falls back to it).
   */
  coHost(djId, styleId, choice) {
    const dj = this.#prompts.djs.find((entry) => entry.id === djId);
    if (!dj || choice === null) return { coHost: null, coHostChosen: Boolean(dj) };
    const chosen = this.#prompts.djs.find((entry) => entry.id === choice && entry.gender !== dj.gender);
    return chosen ? { coHost: chosen.id, coHostChosen: true } : { coHost: coHostFor(this.#prompts.djs, dj, styleId)?.id ?? null, coHostChosen: false };
  }

  /**
   * The transition a slot aims at. Listener stations: the end of the song on air. LVX stations
   * (MP3s of known length, often shorter than a cold DJ start): the end of the song on air when the
   * runway allows, else the end of the next song, introducing the one after it.
   */
  #target(context) {
    if (!context?.lux) return context?.stationId ? { ...context, anchorTrackId: context.playbackTrackId } : context;
    const direct = { ...context, songEstimateSec: 0, next: this.#luxSong(context.next, context.config), anchorTrackId: context.playbackTrackId };
    if (!context.next || context.runwaySec >= this.#runwayBudget(direct).minimumSec) return direct;
    if (!(context.next.durationSec > 0) || !context.after) return direct;
    return { ...direct, current: context.next, next: this.#luxSong(context.after, context.config), anchorTrackId: context.next.id, fromTrackId: context.playbackTrackId, runwaySec: context.runwaySec + context.next.durationSec, ahead: true };
  }

  /** LVX MP3s carry no mood: one word from prompts/lux-moods.json, the manifest, or the station style. */
  #luxSong(track, config) {
    if (!track) return track;
    const style = this.#prompts.styles.find((entry) => entry.id === styleFor(config)) ?? this.#prompts.styles.find((entry) => entry.id === 'generic');
    const words = style.moodWords;
    const fallback = words[createHash('sha256').update(String(track.id)).digest()[0] % words.length];
    const mood = this.#prompts.luxMoods?.[track.id] ?? (typeof track.generation?.mood === 'string' && track.generation.mood.trim() ? track.generation.mood : fallback);
    return { ...track, generation: { ...(track.generation ?? {}), mood } };
  }

  /** Whether a slot aimed at `target` still fits what is on air now. */
  #stillOn(target, context) {
    if (!context?.playing || target.stationId !== context.stationId) return false;
    if (!target.lux) return context.playbackTrackId === target.playbackTrackId;
    if (context.playbackTrackId === target.anchorTrackId) return context.next?.id === target.next.id;
    return target.ahead && context.playbackTrackId === target.fromTrackId && context.next?.id === target.anchorTrackId && context.after?.id === target.next.id;
  }

  async settings() {
    const [model, voice] = await Promise.all([this.#model.snapshot(), this.#voice.snapshot()]);
    const missing = [...(!model.ready ? ['llm'] : []), ...(!voice.ready ? ['voice'] : [])];
    const ready = missing.length === 0;
    this.#ready = ready; this.#missing = missing;
    return { ...this.#settings, ready, status: !this.#settings.enabled ? 'off' : ready ? 'ready' : 'waiting', missing, model, voice: { ...voice, sharedWith: 'news' } };
  }

  async configure(change) {
    const { stationId, djId, coHostId, ...settings } = change ?? {};
    if (stationId !== undefined) {
      const role = Object.hasOwn(change, 'coHostId') ? 'coHost' : 'dj';
      const value = role === 'coHost' ? coHostId : djId;
      if (typeof stationId !== 'string' || (value !== null && typeof value !== 'string')) throw new TypeError('Invalid station DJ choice');
      return this.#station.setDj(stationId, value, role);
    }
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'enabled' && typeof value === 'boolean') this.#settings.enabled = value;
      else if ((key === 'minSongs' || key === 'maxSongs') && CADENCE.includes(value)) this.#settings[key] = value;
      else if (key === 'runtime' && value && typeof value === 'object') {
        const next = { ...this.#settings.runtime, ...value };
        if (typeof next.command !== 'string' || !next.command.trim() || !Array.isArray(next.args) || next.args.some((arg) => typeof arg !== 'string') || !Number.isInteger(Number(next.port)) || Number(next.port) < 1024 || Number(next.port) > 65535) throw new TypeError('Invalid DJ LLM runtime settings');
        next.port = Number(next.port); this.#settings.runtime = next;
      }
      else throw new TypeError(`Invalid DJ setting: ${key}`);
    }
    if (this.#settings.minSongs > this.#settings.maxSongs) throw new TypeError('minSongs cannot exceed maxSongs');
    // A new cadence applies to the station on air too, not only after the next tune.
    if ('minSongs' in settings || 'maxSongs' in settings) for (const state of this.#states.values()) state.target = this.#slotTarget(randomInt(1_000_000));
    if (this.#settings.enabled) {
      const state = await this.settings();
      if (!state.ready) { this.#settings.enabled = false; throw Object.assign(new Error('Both DJ models must be ready first.'), { status: 409, readiness: state }); }
    }
    if (!this.#settings.enabled) {
      await this.cancel('DJs switched off');
      await this.#llm?.stop();
      this.#nextSlot = null;
    }
    await this.#llm?.configure(this.#settings.runtime);
    await this.#save(); this.emit('change');
    return this.settings();
  }

  async catalog() { return { djs: this.#prompts.djs, styles: this.#prompts.styles }; }

  modelSnapshot() { return this.#model.snapshot(); }
  downloadModel() { return this.#model.download(true); }
  pauseModel() { return this.#model.pause(); }
  useModelDirectory(path) { return this.#model.useDirectory(path, true); }

  snapshot() {
    return { enabled: this.#settings.enabled, ready: this.#ready, status: !this.#settings.enabled ? 'off' : this.#ready ? 'ready' : 'waiting', missing: this.#missing, nextSlot: this.#nextSlot, lastLine: this.#lastLine, last: this.#last, tier: this.#tier, preview: this.#preview, introduction: this.#introduction };
  }

  #setIntroduction(introduction) {
    if (JSON.stringify(this.#introduction) === JSON.stringify(introduction)) return;
    this.#introduction = introduction; this.emit('change');
  }

  #runwayBudget(context) {
    const songReserveSec = Number.isFinite(context.songEstimateSec) ? Math.max(0, context.songEstimateSec) : 0;
    const estimateSec = this.#isWarm() ? DJ_WARM_ESTIMATE_SEC : DJ_COLD_ESTIMATE_SEC;
    return {
      minimumSec: estimateSec + songReserveSec + MARGIN_SEC,
      productionMs: Math.max(0, (context.runwaySec - songReserveSec - MARGIN_SEC) * 1000),
    };
  }

  #slotReason(context) {
    if (!this.#ready) return 'models-missing';
    if (!context.playing || !context.current) return 'not-playing';
    if (this.#newsUrgent()) return 'news-urgent';
    if (!context.next) return 'next-song-not-ready';
    if (context.runwaySec < this.#runwayBudget(context).minimumSec) return 'not-enough-time';
    return null;
  }

  #stateFor(stationId, seed = 1, playbackSessionId) {
    if (!this.#states.has(stationId) || (playbackSessionId && this.#states.get(stationId).playbackSessionId !== playbackSessionId)) this.#states.set(stationId, { playbackSessionId, lastTrackId: null, songsSince: 0, target: this.#slotTarget(seed), lastDjId: null, offered: null, fresh: true });
    return this.#states.get(stationId);
  }
  #slotTarget(seed) { return this.#slotEverySong ? 1 : this.#settings.minSongs + (seed % (this.#settings.maxSongs - this.#settings.minSongs + 1)); }

  consider(context) {
    const intro = this.#introduction;
    if (this.#active?.slot && !this.#stillOn(this.#active.context, context)) {
      void this.cancel('automatic introduction context changed'); return;
    }
    if (!context?.stationId || !context.djId || !this.#settings.enabled) {
      this.#nextSlot = null; this.#setIntroduction(null); return;
    }
    const state = this.#stateFor(context.stationId, context.config?.seed ?? 1, context.playbackSessionId);
    if (context.playbackTrackId && context.playbackTrackId !== state.lastTrackId) {
      state.songsSince += 1;
      state.lastTrackId = context.playbackTrackId;
    }
    // Never on the first song after tuning (except the demo flag): a fresh playback session waits for its second song.
    const due = state.fresh && !this.#slotEverySong ? Math.max(2, state.target) : state.target;
    this.#nextSlot = this.#ready && context.playing ? { stationId: context.stationId, afterSongs: due, remainingSongs: Math.max(0, due - state.songsSince), songId: context.next?.id ?? null } : null;
    if (intro && ['armed', 'done'].includes(intro.state) && intro.stationId === context.stationId && context.playing && context.playbackTrackId === intro.nextSongId) {
      if (intro.state === 'armed') {
        const done = { ...intro, state: 'done' };
        clearTimeout(this.#introductionTimer);
        this.#introductionTimer = setTimeout(() => { if (this.#introduction === done) this.#setIntroduction(null); }, 4000);
        this.#introductionTimer.unref?.(); this.#setIntroduction(done);
      }
    }
    // An LVX slot aimed at the end of the NEXT song stays put while the song before it plays.
    const ahead = Boolean(intro?.fromTrackId && ['preparing', 'armed'].includes(intro.state) && intro.stationId === context.stationId && context.playing && intro.fromTrackId === context.playbackTrackId && intro.songId === context.next?.id && context.after?.id === intro.nextSongId);
    // An ahead line whose songs moved (catalog refresh) is dropped before the reset below replaces it.
    if (intro?.fromTrackId && intro.state === 'armed' && !ahead && intro.songId !== context.playbackTrackId && this.#lastLine?.songId === intro.nextSongId) this.#lastLine = null;
    if (ahead || (intro && ['armed', 'done'].includes(intro.state) && intro.stationId === context.stationId && context.playing && context.playbackTrackId === intro.nextSongId)) {
      // handled above, or waiting for its song
    } else if (!intro || intro.state === 'idle' || intro.stationId !== context.stationId || intro.songId !== context.playbackTrackId || !context.playing || (intro.nextSongId ?? null) !== (context.next?.id ?? null)) {
      clearTimeout(this.#introductionTimer);
      const reason = !this.#ready ? 'models-missing' : !context.playing || !context.current ? 'not-playing' : null;
      this.#setIntroduction({ stationId: context.stationId, songId: context.playbackTrackId ?? null, state: 'idle', ...(reason ? { reason } : {}) });
    }
    if (this.#active && this.#newsUrgent()) { void this.cancel('news became urgent'); return; }
    if (this.#closed || !this.#ready || !context.playing || !context.current || state.songsSince < due || this.#active) return;
    // A line is already armed or on its way for a transition still ahead: one at a time.
    if (ahead || (this.#introduction?.state === 'armed' && this.#introduction.stationId === context.stationId && this.#introduction.songId === context.playbackTrackId)) return;
    const target = this.#target(context);
    const reason = this.#slotReason(target);
    if (reason) { this.#skipSlot(state, context, reason); return; }
    if (state.offered === target.next.id) return;
    state.offered = target.next.id;
    const expiresAt = Date.now() + Math.max(1000, this.#runwayBudget(target).productionMs);
    const pending = { cancelWait: null, release: null, cancel: null, expiry: null, slot: true, context: target, state };
    this.#active = pending;
    this.#setIntroduction({ stationId: target.stationId, songId: target.anchorTrackId, nextSongId: target.next.id, state: 'preparing', ...(target.ahead ? { fromTrackId: target.fromTrackId } : {}) });
    const cancelWait = this.#station.requestHold((release) => {
      clearTimeout(pending.expiry);
      if (this.#active !== pending) { release(); return; }
      const latest = this.#target(this.#station.djContext());
      const changed = !latest?.stationId || latest.stationId !== target.stationId || latest.djId !== target.djId || latest.anchorTrackId !== target.anchorTrackId || latest.next?.id !== target.next.id || (!target.lux && latest.current?.id !== target.current.id);
      const reason = changed ? 'context-changed' : this.#slotReason(latest);
      if (reason) {
        this.#active = null; this.#skipSlot(state, context, reason); release(); return;
      }
      const active = this.#active = { cancelWait: null, release, cancel: null, slot: true, context: latest, state };
      active.deadline = setTimeout(() => { void this.cancel('DJ production runway deadline'); }, this.#runwayBudget(latest).productionMs); active.deadline.unref?.();
      void this.#produceLine(latest, state, release, 'slot');
    }, { priority: 'dj', expiresAt });
    pending.cancelWait = cancelWait;
    pending.cancel = () => { clearTimeout(pending.expiry); cancelWait(); if (this.#active === pending) this.#active = null; state.offered = null; };
    if (this.#active === pending) { pending.expiry = setTimeout(() => { pending.cancel(); this.#skipSlot(state, context, 'expired'); }, Math.max(0, expiresAt - Date.now())); pending.expiry.unref?.(); }
    this.emit('change');
  }

  #skipSlot(state, context, reason) {
    // Every skip is logged once per song and reason, with the gate values, so a DJ that never speaks can be diagnosed from dj.log.
    const key = `${context.playbackTrackId ?? ''}:${reason}`;
    if (state.loggedSkip !== key) {
      state.loggedSkip = key;
      this.#logLine({ stationId: context.stationId, songId: context.playbackTrackId ?? null, djId: context.djId ?? null, mode: 'slot', status: 'skipped', reason, songsSince: state.songsSince, due: state.target, fresh: state.fresh, runwaySec: Math.round(context.runwaySec ?? 0), warm: this.#isWarm(), next: context.next?.id ?? null, after: context.after?.id ?? null, lux: Boolean(context.lux) });
    }
    state.offered = null;
    // News needing the engine is brief: the slot stays due and is tried again as soon as News lets go.
    if (reason !== 'news-urgent') { state.fresh = false; state.songsSince = 0; state.target = this.#slotTarget(randomInt(1_000_000)); }
    this.#setIntroduction({ stationId: context.stationId, songId: context.playbackTrackId, nextSongId: context.next?.id ?? null, state: 'refused', reason });
  }

  async #tierChoice() {
    const memory = await this.#freeMemory();
    const normalized = typeof memory === 'number' ? { availableBytes: memory, freePercent: 100 } : memory ?? {};
    const engineBytes = rssBytes(this.#dataDir);
    const totalBudget = (normalized.availableBytes ?? 0) + engineBytes;
    if ((normalized.availableBytes ?? 0) >= 12 * 1024 ** 3 && totalBudget >= 18 * 1024 ** 3 && (normalized.freePercent ?? 100) >= 18) return 1;
    if ((normalized.availableBytes ?? 0) >= 10 * 1024 ** 3 && (normalized.freePercent ?? 100) >= 12) return 2;
    return 4;
  }

  /** One writer call: a single-DJ line, or with `hosts` a two-host break as JSON. */
  async #writerLine(context, style, signal, retry = false, hosts = null) {
    const input = { ...context, style, recentOpeners: this.#openers, recentStructures: this.#writerStructures, recentHumour: this.#writerHumour, retry };
    const request = hosts ? buildDuoRequest(this.#prompts, input, hosts) : buildDjWriterRequest(this.#prompts, input);
    this.#writerHumour.push(request.hints.humour);
    this.#writerHumour = this.#writerHumour.slice(-6);
    this.#writerStructures.push(request.hints.structure);
    this.#writerStructures = this.#writerStructures.slice(-6);
    return this.#llm.complete({ ...request, signal });
  }

  /** A news story the next break may mention, or null. */
  #story() {
    if (Date.now() - this.#newsAt < NEWS_EVERY_MS) return null;
    return this.#headlines().find((story) => story.language !== 'it' && story.title && !this.#mentioned.has(story.id)) ?? null;
  }

  /** The writer retells the story in one checked sentence; if it cannot, the headline is read as it is. */
  async #newsLine(story, signal) {
    for (const retry of [false, true]) {
      const line = await this.#llm.complete({ ...buildNewsRequest(this.#prompts, story, { retry }), signal });
      if (validateNewsLine(line, story)) return line.trim();
    }
    return headlineLine(story);
  }

  /**
   * The break as turns [{ djId, text }]. With the writer: a two-host break (two tries, plus the
   * story before the handoff), then a single line (two tries); otherwise a style template.
   */
  async #lineText(raw, style, tier, signal, hosts, story = null) {
    const title = djTitle(raw.next?.title);
    if (!title) throw new Error('The next song has no title the DJ can say');
    const context = { ...raw, next: { ...raw.next, title } };
    const alone = (text, source, used = tier) => ({ turns: [{ djId: hosts[0].id, text }], source, tier: used });
    if (tier === 1) {
      try {
        if (hosts[1]) {
          const check = { title, hosts, stationName: context.stationName, genres: Object.keys(context.config?.mix ?? {}) };
          for (const retry of [false, true]) {
            const turns = parseDuo(await this.#writerLine(context, style, signal, retry, hosts), hosts);
            if (!validateDuo(turns, check)) continue;
            const spoken = turns.map((turn) => ({ djId: hosts[turn.host].id, text: turn.text }));
            // The host who does not hand over reads the story, just before the handoff.
            if (story) spoken.splice(-1, 0, { djId: hosts[1 - turns.at(-1).host].id, text: await this.#newsLine(story, signal) });
            return { turns: spoken, source: 'llm', tier, story };
          }
        }
        for (const retry of [false, true]) {
          const line = await this.#writerLine(context, style, signal, retry);
          if (validateDjLine(line, context.next.title)) return alone(line.trim(), 'llm');
        }
      } catch (error) { if (signal?.aborted) throw error; console.warn('DJ writer unavailable; using template:', error.message); }
      await this.#llm?.stop();
    }
    const info = { ...metadata(context.next.generation ?? context.config), mood: nextSongMoodWord(context.next.generation) };
    const candidates = this.#prompts.fallback[style.id] ?? this.#prompts.fallback.generic ?? [];
    const offset = candidates.length ? randomInt(candidates.length) : 0;
    for (const template of [...candidates.slice(offset), ...candidates.slice(0, offset)]) {
      const text = renderFallback(template, { ...info, title: context.next.title });
      if (validateDjLine(text, context.next.title)) return alone(text, 'template', 2);
    }
    throw new Error(`No valid ${style.id} or generic DJ fallback template is configured`);
  }

  async #cached(key) {
    try {
      const meta = JSON.parse(await readFile(join(this.#cacheDir, `${key}.json`), 'utf8'));
      const wav = await readFile(join(this.#cacheDir, `${key}.wav`));
      const { sampleRate, samples } = readWav(wav); const durationSec = samples[0].length / sampleRate;
      if (meta.key !== key || !Number.isFinite(durationSec) || durationSec <= 0 || !samples[0].some((v) => Math.abs(v) > 0.002)) throw new Error('Bad DJ cache audio');
      return { ...meta, durationSec, wav };
    } catch { await Promise.all([rm(join(this.#cacheDir, `${key}.json`), { force: true }), rm(join(this.#cacheDir, `${key}.wav`), { force: true })]); return null; }
  }

  /** LVX songs repeat: a cached line is used again at most LUX_LINE_REUSE times, then a new variant is written. */
  async #luxVariant(context, dj, styleId, coHostId) {
    let first = null;
    for (let variant = 0; variant < LUX_LINE_VARIANTS; variant += 1) {
      const key = createHash('sha256').update(JSON.stringify(['lux', context.next.id, dj.id, coHostId, LINE_VERSION, VOICE_VERSION, styleId, variant])).digest('hex');
      const cached = await this.#cached(key);
      if (!cached) return { key, cached: null };
      first ??= { key, cached };
      if ((cached.uses ?? 1) <= LUX_LINE_REUSE) {
        const { wav: _audio, ...metadata } = cached;
        await atomic(join(this.#cacheDir, `${key}.json`), JSON.stringify({ ...metadata, uses: (cached.uses ?? 1) + 1 })).catch(() => {});
        return { key, cached };
      }
    }
    return first;
  }

  async #speak(text, dj, style) {
    const response = await this.#engine.run({ text, options: { speaker: dj.speaker, instruct: style.instruct, language: 'English' } }, { model: 'qwen3tts' });
    if (!response?.audio) throw new Error('Qwen voice engine returned no audio');
    const wav = Buffer.from(response.audio, 'base64');
    const { sampleRate, samples } = readWav(wav);
    const durationSec = samples[0].length / sampleRate;
    if (sampleRate < 24_000 || samples.length !== 1 || durationSec < 0.5 || durationSec > 60 || !samples[0].some((v) => Math.abs(v) > 0.002)) throw new Error('Qwen returned invalid DJ WAV audio');
    return { wav, durationSec };
  }

  async #store(key, record, wav) {
    await mkdir(this.#cacheDir, { recursive: true });
    const { wav: _audio, ...metadata } = record;
    await atomic(join(this.#cacheDir, `${key}.wav`), wav);
    await atomic(join(this.#cacheDir, `${key}.json`), JSON.stringify({ ...metadata, id: key, key, sizeBytes: wav.length, cachedAt: new Date().toISOString() }));
    await this.#prune();
  }

  async #prune() {
    const files = await readdir(this.#cacheDir).catch(() => []); const entries = [];
    for (const name of files.filter((n) => n.endsWith('.json'))) {
      const path = join(this.#cacheDir, name);
      try { const meta = JSON.parse(await readFile(path, 'utf8')); entries.push({ path, wav: join(this.#cacheDir, `${meta.id}.wav`), at: Date.parse(meta.cachedAt) || 0, bytes: meta.sizeBytes || 0 }); }
      catch { await rm(path, { force: true }); }
    }
    entries.sort((a, b) => a.at - b.at); let bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    for (const entry of entries) if (bytes > MAX_CACHE_BYTES || entry.at < Date.now() - MAX_CACHE_AGE_MS) { bytes -= entry.bytes; await Promise.all([rm(entry.path, { force: true }), rm(entry.wav, { force: true })]); }
  }

  async #produceLine(context, state, release, mode) {
    const startedAt = performance.now(); let outcome = null;
    const dj = this.#prompts.djs.find((entry) => entry.id === context.djId);
    const styleId = context.styleId ?? styleFor(context.config), style = this.#prompts.styles.find((entry) => entry.id === styleId) ?? this.#prompts.styles.find((entry) => entry.id === 'generic');
    const coHostId = this.coHost(dj.id, styleId, context.coHostChoice).coHost;
    const hosts = [dj, this.#prompts.djs.find((entry) => entry.id === coHostId) ?? null];
    let key = context.cacheKey ?? createHash('sha256').update(JSON.stringify([context.next.id, dj.id, coHostId, LINE_VERSION, VOICE_VERSION, styleId])).digest('hex');
    let wasReleased = false;
    const active = this.#active;
    active.controller = new AbortController();
    const finish = () => { if (wasReleased) return; wasReleased = true; clearTimeout(active.deadline); if (this.#active === active) this.#active = null; release(); };
    try {
      const availability = await this.settings();
      if (!availability.voice.ready) throw new Error('The shared News voice is not ready.');
      let cached;
      if (context.lux && mode === 'slot' && !context.cacheKey) ({ key, cached } = await this.#luxVariant(context, dj, styleId, coHostId));
      else cached = await this.#cached(key);
      let line;
      if (!cached) {
        const tier = mode === 'preview' ? 2 : await this.#tierChoice();
        if (mode === 'preview') line = { turns: [{ djId: dj.id, text: PREVIEW_TEXT }], source: 'template', tier: 2 };
        if (tier === 4) {
          outcome = { tier: 4, source: 'silent', status: 'refused', reason: 'low-memory' };
          this.#tier = 4; state.offered = null;
          this.#skipSlot(state, context, 'low-memory');
          return;
        }
        if (mode !== 'preview') this.#tier = tier;
        if (!line && tier === 1) {
          const model = await this.#model.snapshot();
          if (this.#llm && this.#llmModelDir !== model.directory) { await this.#llm.close(); this.#llm = null; }
          this.#llm ??= new DjLlm({ ...this.#settings.runtime, modelPath: join(model.directory, WRITER_MODEL_FILE), recordPath: join(this.#dataDir, 'dj-llm-process.json'), log: (entry) => console.log('[dj-llm]', entry) });
          this.#llmModelDir = model.directory;
          line = await this.#lineText(context, style, tier, active.controller.signal, hosts, mode === 'slot' ? this.#story() : null);
          const after = await this.#freeMemory();
          if ((typeof after === 'number' ? after : after?.availableBytes ?? 0) < 10 * 1024 ** 3) await this.#llm.stop();
        } else if (!line) line = await this.#lineText(context, style, 2, undefined, hosts);
        if (active.controller.signal.aborted) throw active.controller.signal.reason ?? new Error('DJ line cancelled');
        const clips = [];
        for (const turn of line.turns) clips.push((await this.#speak(turn.text, this.#prompts.djs.find((entry) => entry.id === turn.djId), style)).wav);
        const wav = clips.length === 1 ? clips[0] : joinTurns(clips);
        // A break with news is kept apart: a replay of the song must not repeat old news.
        if (line.story) { this.#newsAt = Date.now(); this.#mentioned.add(line.story.id); key = createHash('sha256').update(JSON.stringify([key, line.story.id])).digest('hex'); }
        cached = { wav, durationSec: wavDurationSeconds(wav), text: line.turns.map((turn) => turn.text).join(' '), turns: line.turns, ...(line.story ? { newsId: line.story.id } : {}), source: line.source, style: styleId, djId: dj.id, songId: context.next.id, stationId: context.stationId, tier: line.tier, ...(context.lux ? { uses: 1 } : {}) };
        await this.#store(key, cached, wav);
      }
      active.controller.signal.throwIfAborted();
      outcome = { tier: cached.tier ?? this.#tier, source: cached.source, status: 'ready', durationSec: cached.durationSec };
      if (mode === 'slot') {
        this.#lastLine = { id: key, stationId: context.stationId, songId: context.next.id, djId: dj.id, style: styleId, text: cached.text, ...(cached.turns ? { turns: cached.turns } : {}), source: cached.source, audioId: key, durationSec: cached.durationSec, createdAt: cached.cachedAt ?? new Date().toISOString() };
        this.#openers.push(cached.text.split(/[.!?]/)[0]); this.#openers = this.#openers.slice(-6);
        state.fresh = false; state.songsSince = 0; state.target = this.#slotTarget(randomInt(1_000_000)); state.lastDjId = dj.id; state.offered = null;
        this.#tier = cached.tier ?? this.#tier;
        this.#setIntroduction({ stationId: context.stationId, songId: context.anchorTrackId ?? context.playbackTrackId, nextSongId: context.next.id, state: 'armed', ...(context.ahead && context.fromTrackId ? { fromTrackId: context.fromTrackId } : {}) });
      } else {
        this.#preview = { id: context.previewId, audioId: key, status: 'ready', error: null }; this.emit('change');
      }
    } catch (error) {
      outcome = { tier: this.#tier, source: null, status: 'error', error: error.message };
      if (mode === 'preview') this.#preview = { id: context.previewId, audioId: null, status: 'error', error: error.message };
      else if (!active.controller.signal.aborted) this.#skipSlot(state, context, 'error');
      if (mode !== 'preview') this.#tier = active.controller.signal.aborted ? null : 4;
      this.emit('change');
      if (mode === 'preview') throw error;
    } finally {
      finish();
      this.#last = { stationId: context.stationId, songId: context.next.id, djId: dj.id, mode, ...outcome, seconds: Number(((performance.now() - startedAt) / 1000).toFixed(2)) };
      this.#logLine(this.#last); this.emit('change');
    }
  }

  async cancel(reason = 'cancelled', { trackId } = {}) {
    // The song before an LVX slot's anchor ended into that anchor: the slot (or its armed line) carries on.
    const aimed = this.#active?.slot ? this.#active.context : this.#introduction;
    const anchor = this.#active?.slot ? aimed?.anchorTrackId : aimed?.songId;
    if (reason === 'song ended' && trackId && aimed?.fromTrackId && anchor === trackId && (this.#active?.slot || ['preparing', 'armed'].includes(this.#introduction?.state))) return;
    if (reason === 'DJs switched off' || reason === 'station DJ changed') {
      this.#lastLine = null; this.#nextSlot = null;
    }
    clearTimeout(this.#introductionTimer);
    const active = this.#active;
    if (active?.slot) { active.state.songsSince = 0; active.state.offered = null; }
    if (this.#active === active) this.#active = null;
    if (reason === 'DJ production runway deadline' && active?.slot) this.#skipSlot(active.state, active.context, 'not-enough-time');
    else if (reason !== 'song ended' || this.#introduction?.state !== 'armed') this.#setIntroduction(null);
    if (!active) return;
    if (!active.release) { active.cancel?.(); if (this.#active === active) this.#active = null; }
    else {
      if (this.#active === active) this.#active = null;
      active.controller?.abort(new Error(reason)); clearTimeout(active.deadline);
      await Promise.allSettled([this.#engine.abort?.(), this.#llm?.stop()]);
      active.release();
    }
    this.#tier = null; this.emit('change');
  }

  /** A persistent trail of DJ work, since the packaged app has no console: <data>/dj.log, kept small. */
  #logLine(record) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...record });
    console.log('[dj]', line);
    const path = join(this.#dataDir, 'dj.log');
    void (async () => {
      try {
        const old = await readFile(path, 'utf8').catch(() => '');
        const next = `${old}${line}\n`;
        await writeFile(path, next.length > LOG_MAX_BYTES ? next.slice(next.indexOf('\n', next.length - LOG_MAX_BYTES / 2) + 1) : next);
      } catch {}
    })();
  }

  /**
   * Auditions a DJ voice. Each DJ and style is voiced once and then played from the cache, with
   * no engine. Otherwise it waits only for a song already composing (never interrupted) and goes
   * ahead of planning the next one; an automatic introduction still waiting for the engine gives
   * way and is offered again later. Every failure ends in snapshot.preview.status 'error' with text.
   */
  async preview({ djId, style: styleId } = {}) {
    const dj = this.#prompts.djs.find((entry) => entry.id === djId);
    if (!dj || !this.#prompts.styles.some((entry) => entry.id === styleId)) throw new RangeError('Unknown DJ or style');
    const id = createHash('sha256').update(randomUUID()).digest('hex');
    // Shipped with the app: no engine, hold, voice model or LLM, whatever the radio is doing.
    const bundled = this.#bundledPreviews.get(djId);
    if (bundled?.styleId === styleId) {
      this.#preview = { id, audioId: bundled.sha256, status: 'ready', error: null }; this.emit('change');
      this.#logLine({ djId, style: styleId, mode: 'preview', status: 'ready', source: 'bundled' });
      return { id, status: 'ready' };
    }
    const key = createHash('sha256').update(JSON.stringify(['preview', djId, styleId, LINE_VERSION, VOICE_VERSION, PREVIEW_TEXT])).digest('hex');
    if (await this.#cached(key)) {
      this.#preview = { id, audioId: key, status: 'ready', error: null }; this.emit('change');
      this.#logLine({ djId, style: styleId, mode: 'preview', status: 'ready', source: 'cache' });
      return { id, status: 'ready' };
    }
    const refuse = (message) => {
      this.#preview = { id, audioId: null, status: 'error', error: message }; this.emit('change');
      this.#logLine({ djId, style: styleId, mode: 'preview', status: 'refused', error: message });
      throw Object.assign(new Error(message), { status: 409 });
    };
    const settings = await this.settings();
    if (!settings.voice.ready) refuse('The DJ voice (shared with News) is not installed yet. Install it in Settings, News, Voice.');
    if (this.#newsUrgent()) refuse('The news bulletin is being prepared. Try the voice again in a minute.');
    if (this.#active?.slot && !this.#active.release) this.#active.cancel?.();
    if (this.#active) refuse(this.#active.release ? 'A DJ line is being recorded right now. Try again in a few seconds.' : 'Another voice sample is already on its way.');
    const busy = this.#station.djContext?.()?.busy === true;
    this.#preview = { id, audioId: null, status: 'queued', error: null, ...(busy ? { waitingFor: 'song' } : {}) }; this.emit('change');
    const pending = { cancelWait: null, release: null, cancel: null, expiry: null };
    this.#active = pending;
    const releaseWait = this.#station.requestHold((release) => {
      clearTimeout(pending.expiry);
      if (this.#active !== pending) { release(); return; }
      this.#active = { cancelWait: null, release, cancel: null };
      this.#preview = { id, audioId: null, status: 'producing', error: null }; this.emit('change');
      const config = { mix: { Pop: 100 }, mood: 'bright', bpm: 104 };
      const context = { stationId: this.#station.snapshot().stationId, djId, styleId, config, current: null, next: { id: key, title: 'A Little Voice Check', generation: config }, previewId: id, cacheKey: key };
      void this.#produceLine(context, { offered: null }, release, 'preview').catch(() => {});
    }, { priority: 'dj', expiresAt: Date.now() + PREVIEW_WAIT_MS, plan: false });
    pending.cancelWait = releaseWait;
    pending.cancel = (message = 'Preview cancelled.') => { clearTimeout(pending.expiry); releaseWait(); if (this.#active === pending) this.#active = null; this.#preview = { id, audioId: null, status: 'error', error: message }; this.emit('change'); };
    if (this.#active === pending) {
      pending.expiry = setTimeout(() => pending.cancel('The song being composed is taking long. Try the voice again when it is ready.'), PREVIEW_WAIT_MS);
      pending.expiry.unref?.();
    }
    return { id, status: this.#preview.status };
  }

  /** A DJ clip by its opaque id: a bundled audition (MP3, by its sha256) or a cached line (WAV). */
  audioPath(id) {
    if (!ID.test(id)) return null;
    for (const clip of this.#bundledPreviews.values()) if (clip.sha256 === id) return clip.file;
    return join(this.#cacheDir, `${id}.wav`);
  }
  async rejectSong(songId) {
    for (const name of await readdir(this.#cacheDir).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.#cacheDir, name);
      try { const item = JSON.parse(await readFile(path, 'utf8')); if (item.songId === songId) await Promise.all([rm(path, { force: true }), rm(join(this.#cacheDir, `${item.id}.wav`), { force: true })]); } catch { await rm(path, { force: true }); }
    }
    if (this.#lastLine?.songId === songId) this.#lastLine = null;
  }
  async close() { this.#closed = true; clearInterval(this.#modelPoll); clearTimeout(this.#introductionTimer); await this.cancel('close'); await this.#llm?.close(); }
}
