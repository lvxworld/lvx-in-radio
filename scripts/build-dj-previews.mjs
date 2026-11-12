#!/usr/bin/env node
/**
 * Renders the six DJ audition clips that ship with the app (src/radio/dj/previews/), so Listen
 * plays at once with no engine. Real pipeline: Qwen3-TTS through audio.cpp, each DJ's audition
 * style, the app's preview sentence. Loudness-matched (EBU R128, two passes), 64 kbps mono MP3.
 * Re-run after changing a DJ speaker, a style instruct, the preview sentence or the voice weights:
 * the app ignores a clip whose prompt hash no longer matches and voices that DJ live instead.
 *
 *   npm run build:dj-previews
 * Env: LVX_NEWS_VOICE_DIR (Qwen3-TTS CustomVoice folder), LVX_ENGINE_BINARY, LVX_MODEL_SPECS, FFMPEG.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioCppEngine } from '../src/engine/audiocpp.js';
import { readWav } from '../src/engine/wav.js';
import { loadDjPrompts } from '../src/radio/dj/prompts.js';
import { PREVIEW_DIR, PREVIEW_TEXT, VOICE_VERSION, previewPromptHash, previewStyleFor } from '../src/radio/dj/dj-preview.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = process.env.LVX_DJ_PREVIEW_DATA ?? join(homedir(), '.lvx-dev/dj13-data');
const VOICE = resolve(process.env.LVX_NEWS_VOICE_DIR ?? join(ROOT, '.data/models/Qwen3-TTS-12Hz-1.7B-CustomVoice'));
const BINARY = process.env.LVX_ENGINE_BINARY ?? join(ROOT, 'vendor/audio.cpp/audiocpp_server');
const SPECS = process.env.LVX_MODEL_SPECS ?? join(ROOT, 'vendor/audio.cpp/model_specs');
const FFMPEG = process.env.FFMPEG ?? ['/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', 'ffmpeg'].find((path) => path === 'ffmpeg' || existsSync(path));
const LOUDNESS = { I: -18, TP: -1.5, LRA: 11 };
const MAX_SET_BYTES = 3 * 1024 * 1024;

for (const [label, path] of [['voice model', join(VOICE, 'config.json')], ['audio.cpp', BINARY], ['model specs', SPECS]]) {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`);
}

function ffmpeg(args) {
  const run = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr.slice(-800)}`);
  return run.stderr;
}

const prompts = await loadDjPrompts();
await rm(WORK, { recursive: true, force: true });
await mkdir(join(WORK, 'wav'), { recursive: true });
const engine = new AudioCppEngine({ binary: BINARY, modelSpecs: SPECS, dataDir: WORK, ttsOnly: true, tts: { modelDir: VOICE } });
const clips = [];
try {
  await mkdir(PREVIEW_DIR, { recursive: true });
  for (const dj of [...prompts.djs].sort((a, b) => a.id.localeCompare(b.id))) {
    const styleId = previewStyleFor(dj, prompts.styles);
    const style = prompts.styles.find((entry) => entry.id === styleId);
    const started = performance.now();
    const response = await engine.run({ text: PREVIEW_TEXT, options: { speaker: dj.speaker, instruct: style.instruct, language: 'English' } }, { model: 'qwen3tts' });
    if (!response?.audio) throw new Error(`No audio for ${dj.id}`);
    const wavPath = join(WORK, 'wav', `${dj.id}.wav`);
    const wav = Buffer.from(response.audio, 'base64');
    const { sampleRate, samples } = readWav(wav);
    if (samples[0].length / sampleRate < 2) throw new Error(`Audio for ${dj.id} is too short`);
    await writeFile(wavPath, wav);
    // Two-pass loudness normalisation, so the six clips sit at the same level.
    const target = `I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}`;
    const measured = JSON.parse(ffmpeg(['-i', wavPath, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']).match(/\{[\s\S]*?\}/g).at(-1));
    const file = `${dj.id}.mp3`;
    ffmpeg(['-i', wavPath, '-af', `loudnorm=${target}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`,
      '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', '-map_metadata', '-1', '-id3v2_version', '0', '-write_xing', '1', join(PREVIEW_DIR, file)]);
    const bytes = await readFile(join(PREVIEW_DIR, file));
    const durationSec = Number((samples[0].length / sampleRate).toFixed(2));
    clips.push({ djId: dj.id, styleId, file, sizeBytes: bytes.length, durationSec, sha256: createHash('sha256').update(bytes).digest('hex'), promptHash: previewPromptHash({ dj, style }), voiceVersion: VOICE_VERSION, text: PREVIEW_TEXT });
    console.log(`${dj.id} (${styleId}): ${durationSec}s, ${Math.round(bytes.length / 1024)} KB, voiced in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
} finally {
  await engine.stop();
}
const total = clips.reduce((sum, clip) => sum + clip.sizeBytes, 0);
if (total > MAX_SET_BYTES) throw new Error(`The preview set is ${total} bytes, over ${MAX_SET_BYTES}`);
await writeFile(join(PREVIEW_DIR, 'manifest.json'), `${JSON.stringify({ version: 1, loudness: LOUDNESS, clips }, null, 2)}\n`);
console.log(`Wrote ${clips.length} clips, ${Math.round(total / 1024)} KB, to ${PREVIEW_DIR}`);
