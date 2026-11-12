#!/usr/bin/env node
/** Puts the DJ script writer (bundled Python + mlx_lm.server) inside vendor/, where the app build takes it from. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, 'build-dj-llm.sh');
const TARGET = resolve(HERE, '../vendor/dj-llm');
// One source of truth: the version the build script writes into vendor/dj-llm/VERSION.
const VERSION = readFileSync(BUILD, 'utf8').match(/^BUNDLE_VERSION="([^"]+)"$/m)?.[1];
if (!VERSION) throw new Error('build-dj-llm.sh has no BUNDLE_VERSION');

// Ready for a prebuilt release archive later; disabled until one is published.
const ARCHIVE_URL = null; // e.g. https://github.com/lvxworld/lvx-in-radio/releases/download/dj-llm-1/dj-llm-macos-arm64.tar.gz
const ARCHIVE_SHA256 = null;

function installedVersion() {
  try { return readFileSync(join(TARGET, 'VERSION'), 'utf8').trim(); } catch { return null; }
}

if (installedVersion() === VERSION && existsSync(join(TARGET, 'bin/mlx_lm.server')) && existsSync(join(TARGET, 'python/bin/python3.12'))) {
  console.log(`DJ writer ${VERSION} is already in place`);
  process.exit(0);
}
if (ARCHIVE_URL && ARCHIVE_SHA256) throw new Error('Prebuilt DJ writer archives are not wired yet');

console.log(`Building DJ writer ${VERSION}`);
const { status } = spawnSync('sh', [BUILD], { stdio: 'inherit' });
if (status !== 0) throw new Error(`build-dj-llm.sh failed (${status})`);
if (installedVersion() !== VERSION) throw new Error('The DJ writer build did not write the expected VERSION');
