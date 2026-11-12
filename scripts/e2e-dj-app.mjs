#!/usr/bin/env node
// Real end-to-end DJ gate on the PACKAGED app (npm run e2e:dj). Not a unit test: it launches the built .app on an isolated
// copy of a data dir, drives the real renderer over CDP (dial, Play), and requires the DJ voice to actually play over a song end.
// Usage: node scripts/e2e-dj-app.mjs [--scenario A|B1|B2|C0|C1|switch|off|nodj|all] [--source <data dir>] [--keep]
import { spawn, execFileSync } from 'node:child_process';
import { rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const WORK = join(homedir(), '.lvx-dev');
const SOURCE = opt('source', join(homedir(), 'Library/Application Support/LVX Radio'));
const DATA = join(WORK, 'e2e-data'), APPDIR = join(WORK, 'e2e-app');
const BUILT = join(ROOT, 'dist/mac-arm64/LVX in Radio.app');
const PORT = 9333;
const SCENARIOS = (opt('scenario', 'all') === 'all' ? ['A', 'B1', 'B2', 'C0', 'C1', 'switch', 'off', 'nodj'] : opt('scenario').split(','));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

const HOOK = `(()=>{if(window.__e2e)return;window.__e2e={audio:[],fetches:[]};
const of=window.fetch;window.fetch=function(u,o){const s=String(u);if(/\\/api\\/(playback|dj)/.test(s)){const e={t:Date.now(),u:s,m:o&&o.method,b:o&&o.body&&String(o.body).slice(0,200)};window.__e2e.fetches.push(e);if(window.__e2e.fetches.length>300)window.__e2e.fetches.shift();return of.apply(this,arguments).then(r=>{e.status=r.status;return r})}return of.apply(this,arguments)};
window.__players=[];const op=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){if(!window.__players.includes(this))window.__players.push(this);window.__e2e.audio.push({t:Date.now(),src:(this.currentSrc||this.src||'').slice(-100)});return op.apply(this,arguments)};
var __r;Object.defineProperty(window,'LvxDjTalkOver',{configurable:true,set(v){__r=v},get(){return __r&&class extends __r{constructor(...a){super(...a);window.__dj=this}}}})})();`;

async function setup() {
  if (!existsSync(BUILT)) throw new Error(`Build the app first: ${BUILT} is missing (npm run dist).`);
  try { execFileSync('pkill', ['-f', 'e2e-app/LVX in Radio']); } catch { /* none running */ }
  await sleep(1500);
  await rm(DATA, { recursive: true, force: true }); await rm(APPDIR, { recursive: true, force: true }); await mkdir(APPDIR, { recursive: true });
  log('copying data', SOURCE, '->', DATA);
  execFileSync('cp', ['-R', SOURCE, DATA]);
  for (const f of ['engine.json', 'engine.pid']) await rm(join(DATA, f), { force: true });
  await rm(join(DATA, 'dj.log'), { force: true });
  execFileSync('ditto', [BUILT, join(APPDIR, 'LVX in Radio.app')]); // ditto keeps the framework symlinks; fs.cp breaks the bundle
  const proc = spawn(join(APPDIR, 'LVX in Radio.app/Contents/MacOS/LVX in Radio'), [`--remote-debugging-port=${PORT}`], { env: { ...process.env, LVX_DATA_DIR: DATA }, stdio: ['ignore', openSync(join(WORK, 'e2e-app.log'), 'w'), openSync(join(WORK, 'e2e-app.log'), 'a')], detached: true });
  proc.unref();
  return proc;
}

async function connect() {
  let page;
  for (let i = 0; i < 60 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page' && /127\.0\.0\.1:\d+/.test(t.url)); } catch { /* starting */ } if (!page) await sleep(1000); }
  if (!page) throw new Error('The app did not open a page');
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map(); const consoleErrors = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(String(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 300)); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => { const r = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), sleep(20000).then(() => { throw new Error('ev timeout ' + expression.slice(0, 80)); })]); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  await send('Page.reload', { ignoreCache: true }); await sleep(6000);
  const key = async (k) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: { ArrowLeft: 37, ArrowRight: 39 }[k] ?? 0 }); };
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); await mkdir(join(WORK, 'ux-walkthrough'), { recursive: true }); await writeFile(join(WORK, 'ux-walkthrough', `22-e2e-${name}.png`), Buffer.from(r.result.data, 'base64')); };
  return { ev, key, shot, consoleErrors, close: () => ws.close() };
}

const snapshot = (c) => c.ev(`fetch('/api/events').then(async r=>{const rd=r.body.getReader();let t='';while(!t.includes('\\n\\n')){const {value}=await rd.read();t+=new TextDecoder().decode(value)};rd.cancel();return JSON.parse(t.slice(t.indexOf('data:')+5,t.indexOf('\\n\\n')))})`);
const post = (c, body) => c.ev(`fetch('/api/dj/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})}).then(async r=>({status:r.status,body:await r.json().catch(()=>null)}))`);
const djLog = async () => (existsSync(join(DATA, 'dj.log')) ? (await readFile(join(DATA, 'dj.log'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) : []);

async function tune(c, name) {
  await c.ev(`document.querySelector('.fm-band')?.focus()`);
  const txt = () => c.ev(`document.querySelector('.fm-band')?.getAttribute('aria-valuetext')`);
  for (let i = 0; i < 40; i++) { if (new RegExp(name, 'i').test((await txt()) || '')) break; await c.key(i < 20 ? 'ArrowRight' : 'ArrowLeft'); await sleep(450); }
  const at = await txt(); if (!new RegExp(name, 'i').test(at || '')) throw new Error(`Could not tune ${name}; dial says ${at}`);
  await sleep(3000);
  const air = () => c.ev(`document.querySelector('.air-toolbar-end span')?.innerText.trim()`);
  if (/PAUSED/i.test(await air())) { await c.ev(`document.querySelector('.transport-buttons button')?.click()`); await sleep(2500); }
  if (!/ON AIR/i.test(await air())) throw new Error('Play did not start: ' + (await air()));
  return at;
}

const probe = (c) => c.ev(`(()=>{const d=window.__dj;const voice=(window.__players||[]).find(p=>/dj-audio|audio\\/[0-9a-f]{64}/.test(p.currentSrc||'')&&!p.paused);const song=(window.__players||[]).find(p=>!p.paused&&p!==voice&&p.duration>20);return JSON.stringify({phase:d?.phase,plan:!!d?.plan,music:d?+d.musicIn.gain.value.toFixed(2):null,voice:!!voice,voiceSrc:voice&&voice.currentSrc.slice(-70),t:song&&+song.currentTime.toFixed(1),dur:song&&+song.duration.toFixed(1),state:document.querySelector('.dj-mic-detail em')?.textContent,mic:!!document.querySelector('.dj-mic-mini')})})()`).then(JSON.parse);

/** Waits until the DJ's voice is playing over a song and the music is ducked. Returns the evidence or throws with the last state. */
async function expectVoice(c, label, { timeoutSec = 600, djId } = {}) {
  const before = (await djLog()).length; const t0 = Date.now(); let last, ducked = Infinity, spoke = null; const ignored = new Set();
  while (Date.now() - t0 < timeoutSec * 1000) {
    await sleep(1000);
    try { last = await probe(c); } catch (error) { log('probe failed:', error.message.slice(0, 60)); continue; }
    if (last.voice) {
      // Only the clip of the radio's own slot counts: a preview (someone pressing Hear) or any other audio must not fake a pass.
      const line = (await snapshot(c)).dj?.lastLine;
      const isSlotClip = !!line?.audioId && String(last.voiceSrc || '').endsWith(line.audioId);
      if (!isSlotClip) { if (!ignored.has(last.voiceSrc)) { ignored.add(last.voiceSrc); log('ignoring a voice that is not the slot clip:', last.voiceSrc); } }
      else { ducked = Math.min(ducked, last.music ?? 1); if (!spoke) { spoke = { ...last, audioId: line.audioId }; await c.shot(label.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-speaking').catch(() => {}); } }
    }
    if (spoke && !last.voice && last.phase !== 'speaking') break;
  }
  const lines = (await djLog()).slice(before);
  const snap = await snapshot(c);
  const dangling = snap.dj?.introduction?.state === 'armed' && !last?.voice && spoke == null;
  const ok = !!spoke && spoke.t != null /* the song kept playing under the voice */ && ducked < 0.9 && lines.some((l) => l.mode === 'slot' && l.status === 'ready' && (!djId || l.djId === djId));
  log(ok ? 'PASS' : 'FAIL', label, JSON.stringify({ spoke, minMusicGain: ducked, finalState: last, intro: snap.dj?.introduction, newLog: lines.map((l) => ({ djId: l.djId, status: l.status, source: l.source, reason: l.reason })) }));
  return ok;
}
async function expectSilence(c, label, seconds) {
  const t0 = Date.now(); let voiced = false;
  const before = (await djLog()).length;
  while (Date.now() - t0 < seconds * 1000) { await sleep(2000); const p = await probe(c); if (p.voice || p.phase === 'speaking') voiced = true; }
  const snap = await snapshot(c); const armed = snap.dj?.introduction?.state === 'armed';
  const made = (await djLog()).slice(before).filter((l) => l.mode === 'slot' && l.status === 'ready');
  const ok = !voiced && !armed && !made.length;
  log(ok ? 'PASS' : 'FAIL', label, JSON.stringify({ voiced, armed, linesMade: made.length }));
  return ok;
}

async function main() {
  await setup(); const c = await connect();
  const results = {};
  try {
    const dj = await c.ev(`fetch('/api/dj').then(r=>r.json())`);
    if (!dj.ready) throw new Error('DJ models are not ready in the data copy: ' + JSON.stringify(dj.missing));
    await post(c, { enabled: true });
    for (const s of SCENARIOS) {
      try {
        if (s === 'A') { await post(c, { minSongs: 1, maxSongs: 1 }); await post(c, { stationId: 'lux-lofi', djId: 'ryan' }); log('tuned', await tune(c, 'LVX Lofi')); results[s] = await expectVoice(c, 'A lux-lofi Ryan 1-1', { djId: 'ryan' }); }
        if (s === 'B1') { await post(c, { minSongs: 1, maxSongs: 1 }); await post(c, { stationId: 'lux-rock', djId: 'default' }); log('tuned', await tune(c, 'LVX Rock')); results[s] = await expectVoice(c, 'B1 LVX Rock default 1-1', { djId: 'dylan' }); }
        if (s === 'B2') { await post(c, { minSongs: 2, maxSongs: 4 }); await post(c, { stationId: 'lux-pop', djId: 'default' }); log('tuned', await tune(c, 'LVX Pop')); results[s] = await expectVoice(c, 'B2 LVX Pop default 2-4', { djId: 'aiden', timeoutSec: 900 }); }
        if (s === 'C0') { await post(c, { minSongs: 1, maxSongs: 1 }); const snap = await snapshot(c); const st = snap.stations.find((x) => !x.lux && !x.live && x.songCount >= 3 && x.dj); if (!st) throw new Error('no listener station with a library'); await c.ev(`fetch('/api/generation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})}).catch(()=>0)`); log('tuned', await tune(c, st.name)); results[s] = await expectVoice(c, `C0 listener ${st.name} generation off`, {}); }
        if (s === 'C1') { await post(c, { minSongs: 1, maxSongs: 1 }); const snap = await snapshot(c); const st = snap.stations.find((x) => !x.lux && !x.live && x.songCount >= 3 && x.dj); if (!st) throw new Error('no listener station with a library'); await c.ev(`fetch('/api/generation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true})}).then(r=>r.status)`); log('tuned', await tune(c, st.name)); await c.ev(`fetch('/api/generation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true})}).then(r=>r.status)`); let genSeen = false; const watch = setInterval(async () => { try { const g = (await snapshot(c)).generation; if (g?.enabled && (g.active || g.waitingFor)) genSeen = true; } catch { /* next tick */ } }, 5000); try { results[s] = await expectVoice(c, `C1 listener ${st.name} generation ON`, { timeoutSec: 900 }); } finally { clearInterval(watch); } log('C1 generation seen active/waiting:', genSeen); await c.ev(`fetch('/api/generation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})}).then(r=>r.status)`); }
        if (s === 'switch') { await post(c, { minSongs: 1, maxSongs: 1 }); await post(c, { stationId: 'lux-lofi', djId: 'ryan' }); log('tuned', await tune(c, 'LVX Lofi')); const a = await expectVoice(c, 'switch: first break Ryan', { djId: 'ryan' }); await post(c, { stationId: 'lux-lofi', djId: 'vivian' }); results[s] = a && await expectVoice(c, 'switch: next break Vivian', { djId: 'vivian' }); }
        if (s === 'off') { await post(c, { enabled: false }); results[s] = await expectSilence(c, 'DJs off is silent', 240); await post(c, { enabled: true }); }
        if (s === 'nodj') { await post(c, { stationId: 'lux-lofi', djId: null }); results[s] = await expectSilence(c, 'No DJ is silent', 240); }
      } catch (error) { results[s] = false; log('FAIL', s, error.message); }
    }
    log('console exceptions', JSON.stringify(c.consoleErrors.slice(0, 5)));
  } finally { c.close(); try { execFileSync('pkill', ['-f', 'e2e-app/LVX in Radio']); } catch { /* gone */ } }
  log('RESULTS', JSON.stringify(results));
  process.exit(Object.values(results).every(Boolean) && Object.keys(results).length ? 0 : 1);
}
main().catch((error) => { console.error(error); process.exit(2); });
