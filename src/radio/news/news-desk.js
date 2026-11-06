import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LANGUAGES, composeScript } from './news-script.js';

/** The News station on the dial: a free frequency at the end of the scale. */
export const NEWS_STATION = { id: 'lvx-news', name: 'LVX News', k: 25 };

const RETRY_MS = 15_000;
const KEEP = 3;
const ID = /^news-[a-z0-9]{1,16}$/;
const SETTINGS_VERSION = 2;
const MAX_CUSTOM_FEEDS = 8;

const hourStart = (ms) => { const date = new Date(ms); date.setMinutes(0, 0, 0); return date.getTime(); };
const nextHour = (ms) => { const date = new Date(hourStart(ms)); date.setHours(date.getHours() + 1); return date.getTime(); };

async function writeAtomic(path, data) {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
}

/**
 * Owns the hourly news bulletin: settings, the schedule (production starts shortly
 * before each hour), the pipeline and the few bulletins kept on disk. Same shape as
 * LiveRadio: snapshot(), configure(), and a 'change' event.
 */
export class NewsDesk extends EventEmitter {
  #path; #dir; #availability; #fetchStories; #render; #mix; #acquire;
  #now; #setTimer; #clearTimer; #leadMs; #lateMs; #canProduce; #requestHold; #cancelWait = null;
  #defaults; #probe; #manualWait = null;
  #settings = { enabled: false };
  #disabled = new Set(); #custom = [];
  #bulletins = [];
  #due = null; #error = null; #missing = [];
  #producing = null; #timer = null; #dueTimer = null; #lastAttempt = 0; #closed = false; #started = false;

  constructor({ path, dir, availability, fetchStories, render, mix, acquire = () => () => {}, requestHold = null, canProduce = () => true, defaultFeeds = [], probeFeed = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, leadMs = 10 * 60_000, lateMs = 5 * 60_000 }) {
    super();
    this.#path = path; this.#dir = dir; this.#availability = availability; this.#fetchStories = fetchStories; this.#render = render; this.#mix = mix;
    this.#acquire = acquire; this.#requestHold = requestHold; this.#canProduce = canProduce; this.#now = now; this.#setTimer = setTimer; this.#clearTimer = clearTimer; this.#leadMs = leadMs; this.#lateMs = lateMs;
    this.#defaults = defaultFeeds; this.#probe = probeFeed;
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.#path, 'utf8'));
      if ((saved.version === 1 || saved.version === SETTINGS_VERSION) && typeof saved.enabled === 'boolean') {
        this.#settings = { enabled: saved.enabled };
        if (saved.version === SETTINGS_VERSION) {
          this.#disabled = new Set((Array.isArray(saved.disabled) ? saved.disabled : []).filter((id) => typeof id === 'string'));
          this.#custom = (Array.isArray(saved.custom) ? saved.custom : []).filter((feed) => feed && typeof feed.id === 'string' && typeof feed.name === 'string' && typeof feed.url === 'string').slice(0, MAX_CUSTOM_FEEDS).map(({ id, name, url, language }) => ({ id, name, url, language: language in LANGUAGES ? language : 'en' }));
        }
      }
    } catch { /* first run or unreadable settings: stay off */ }
    await mkdir(this.#dir, { recursive: true });
    const names = await readdir(this.#dir);
    const keep = new Set();
    for (const name of names) {
      const id = name.replace(/\.(wav|json)$/, '');
      if (!ID.test(id) || !name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.#dir, name), 'utf8'));
        const sound = meta && meta.id === id && typeof meta.readyAt === 'string' && Array.isArray(meta.stories) && Number.isFinite(meta.durationSec);
        if (sound && names.includes(`${id}.wav`)) { this.#bulletins.push(meta); keep.add(`${id}.json`).add(`${id}.wav`); }
      } catch { /* corrupt metadata: removed below */ }
    }
    await Promise.all(names.filter((name) => !keep.has(name)).map((name) => rm(join(this.#dir, name), { force: true })));
    this.#bulletins.sort((a, b) => a.readyAt.localeCompare(b.readyAt));
    this.#lastAttempt = Math.max(0, ...this.#bulletins.map((entry) => Number(entry.forHour) || 0));
  }

  start() {
    this.#started = true;
    this.#arm();
  }

  async close() {
    this.#closed = true;
    this.#clearTimers();
    this.#manualWait?.(); this.#manualWait = null;
    await this.#producing?.catch(() => {});
  }

  snapshot() {
    const latest = this.#bulletins.at(-1) ?? null;
    const status = !this.#settings.enabled ? 'off' : this.#producing || this.#manualWait ? 'producing' : this.#error ? 'error' : latest ? 'ready' : 'idle';
    return { ...this.#settings, feeds: this.feeds(), station: NEWS_STATION, status, missing: this.#missing, nextAt: this.#settings.enabled ? new Date(this.#target(this.#now())).toISOString() : null, latest, due: this.#due, error: this.#error };
  }

  feeds() {
    return [
      ...this.#defaults.map((feed) => ({ id: feed.id, name: feed.name, url: feed.url, language: 'en', custom: false, enabled: !this.#disabled.has(feed.id) })),
      ...this.#custom.map((feed) => ({ ...feed, custom: true, enabled: !this.#disabled.has(feed.id) })),
    ];
  }

  #activeFeeds() {
    const active = this.feeds().filter((feed) => feed.enabled);
    return active.length ? active : this.feeds();
  }

  async #save() {
    await mkdir(this.#dir, { recursive: true });
    await writeAtomic(this.#path, JSON.stringify({ version: SETTINGS_VERSION, ...this.#settings, disabled: [...this.#disabled], custom: this.#custom }));
  }

  async setFeedEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    if (!this.feeds().some((feed) => feed.id === id)) throw new Error('Unknown news source.');
    const next = new Set(this.#disabled);
    if (enabled) next.delete(id); else next.add(id);
    if (!this.feeds().some((feed) => !next.has(feed.id))) throw new Error('Keep at least one source on.');
    this.#disabled = next;
    await this.#save();
    this.emit('change');
    return this.snapshot();
  }

  /** Checks the address by reading it once, then keeps it. */
  async addFeed({ url, name, language = 'en' } = {}) {
    if (!(language in LANGUAGES)) throw new Error('Choose English or Italian.');
    if (!this.#probe) throw new Error('Adding sources is unavailable.');
    if (this.#custom.length >= MAX_CUSTOM_FEEDS) throw new Error(`You can add up to ${MAX_CUSTOM_FEEDS} sources.`);
    const found = await this.#probe(url);
    if (this.feeds().some((feed) => feed.url === found.url)) throw new Error('This source is already in the list.');
    const label = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || found.name;
    const id = `c-${createHash('sha1').update(found.url).digest('hex').slice(0, 8)}`;
    this.#custom.push({ id, name: label, url: found.url, language });
    await this.#save();
    this.emit('change');
    return this.snapshot();
  }

  async setFeedLanguage(id, language) {
    const feed = this.#custom.find((entry) => entry.id === id);
    if (!feed) throw new Error('Only sources you added have a language to choose.');
    if (!(language in LANGUAGES)) throw new Error('Choose English or Italian.');
    feed.language = language;
    await this.#save();
    this.emit('change');
    return this.snapshot();
  }

  async removeFeed(id) {
    const index = this.#custom.findIndex((feed) => feed.id === id);
    if (index < 0) throw new Error('Only sources you added can be removed.');
    this.#custom.splice(index, 1);
    this.#disabled.delete(id);
    if (!this.#activeFeeds().some((feed) => feed.enabled)) this.#disabled.clear();
    await this.#save();
    this.emit('change');
    return this.snapshot();
  }

  async configure(change) {
    const known = ['enabled'];
    for (const [key, value] of Object.entries(change ?? {})) {
      if (!known.includes(key)) throw new TypeError(`Unknown news setting: ${key}`);
      if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`);
    }
    const next = { ...this.#settings, ...change };
    this.#missing = [];
    if (next.enabled) {
      const { ready, missing } = await this.#availability();
      if (!ready) { next.enabled = false; this.#missing = missing; }
    }
    this.#settings = next;
    await this.#save();
    if (!next.enabled) { this.#clearTimers(); this.#manualWait?.(); this.#manualWait = null; this.#due = null; this.#error = null; }
    else if (this.#started) this.#arm();
    this.emit('change');
    return this.snapshot();
  }

  /** Fetches the news again and makes a new bulletin now; if a song is composing it waits for it to end. */
  async produceNow() {
    if (!this.#settings.enabled) throw new Error('Turn the news on first.');
    if (this.#producing || this.#manualWait) throw new Error('A bulletin is already being made.');
    const run = async (release) => {
      await this.#produce(release, { target: this.#target(this.#now()), scheduled: false });
      if (this.#started) this.#arm();
      if (!this.#error) this.#raiseDue();
    };
    const release = this.#acquire();
    if (release) {
      await run(release);
      if (this.#error) throw new Error(this.#error);
      return;
    }
    if (!this.#requestHold) throw new Error('The engine is busy with a song. Try again in a moment.');
    let granted = false;
    const cancel = this.#requestHold((lent) => {
      granted = true; this.#manualWait = null;
      if (this.#closed || !this.#settings.enabled) { lent(); this.emit('change'); return; }
      void run(lent);
    });
    if (!granted) { this.#manualWait = cancel; this.emit('change'); }
  }

  async acknowledge(id) {
    if (this.#due === id) { this.#due = null; this.emit('change'); }
  }

  audioPath(id) {
    return typeof id === 'string' && ID.test(id) && this.#bulletins.some((entry) => entry.id === id) ? join(this.#dir, `${id}.wav`) : null;
  }

  /** The hour this bulletin is for: the current hour while still within the late window, else the next. */
  #target(now) {
    const current = hourStart(now);
    if (now - current < this.#lateMs && this.#lastAttempt < current) return current;
    let target = nextHour(now);
    while (target <= this.#lastAttempt) target = nextHour(target);
    return target;
  }

  #clearTimers() {
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    if (this.#dueTimer !== null) this.#clearTimer(this.#dueTimer);
    this.#timer = this.#dueTimer = null;
    this.#withdrawRequest();
  }

  #withdrawRequest() {
    this.#cancelWait?.();
    this.#cancelWait = null;
  }

  /** `granted` is an engine already lent to us by a waiting request. */
  #arm(granted = null) {
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    if (this.#closed || !this.#settings.enabled || this.#producing) { granted?.(); return; }
    const now = this.#now();
    const target = this.#target(now);
    const startAt = target - this.#leadMs;
    if (now < startAt) {
      granted?.();
      this.#withdrawRequest();
      this.#timer = this.#setTimer(() => { this.#timer = null; this.#arm(); }, startAt - now);
      return;
    }
    // Nothing is made for a radio that is not playing; checked again every few seconds.
    if (!this.#canProduce()) { granted?.(); this.#retryLater(); return; }
    const release = granted ?? this.#acquire();
    if (!release) { this.#retryLater(); this.#waitForEngine(); return; }
    this.#withdrawRequest();
    this.#lastAttempt = target;
    this.#produce(release, { target, scheduled: true }).then(() => {
      if (this.#closed || !this.#settings.enabled) return;
      if (!this.#error) this.#announce(target);
      this.#arm();
    });
  }

  #retryLater() {
    this.#timer = this.#setTimer(() => { this.#timer = null; this.#arm(); }, RETRY_MS);
  }

  /** A song is composing: ask to be served the moment it ends, before the next one starts. */
  #waitForEngine() {
    if (this.#cancelWait || !this.#requestHold) return;
    this.#cancelWait = this.#requestHold((release) => { this.#cancelWait = null; this.#arm(release); });
  }

  #announce(target) {
    const now = this.#now();
    if (now > target + this.#lateMs) return;
    if (this.#dueTimer !== null) this.#clearTimer(this.#dueTimer);
    if (now >= target) { this.#raiseDue(); return; }
    const id = this.#bulletins.at(-1)?.id;
    this.#dueTimer = this.#setTimer(() => { this.#dueTimer = null; if (this.#bulletins.at(-1)?.id === id) this.#raiseDue(); }, target - now);
  }

  #raiseDue() {
    this.#due = this.#bulletins.at(-1)?.id ?? null;
    this.emit('change');
  }

  #produce(release, options) {
    this.#producing = this.#run(options).finally(() => { release(); this.#producing = null; this.emit('change'); });
    this.emit('change');
    return this.#producing;
  }

  async #run({ target, scheduled }) {
    this.#error = null;
    const written = [];
    try {
      const stories = await this.#fetchStories(this.#activeFeeds());
      if (!stories.length) throw new Error('No news available right now.');
      const parts = composeScript(stories, new Date(target ?? this.#now()));
      const voices = await this.#render(parts);
      if (this.#closed) return;
      const { wav, timeline } = this.#mix({ voices });
      const id = `news-${this.#now().toString(36)}`;
      const meta = {
        id, readyAt: new Date(this.#now()).toISOString(), forHour: scheduled ? target : 0, durationSec: timeline.totalSamples / timeline.sampleRate,
        stories: stories.map((story) => {
          const span = timeline.voice.find((entry) => entry.id === story.id);
          return { id: story.id, title: story.title, source: story.source, link: story.link, startSec: span.startSec, endSec: span.endSec };
        }),
      };
      await mkdir(this.#dir, { recursive: true });
      for (const [name, data] of [[`${id}.wav`, wav], [`${id}.json`, JSON.stringify(meta)]]) {
        await writeAtomic(join(this.#dir, name), data);
        written.push(join(this.#dir, name));
      }
      if (this.#closed) throw new Error('closed');
      this.#bulletins.push(meta);
      if (this.#due !== null) this.#due = id; // an unanswered notice always points at the newest bulletin
      await this.#prune();
    } catch (error) {
      await Promise.all(written.map((path) => rm(path, { force: true })));
      if (!this.#closed) this.#error = error.message;
    }
  }

  async #prune() {
    while (this.#bulletins.length > KEEP) {
      const old = this.#bulletins.shift();
      await Promise.all([`${old.id}.wav`, `${old.id}.json`].map((name) => rm(join(this.#dir, name), { force: true })));
    }
  }
}
