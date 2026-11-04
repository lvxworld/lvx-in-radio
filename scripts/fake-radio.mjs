// Dev only: the real UI and server with a fake engine (no GPU, no model).
// GEN_MS = seconds a song takes to compose (ms), SONG_SEC = song length, PORT = 8788.
import { mkdtemp } from 'node:fs/promises';import { tmpdir } from 'node:os';import { join } from 'node:path';
const R=new URL('../src/',import.meta.url).href;
const { loadConfig }=await import(R+'config.js');const { Library }=await import(R+'radio/library.js');
const { StationStore }=await import(R+'radio/stations.js');const { LuxCatalog, RESERVED_FREQUENCIES }=await import(R+'radio/lux-catalog.js');
const { LiveRadio }=await import(R+'radio/live-radio.js');const { writeFile }=await import('node:fs/promises');
const { RadioStation }=await import(R+'radio/station.js');const { createApp, listen }=await import(R+'server/app.js');
const GEN_MS=Number(process.env.GEN_MS??20000), SECONDS=Number(process.env.SONG_SEC??8);
function wav(seconds){const rate=192000,size=seconds*rate,b=Buffer.alloc(44+size);b.write('RIFF',0,'latin1');b.write('WAVE',8,'latin1');b.write('fmt ',12,'latin1');b.writeUInt32LE(16,16);b.writeUInt32LE(rate,28);b.write('data',36,'latin1');b.writeUInt32LE(size,40);return b.toString('base64')}
const engine={requests:[],run(req){this.requests.push(req);return new Promise(r=>setTimeout(()=>r({audio:wav(SECONDS)}),GEN_MS))},async abort(){},async stop(){}};
const dir=await mkdtemp(join(tmpdir(),'lvx-fake-'));const config=loadConfig({LVX_DATA_DIR:dir,LVX_PORT:process.env.PORT??'8788'});
const library=new Library(config.libraryDir);await library.load();
const stations=new StationStore(config.stationsFile,{reservedFrequencies:RESERVED_FREQUENCIES});await stations.load();
const catalog=new LuxCatalog(config.lux);await catalog.load();
// LIVE=1 (default) turns LVX Live on with an empty fake catalog, so the refresh button shows.
let station;
const live=new LiveRadio({path:config.liveRadio.path,defaultUrl:'https://catalog.invalid/catalog.json',catalog,stations,fetchCatalog:async()=>{await new Promise(r=>setTimeout(r,1500));return {schemaVersion:1,stations:[]}},onCatalogChange:change=>station?.catalogChanged(change)});
if(process.env.LIVE!=='0')await writeFile(config.liveRadio.path,JSON.stringify({version:1,settings:{choiceMade:true,enabled:true,url:'https://catalog.invalid/catalog.json',refreshMinutes:0},positions:{}}));
await live.load();
station=new RadioStation({engine,library,stations,catalog,tickMs:1000,leadMarginSec:30});
live.on('change',()=>station.emit('change'));
const server=createApp({station,uiDir:config.uiDir,readGpu:async()=>null,live});
console.log('FAKE RADIO',await listen(server,config.port),'data',dir);
