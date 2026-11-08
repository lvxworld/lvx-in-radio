import { StationAura } from '../station-aura.js';
import { drawStationDial } from '../station-dial.js';
import { generationAppearance } from '../generation-control.js';

// Playback stays in the main renderer; its real levels also drive the small face.
const canvas = document.getElementById('aura');
const dial = document.getElementById('dial');
const levels = new Float32Array(60);
let colors = ['#f2a33a'];
let time = 0;
let receivedAt = performance.now();
let aura = null;
let generation = null;
const byId = id => document.getElementById(id);

try {
  aura = new StationAura(canvas, {
    levels: () => levels,
    origin: () => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight * 0.64 }),
  });
} catch {
  // Without WebGL the panel is simply dark behind its text.
}

window.LvxMini.onState(state => {
  generation = state.generation;
  const control = byId('generation-control'), button = byId('generation');
  control.hidden = !generation?.visible;
  if (generation?.visible) {
    control.classList.toggle('is-composing', generation.composing);
    button.disabled = generation.disabled;
    button.setAttribute('aria-label', generation.action);
    button.setAttribute('aria-pressed', String(generation.enabled));
    const appearance = generationAppearance(generation.enabled, generation.color);
    button.style.background = appearance.genBg;
    button.style.boxShadow = appearance.genShadow;
    button.querySelector('i').style.borderColor = appearance.genIcon;
    button.querySelector('i').style.borderTopColor = 'transparent';
    button.querySelector('b').style.background = appearance.genIcon;
    byId('generation-label').style.color = appearance.genColor;
    byId('generation-label').textContent = generation.action;
    byId('generation-caption').textContent = generation.caption;
    byId('generation-tip').textContent = generation.tip;
    byId('generation-gpu').textContent = generation.gpu;
  }
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
