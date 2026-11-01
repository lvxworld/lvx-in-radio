#!/usr/bin/env node
/** Puts the audio.cpp release inside vendor/, where the app build takes it from. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'v0.9.3';
const SHA256 = '70a84c2b61ce5ef99547a12affab9b0d40daf08666baf7da4f940d5c7b722819';
const URL = `https://github.com/0xShug0/audio.cpp/releases/download/${VERSION}/audio-${VERSION}-bin-macos-arm64-metal.tar.gz`;
const TARGET = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/audio.cpp');
const KEEP = ['audiocpp_server', 'LICENSE', 'model_specs'];

async function installedVersion() {
  try {
    return (await readFile(join(TARGET, 'VERSION'), 'utf8')).trim();
  } catch {
    return null;
  }
}

if ((await installedVersion()) === VERSION && existsSync(join(TARGET, 'audiocpp_server'))) {
  console.log(`audio.cpp ${VERSION} is already in place`);
  process.exit(0);
}

console.log(`Downloading audio.cpp ${VERSION}`);
const response = await fetch(URL);
if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== SHA256) throw new Error(`The download does not match the expected checksum: ${digest}`);

const work = await mkdtemp(join(tmpdir(), 'lvx-engine-'));
try {
  const file = join(work, 'engine.tar.gz');
  await writeFile(file, archive);
  const { status, stderr } = spawnSync('tar', ['xzf', file, '-C', work], { encoding: 'utf8' });
  if (status !== 0) throw new Error(`Could not extract the release: ${stderr}`);
  await rm(TARGET, { recursive: true, force: true });
  await mkdir(TARGET, { recursive: true });
  for (const name of KEEP) await cp(join(work, name), join(TARGET, name), { recursive: true });
  await writeFile(join(TARGET, 'VERSION'), `${VERSION}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(`audio.cpp ${VERSION} is in ${TARGET}`);
