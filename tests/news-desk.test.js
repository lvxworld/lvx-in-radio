import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeWav } from '../src/engine/wav.js';
import { RESERVED_FREQUENCIES } from '../src/radio/lux-catalog.js';
import { NEWS_STATION, NewsDesk } from '../src/radio/news/news-desk.js';

const HOUR = 3_600_000, MINUTE = 60_000;
const at = (hour, minute = 0, second = 0) => new Date(2026, 10, 6, hour, minute, second).getTime();
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 4)); };

function clock(start) {
  let now = start, next = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { timers.set(++next, { at: now + ms, fn }); return next; },
    clearTimer: (handle) => timers.delete(handle),
    async advanceTo(target) {
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

const story = (id) => ({ id, title: `Story ${id}`, summary: 'Body.', source: 'BBC News', link: `https://example.com/${id}`, publishedAt: '' });
const fakeMix = ({ voices }) => {
  let cursor = 2;
  const spans = voices.map((voice) => { const span = { id: voice.id, startSec: cursor, endSec: cursor + voice.durationSec }; cursor += voice.durationSec + 1; return span; });
  return { wav: writeWav({ sampleRate: 8000, samples: [new Float32Array(8000)] }), timeline: { sampleRate: 8000, totalSamples: 8000 * cursor, voice: spans, gaps: [] } };
};

async function fixture(t, { start = at(10, 30), ...overrides } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-news-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const time = clock(start);
  const calls = { fetch: 0, render: 0 };
  const state = { canProduce: true, active: true, stories: [story('a'), story('b')], ready: true, renderGate: null, released: 0, parts: [], waiters: [] };
  const desk = new NewsDesk({
    path: join(root, 'news.json'), dir: join(root, 'bulletins'),
    availability: async () => ({ ready: state.ready, missing: state.ready ? [] : ['news-voice'] }),
    fetchStories: async () => { calls.fetch += 1; return state.stories; },
    render: async (parts) => { calls.render += 1; state.parts = parts; if (state.renderGate) await state.renderGate; return parts.map((part) => ({ id: part.id, wav: Buffer.alloc(0), durationSec: 1 })); },
    mix: fakeMix, acquire: () => (state.canProduce ? () => { state.released += 1; } : null),
    canProduce: () => state.active,
    requestHold: (callback) => { const entry = (release) => { state.waiters = state.waiters.filter((w) => w !== entry); callback(release); }; state.waiters.push(entry); return () => { state.waiters = state.waiters.filter((w) => w !== entry); }; },
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    ...overrides,
  });
  await desk.load();
  t.after(() => desk.close());
  return { desk, time, calls, state, root };
}

test('NEWS_STATION has a frequency that is free and on the dial', () => {
  assert.equal(NEWS_STATION.id, 'lvx-news');
  assert.ok(!RESERVED_FREQUENCIES.includes(NEWS_STATION.k));
  assert.ok(Number.isInteger(NEWS_STATION.k) && NEWS_STATION.k >= 0 && NEWS_STATION.k < 26);
});

test('switched off, the desk makes no fetch and nothing is scheduled', async (t) => {
  const { desk, time, calls } = await fixture(t);
  desk.start();
  await time.advanceTo(at(12, 5));
  assert.equal(calls.fetch, 0);
  assert.equal(desk.snapshot().status, 'off');
});

test('production starts 10 minutes before the hour and the bulletin is announced on the hour', async (t) => {
  const { desk, time, calls } = await fixture(t);
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 49, 59));
  assert.equal(calls.fetch, 0);
  await time.advanceTo(at(10, 50, 1));
  assert.equal(calls.fetch, 1);
  assert.equal(desk.snapshot().due, null);
  assert.ok(desk.snapshot().latest);
  await time.advanceTo(at(11, 0, 1));
  assert.equal(desk.snapshot().due, desk.snapshot().latest.id);
});

test('the snapshot lists the stories with their position in the bulletin', async (t) => {
  const { desk, time } = await fixture(t);
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 51));
  const { latest } = desk.snapshot();
  assert.deepEqual(latest.stories.map((s) => s.id), ['a', 'b']);
  assert.ok(latest.stories[0].startSec >= 2 && latest.stories[0].endSec > latest.stories[0].startSec);
  assert.equal(latest.stories[0].link, 'https://example.com/a');
});

test('production waits while a song is being composed', async (t) => {
  const { desk, time, calls, state } = await fixture(t);
  state.canProduce = false;
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 55));
  assert.equal(calls.fetch, 0);
  state.canProduce = true;
  await time.advanceTo(at(10, 56));
  assert.equal(calls.fetch, 1);
});

test('a bulletin that could only start more than 5 minutes late waits for the next hour', async (t) => {
  const { desk, time, calls, state } = await fixture(t);
  state.canProduce = false;
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(11, 6));
  state.canProduce = true;
  await time.advanceTo(at(11, 7));
  assert.equal(calls.fetch, 0);
  await time.advanceTo(at(11, 51));
  assert.equal(calls.fetch, 1);
  await time.advanceTo(at(12, 0, 1));
  assert.ok(desk.snapshot().due);
});

test('switching on just after the hour still announces within the 5 minute window', async (t) => {
  const { desk, time, calls } = await fixture(t, { start: at(11, 2) });
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(11, 2, 30));
  assert.equal(calls.fetch, 1);
  assert.ok(desk.snapshot().due);
});

test('no stories keeps the previous bulletin and reports quietly without retrying', async (t) => {
  const { desk, time, calls, state } = await fixture(t);
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 51));
  const first = desk.snapshot().latest.id;
  state.stories = [];
  await time.advanceTo(at(11, 51));
  assert.equal(desk.snapshot().latest.id, first);
  assert.equal(desk.snapshot().status, 'error');
  assert.match(desk.snapshot().error, /No news/);
  await time.advanceTo(at(11, 58));
  assert.equal(calls.fetch, 2, 'one attempt per hour, no retry storm');
});

test('a failed voice discards partial files and keeps the previous bulletin', async (t) => {
  const { desk, time, state, root } = await fixture(t);
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 51));
  const before = (await readdir(join(root, 'bulletins'))).sort();
  state.stories = [story('c')];
  state.renderGate = Promise.reject(new Error('voice failed'));
  state.renderGate.catch(() => {});
  await time.advanceTo(at(11, 51));
  assert.equal(desk.snapshot().status, 'error');
  assert.deepEqual((await readdir(join(root, 'bulletins'))).sort(), before);
});

test('only the last 3 bulletins stay on disk', async (t) => {
  const { desk, time, root } = await fixture(t);
  await desk.configure({ enabled: true });
  desk.start();
  for (const hour of [10, 11, 12, 13]) await time.advanceTo(at(hour, 51));
  const files = await readdir(join(root, 'bulletins'));
  assert.equal(files.filter((name) => name.endsWith('.wav')).length, 3);
  assert.equal(files.filter((name) => name.endsWith('.json')).length, 3);
});

test('closing during production leaves no files behind', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { desk, time, state, root } = await fixture(t);
  state.renderGate = gate;
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 51));
  const closing = desk.close();
  release();
  await closing;
  const files = await readdir(join(root, 'bulletins')).catch(() => []);
  assert.deepEqual(files, []);
});

test('missing voice weights keep the switch off and name what is missing', async (t) => {
  const { desk, calls, state } = await fixture(t);
  state.ready = false;
  const snapshot = await desk.configure({ enabled: true });
  assert.equal(snapshot.enabled, false);
  assert.deepEqual(snapshot.missing, ['news-voice']);
  assert.equal(calls.fetch, 0);
});

test('settings survive a restart', async (t) => {
  const { desk, root, time } = await fixture(t);
  await desk.configure({ enabled: true });
  const again = new NewsDesk({
    path: join(root, 'news.json'), dir: join(root, 'bulletins'), availability: async () => ({ ready: true, missing: [] }),
    fetchStories: async () => [], render: async () => [], mix: fakeMix, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
  });
  await again.load();
  assert.deepEqual([again.snapshot().enabled, 'autoTune' in again.snapshot()], [true, false]);
  await again.close();
});

test('configure rejects unknown keys and non-booleans', async (t) => {
  const { desk } = await fixture(t);
  await assert.rejects(desk.configure({ enabled: 'yes' }), /boolean/);
  await assert.rejects(desk.configure({ volume: 11 }), /Unknown/);
});

test('produceNow makes a bulletin at once and acknowledge clears the notice', async (t) => {
  const { desk, calls } = await fixture(t);
  await desk.configure({ enabled: true });
  await desk.produceNow();
  assert.equal(calls.fetch, 1);
  const { due, latest } = desk.snapshot();
  assert.equal(due, latest.id);
  await desk.acknowledge(latest.id);
  assert.equal(desk.snapshot().due, null);
});

test('audioPath only resolves a known bulletin id', async (t) => {
  const { desk } = await fixture(t);
  await desk.configure({ enabled: true });
  await desk.produceNow();
  const { id } = desk.snapshot().latest;
  assert.ok(desk.audioPath(id).endsWith(`${id}.wav`));
  for (const bad of ['../news.json', 'news-zzz', '', `${id}/../x`]) assert.equal(desk.audioPath(bad), null);
});

test('startup removes orphan and temporary files', async (t) => {
  const { root, time } = await fixture(t);
  const dir = join(root, 'bulletins');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'news-x.wav'), 'x');
  await writeFile(join(dir, 'news-y.json.tmp'), 'x');
  await writeFile(join(dir, 'news-z.json'), '{}');
  const again = new NewsDesk({ path: join(root, 'news.json'), dir, availability: async () => ({ ready: true, missing: [] }), fetchStories: async () => [], render: async () => [], mix: fakeMix, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  await again.load();
  assert.deepEqual(await readdir(dir), []);
  await again.close();
});

test('the engine is released after every attempt, successful or not', async (t) => {
  const { desk, time, state } = await fixture(t);
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 51));
  assert.equal(state.released, 1);
  state.stories = [];
  await time.advanceTo(at(11, 51));
  assert.equal(state.released, 2);
});

test('a bulletin made on demand counts for its hour: the schedule does not make another at once', async (t) => {
  const { desk, time, calls } = await fixture(t, { start: at(10, 55) });
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 56));
  const afterSchedule = calls.fetch;
  assert.equal(afterSchedule, 1, 'the schedule made the 11:00 bulletin');
  await desk.produceNow();
  await time.advanceTo(at(10, 58));
  assert.equal(calls.fetch, 2, 'only the manual one was added');
  await time.advanceTo(at(11, 49));
  assert.equal(calls.fetch, 2, 'nothing else before the next hour');
  await time.advanceTo(at(11, 51));
  assert.equal(calls.fetch, 3, 'the next hour is still scheduled');
});

test('changing a setting while a bulletin is being made does not lose the schedule', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { desk, time, calls, state } = await fixture(t);
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 51));
  assert.equal(calls.fetch, 1);
  state.renderGate = gate;
  const making = desk.produceNow();
  await time.advanceTo(at(10, 52));
  await desk.configure({ enabled: true });
  release();
  await making;
  await time.advanceTo(at(11, 51));
  assert.equal(calls.fetch, 3, 'the 12:00 bulletin is still made');
});

test('nothing is made while the radio is paused, and production starts once it plays', async (t) => {
  const { desk, time, calls, state } = await fixture(t);
  state.active = false;
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 55));
  assert.equal(calls.fetch, 0);
  state.active = true;
  await time.advanceTo(at(10, 56));
  assert.equal(calls.fetch, 1);
});

test('a busy engine is waited for once, and the bulletin is made as soon as it is lent', async (t) => {
  const { desk, time, calls, state } = await fixture(t);
  state.canProduce = false;
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 55));
  assert.equal(calls.fetch, 0);
  assert.equal(state.waiters.length, 1, 'one request, not one per poll');
  state.waiters[0](() => { state.released += 1; });
  await time.advanceTo(at(10, 55, 5));
  assert.equal(calls.fetch, 1);
  assert.equal(state.released, 1);
  assert.equal(state.waiters.length, 0);
});

test('an engine lent after the late window is given straight back, and the stale request is withdrawn', async (t) => {
  const { desk, time, calls, state } = await fixture(t);
  state.canProduce = false;
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 55));
  const [lend] = state.waiters;
  await time.advanceTo(at(11, 6));
  assert.equal(state.waiters.length, 0, 'the request for the 11:00 bulletin is withdrawn once it is too late');
  lend(() => { state.released += 1; });
  await time.advanceTo(at(11, 6, 5));
  assert.equal(calls.fetch, 0);
  assert.equal(state.released, 1);
});

test('a restart inside the same hour does not make or announce the bulletin again', async (t) => {
  const { desk, time, calls, root, state } = await fixture(t);
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(10, 51));
  assert.equal(calls.fetch, 1);
  const again = new NewsDesk({
    path: join(root, 'news.json'), dir: join(root, 'bulletins'), availability: async () => ({ ready: true, missing: [] }),
    fetchStories: async () => { calls.fetch += 1; return state.stories; }, render: async () => [], mix: fakeMix,
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
  });
  await again.load();
  again.start();
  await time.advanceTo(at(10, 58));
  assert.equal(calls.fetch, 1);
  await again.close();
});

test('the greeting follows the hour the bulletin airs, not the hour it was made', async (t) => {
  const { desk, time, state } = await fixture(t, { start: at(11, 30) });
  await desk.configure({ enabled: true });
  desk.start();
  await time.advanceTo(at(11, 51));
  assert.match(state.parts[0].text, /^Good afternoon\./);
});

test('a bulletin file with a missing field is dropped at startup instead of breaking the app', async (t) => {
  const { root, time } = await fixture(t);
  const dir = join(root, 'bulletins');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'news-bad.wav'), 'x');
  await writeFile(join(dir, 'news-bad.json'), JSON.stringify({ id: 'news-bad', durationSec: 5 }));
  const again = new NewsDesk({ path: join(root, 'news.json'), dir, availability: async () => ({ ready: true, missing: [] }), fetchStories: async () => [], render: async () => [], mix: fakeMix, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  await again.load();
  assert.equal(again.snapshot().latest, null);
  assert.deepEqual(await readdir(dir), []);
  await again.close();
});

const defaults = [{ id: 'bbc', name: 'BBC News', url: 'https://feeds.example.com/bbc.xml' }, { id: 'npr', name: 'NPR News', url: 'https://feeds.example.com/npr.xml' }];
const probe = async (url) => { if (url.includes('bad')) throw new Error('No stories found.'); return { url, name: 'My Feed', count: 3 }; };

async function withFeeds(t) {
  const seen = [];
  const made = await fixture(t, { defaultFeeds: defaults, probeFeed: probe, fetchStories: async (feeds) => { seen.push(feeds.map((feed) => feed.id)); return [story('a')]; } });
  return { ...made, seen };
}

test('the default sources are listed, can be switched off one by one and the last stays on', async (t) => {
  const { desk } = await withFeeds(t);
  assert.deepEqual(desk.snapshot().feeds.map((feed) => [feed.id, feed.enabled, feed.custom]), [['bbc', true, false], ['npr', true, false]]);
  await desk.setFeedEnabled('bbc', false);
  assert.equal(desk.snapshot().feeds[0].enabled, false);
  await assert.rejects(desk.setFeedEnabled('npr', false), /at least one/);
  await assert.rejects(desk.setFeedEnabled('nope', true), /Unknown/);
});

test('a custom source is checked, saved, used for the next bulletin and removable', async (t) => {
  const { desk, root, time, seen } = await withFeeds(t);
  await desk.configure({ enabled: true });
  await assert.rejects(desk.addFeed({ url: 'https://bad.example.com/rss' }), /No stories/);
  const added = await desk.addFeed({ url: 'https://news.example.org/rss.xml', name: '  Local   Paper ' });
  const mine = added.feeds.find((feed) => feed.custom);
  assert.deepEqual([mine.name, mine.enabled], ['Local Paper', true]);
  await assert.rejects(desk.addFeed({ url: 'https://news.example.org/rss.xml' }), /already/);
  await desk.setFeedEnabled('bbc', false);
  await desk.produceNow();
  assert.deepEqual(seen.at(-1), ['npr', mine.id], 'only the enabled sources are read');
  const again = new NewsDesk({ path: join(root, 'news.json'), dir: join(root, 'bulletins'), availability: async () => ({ ready: true, missing: [] }), fetchStories: async () => [], render: async () => [], mix: fakeMix, defaultFeeds: defaults, probeFeed: probe, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
  await again.load();
  assert.deepEqual(again.snapshot().feeds.map((feed) => [feed.id, feed.enabled]), [['bbc', false], ['npr', true], [mine.id, true]]);
  await again.close();
  await assert.rejects(desk.removeFeed('npr'), /you added/);
  assert.equal((await desk.removeFeed(mine.id)).feeds.length, 2);
});

test('Make one now fetches again, and waits for a running song instead of failing', async (t) => {
  const { desk, calls, state } = await fixture(t);
  await desk.configure({ enabled: true });
  state.canProduce = false;
  await desk.produceNow();
  assert.equal(calls.fetch, 0);
  assert.equal(desk.snapshot().status, 'producing', 'queued behind the song');
  state.canProduce = true;
  state.waiters[0](() => { state.released += 1; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.fetch, 1);
  assert.ok(desk.snapshot().due, 'the new bulletin is announced');
  await desk.produceNow();
  assert.equal(calls.fetch, 2, 'every press reads the news again');
});

test('a custom source has a language that is kept, can change, and reaches the fetch', async (t) => {
  const { desk } = await withFeeds(t);
  const added = await desk.addFeed({ url: 'https://news.example.org/it.xml', language: 'it' });
  const mine = added.feeds.find((feed) => feed.custom);
  assert.deepEqual([added.feeds[0].language, mine.language], ['en', 'it']);
  await assert.rejects(desk.addFeed({ url: 'https://news.example.org/de.xml', language: 'de' }), /English or Italian/);
  assert.equal((await desk.setFeedLanguage(mine.id, 'en')).feeds.find((feed) => feed.custom).language, 'en');
  await assert.rejects(desk.setFeedLanguage('bbc', 'it'), /you added/);
});

test('an unanswered notice follows a newer bulletin, so Listen never points at an old one', async (t) => {
  const { desk, time } = await fixture(t);
  await desk.configure({ enabled: true });
  desk.start();
  await desk.produceNow();
  const first = desk.snapshot().due;
  assert.ok(first);
  await time.advanceTo(at(10, 40));
  await desk.produceNow();
  const second = desk.snapshot();
  assert.notEqual(second.latest.id, first);
  assert.equal(second.due, second.latest.id);
  await desk.acknowledge(second.latest.id);
  assert.equal(desk.snapshot().due, null);
  await desk.produceNow();
  assert.ok(desk.snapshot().due, 'a new bulletin raises a fresh notice');
});
