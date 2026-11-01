/**
 * YuE2 sings even with `[instrumental]` lyrics. It stays silent only when it
 * renders a planned score whose vocal line holds nothing but rests.
 */

const HEADER_LINES = 8;

function barLength(lines) {
  const meter = /^M:(\d+)\/(\d+)$/.exec(lines[2] ?? '');
  const unit = /^L:1\/(\d+)$/.exec(lines[3] ?? '');
  if (!meter || !unit) throw new Error('The planner did not return a usable score');
  return (Number(meter[1]) * Number(unit[1])) / Number(meter[2]);
}

function restedBars(line, units) {
  const rest = `z${units}`;
  const bars = line.replace(/\|$/, '').split('|').flatMap((bar) => {
    const silent = /^Z([1-4])?$/.exec(bar.trim());
    if (silent) return Array(Number(silent[1] ?? 1)).fill(rest);
    return [`${(bar.match(/"[^"\n]*"/g) ?? []).join('')}${rest}`];
  });
  return `${bars.join('|')}|`;
}

/** Rests every vocal note, keeping chord symbols, the timing and the instruments. */
export function muteVocals(score) {
  const lines = score.split('\n');
  const units = barLength(lines);
  if (!Number.isInteger(units) || !lines.slice(HEADER_LINES).includes('V: Vocal')) {
    throw new Error('The planner did not return a usable score');
  }
  return lines
    .map((line, index) => (index >= HEADER_LINES && lines[index - 1] === 'V: Vocal' ? restedBars(line, units) : line))
    .join('\n');
}

/** The muted score from a planning response. Throws if the plan is incomplete. */
export function scoreFromPlan(result) {
  const score = result.artifacts?.find((artifact) => artifact.id === 'score');
  if (!score?.payload || String(score.meta?.truncated).toLowerCase() !== 'false') {
    throw new Error('The planner did not return a complete score');
  }
  return muteVocals(Buffer.from(score.payload, 'base64').toString('utf8'));
}
