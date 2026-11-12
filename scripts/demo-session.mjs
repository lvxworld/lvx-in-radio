// Isolated demo ownership for smoke/real-voice checks; never targets the owner's server.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function startDemoSession({ prefix = 'demo-smoke-', noGpu = true, slotEverySong = true, env = {} } = {}) {
  const parent = join(homedir(), '.lvx-dev');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, prefix));
  let child, closing;
  const handlers = new Map();
  const close = () => closing ??= (async () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    await rm(dir, { recursive: true, force: true });
  })();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => { void close().finally(() => process.exit(1)); };
    handlers.set(signal, handler); process.once(signal, handler);
  }
  try {
    const writerPort = env.DJ_LLM_PORT ?? await new Promise((resolve, reject) => {
      const probe = createServer(); probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(String(port))); });
    });
    child = spawn('bash', [fileURLToPath(new URL('./run-demo.sh', import.meta.url))], {
      env: { ...process.env, ...env, DJ_LLM_PORT: writerPort, DEMO_DATA_DIR: dir, DEMO_FRESH: '0', DEMO_NO_GPU: noGpu ? '1' : '0', DJ_DEMO_SLOT: slotEverySong ? '1' : '0', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Demo startup timed out: ${output.slice(-2000)}`)), 120_000);
      const failed = error => { clearTimeout(timer); reject(error); };
      child.once('error', failed);
      child.once('exit', code => failed(new Error(`Demo exited (${code}): ${output.slice(-2000)}`)));
      const collect = chunk => {
        output = (output + chunk).slice(-8000);
        const ready = /LVX demo: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (ready) { clearTimeout(timer); resolve(ready[1]); }
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
    });
    return { dir, address, close };
  } catch (error) { await close(); throw error; }
}
