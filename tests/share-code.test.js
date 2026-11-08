import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeCode, encodeShareCode, decodeShareCode } from '../src/ui/assets/lvx-code.js';

const config = { mix: { 'R&B': 40, 'Hip-hop': 35, 'Lo-fi': 25 }, energy: 42, bpm: 91, dark: 70, melody: false, scenario: 'Road trip', flavors: ['neon', 'raw'], hint: 'Jazz', seed: 2 ** 46 + 5, mood: 'rain ~ on glass' };

test('short shared codes keep their existing format and old images remain readable', async () => {
  assert.equal(await encodeShareCode(config), encodeCode(config));
  assert.deepEqual(await decodeShareCode(encodeCode(config)), config);
});

test('long shared descriptions preserve Unicode, separators, voices and all settings', async () => {
  for (const instrumental of [false, true]) {
    const shared = { ...config, mood: 'Città di notte 🌙 ~ pioggia, un piano e voci lontane. '.repeat(20).slice(0, 1000), ...(instrumental ? { instrumental: true } : {}) };
    const text = await encodeShareCode(shared);
    assert.ok(text.startsWith('LVX2~'));
    assert.ok(text.length < 500, 'the compressed description fits a QR with high error correction');
    assert.deepEqual(await decodeShareCode(text), shared);
  }
});

test('damaged and oversized compressed shared codes are refused', async () => {
  await assert.rejects(decodeShareCode('LVX2~broken'), /Not a Lux code/);
  const oversized = await encodeShareCode({ ...config, mood: 'a'.repeat(30000) });
  await assert.rejects(decodeShareCode(oversized), /Not a Lux code/);
});
