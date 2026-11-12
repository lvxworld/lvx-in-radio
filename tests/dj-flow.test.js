import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingWords, djSwitchView, rangeWords, cadenceWords, nextRange, fromHuggingFace, modelView, voiceView, previewStyle, previewState, stationDjChoices, djSelectorAvailable, djChipView, djOffView, djStateLine, clipToArm, djMayStart, djAvatarUrl, djInitial, djVoiceTag, djLiveState } from '../src/ui/assets/dj-flow.js';

const readyDj = { enabled: true, ready: true, status: 'ready' };

test('DJ Settings helpers report readiness, ranges and Hugging Face model setup', () => {
  assert.equal(missingWords(['llm', 'voice']), 'Needs the script model and the News voice');
  assert.equal(djSwitchView({ enabled: true, ready: false, missing: ['llm'] }).canToggle, true, 'an enabled switch can always be turned off');
  assert.equal(djSwitchView({ enabled: false, ready: true }).canToggle, true);
  assert.equal(rangeWords(3, 3), '3');
  assert.equal(rangeWords(2, 4), '2–4');
  assert.deepEqual(nextRange({ min: 2, max: 4 }, 'min', 4), { minSongs: 4, maxSongs: 4 });
  assert.deepEqual(nextRange({ min: 3, max: 4 }, 'max', 2), { minSongs: 2, maxSongs: 2 });
  assert.deepEqual(nextRange({ min: 3, max: 4 }, 'max', 1), { minSongs: 1, maxSongs: 1 });
  assert.deepEqual(nextRange({ min: 2, max: 4 }, 'min', 1), { minSongs: 1, maxSongs: 4 });
  assert.equal(cadenceWords(1, 1), 'after every song');
  assert.equal(cadenceWords(1, 4), 'every 1–4 songs');
  assert.equal(fromHuggingFace({ directory: '/cache/models--org--model/snapshots/abc' }), true);
  assert.equal(fromHuggingFace({ source: 'cache' }), true);
  const view = modelView({ status: 'downloading', bytes: 50, total: 100 });
  assert.equal(view.percent, 50);
  assert.equal(view.canPause, true);
  assert.match(voiceView({ status: 'ready', ready: true }).detail, /Shared with News/);
});

test('catalog helpers choose fitted DJs, mark Lux and News unavailable, and show preview states', () => {
  const djs = [{ id: 'serena', name: 'Serena', bestFor: ['relax'], blurb: 'Warm' }, { id: 'ryan', name: 'Ryan', bestFor: ['edm'] }];
  assert.equal(previewStyle(djs[0], [{ id: 'relax' }, { id: 'generic' }]), 'relax');
  assert.equal(previewStyle({ bestFor: ['unknown'] }, [{ id: 'generic' }]), 'generic');
  assert.equal(previewState({ status: 'producing' }, 'serena', 'serena').busy, true);
  assert.equal(previewState({ status: 'error', error: 'failed' }, 'serena', 'serena').error, 'failed');
  assert.deepEqual(stationDjChoices(djs, 'relax').map((entry) => entry.id), [null, 'serena', 'ryan']);
  assert.equal(djSelectorAvailable({ station: { lux: true } }), true);
  assert.equal(djSelectorAvailable({ station: { news: true } }), false);
  assert.equal(djSelectorAvailable({ station: { id: 'listener' } }), true);
  assert.equal(djChipView({ dj: { enabled: true, ready: true }, station: { dj: 'serena' }, catalog: { djs } }).state, 'on');
  assert.equal(djOffView({ ready: true }).action, 'Turn on DJs');
});

test('a DJ clip arms only for the radio\u2019s armed slot on this station and song', () => {
  const line = { id: 'hash', audioId: 'opaque-hash', stationId: 'record', songId: 'next', durationSec: 8.4, style: 'relax', text: 'A line.' };
  const slot = { stationId: 'record', songId: 'cur', state: 'armed' };
  const dj = { lastLine: line, introduction: slot };
  const ask = (over = {}) => clipToArm({ dj, stationIds: ['record', 'session'], nextSongId: 'next', currentSongId: 'cur', ...over });
  assert.deepEqual(ask(), { id: 'hash', url: '/dj-audio/opaque-hash', durationSec: 8.4, style: 'relax', text: 'A line.' });
  assert.equal(ask({ stationIds: 'record' }).durationSec, 8.4);
  assert.equal(ask({ stationIds: ['session'] }), null);
  assert.equal(ask({ nextSongId: 'other' }), null);
  assert.equal(ask({ currentSongId: 'old' }), null, 'slot belongs to another song');
  assert.equal(ask({ currentSongId: undefined }), null);
  assert.equal(clipToArm({ dj: { lastLine: line }, stationIds: ['record'], nextSongId: 'next', currentSongId: 'cur' }), null, 'lastLine alone never arms');
  for (const state of ['idle', 'preparing', 'done', 'refused']) assert.equal(ask({ dj: { lastLine: line, introduction: { ...slot, state } } }), null, state);
  assert.equal(ask({ dj: { lastLine: line, introduction: { ...slot, stationId: 'other' } } }), null);
  assert.equal(ask({ dj: { lastLine: { ...line, audioId: null }, introduction: slot } }), null);
});

test('news playback always blocks starting a DJ clip and paused music cannot start one', () => {
  assert.equal(djMayStart({ newsPlaying: true, playing: true }), false);
  assert.equal(djMayStart({ newsPlaying: false, playing: false }), false);
  assert.equal(djMayStart({ newsPlaying: false, playing: true }), true);
});

test('DJ portraits, monogram, voice tag and live state', () => {
  assert.equal(djAvatarUrl('Sohee'), 'assets/dj/avatars/sohee.png');
  assert.equal(djAvatarUrl('../x'), '');
  assert.equal(djAvatarUrl(null), '');
  assert.equal(djInitial('serena'), 'S');
  assert.equal(djInitial(''), '·');
  assert.equal(djVoiceTag({ gender: 'woman', language: 'en' }), 'Woman · EN');
  assert.equal(djVoiceTag({ gender: 'man' }), 'Man · EN');
  assert.equal(djLiveState({ phase: 'ducking' }), 'speaking');
  assert.equal(djLiveState({ phase: 'idle', hasPlan: true }), 'armed');
  assert.equal(djLiveState({ phase: 'idle', hasPlan: false }), '');
  assert.equal(djLiveState({ phase: 'skipped', hasPlan: true }), '');
  assert.equal(djLiveState({ phase: 'done', hasPlan: true }), 'done');
});

test('once the clip has played the state line stops saying Ready', () => {
  const dj = { introduction: { stationId: 's', songId: 'a', state: 'armed' }, nextSlot: { remainingSongs: 1 } };
  assert.equal(djStateLine({ dj, stationId: 's', live: 'armed' }), 'Ready: the DJ speaks before this song ends');
  assert.equal(djStateLine({ dj, stationId: 's', live: '' }), 'Ready: the DJ speaks before this song ends');
  assert.equal(djStateLine({ dj, stationId: 's', live: 'done' }), 'Next DJ break in 1 song');
  assert.equal(djStateLine({ dj: { ...dj, introduction: { ...dj.introduction, state: 'preparing' } }, stationId: 's', live: 'done' }), 'Writing the next intro…');
});

test('a Lux intro aimed at the end of the next song says so', () => {
  const dj = { introduction: { stationId: 'lux-rock', songId: 'b', fromTrackId: 'a', state: 'armed' } };
  assert.equal(djStateLine({ dj, stationId: 'lux-rock', currentSongId: 'a' }), 'Next DJ break: after the next song');
  assert.equal(djStateLine({ dj, stationId: 'lux-rock', currentSongId: 'b' }), 'Ready: the DJ speaks before this song ends');
});

test('state line words what the DJ is doing, never a button', () => {
  assert.equal(djStateLine({ dj: { minSongs: 2, maxSongs: 4 } }), 'Speaks every 2\u20134 songs');
  assert.equal(djStateLine({ dj: { minSongs: 3, maxSongs: 3 } }), 'Speaks every 3 songs');
  assert.equal(djStateLine({ dj: {}, live: 'speaking' }), 'On air now');
  assert.match(djStateLine({ dj: {}, live: 'armed' }), /before this song ends/);
  assert.equal(djStateLine({ dj: {}, hasDj: false }), 'Just the music on this station.');
});

test('state line uses the automatic introduction and the songs left', () => {
  assert.equal(djStateLine({ dj: { introduction: { stationId: 's', state: 'preparing' } }, stationId: 's' }), 'Writing the next intro\u2026');
  assert.equal(djStateLine({ dj: { introduction: { stationId: 'other', state: 'preparing' }, minSongs: 2, maxSongs: 4 }, stationId: 's' }), 'Speaks every 2\u20134 songs');
  assert.equal(djStateLine({ dj: { nextSlot: { remainingSongs: 3 } } }), 'Next DJ break in 3 songs');
  assert.equal(djStateLine({ dj: { nextSlot: { remainingSongs: 1 } } }), 'Next DJ break in 1 song');
  assert.equal(djStateLine({ dj: { nextSlot: { remainingSongs: 0 } } }), 'Next DJ break: after this song');
});

test('fix1: cadence goes down to 1, also 1 to 1 = after every song', () => {
  assert.deepEqual(nextRange({ min: 2, max: 4 }, 'min', 4), { minSongs: 4, maxSongs: 4 });
  assert.deepEqual(nextRange({ min: 1, max: 1 }, 'max', 3), { minSongs: 1, maxSongs: 3 });
  assert.deepEqual(nextRange({ min: 2, max: 4 }, 'min', 0), { minSongs: 1, maxSongs: 4 }, 'clamped up to 1');
  assert.deepEqual(nextRange({ min: 2, max: 4 }, 'max', 9), { minSongs: 2, maxSongs: 4 }, 'clamped down to 4');
  assert.equal(cadenceWords(1, 1), 'after every song');
  assert.equal(cadenceWords(1, 4), 'every 1–4 songs');
  assert.equal(cadenceWords(3, 3), 'every 3 songs');
  assert.equal(cadenceWords(undefined, undefined), 'every 2–4 songs');
  assert.equal(djSwitchView({ enabled: true, ready: true, status: 'ready', minSongs: 1, maxSongs: 1 }).caption, 'A DJ speaks after every song, on stations that have one.');
  assert.equal(djStateLine({ dj: { minSongs: 1, maxSongs: 1 } }), 'Speaks after every song');
});

test('fix1: preview button states give feedback while busy and words on failure', () => {
  assert.deepEqual(previewState({ status: 'producing' }, 'sohee', 'vivian'), { label: 'Listen', busy: false, error: '' }, 'another tile pending: this one is idle');
  const starting = previewState(null, 'sohee', 'sohee');
  assert.equal(starting.label, 'Starting…'); assert.equal(starting.busy, true);
  const queued = previewState({ status: 'queued' }, 'sohee', 'sohee');
  assert.equal(queued.label, 'Waiting for the radio…'); assert.equal(queued.busy, true);
  const producing = previewState({ status: 'producing' }, 'sohee', 'sohee');
  assert.equal(producing.label, 'Making a sample…'); assert.equal(producing.busy, true);
  assert.deepEqual(previewState({ status: 'error', error: 'voice failed' }, 'sohee', 'sohee'), { label: 'Listen', busy: false, error: 'voice failed' });
  assert.equal(previewState({ status: 'error' }, 'sohee', 'sohee').error, 'The sample could not be made', 'never a silent failure');
});

test('fix1: a station DJ chip shows only that station’s own pick', () => {
  const djs = [{ id: 'serena', name: 'Serena' }, { id: 'ryan', name: 'Ryan' }];
  const dj = { enabled: true, ready: true, status: 'ready' };
  assert.equal(djChipView({ dj, station: { id: 'a', dj: 'ryan' }, catalog: { djs } }).caption, 'DJ Ryan');
  assert.equal(djChipView({ dj, station: { id: 'b', dj: null }, catalog: { djs } }).caption, 'No DJ on this station');
});
