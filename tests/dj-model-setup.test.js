import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import manifest from '../src/engine/dj-llm-manifest.json' with { type: 'json' };
import { ModelSetup } from '../src/engine/model-setup.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('DJ LLM manifest pins every file to the Qwen3.5-4B-4bit revision and has verifiable sizes/hashes', () => {
  assert.equal(manifest.revision, '0e7ffd5c629ef7719d4cbc04069232580bfa9d9c');
  assert.ok(manifest.files.some((file) => file.path === 'model.safetensors' && file.size > 3_000_000_000));
  assert.ok(manifest.files.some((file) => file.path === 'chat_template.jinja'));
  for (const file of manifest.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(file.size > 0);
    assert.ok(file.url.includes(`/resolve/${manifest.revision}/`), file.path);
    assert.ok(file.url.includes('mlx-community/Qwen3.5-4B-4bit'), file.path);
  }
});

test('DJ model setup accepts only the matching pinned Hugging Face cache snapshot in place', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lvx-dj-hf-'));
  const hub = join(root, 'hf-cache', 'hub');
  const bytes = Buffer.from('tiny pinned DJ model fixture');
  const rev = manifest.revision;
  const file = { ...manifest.files.find((entry) => entry.path === 'chat_template.jinja'), size: bytes.length, sha256: sha256(bytes) };
  const repo = 'models--mlx-community--Qwen3.5-4B-4bit';
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
  const file = { ...manifest.files.find((entry) => entry.path === 'chat_template.jinja'), size: bytes.length, sha256: sha256(bytes) };
  const repo = 'models--mlx-community--Qwen3.5-4B-4bit';
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
