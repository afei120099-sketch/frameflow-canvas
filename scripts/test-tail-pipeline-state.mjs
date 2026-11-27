import assert from 'node:assert/strict';
import {parseShotQueue} from '../lib/shot-queue.ts';
import {newQueueSession} from '../lib/shot-queue-session.ts';
import {frameEntriesToResume,resolveQueueFrameInputs} from '../lib/shot-queue-frames.ts';
import {harness} from './test-queue-fail-closed.mjs';

const shot=(title,source)=>({title,prompt:'CPU isolation only',seconds:6,aspect:'16:9',roleIds:[],sceneAssetIds:[],autoVoiceDisabled:true,...(source?{generationMode:'first-last',firstFrameFrom:{shot:source,frame:'last'}}:{})});
const queue=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'two independent chains',chapters:[{title:'test',shots:[shot('A'),shot('B'),shot('A-tail','A'),shot('B-tail','B')]}]}));
const batch=newQueueSession('page:g-test',queue,{x:0,y:0});batch.entries.forEach((entry,i)=>{entry.nodeId='shape:'+i;if(i<2)entry.submissionState='accepted';});
const runs=[0,1].map(i=>({runId:'original-'+i,ownerNodeId:'shape:'+i,status:'completed',submission:'accepted',comfyPromptId:'prompt-'+i,outputAssetIds:['video-'+i],createdAt:1}));
const assets=[0,1].map(i=>({assetId:'video-'+i,kind:'video',filename:i+'.mp4',storageReference:'media:'+i}));
let reads=0;
const h=harness({queue,saved:batch,runs,assets,hooks:{blobError:async src=>{if(src==='media:0'){reads++;return Error('视频元数据超时');}}}});
await h.api.submitAll();
assert.equal(reads,1,'one preparation attempt per pass; no in-lock retries');
assert.deepEqual(h.data.submitted,['shape:3'],'independent ready chain progresses after another source timeout');
assert.equal(h.data.saved.entries[2].execution.phase,'retry_wait');
assert.ok(h.data.saved.entries[2].execution.nextRetryAt>Date.now());

const rerun=structuredClone(batch);rerun.entries[0].rerun={requestId:'rerun-A',previousRunId:'original-0',requestedAt:10};rerun.entries[0].submissionState='pending';
rerun.entries[2].frameInputs={first:{src:'image:OLD',name:'old.png',sourceRunId:'original-0',sourceAssetId:'video-0',sourceStorageReference:'media:0',sourceNodeId:'shape:0',sourceShot:'A',sourceFrame:'last',seconds:5.9,width:64,height:32}};
assert.deepEqual(frameEntriesToResume(rerun,runs).map(e=>e.nodeId),['shape:3'],'only downstream of A is fenced');
const io={guard(){},runs:async()=>runs,asset:async id=>assets.find(a=>a.assetId===id),read:async()=>{throw Error('must not read old source');},pause:async()=>{},extract:async()=>{throw Error('must not extract old source');}};
await assert.rejects(()=>resolveQueueFrameInputs(rerun,rerun.entries[2],io),/等待上游重渲/);
const active={...runs[0],runId:'rerun-active',status:'running',createdAt:20};
await assert.rejects(()=>resolveQueueFrameInputs(rerun,rerun.entries[2],{...io,runs:async()=>[...runs,active],observeRun:async()=> 'running'}),/仍在排队/);
const done={...active,status:'completed',outputAssetIds:['new-video']},newAsset={...assets[0],assetId:'new-video',storageReference:'media:NEW'};
const resolved=await resolveQueueFrameInputs(rerun,rerun.entries[2],{...io,runs:async()=>[...runs,done],asset:async id=>id===newAsset.assetId?newAsset:assets.find(a=>a.assetId===id),read:async src=>{assert.equal(src,'media:NEW');return new Blob(['test']);},extract:async src=>{assert.equal(src,'media:NEW');return{dataUrl:'data:image/png;base64,eA==',width:64,height:32,seconds:5.9};}});
assert.equal(resolved.first.sourceRunId,done.runId,'continuation cannot use pre-rerun frozen tail');

const one=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'idempotent request',chapters:[{title:'one',shots:[shot('A')]}]}));
const saved=newQueueSession('page:g-test',one,{x:0,y:0});saved.entries[0].nodeId='shape:A';saved.entries[0].submissionState='accepted';
const complete={...runs[0],ownerNodeId:'shape:A'};
const once=harness({queue:one,saved,runs:[complete],hooks:{probeState:'completed'}});
const selector={sessionId:saved.id,titles:['A'],cascade:false};
await once.data.recovery.fileRerun(selector,'stable-request');
for(let i=0;i<100;i++)await new Promise(r=>setImmediate(r));
assert.equal(once.data.submitted.length,1);
await once.data.recovery.fileRerun(selector,'stable-request');
for(let i=0;i<100;i++)await new Promise(r=>setImmediate(r));
assert.equal(once.data.submitted.length,1,'same durable rerun intent does not post again');
for(const key of ['removedAt','cancelledAt','cancelRequestedAt']){
 const removed=structuredClone(saved);removed.entries[0][key]=1;const closed=harness({queue:one,saved:removed,runs:[complete],hooks:{probeState:'completed'}});
 await assert.rejects(()=>closed.data.recovery.fileRerun(selector,'never-revive'),/删除|取消/);assert.equal(closed.data.submitted.length,0);
}
console.log('PASS actual queue hook: one timed-out source yields, independent chain submits, local rerun fences reject old tails, stable rerun request once, tombstones never revive. CPU only.');

const retiredRun={...complete,status:'failed',error:'已核实丢失：old writer misclassified an intentional hold'};
const retired=harness({queue:one,saved:structuredClone(saved),runs:[retiredRun],hooks:{probeState:'not_found',retiredHeldProof:true}});
await retired.data.recovery.fileRerun({sessionId:saved.id,titles:['A'],cascade:false},'proved-dequeued-repair');
for(let i=0;i<100;i++)await new Promise(r=>setImmediate(r));
assert.equal(retired.data.submitted.length,1,'positive dequeue-and-retirement proof permits the original node retry');
const unproved=harness({queue:one,saved:structuredClone(saved),runs:[retiredRun],hooks:{probeState:'not_found'}});
await assert.rejects(()=>unproved.data.recovery.fileRerun({sessionId:saved.id,titles:['A'],cascade:false},'unproved'),/未确认终态/);
assert.equal(unproved.data.submitted.length,0,'history absence alone is still insufficient');
