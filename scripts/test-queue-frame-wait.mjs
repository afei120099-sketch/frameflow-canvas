import assert from 'node:assert/strict';
import {createQueueFrameRunObserver} from '../lib/queue-frame-run-observer.ts';
import {waitForQueuePrimaries,resolveQueueFrameInputs,frameEntriesToResume,QueueFrameWaitingError} from '../lib/shot-queue-frames.ts';
import {SubmissionUncertainError,ComfyConnectionError} from '../lib/ai-adapter.ts';
import {parseShotQueue} from '../lib/shot-queue.ts';
import {newQueueSession} from '../lib/shot-queue-session.ts';
import {harness} from './test-queue-fail-closed.mjs';

// No network, production DB, real timers or GPU submission.
const run={runId:'source-run',comfyPromptId:'original-prompt',ownerNodeId:'node:source',status:'queued',submission:'accepted',createdAt:1,startedAt:2,outputAssetIds:[]};
let now=0,calls=0,state='queued';
const observer=createQueueFrameRunObserver(async r=>{assert.equal(r.comfyPromptId,'original-prompt');calls++;if(state==='offline')throw new ComfyConnectionError('connection lost');return{state};},{now:()=>now,pollMs:5000});
assert.equal(await observer(run),'queued');assert.equal(await observer(run),'queued');assert.equal(calls,1,'same poll interval is cached');
now+=12*60*60*1000;assert.equal(await observer(run),'queued','a half-day wait is still normal queued state');
state='running';now+=5000;assert.equal(await observer(run),'running');
now+=12*60*60*1000;assert.equal(await observer(run),'running','long execution alone is never uncertainty');
state='not_found';now+=5000;assert.equal(await observer(run),'checking');
state='offline';now+=5000;assert.equal(await observer(run),'waiting_connection');
state='not_found';now+=5000;assert.equal(await observer(run),'checking','network failure breaks consecutive successful misses');
now+=5000;assert.equal(await observer(run),'not_found');
state='queued';now+=5000;assert.equal(await observer(run),'queued');
state='completed';now+=5000;assert.equal(await observer(run),'completed');
assert.equal(await observer({...run,submission:'reserved'}),'unconfirmed');
assert.equal(await observer({...run,comfyPromptId:null}),'unconfirmed');
assert.equal(await observer({...run,status:'cancelled'}),'failed');
for(const error of [new TypeError('programming error'),new SyntaxError('invalid history'),Error('HTTP 403')]){
  const broken=createQueueFrameRunObserver(async()=>{throw error;});
  await assert.rejects(()=>broken(run),e=>e===error,'unknown errors are not hidden as network waits');
}

const shot=(title,extra={})=>({title,prompt:'CPU-only frame wait regression',seconds:6,aspect:'16:9',roleIds:[],sceneAssetIds:[],autoVoiceDisabled:true,...extra});
const queue=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'isolated frame wait',chapters:[{title:'test',shots:[shot('source'),shot('tail',{generationMode:'first-last',firstFrameFrom:{shot:'source',frame:'last'}})]}]}));
const batch=()=>{const b=newQueueSession('page:g-test',queue,{x:0,y:0});b.entries[0].nodeId='node:source';b.entries[0].submissionState='accepted';b.entries[1].nodeId='node:tail';return b;};
const asset={assetId:'source-video',kind:'video',filename:'source.mp4',storageReference:'media:source'};
const completed={...run,status:'completed',outputAssetIds:[asset.assetId]};
const io={guard(){},runs:async()=>[completed],asset:async()=>asset,read:async()=>new Blob(['fixture']),pause:async()=>{throw Error('unexpected wait');},extract:async()=>({dataUrl:'data:image/png;base64,WA==',seconds:5.99,width:320,height:180})};

// Both the phase-1 barrier and direct source resolution survive long normal work
// and temporary disconnection; they proceed only after the actual local output exists.
for(const sourceStatus of ['queued','running']){
  const b=batch();let polls=0,reads=0;
  const sequence=['waiting_connection',sourceStatus,'completed'];
  const waiting={...io,runs:async()=>[polls>=3?completed:{...run,status:sourceStatus}],observeRun:async()=>sequence[polls],onWaiting(){},pause:async()=>{if(++polls>3)throw Error('unbounded test loop');},read:async()=>{reads++;return new Blob(['fixture']);}};
  await waitForQueuePrimaries(b,waiting);assert.equal(polls,3);assert.equal(reads,0,'server completed does not skip local output confirmation');assert.equal(b.entries[0].outcome,undefined);
  const live={...io,runs:async()=>[{...run,status:sourceStatus}],observeRun:async()=>sourceStatus,pause:async()=>{throw Error('live source must not pin the frame resolver');},read:async()=>{reads++;return new Blob(['fixture']);}};
  await assert.rejects(()=>resolveQueueFrameInputs(b,b.entries[1],live),/仍在排队或处理中/);
  assert.equal(reads,0,'a queued or running source is not extracted');
  const inputs=await resolveQueueFrameInputs(b,b.entries[1],{...io,pause:async()=>{throw Error('completed source must not wait');},read:async()=>{reads++;return new Blob(['fixture']);}});
  assert.equal(inputs.first.sourceRunId,run.runId);assert.equal(reads,1);
}
for(const observed of ['not_found','unconfirmed','failed']){
  const b=batch();const unknown={...io,runs:async()=>[run],observeRun:async()=>observed};
  await waitForQueuePrimaries(b,unknown); // Unrelated sources may proceed; this one cannot.
  await assert.rejects(()=>resolveQueueFrameInputs(b,b.entries[1],unknown),observed==='failed'?QueueFrameWaitingError:SubmissionUncertainError);
}
for(const which of [0,1]){
  const b=batch();b.entries[which].removedAt=1;
  await assert.rejects(()=>resolveQueueFrameInputs(b,b.entries[1],io),/已删除/);
}
const cancelledTarget=batch();cancelledTarget.entries[1].outcome='failed';
const cancelledRun={...run,runId:'cancelled-tail',ownerNodeId:'node:tail',status:'cancelled'};
assert.deepEqual(frameEntriesToResume(cancelledTarget,[completed,cancelledRun]),[]);
const stopped=harness({queue,saved:cancelledTarget,runs:[completed,cancelledRun],assets:[asset]});await stopped.api.resumeFrames();assert.equal(stopped.data.submitted.length,0,'actual auto-resume hook never revives a cancelled continuation');
const removed=batch();removed.entries[1].removedAt=1;
const removedHook=harness({queue,saved:removed,runs:[completed],assets:[asset]});await removedHook.api.resumeFrames();assert.equal(removedHook.data.submitted.length,0,'deleted continuation never auto-resumes');

// Actual hook: normal primary work older than the old deadline completes, then
// tail extraction + HD checkpoint + exactly one independent continuation follow.
const h=harness({queue,assets:[],hooks:{accepted({run,assets,data}){
  if(data.submitted.length===1){
    run.createdAt=Date.now()-24*60*60*1000;run.status='completed';run.outputAssetIds=['primary-output'];
    assets.push({assetId:'primary-output',kind:'video',filename:'primary.mp4',storageReference:'media:primary'});
    return;
  }
  run.status='completed';run.outputAssetIds=['tail-output'];assets.push({assetId:'tail-output',kind:'video',filename:'tail.mp4',storageReference:'media:tail'});
}}});
await h.api.submitAll();
assert.equal(h.data.submitted.length,2);assert.equal(new Set(h.data.submitted).size,2);assert.equal(h.data.enhancements.length,1);assert.equal(h.data.saved.entries[0].outcome,undefined);
assert.equal(h.data.pauseCalls,0,'a source that is already completed does not pin the scheduler');

// A waiting_frame continuation whose own source is already completed must extract and submit
// even while a different primary is still queued. No inherited frame, no submit.
{
  const readyQueue=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'ready tail',chapters:[{title:'one',shots:[
    shot('done'),shot('live'),shot('tail',{generationMode:'first-last',firstFrameFrom:{shot:'done',frame:'last'}}),
  ]}]}));
  const saved=newQueueSession('page:g-test',readyQueue,{x:0,y:0});
  saved.entries[0].nodeId='shape:done';saved.entries[0].submissionState='accepted';
  saved.entries[1].nodeId='shape:live';saved.entries[1].submissionState='accepted';
  saved.entries[2].nodeId='shape:tail';saved.entries[2].submissionState='pending';
  saved.entries[2].waitingReason='来源已重新结算，等待截取继承帧后再提交；没有继承首帧不会生成视频';
  const done={runId:'done',ownerNodeId:'shape:done',status:'completed',submission:'accepted',comfyPromptId:'p-done',createdAt:1,outputAssetIds:['vid-done']};
  const live={runId:'live',ownerNodeId:'shape:live',status:'queued',submission:'accepted',comfyPromptId:'p-live',createdAt:2,outputAssetIds:[]};
  const asset={assetId:'vid-done',kind:'video',filename:'done.mp4',storageReference:'media:done'};
  const ready=harness({queue:readyQueue,saved,runs:[done,live],assets:[asset]});
  await ready.api.resumeFrames();
  assert.deepEqual(ready.data.submitted,['shape:tail']);
  assert.deepEqual(ready.data.extractions,[['media:done','last']]);
  assert.equal(ready.data.pauseCalls,0,'a completed source does not wait for an unrelated queued primary');
  assert.equal(ready.data.runs.find(run=>run.runId==='live').status,'queued');
  assert.ok(ready.data.saved.entries[2].frameInputs.first.src.startsWith('image:'));
  const blocked=harness({queue:readyQueue,saved:structuredClone(saved),runs:[done,live],assets:[]});
  await blocked.api.resumeFrames();
  assert.equal(blocked.data.submitted.length,0,'missing source video never becomes a hard render');
  assert.match(blocked.data.saved.entries[2].waitingReason,/缺失|不唯一/);
}

// A tail whose HD prompt is still in Comfy's queue must not hold the scheduler.
// The next continuation, including one whose waitingReason was cleared back to pending, still extracts once.
{
  const two=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'two tails',chapters:[{title:'one',shots:[
    shot('doneA'),shot('doneB'),shot('live'),
    shot('tailA',{generationMode:'first-last',firstFrameFrom:{shot:'doneA',frame:'last'}}),
    shot('tailB',{generationMode:'first-last',firstFrameFrom:{shot:'doneB',frame:'last'}}),
  ]}]}));
  const saved=newQueueSession('page:g-test',two,{x:0,y:0});
  const ids=['shape:doneA','shape:doneB','shape:live','shape:tailA','shape:tailB'];
  saved.entries.forEach((entry,index)=>{entry.nodeId=ids[index];entry.submissionState=index<3?'accepted':'pending';});
  saved.entries[3].frameInputs={first:{src:'image:keep',name:'a.png',sourceNodeId:'shape:doneA',sourceShot:'doneA',sourceRunId:'run-a',sourceAssetId:'vid-a',sourceStorageReference:'media:a',sourceFrame:'last',seconds:1,width:8,height:8,enhancement:{originalAssetId:'orig-a',promptId:'99e2f374-6a7f-4cdf-a431-3e1277c1d956'}}};
  const runs=[
    {runId:'run-a',ownerNodeId:'shape:doneA',status:'completed',submission:'accepted',comfyPromptId:'p-a',createdAt:1,outputAssetIds:['vid-a']},
    {runId:'run-b',ownerNodeId:'shape:doneB',status:'completed',submission:'accepted',comfyPromptId:'p-b',createdAt:2,outputAssetIds:['vid-b']},
    {runId:'run-live',ownerNodeId:'shape:live',status:'queued',submission:'accepted',comfyPromptId:'p-live',createdAt:3,outputAssetIds:[]},
  ];
  const assets=[{assetId:'vid-a',kind:'video',filename:'a.mp4',storageReference:'media:a'},{assetId:'vid-b',kind:'video',filename:'b.mp4',storageReference:'media:b'}];
  assert.deepEqual(frameEntriesToResume(saved,runs).map(entry=>entry.nodeId),['shape:tailA','shape:tailB'],'pending with an empty waitingReason stays in the continuation loop');
  const ready=harness({queue:two,saved,runs,assets,hooks:{deferEnhancement:frame=>frame.enhancement?.promptId==='99e2f374-6a7f-4cdf-a431-3e1277c1d956'}});
  await ready.api.resumeFrames();
  assert.deepEqual(ready.data.submitted,['shape:tailB']);
  assert.deepEqual(ready.data.extractions,[['media:b','last']]);
  assert.equal(ready.data.extractions.filter(item=>item[0]==='media:a').length,0,'the reserved tail is not extracted again');
  assert.equal(ready.data.blobReads,1,'polling a reserved tail HD does not re-read the source video');
  assert.match(ready.data.saved.entries[3].waitingReason,/不会改用低清图，也不会重复提交/);
  assert.equal(ready.data.saved.entries[3].frameInputs.first.enhancement.promptId,'99e2f374-6a7f-4cdf-a431-3e1277c1d956');
  assert.equal(ready.data.saved.entries[3].frameInputs.first.src,'image:keep');
  assert.equal(ready.data.saved.entries[3].submissionState,'pending');
  assert.ok(ready.data.saved.entries[4].frameInputs.first.src.startsWith('image:'));
  assert.equal(ready.data.runs.find(run=>run.runId==='run-live').status,'queued');
  assert.equal(ready.data.pauseCalls,0,'a queued tail HD is not an in-place retry');
  await ready.api.resumeFrames();
  assert.deepEqual(ready.data.submitted,['shape:tailB'],'the second pass does not post the continuation again');
}

// An earlier continuation whose source is still queued must not pin later tails whose sources are already completed.
{
  const later=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'later ready tail',chapters:[{title:'one',shots:[
    shot('live'),shot('done'),
    shot('tailLive',{generationMode:'first-last',firstFrameFrom:{shot:'live',frame:'last'}}),
    shot('tailDone',{generationMode:'first-last',firstFrameFrom:{shot:'done',frame:'last'}}),
  ]}]}));
  const saved=newQueueSession('page:g-test',later,{x:0,y:0});
  const ids=['shape:live','shape:done','shape:tailLive','shape:tailDone'];
  saved.entries.forEach((entry,index)=>{entry.nodeId=ids[index];entry.submissionState=index<2?'accepted':'pending';});
  saved.entries[2].waitingReason='来源已重新结算，等待截取继承帧后再提交；没有继承首帧不会生成视频';
  const runs=[
    {runId:'run-live',ownerNodeId:'shape:live',status:'queued',submission:'accepted',comfyPromptId:'p-live',createdAt:1,outputAssetIds:[]},
    {runId:'run-done',ownerNodeId:'shape:done',status:'completed',submission:'accepted',comfyPromptId:'p-done',createdAt:2,outputAssetIds:['vid-done']},
  ];
  const assets=[{assetId:'vid-done',kind:'video',filename:'done.mp4',storageReference:'media:done'}];
  const pass=harness({queue:later,saved,runs,assets});
  await pass.api.resumeFrames();
  assert.deepEqual(pass.data.submitted,['shape:tailDone']);
  assert.deepEqual(pass.data.extractions,[['media:done','last']]);
  assert.equal(pass.data.saved.entries[2].frameInputs,undefined,'the live source is not extracted or hard-rendered');
  assert.match(pass.data.saved.entries[2].waitingReason,/仍在排队或处理中/);
  assert.ok(pass.data.saved.entries[3].frameInputs.first.src.startsWith('image:'));
  assert.equal(pass.data.pauseCalls,0,'a queued source yields the scheduler instead of waiting in place');
  assert.equal(pass.data.runs.find(run=>run.runId==='run-live').status,'queued');
  await pass.api.resumeFrames();
  assert.deepEqual(pass.data.submitted,['shape:tailDone'],'the ready tail is not posted twice while its source is still queued');
  pass.data.runs[0].status='completed';pass.data.runs[0].outputAssetIds=['vid-live'];
  assets.push({assetId:'vid-live',kind:'video',filename:'live.mp4',storageReference:'media:live'});
  await pass.api.resumeFrames();
  assert.deepEqual(pass.data.submitted,['shape:tailDone','shape:tailLive']);
  assert.deepEqual(pass.data.extractions.filter(item=>item[0]==='media:live'),[['media:live','last']]);
}

// A transient read of an earlier tail must not hold the only submit. The later tail whose source video is readable still submits once, with its own inherited frame.
{
  const stuck=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'io yield',chapters:[{title:'one',shots:[
    shot('doneA'),shot('doneB'),
    shot('tailA',{generationMode:'first-last',firstFrameFrom:{shot:'doneA',frame:'last'}}),
    shot('tailB',{generationMode:'first-last',firstFrameFrom:{shot:'doneB',frame:'last'}}),
  ]}]}));
  const saved=newQueueSession('page:g-test',stuck,{x:0,y:0});
  const ids=['shape:doneA','shape:doneB','shape:tailA','shape:tailB'];
  saved.entries.forEach((entry,index)=>{entry.nodeId=ids[index];entry.submissionState=index<2?'accepted':'pending';});
  const runs=[
    {runId:'run-a',ownerNodeId:'shape:doneA',status:'completed',submission:'accepted',comfyPromptId:'p-a',createdAt:1,outputAssetIds:['vid-a']},
    {runId:'run-b',ownerNodeId:'shape:doneB',status:'completed',submission:'accepted',comfyPromptId:'p-b',createdAt:2,outputAssetIds:['vid-b']},
  ];
  const assets=[{assetId:'vid-a',kind:'video',filename:'a.mp4',storageReference:'media:a'},{assetId:'vid-b',kind:'video',filename:'b.mp4',storageReference:'media:b'}];
  const ioYield=harness({queue:stuck,saved,runs,assets,hooks:{blobError:async src=>src==='media:a'?new TypeError('Failed to fetch'):null}});
  await ioYield.api.resumeFrames();
  assert.ok(ioYield.data.pauseCalls<40,'a transient tail read must not pin the scheduler');
  assert.match(ioYield.data.saved.entries[2].waitingReason,/无法读取或截帧/);
  assert.equal(ioYield.data.saved.entries[2].submissionState,'pending');
  assert.deepEqual(ioYield.data.submitted,['shape:tailB']);
  assert.equal(ioYield.data.saved.entries[3].submissionState,'accepted');
  assert.ok(String(ioYield.data.saved.entries[3].frameInputs.first.src).startsWith('image:'));
}
console.log('PASS frame wait: long queued/running -> completion -> HD -> continuation; throttled original-ID probes; disconnection/reconnect; consecutive missing evidence; local-output barrier; deleted/cancelled never revived. CPU mocks only.');
