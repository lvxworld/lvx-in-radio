import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentStory, newsCaption, nextNewsAction } from '../src/ui/assets/news-flow.js';

const base = { due: 'news-a', handledId: null, active: false };

test('a due bulletin always asks, whatever the radio is doing', () => {
  assert.deepEqual(nextNewsAction(base), { type: 'popup', id: 'news-a' });
});

test('nothing happens without a notice, for a handled notice, or while the news is playing', () => {
  assert.deepEqual(nextNewsAction({ ...base, due: null }), { type: 'none' });
  assert.deepEqual(nextNewsAction({ ...base, handledId: 'news-a' }), { type: 'none' });
  assert.deepEqual(nextNewsAction({ ...base, active: true }), { type: 'none' });
});

test('currentStory follows the playback position', () => {
  const stories = [{ title: 'One', startSec: 5, endSec: 15 }, { title: 'Two', startSec: 17, endSec: 30 }];
  assert.equal(currentStory(stories, 1), null);
  assert.equal(currentStory(stories, 6).title, 'One');
  assert.equal(currentStory(stories, 16), null, 'a pause between stories');
  assert.equal(currentStory(stories, 20).title, 'Two');
  assert.equal(currentStory([], 3), null);
});

test('newsCaption explains every state in plain words', () => {
  const at = '2026-11-06T18:00:00.000Z';
  assert.match(newsCaption({ enabled: false, status: 'off', missing: [] }), /Hourly headlines/);
  assert.match(newsCaption({ enabled: false, status: 'off', missing: ['news-voice'] }), /voice/i);
  assert.match(newsCaption({ enabled: true, status: 'producing', missing: [] }), /Making/);
  assert.match(newsCaption({ enabled: true, status: 'ready', missing: [], nextAt: at }), /Next bulletin/);
  assert.match(newsCaption({ enabled: true, status: 'error', missing: [], error: 'No news available right now.' }), /No news available/);
});
