import assert from 'node:assert/strict';
import {mkdtemp,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mediaTrashBlockers} from '../lib/media-trash-policy.ts';
import {assertLocalTrashRequest,checkedMediaPath,recycleWindowsFile,assertTrashQueueIdle,recycleMediaRequest,COMFY_OUTPUT_DIR} from './media-trash-service.ts';
import {cancelRecoveredJob} from '../lib/cancel-recovered-job.ts';

const asset={assetId:'asset-a',storageReference:'image:a',canvasPageIds:['page:a']};
const empty={pageId:'page:a',otherShapes:[],roles:[],runs:[],shots:[],otherAssets:[],metadata:[]};
assert.deepEqual(mediaTrashBlockers(asset,empty),[]);
for(const change of [
 {otherShapes:[{props:{src:'image:a'}}]}, {roles:[{voiceAssetIds:['asset-a']}]},
 {shots:[{adoptedAssetId:'asset-a'}]}, {runs:[{status:'running',inputAssetIds:['asset-a']}]},
 {metadata:[{value:{items:[{assetId:'asset-a'}]}}]}, {otherAssets:[{sourceVideoAssetId:'asset-a'}]},
])assert.ok(mediaTrashBlockers(asset,{...empty,...change}).length);
// 2026-11-25: finished history runs no longer keep their inputs (was: completed run protected).
assert.deepEqual(mediaTrashBlockers(asset,{...empty,runs:[{status:'completed',inputAssetIds:['asset-a']}]}),[]);
assert.ok(mediaTrashBlockers({...asset,canvasPageIds:['page:a','page:b']},empty).length);
assert.throws(()=>assertLocalTrashRequest(new Request('http://localhost:5173/api/media-trash',{method:'POST',headers:{origin:'https://evil.example','x-frameflow-action':'recycle'}})),/跨站/);
assert.throws(()=>assertLocalTrashRequest(new Request('http://evil.example/api/media-trash')),/本机/);
assertLocalTrashRequest(new Request('http://localhost:5173/api/media-trash',{method:'POST',headers:{origin:'http://localhost:5173','x-frameflow-action':'recycle'}}));
assertLocalTrashRequest(new Request('http://127.0.0.1:5173/api/media-trash',{method:'POST',headers:{'x-frameflow-action':'recycle'}}));
assertLocalTrashRequest(new Request('http://localhost:5173/api/media-trash',{method:'POST',headers:{origin:'http://127.0.0.1:5173','x-frameflow-action':'recycle'}}));
assertLocalTrashRequest(new Request('http://127.0.0.1:5189/',{method:'POST',headers:{origin:'http://localhost:5177','x-frameflow-action':'recycle'}}));
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>Response.json({queue_running:[['active']],queue_pending:[]});
await assert.rejects(assertTrashQueueIdle,/仍有渲染/);
globalThis.fetch=async()=>{throw Error('offline');};
await assert.rejects(assertTrashQueueIdle,/offline/);
globalThis.fetch=originalFetch;

let cancelled=0;
assert.equal(await cancelRecoveredJob({probeJob:async()=>({state:'not_found'}),cancel:async()=>cancelled++},'job','148'),'stopped');
assert.equal(cancelled,0,'missing task never calls cancel or interrupt');
assert.equal(await cancelRecoveredJob({probeJob:async()=>({state:'completed',file:{filename:'a.mp4'}}),cancel:async()=>cancelled++},'job','148'),'completed');
await assert.rejects(()=>cancelRecoveredJob({probeJob:async()=>({state:'running'}),cancel:async()=>{throw Error('cancel failed');}},'job','148'),/cancel failed/);
await assert.rejects(()=>cancelRecoveredJob({probeJob:async()=>{throw Error('offline');},cancel:async()=>cancelled++},'job','148'),/offline/);
assert.equal(cancelled,0);

const folder=await mkdtemp(path.join(tmpdir(),'frameflow-recycle-test-'));
const name=`frameflow-TEST-ONLY-${randomUUID()}.png`;
const target=path.join(folder,name);
await writeFile(target,'Frameflow disposable recycle test fixture only');
await assert.rejects(()=>checkedMediaPath(folder,'../outside.png'),/不安全/);
await assert.rejects(()=>checkedMediaPath(folder,'Z:/any.png'),/不安全|越界/);
assert.equal((await checkedMediaPath(folder,name)).toLowerCase(),target.toLowerCase());
if(process.platform==='win32'){
 await recycleWindowsFile(target);
 await assert.rejects(access(target),{code:'ENOENT'});
 console.log('PASS: actual Windows recycle call moved ONLY the newly-created test fixture:',target);
 const fixtureId=randomUUID(), promptId=randomUUID();
 const filename=`Frameflow-TEST-ONLY-${fixtureId}.png`;
 const generatedTarget=path.join(COMFY_OUTPUT_DIR,filename);
 const fixture=new TextEncoder().encode('Disposable generated-file hash-match fixture only');
 await writeFile(generatedTarget,fixture,{flag:'wx'});
 globalThis.fetch=async url=>{
  if(String(url).endsWith('/queue'))return Response.json({queue_running:[],queue_pending:[]});
  if(String(url).endsWith('/history/'+promptId))return Response.json({[promptId]:{status:{status_str:'success'},outputs:{'save':{images:[{filename,subfolder:'',type:'output'}]}}}});
  throw Error('Unexpected test fetch');
 };
 try {
  const query=new URLSearchParams({assetId:fixtureId,promptId,filename});
  const receipt=await recycleMediaRequest(new Request('http://localhost:5173/api/media-trash?'+query,{method:'POST',headers:{origin:'http://localhost:5173','x-frameflow-action':'recycle'},body:fixture}));
  assert.equal(receipt.mode,'generated-original');
  assert.equal(receipt.recycled,true);
  await assert.rejects(access(generatedTarget),{code:'ENOENT'});
  console.log('PASS: generated-original hash/history matching; ONLY a newly-created fixture recycled; receipt:',receipt.receiptId);
  const cancelledId=randomUUID(), cancelledPrompt=randomUUID();
  const cancelledName=`Frameflow-TEST-ONLY-cancelled-${cancelledId}.png`;
  const cancelledBytes=new TextEncoder().encode('Cancelled-job browser-copy recycle fixture only');
  globalThis.fetch=async url=>{
   if(String(url).endsWith('/queue'))return Response.json({queue_running:[],queue_pending:[]});
   if(String(url).endsWith('/history/'+cancelledPrompt))return Response.json({[cancelledPrompt]:{status:{status_str:'error'},outputs:{}}});
   throw Error('Unexpected test fetch');
  };
  const cancelled=await recycleMediaRequest(new Request('http://localhost:5173/api/media-trash?'+new URLSearchParams({assetId:cancelledId,promptId:cancelledPrompt,filename:cancelledName}),{method:'POST',headers:{origin:'http://localhost:5173','x-frameflow-action':'recycle'},body:cancelledBytes}));
  assert.equal(cancelled.mode,'browser-copy');
  assert.equal(cancelled.recycled,true);
  console.log('PASS: cancelled/failed Comfy history falls back to browser-copy; receipt:',cancelled.receiptId);
 }finally{globalThis.fetch=originalFetch;}
}
console.log('PASS: shared reference guards, adopted/active-run input protection, CSRF, queue/offline guards, traversal protection, cancelled-node recovery');
