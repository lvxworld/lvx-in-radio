// Dev only: speaks one sentence with the real Qwen3-TTS voice through the app's own engine and reports the speed.
// Usage: node scripts/news-voice-check.mjs [out.wav]   (needs the voice folder, see LVX_NEWS_VOICE_DIR)
import { writeFile } from 'node:fs/promises';
const R = new URL('../src/', import.meta.url).href;
const { loadConfig } = await import(R + 'config.js');
const { AudioCppEngine } = await import(R + 'engine/audiocpp.js');
const { createSynthesizer } = await import(R + 'radio/news/news-voice.js');
const { wavDurationSeconds } = await import(R + 'engine/wav.js');

const config = loadConfig();
const engine = new AudioCppEngine({ ...config.engine, tts: { modelDir: config.news.voiceModelDir } });
const speak = createSynthesizer(engine, { speaker: config.news.speaker });
const sentences = [
  'Good evening. Here are the latest headlines.',
  'Two dead after bus crashes in France, officials say. One child and one young adult were killed in the crash, local authorities say, with more injured. According to BBC News.',
];
try {
  for (const [i, text] of sentences.entries()) {
    const started = Date.now();
    const wav = await speak(text);
    const seconds = wavDurationSeconds(wav), took = (Date.now() - started) / 1000;
    console.log(`#${i + 1}: ${seconds.toFixed(1)} s of audio in ${took.toFixed(1)} s (${(took / seconds).toFixed(2)}x)${i === 0 ? ' (includes model loading)' : ''}`);
    if (process.argv[2]) await writeFile(process.argv[2].replace(/\.wav$/, `-${i + 1}.wav`), wav);
  }
} finally {
  await engine.stop();
}
