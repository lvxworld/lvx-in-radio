import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { basename } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const STOP_AFTER_MS = 60_000;
const STARTUP_MS = 60_000;

// The KV cache follows the context size; the writer prompt and its line fit well inside 8k tokens
// (the model advertises 262k, which would reserve memory for nothing).
const CONTEXT_TOKENS = 8192;

/** Small owner for the local llama-server process that writes DJ lines. */
export class DjLlm {
  #command; #args; #port; #modelPath; #log; #record; #child = null; #starting = null; #idle = null; #closed = false; #ready = false;
  constructor({ command = 'llama-server', args = [], port = 8765, modelPath, recordPath, log = () => {} } = {}) {
    this.#command = command; this.#args = args; this.#port = port; this.#modelPath = modelPath; this.#record = recordPath; this.#log = log;
  }
  get port() { return this.#port; }
  isWarm() { return Boolean(this.#ready && this.#child && this.#child.exitCode === null && this.#child.signalCode === null); }
  async configure({ command = this.#command, args = this.#args, port = this.#port } = {}) {
    if (this.#child) await this.stop();
    if (typeof command !== 'string' || !command.trim() || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('Invalid DJ LLM command');
    if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535) throw new TypeError('Invalid DJ LLM port');
    this.#command = command; this.#args = [...args]; this.#port = Number(port);
  }
  async #reapOrphan() {
    if (!this.#record) return;
    let record;
    try { record = JSON.parse(await readFile(this.#record, 'utf8')); } catch { return; }
    await rm(this.#record, { force: true });
    if (!Number.isInteger(record.pid) || record.port !== this.#port || record.model !== this.#modelPath) return;
    let args = '';
    try { args = execFileSync('ps', ['-o', 'args=', '-p', String(record.pid)], { encoding: 'utf8' }).trim(); } catch { return; }
    const command = basename(this.#command);
    if (!args || !args.includes(command) || !args.includes(`--port ${this.#port}`) || !args.includes(`--model ${this.#modelPath}`)) return;
    try { process.kill(record.pid, 'SIGTERM'); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { process.kill(record.pid, 0); process.kill(record.pid, 'SIGKILL'); } catch {}
  }
  async #start() {
    if (this.#closed) throw new Error('DJ writer is closing');
    if (this.#child) return;
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      await this.#reapOrphan();
      let occupied = false;
      try { const response = await fetch(`http://127.0.0.1:${this.#port}/health`, { signal: AbortSignal.timeout(500) }); occupied = response.ok; } catch {}
      if (occupied) throw new Error(`DJ LLM port ${this.#port} is already serving another process`);
      const args = [...this.#args, '--model', this.#modelPath, '--host', '127.0.0.1', '--port', String(this.#port), '--jinja', '--chat-template-kwargs', '{"enable_thinking":false}', '--parallel', '1', '--ctx-size', String(CONTEXT_TOKENS), '--no-webui'];
      const child = spawn(this.#command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => this.#log(String(chunk).trimEnd()));
      child.stderr.on('data', (chunk) => this.#log(String(chunk).trimEnd()));
      child.once('error', (error) => this.#log(`DJ writer process error: ${error.message}`));
      this.#child = child;
      if (this.#record && child.pid) await writeFile(this.#record, JSON.stringify({ pid: child.pid, port: this.#port, model: this.#modelPath, command: this.#command }));
      child.once('exit', async () => {
        if (this.#child === child) { this.#child = null; this.#ready = false; }
        if (this.#record) {
          try { const record = JSON.parse(await readFile(this.#record, 'utf8')); if (record.pid === child.pid) await rm(this.#record, { force: true }); } catch {}
        }
      });
      const until = Date.now() + STARTUP_MS;
      while (Date.now() < until) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`DJ LLM exited during startup (${child.exitCode ?? child.signalCode})`);
        try { const response = await fetch(`http://127.0.0.1:${this.#port}/health`, { signal: AbortSignal.timeout(500) }); if (response.ok) { this.#ready = true; return; } } catch {}
        await delay(250);
      }
      await this.stop();
      throw new Error('DJ LLM startup timed out');
    })().finally(() => { this.#starting = null; });
    return this.#starting;
  }
  async complete({ system, prompt, maxTokens = 150, signal }) {
    clearTimeout(this.#idle); this.#idle = null;
    await this.#start();
    try {
      const response = await fetch(`http://127.0.0.1:${this.#port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
        body: JSON.stringify({ model: this.#modelPath, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], temperature: 0.6, max_tokens: maxTokens, stream: false, chat_template_kwargs: { enable_thinking: false } }),
      });
      if (!response.ok) throw new Error(`DJ LLM HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`);
      const body = await response.json();
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('DJ LLM returned no message text');
      return text;
    } finally {
      this.#idle = setTimeout(() => { void this.stop(); }, STOP_AFTER_MS);
      this.#idle.unref?.();
    }
  }
  async stop() {
    this.#ready = false;
    clearTimeout(this.#idle); this.#idle = null;
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); }
    }
    if (this.#record) await rm(this.#record, { force: true });
  }
  async close() { this.#closed = true; await this.stop(); }
}
