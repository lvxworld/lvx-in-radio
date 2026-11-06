const byId = id => document.getElementById(id);
const play = byId('play');

window.LvxMini.onState(state => {
  document.body.classList.toggle('is-compact', state.compact === true);
  byId('tray').hidden = state.compact !== true;
  document.body.classList.toggle('is-playing', state.playing);
  byId('status').textContent = state.playing ? 'ON AIR' : state.available ? 'STOPPED' : 'READY';
  byId('frequency').textContent = state.frequency === null ? '—' : state.frequency.toFixed(1);
  byId('station').textContent = state.name || 'LVX in Radio';
  byId('track').textContent = state.title || 'Your radio, a little closer.';
  byId('track').title = state.title;
  const label = state.playing ? 'Stop' : 'Play';
  play.disabled = !state.available;
  play.setAttribute('aria-label', label);
  play.title = state.playing ? 'Stop playback · keep your place' : 'Resume playback';
  byId('play-label').textContent = label;
  byId('play-hint').textContent = !state.available ? 'Choose a station in the app' : state.playing ? 'Music stays here with you' : 'Pick up where you left off';
  byId('play-glyph').setAttribute('d', state.playing ? 'M6 6h12v12H6z' : 'M9 5v14l11-7z');
});

play.addEventListener('click', () => window.LvxMini.togglePlay());
byId('open').addEventListener('click', () => window.LvxMini.open());
byId('tray').addEventListener('click', () => window.LvxMini.toTray());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.LvxMini.hide();
});
