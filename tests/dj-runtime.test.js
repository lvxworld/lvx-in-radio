import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, VENDOR_DJ_LLM_COMMAND } from '../src/config.js';
import { DjDesk, resolveDjRuntime } from '../src/radio/dj/dj-desk.js';

const packagedCommand = '/Applications/LVX in Radio.app/Contents/Resources/dj-llm/llama-server';
// What v0.2.0 saved: python3 -m mlx_lm.server, or its bundled MLX launcher.
const legacyRuntime = { command: 'python3', args: ['-m', 'mlx_lm.server'] };
const oldBundled = '/X/dj-llm/bin/mlx_lm.server';

for (const [label, bundledCommand] of [['packaged', packagedCommand], ['vendor', VENDOR_DJ_LLM_COMMAND]]) {
  test(`DJ runtime uses the ${label} llama-server without extra arguments`, () => {
    assert.deepEqual(resolveDjRuntime({ env: {}, bundledCommand }), { command: bundledCommand, args: [], port: 8765 });
  });
}

test('DJ runtime environment command and port override saved and bundled settings', () => {
  const saved = { command: 'llama-server', args: ['--ctx-size', '2048'], port: 9000 };
  assert.deepEqual(resolveDjRuntime({
    env: { LVX_DJ_LLM_COMMAND: '/opt/homebrew/bin/llama-server', LVX_DJ_LLM_PORT: '9876' },
    bundledCommand: packagedCommand, saved,
  }), { command: '/opt/homebrew/bin/llama-server', args: [], port: 9876 });
  assert.deepEqual(saved, { command: 'llama-server', args: ['--ctx-size', '2048'], port: 9000 });
});

for (const saved of [
  { ...legacyRuntime, port: 9010 },
  { command: 'python3', port: 9010 },
  { command: oldBundled, args: [], port: 9010 },
  { command: '/X/dj-llm/llama-server', args: [], port: 9010 },
  { command: 'llama-server', args: [], port: 9010 },
]) {
  test(`saved old runtime ${saved.command} does not shadow the current bundle`, () => {
    assert.deepEqual(resolveDjRuntime({ env: {}, bundledCommand: packagedCommand, saved }), {
      command: packagedCommand, args: [], port: 9010,
    });
  });
}

test('DJ runtime preserves an explicitly configured custom server and its arguments', () => {
  const saved = { command: 'llama-server', args: ['--ctx-size', '2048'], port: 9000 };
  const resolved = resolveDjRuntime({ env: {}, bundledCommand: packagedCommand, saved });
  assert.deepEqual(resolved, saved);
  resolved.args.push('--verbose');
  assert.deepEqual(saved.args, ['--ctx-size', '2048'], 'resolution does not lend out the persisted argument array');
  assert.deepEqual(resolveDjRuntime({ env: { LVX_DJ_LLM_PORT: '9876' }, bundledCommand: packagedCommand, saved }), {
    ...saved, port: 9876,
  });
});

test('a custom Python command with different arguments remains an explicit choice', () => {
  const saved = { command: 'python3', args: ['-m', 'my_writer.server'], port: 9001 };
  assert.deepEqual(resolveDjRuntime({ env: {}, bundledCommand: packagedCommand, saved }), saved);
});

test('DJ runtime falls back to llama-server from PATH when no bundle or custom choice exists', () => {
  assert.deepEqual(resolveDjRuntime({ env: {} }), { command: 'llama-server', args: [], port: 8765 });
  assert.deepEqual(resolveDjRuntime({ env: {}, saved: { command: oldBundled, args: [], port: 9010 } }), {
    command: 'llama-server', args: [], port: 9010,
  });
});

test('loadConfig accepts the packaged launcher override without requiring that path to exist', () => {
  assert.equal(loadConfig({}, { djLlmCommand: '/a' }).djLlmCommand, '/a');
  assert.equal(loadConfig({}, { djLlmCommand: packagedCommand }).djLlmCommand, packagedCommand);
});

test('loadConfig discovers the vendor launcher only when it exists', () => {
  assert.equal(loadConfig({}).djLlmCommand, existsSync(VENDOR_DJ_LLM_COMMAND) ? VENDOR_DJ_LLM_COMMAND : null);
});

test('loading legacy DJ settings adopts the bundled runtime and preserves port and cadence', async (t) => {
  // DjDesk reads the real environment; isolate these two settings within this test worker.
  const keys = ['LVX_DJ_LLM_COMMAND', 'LVX_DJ_LLM_PORT'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  for (const runtime of [
    { ...legacyRuntime, port: 9010 },
    { command: oldBundled, args: [], port: 9011 },
  ]) {
    await t.test(runtime.command, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'lvx-dj-runtime-'));
      const setup = { snapshot: async () => ({ ready: true, status: 'ready' }) };
      const desk = new DjDesk({ dataDir: root, station: {}, engine: {}, modelSetup: setup, voiceSetup: setup, llmCommand: packagedCommand });
      t.after(async () => { await desk.close(); await rm(root, { recursive: true, force: true }); });
      await writeFile(join(root, 'dj-settings.json'), JSON.stringify({ version: 1, enabled: true, minSongs: 3, maxSongs: 4, runtime }));
      await desk.load();
      const settings = await desk.settings();
      assert.deepEqual(settings.runtime, { command: packagedCommand, args: [], port: runtime.port });
      assert.equal(settings.enabled, true);
      assert.equal(settings.minSongs, 3);
      assert.equal(settings.maxSongs, 4);
    });
  }
});
