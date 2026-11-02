import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { LuxCatalog, LUX_STATIONS } from '../src/radio/lux-catalog.js';
import { LiveRadio, isMp3Type, parseLiveCatalog } from '../src/radio/live-radio.js';
import { catalogAddress, mediaAddress, publicIPv4, remoteJson, MAX_CATALOG_BYTES } from '../src/radio/remote-http.js';
import { Library } from '../src/radio/library.js';
import { StationStore } from '../src/radio/stations.js';
import { RadioStation } from '../src/radio/station.js';
import { EngineAbortedError } from '../src/engine/audiocpp.js';
import { createApp, listen } from '../src/server/app.js';

const base = 'http://127.0.0.1:8790/catalog.json';
const settings = { enabled:true, url:base, refreshMinutes:0 };
const track = (id, url = `pop/${id}.mp3`) => ({ id, title:id, url, durationSec:120 });
const entry = (id, tracks = [track(id + '-a'),track(id + '-b')]) => ({ id, name:id, genre:'Pop', tracks });
const directory = (...stations) => ({ schemaVersion:1, stations });

async function fixture(t, fetchCatalog = async () => ({ data:directory(entry('lux-pop'),entry('lux-metal')) })) {
  const root = await mkdtemp(join(tmpdir(), 'lvx-live-'));
  const bundled = join(root,'bundle'); await mkdir(bundled);
  const audio = Buffer.from('ID3 included fixture');
  const songs = ['lux-pop','lux-rock'].map(station => ({ id:`seed-${station}`, station, title:`Included ${station}`, file:`${station}.mp3`, durationSec:120, sizeBytes:audio.length, sha256:createHash('sha256').update(audio).digest('hex') }));
  for (const song of songs) await writeFile(join(bundled,song.file),audio);
  await writeFile(join(bundled,'manifest.json'),JSON.stringify({version:1,songs}));
  const catalog = new LuxCatalog({bundledDir:bundled,downloadDir:join(root,'downloads'),statePath:join(root,'lux-state.json')}); await catalog.load();
  const stations = new StationStore(join(root,'stations.json')); await stations.load();
  const library = new Library(join(root,'library')); await library.load();
  const engine = { requests:[], pending:[], aborts:0, run(request) { this.requests.push(request);return new Promise((resolve,reject)=>this.pending.push({resolve,reject})); }, async abort() { this.aborts++;for(const job of this.pending.splice(0))job.reject(new EngineAbortedError()); }, async stop() {} };
  const station = new RadioStation({engine,library,stations,catalog});
  const path = join(root,'live-radio.json');
  const live = new LiveRadio({path,catalog,stations,fetchCatalog,onCatalogChange:change=>station.catalogChanged(change)}); await live.load();
  t.after(async()=>{await live.close();await station.close();await rm(root,{recursive:true,force:true});});
  return {root,path,live,catalog,stations,station,engine,bundled,audio};
}

async function enable(live, value = settings) { await live.configure(value);await live.refresh(); }
async function server(t, handler) {
  const value = http.createServer(handler);const address=await listen(value);
  t.after(()=>{value.closeAllConnections();value.close();});return address;
}

test('a three-station catalog uses the folder format and ignores unknown fields',()=>{
  const parsed=parseLiveCatalog({...directory(entry('pop'),entry('metal'),entry('ambient')),future:{anything:true}},base);
  assert.equal(parsed.stations.length,3);assert.equal(parsed.stations[0].tracks[0].url,'http://127.0.0.1:8790/pop/pop-a.mp3');
});

test('invalid versions, duplicate station/track IDs and unsafe URLs reject the entire update',()=>{
  for(const value of [{schemaVersion:99,stations:[]},directory(entry('pop'),entry('pop')),directory(entry('pop',[track('a'),track('a')])),directory(entry('pop',[track('a','file:///etc/passwd')])),directory(entry('pop',[track('a','https://other.example/a.mp3')])),directory({...entry('pop'),enabled:'yes'})])assert.throws(()=>parseLiveCatalog(value,base));
  assert.throws(()=>catalogAddress('http://example.com/catalog.json'));
  assert.throws(()=>catalogAddress('https://user:secret@example.com/catalog.json'));
  assert.throws(()=>mediaAddress('http://169.254.169.254/latest',base));
  for(const ip of ['127.0.0.1','10.1.2.3','192.168.1.1','169.254.169.254','100.64.0.1','192.0.2.1','203.0.113.3','224.0.0.1','0.0.0.0'])assert.equal(publicIPv4(ip),false,ip);
  assert.equal(publicIPv4('1.1.1.1'),true);
});

test('first startup and the local-only choice make no catalog requests',async t=>{
  let calls=0;const {live,catalog}=await fixture(t,async()=>{calls++;return {data:directory()};});
  live.start();await live.refresh();assert.equal(calls,0);assert.equal(live.snapshot().choiceMade,false);
  await live.configure({enabled:false,url:'',refreshMinutes:30});await live.refresh();assert.equal(calls,0);assert.equal(catalog.stations().length,4);
});

test('discovery updates metadata and tracks without changing the playing source or position',async t=>{
  let data=directory(entry('lux-pop'),entry('lux-metal'));
  const f=await fixture(t,async()=>({data}));await enable(f.live);
  await f.station.tune(null,{stationId:'lux-pop',fromLibrary:true});
  const first=f.station.snapshot().tracks[0];await f.station.setPlayback({trackId:first.id,positionSec:37,playing:true});
  data=directory({...entry('lux-pop',[track('lux-pop-a','pop/changed.mp3'),track('new-track')]),name:'Updated Pop'},entry('lux-metal'),entry('lux-ambient'));
  await f.live.refresh();const snapshot=f.station.snapshot();
  assert.equal(snapshot.station.name,'Updated Pop');assert.equal(snapshot.tracks[0].id,first.id);assert.equal(snapshot.tracks[0].mediaKey,first.mediaKey);
  assert.equal(f.station.audioSource(first.id,first.mediaKey).url,first.remoteUrl);
  assert.ok(snapshot.tracks.some(song=>song.title==='new-track'));assert.ok(snapshot.stations.some(station=>station.id==='lux-ambient'));assert.equal(f.live.snapshot().added,1);
  assert.equal(f.engine.requests.length,0);
});

test('disabled or removed live stations leave the dial but the active song can finish',async t=>{
  let data=directory(entry('lux-metal'));const f=await fixture(t,async()=>({data}));await enable(f.live);
  await f.station.tune(null,{stationId:'lux-metal',fromLibrary:true});const current=f.station.snapshot().tracks[0];await f.station.setPlayback({trackId:current.id,positionSec:15,playing:true});
  data=directory({...entry('lux-metal'),enabled:false});await f.live.refresh();
  const snapshot=f.station.snapshot();assert.equal(snapshot.station.unavailable,true);assert.equal(snapshot.tracks.length,1);assert.equal(snapshot.tracks[0].id,current.id);assert.ok(!snapshot.stations.some(station=>station.id==='lux-metal'));
});

test('turning Live off restores included music without deleting files or feedback',async t=>{
  const f=await fixture(t);await enable(f.live);await f.station.tune(null,{stationId:'lux-pop',fromLibrary:true});
  const current=f.station.snapshot().tracks[0];await f.station.setPlayback({trackId:current.id,positionSec:3,playing:true});await f.station.setFeedback(current.id,'like');
  await f.live.configure({...settings,enabled:false});
  assert.equal(f.station.snapshot().station.live,false);assert.equal(f.station.snapshot().tracks[0].source,'library');
  assert.deepEqual(await readFile(join(f.bundled,'lux-pop.mp3')),f.audio);
  assert.equal(JSON.parse(await readFile(join(f.root,'lux-state.json'),'utf8')).songs[current.id].liked,true);
});

test('failed tracks advance to valid tracks and an entirely broken station stops',async t=>{
  const f=await fixture(t);await enable(f.live);await f.station.tune(null,{stationId:'lux-metal',fromLibrary:true});
  for(let i=0;i<2;i++){const current=f.station.snapshot().tracks[0];f.station.playbackFailed(current.id,current.mediaKey);}
  assert.equal(f.station.snapshot().tracks.length,0);assert.match(f.station.snapshot().error,/no playable songs/);
  await f.live.refresh();assert.equal(f.station.snapshot().tracks.length,2,'Explicit refresh permits retry');
});

test('an entirely broken live version of a bundled station falls back to local MP3s',async t=>{
  const f=await fixture(t);await enable(f.live);await f.station.tune(null,{stationId:'lux-pop',fromLibrary:true});
  for(let i=0;i<2;i++){const current=f.station.snapshot().tracks[0];f.station.playbackFailed(current.id,current.mediaKey);}
  assert.equal(f.station.snapshot().tracks[0].source,'library');assert.equal(f.station.snapshot().error,null);
});

test('cache restores live stations before the network and malformed updates preserve it',async t=>{
  let invalid=false;const f=await fixture(t,async()=>({data:invalid?{schemaVersion:99,stations:[]}:directory(entry('lux-metal'))}));await enable(f.live);
  const diskBefore=JSON.parse(await readFile(f.path,'utf8')).cache;
  invalid=true;await f.live.refresh();assert.equal(f.live.snapshot().status,'unavailable');
  assert.deepEqual(JSON.parse(await readFile(f.path,'utf8')).cache,diskBefore);
  let called=false;const restored=new LiveRadio({path:f.path,catalog:f.catalog,stations:f.stations,fetchCatalog:async()=>{called=true;throw new Error('offline');}});await restored.load();t.after(()=>restored.close());
  assert.equal(called,false);assert.equal(restored.snapshot().enabled,true);assert.ok(f.catalog.station('lux-metal'));
});

test('conditional requests honor ETag and HTTP 304 without parsing an empty body',async t=>{
  let requests=0;const address=await server(t,(req,res)=>{requests++;if(req.headers['if-none-match']==='"catalog-1"'){res.writeHead(304);res.end();return;}res.writeHead(200,{'Content-Type':'application/json',ETag:'"catalog-1"'});res.end(JSON.stringify(directory(entry('lux-metal'))));});
  const f=await fixture(t,remoteJson);await enable(f.live,{...settings,url:address+'/catalog.json'});await f.live.refresh();
  assert.equal(requests,2);assert.equal(f.live.snapshot().status,'ready');assert.ok(f.catalog.station('lux-metal'));
});

test('Last-Modified is used when ETag is unavailable',async t=>{
  let conditional;const date='Mon, 02 Nov 2026 10:00:00 GMT';
  const address=await server(t,(req,res)=>{conditional=req.headers['if-modified-since'];res.writeHead(200,{'Content-Type':'application/json','Last-Modified':date});res.end(JSON.stringify(directory()));});
  const f=await fixture(t,remoteJson);await enable(f.live,{...settings,url:address+'/catalog.json'});await f.live.refresh();assert.equal(conditional,date);
});

test('an actual timed-out catalog request fails gracefully and retains local stations',async t=>{
  const address=await server(t,()=>{});
  const f=await fixture(t,(url,options)=>remoteJson(url,{...options,signal:AbortSignal.any([options.signal,AbortSignal.timeout(25)])}));
  await enable(f.live,{...settings,url:address+'/catalog.json'});assert.equal(f.live.snapshot().status,'unavailable');assert.equal(f.catalog.stations().length,4);
});

test('duplicate refreshes share one request and switching stations cannot be undone by its response',async t=>{
  let release;let delayed=false;let count=0;
  const f=await fixture(t,async()=>{count++;return delayed?new Promise(resolve=>{release=resolve;}):{data:directory(entry('lux-pop'))};});await enable(f.live);
  await f.station.tune(null,{stationId:'lux-pop',fromLibrary:true});
  delayed=true;const a=f.live.refresh(),b=f.live.refresh();assert.equal(a,b);
  await f.station.tune(null,{stationId:'lux-rock',fromLibrary:true});const id=f.station.snapshot().stationId;
  release({data:directory(entry('lux-metal'))});await a;
  assert.equal(count,2);assert.equal(f.station.snapshot().station.id,'lux-rock');assert.equal(f.station.snapshot().stationId,id);
});

test('disabling during a pending refresh ignores its late result',async t=>{
  let release;const f=await fixture(t,()=>new Promise(resolve=>{release=resolve;}));
  await f.live.configure(settings);const work=f.live.refresh();const off=f.live.configure({...settings,enabled:false});
  release({data:directory(entry('lux-metal'))});await work;await off;
  assert.equal(f.live.snapshot().enabled,false);assert.equal(f.catalog.station('lux-metal'),null);
});

test('live frequencies never replace personal stations and survive cache reload',async t=>{
  const f=await fixture(t);const config=LUX_STATIONS[0].config;const personal=await f.stations.open(config,{name:'Personal',quote:''});
  await enable(f.live);const live=f.catalog.station('lux-metal');assert.notEqual(live.k,personal.k);assert.equal(f.stations.get(personal.id).k,personal.k);
  const restored=new LiveRadio({path:f.path,catalog:f.catalog,stations:f.stations});await restored.load();t.after(()=>restored.close());assert.equal(f.catalog.station('lux-metal').k,live.k);
});

test('refresh and tuning to a live station leave a YuE2 job running',async t=>{
  const f=await fixture(t);await f.station.tune(LUX_STATIONS[0].config);await delay(10);assert.equal(f.engine.requests.length,1);
  await enable(f.live);await f.station.tune(null,{stationId:'lux-metal',fromLibrary:true});await f.live.refresh();
  assert.equal(f.engine.requests.length,1);assert.equal(f.engine.aborts,0);
});

test('MP3 streaming uses the existing audio endpoint, forwards ranges and rejects arbitrary URLs',async t=>{
  const bytes=Buffer.from('ID3 remote audio fixture');let sawRange;
  const origin=await server(t,(req,res)=>{if(req.url==='/catalog.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(directory(entry('lux-metal',[track('remote-a','metal/a.mp3')]))));return;}sawRange=req.headers.range;res.writeHead(206,{'Content-Type':'audio/mpeg','Content-Range':`bytes 0-3/${bytes.length}`,'Content-Length':4,'Accept-Ranges':'bytes'});res.end(bytes.subarray(0,4));});
  const f=await fixture(t,remoteJson);await enable(f.live,{...settings,url:origin+'/catalog.json'});await f.station.tune(null,{stationId:'lux-metal',fromLibrary:true});
  const app=createApp({station:f.station,live:f.live,uiDir:join(f.root,'ui')});const address=await listen(app);t.after(()=>{app.closeAllConnections();app.close();});
  const song=f.station.snapshot().tracks[0];const response=await fetch(`${address}/audio/${song.id}?v=${song.mediaKey}`,{headers:{Range:'bytes=0-3'}});
  assert.equal(response.status,206);assert.equal(sawRange,'bytes=0-3');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(0,4));
  assert.equal((await fetch(`${address}/audio/not-registered?v=unsafe`)).status,404);
  assert.equal((await fetch(`${address}/api/live/settings`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example'},body:JSON.stringify(settings)})).status,403);
});

test('redirects to another host and oversized catalogs are rejected',async t=>{
  const origin=await server(t,(req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'http://169.254.169.254/latest'});res.end();}else{res.writeHead(200,{'Content-Type':'application/json','Content-Length':MAX_CATALOG_BYTES+1});res.end();}});
  await assert.rejects(remoteJson(origin+'/redirect'),/host/);
  await assert.rejects(remoteJson(origin+'/oversized'),/too large/);
});

test('MP3 types from common hosts are accepted, other media is not', () => {
  for (const type of ['audio/mpeg','audio/mp3','audio/mpeg; charset=binary','application/octet-stream']) assert.equal(isMp3Type(type), true, type);
  for (const type of ['text/html','audio/wav','video/mp4','',undefined]) assert.equal(isMp3Type(type), false, String(type));
});
