import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),fixtures={};for(const key of ['video','bad-image','candidate-image']){const i=args.indexOf('--'+key);if(i>=0){const name=path.resolve(args[i+1]);fixtures[key]={path:name,bytes:readFileSync(name)};}}
import http from 'node:http';
import ts from 'typescript';
import {pathToFileURL} from 'node:url';
// Playwright entry and browser come from FRAMEFLOW_PLAYWRIGHT_ENTRY (path to playwright/index.mjs) and FRAMEFLOW_CHROME_PATH.
const {chromium}=await import(process.env.FRAMEFLOW_PLAYWRIGHT_ENTRY?pathToFileURL(process.env.FRAMEFLOW_PLAYWRIGHT_ENTRY).href:'playwright');

// Fresh browser context, random loopback port, no production origin/profile/inbox/GPU access.
const modules={},dependencies={};
function bundle(name){
  const key=path.resolve(name).replaceAll('\\','/');if(modules[key])return key;
  modules[key]='';dependencies[key]={};
  let code=key.endsWith('.json')?'module.exports='+readFileSync(key,'utf8')+';':ts.transpileModule(readFileSync(key,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  if(key.endsWith('/lib/comfyui/submission-scheduler.ts'))code='exports.scheduledPromptFetch=async(url,init,request,kind,before)=>{before?.();return request(url,init);};';
  for(const match of code.matchAll(/require\(["']([^"']+)["']\)/g)){
    const spec=match[1];assert.ok(spec.startsWith('.'),'No external runtime in isolated test: '+spec);
    dependencies[key][spec]=bundle(path.resolve(path.dirname(key),spec));
  }
  modules[key]=code;return key;
}
const roots={};for(const name of ['operation-scope','image-integrity','local-video-store','production-records','queue-session-store','queue-entry-state','shot-queue-session','shot-queue-frames','queue-tail-frame-enhance','tail-frame-hd-job','tail-frame-output-recovery','canvas-library-scope','comfyui/frame-image-enhance'])roots[name]=bundle('lib/'+name+'.ts');
const script=`const defs=${JSON.stringify(modules)},deps=${JSON.stringify(dependencies)},cache={};function load(id){if(cache[id])return cache[id].exports;const mod=cache[id]={exports:{}};new Function('module','exports','require',defs[id])(mod,mod.exports,name=>load(deps[id][name]));return mod.exports;}window.testModules=Object.fromEntries(Object.entries(${JSON.stringify(roots)}).map(([key,id])=>[key,load(id)]));`;
const state={posts:0,uploads:new Map(),png:null,info:{},promptId:null,disconnect:false,complete:false,corruptUpload:false};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://test');
  if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>Isolated tail pipeline regression</title>');return;}
  if(url.pathname.startsWith('/fixture/')){const f=fixtures[url.pathname.slice(9)];if(!f){res.writeHead(404);res.end();return;}res.end(f.bytes);return;}
  if(url.pathname==='/bundle.js'){res.setHeader('content-type','application/javascript; charset=utf-8');res.end(script);return;}
  if(url.pathname==='/hang'){res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
  if(url.pathname==='/comfyui/object_info'){res.setHeader('content-type','application/json');res.end(JSON.stringify(state.info));return;}
  if(url.pathname==='/comfyui/upload/image'){
   const chunks=[];for await(const c of req)chunks.push(c);
   const form=await new Response(Buffer.concat(chunks),{headers:{'content-type':req.headers['content-type']}}).formData();const image=form.get('image');
   const bytes=Buffer.from(await image.arrayBuffer());state.uploads.set(image.name,state.corruptUpload?Buffer.alloc(bytes.length):bytes);
   res.setHeader('content-type','application/json');res.end(JSON.stringify({name:image.name,subfolder:''}));return;
  }
  if(url.pathname==='/comfyui/prompt'){
   let text='';for await(const c of req)text+=c;state.promptId=JSON.parse(text).prompt_id;state.posts++;
   if(state.disconnect){state.disconnect=false;res.writeHead(200,{'content-type':'application/json','content-length':'200'});res.write('{');setTimeout(()=>res.destroy(),5);return;}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({prompt_id:state.promptId}));return;
  }
  if(url.pathname.startsWith('/comfyui/history/')){res.setHeader('content-type','application/json');res.end(JSON.stringify(state.complete&&state.promptId?{[state.promptId]:{status:{completed:true,status_str:'success'},outputs:{'7':{images:[{filename:'isolated-hd.png',type:'output'}]}}}}:{}));return;}
  if(url.pathname==='/comfyui/queue'){res.setHeader('content-type','application/json');res.end(JSON.stringify({queue_running:[],queue_pending:state.promptId&&!state.complete?[[1,state.promptId]]:[]}));return;}
  if(url.pathname==='/comfyui/view'){res.setHeader('content-type','image/png');res.end(url.searchParams.get('type')==='input'?state.uploads.get(url.searchParams.get('filename')):state.png);return;}
  res.writeHead(404);res.end();
 }catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({executablePath:process.env.FRAMEFLOW_CHROME_PATH||undefined,headless:true});
const context=await browser.newContext();
await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
const page=await context.newPage();const results=[];
try{
 await page.goto(origin);await page.addScriptTag({url:origin+'/bundle.js'});
 const initial=await page.evaluate(async()=>{
  const m=window.testModules;m['canvas-library-scope'].configureCanvasLibraryScope(()=>({pageId:'page:isolated',references:new Set()}));
  const canvas=document.createElement('canvas');canvas.width=64;canvas.height=32;const c=canvas.getContext('2d');c.fillStyle='#1b94cd';c.fillRect(0,0,64,32);c.fillStyle='#fac422';c.fillRect(12,5,18,21);
  const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));window.png=blob;
  const graph=m['comfyui/frame-image-enhance'].buildFrameImageEnhance('test.png',64,32,'lab');const info=Object.fromEntries(Object.values(graph).map(n=>[n.class_type,{input:{required:{}}}]));
  for(const [id,field] of [['66:52','unet_name'],['66:51','vae_name']])info[graph[id].class_type].input.required[field]=[[graph[id].inputs[field]]];
  return {bytes:Array.from(new Uint8Array(await blob.arrayBuffer())),info};
 });state.png=Buffer.from(initial.bytes);state.info=initial.info;
 results.push(await page.evaluate(async()=>{
  const {imageProof,verifyUploadedImage}=window.testModules['image-integrity'];
  const mustReject=async(fn,pattern)=>{try{await fn();throw Error('Expected rejection');}catch(e){if(!pattern.test(String(e)))throw e;}};
  const proof=await imageProof(window.png);if(proof.width!==64||proof.height!==32)throw Error('Native decode dimensions');
  await mustReject(()=>imageProof(new Blob([new Uint8Array(300)])),/全零/);
  await mustReject(()=>imageProof(new Blob([new Uint8Array([137,80,78,71,13,10,26,10,1,2,3])])),/解码/);
  await mustReject(()=>verifyUploadedImage(window.png,{name:'bad'},async()=>new Response(new Blob([new Uint8Array(window.png.size)])),''),/全零/);
  return 'native ImageBitmap decode, zero/truncated PNG and received bytes gate';
 }));
 results.push(await page.evaluate(async()=>{
  const {bounded,boundedLock,fetchBody,idbDeadline}=window.testModules['operation-scope'];
  let write=0,finish;const gate=new Promise(r=>finish=r);
  await bounded(async scope=>{await gate;scope.check();write++;},15).then(()=>{throw Error('No deadline');},()=>{});finish();await new Promise(r=>setTimeout(r,25));if(write)throw Error('Late write escaped');
  let release;const held=navigator.locks.request('isolated-lock',()=>new Promise(r=>release=r));await new Promise(r=>setTimeout(r,5));
  await boundedLock('isolated-lock',async()=>1,{waitMs:10,workMs:20}).then(()=>{throw Error('Lock wait did not expire');},()=>{});release();await held;
  if(await boundedLock('isolated-lock',async()=>2,{waitMs:100,workMs:100})!==2)throw Error('Leaked native lock');
  await fetchBody('/hang',{},r=>r.json(),25).then(()=>{throw Error('Body not timed');},()=>{});
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('isolated-native-tx',1);r.onupgradeneeded=()=>r.result.createObjectStore('x');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const tx=db.transaction('x','readwrite'),store=tx.objectStore('x');store.put('forbidden','key');let keep=true;
  const spin=()=>{if(!keep)return;const r=store.get('key');r.onsuccess=spin;};spin();
  await idbDeadline(tx,()=>{},15).then(()=>{throw Error('Tx deadline not enforced');},()=>{});keep=false;
  const result=await new Promise((resolve,reject)=>{const r=db.transaction('x').objectStore('x').get('key');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();if(result!==undefined)throw Error('Native transaction was not rolled back');
  return 'response body abort, late-writer fence, native Web Lock release and native IDB rollback';
 }));
 results.push(await page.evaluate(async()=>{
  const m=window.testModules,p=m['production-records'],store=m['queue-session-store'];
  const batch=m['shot-queue-session'].newQueueSession('page:isolated',{version:'shot-queue-v1',chapters:[{title:'test',shots:[{title:'A'},{title:'B'}]}]},{x:0,y:0});
  await store.saveSessionDelta(batch,null,{activate:true,expectedPageId:null});
  const before=structuredClone(batch),a=structuredClone(batch),b=structuredClone(batch);a.entries[0].waitingReason='A';b.entries[1].waitingReason='B';
  await Promise.all([store.saveSessionDelta(a,before),store.saveSessionDelta(b,before)]);
  let fresh=await p.getMeta(m['shot-queue-session'].queueSessionKey(batch.pageId));if(fresh.entries[0].waitingReason!=='A'||fresh.entries[1].waitingReason!=='B')throw Error('Concurrent unrelated entry lost');
  const old=structuredClone(fresh),next=structuredClone(fresh);next.entries[0].execution={attemptId:'new',phase:'extracting',startedAt:1,lastProgressAt:1,leaseUntil:2,lockName:'test'};await store.saveSessionDelta(next,fresh);
  old.entries[0].waitingReason='late';await store.saveSessionDelta(old,fresh).then(()=>{throw Error('Old attempt overwritten');},()=>{});
  fresh=await p.getMeta('shot-queue-file-v2:'+batch.id);const stopped=structuredClone(fresh);stopped.stoppedAt=3;stopped.autoContinueFrames=false;await p.putMeta('shot-queue-file-v2:'+batch.id,stopped);
  const stale=structuredClone(fresh);stale.entries[1].waitingReason='stale-after-stop';await store.saveSessionDelta(stale,fresh).then(()=>{throw Error('Stop overwritten');},()=>{});
  for(const field of ['removedAt','cancelledAt','cancelRequestedAt']){const cancelled=structuredClone(fresh);cancelled.entries[0][field]=4;const old=structuredClone(fresh);old.entries[0].waitingReason='late';const merged=m['queue-entry-state'];try{merged.mergeSessionDelta(cancelled,old,fresh);throw Error('Tombstone overwritten');}catch(e){if(e.name!=='SessionConflict')throw e;}}
  window.batch=batch;return 'actual dual-row IDB transactions, independent delta merge, attempt conflict, stop and deletion fences';
 }));
 if(fixtures.video)results.push(await page.evaluate(async()=>{
  const media=window.testModules['local-video-store'],proof=window.testModules['image-integrity'];
  const blob=await(await fetch('/fixture/video')).blob();const src=await media.storeLocalVideo(blob,'read-only-production-fixture.mp4');
  const frame=await media.extractVideoFrameAt(src,Number.MAX_SAFE_INTEGER);const png=await media.getLocalImageBlob(frame.dataUrl);const verified=await proof.imageProof(png);
  if(verified.width!==frame.width||verified.height!==frame.height||!frame.seconds)throw Error('Real MP4 tail decode failed');
  return 'read-only existing MP4 -> isolated IDB -> native last-frame PNG decode '+frame.width+'x'+frame.height;
 }));
 if(fixtures['bad-image']&&fixtures['candidate-image'])results.push(await page.evaluate(async()=>{
  const {imageProof}=window.testModules['image-integrity'];let rejected=false;
  try{await imageProof(await(await fetch('/fixture/bad-image')).blob());}catch(error){if(!String(error).includes('全零'))throw error;rejected=true;}
  if(!rejected)throw Error('L15 zero input accepted');const proof=await imageProof(await(await fetch('/fixture/candidate-image')).blob());
  return 'L15 filesystem evidence: zero input rejected; candidate PNG really decodes '+proof.width+'x'+proof.height+' (lineage still unverified)';
 }));
 state.disconnect=true;
 results.push(await page.evaluate(async()=>{
  const m=window.testModules,src=await m['local-video-store'].storeLocalImage(window.png,'native-original.png');
  const original=await m['production-records'].registerAsset({kind:'image',origin:'generated',filename:'native-original.png',mimeType:'image/png',storageReference:src,sourceRunId:null,width:64,height:32,fileSize:window.png.size});window.original=original;
  try{await m['tail-frame-hd-job'].enhanceTailPNG(original.assetId,()=>{},async()=>{},true,'chain',undefined,'isolated-test',true);throw Error('Expected ambiguous POST');}catch(e){if(!String(e).includes('提交状态待确认'))throw e;}
  const meta=await m['production-records'].getMeta(m['tail-frame-hd-job'].tailFrameEnhanceKey(original.assetId));if(!meta?.promptId)throw Error('Reservation lost');window.reserved=meta.promptId;
  return 'accepted HD POST / disconnected receipt leaves durable original promptId';
 }));assert.equal(state.posts,1);state.complete=true;
 results.push(await page.evaluate(async()=>{
  const m=window.testModules;const hd=await m['tail-frame-hd-job'].enhanceTailPNG(window.original.assetId,()=>{},async()=>{},true,'chain',undefined,'isolated-test',true);
  if(hd.enhancementPromptId!==window.reserved)throw Error('Wrong recovered GPU job');window.hd=hd;
  // Simulate crash after HD asset creation but before meta / session attachment.
  await m['production-records'].putMeta(m['tail-frame-hd-job'].tailFrameEnhanceKey(window.original.assetId),{promptId:window.reserved});
  const recovered=await m['tail-frame-hd-job'].enhanceTailPNG(window.original.assetId,()=>{},async()=>{},true,'chain',undefined,'isolated-test',true);
  if(recovered.assetId!==hd.assetId)throw Error('HD asset duplicated after failed checkpoint');
  const frame={src:window.original.storageReference,name:'tail.png',sourceRunId:'source-run',sourceAssetId:'source-video',sourceStorageReference:'media:source',sourceFrame:'last',seconds:1,width:64,height:32,sourceNodeId:'node:source',sourceShot:'source',enhancement:{originalAssetId:window.original.assetId,promptId:window.reserved}};
  const finished=await m['queue-tail-frame-enhance'].enhanceQueueTailFrame(frame,async()=>{},()=>{},()=>{},'isolated-test');if(finished.enhancement.completedAssetId!==hd.assetId)throw Error('Session did not recognize recovered HD');
  return 'same HD asset recognized after lost session/meta checkpoint, no second POST';
 }));assert.equal(state.posts,1);
 // Real PNG metadata and checksum checks exercise the recovery API without touching production.
 const originalSha=createHash('sha256').update(Buffer.from(initial.bytes)).digest('hex');
 const prompt=Buffer.from('prompt\0'+JSON.stringify({'load-frame':{class_type:'LoadImage',inputs:{image:'original.png'},is_changed:[originalSha]},'66:59':{class_type:'SeedVR2ColorCorrection',inputs:{color_correction_method:'lab'}}}));
 const chunk=Buffer.alloc(prompt.length+12);chunk.writeUInt32BE(prompt.length);chunk.write('tEXt',4);prompt.copy(chunk,8);let crc=0xffffffff;for(const b of chunk.subarray(4,-4)){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
 state.png=Buffer.concat([state.png.subarray(0,-12),chunk,state.png.subarray(-12)]);
 const recovered=await page.evaluate(async target=>{
  const m=window.testModules,old=window.hd.assetId,args={originalAssetId:window.original.assetId,promptId:window.reserved,...target};
  await m['tail-frame-output-recovery'].recoverTailOutput({...args,expectedOriginalSha256:'0'.repeat(64)}).then(()=>{throw Error('wrong source accepted');},()=>{});
  await m['tail-frame-output-recovery'].recoverTailOutput({...args,expectedOutputSha256:'0'.repeat(64)}).then(()=>{throw Error('wrong output accepted');},()=>{});
  const result=await m['tail-frame-output-recovery'].recoverTailOutput(args);
  if(!await m['production-records'].getAsset(old))throw Error('Old evidence asset deleted');
  const again=await m['tail-frame-output-recovery'].recoverTailOutput(args);if(again.asset.assetId!==result.asset.assetId)throw Error('Recovery duplicated asset');
  return 'proven PNG original hash + output hash + lab correction recovery is idempotent; wrong evidence rejected; old asset retained';
 },{filename:'Frameflow_Frame_HD_00999_.png',expectedOriginalSha256:originalSha,expectedOutputSha256:createHash('sha256').update(state.png).digest('hex')});results.push(recovered);assert.equal(state.posts,1);
 const evidence={at:new Date().toISOString(),origin,productionAccess:false,gpuPosts:0,mockHdPosts:state.posts,fixtures:Object.fromEntries(Object.entries(fixtures).map(([key,value])=>[key,{path:value.path,bytes:value.bytes.length,sha256:createHash('sha256').update(value.bytes).digest('hex')}])),results};
 mkdirSync('runtime/tail-pipeline-20261025',{recursive:true});writeFileSync('runtime/tail-pipeline-20261025/browser-regression.json',JSON.stringify(evidence,null,2));
 for(const result of results)console.log('PASS '+result);console.log('No production origin, browser profile, database, inbox or GPU accessed; only explicit fixture files read.');
}finally{await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}




