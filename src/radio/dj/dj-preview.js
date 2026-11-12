import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Qwen3-TTS weights the DJ voice was tuned on; part of every cache key. */
export const VOICE_VERSION = 'qwen3tts-customvoice-0c0e3051';
export const PREVIEW_TEXT = 'Welcome to LVX in Radio. Here is a quick voice check before we get back to the music. I promise this introduction is shorter than the settings menu.';
export const PREVIEW_DIR = fileURLToPath(new URL('./previews/', import.meta.url));

/** The style a DJ is auditioned in: its first station fit the catalog knows, else generic (as the client). */
export function previewStyleFor(dj, styles = []) {
  const known = new Set(styles.map((style) => style.id));
  return (dj?.bestFor ?? []).find((id) => known.has(id)) ?? 'generic';
}

/** Everything that changes what the audition sounds like. A bundled clip is used only while this matches. */
export function previewPromptHash({ dj, style, text = PREVIEW_TEXT, voiceVersion = VOICE_VERSION }) {
  return createHash('sha256').update(JSON.stringify([dj.id, dj.speaker, style.id, style.instruct, text, voiceVersion, 'English'])).digest('hex');
}

/**
 * The bundled clips (scripts/build-dj-previews.mjs) that still match the current prompts,
 * keyed by DJ id: { djId, styleId, file, sha256, promptHash }. Any mismatch or bad file is left out.
 */
export function loadBundledPreviews(prompts, { dir = PREVIEW_DIR } = {}) {
  const usable = new Map();
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); } catch { return usable; }
  for (const entry of Array.isArray(manifest?.clips) ? manifest.clips : []) {
    const dj = prompts.djs.find((item) => item.id === entry?.djId);
    const style = prompts.styles.find((item) => item.id === entry?.styleId);
    if (!dj || !style || entry.styleId !== previewStyleFor(dj, prompts.styles)) continue;
    if (entry.voiceVersion !== VOICE_VERSION || entry.text !== PREVIEW_TEXT || entry.promptHash !== previewPromptHash({ dj, style })) continue;
    if (!/^[a-z0-9-]+\.mp3$/.test(entry.file ?? '') || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) continue;
    try {
      const bytes = readFileSync(join(dir, entry.file));
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) continue;
    } catch { continue; }
    usable.set(dj.id, { djId: dj.id, styleId: style.id, file: join(dir, entry.file), sha256: entry.sha256, promptHash: entry.promptHash, durationSec: entry.durationSec });
  }
  return usable;
}
