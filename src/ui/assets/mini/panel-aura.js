import { StationAura } from '../station-aura.js';
import { drawStationDial } from '../station-dial.js';

// Playback stays in the main renderer; its real levels also drive the small face.
const canvas = document.getElementById('aura');
const dial = document.getElementById('dial');
const levels = new Float32Array(60);
let colors = ['#f2a33a'];
let time = 0;
let receivedAt = performance.now();
let aura = null;

try {
  aura = new StationAura(canvas, {
    levels: () => levels,
    origin: () => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight * 0.64 }),
  });
} catch {
  // Without WebGL the panel is simply dark behind its text.
}

window.LvxMini.onState(state => {
  if (state.colors?.length) {
    colors = state.colors;
    aura?.setColors(colors);
  }
});
window.LvxMini.onVisuals(visuals => {
  if (!Array.isArray(visuals?.levels) || visuals.levels.length !== levels.length) return;
  levels.set(visuals.levels);
  time = visuals.time;
  receivedAt = performance.now();
});

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
function move(now) {
  drawStationDial(dial, { levels, colors, time: reduced.matches ? 0 : time + (now - receivedAt) / 1000 });
  requestAnimationFrame(move);
}
requestAnimationFrame(move);
