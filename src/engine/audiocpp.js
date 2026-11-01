import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { availableParallelism } from 'node:os';
import { basename, join } from 'node:path';

const MODEL_ID = 'yue2';
const STARTUP_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const PROCESS_RECORD = 'engine-process.json';

function processName(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'comm=', '-p', String(pid)], (error, output) => resolve(error ? '' : basename(output.trim())));
  });
}

/**
 * Stops an engine left running by a crash. The id is checked against the program
 * name first, because the system may have given it to something else since.
 */
export async function stopStaleEngine(dataDir) {
  const path = join(dataDir, PROCESS_RECORD);
  let pid;
  try {
    ({ pid } = JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return false;
  }
  await rm(path, { force: true });
  if (!Number.isInteger(pid) || (await processName(pid)) !== 'audiocpp_server') return false;
  process.kill(pid, 'SIGTERM');
  return true;
}

export class EngineAbortedError extends Error {
  constructor() {
    super('Generation was aborted');
    this.name = 'EngineAbortedError';
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * JSON request without a response deadline. Generation sends no headers until
 * the song is finished, which can outlast the default timeouts of `fetch`.
 */
function requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`audio.cpp error ${response.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('audio.cpp returned an invalid response'));
          }
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

function isHealthy(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1_000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Owns one audio.cpp server process. The process starts on first use, keeps the
 * model loaded between songs, and is the only way to stop a running generation
 * because audio.cpp has no request cancellation.
 */
export class AudioCppEngine {
  #config;
  #process = null;
  #url = null;
  #starting = null;
  #aborted = false;
  #launchVersion = 0;

  constructor(config) {
    this.#config = config;
  }

  async #launch(version) {
    const { binary, modelDir, modelFile, vaeFile, modelSpecs, dataDir } = this.#config;
    await mkdir(dataDir, { recursive: true });
    const port = await freePort();
    const configPath = join(dataDir, 'engine.json');
    await writeFile(
      configPath,
      JSON.stringify({
        host: '127.0.0.1',
        port,
        backend: 'metal',
        device: 0,
        threads: Math.min(availableParallelism(), 8),
        lazy_load: true,
        model_spec_override: modelSpecs,
        models: [
          {
            id: MODEL_ID,
            family: 'yue2',
            task: 'gen',
            mode: 'offline',
            path: modelDir,
            session_options: { 'yue2.model_gguf': modelFile, 'yue2.vae_gguf': vaeFile },
          },
        ],
      }),
    );

    if (version !== this.#launchVersion) throw new EngineAbortedError();
    const log = createWriteStream(join(dataDir, 'engine.log'), { flags: 'a' });
    const child = spawn(binary, ['--config', configPath, '--no-ui', '--busy-timeout-ms', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = join(dataDir, PROCESS_RECORD);
    child.stdout.pipe(log);
    child.stderr.pipe(log);

    const url = `http://127.0.0.1:${port}`;
    let failure = null;
    child.once('error', (error) => {
      failure = error;
      log.end();
      if (this.#process === child) this.#process = null;
    });
    child.once('exit', () => {
      log.end();
      rm(record, { force: true }).catch(() => {});
      if (this.#process === child) {
        this.#process = null;
        this.#url = null;
      }
    });
    this.#process = child;
    if (child.pid) await writeFile(record, JSON.stringify({ pid: child.pid }));

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (version !== this.#launchVersion) throw new EngineAbortedError();
      if (failure || child.exitCode !== null) {
        throw new Error(`audio.cpp failed to start: ${failure?.message ?? `exit ${child.exitCode}`}`);
      }
      if (await isHealthy(`${url}/health`) && version === this.#launchVersion && this.#process === child) {
        this.#url = url;
        return;
      }
      await delay(100);
    }
    await this.stop();
    throw new Error('audio.cpp startup timed out');
  }

  async #ensureStarted() {
    if (this.#url) return;
    this.#starting ??= this.#launch(this.#launchVersion).finally(() => {
      this.#starting = null;
    });
    await this.#starting;
  }

  /** Runs one YuE2 request and resolves with the raw engine response. */
  async run(request) {
    this.#aborted = false;
    await this.#ensureStarted();
    if (this.#aborted) throw new EngineAbortedError();
    try {
      return await requestJson(`${this.#url}/v1/tasks/run`, { model: MODEL_ID, request });
    } catch (error) {
      throw this.#aborted ? new EngineAbortedError() : error;
    }
  }

  /** Cancels the running request. The next `run` reloads the model. */
  async abort() {
    this.#aborted = true;
    await this.stop();
  }

  async stop() {
    this.#launchVersion += 1;
    const child = this.#process;
    if (!child) return;
    this.#process = null;
    this.#url = null;
    await new Promise((resolve) => {
      const forceKill = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
