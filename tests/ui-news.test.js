import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { currentStory, newsCaption, nextNewsAction } from '../src/ui/assets/news-flow.js';

const html = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const source = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

const bulletin = { id: 'news-a', readyAt: '2026-11-06T14:00:00.000Z', durationSec: 90, stories: [{ id: 's1', title: 'One', source: 'BBC News', link: 'https://example.com/1', startSec: 5, endSec: 20 }] };
const snapshot = (change = {}) => ({ enabled: true, status: 'ready', missing: [], station: { id: 'lvx-news', name: 'LVX News', k: 25 }, latest: bulletin, due: null, error: null, ...change });

function view() {
  const posts = [], calls = [];
  let fetchImpl = async () => ({ json: async () => ({}) });
  const audio = { src: '', currentTime: 0, play: async () => { calls.push('news-play'); }, pause: () => { calls.push('news-pause'); } };
  const context = vm.createContext({
    setTimeout, clearTimeout, fetch: (...args) => fetchImpl(...args),
    Audio: class { constructor() { this.listeners = {}; } addEventListener() {} pause() {} play() { return Promise.resolve(); } },
    React: { createRef: () => ({ current: null }) },
    DCLogic: class { props = {}; },
    window: { LvxRadio: { post: async (path, body) => { posts.push([path, body]); return {}; } }, LvxNewsFlow: { nextNewsAction, currentStory, newsCaption } },
  });
  vm.runInContext(source + ';globalThis.component = new Component()', context);
  const component = context.component;
  component.setState = (patch, done) => { Object.assign(component.state, typeof patch === 'function' ? patch(component.state) : patch); done?.(); };
  const originalToggle = component.togglePlay;
  const realMakeNewsAudio = component.makeNewsAudio.bind(component);
  const originalStart = component.startMusic.bind(component);
  component.makeNewsAudio = () => audio;
  component.togglePlay = () => { calls.push('toggle'); component.state.playing = !component.state.playing; };
  component.toastMsg = () => {};
  component.signalChime = () => calls.push('chime');
  return { component, context, posts, calls, audio, originalToggle, realMakeNewsAudio, originalStart, setFetch: (fn) => { fetchImpl = fn; } };
}

test('without news the screen still renders and offers no news controls', () => {
  const { component } = view();
  const vals = component.newsVals();
  assert.equal(vals.newsAvailable, false);
  assert.equal(vals.newsPlaying, false);
  assert.equal(vals.newsPopupOpen, false);
});

test('the switch shows ON, OFF and a missing voice', () => {
  const { component } = view();
  component.state.news = snapshot();
  assert.deepEqual([component.newsVals().newsOn, component.newsVals().newsStateWord, component.newsVals().newsClass], [true, 'ON', 'is-on']);
  component.state.news = snapshot({ enabled: false, status: 'off', missing: ['news-voice'] });
  const off = component.newsVals();
  assert.deepEqual([off.newsOn, off.newsStateWord, off.newsClass], [false, 'OFF', 'is-error']);
  assert.match(off.newsCaption, /voice is not installed/i);
});

test('a notice only opens the popup, even with music playing, and Later dismisses it', () => {
  const { component, calls, posts } = view();
  component.state.playing = true;
  component.syncNews(snapshot({ due: 'news-a' }));
  assert.equal(component.state.newsPopup, 'news-a');
  assert.ok(!calls.includes('news-play'));
  component.newsVals().newsPopupLater();
  assert.equal(component.state.newsPopup, null);
  assert.equal(JSON.stringify(posts.at(-1)), JSON.stringify(['/api/news/ack', { id: 'news-a' }]));
  component.syncNews(snapshot({ due: 'news-a' }));
  assert.equal(component.state.newsPopup, null, 'a dismissed notice does not come back');
});

test('with the radio paused a notice asks too', () => {
  const { component } = view();
  component.state.playing = false;
  component.syncNews(snapshot({ due: 'news-a' }));
  assert.equal(component.state.newsPopup, 'news-a');
  assert.equal(component.state.newsPlaying, undefined);
});

test('the headline follows the story being read', () => {
  const { component } = view();
  component.state.news = snapshot();
  component.state.newsPlaying = { id: 'news-a', stories: bulletin.stories, duration: 90, wasPlaying: false };
  component.state.newsT = 10;
  assert.deepEqual([component.newsVals().newsHeadline, component.newsVals().newsSource, component.newsVals().newsHasLink], ['One', 'BBC News', true]);
  component.state.newsT = 40;
  assert.equal(component.newsVals().newsHeadline, 'That was the news');
});

test('the end of the news brings the music back only if it was playing', () => {
  for (const [wasPlaying, expected] of [[true, ['toggle']], [false, []]]) {
    const { component, calls } = view();
    component.state.newsPlaying = { id: 'news-a', stories: [], duration: 90, wasPlaying };
    component.state.playing = false;
    component.endNews({ resume: true });
    assert.equal(component.state.newsPlaying, null);
    assert.deepEqual(calls.filter((call) => call === 'toggle'), expected);
  }
});

test('pressing play during the news skips it and returns to the music', () => {
  const { component, calls, originalToggle } = view();
  component.endNews = (options) => calls.push(['end', JSON.stringify(options)]);
  component.state.newsPlaying = { id: 'news-a', stories: [], duration: 90, wasPlaying: true };
  originalToggle();
  assert.equal(JSON.stringify(calls), JSON.stringify([['end', '{"resume":true}']]));
});

test('choosing another station during the news ends it without bringing the old music back', () => {
  const { component, calls } = view();
  component.endNews = (options) => calls.push(['end', JSON.stringify(options)]);
  component.state.newsPlaying = { id: 'news-a', stories: [], duration: 90, wasPlaying: true };
  try { component.resumeStation({ id: 'x', lux: true, songCount: 0 }); } catch { /* the rest of the switch is not under test */ }
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(['end', '{"resume":false}']));
});

test('Listen to the last bulletin plays it without a notice and the menu opens and closes', () => {
  const { component, calls, posts } = view();
  component.state.news = snapshot({ due: null });
  component.state.playing = true;
  assert.equal(component.newsVals().newsHasLatest, true);
  assert.match(component.newsVals().newsLatestTime, /\d/);
  component.newsMenuToggle();
  component.newsListenLast();
  assert.equal(component.state.newsMenu, false);
  assert.ok(calls.includes('news-play'));
  assert.equal(component.state.newsPlaying.id, 'news-a');
  assert.equal(JSON.stringify(posts.at(-1)), JSON.stringify(['/api/news/ack', { id: 'news-a' }]));
  component.state.news = snapshot({ latest: null });
  assert.equal(component.newsVals().newsHasLatest, false);
  component.state.newsMenu = false;
  assert.equal(component.newsVals().newsMenuOpen, false);
  component.newsMenuToggle();
  assert.equal(component.newsVals().newsMenuOpen, true);
  component.newsMenuClose();
  assert.equal(component.newsVals().newsMenuOpen, false);
});

const missingVoice = () => snapshot({ enabled: false, status: 'off', missing: ['news-voice'] });

test('an installed voice shows no download block', () => {
  const { component } = view();
  component.state.news = snapshot();
  assert.equal(component.newsVals().newsVoiceNeeded, false);
});

test('switching the news on without the voice opens the menu so the download is visible', async () => {
  const { component } = view();
  component.state.news = missingVoice();
  component.state.newsMenu = false;
  await component.afterNewsSetting({ enabled: false, missing: ['news-voice'] });
  assert.equal(component.state.newsMenu, true);
});

test('when the voice finishes downloading the news turns itself on', async () => {
  const { component, posts, setFetch } = view();
  component.state.news = missingVoice();
  setFetch(async () => ({ json: async () => ({ status: 'ready', bytes: 1, total: 1, ready: true, error: null }) }));
  await component.syncNewsVoice();
  assert.equal(JSON.stringify(posts.at(-1)), JSON.stringify(['/api/news/settings', { enabled: true }]));
});

test('the voice is looked at only while the news is waiting for it', async () => {
  const { component, setFetch } = view();
  let fetched = 0;
  setFetch(async () => { fetched += 1; return { json: async () => ({ ready: false }) }; });
  component.state.news = snapshot();
  await component.syncNewsVoice();
  assert.equal(fetched, 0, 'nothing is waiting for the voice');
  component.state.news = missingVoice();
  await component.syncNewsVoice();
  assert.equal(fetched, 1);
});

test('a missing voice points to the News voice page in Settings instead of downloading in the menu', () => {
  const { component } = view();
  component.state.news = missingVoice();
  component.state.newsMenu = true;
  const opened = [];
  component.liveSettings = { openPage: (page) => opened.push(page) };
  const vals = component.newsVals();
  assert.equal(vals.newsVoiceNeeded, true);
  assert.equal(vals.newsVoiceAction, undefined, 'no download controls in the popover any more');
  vals.newsVoiceSettings();
  assert.equal(JSON.stringify(opened), '["voice"]');
  assert.equal(component.state.newsMenu, false);
});
test('LVX News is on the dial only while it is on and has a bulletin', () => {
  const { component } = view();
  component.state.savedStations = [{ id: 'a', k: 11, name: 'A', songCount: 2 }];
  assert.equal(JSON.stringify(component.dialStations().map((s) => s.id)), '["a"]');
  component.state.news = snapshot({ latest: null });
  assert.equal(JSON.stringify(component.dialStations().map((s) => s.id)), '["a"]');
  component.state.news = snapshot({ enabled: false });
  assert.equal(JSON.stringify(component.dialStations().map((s) => s.id)), '["a"]');
  component.state.news = snapshot();
  const [first, second] = component.dialStations();
  assert.deepEqual([first.id, second.id, second.k, second.news, second.name], ['a', 'lvx-news', 25, true, 'LVX News']);
});

test('tuning to LVX News on the dial plays the bulletin and leaves the dial on the music station', () => {
  const { component, calls } = view();
  component.state.savedStations = [{ id: 'a', k: 11, name: 'A', songCount: 2 }];
  component.state.news = snapshot();
  component.state.stationK = 11;
  component.state.playing = true;
  const near = component.nearestStation(component.freqOf(25) - 0.1);
  assert.equal(near.id, 'lvx-news');
  component.moveToStation(near);
  assert.equal(component.state.dragging, false);
  assert.equal(component.state.freq, component.freqOf(11));
  assert.equal(JSON.stringify(calls), '["toggle","news-play"]');
  assert.equal(component.state.newsPlaying.id, 'news-a');
});

test('the arrow keys can step onto LVX News', () => {
  const { component, calls } = view();
  component.state.savedStations = [{ id: 'a', k: 11, name: 'A', songCount: 2 }];
  component.state.news = snapshot();
  component.state.stationK = 11;
  component.tickSnd = () => {};
  component.bandKey({ key: 'ArrowRight', preventDefault() {} });
  assert.ok(calls.includes('news-play'));
});

function fakeContext(component) {
  const node = (name) => ({ name, gain: { value: 0, setTargetAtTime(v) { this.value = v; }, cancelScheduledValues() {} }, links: [], connect(to) { this.links.push(to); return to; } });
  const nodes = [];
  component.ctx = { currentTime: 0, createGain: () => { const n = node('gain' + nodes.length); nodes.push(n); return n; }, createMediaElementSource: () => node('source'), resume() {} };
  component.master = node('master');
  component.analyser = node('analyser');
  component.state.volume = 80;
  component.props = { sound: true };
  return nodes;
}

test('the news is audible even when the music was paused: it has its own gain, not the music master', () => {
  const { component, realMakeNewsAudio } = view();
  fakeContext(component);
  component.master.gain.value = 0; // stopMusic leaves the music master silent
  component.makeNewsAudio = realMakeNewsAudio;
  const audioElement = component.makeNewsAudio();
  assert.ok(audioElement);
  assert.ok(component.newsGain, 'the news has a gain node');
  assert.notEqual(component.newsGain, component.master);
  assert.ok(component.newsGain.gain.value > 0, 'the news gain follows the volume');
  assert.equal(component.master.links.length, 0, 'nothing is routed through the silent music master');
  assert.ok(component.newsGain.links.includes(component.analyser));
});

test('the volume slider moves the news volume while the news plays', () => {
  const { component, realMakeNewsAudio } = view();
  fakeContext(component);
  component.makeNewsAudio = realMakeNewsAudio;
  component.makeNewsAudio();
  component.state.newsPlaying = { id: 'news-a', stories: [], duration: 90, wasPlaying: false };
  component.changeVolume({ target: { value: '30' } });
  assert.equal(component.newsGain.gain.value, 0.3);
});

test('tuning a new station while the news plays ends the news first', () => {
  const { component, calls, originalStart } = view();
  fakeContext(component);
  component.endNews = (options) => calls.push(['end', JSON.stringify(options)]);
  component.state.newsPlaying = { id: 'news-a', stories: [], duration: 90, wasPlaying: true };
  component.initAudio = () => {};
  try { originalStart(); } catch { /* the rest of the start is not under test */ }
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(['end', '{"resume":false}']));
});

test('reaching for the news again while it plays does not restart it or lose the way back to the music', () => {
  const { component, calls } = view();
  component.state.news = snapshot();
  component.state.playing = true;
  component.startNews('news-a');
  assert.equal(component.state.newsPlaying.wasPlaying, true);
  component.state.playing = false; // the music was paused for the news
  component.startNews('news-a');
  assert.equal(component.state.newsPlaying.wasPlaying, true, 'the first answer to "was music playing" is kept');
  assert.equal(calls.filter((call) => call === 'news-play').length, 1, 'no restart');
});

test('every news value the markup uses is supplied, with or without news (a missing one is a dead button)', () => {
  const used = new Set([...html.matchAll(/\{\{\s*(news\w+)\s*\}\}/g)].map((match) => match[1]));
  assert.ok(used.size > 20, 'the markup uses the news values');
  for (const news of [undefined, snapshot(), missingVoice()]) {
    const { component } = view();
    component.state.news = news;
    const vals = component.newsVals();
    for (const name of used) assert.ok(name in vals, `newsVals lacks ${name}`);
  }
  // Handlers must be functions, or the click does nothing.
  const { component } = view();
  component.state.news = snapshot();
  for (const name of ['newsMenuToggle', 'newsMenuClose', 'newsToggle', 'newsListenLast', 'newsMakeNow', 'newsPopupGo', 'newsPopupLater', 'newsStop', 'newsVoiceSettings']) {
    assert.equal(typeof component.newsVals()[name], 'function', `${name} must be a function`);
  }
});

test('Listen plays the newest bulletin even when the notice was raised for an older one', () => {
  const { component, calls, posts } = view();
  component.state.news = snapshot({ latest: { ...bulletin, id: 'news-b' }, due: 'news-b' });
  component.state.newsPopup = 'news-a'; // the card on screen still names the first bulletin
  component.newsVals().newsPopupGo();
  assert.equal(component.state.newsPlaying.id, 'news-b');
  assert.ok(calls.includes('news-play'));
  assert.equal(JSON.stringify(posts.at(-1)), JSON.stringify(['/api/news/ack', { id: 'news-b' }]));
});

test('arriving on a listener station flips the frequency to Share after 2 s for 3 s, once per arrival', () => {
  const { component, context } = view();
  const timers = [];
  context.setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; };
  context.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].live = false; };
  const fire = () => { const next = timers.find((timer) => timer.live); next.live = false; next.fn(); return next.ms; };
  component.state.screen = 'air';
  let session = { stationRecordId: 'mine-1', lux: false };
  component.stationSession = () => session;

  component.syncShareFlip();
  assert.equal(component.state.shareFlip ?? false, false, 'nothing happens at once');
  assert.equal(fire(), 2000);
  assert.equal(component.state.shareFlip, true);
  assert.equal(fire(), 3000);
  assert.equal(component.state.shareFlip, false, 'it flips back to the number');

  component.syncShareFlip();
  assert.ok(!timers.some((timer) => timer.live), 'the same station does not start a second round');

  session = { stationRecordId: 'mine-2', lux: false };
  component.syncShareFlip();
  assert.equal(fire(), 2000, 'a new arrival starts a new round');
  session = { stationRecordId: 'lux-edm', lux: true };
  component.syncShareFlip();
  assert.equal(component.state.shareFlip, false, 'leaving for a Lux station cancels the flip');
  assert.ok(!timers.some((timer) => timer.live), 'and nothing is left waiting');
});
