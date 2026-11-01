import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ModelSetup } from '../src/engine/model-setup.js';

const content = Buffer.alloc(20000, 'music');
const digest = data => createHash('sha256').update(data).digest('hex');
const waitFor = async (setup, predicate) => {
  for (let n=0;n<300;n++) { const s=await setup.snapshot(); if(predicate(s)) return s; await new Promise(r=>setTimeout(r,10)); }
  throw new Error('Setup did not reach the expected state');
};
async function fixture(t, options={}) {
  const root=await mkdtemp(join(tmpdir(),'lvx-model-'));
  const ranges=[];
  const server=createServer((req,res)=>{
    const start=Number(/bytes=(\d+)-/.exec(req.headers.range||'')?.[1]||0);ranges.push(start);
    const from=options.ignoreRange?0:start;
    res.writeHead(from?206:200,{...(from?{'Content-Range':`bytes ${from}-${content.length-1}/${content.length}`}:{})});
    let pos=from;
    const timer=setInterval(()=>{if(pos>=content.length){clearInterval(timer);res.end();return}res.write(content.subarray(pos,pos+1000));pos+=1000;},4);
    res.on('close',()=>clearInterval(timer));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const file={path:'music.gguf',size:content.length,sha256:digest(content),url:`http://127.0.0.1:${server.address().port}/model`};
  const engine={dataDir:root,modelDir:join(root,'models'),binary:'/bin/sh',modelSpecs:root};
  await writeFile(join(root,'yue2.json'),'{}');
  const setup=new ModelSetup(engine,{files:[file],...options});
  await setup.initialize();
  t.after(async()=>{await setup.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  return{setup,engine,root,file,ranges};
}

test('setup requires license acceptance before downloading',async t=>{
 const {setup}=await fixture(t);await assert.rejects(setup.download(false),/terms/);assert.equal((await setup.snapshot()).ready,false);
});
test('download verifies the hash and persists a usable model without another download',async t=>{
 const {setup,engine,file,ranges}=await fixture(t);await setup.download(true);await waitFor(setup,s=>s.ready);
 assert.deepEqual(await readFile(join(engine.modelDir,file.path)),content);
 await setup.close(); const again=new ModelSetup(engine,{files:[file]});await again.initialize();assert.equal((await again.snapshot()).ready,true);assert.equal(ranges.length,1);await again.close();
});
test('pausing and restarting setup resumes the partial file using Range',async t=>{
 const {setup,engine,file,ranges}=await fixture(t);await setup.download(true);await waitFor(setup,s=>s.bytes>2000);await setup.pause();assert.equal((await setup.snapshot()).status,'paused');await setup.close();
 const resumed=new ModelSetup(engine,{files:[file]});await resumed.initialize();await resumed.download(false);await waitFor(resumed,s=>s.ready);assert.ok(ranges[1]>0);await resumed.close();
});
test('a server ignoring Range restarts cleanly instead of appending a duplicate',async t=>{
 const {setup,ranges}=await fixture(t,{ignoreRange:true});await setup.download(true);await waitFor(setup,s=>s.bytes>2000);await setup.pause();await setup.download(true);await waitFor(setup,s=>s.ready);assert.ok(ranges[1]>0);
});
test('corrupt downloads fail integrity verification and can be retried',async t=>{
 const {setup}=await fixture(t,{fetchFile:async()=>new Response(Buffer.alloc(content.length,0))});await setup.download(true);const s=await waitFor(setup,s=>s.status==='error');assert.match(s.error,/integrity/);assert.equal(s.ready,false);
});
test('existing folders are checked and used in place',async t=>{
 const {setup,root}=await fixture(t);const dir=join(root,'existing model');await mkdir(dir);await writeFile(join(dir,'music.gguf'),content);await setup.useDirectory(dir,true);await waitFor(setup,s=>s.ready);assert.equal((await setup.snapshot()).directory,dir);assert.deepEqual(await readFile(join(dir,'music.gguf')),content);
});
test('invalid existing model folders explain what is missing',async t=>{
 const {setup,root}=await fixture(t);await setup.useDirectory(root,true);const s=await waitFor(setup,s=>s.status==='error');assert.match(s.error,/music.gguf/);assert.equal(s.ready,false);
});
test('insufficient disk space stops before a download starts',async t=>{
 const {setup,ranges}=await fixture(t,{freeSpace:async()=>0});await setup.download(true);const s=await waitFor(setup,s=>s.status==='error');assert.match(s.error,/free space/);assert.equal(ranges.length,0);
});
test('a disconnected download reports an error while retaining partial progress',async t=>{
 const {setup}=await fixture(t,{fetchFile:async()=>{throw new Error('Network unavailable');}});await setup.download(true);const s=await waitFor(setup,s=>s.status==='error');assert.match(s.error,/Network/);assert.equal(s.ready,false);
});

test('a short successful response keeps the partial file for the next resume',async t=>{
 let calls=0;const {setup}=await fixture(t,{fetchFile:async(url,options)=>{
   if(calls++===0)return new Response(content.subarray(0,500));
   assert.equal(options.headers.Range,'bytes=500-');
   return new Response(content.subarray(500),{status:206,headers:{'Content-Range':`bytes 500-${content.length-1}/${content.length}`}});
 }});
 await setup.download(true);await waitFor(setup,s=>s.status==='error');await setup.download(true);await waitFor(setup,s=>s.ready);
});

test('a second download request cannot start a parallel task',async t=>{
 const {setup}=await fixture(t);const first=setup.download(true);await assert.rejects(setup.download(true),/already running/);await first;await setup.pause();
});

test('removing an installed model returns setup to the required state',async t=>{
 const {setup,engine,file}=await fixture(t);await setup.download(true);await waitFor(setup,s=>s.ready);await rm(join(engine.modelDir,file.path));const status=await setup.snapshot();assert.equal(status.ready,false);assert.equal(status.status,'idle');
});
