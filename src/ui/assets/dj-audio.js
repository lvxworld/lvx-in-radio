/**
 * The DJ's voice over the music, in the renderer (Web Audio, no ffmpeg).
 *
 * Two layers. The first is pure functions with no DOM and no AudioContext, so they are
 * tested in plain Node: dB maths, the preset clean-up, the synthetic room impulse response,
 * the timing plan and the per-tick decision. The second, `DjTalkOver`, wires those into a
 * Web Audio graph and is only given its `ctx` and `destination`.
 *
 * Music path:  song source -> musicIn (the duck gain) -> destination
 * Voice path:  clip element -> highpass -> low shelf -> presence EQ -> high shelf -> compressor -> makeup
 *                           -> dry ---------------------------------> destination
 *                           -> convolver (synthetic room) -> wet ---> destination
 */

export const DJ_DEFAULTS = Object.freeze({
  duckDb: -7,            // how far the music sinks under the voice
  duckAttackSec: 0.35,   // time for the music to reach (about 95% of) the ducked level
  duckReleaseSec: 0.9,   // time for the music to come back after the voice
  duckLeadSec: 0.45,     // the music starts sinking this long before the voice
  endMarginSec: 2.0,     // the voice is over this long before the song ends
  tailSec: 0.5,          // room tail kept ducked after the voice stops
  minSongSec: 20,        // shorter songs get no talk-over
  minMusicBeforeSec: 8,  // the song plays this long alone before the music starts sinking
  maxVoiceShare: 0.6,    // the voice never covers more than this share of the song
  lateStartSec: 1.0,     // started this late on a due clip is still fine, later is skipped
  cancelFadeSec: 0.12,   // how fast a cancelled voice fades out
  highpassHz: 110,
  lowShelf: Object.freeze({ hz: 300, gainDb: 0 }),    // flat unless a preset asks
  highShelf: Object.freeze({ hz: 6000, gainDb: 0 }),
  presence: Object.freeze({ hz: 3200, gainDb: 3, q: 0.9 }),
  compressor: Object.freeze({ thresholdDb: -24, ratio: 3.5, attackSec: 0.006, releaseSec: 0.2, kneeDb: 12 }),
  makeupDb: 3,
  reverb: Object.freeze({ seconds: 0.7, decay: 3.2, wet: 0.18 }),
  voiceGainDb: 0,
});

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (value, fallback, min, max) => clamp(finite(Number(value), fallback), min, max);

export const dbToGain = (db) => 10 ** (finite(db, 0) / 20);
export const gainToDb = (gain) => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);

/** Time constant of `setTargetAtTime` so the gain has covered `fraction` of the way after `seconds`. */
export function timeConstant(seconds, fraction = 0.95) {
  return Math.max(0.001, seconds) / -Math.log(1 - clamp(fraction, 0.5, 0.999));
}

/**
 * The server sends the EQ and room of the DJ's style preset. Whatever arrives (missing parts,
 * strings, wild numbers) comes out as a complete, safe set of values. Accepts the nested shape
 * `{ highpassHz, presence:{hz,gainDb,q}, compressor:{...}, reverb:{...}, duckDb }` and the flat
 * names `presenceHz` / `presenceGainDb` / `reverbSeconds` / `reverbWet`.
 */
export function normalizePreset(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DJ_DEFAULTS;
  const presence = r.presence ?? r.eq?.presence ?? {};
  const comp = r.compressor ?? r.eq?.compressor ?? {};
  const room = r.reverb ?? r.room ?? {};
  return {
    duckDb: num(r.duckDb, d.duckDb, -18, -1),
    highpassHz: num(r.highpassHz ?? r.highpass ?? r.eq?.highpassHz, d.highpassHz, 20, 400),
    lowShelf: {
      hz: num(r.lowShelf?.hz ?? r.eq?.lowShelf?.hz ?? r.lowShelfHz, d.lowShelf.hz, 50, 1000),
      gainDb: num(r.lowShelf?.gainDb ?? r.eq?.lowShelf?.gainDb ?? r.lowShelfGainDb, d.lowShelf.gainDb, -12, 12),
    },
    highShelf: {
      hz: num(r.highShelf?.hz ?? r.eq?.highShelf?.hz ?? r.highShelfHz, d.highShelf.hz, 2000, 12000),
      gainDb: num(r.highShelf?.gainDb ?? r.eq?.highShelf?.gainDb ?? r.highShelfGainDb, d.highShelf.gainDb, -12, 12),
    },
    presence: {
      hz: num(presence.hz ?? r.presenceHz, d.presence.hz, 1000, 8000),
      gainDb: num(presence.gainDb ?? r.presenceGainDb, d.presence.gainDb, -6, 9),
      q: num(presence.q ?? r.presenceQ, d.presence.q, 0.3, 4),
    },
    compressor: {
      thresholdDb: num(comp.thresholdDb ?? comp.threshold, d.compressor.thresholdDb, -60, 0),
      ratio: num(comp.ratio, d.compressor.ratio, 1, 20),
      attackSec: num(comp.attackSec ?? comp.attack, d.compressor.attackSec, 0.001, 0.1),
      releaseSec: num(comp.releaseSec ?? comp.release, d.compressor.releaseSec, 0.02, 1),
      kneeDb: num(comp.kneeDb ?? comp.knee, d.compressor.kneeDb, 0, 40),
    },
    makeupDb: num(r.makeupDb ?? comp.makeupDb, d.makeupDb, 0, 12),
    reverb: {
      seconds: num(room.seconds ?? r.reverbSeconds, d.reverb.seconds, 0.45, 1.1),
      decay: num(room.decay, d.reverb.decay, 1, 8),
      wet: num(room.wet ?? room.mix ?? r.reverbWet, d.reverb.wet, 0, 0.6),
    },
    voiceGainDb: num(r.voiceGainDb, d.voiceGainDb, -12, 6),
  };
}

/** Small seeded generator, so the same preset always makes the same room. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A synthetic room: noise under an exponential decay, with a few ms of pre-delay and a tail that
 * gets darker as it fades (one-pole low-pass whose cutoff falls over time).
 * Returns one Float32Array per channel; the channels use different noise so the room is wide.
 */
export function makeImpulseResponse({ sampleRate = 48000, seconds = 0.7, decay = 3.2, channels = 2, seed = 7, preDelaySec = 0.008 } = {}) {
  const sr = clamp(Math.round(finite(sampleRate, 48000)), 8000, 192000);
  const secs = clamp(finite(seconds, 0.7), 0.1, 3);
  const length = Math.max(2, Math.round(sr * secs));
  const pre = Math.min(length - 1, Math.round(sr * preDelaySec));
  const out = [];
  for (let c = 0; c < clamp(channels, 1, 2); c++) {
    const rand = mulberry32(seed * 7919 + c * 104729 + 1);
    const data = new Float32Array(length);
    let low = 0;
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / (length - pre);
      const envelope = Math.exp(-decay * t * 2.3);
      const brightness = 0.9 - 0.75 * t;          // 0.9 early, 0.15 at the end: the tail darkens
      low += (rand() * 2 - 1 - low) * brightness;
      data[i] = low * envelope;
    }
    // A hard cut would click: the last 5% fades to exactly zero.
    const fade = Math.max(1, Math.floor(length * 0.05));
    for (let i = 0; i < fade; i++) data[length - 1 - i] *= i / fade;
    out.push(data);
  }
  // Normalise the energy so the wet level of a preset means the same for any length or decay.
  let energy = 0;
  for (const data of out) for (let i = 0; i < data.length; i++) energy += data[i] * data[i];
  const scale = energy > 0 ? 1 / Math.sqrt(energy / out.length) : 1;
  for (const data of out) for (let i = 0; i < data.length; i++) data[i] *= scale;
  return out;
}

/**
 * When to speak, in song time. The voice ends `endMarginSec` before the song does, and the music
 * starts sinking `duckLeadSec` ahead of it. Returns null when the clip does not fit.
 */
export function planTalkOver({ songDurationSec, clipDurationSec, options = {} } = {}) {
  const o = { ...DJ_DEFAULTS, ...options };
  const song = Number(songDurationSec), clip = Number(clipDurationSec);
  if (!Number.isFinite(song) || !Number.isFinite(clip) || clip <= 0 || song < o.minSongSec) return null;
  const startAt = song - o.endMarginSec - clip;
  if (startAt < Math.max(o.duckLeadSec + 1, o.minMusicBeforeSec)) return null;   // not enough music before the voice
  if (clip > song * o.maxVoiceShare) return null;
  return {
    songDurationSec: song,
    clipDurationSec: clip,
    duckAt: startAt - o.duckLeadSec,
    startAt,
    endAt: startAt + clip,
    releaseAt: startAt + clip + o.tailSec,
    hardStopAt: song - 0.6,                          // whatever happens, silence the voice by here
  };
}

/**
 * What to do right now. `phase` is what the controller is doing ('idle' | 'ducking' | 'speaking'
 * | 'done' | 'skipped'); the answer is one of: none, duck, start, release, stop, skip.
 *
 * - Not playing: nothing starts; a voice already speaking is paused by the caller, not stopped here.
 * - A position before the plan's duck time clears an old attempt (a replay of the same song).
 * - A clip that is due but later than `lateStartSec` after its start time is skipped, never run late.
 */
export function decideTalkOver({ plan, phase = 'idle', position, playing = true, options = {} }) {
  const o = { ...DJ_DEFAULTS, ...options };
  if (!plan || !Number.isFinite(position)) return { action: 'none' };
  if (phase === 'speaking') {
    if (position >= plan.hardStopAt) return { action: 'stop', reason: 'song-ending' };
    return { action: 'none' };
  }
  if (phase === 'done' || phase === 'skipped') return { action: 'none' };
  if (!playing) return { action: 'none' };
  if (position >= plan.startAt) {
    return position - plan.startAt > o.lateStartSec || position + plan.clipDurationSec > plan.hardStopAt
      ? { action: 'skip', reason: 'late' }
      : { action: 'start' };
  }
  if (position >= plan.duckAt && phase !== 'ducking') return { action: 'duck' };
  if (position < plan.duckAt && phase === 'ducking') return { action: 'release', reason: 'rewound' };
  return { action: 'none' };
}

/** Everything the on-air screen needs from the DJ block of a snapshot. Pure and forgiving. */
export function djCaption({ enabled, ready, missing = [], status, error, stationDj } = {}) {
  if (missing.length) return missing.map((name) => ({ 'dj-llm': 'The DJ script model is not installed yet', 'news-voice': 'The DJ voice is not installed yet' })[name] ?? `Missing: ${name}`).join(' · ');
  if (!enabled) return 'DJs are off';
  if (!ready) return 'Setting up the DJ…';
  if (status === 'error') return error || 'The DJ could not make a line';
  return stationDj ? `DJ ${stationDj}` : 'No DJ on this station';
}

/** The Web Audio talk-over. `ctx` and `destination` are given, so a test can pass fakes. */
export class DjTalkOver {
  constructor({ ctx, destination, createAudio = () => new Audio(), options = {} }) {
    this.ctx = ctx;
    this.destination = destination;
    this.createAudio = createAudio;
    this.options = { ...DJ_DEFAULTS, ...options };
    this.phase = 'idle';
    this.plan = null;
    this.clip = null;
    this.preset = normalizePreset(null);
    this.musicIn = ctx.createGain();
    this.musicIn.connect(destination);
    this.cancelReason = null;
    this.events = [];
    this.buildVoiceChain();
  }

  buildVoiceChain() {
    const { ctx } = this, p = this.preset;
    this.highpass = ctx.createBiquadFilter(); this.highpass.type = 'highpass';
    this.lowShelf = ctx.createBiquadFilter(); this.lowShelf.type = 'lowshelf';
    this.presence = ctx.createBiquadFilter(); this.presence.type = 'peaking';
    this.highShelf = ctx.createBiquadFilter(); this.highShelf.type = 'highshelf';
    this.compressor = ctx.createDynamicsCompressor();
    this.makeup = ctx.createGain();
    this.voiceOut = ctx.createGain();      // fades a cancelled voice out
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.voiceIn = ctx.createGain();
    this.voiceIn.connect(this.highpass);
    this.highpass.connect(this.lowShelf);
    this.lowShelf.connect(this.presence);
    this.presence.connect(this.highShelf);
    this.highShelf.connect(this.compressor);
    this.compressor.connect(this.makeup);
    this.makeup.connect(this.voiceOut);
    this.voiceOut.connect(this.dry); this.dry.connect(this.destination);
    this.voiceOut.connect(this.convolver); this.convolver.connect(this.wet); this.wet.connect(this.destination);
    this.applyPreset(p);
  }

  /** Apply a preset from the server. The room is rebuilt only when its length or decay change. */
  setPreset(raw) {
    this.applyPreset(normalizePreset(raw));
  }

  applyPreset(p) {
    const { ctx } = this, now = ctx.currentTime;
    const previous = this.preset;
    this.preset = p;
    this.highpass.frequency.setValueAtTime(p.highpassHz, now);
    this.lowShelf.frequency.setValueAtTime(p.lowShelf.hz, now);
    this.lowShelf.gain.setValueAtTime(p.lowShelf.gainDb, now);
    this.highShelf.frequency.setValueAtTime(p.highShelf.hz, now);
    this.highShelf.gain.setValueAtTime(p.highShelf.gainDb, now);
    this.presence.frequency.setValueAtTime(p.presence.hz, now);
    this.presence.gain.setValueAtTime(p.presence.gainDb, now);
    this.presence.Q.setValueAtTime(p.presence.q, now);
    const c = this.compressor;
    c.threshold.setValueAtTime(p.compressor.thresholdDb, now);
    c.ratio.setValueAtTime(p.compressor.ratio, now);
    c.attack.setValueAtTime(p.compressor.attackSec, now);
    c.release.setValueAtTime(p.compressor.releaseSec, now);
    c.knee.setValueAtTime(p.compressor.kneeDb, now);
    this.makeup.gain.setValueAtTime(dbToGain(p.makeupDb + p.voiceGainDb), now);
    this.voiceOut.gain.setValueAtTime(1, now);
    this.dry.gain.setValueAtTime(1 - p.reverb.wet * 0.5, now);
    this.wet.gain.setValueAtTime(p.reverb.wet, now);
    if (!this.convolver.buffer || previous.reverb.seconds !== p.reverb.seconds || previous.reverb.decay !== p.reverb.decay) {
      const channels = makeImpulseResponse({ sampleRate: ctx.sampleRate, seconds: p.reverb.seconds, decay: p.reverb.decay });
      const buffer = ctx.createBuffer(channels.length, channels[0].length, ctx.sampleRate);
      channels.forEach((data, index) => buffer.copyToChannel(data, index));
      this.convolver.buffer = buffer;
    }
  }

  /**
   * Prepare the clip for the song now on air. `clip` is `{ id, url, durationSec }` of the line that
   * introduces the NEXT song. Safe to call again for the next song; anything running is cancelled.
   */
  arm({ clip, songDurationSec, preset }) {
    this.cancel('rearm');
    this.clip = clip ?? null;
    this.plan = clip ? planTalkOver({ songDurationSec, clipDurationSec: clip.durationSec, options: this.options }) : null;
    this.phase = this.plan ? 'idle' : 'skipped';
    if (preset) this.setPreset(preset);
    return this.plan;
  }

  /** A stop switch ended a scheduled intro: stop the voice and forget the plan and clip, so nothing revives it. */
  disarm(reason = 'disarm') {
    this.cancel(reason);
    this.plan = null;
    this.clip = null;
    this.phase = 'idle';
  }

  /** Call a few times a second with the music's position. */
  tick({ position, playing = true }) {
    const step = decideTalkOver({ plan: this.plan, phase: this.phase, position, playing, options: this.options });
    switch (step.action) {
      case 'duck': this.duck(); break;
      case 'start': this.start(); break;
      case 'release': this.release(); this.phase = 'idle'; break;
      case 'stop': this.cancel(step.reason); break;
      case 'skip': this.phase = 'skipped'; this.release(); this.note('skip', step.reason); break;
      default: break;
    }
    return step.action;
  }

  duck() {
    this.phase = 'ducking';
    const now = this.ctx.currentTime, g = this.musicIn.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(dbToGain(this.preset.duckDb), now, timeConstant(this.options.duckAttackSec));
  }

  release(delaySec = 0) {
    const now = this.ctx.currentTime + delaySec, g = this.musicIn.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(1, now, timeConstant(this.options.duckReleaseSec));
  }

  start() {
    if (!this.clip) return;
    if (this.phase !== 'ducking') this.duck();
    const el = this.voice = this.createAudio();
    el.preload = 'auto';
    el.src = this.clip.url;
    try { this.source = this.ctx.createMediaElementSource(el); this.source.connect(this.voiceIn); } catch { this.source = null; }
    this.voiceOut.gain.cancelScheduledValues(this.ctx.currentTime);
    this.voiceOut.gain.setValueAtTime(1, this.ctx.currentTime);
    el.onended = () => this.finish();
    el.onerror = () => this.cancel('error');
    this.phase = 'speaking';
    Promise.resolve(el.play()).catch(() => this.cancel('blocked'));
  }

  finish() {
    if (this.phase !== 'speaking') return;
    this.phase = 'done';
    this.disposeVoice(this.options.tailSec * 1000);
    this.release(this.options.tailSec);
    this.note('done');
  }

  /**
   * Plays one clip right now through the same voice chain, for an audition. The music (if any)
   * ducks under it as on air. It has its own element, apart from the on-air plan: arming the next
   * intro, a tick or a news cancel never cuts a sample, and a sample never erases an armed intro.
   * A new sample replaces the previous one; a sample over an on-air voice stops that voice.
   */
  preview({ clip, preset }) {
    if (this.phase === 'speaking') this.cancel('preview');
    this.stopPreview(0);
    if (preset) this.setPreset(preset);
    const el = this.previewVoice = this.createAudio();
    el.preload = 'auto';
    el.src = clip.url;
    try { this.previewSource = this.ctx.createMediaElementSource(el); this.previewSource.connect(this.voiceIn); } catch { this.previewSource = null; }
    const now = this.ctx.currentTime;
    this.voiceOut.gain.cancelScheduledValues(now);
    this.voiceOut.gain.setValueAtTime(1, now);
    this.musicIn.gain.cancelScheduledValues(now);
    this.musicIn.gain.setTargetAtTime(dbToGain(this.preset.duckDb), now, timeConstant(this.options.duckAttackSec));
    const problem = (detail) => { if (this.previewVoice !== el) return; this.stopPreview(0); this.onProblem?.(detail); };
    el.onended = () => { if (this.previewVoice === el) this.stopPreview(this.options.tailSec * 1000); };
    el.onerror = () => problem('error');
    Promise.resolve(el.play()).catch(() => problem('blocked'));
  }

  /** Ends the sample; the music comes back unless an on-air intro is ducking it. */
  stopPreview(afterMs) {
    const el = this.previewVoice, source = this.previewSource;
    if (!el) return;
    this.previewVoice = null; this.previewSource = null;
    if (this.phase !== 'ducking' && this.phase !== 'speaking') this.release(afterMs / 1000);
    this.dispose(el, source, afterMs);
  }

  get previewing() { return Boolean(this.previewVoice); }

  /** The listener paused: the voice waits with the music. */
  pause() { if (this.phase === 'speaking') this.voice?.pause(); }

  /** The listener pressed play again: carry on if the song is still where it was. */
  resume({ position }) {
    if (this.phase !== 'speaking' || !this.plan) return;
    if (position >= this.plan.hardStopAt) { this.cancel('song-ending'); return; }
    Promise.resolve(this.voice?.play()).catch(() => this.cancel('blocked'));
  }

  /** Skip, station change, the song changing under us: stop the voice with a short fade and let the music back. */
  cancel(reason = 'cancel') {
    const wasActive = this.phase === 'speaking' || this.phase === 'ducking';
    // The voice output is shared with a sample: with one playing, the on-air voice stops at once instead of fading both.
    if (this.phase === 'speaking' && this.voice && this.previewVoice) this.disposeVoice(0);
    else if (this.phase === 'speaking' && this.voice) {
      const now = this.ctx.currentTime;
      this.voiceOut.gain.cancelScheduledValues(now);
      this.voiceOut.gain.setTargetAtTime(0, now, timeConstant(this.options.cancelFadeSec));
      this.disposeVoice(this.options.cancelFadeSec * 1000 + 60);
    }
    // A new song starts at full level even if the last release is still on its way.
    if ((wasActive || reason === 'song-change') && !this.previewVoice) this.release();
    if (this.phase !== 'idle') this.phase = reason === 'rearm' ? 'idle' : 'skipped';
    if (wasActive) this.note('cancel', reason);
  }

  disposeVoice(afterMs) {
    const el = this.voice, source = this.source;
    this.voice = null; this.source = null;
    this.dispose(el, source, afterMs);
  }

  dispose(el, source, afterMs) {
    const dispose = () => {
      try { el?.pause(); } catch { /* already gone */ }
      if (el) { el.onended = null; el.onerror = null; el.removeAttribute?.('src'); }
      try { source?.disconnect(); } catch { /* already disconnected */ }
    };
    if (afterMs > 0) setTimeout(dispose, afterMs); else dispose();
  }

  note(type, detail) {
    this.events.push({ type, detail, at: this.ctx.currentTime }); if (this.events.length > 20) this.events.shift(); }

  get speaking() { return this.phase === 'speaking'; }

  destroy() {
    this.cancel('destroy');
    this.stopPreview(0);
    this.disposeVoice(0);
    for (const node of [this.musicIn, this.voiceIn, this.highpass, this.lowShelf, this.presence, this.highShelf, this.compressor, this.makeup, this.voiceOut, this.dry, this.wet, this.convolver]) { try { node.disconnect(); } catch { /* ignore */ } }
  }
}
