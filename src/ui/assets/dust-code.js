/**
 * Draws a real QR code as a cloud of coloured dust. Bright modules are dense
 * dust on a dark ground, which QR readers accept as an inverted code. Colours
 * follow the mix: each genre owns a slice of the cloud sized by its share.
 */

const GROUND = '#0d0c0b';
const QUIET_MODULES = 4;
const CODE_SHARE = 0.62;
const CORE_SHARE = 0.5;
const CORE_ALPHA = 0.85;
const GRAINS_PER_MODULE = 16;
const NEBULA_PUFFS = 220;
const MOVING_PER_MODULE = 3;
const HALO_GRAINS = 5200;
const SHIMMER_GRAINS = 160;
const SPRITE_SIZE = 32;
const ASSEMBLE_MS = 1500;
const FRAME_MS = 1000 / 30;
/* The logo takes the middle of the code. Level H error correction recovers it. */
const LOGO_HOLE = 0.11;
const LOGO_SIZE = 0.15;
const RING_REACH = 0.47;
const POSTER_RADIUS = 72;
const logoSymbol = new Image();
logoSymbol.src = 'assets/logo-symbol.png';
const READ_SIZES = [1280, 700, 500, 1000, 340];
const READ_THRESHOLDS = [70, 100, 45, 130];

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

function hashText(text) {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash;
}

function vivid(hex) {
  return [1, 3, 5].map((start) => Math.round(parseInt(hex.slice(start, start + 2), 16) * 0.94 + 255 * 0.06)).join(',');
}

function makeSprite(rgb) {
  const sprite = document.createElement('canvas');
  sprite.width = SPRITE_SIZE;
  sprite.height = SPRITE_SIZE;
  const context = sprite.getContext('2d');
  const center = SPRITE_SIZE / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, `rgba(${rgb},1)`);
  gradient.addColorStop(0.45, `rgba(${rgb},.75)`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  return sprite;
}

/** Everything about the cloud that does not depend on the output size. */
function layout(text, colors) {
  const code = window.qrcode(0, 'H');
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  const span = count + QUIET_MODULES * 2;
  const modules = [];
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      const x = (column + QUIET_MODULES + 0.5) / span - 0.5;
      const y = (row + QUIET_MODULES + 0.5) / span - 0.5;
      if (code.isDark(row, column) && Math.hypot(x, y) > LOGO_HOLE) modules.push({ x, y });
    }
  }
  const total = colors.reduce((sum, color) => sum + color.share, 0);
  let edge = 0;
  const slices = colors.map(({ color, share }) => {
    edge += share / total;
    const rgb = vivid(color);
    return { until: edge, rgb, sprite: makeSprite(rgb) };
  });
  return { modules, span, slices, rng: random(hashText(text)) };
}

function sliceAt(slices, x, y, rng) {
  const turn = (Math.atan2(y, x) / (Math.PI * 2) + 1 + (rng() - 0.5) * 0.14) % 1;
  return slices.find((slice) => turn <= slice.until) ?? slices.at(-1);
}

function spriteAt(slices, x, y, rng) {
  return sliceAt(slices, x, y, rng).sprite;
}

/** Soft colour behind the code. It stays dim enough to read as dark. */
function paintNebula(context, size, slices, rng) {
  const center = size / 2;
  context.globalCompositeOperation = 'lighter';
  for (let index = 0; index < NEBULA_PUFFS; index += 1) {
    const angle = rng() * Math.PI * 2;
    const reach = (size / 2) * (0.55 + rng() * 0.42);
    const x = Math.cos(angle) * reach;
    const y = Math.sin(angle) * reach;
    const radius = size * (0.05 + rng() * 0.1);
    context.globalAlpha = 0.012 + rng() * 0.03;
    context.drawImage(spriteAt(slices, x, y, rng), center + x - radius, center + y - radius, radius * 2, radius * 2);
  }
}

function paintHalo(context, size, quiet, slices, rng) {
  const center = size / 2;
  const edge = quiet * Math.SQRT2 * 0.92;
  context.globalCompositeOperation = 'lighter';
  for (let index = 0; index < HALO_GRAINS; index += 1) {
    const angle = rng() * Math.PI * 2;
    const reach = quiet + rng() ** 1.25 * (size / 2 - quiet);
    const x = Math.cos(angle) * reach;
    const y = Math.sin(angle) * reach;
    if (Math.max(Math.abs(x), Math.abs(y)) < quiet) continue;
    const near = 1 - Math.min(Math.max((reach - edge) / (size / 2 - edge), 0), 1);
    const radius = size * (0.0009 + rng() ** 3 * 0.005);
    context.globalAlpha = (0.2 + rng() * 0.65) * (0.25 + near * 0.75);
    context.drawImage(spriteAt(slices, x, y, rng), center + x - radius, center + y - radius, radius * 2, radius * 2);
  }
}

/** Solid cores keep the code readable; fine grains make its edges dusty. */
function paintModules(context, codeSize, center, plan) {
  const { modules, span, slices, rng } = plan;
  const cell = codeSize / span;
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = 1;
  for (const module of modules) {
    const x = module.x * codeSize;
    const y = module.y * codeSize;
    context.globalAlpha = CORE_ALPHA;
    context.fillStyle = `rgb(${sliceAt(slices, x, y, rng).rgb})`;
    context.beginPath();
    context.arc(center + x, center + y, cell * CORE_SHARE, 0, Math.PI * 2);
    context.fill();
  }
  for (const module of modules) {
    for (let grain = 0; grain < GRAINS_PER_MODULE; grain += 1) {
      const x = (module.x + ((rng() - 0.5) * 1.05) / span) * codeSize;
      const y = (module.y + ((rng() - 0.5) * 1.05) / span) * codeSize;
      const radius = cell * (0.05 + rng() ** 2 * 0.17);
      context.globalAlpha = 0.7 + rng() * 0.3;
      context.drawImage(spriteAt(slices, x, y, rng), center + x - radius, center + y - radius, radius * 2, radius * 2);
    }
  }
}

/** The symbol in the clear middle of the code. */
function paintLogo(context, size) {
  if (!logoSymbol.complete || !logoSymbol.naturalWidth) return;
  const width = size * LOGO_SIZE;
  const height = (width * logoSymbol.naturalHeight) / logoSymbol.naturalWidth;
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = 1;
  context.drawImage(logoSymbol, size / 2 - width / 2, size / 2 - height / 2, width, height);
}

/** A fine ring in the mix's colours, like the dials: the code reads as a round object. */
function paintRing(context, size, slices) {
  const center = size / 2;
  const radius = size * RING_REACH;
  context.globalCompositeOperation = 'source-over';
  context.lineWidth = Math.max(1.5, size * 0.004);
  context.lineCap = 'round';
  let from = -Math.PI / 2;
  let start = 0;
  for (const slice of slices) {
    const end = -Math.PI / 2 + (slice.until - start) * Math.PI * 2 + (from + Math.PI / 2);
    context.globalAlpha = 0.5;
    context.strokeStyle = `rgb(${slice.rgb})`;
    context.beginPath();
    context.arc(center, center, radius, from + 0.03, end - 0.03);
    context.stroke();
    from = end;
    start = slice.until;
  }
}

/** Paints the finished cloud. Its size is the side of the square in pixels. */
function paintCloud(context, size, plan) {
  const codeSize = size * CODE_SHARE;
  context.save();
  paintNebula(context, size, plan.slices, plan.rng);
  paintHalo(context, size, codeSize / 2, plan.slices, plan.rng);
  paintModules(context, codeSize, size / 2, plan);
  paintRing(context, size, plan.slices);
  paintLogo(context, size);
  context.restore();
}

export class DustCode {
  #canvas;
  #context;
  #size = 0;
  #plan = null;
  #still = null;
  #grains = [];
  #shimmer = [];
  #started = 0;
  #frame = 0;
  #lastDraw = 0;
  #text = '';
  #reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  constructor(canvas) {
    this.#canvas = canvas;
    this.#context = canvas.getContext('2d');
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    this.#size = Math.round(canvas.clientWidth * scale);
    canvas.width = this.#size;
    canvas.height = this.#size;
    this.#frame = requestAnimationFrame(this.#draw);
  }

  get text() {
    return this.#text;
  }

  /** Shows a code. The dust gathers from a cloud into the new pattern. */
  show(text, colors) {
    this.#text = text;
    const plan = layout(text, colors);
    this.#plan = plan;
    this.#still = document.createElement('canvas');
    this.#still.width = this.#size;
    this.#still.height = this.#size;
    const still = this.#still.getContext('2d');
    still.fillStyle = GROUND;
    still.fillRect(0, 0, this.#size, this.#size);
    paintCloud(still, this.#size, plan);
    this.#prepareMotion(plan);
    this.#started = performance.now();
  }

  destroy() {
    cancelAnimationFrame(this.#frame);
  }

  #prepareMotion({ modules, span, slices, rng }) {
    const codeSize = this.#size * CODE_SHARE;
    const center = this.#size / 2;
    this.#grains = [];
    for (const module of modules) {
      for (let grain = 0; grain < MOVING_PER_MODULE; grain += 1) {
        const x = (module.x + ((rng() - 0.5) * 0.74) / span) * codeSize;
        const y = (module.y + ((rng() - 0.5) * 0.74) / span) * codeSize;
        const angle = Math.atan2(y, x) + (rng() - 0.5) * 1.6;
        const reach = this.#size * (0.2 + rng() * 0.32);
        this.#grains.push({
          homeX: center + x,
          homeY: center + y,
          fromX: center + Math.cos(angle) * reach,
          fromY: center + Math.sin(angle) * reach,
          delay: rng() * 0.45,
          radius: (codeSize / span) * (0.24 + rng() * 0.2),
          sprite: spriteAt(slices, x, y, rng),
        });
      }
    }
    this.#shimmer = Array.from({ length: SHIMMER_GRAINS }, () => {
      const angle = rng() * Math.PI * 2;
      const reach = (this.#size / 2) * (0.1 + rng() * 0.88);
      const x = Math.cos(angle) * reach;
      const y = Math.sin(angle) * reach;
      return {
        x: center + x,
        y: center + y,
        radius: this.#size * (0.003 + rng() * 0.006),
        phase: rng() * Math.PI * 2,
        speed: 0.6 + rng() * 1.6,
        sprite: spriteAt(slices, x, y, rng),
      };
    });
  }

  #draw = (now) => {
    this.#frame = requestAnimationFrame(this.#draw);
    if (!this.#plan || now - this.#lastDraw < FRAME_MS || document.hidden) return;
    this.#lastDraw = now;
    const context = this.#context;
    const size = this.#size;
    const elapsed = this.#reducedMotion ? ASSEMBLE_MS : now - this.#started;
    const progress = Math.min(elapsed / ASSEMBLE_MS, 1);
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;

    if (progress >= 1) {
      context.drawImage(this.#still, 0, 0);
      if (this.#reducedMotion) return;
      context.globalCompositeOperation = 'lighter';
      for (const grain of this.#shimmer) {
        context.globalAlpha = 0.25 + 0.25 * Math.sin(now / 1000 * grain.speed + grain.phase);
        context.drawImage(grain.sprite, grain.x - grain.radius, grain.y - grain.radius, grain.radius * 2, grain.radius * 2);
      }
      return;
    }

    context.fillStyle = GROUND;
    context.fillRect(0, 0, size, size);
    context.globalAlpha = progress ** 3;
    context.drawImage(this.#still, 0, 0);
    context.globalCompositeOperation = 'lighter';
    context.globalAlpha = 0.9 * (1 - progress ** 4);
    for (const grain of this.#grains) {
      const local = Math.min(Math.max((progress - grain.delay) / (1 - grain.delay), 0), 1);
      const eased = 1 - (1 - local) ** 3;
      const x = grain.fromX + (grain.homeX - grain.fromX) * eased;
      const y = grain.fromY + (grain.homeY - grain.fromY) * eased;
      context.drawImage(grain.sprite, x - grain.radius, y - grain.radius, grain.radius * 2, grain.radius * 2);
    }
  };
}

/** A shareable picture of the code: the cloud above the station name. */
export function renderPoster(text, colors, title) {
  const width = 1080;
  const height = 1280;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.beginPath();
  context.roundRect(0, 0, width, height, POSTER_RADIUS);
  context.clip();
  context.fillStyle = GROUND;
  context.fillRect(0, 0, width, height);
  paintCloud(context, width, layout(text, colors));
  context.textAlign = 'center';
  context.fillStyle = '#f3ece2';
  context.font = "700 64px 'Space Grotesk', sans-serif";
  context.fillText(title, width / 2, 1160);
  context.fillStyle = '#9b958c';
  context.font = "400 30px 'Space Grotesk', sans-serif";
  context.fillText('Open it in LVX Radio to tune in', width / 2, 1216);
  return canvas;
}

/** Turns bright dust into black modules on white, the form QR readers expect. */
function binarize({ data }, threshold) {
  const output = new Uint8ClampedArray(data.length);
  for (let index = 0; index < data.length; index += 4) {
    const luminance = data[index] * 0.3 + data[index + 1] * 0.59 + data[index + 2] * 0.11;
    const value = luminance > threshold ? 0 : 255;
    output[index] = value;
    output[index + 1] = value;
    output[index + 2] = value;
    output[index + 3] = 255;
  }
  return output;
}

/** Reads a Lux code from a picture, trying sizes and light levels in turn. */
export async function readCodeFromImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  for (const longestSide of READ_SIZES) {
    const scale = Math.min(longestSide / Math.max(bitmap.width, bitmap.height), 1);
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    context.filter = 'blur(1px)';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    for (const threshold of READ_THRESHOLDS) {
      const found = window.jsQR(binarize(image, threshold), canvas.width, canvas.height, {
        inversionAttempts: 'dontInvert',
      });
      if (found?.data) return found.data;
    }
  }
  throw new Error('No Lux code found in this picture');
}
