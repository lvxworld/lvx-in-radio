/** Keep the current DMG and its blockmap after a successful build. */
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const current = `${pkg.productName}-${pkg.version}-arm64.dmg`;
const dist = join(root, 'dist');
// Never remove an older usable build if the new one was not produced.
if (!(await stat(join(dist, current))).isFile()) throw new Error(`Current build is missing: ${current}`);
for (const file of await readdir(dist, { withFileTypes: true })) {
  if (!file.isFile() || !/^LVX(?: in)? Radio-.+-arm64\.dmg(?:\.blockmap)?$/.test(file.name)) continue;
  if (file.name === current || file.name === `${current}.blockmap`) continue;
  await rm(join(dist, file.name));
  console.log(`Removed old distribution: ${file.name}`);
}
