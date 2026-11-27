import assert from 'node:assert/strict';
import {runVoiceDesign,waitForVoiceDesign,validateVoiceDesign} from '../lib/voice-design.ts';
import './fake-indexeddb.mjs';
import {storeLocalAudio,getLocalAudioBlob} from '../lib/local-video-store.ts';
import {registerAsset} from '../lib/production-records.ts';
import {attachVoiceToRole} from '../lib/voice-role-attach.ts';
import {getRole} from '../lib/role-records.ts';
const input={text:'你好，这是试听台词。',description:'年轻自然温柔的普通话女声',count:3,seed:42};
for(const patch of [{text:''},{text:'x'.repeat(301)},{description:''},{count:4},{seed:-1}])assert.throws(()=>validateVoiceDesign({...input,...patch}));
let posts=0,id='',cleared=0;
const response=data=>Response.json(data);
const fake=async(url,init)=>{
 if(init?.method==='POST'){posts++;const plan=JSON.parse(init.body);id=plan.id;assert.equal(plan.count,3);assert.ok(!('referenceName'in plan));return response({id,status:'running'});}
 if(String(url).includes('&file='))return new Response(new Blob(['audio data'],{type:'audio/wav'}),{headers:{'Content-Type':'audio/wav'}});
 return response({status:'completed',description:input.description,candidates:[1,2,3].map(i=>({filename:`voice${i}.wav`,seed:41+i}))});
};
const results=await runVoiceDesign(input,{fetch:fake,onPending:value=>{id=value;},onRejected:()=>{cleared++;}});
assert.equal(results.length,3);assert.equal(posts,1);assert.equal(cleared,0,'do not clear recovery ID before local audio storage succeeds');
await waitForVoiceDesign(id,{fetch:fake});assert.equal(posts,1,'query must never repeat GPU submission');
await assert.rejects(()=>runVoiceDesign(input,{fetch:async()=>new Response(JSON.stringify({error:'GPU队列已有任务'}),{status:409}),onRejected:()=>cleared++}),/GPU队列/);
assert.equal(cleared,1);
await assert.rejects(()=>waitForVoiceDesign(id,{fetch:async()=>response({status:'failed',error:'CUDA out of memory'})}),/out of memory/);
const controller=new AbortController();controller.abort();await assert.rejects(()=>waitForVoiceDesign(id,{fetch:fake,signal:controller.signal}),/abort/i);
const src=await storeLocalAudio(results[1].blob,results[1].filename);
const asset=await registerAsset({kind:'audio',origin:'generated',filename:results[1].filename,mimeType:'audio/wav',storageReference:src,sourceRunId:null});
const role=await attachVoiceToRole(asset.assetId,{newName:'已选AI音色角色',primary:true});
assert.equal((await getRole(role.roleId)).primaryVoiceAssetId,asset.assetId);assert.equal(await(await getLocalAudioBlob(src)).text(),'audio data');
console.log('PASS voice design validation, 3-candidate protocol, no reference dependency, stable seeds, primary role storage, GPU-busy/failure/abort, query-only recovery without duplicate submission. No GPU.');
