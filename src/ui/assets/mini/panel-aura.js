import { StationAura } from '../station-aura.js';

// The same sky as the on-air screen, small. The sound plays in the main window, so
// the panel moves its own gentle levels while the radio is on air and rests when it is not.
const canvas = document.getElementById('aura');
const levels = new Float32Array(60);
let playing = false;
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
  playing = state.playing === true;
  if (aura && state.colors?.length) aura.setColors(state.colors);
});

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
function move(now) {
  const t = reduced.matches ? 0 : now / 1000;
  for (let index = 0; index < levels.length; index += 1) {
    const target = playing
      ? 0.35 + 0.3 * Math.sin(t * 3 + index * 0.7) * Math.sin(t * 1.3 + index * 0.21)
      : 0.08 + 0.05 * Math.sin(t * 1.2 + index * 0.4);
    levels[index] += (target - levels[index]) * 0.22;
  }
  requestAnimationFrame(move);
}
requestAnimationFrame(move);
