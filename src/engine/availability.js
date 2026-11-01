import { access, constants, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const SIDECARS = [
  'sidecars/yue2-generation-config.json',
  'sidecars/yue2-model-config.json',
  'sidecars/yue2-qwen.tiktoken',
  'sidecars/yue2-vae-config.json',
];

/** Exact sizes, so a file cut short by an interrupted copy does not count as present. */
const KNOWN_SIZES = { 'yue2-3b-q8_0.gguf': 4264195616, 'yue2-vae-f16.gguf': 265218656 };

export class ModelMissingError extends Error {
  status = 409;

  constructor() {
    super('Your own stations need the music model');
  }
}

async function isComplete(path, name) {
  try {
    const file = await stat(path);
    return file.isFile() && (KNOWN_SIZES[name] === undefined ? file.size > 0 : file.size === KNOWN_SIZES[name]);
  } catch {
    return false;
  }
}

async function canRun(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** What generation needs, checked on disk each time: the model can arrive while running. */
export async function engineAvailability({ binary, modelDir, modelFile, vaeFile }) {
  const files = [modelFile, vaeFile, ...SIDECARS];
  const present = await Promise.all(files.map((name) => isComplete(join(modelDir, name), name)));
  const missing = files.filter((_, index) => !present[index]);
  if (!(await canRun(binary))) missing.push(basename(binary));
  return { ready: missing.length === 0, missing };
}
