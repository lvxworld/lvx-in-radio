/** The same receiver face in the main radio and both small players. */
export function drawStationDial(canvas, { levels = [], colors = ['#f2a33a'], time = 0 } = {}) {
  const width = 346, height = 196, cx = 173, cy = 184;
  const scale = (canvas.clientWidth || width) / width;
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * scale * dpr);
  const pixelHeight = Math.round(height * scale * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth; canvas.height = pixelHeight;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  context.clearRect(0, 0, width, height);
  const palette = (colors.length ? colors : ['#f2a33a']).map(color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)));
  const colorAt = (position, alpha = 1) => {
    const at = Math.min(position, .9999) * (palette.length - 1), index = Math.floor(at), mix = at - index;
    const a = palette[index], b = palette[Math.min(index + 1, palette.length - 1)];
    return `rgba(${a.map((value, channel) => Math.round(value + (b[channel] - value) * mix)).join(',')},${alpha})`;
  };
  const average = levels.length ? levels.reduce((sum, level) => sum + level, 0) / levels.length : 0;
  for (let i = 0; i <= 72; i++) {
    const angle = Math.PI + i / 72 * Math.PI;
    context.fillStyle = i % 6 === 0 ? 'rgba(243,236,226,.4)' : 'rgba(243,236,226,.14)';
    context.beginPath(); context.arc(cx + Math.cos(angle) * 168, cy + Math.sin(angle) * 168, i % 6 === 0 ? 1.3 : .7, 0, Math.PI * 2); context.fill();
  }
  let gradient = colorAt(.5);
  if (context.createConicGradient) {
    gradient = context.createConicGradient(Math.PI, cx, cy);
    for (let i = 0; i <= 8; i++) gradient.addColorStop(i / 16, colorAt(i / 8));
  }
  context.save(); context.shadowColor = colorAt(.5, .35 + average * .5); context.shadowBlur = 12 + average * 22;
  context.lineWidth = 7; context.lineCap = 'round'; context.strokeStyle = gradient;
  context.beginPath(); context.arc(cx, cy, 152, Math.PI, Math.PI * 2); context.stroke(); context.restore();
  context.lineWidth = 1; context.strokeStyle = 'rgba(255,255,255,.07)';
  context.beginPath(); context.arc(cx, cy, 84, Math.PI, Math.PI * 2); context.stroke();
  context.lineCap = 'butt';
  for (let i = 0; i <= 48; i++) {
    const position = i / 48, angle = Math.PI + position * Math.PI, major = i % 6 === 0, fromMiddle = Math.abs(position - .5) * 2;
    const level = Math.max(Math.min(1, (levels[Math.floor(fromMiddle * 44)] || 0) * (.72 + .6 * Math.pow(fromMiddle, .8))), .07 + .09 * (.5 + .5 * Math.sin(time * 1.6 - i * .34)));
    const inner = major ? 88 : 92, outer = major ? 140 : 96 + level * 42;
    context.strokeStyle = major ? 'rgba(243,236,226,.38)' : colorAt(position, .55 + level * .45);
    context.lineWidth = major ? 2.2 : 1.6;
    context.beginPath(); context.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    context.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer); context.stroke();
  }
}
