/**
 * The tuning game: the listener drags a needle between two signals, hears them
 * crossfade and locks the one they want. Each answer steers the next songs.
 */

const LOCK_AT = 0.86;
const KEY_STEP = 0.24;
const TAP_COUNT = 4;
const WAVE_POINTS = 160;
const VOICE_LEVEL = 0.11;
const NEXT_ROUND_MS = 620;

/** One pair: [id, label, colour, root note, wave, filter cutoff, pulse, roughness]. */
const GENRE_ROUNDS = {
  Pop: [
    [['pop-stadium', 'Sung by a stadium', '#ffd08a', 330, 'sawtooth', 3000, 2, 0.5], ['pop-bedroom', 'Made in a bedroom', '#ed9295', 262, 'triangle', 1100, 1, 0.1]],
    [['pop-neon', '80s neon', '#c994e8', 294, 'square', 2200, 4, 0.55], ['pop-sun', 'Summer radio', '#ffdf7a', 392, 'triangle', 3400, 2, 0.2]],
    [['pop-hook', 'The hook comes first', '#ff9a76', 440, 'sawtooth', 3200, 4, 0.6], ['pop-dream', 'A dream that drifts', '#b9c8f0', 220, 'sine', 1500, 0.5, 0]],
  ],
  Rock: [
    [['rock-garage', 'A garage at midnight', '#c76b60', 147, 'sawtooth', 1000, 4, 0.95], ['rock-arena', 'Arena lights', '#ffd08a', 196, 'sawtooth', 2600, 2, 0.6]],
    [['rock-blues', 'Worn blues', '#d6a67a', 165, 'triangle', 1200, 1, 0.4], ['rock-alt', 'Restless alternative', '#ee8755', 220, 'square', 1800, 3, 0.75]],
    [['rock-riff', 'Riff first', '#ff6a3d', 123, 'sawtooth', 1400, 4, 1], ['rock-soar', 'Guitars that soar', '#9fd8e0', 294, 'triangle', 2800, 1, 0.2]],
  ],
  Metal: [
    [['metal-doom', 'Slow and doomed', '#7f83ad', 62, 'sawtooth', 600, 0.75, 0.8], ['metal-thrash', 'Fast and furious', '#ff6a3d', 110, 'sawtooth', 1800, 8, 1]],
    [['metal-epic', 'Epic and symphonic', '#e6d8ba', 147, 'triangle', 2400, 2, 0.4], ['metal-groove', 'Pure groove', '#c76b60', 82, 'square', 900, 4, 0.9]],
    [['metal-black', 'Cold black forest', '#9fb8c8', 98, 'sawtooth', 2800, 6, 0.95], ['metal-fire', 'Molten steel', '#ee8755', 73, 'sawtooth', 1200, 2, 1]],
  ],
  'Progressive metal': [
    [['prog-odyssey', 'A long odyssey', '#b9a6e8', 147, 'triangle', 2400, 1, 0.3], ['prog-crush', 'Crushing odd meter', '#8f7ac2', 73, 'sawtooth', 900, 7, 1]],
    [['prog-virtuoso', 'Dazzling runs', '#ffd08a', 330, 'sawtooth', 3200, 8, 0.7], ['prog-atmosphere', 'Dark interludes', '#7f83ad', 98, 'sine', 1100, 0.75, 0.1]],
    [['prog-classic', 'Symphonic grandeur', '#e6d8ba', 196, 'triangle', 2800, 2, 0.35], ['prog-modern', 'Modern precision', '#9fb8c8', 82, 'square', 1600, 6, 0.9]],
  ],
  EDM: [
    [['edm-festival', 'Main stage at sunrise', '#ffd08a', 220, 'sawtooth', 3200, 4, 0.55], ['edm-warehouse', 'A warehouse at 4am', '#7f83ad', 110, 'square', 800, 4, 0.8]],
    [['edm-ethereal', 'Ethereal and weightless', '#c9c2e8', 330, 'sine', 2400, 0.5, 0], ['edm-heavy', 'Heavy and physical', '#ff6a3d', 73, 'sawtooth', 700, 2, 1]],
    [['edm-drop', 'All about the drop', '#e9c35f', 147, 'sawtooth', 2800, 6, 0.85], ['edm-journey', 'A long journey', '#85b6ad', 196, 'triangle', 1600, 1, 0.2]],
  ],
  Techno: [
    [['techno-hypnotic', 'Hypnotic loop', '#e9a140', 110, 'square', 1000, 4, 0.7], ['techno-melodic', 'Melodic and emotional', '#c994b9', 262, 'sawtooth', 2200, 2, 0.35]],
    [['techno-berlin', 'Concrete and steel', '#9fb8c8', 82, 'square', 700, 8, 1], ['techno-space', 'Deep space', '#8fa8e8', 147, 'sine', 1400, 0.5, 0.05]],
    [['techno-acid', 'Acid lines', '#d8e36a', 196, 'sawtooth', 3000, 6, 0.9], ['techno-analog', 'Warm analog', '#d6a67a', 131, 'triangle', 900, 2, 0.3]],
  ],
  'Hip-hop': [
    [['hiphop-boom', 'Old school boom bap', '#b7a06b', 98, 'triangle', 900, 2, 0.5], ['hiphop-trap', 'Dark modern trap', '#7f83ad', 55, 'sine', 700, 4, 0.7]],
    [['hiphop-soul', 'Soul sample crate', '#e0a070', 196, 'triangle', 1300, 1, 0.3], ['hiphop-synth', 'Spacey synth', '#9fd8e0', 262, 'sawtooth', 2400, 2, 0.45]],
    [['hiphop-street', 'Night streets', '#c76b60', 73, 'square', 800, 2, 0.8], ['hiphop-chill', 'Rooftop sunset', '#ffd08a', 165, 'sine', 1600, 0.75, 0.1]],
  ],
  'R&B': [
    [['rnb-velvet', 'Velvet slow jam', '#c58caf', 147, 'triangle', 1000, 0.75, 0.1], ['rnb-future', 'Glassy future R&B', '#9fd8e0', 294, 'sine', 2800, 2, 0.35]],
    [['rnb-90s', '90s nights', '#d99691', 196, 'triangle', 1400, 1.5, 0.25], ['rnb-neosoul', 'Live neo-soul band', '#d6bd87', 165, 'triangle', 1800, 1, 0.3]],
    [['rnb-candle', 'Candlelight', '#ffd08a', 131, 'sine', 900, 0.5, 0], ['rnb-city', 'City after midnight', '#8fa8e8', 110, 'square', 1200, 2, 0.45]],
  ],
  Jazz: [
    [['jazz-smoky', 'A smoky club', '#d6bd87', 147, 'triangle', 1000, 1.5, 0.3], ['jazz-modal', 'Open modal space', '#85b6ad', 196, 'sine', 1800, 0.5, 0.05]],
    [['jazz-bebop', 'Quick and bebop', '#ff9a76', 262, 'triangle', 2400, 6, 0.65], ['jazz-ballad', 'A late ballad', '#c9c2e8', 131, 'sine', 1200, 0.5, 0]],
    [['jazz-fusion', 'Electric fusion', '#c994e8', 220, 'sawtooth', 2200, 3, 0.55], ['jazz-acoustic', 'Acoustic trio', '#d6a67a', 165, 'triangle', 1400, 1, 0.2]],
  ],
  Classical: [
    [['classical-orchestra', 'Full orchestra', '#e6d8ba', 196, 'sawtooth', 2200, 1, 0.3], ['classical-chamber', 'Intimate quartet', '#c9b08a', 262, 'triangle', 1600, 0.75, 0.1]],
    [['classical-romantic', 'Sweeping and romantic', '#d99691', 165, 'triangle', 1900, 0.5, 0.1], ['classical-minimal', 'Minimal and modern', '#9fd8e0', 330, 'sine', 2600, 2, 0.15]],
    [['classical-piano', 'One piano in the dark', '#c9c2e8', 220, 'sine', 1300, 0.5, 0], ['classical-film', 'A film score', '#ffd08a', 147, 'sawtooth', 1800, 1, 0.25]],
  ],
  Reggae: [
    [['reggae-roots', 'Sunlit roots', '#98ac7f', 147, 'triangle', 1200, 2, 0.3], ['reggae-dub', 'Deep dub echoes', '#6f9a8c', 73, 'sine', 700, 2, 0.45]],
    [['reggae-beach', 'Beach at noon', '#ffdf7a', 220, 'square', 2000, 2, 0.4], ['reggae-night', 'Sound system night', '#c76b60', 98, 'square', 900, 2, 0.6]],
    [['reggae-lovers', 'Lovers rock', '#d99691', 196, 'triangle', 1500, 1, 0.15], ['reggae-modern', 'Modern and electronic', '#9fd8e0', 165, 'sawtooth', 2200, 4, 0.55]],
  ],
  'Lo-fi': [
    [['lofi-rain', 'Rain on the window', '#8fa8e8', 165, 'triangle', 700, 0.5, 0.2], ['lofi-cafe', 'A slow morning café', '#d6a67a', 220, 'triangle', 1100, 1, 0.3]],
    [['lofi-tape', 'Warped old tape', '#bf9881', 131, 'sawtooth', 600, 0.75, 0.6], ['lofi-clean', 'Soft and clean', '#c9c2e8', 262, 'sine', 1600, 0.75, 0.05]],
    [['lofi-study', 'Quiet study', '#85b6ad', 196, 'sine', 900, 0.75, 0.1], ['lofi-night', 'Last train home', '#7f83ad', 147, 'triangle', 800, 1, 0.3]],
  ],
  Ambient: [
    [['ambient-ocean', 'Slow ocean', '#85b6ad', 110, 'sine', 900, 0.15, 0], ['ambient-space', 'Distant stars', '#8fa8e8', 330, 'sine', 3000, 0.25, 0.05]],
    [['ambient-forest', 'A forest at dawn', '#98ac7f', 196, 'triangle', 1500, 0.25, 0.1], ['ambient-ice', 'Glass and ice', '#c9e4f0', 440, 'sine', 4200, 0.5, 0.15]],
    [['ambient-drone', 'A deep drone', '#7f83ad', 65, 'sawtooth', 500, 0.1, 0.1], ['ambient-light', 'Floating light', '#ffe0a3', 262, 'sine', 2600, 0.25, 0]],
  ],
};

const GENRE_SOUNDS = {
  Pop: { root: 330, wave: 'triangle', cutoff: 2800, pulse: 2, jag: 0.25 },
  Rock: { root: 165, wave: 'sawtooth', cutoff: 1500, pulse: 2, jag: 0.7 },
  Metal: { root: 82, wave: 'sawtooth', cutoff: 1100, pulse: 6, jag: 1 },
  'Progressive metal': { root: 98, wave: 'sawtooth', cutoff: 1500, pulse: 7, jag: 0.8 },
  EDM: { root: 220, wave: 'sawtooth', cutoff: 3200, pulse: 4, jag: 0.55 },
  Techno: { root: 110, wave: 'square', cutoff: 900, pulse: 4, jag: 0.8 },
  'Hip-hop': { root: 73, wave: 'sine', cutoff: 800, pulse: 1.5, jag: 0.3 },
  'R&B': { root: 196, wave: 'triangle', cutoff: 1300, pulse: 1, jag: 0.1 },
  Jazz: { root: 233, wave: 'triangle', cutoff: 1700, pulse: 1.5, jag: 0.2 },
  Classical: { root: 294, wave: 'sine', cutoff: 2200, pulse: 0.25, jag: 0 },
  Reggae: { root: 147, wave: 'square', cutoff: 1000, pulse: 2, jag: 0.4 },
  'Lo-fi': { root: 175, wave: 'triangle', cutoff: 650, pulse: 0.75, jag: 0.35 },
  Ambient: { root: 131, wave: 'sine', cutoff: 1400, pulse: 0.15, jag: 0 },
};

function sideFrom([id, label, color, root, wave, cutoff, pulse, jag]) {
  return { id, label, color, sound: { root, wave, cutoff, pulse, jag } };
}

function genreSide({ name, color }, extra) {
  return { ...extra, color, sound: GENRE_SOUNDS[name] };
}

function shuffled(list, random) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

/** Everything the listener can be asked about the genres they chose. */
function roundsFor(genres, random) {
  const rounds = genres.flatMap(({ name }) =>
    GENRE_ROUNDS[name].map((pair) => ({ kind: 'signal', sides: shuffled(pair.map(sideFrom), random) })),
  );
  const leading = genres[0];
  rounds.push({
    kind: 'signal',
    sides: [
      genreSide({ name: leading.name, color: '#7f83ad' }, { delta: 25, label: `Darker ${leading.name}` }),
      genreSide({ name: leading.name, color: '#ffe0a3' }, { delta: -25, label: `Brighter ${leading.name}` }),
    ],
  });
  rounds.push({ kind: 'tempo', genre: shuffled(genres, random)[0].name });
  for (let index = 0; index + 1 < genres.length; index += 1) {
    rounds.push({
      kind: 'signal',
      sides: [genres[index], genres[index + 1]].map((genre) =>
        genreSide(genre, { lead: genre.name, label: `More ${genre.name}` }),
      ),
    });
  }
  return rounds;
}

/** Endless sequence of rounds about the chosen genres, reshuffled when used up. */
export function createDeck({ genres, random = Math.random, signalsOnly = false }) {
  let pending = [];
  const rounds = () => roundsFor(genres, random).filter((round) => !signalsOnly || round.kind === 'signal');
  return {
    next() {
      if (!pending.length) pending = shuffled(rounds(), random);
      return pending.shift();
    },
  };
}

/** Turns a chosen side into what the station should change. */
export function answerFrom(side) {
  if (side.id) return { type: 'flavor', id: side.id, label: side.label };
  if (side.lead) return { type: 'lead', genre: side.lead, label: side.label };
  return { type: 'color', delta: side.delta, label: side.label };
}

export function tempoFromTaps(times) {
  const gaps = times.slice(1).map((time, index) => time - times[index]);
  const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  return Math.round(60_000 / average);
}

function mix(a, b, amount) {
  const parse = (hex) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
  const [first, second] = [parse(a), parse(b)];
  const channel = first.map((value, index) => Math.round(value + (second[index] - value) * amount));
  return `rgb(${channel.join(',')})`;
}

/** Three-note drone with a rhythmic pulse. One per side of the crossfader. */
function createVoice(context, destination, { root, wave, cutoff, pulse }) {
  const output = context.createGain();
  output.gain.value = 0;
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const pulseGain = context.createGain();
  pulseGain.gain.value = 0.6;
  const lfo = context.createOscillator();
  lfo.frequency.value = pulse;
  const lfoDepth = context.createGain();
  lfoDepth.gain.value = 0.4;
  lfo.connect(lfoDepth);
  lfoDepth.connect(pulseGain.gain);
  const oscillators = [1, 1.25, 1.5].map((ratio) => {
    const oscillator = context.createOscillator();
    oscillator.type = wave;
    oscillator.frequency.value = root * ratio;
    oscillator.connect(filter);
    return oscillator;
  });
  filter.connect(pulseGain);
  pulseGain.connect(output);
  output.connect(destination);
  [...oscillators, lfo].forEach((node) => node.start());
  return {
    output,
    stop() {
      const end = context.currentTime + 0.25;
      output.gain.cancelScheduledValues(context.currentTime);
      output.gain.setTargetAtTime(0, context.currentTime, 0.05);
      [...oscillators, lfo].forEach((node) => node.stop(end));
    },
  };
}

function element(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent?.append(node);
  return node;
}

export class SignalGame {
  #root;
  #deck;
  #audio;
  #onAnswer;
  #limit;
  #onDone;
  #answered = 0;
  #reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  #round = null;
  #position = 0;
  #target = 0;
  #dragging = false;
  #locked = false;
  #flash = 0;
  #taps = [];
  #voices = null;
  #silenceTimer = null;
  #nextTimer = null;
  #frame = 0;
  #answers = [];
  #nodes;

  /**
   * With a `limit` the game asks that many questions, then calls `onDone`. It
   * then plays over the radio, so it has no tapping round and states no audio.
   */
  constructor(root, { genres, audio, onAnswer, limit = 0, onDone = () => {} }) {
    this.#root = root;
    this.#audio = audio;
    this.#onAnswer = onAnswer;
    this.#limit = limit;
    this.#onDone = onDone;
    this.#deck = createDeck({ genres, signalsOnly: limit > 0 });
    this.#build();
    this.#startRound();
    this.#frame = requestAnimationFrame(this.#draw);
  }

  destroy() {
    cancelAnimationFrame(this.#frame);
    clearTimeout(this.#nextTimer);
    clearTimeout(this.#silenceTimer);
    this.#stopVoices();
    window.removeEventListener('resize', this.#fit);
    this.#root.replaceChildren();
  }

  #build() {
    const stage = element('div', 'signal-stage', this.#root);
    const left = element('button', 'signal-side signal-left', stage);
    const right = element('button', 'signal-side signal-right', stage);
    const field = element('div', 'signal-field', stage);
    const canvas = element('canvas', 'signal-wave', field);
    const needle = element('div', 'signal-needle', field);
    const hint = element('p', 'signal-hint', stage);
    const trail = element('p', 'signal-trail', stage);
    trail.setAttribute('aria-live', 'polite');
    field.tabIndex = 0;
    field.setAttribute('role', 'slider');
    field.setAttribute('aria-valuemin', '-100');
    field.setAttribute('aria-valuemax', '100');
    this.#nodes = { stage, left, right, field, canvas, needle, hint, trail };

    left.addEventListener('click', () => this.#lock(-1));
    right.addEventListener('click', () => this.#lock(1));
    field.addEventListener('pointerdown', this.#pointerDown);
    field.addEventListener('pointermove', this.#pointerMove);
    field.addEventListener('pointerup', this.#pointerUp);
    field.addEventListener('pointercancel', this.#pointerUp);
    field.addEventListener('keydown', this.#keyDown);
    window.addEventListener('resize', this.#fit);
    this.#fit();
  }

  #fit = () => {
    const { canvas } = this.#nodes;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.clientWidth * scale;
    canvas.height = canvas.clientHeight * scale;
  };

  #startRound() {
    this.#stopVoices();
    this.#round = this.#deck.next();
    this.#position = 0;
    this.#target = 0;
    this.#locked = false;
    this.#taps = [];
    const { left, right, hint, field, stage } = this.#nodes;
    stage.dataset.kind = this.#round.kind;
    if (this.#round.kind === 'tempo') {
      left.textContent = '';
      right.textContent = '';
      hint.textContent = `Tap the pace of your ${this.#round.genre} on the wave`;
      field.setAttribute('aria-label', 'Tap the pace you want. Press Enter to tap.');
    } else {
      const [first, second] = this.#round.sides;
      left.textContent = first.label;
      right.textContent = second.label;
      left.style.setProperty('--side', first.color);
      right.style.setProperty('--side', second.color);
      hint.textContent = this.#limit
        ? 'Drag the needle to the side that feels like yours.'
        : 'Drag the needle and listen. Your choice shapes the next songs.';
      field.setAttribute('aria-label', `${first.label} or ${second.label}. Use the arrow keys, then Enter.`);
    }
    stage.classList.remove('is-new');
    void stage.offsetWidth;
    stage.classList.add('is-new');
  }

  #xFor(event) {
    const box = this.#nodes.field.getBoundingClientRect();
    return Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width) * 2 - 1));
  }

  #pointerDown = (event) => {
    if (this.#locked) return;
    if (this.#round.kind === 'tempo') {
      this.#tap(event.timeStamp);
      return;
    }
    this.#dragging = true;
    this.#nodes.field.setPointerCapture(event.pointerId);
    this.#target = this.#xFor(event);
    this.#startVoices();
  };

  #pointerMove = (event) => {
    if (!this.#dragging || this.#locked) return;
    this.#target = this.#xFor(event);
    if (Math.abs(this.#target) >= LOCK_AT) this.#lock(Math.sign(this.#target));
  };

  #pointerUp = () => {
    if (!this.#dragging) return;
    this.#dragging = false;
    if (!this.#locked) this.#fadeVoices();
  };

  #keyDown = (event) => {
    if (this.#locked) return;
    if (this.#round.kind === 'tempo') {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        this.#tap(event.timeStamp);
      }
      return;
    }
    const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (direction) {
      event.preventDefault();
      event.stopPropagation();
      this.#target = Math.max(-1, Math.min(1, this.#target + direction * KEY_STEP));
      this.#startVoices();
      this.#fadeVoices(700);
      if (Math.abs(this.#target) >= LOCK_AT) this.#lock(Math.sign(this.#target));
    } else if (event.key === 'Enter' && this.#target !== 0) {
      event.preventDefault();
      event.stopPropagation();
      this.#lock(Math.sign(this.#target));
    }
  };

  #tap(time) {
    this.#flash = 1;
    this.#click();
    this.#taps.push(time);
    const remaining = TAP_COUNT - this.#taps.length;
    this.#nodes.hint.textContent = remaining > 0 ? `${remaining} more` : 'Got it';
    if (remaining > 0) return;
    this.#finish({ type: 'tempo', bpm: tempoFromTaps(this.#taps), label: `${tempoFromTaps(this.#taps)} BPM` }, this.#round);
  }

  #lock(side) {
    if (this.#locked || this.#round.kind !== 'signal') return;
    this.#target = side;
    this.#startVoices();
    const chosen = this.#round.sides[side < 0 ? 0 : 1];
    const button = side < 0 ? this.#nodes.left : this.#nodes.right;
    button.classList.add('is-chosen');
    setTimeout(() => button.classList.remove('is-chosen'), NEXT_ROUND_MS);
    this.#finish(answerFrom(chosen));
  }

  #finish(answer) {
    this.#locked = true;
    this.#dragging = false;
    this.#flash = 1;
    this.#answers = [...this.#answers, answer.label].slice(-4);
    this.#nodes.trail.textContent = this.#answers.join(', ');
    this.#onAnswer(answer, this.#nodes.needle);
    this.#fadeVoices(NEXT_ROUND_MS - 150);
    this.#answered += 1;
    const done = this.#limit > 0 && this.#answered >= this.#limit;
    this.#nextTimer = setTimeout(() => (done ? this.#onDone() : this.#startRound()), this.#reducedMotion ? 150 : NEXT_ROUND_MS);
  }

  #click() {
    const { context, destination, level } = this.#audio;
    const volume = level();
    if (!context || !volume) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.16 * volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start(now);
    oscillator.stop(now + 0.1);
  }

  #startVoices() {
    clearTimeout(this.#silenceTimer);
    const { context, destination, level } = this.#audio;
    if (this.#voices || !context || !level() || this.#round.kind !== 'signal') return;
    this.#voices = this.#round.sides.map(({ sound }) => createVoice(context, destination, sound));
  }

  #fadeVoices(afterMs = 450) {
    clearTimeout(this.#silenceTimer);
    this.#silenceTimer = setTimeout(() => this.#stopVoices(), afterMs);
  }

  #stopVoices() {
    this.#voices?.forEach((voice) => voice.stop());
    this.#voices = null;
  }

  /** Equal-power crossfade, so the middle is not quieter than the ends. */
  #applyCrossfade() {
    if (!this.#voices) return;
    const { context, level } = this.#audio;
    const angle = ((this.#position + 1) / 2) * (Math.PI / 2);
    const volume = level() * VOICE_LEVEL;
    this.#voices[0].output.gain.setTargetAtTime(Math.cos(angle) * volume, context.currentTime, 0.03);
    this.#voices[1].output.gain.setTargetAtTime(Math.sin(angle) * volume, context.currentTime, 0.03);
  }

  #draw = (now) => {
    this.#frame = requestAnimationFrame(this.#draw);
    const { canvas, needle, field } = this.#nodes;
    if (!canvas.width) this.#fit();
    this.#position += (this.#target - this.#position) * (this.#reducedMotion ? 1 : 0.18);
    this.#flash *= 0.92;
    this.#applyCrossfade();
    needle.style.left = `${((this.#position + 1) / 2) * 100}%`;
    field.setAttribute('aria-valuenow', String(Math.round(this.#position * 100)));
    this.#drawWave(canvas, this.#reducedMotion ? 0 : now / 1000);
  };

  #waveSides() {
    if (this.#round.kind === 'signal') return this.#round.sides;
    const pace = { color: '#f2a33a', sound: { root: 200, pulse: 2, jag: 0.2 } };
    return [pace, pace];
  }

  #drawWave(canvas, time) {
    const context = canvas.getContext('2d');
    const { width, height } = canvas;
    const [first, second] = this.#waveSides();
    const blend = (this.#position + 1) / 2;
    context.clearRect(0, 0, width, height);
    context.lineWidth = Math.max(1.5, height / 90) * (1 + this.#flash);
    context.lineJoin = 'round';
    context.strokeStyle = mix(first.color, second.color, blend);
    context.shadowColor = context.strokeStyle;
    context.shadowBlur = (12 + this.#flash * 30) * (width / canvas.clientWidth);
    context.beginPath();
    const shape = ({ sound }, x) => {
      const density = 2 + sound.root / 45;
      const smooth = Math.sin(x * density + time * (1 + sound.pulse));
      const jagged = Math.sign(Math.sin(x * density * 2.3 - time * sound.pulse)) * Math.abs(Math.sin(x * density * 7.1));
      const swell = 0.55 + 0.45 * Math.sin(x * 1.3 + time * (0.4 + sound.pulse * 0.2));
      return (smooth * (1 - sound.jag) + jagged * sound.jag) * swell;
    };
    for (let index = 0; index <= WAVE_POINTS; index += 1) {
      const progress = index / WAVE_POINTS;
      const x = progress * Math.PI * 2;
      const taper = Math.sin(progress * Math.PI);
      const value = shape(first, x) * (1 - blend) + shape(second, x) * blend;
      const y = height / 2 + value * taper * height * (0.32 + this.#flash * 0.12);
      if (index === 0) context.moveTo(0, y);
      else context.lineTo(progress * width, y);
    }
    context.stroke();
  }
}
