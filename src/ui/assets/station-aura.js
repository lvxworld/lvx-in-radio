/**
 * The sky behind the on-air screen. Veils of aurora in the station's colours
 * hang across the whole screen, each ray moving with its own frequency, with dust
 * floating in the light. The bass sends a soft shock through both, the mids stir the air, and the highs make the dust glint.
 * Dragging the FM dial blows the dust along with the hand.
 *
 * The aurora is soft, so it renders small and is scaled up: this has to stay
 * light while the GPU composes music.
 */

const DUST_COUNT = 950;
const REDUCED_DUST_COUNT = 420;
const FLOATS_PER_GRAIN = 7;
const AURORA_SCALE = 0.34;
const REDUCED_AURORA_SCALE = 0.2;
const MAX_PIXEL_RATIO = 1.5;
const SLOW_FRAME_MS = 28;
const SLOW_FRAMES_BEFORE_REDUCING = 90;
const COLOR_EASE = 0.035;
const ONSET_RATIO = 1.28;
const ONSET_FLOOR = 0.16;
const ONSET_GAP_MS = 240;
const SHOCK_SPEED = 0.62;
const SHOCK_LIFE_SEC = 2.4;
const SHOCK_WIDTH = 0.09;
const MAX_SHOCKS = 4;
const TUNE_SPEED = 0.55;
const TUNE_LIFE_SEC = 2.6;
const SPECTRUM_SIZE = 64;

const MOTE = 0;
const GLINT = 1;
const BOKEH = 2;

const FULL_SCREEN = `
attribute vec2 corner;
varying vec2 place;
void main() {
  place = corner * 0.5 + 0.5;
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

const AURORA = `
precision highp float;
varying vec2 place;
uniform float time, flow, aspect, bass, mid, high, shockRadius, shockPower, tuneRadius, tunePower;
uniform sampler2D spectrum;
uniform vec2 origin;
uniform vec3 colorA, colorB, colorC;

float hash(vec2 point) {
  return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 point) {
  vec2 cell = floor(point);
  vec2 part = fract(point);
  part = part * part * (3.0 - 2.0 * part);
  return mix(
    mix(hash(cell), hash(cell + vec2(1.0, 0.0)), part.x),
    mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), part.x),
    part.y
  );
}

float layered(vec2 point) {
  return noise(point) * 0.55 + noise(point * 2.1 + 3.7) * 0.3 + noise(point * 4.3 + 9.1) * 0.15;
}

/**
 * One hanging veil across the whole width: wandering folds of fine vertical rays.
 * Each ray listens to one frequency, mirrored like the dial: bass in the middle,
 * highs at the edges. A louder band makes its rays taller and brighter.
 */
float veil(vec2 point, float middle, float seed, float drift) {
  float x = point.x * 0.9 + seed;
  float fold = layered(vec2(x * 0.7 + time * drift, time * 0.018 + seed)) * 3.4;
  float ribbon = 0.34 + 0.66 * pow(0.5 + 0.5 * sin((x + fold) * 3.4 + seed), 4.0);
  float fine = layered(vec2((x + fold * 0.4) * 30.0, time * 0.06 + seed * 3.0));
  float travelling = 0.45 + 0.9 * layered(vec2(x * 5.0, point.y * 3.6 - flow));
  float rays = pow(fine, 3.0) * 4.0 * travelling;
  float fromMiddle = clamp(abs(point.x - middle) / max(middle, 0.001), 0.0, 1.0);
  float level = texture2D(spectrum, vec2(fromMiddle * 0.72 + (fine - 0.5) * 0.14, 0.5)).r;
  float hem = 0.5 + 0.1 * sin(x * 1.3 + fold + time * 0.05 + seed);
  float below = smoothstep(hem - 0.5 - level * 0.3, hem + 0.05, point.y);
  float above = 1.0 - smoothstep(hem + 0.05, hem + 0.42 + level * 0.4, point.y);
  /* Light falls off upward from a brighter hem, as it does in a real aurora. */
  return ribbon * pow(below, 2.0) * above * (0.1 + rays) * (0.22 + level * 1.15);
}

void main() {
  vec2 point = vec2(place.x * aspect, place.y);
  vec2 center = vec2(origin.x * aspect, origin.y);
  float reach = distance(point, center);

  /* The shock bends the light as it passes, instead of drawing a ring. */
  float crest = exp(-pow((reach - shockRadius) / ${SHOCK_WIDTH.toFixed(3)}, 2.0)) * shockPower;
  vec2 bent = point + normalize(point - center + 0.0001) * crest * 0.016;

  float a = veil(bent, center.x, 1.3, 0.016) * (0.5 + bass * 0.25);
  float b = veil(bent, center.x, 4.1, -0.012) * (0.4 + mid * 0.25);
  float c = veil(bent, center.x, 7.7, 0.022) * (0.3 + high * 0.3);
  vec3 light = colorA * a + colorB * b + colorC * c;

  float heart = exp(-reach * 3.1);
  light += colorA * heart * (0.03 + bass * 0.13);
  light += mix(colorA, vec3(1.0), 0.25) * crest * 0.04 * (0.6 + layered(point * 9.0));

  /* Keeps the colour deep: shadows stay black and the peaks never wash out. */
  light = (1.0 - exp(-light * light * 1.4 - light * 0.55)) * 0.62;

  /* Stays dark where the station name, quote, dial and songs have to be read. */
  float text = exp(-pow((place.x - 0.5) / 0.36, 2.0) - pow((place.y - 0.32) / 0.24, 2.0));
  float songs = exp(-pow((place.x - 0.88) / 0.13, 2.0) - pow((place.y - 0.72) / 0.22, 2.0));
  light *= (1.0 - text * 0.78) * (1.0 - songs * 0.6);
  light *= smoothstep(0.0, 0.22, place.y) * 0.55 + 0.45;
  /* Finding a station: a drop of coloured water. A crest leaves the dial with a smaller echo behind it,
     and the surface inside stays softly lit, so the wave never opens a hole at the centre. */
  float ripple = exp(-pow((reach - tuneRadius) / 0.085, 2.0));
  float echo = exp(-pow((reach - tuneRadius * 0.62) / 0.07, 2.0)) * smoothstep(0.12, 0.3, tuneRadius);
  float surface = smoothstep(tuneRadius, 0.0, reach);
  float bloom = exp(-reach * 2.6) * tunePower;
  light += mix(colorA, vec3(1.0), 0.28) * (ripple * 0.14 + echo * 0.09 + surface * 0.045 + bloom * 0.08) * tunePower;
  gl_FragColor = vec4(light, 1.0);
}`;

const BLIT = `
precision mediump float;
varying vec2 place;
uniform sampler2D image;

float hash(vec2 point) {
  return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 light = texture2D(image, place).rgb;
  /* A little grain keeps slow dark gradients from banding. */
  light += (hash(gl_FragCoord.xy) - 0.5) / 96.0;
  gl_FragColor = vec4(light, max(light.r, max(light.g, light.b)));
}`;

const DUST_VERTEX = `
attribute vec2 position;
attribute float size;
attribute vec4 tint;
uniform float scale;
varying vec4 color;
varying float kind;
void main() {
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = abs(size) * scale;
  kind = size < 0.0 ? ${BOKEH.toFixed(1)} : (tint.a > 1.0 ? ${GLINT.toFixed(1)} : ${MOTE.toFixed(1)});
  color = vec4(tint.rgb, tint.a > 1.0 ? tint.a - 1.0 : tint.a);
}`;

const DUST_FRAGMENT = `
precision mediump float;
varying vec4 color;
varying float kind;
void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float reach = length(point);
  float shape;
  if (kind > 1.5) {
    /* Far out of focus: only a faint warmth in the air. */
    shape = 1.0 - smoothstep(0.1, 1.0, reach);
  } else if (kind > 0.5) {
    /* A speck catching the light: a bright core and four thin rays. */
    float core = exp(-reach * reach * 26.0);
    float rays = exp(-abs(point.x) * 26.0) * pow(max(1.0 - abs(point.y), 0.0), 3.0)
      + exp(-abs(point.y) * 26.0) * pow(max(1.0 - abs(point.x), 0.0), 3.0);
    shape = core + rays * 0.6;
  } else {
    shape = exp(-reach * reach * 4.6) * (1.0 - smoothstep(0.8, 1.0, reach));
  }
  float alpha = shape * color.a;
  gl_FragColor = vec4(color.rgb * alpha, alpha);
}`;

function rgbOf(hex) {
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
}

function average(levels, from, to) {
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += levels[index];
  return sum / (to - from);
}

function compile(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const uniforms = new Proxy({}, { get: (cache, name) => (cache[name] ??= gl.getUniformLocation(program, name)) });
  return { program, uniforms };
}

function createGrain() {
  const roll = Math.random();
  const kind = roll < 0.03 ? BOKEH : roll < 0.09 ? GLINT : MOTE;
  return {
    x: Math.random(),
    y: Math.random(),
    kind,
    /* Near grains are large and move most, which gives the air its depth. */
    depth: kind === BOKEH ? 1 : 0.25 + Math.random() ** 2 * 0.75,
    size: kind === BOKEH ? 30 + Math.random() * 44 : kind === GLINT ? 7 + Math.random() * 9 : 1.4 + Math.random() ** 3 * 3.4,
    seed: Math.random() * 100,
    shade: Math.floor(Math.random() * 3),
    /* Most dust takes the station's colour, and some stays nearly white for sparkle. */
    whiten: kind === BOKEH ? 0.05 : Math.random() < 0.3 ? 0.8 : 0.08 + Math.random() * 0.17,
    pushX: 0,
    pushY: 0,
  };
}

export class StationAura {
  #canvas;
  #levels;
  #origin;
  #stir;
  #gl = null;
  #aurora;
  #blit;
  #dust;
  #quad;
  #dustBuffer;
  #target;
  #targetTexture;
  #targetSize = [0, 0];
  #spectrumTexture;
  #spectrum = new Float32Array(SPECTRUM_SIZE);
  #spectrumBytes = new Uint8Array(SPECTRUM_SIZE);
  #flow = 0;
  #auroraScale = AURORA_SCALE;
  #grains = [];
  #grainData = new Float32Array(DUST_COUNT * FLOATS_PER_GRAIN);
  #visibleGrains = DUST_COUNT;
  #colors = [[0.95, 0.64, 0.23], [0.95, 0.64, 0.23], [0.95, 0.64, 0.23]];
  #targetColors = null;
  #bands = { bass: 0, mid: 0, high: 0 };
  #bassFloor = 0;
  #shocks = [];
  #tune = null;
  #lastShock = 0;
  #wind = 0;
  #lastFrame = 0;
  #slowFrames = 0;
  #frame = 0;
  #reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  constructor(canvas, { levels, origin, stir = () => 0 }) {
    this.#canvas = canvas;
    this.#levels = levels;
    this.#origin = origin;
    this.#stir = stir;
    /* The screen stays usable without this: on failure it is simply dark. */
    try {
      this.#setUp();
    } catch (error) {
      console.warn('The on-air background is off:', error.message);
      this.#gl = null;
      return;
    }
    window.addEventListener('resize', this.#fit);
    this.#fit();
    this.#frame = requestAnimationFrame(this.#draw);
  }

  /** Colours are hex strings, most prominent first. They blend over from the last set. */
  setColors(colors) {
    this.#targetColors = [0, 1, 2].map((index) => rgbOf(colors[index % colors.length]));
  }

  /** A station was found: send one ring of light out from the dial. */
  pulse() {
    if (this.#reducedMotion || !this.#gl) return;
    this.#tune = { age: 0 };
  }

  destroy() {
    cancelAnimationFrame(this.#frame);
    window.removeEventListener('resize', this.#fit);
    this.#gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }

  #setUp() {
    const gl = this.#canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('WebGL is not available');
    this.#gl = gl;
    this.#aurora = compile(gl, FULL_SCREEN, AURORA);
    this.#blit = compile(gl, FULL_SCREEN, BLIT);
    this.#dust = compile(gl, DUST_VERTEX, DUST_FRAGMENT);
    this.#quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.#dustBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#dustBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.#grainData.byteLength, gl.DYNAMIC_DRAW);
    this.#target = gl.createFramebuffer();
    this.#targetTexture = gl.createTexture();
    this.#spectrumTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#spectrumTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.#grains = Array.from({ length: DUST_COUNT }, createGrain);
    this.#canvas.addEventListener('webglcontextlost', () => cancelAnimationFrame(this.#frame));
  }

  #fit = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.#canvas.width = Math.round(this.#canvas.clientWidth * ratio);
    this.#canvas.height = Math.round(this.#canvas.clientHeight * ratio);
    this.#sizeTarget();
  };

  #sizeTarget() {
    const gl = this.#gl;
    const width = Math.max(2, Math.round(this.#canvas.width * this.#auroraScale));
    const height = Math.max(2, Math.round(this.#canvas.height * this.#auroraScale));
    this.#targetSize = [width, height];
    gl.bindTexture(gl.TEXTURE_2D, this.#targetTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#target);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.#targetTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** The screen gives up detail rather than smoothness when the Mac is busy. */
  #watchSpeed(elapsedMs) {
    if (this.#auroraScale === REDUCED_AURORA_SCALE) return;
    this.#slowFrames = elapsedMs > SLOW_FRAME_MS ? this.#slowFrames + 1 : Math.max(0, this.#slowFrames - 1);
    if (this.#slowFrames < SLOW_FRAMES_BEFORE_REDUCING) return;
    this.#auroraScale = REDUCED_AURORA_SCALE;
    this.#visibleGrains = REDUCED_DUST_COUNT;
    this.#sizeTarget();
  }

  #listen(now, seconds) {
    const levels = this.#levels();
    const follow = (name, value) => {
      const speed = value > this.#bands[name] ? 0.22 : 0.035;
      this.#bands[name] += (value - this.#bands[name]) * speed;
    };
    const bass = average(levels, 0, 8);
    follow('bass', bass);
    follow('mid', average(levels, 8, 30));
    follow('high', average(levels, 30, 60));
    const isOnset = bass > ONSET_FLOOR && bass > this.#bassFloor * ONSET_RATIO && now - this.#lastShock > ONSET_GAP_MS;
    if (isOnset && !this.#reducedMotion) {
      this.#lastShock = now;
      this.#shocks.push({ radius: 0.12, age: 0, power: Math.min(1, bass * 1.5) });
      if (this.#shocks.length > MAX_SHOCKS) this.#shocks.shift();
    }
    this.#bassFloor += (bass - this.#bassFloor) * 0.05;
    /* Rays jump with the sound and sink back slowly, like the bars of a meter. */
    for (let index = 0; index < SPECTRUM_SIZE; index += 1) {
      /* Music is far quieter up high: the tilt lets every direction take part. */
      const tilt = 1 + (index / SPECTRUM_SIZE) * 2.6;
      const level = Math.min(1, levels[Math.floor((index / SPECTRUM_SIZE) * levels.length)] * tilt) ** 1.35;
      const held = this.#spectrum[index];
      this.#spectrum[index] = held + (level - held) * (level > held ? 0.14 : 0.03);
      this.#spectrumBytes[index] = Math.min(255, this.#spectrum[index] * 255);
    }
    if (!this.#reducedMotion) this.#flow += seconds * (0.06 + this.#bands.bass * 0.6 + this.#bands.mid * 0.25);
    for (const shock of this.#shocks) {
      shock.age += seconds;
      shock.radius += SHOCK_SPEED * seconds;
    }
    this.#shocks = this.#shocks.filter((shock) => shock.age < SHOCK_LIFE_SEC);
    if (this.#tune) {
      this.#tune.age += seconds;
      if (this.#tune.age > TUNE_LIFE_SEC) this.#tune = null;
    }
    if (this.#targetColors) {
      this.#colors = this.#colors.map((color, index) =>
        color.map((value, channel) => value + (this.#targetColors[index][channel] - value) * COLOR_EASE),
      );
    }
    this.#wind += (this.#stir() - this.#wind) * 0.12;
  }

  #moveDust(time, seconds, aspect, center) {
    const { bass, mid, high } = this.#bands;
    const air = 0.012 + mid * 0.1;
    const data = this.#grainData;
    for (let index = 0; index < this.#visibleGrains; index += 1) {
      const grain = this.#grains[index];
      if (!this.#reducedMotion) {
        /* Curling drift, with a slow lift, like dust in a beam of light. */
        const curl =
          Math.sin(grain.x * 5.1 + time * 0.09 + grain.seed * 0.1) + Math.cos(grain.y * 6.3 - time * 0.07 + grain.seed * 0.07);
        let moveX = Math.cos(curl * 2.2) * air + this.#wind;
        let moveY = Math.sin(curl * 2.2) * air + 0.006;
        const offsetX = (grain.x - center[0]) * aspect;
        const offsetY = grain.y - center[1];
        const reach = Math.hypot(offsetX, offsetY) + 0.0001;
        for (const shock of this.#shocks) {
          const crest = Math.exp(-(((reach - shock.radius) / SHOCK_WIDTH) ** 2));
          const force = crest * shock.power * (1 - shock.age / SHOCK_LIFE_SEC) * 0.45;
          grain.pushX += (offsetX / reach) * force * seconds;
          grain.pushY += (offsetY / reach) * force * seconds;
        }
        grain.pushX *= 0.94;
        grain.pushY *= 0.94;
        moveX += grain.pushX;
        moveY += grain.pushY;
        grain.x += (moveX * grain.depth * seconds) / aspect;
        grain.y += moveY * grain.depth * seconds;
        if (grain.x < -0.03) grain.x += 1.06;
        if (grain.x > 1.03) grain.x -= 1.06;
        if (grain.y < -0.03) grain.y += 1.06;
        if (grain.y > 1.03) grain.y -= 1.06;
      }

      const twinkle = 0.5 + 0.5 * Math.sin(time * (0.5 + (grain.seed % 1) * 1.3) + grain.seed);
      const color = this.#colors[grain.shade];
      const whiten = grain.whiten;
      const warm = (value) => value + (1 - value) * whiten;
      let alpha;
      let size = grain.size;
      if (grain.kind === BOKEH) {
        alpha = (0.02 + bass * 0.05) * (0.5 + twinkle * 0.5);
        size = -size;
      } else if (grain.kind === GLINT) {
        /* Rests almost dark and flares briefly, more often with the highs. */
        const flare = twinkle ** 10;
        alpha = 1 + Math.min(1, flare * (0.5 + high * 1.6) + high * 0.1);
        size *= 0.75 + flare * 0.5;
      } else {
        alpha = (0.3 + twinkle * 0.5 + high * 0.45) * (0.5 + grain.depth * 0.5);
      }
      const at = index * FLOATS_PER_GRAIN;
      data[at] = grain.x;
      data[at + 1] = grain.y;
      data[at + 2] = size;
      data[at + 3] = warm(color[0]);
      data[at + 4] = warm(color[1]);
      data[at + 5] = warm(color[2]);
      data[at + 6] = alpha;
    }
  }

  #bindQuad({ program }) {
    const gl = this.#gl;
    const corner = gl.getAttribLocation(program, 'corner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#quad);
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
  }

  #drawAurora(time, aspect, center) {
    const gl = this.#gl;
    const shock = this.#shocks.at(-1);
    const { program, uniforms } = this.#aurora;
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#target);
    gl.viewport(0, 0, this.#targetSize[0], this.#targetSize[1]);
    gl.disable(gl.BLEND);
    this.#bindQuad(this.#aurora);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.#spectrumTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, SPECTRUM_SIZE, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.#spectrumBytes);
    gl.uniform1i(uniforms.spectrum, 1);
    gl.uniform1f(uniforms.flow, this.#flow);
    gl.uniform1f(uniforms.time, time);
    gl.uniform1f(uniforms.aspect, aspect);
    gl.uniform1f(uniforms.bass, this.#bands.bass);
    gl.uniform1f(uniforms.mid, this.#bands.mid);
    gl.uniform1f(uniforms.high, this.#bands.high);
    gl.uniform1f(uniforms.shockRadius, shock?.radius ?? 0);
    gl.uniform1f(uniforms.shockPower, shock ? shock.power * (1 - shock.age / SHOCK_LIFE_SEC) : 0);
    gl.uniform1f(uniforms.tuneRadius, this.#tune ? 0.06 + this.#tune.age * TUNE_SPEED : 0);
    gl.uniform1f(uniforms.tunePower, this.#tune ? (1 - this.#tune.age / TUNE_LIFE_SEC) ** 1.4 : 0);
    gl.uniform2f(uniforms.origin, center[0], center[1]);
    gl.uniform3fv(uniforms.colorA, this.#colors[0]);
    gl.uniform3fv(uniforms.colorB, this.#colors[1]);
    gl.uniform3fv(uniforms.colorC, this.#colors[2]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  #drawToScreen() {
    const gl = this.#gl;
    gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.#blit.program);
    this.#bindQuad(this.#blit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#targetTexture);
    gl.uniform1i(this.#blit.uniforms.image, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.#drawDust();
  }

  #drawDust() {
    const gl = this.#gl;
    const { program, uniforms } = this.#dust;
    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(uniforms.scale, this.#canvas.width / this.#canvas.clientWidth);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#dustBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#grainData);
    const stride = FLOATS_PER_GRAIN * 4;
    for (const [name, count, offset] of [['position', 2, 0], ['size', 1, 8], ['tint', 4, 12]]) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, count, gl.FLOAT, false, stride, offset);
    }
    gl.drawArrays(gl.POINTS, 0, this.#visibleGrains);
  }

  #draw = (now) => {
    this.#frame = requestAnimationFrame(this.#draw);
    if (document.hidden || !this.#targetColors) {
      this.#lastFrame = now;
      return;
    }
    if (!this.#canvas.width) this.#fit();
    const elapsedMs = now - this.#lastFrame;
    this.#lastFrame = now;
    this.#watchSpeed(elapsedMs);
    const seconds = Math.min(elapsedMs / 1000, 0.05);
    this.#listen(now, seconds);
    const { clientWidth, clientHeight } = this.#canvas;
    const aspect = clientWidth / Math.max(clientHeight, 1);
    const origin = this.#origin();
    const center = origin ? [origin.x / clientWidth, 1 - origin.y / clientHeight] : [0.5, 0.5];
    const time = this.#reducedMotion ? 12 : now / 1000;
    this.#moveDust(time, seconds, aspect, center);
    this.#drawAurora(time, aspect, center);
    this.#drawToScreen();
  };
}
