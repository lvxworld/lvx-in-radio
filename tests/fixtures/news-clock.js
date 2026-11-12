import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWav } from '../../src/engine/wav.js';
import { NewsDesk } from '../../src/radio/news/news-desk.js';

// A NewsDesk on a fake clock with fake feeds, voice and mix, for tests that need News in a given state.

export const at = (hour, minute = 0, second = 0) => new Date(2026, 10, 6, hour, minute, second).getTime();

const flush = async (busy = () => false) => {
  let quiet = 0;
  for (let i = 0; i < 400 && quiet < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 4));
    quiet = busy() ? 0 : quiet + 1;
  }
};

export function clock(start, busy) {
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
        await flush(busy);
      }
      now = target;
      await flush(busy);
    },
  };
}

const story = (id) => ({ id, title: `Story ${id}`, summary: 'Body.', source: 'BBC News', link: `https://example.com/${id}`, publishedAt: '' });
const fakeMix = ({ voices }) => {
  let cursor = 2;
  const spans = voices.map((voice) => { const span = { id: voice.id, startSec: cursor, endSec: cursor + voice.durationSec }; cursor += voice.durationSec + 1; return span; });
  return { wav: writeWav({ sampleRate: 8000, samples: [new Float32Array(8000)] }), timeline: { sampleRate: 8000, totalSamples: 8000 * cursor, voice: spans, gaps: [] } };
};

/** state.canProduce: the engine can be lent; state.active: the radio is playing; state.renderGate: holds production. */
export async function newsDesk(t, { start = at(10, 30) } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-news-clock-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  let producing = () => false;
  const time = clock(start, () => producing());
  const state = { canProduce: true, active: true, renderGate: null, waiters: [] };
  const desk = new NewsDesk({
    path: join(root, 'news.json'), dir: join(root, 'bulletins'),
    availability: async () => ({ ready: true, missing: [] }),
    fetchStories: async () => [story('a'), story('b')],
    render: async (parts) => { if (state.renderGate) await state.renderGate; return parts.map((part) => ({ id: part.id, wav: Buffer.alloc(0), durationSec: 1 })); },
    mix: fakeMix, acquire: () => (state.canProduce ? () => {} : null),
    canProduce: () => state.active,
    requestHold: (callback) => { const entry = (release) => { state.waiters = state.waiters.filter((w) => w !== entry); callback(release); }; state.waiters.push(entry); return () => { state.waiters = state.waiters.filter((w) => w !== entry); }; },
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
  });
  producing = () => desk.snapshot().status === 'producing' && !state.renderGate;
  await desk.load();
  t.after(() => desk.close());
  return { desk, time, state };
}

/** News on, the 11:00 bulletin made at 10:50 and its "ready" card raised at 11:00 and left unanswered. */
export async function newsAfterBulletin(t, minute = 2) {
  const news = await newsDesk(t);
  await news.desk.configure({ enabled: true });
  news.desk.start();
  await news.time.advanceTo(at(11, 0, 1));
  await news.time.advanceTo(at(11, minute));
  return news;
}
