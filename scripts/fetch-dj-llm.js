#!/usr/bin/env node
/** Puts the DJ script writer (llama.cpp's llama-server) inside vendor/, where the app build takes it from. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'b12329';
const SHA256 = 'b4d0176d274c576d1f912d6eede6ff67176b4e205af52fa6400b30f55d8f5446';
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${VERSION}/llama-${VERSION}-bin-macos-arm64.tar.gz`;
const TARGET = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/dj-llm');
// llama-server and the libraries it loads through @loader_path, under the names it asks for
// (copied, not symlinked, so the app bundle holds plain files).
const KEEP = [
  'llama-server', 'LICENSE', 'libllama-server-impl.dylib', 'libllama-common.0.dylib', 'libmtmd.0.dylib', 'libllama.0.dylib',
  'libggml.0.dylib', 'libggml-base.0.dylib', 'libggml-cpu.0.dylib', 'libggml-blas.0.dylib', 'libggml-metal.0.dylib', 'libggml-rpc.0.dylib',
];

async function installedVersion() {
  try { return (await readFile(join(TARGET, 'VERSION'), 'utf8')).trim(); } catch { return null; }
}

if ((await installedVersion()) === VERSION && existsSync(join(TARGET, 'llama-server'))) {
  console.log(`llama.cpp ${VERSION} is already in place`);
  process.exit(0);
}

console.log(`Downloading llama.cpp ${VERSION}`);
const response = await fetch(URL);
if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== SHA256) throw new Error(`The download does not match the expected checksum: ${digest}`);

const work = await mkdtemp(join(tmpdir(), 'lvx-dj-llm-'));
try {
  const file = join(work, 'llama.tar.gz');
  await writeFile(file, archive);
  const { status, stderr } = spawnSync('tar', ['xzf', file, '-C', work], { encoding: 'utf8' });
  if (status !== 0) throw new Error(`Could not extract the release: ${stderr}`);
  await rm(TARGET, { recursive: true, force: true });
  await mkdir(TARGET, { recursive: true });
  for (const name of KEEP) await copyFile(join(work, `llama-${VERSION}`, name), join(TARGET, name));
  const check = spawnSync(join(TARGET, 'llama-server'), ['--version'], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error(`llama-server does not run: ${check.stderr}`);
  await writeFile(join(TARGET, 'VERSION'), `${VERSION}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(`llama.cpp ${VERSION} is in ${TARGET}`);
