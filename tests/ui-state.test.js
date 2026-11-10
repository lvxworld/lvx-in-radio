import * as LvxGeneration from '../src/ui/assets/generation-control.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const source = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

function radioView() {
  const requests = [];
  const context = vm.createContext({
    setTimeout, clearTimeout,
    React: { createRef: () => ({ current: null }) },
    DCLogic: class { props = {}; },
    window: { LvxGeneration, LvxRadio: { generateNow: async id => { requests.push(id); } } },
  });
  vm.runInContext(source + ';globalThis.component = new Component()', context);
  const component = context.component;
  component.state.engineReady = true;
  const session = {
    generationEnabled: true, currentId: 'playing',
    tracks: [
      { id: 'playing', title: 'On air', status: 'ready', generation: { mix: { Jazz: 100 } } },
      { id: 'next-song', title: 'Next song', status: 'queued', generation: { mix: { Jazz: 100 } } },
    ],
  };
  component.stationSession = () => session;
  return { component, session, requests, api: context.window.LvxRadio, renderer: context.window };
}

test('the queue text action generates its own song and disappears once requested', async () => {
  const { component, session, requests } = radioView();
  const view = component.renderVals();
  assert.equal(view.showGeneration, true);
  assert.equal(view.songPeek[0].canRequest, false);
  assert.equal(view.songPeek[1].canRequest, true);
  await view.songPeek[1].onGenerate();
  assert.deepEqual(requests, ['next-song']);
  session.tracks[1].requested = true;
  assert.equal(component.renderVals().songPeek[1].canRequest, false);
  assert.equal(component.renderVals().songPeek[1].statusLabel, 'WAITING');
});

test('LVX stations hide generation controls and the queue action', () => {
  const { component, session } = radioView();
  for (const live of [false, true]) {
    Object.assign(session, { lux: true, live });
    const view = component.renderVals();
    assert.equal(view.showGeneration, false);
    assert.equal(view.songPeek[1].canRequest, false);
  }
});

test('manual FM retuning from LVX to a personal station restores generation controls', async () => {
  const { component, session, api, requests } = radioView();
  delete component.stationSession;
  component.booted = true;
  component.setState = (patch, done) => {
    Object.assign(component.state, typeof patch === 'function' ? patch(component.state) : patch);
    done?.();
  };
  for (const method of ['initAudio', 'startMusic', 'stopMusic', 'startStaticBursts', 'stopStaticBursts', 'loadTrack', 'reportPlayback', 'toastMsg', 'refreshCode', 'tickSnd']) component[method] = () => {};
  const config = { mix: { Jazz: 100 }, energy: 25, bpm: 80, dark: 30, melody: true, mood: '', seed: 7 };
  const stations = [
    { id: 'lux-relax', k: 2, name: 'LVX Relax', lux: true, songCount: 1, config },
    { id: 'my-radio', k: 6, name: 'My radio', songCount: 1, config },
  ];
  let serial = 0;
  const snapshotFor = station => ({
    stationId: 'session-' + ++serial, station, stations,
    tracks: station.lux ? [session.tracks[0]] : session.tracks,
    generation: { enabled: !station.lux },
  });
  api.tune = async (_config, { stationId }) => component.applySnapshot(snapshotFor(stations.find(station => station.id === stationId)));
  component.applySnapshot(snapshotFor(stations[0]));
  Object.assign(component.state, { hasPlayed: true, screen: 'air' });
  assert.equal(component.renderVals().showGeneration, false);

  component.bandKey({ key: 'ArrowRight', preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(component.stationSession().stationRecordId, 'my-radio');
  assert.equal(component.renderVals().showGeneration, true);
  assert.equal(component.renderVals().genDisabled, false);
  const queueAction = component.renderVals().songPeek.find(song => song.canRequest);
  assert.ok(queueAction, 'the manual queue action returns on the personal station');
  await queueAction.onGenerate();
  assert.deepEqual(requests, ['next-song']);
});

test('the queue action stays hidden without a model or while generation is stopped', () => {
  const { component, session } = radioView();
  component.state.engineReady = false;
  assert.equal(component.renderVals().songPeek[1].canRequest, false);
  component.state.engineReady = true;
  session.generationEnabled = false;
  assert.equal(component.renderVals().showGeneration, true, 'a user station keeps its Resume control');
  assert.equal(component.renderVals().songPeek[1].canRequest, false);
});

test('selecting a scenario keeps the sound cue without a particle burst', () => {
  const { component } = radioView();
  const sounds = [];
  component.setState = patch => Object.assign(component.state, patch);
  component.toastMsg = () => {};
  component.blip = on => sounds.push(on);
  component.burstAt = () => assert.fail('scenario selection must not emit confetti');
  component.applyScenario(1);
  assert.equal(component.state.scen, 1);
  assert.deepEqual(sounds, [true]);
});

test('switching a Sound DNA style on keeps the sound cue without a particle burst', () => {
  const { component } = radioView();
  const sounds = [];
  component.setState = patch => Object.assign(component.state, patch);
  component.blip = on => sounds.push(on);
  component.burstAt = () => assert.fail('Sound DNA must not emit confetti');
  const jazz = component.GENRES.findIndex(genre => genre.n === 'Jazz');
  component.toggleGenre(jazz);
  assert.ok(component.state.sel.Jazz > 0);
  assert.deepEqual(sounds, [true]);
});

test('dragging a style to 100% removes the other styles instead of leaving them at 0', () => {
  const { component } = radioView();
  component.setState = patch => Object.assign(component.state, patch);
  component.state.sel = { Pop: 35, Rock: 35, Country: 30 };
  component.state.dnaSlots = ['Pop', 'Rock', 'Country', null, null];
  component.setMixPercent('Country', 100);
  assert.deepEqual({ ...component.state.sel }, { Country: 100 });
  assert.deepEqual({ ...component.mixPercents() }, { Country: 100 });
});

test('opening the compact player and restoring the radio preserves playback and the station', () => {
  const { component, session } = radioView();
  component.setState = patch => Object.assign(component.state, patch);
  component.state.playing = true;
  component.openMiniPlayer();
  assert.equal(component.state.miniPlayer, true);
  assert.equal(component.state.macHidden, true);
  assert.equal(component.state.macMenuOpen, true);
  assert.equal(component.state.playing, true);
  assert.equal(component.stationSession(), session);
  assert.equal(component.renderVals().miniFrameClass, 'tray-frame compact-frame');
  component.macShow();
  assert.equal(component.state.miniPlayer, false);
  assert.equal(component.state.macHidden, false);
  assert.equal(component.state.macMenuOpen, false);
  assert.equal(component.state.playing, true);
});

test('the desktop mini-player command delegates to the native window without changing playback', () => {
  const { component, renderer } = radioView();
  let opened = 0;
  renderer.LvxDesktop = { openMiniPlayer: () => opened++ };
  component.state.playing = true;
  component.openMiniPlayer();
  assert.equal(opened, 1);
  assert.equal(component.state.playing, true);
  assert.equal(component.state.macHidden, false);
});

test('mini-player audio levels are forwarded only while visible and at most 30 times per second', () => {
  const { component, renderer } = radioView();
  const messages = [];
  renderer.LvxDesktop = { updateVisuals: visuals => messages.push(visuals) };
  component.dialTime = () => 3;
  component.levels.fill(.5);
  component.syncMiniVisuals(1000);
  assert.equal(messages.length, 0, 'a hidden panel receives no animation work');
  component.miniVisualsActive = true;
  component.syncMiniVisuals(1000);
  component.syncMiniVisuals(1010);
  component.syncMiniVisuals(1040);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].levels.length, 60);
  assert.ok(messages[0].levels.every(level => level === .5));
  assert.equal(messages[0].time, 3);
  component.miniVisualsActive = false;
  component.syncMiniVisuals(1100);
  assert.equal(messages.length, 2);
});

test('sharing On air uses its saved words and first seed even after editing Create', () => {
  const { component, session } = radioView();
  session.stationRecordId = 'my-station';
  const config = { mix: { Jazz: 100 }, energy: 25, bpm: 80, dark: 30, melody: true, mood: 'Piano, pioggia e città di notte', seed: 99 };
  Object.assign(component.state, { screen: 'air', describe: true, prompt: 'An unrelated Create draft', savedStations: [{ id: 'my-station', config, firstSeed: 7 }] });
  assert.deepEqual(JSON.parse(JSON.stringify(component.codeConfig())), { ...config, seed: 7 });
  assert.equal(component.shareVals().shareParams.find(row => row.label === 'WORDS').value, config.mood);
  component.state.screen = 'create';
  assert.equal(component.codeConfig().mood, 'An unrelated Create draft');
});

test('opening a shared station restores Describe it in words and its enabled state', () => {
  const { component } = radioView();
  component.setState = (patch, done) => { Object.assign(component.state, patch); done?.(); };
  component.toastMsg = () => {};
  component.applyCode({ mix: { Jazz: 100 }, energy: 25, bpm: 80, dark: 30, melody: true, scenario: 'Relax', mood: 'Rain ~ café 🌙', seed: 7 });
  assert.equal(component.state.prompt, 'Rain ~ café 🌙');
  assert.equal(component.state.describe, true);
  assert.equal(component.state.sharedSeed, 7);
  assert.equal(component.state.screen, 'create');
});

test('mini-player generation state follows the current station and toggles the existing API', async () => {
  const { component, session, api } = radioView();
  const changes = [];
  api.setGeneration = async enabled => { changes.push(enabled); };
  component.toastMsg = () => {};
  assert.equal(component.trayStateNow().generationAvailable, true);
  assert.equal(component.trayStateNow().generationEnabled, true);
  component.toggleGeneration();
  session.generationEnabled = false;
  assert.equal(component.trayStateNow().generationEnabled, false);
  component.toggleGeneration();
  assert.deepEqual(changes, [false, true]);
  session.lux = true;
  assert.equal(component.trayStateNow().generationAvailable, false);
  component.toggleGeneration();
  session.lux = false;
  component.state.engineReady = false;
  assert.equal(component.trayStateNow().generationAvailable, false);
  component.toggleGeneration();
  assert.deepEqual(changes, [false, true]);
});

test('the mini generation dial receives the same action, hints and progress as On air', () => {
  const { component, session } = radioView();
  component.state.gpu = 42;
  component.trackProgress = () => 37;
  session.tracks.push({ id:'composing', status:'generating', generation:{mix:{Jazz:100}} });
  const view = component.renderVals(), mini = component.trayStateNow().generation;
  assert.equal(mini.action,view.generationAction);
  assert.equal(mini.caption,view.generationCaption);
  assert.equal(mini.tip,view.genTip);
  assert.equal(mini.progress,37);
  assert.equal(mini.active,true);
  assert.equal(mini.gpu,view.gpuLabel);
  component.state.engineReady = false;
  assert.equal(component.trayStateNow().generation.visible,true,'a personal station keeps the same disabled control when its model is missing');
  assert.equal(component.trayStateNow().generation.disabled,true);
  assert.equal(component.trayStateNow().generation.tip,component.renderVals().genTip);
  session.lux = true;
  assert.equal(component.trayStateNow().generation.visible,false);
});
