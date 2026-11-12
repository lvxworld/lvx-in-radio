import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import manifest from '../src/engine/dj-llm-manifest.json' with { type: 'json' };
import { ModelSetup } from '../src/engine/model-setup.js';
import { WRITER_MODEL_FILE } from '../src/radio/dj/dj-desk.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('DJ LLM manifest pins one Qwen3.5-4B Q4_K_M GGUF with a verifiable size and hash', () => {
  assert.equal(manifest.revision, 'e87f176479d0855a907a41277aca2f8ee7a09523');
  assert.equal(manifest.files.length, 1, 'llama-server loads a single GGUF file');
  const [file] = manifest.files;
  assert.equal(file.path, 'Qwen3.5-4B-Q4_K_M.gguf');
  assert.equal(file.path, WRITER_MODEL_FILE);
  assert.ok(file.size > 2_500_000_000);
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(file.url, `https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/${manifest.revision}/${file.path}`);
});

test('DJ model setup accepts only the matching pinned Hugging Face cache snapshot in place', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-hf-'));
  const hub = join(root, 'hf-cache', 'hub');
  const bytes = Buffer.from('tiny pinned DJ model fixture');
  const rev = manifest.revision;
  const file = { ...manifest.files[0], size: bytes.length, sha256: sha256(bytes) };
  const repo = 'models--unsloth--Qwen3.5-4B-GGUF';
  const snapshot = join(hub, repo, 'snapshots', rev);
  await mkdir(join(hub, repo, 'blobs'), { recursive: true });
  await mkdir(snapshot, { recursive: true });
  await writeFile(join(hub, repo, 'blobs', file.sha256), bytes);
  await symlink(join('../../blobs', file.sha256), join(snapshot, file.path));
  const engine = { dataDir: join(root, 'data'), modelDir: join(root, 'data', 'owned-model'), binary: '/unused', modelSpecs: root };
  const setup = new ModelSetup(engine, { files: [file], hub, components: [] });
  t.after(async () => { await setup.close(); await rm(root, { recursive: true, force: true }); });
  await setup.initialize();
  let state = await setup.snapshot();
  for (let i = 0; i < 200 && !state.ready; i += 1) { await delay(5); state = await setup.snapshot(); }
  assert.equal(state.ready, true, JSON.stringify(state));
  assert.equal(state.directory, snapshot);
  assert.equal(engine.modelDir, snapshot, 'the pinned HF snapshot is used in place');
});

test('a DJ cache entry with the wrong pinned revision is ignored', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-hf-wrong-'));
  const hub = join(root, 'hf-cache', 'hub');
  const bytes = Buffer.from('a different DJ model revision');
  const correct = manifest.revision, wrong = 'f'.repeat(40);
  const file = { ...manifest.files[0], size: bytes.length, sha256: sha256(bytes) };
  const repo = 'models--unsloth--Qwen3.5-4B-GGUF';
  const snapshot = join(hub, repo, 'snapshots', wrong);
  await mkdir(snapshot, { recursive: true });
  await writeFile(join(snapshot, file.path), bytes);
  const engine = { dataDir: join(root, 'data'), modelDir: join(root, 'data', 'owned-model'), binary: '/unused', modelSpecs: root };
  const setup = new ModelSetup(engine, { files: [file], hub, components: [] });
  t.after(async () => { await setup.close(); await rm(root, { recursive: true, force: true }); });
  await setup.initialize();
  const state = await setup.snapshot();
  assert.equal(state.ready, false);
  assert.notEqual(state.directory, snapshot);
  assert.notEqual(correct, wrong);
});
