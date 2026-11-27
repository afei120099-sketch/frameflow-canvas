import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseShotQueue,shotQueueH3Props,planShotReferences,shotQueueFrameExample} from '../lib/shot-queue.ts';
import {newQueueSession,queueRowKey} from '../lib/shot-queue-session.ts';
import {queueFramePlan,queueFrameDescription,queueFrameNodeWaiting,assertQueueFrameRemoval,QueueFrameWaitingError,resolveQueueFrameInputs,waitForQueuePrimaries,frameEntriesToResume,isTransientQueueFrameIoError} from '../lib/shot-queue-frames.ts';
import {harness} from './test-queue-fail-closed.mjs';

const shot=(title,extra={})=>({title,prompt:'仅CPU测试，不提交真实生成',roleIds:[],sceneAssetIds:[],seconds:6,aspect:'16:9',soundMode:'silent',autoVoiceDisabled:true,...extra});
const from=(name,frame='last')=>({shot:name,frame});
const make=(shots)=>parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'queue frames test',defaults:{seed:789,megapixels:0.88},chapters:[{title:'main and dependent',shots}]}));
const queue=make([shot('A'),shot('A2',{generationMode:'first-last',firstFrameFrom:from('A')}),shot('B'),shot('bridge',{generationMode:'first-last',firstFrameFrom:from('A'),lastFrameFrom:from('B','first')}),shot('A3',{generationMode:'first-last',firstFrameFrom:from('A2')})]);
const example=parseShotQueue(JSON.stringify(shotQueueFrameExample()));assert.equal(queueFramePlan(example).dynamic.length,3);assert.throws(()=>planShotReferences(example.chapters[0].shots[0],[],new Map()),/角色不存在/);
assert.deepEqual(queueFramePlan(queue).order,['0:0','0:2','0:1','0:3','0:4']);
assert.match(queueFrameDescription(queue.chapters[0].shots[3]),/首帧←A的尾帧；尾帧←B的首帧/);
assert.throws(()=>assertQueueFrameRemoval(queue,0,0),/仍依赖/);
assert.doesNotThrow(()=>assertQueueFrameRemoval(queue,0,4));
for(const shots of [
  [shot('A',{generationMode:'first-last',firstFrameFrom:from('A')})],
  [shot('A',{generationMode:'first-last',firstFrameFrom:from('B')}),shot('B',{generationMode:'first-last',firstFrameFrom:from('A')})],
  [shot('A'),shot('A'),shot('tail',{generationMode:'first-last',firstFrameFrom:from('A')})],
  [shot('A'),shot('tail',{generationMode:'first-last',firstFrameFrom:from('missing')})],
  [shot('A',{generationMode:'first-last',firstFrameFrom:from('previous')})],
  [shot('A'),shot('tail',{generationMode:'auto',firstFrameFrom:from('A')})],
  [shot('A'),shot('tail',{generationMode:'first-last',firstFrameFrom:from('A'),firstFrameAssetId:'static'})],
  [shot('A'),shot('tail',{generationMode:'first-last',firstFrameFrom:{shot:'A',frame:'middle'}})],
  [shot('A'),shot('tail',{generationMode:'first-last',firstFrameFrom:{shot:'A',frame:'last',typo:true}})],
  [shot('A'),shot('tail',{generationMode:'first-last',firstFrameFrom:from('A'),roleIds:['r1','r2','r3','r4','r5','r6'],sceneAssetIds:['s1','s2','s3']})],
]) assert.throws(()=>make(shots));
assert.equal(queueFramePlan(make([shot('A'),shot('tail',{generationMode:'first-last',firstFrameFrom:from('previous')})])).sourceKey('previous','0:1'),'0:0');
assert.match(queueFrameNodeWaiting({shotQueueFrameWaiting:true}),/等待队列提取来源视频画面/);
assert.match(queueFrameNodeWaiting({shotQueueFrameToken:'ready'},'stale'),/仍在加载/);
assert.equal(queueFrameNodeWaiting({shotQueueFrameWaiting:false,shotQueueFrameToken:'ready'},'ready'),'');
assert.equal(queueFrameNodeWaiting({}), '');

// Missing/recycled/ambiguous/empty/unreadable outputs never borrow another video's frame.
const ioQueue=make([shot('source'),shot('target',{generationMode:'first-last',firstFrameFrom:from('source')})]);
const ioSession=newQueueSession('page:isolated',ioQueue,{x:0,y:0});ioSession.entries[0].nodeId='node:source';ioSession.entries[0].submissionState='accepted';ioSession.entries[1].nodeId='node:target';
const sourceAsset={assetId:'v1',kind:'video',filename:'source.mp4',storageReference:'media:source'};
const sourceRun={runId:'source-run',ownerNodeId:'node:source',createdAt:1,status:'completed',outputAssetIds:['v1']};
for(const variant of ['missing','recycled','multiple','empty','unreadable','unknown','aborted']){
  let extracts=0;const runs=variant==='unknown'?[]:[{...sourceRun,...(variant==='multiple'?{outputAssetIds:['v1','v2']}:{})}];
  const io={guard(){if(variant==='aborted')throw new DOMException('stop','AbortError');},runs:async()=>runs,asset:async id=>variant==='missing'?null:{...sourceAsset,assetId:id,...(variant==='recycled'?{recycled:{at:1}}:{})},read:async()=>{if(variant==='unreadable')throw Error('unreadable');return new Blob(variant==='empty'?[]:['bytes']);},pause:async()=>{throw Error('unexpected unbounded wait');},extract:async()=>{extracts++;throw Error('must not extract');}};
  await assert.rejects(()=>resolveQueueFrameInputs(ioSession,ioSession.entries[1],io),variant==='unknown'?/状态不明/:variant==='aborted'?{name:'AbortError'}:QueueFrameWaitingError);
  assert.equal(extracts,0);
}
assert.equal(isTransientQueueFrameIoError(new TypeError('Failed to fetch')),true);
assert.equal(isTransientQueueFrameIoError(new Error('unreadable')),false);
assert.equal(isTransientQueueFrameIoError(new Error('视频文件为空')),false);
{
  let reads=0,pauses=0;
  const flaky={guard(){},runs:async()=>[sourceRun],asset:async()=>sourceAsset,read:async()=>{if(++reads<3)throw new TypeError('Failed to fetch');return new Blob(['bytes']);},pause:async()=>{pauses++;},extract:async()=>({dataUrl:'data:image/png;base64,WA==',seconds:1,width:320,height:180})};
  await assert.rejects(resolveQueueFrameInputs(ioSession,ioSession.entries[1],flaky),QueueFrameWaitingError);
  await assert.rejects(resolveQueueFrameInputs(ioSession,ioSession.entries[1],flaky),QueueFrameWaitingError);
  const inputs=await resolveQueueFrameInputs(ioSession,ioSession.entries[1],flaky);
  assert.equal(reads,3);assert.equal(pauses,0);assert.equal(inputs.first.sourceRunId,'source-run');
}
{
  let hd=0,pauses=0;
  const frozenSession=structuredClone(ioSession);
  frozenSession.entries[1].frameInputs={first:{src:'image:orig',name:'tail.png',sourceNodeId:'node:source',sourceShot:'source',sourceRunId:'source-run',sourceAssetId:'v1',sourceStorageReference:'media:source',sourceFrame:'last',seconds:5.8,width:320,height:180,enhancement:{originalAssetId:'orig',promptId:'hd-prompt'}}};
  const flakyHd={guard(){},runs:async()=>[sourceRun],asset:async()=>sourceAsset,read:async()=>new Blob(['bytes']),pause:async()=>{pauses++;},extract:async()=>{throw Error('must reuse frozen');},
    enhanceTail:async(input,checkpoint)=>{if(++hd<3)throw new TypeError('Failed to fetch');const done={...input,src:'image:hd',enhancement:{...input.enhancement,completedAssetId:'hd'}};await checkpoint(done);return done;}};
  await assert.rejects(resolveQueueFrameInputs(frozenSession,frozenSession.entries[1],flakyHd),QueueFrameWaitingError);
  await assert.rejects(resolveQueueFrameInputs(frozenSession,frozenSession.entries[1],flakyHd),QueueFrameWaitingError);
  const inputs=await resolveQueueFrameInputs(frozenSession,frozenSession.entries[1],flakyHd);
  assert.equal(hd,3);assert.equal(pauses,0);assert.equal(inputs.first.enhancement.completedAssetId,'hd');assert.equal(inputs.first.enhancement.promptId,'hd-prompt');
}

const assets=[];const markCompleted=({run,assets})=>{run.status='completed';run.outputAssetIds=['asset-'+run.ownerNodeId];assets.push({assetId:run.outputAssetIds[0],kind:'video',filename:run.ownerNodeId+'.mp4',storageReference:'media:'+run.ownerNodeId});};
let stage2Started=false;
const h=harness({queue,assets,hooks:{accepted(state){const node=state.editor.getShape(state.run.ownerNodeId),title=node.props.shotTitle;if(['A','B'].includes(title)){assert.equal(stage2Started,false);markCompleted(state);return;}stage2Started=true;assert.ok(state.data.runs.filter(r=>['A','B'].includes(state.editor.getShape(r.ownerNodeId).props.shotTitle)).every(r=>r.status==='completed'));markCompleted(state);}}});
await h.api.submitAll();
assert.deepEqual(h.data.submitted.map(id=>h.editor.getShape(id).props.shotTitle),['A','B','A2','bridge','A3']);
assert.equal(h.data.created.length,5);assert.equal(new Set(h.data.submitted).size,5);assert.equal(h.data.pauseCalls,0,'completed primaries are captured without parking the scheduler');
assert.equal(h.data.enhancements.length,3,'all three source tails enhanced; source FIRST frame remains unchanged');
for(const entry of h.data.saved.entries)for(const edge of ['first','last']){const frame=entry.frameInputs?.[edge];if(frame?.sourceFrame==='last'){assert.ok(frame.enhancement?.completedAssetId);assert.equal(frame.width,640);assert.equal(h.editor.getShape(entry.nodeId).props[edge==='first'?'videoFirstFrame':'videoLastFrame'].src,'image:hd-'+frame.sourceAssetId);}}
// Frames are stored as image assets; neither the session nor the nodes keep inline base64.
assert.ok(!JSON.stringify(h.data.saved).includes('data:image/'),'queue session must keep image: references, not base64');
for(const entry of h.data.saved.entries.filter(e=>e.nodeId))assert.ok(!JSON.stringify(h.editor.getShape(entry.nodeId).props).includes('data:image/'),'H3 node must keep image: references, not base64');
assert.equal(h.data.storedFrames.length,4,'every extracted frame is stored once');
assert.deepEqual(h.data.extractions,[['media:shape:g-1','last'],['media:shape:g-1','last'],['media:shape:g-3','first'],['media:shape:g-2','last']]);
for(const entry of h.data.saved.entries.filter(e=>e.frameInputs)) {
  const node=h.editor.getShape(entry.nodeId);assert.equal(node.meta.shotQueueFrameWaiting,false);assert.equal(node.meta.shotQueueFrameToken,entry.frameToken);
  assert.equal(node.props.workflowOptionId,'community-ultimate');assert.equal(node.props.ultimateKeyframes,true);assert.equal(node.props.seed,'789');assert.equal(node.props.megapixels,0.88);
  for(const edge of ['first','last'])if(entry.frameInputs[edge])assert.deepEqual(Object.keys(node.props[edge==='first'?'videoFirstFrame':'videoLastFrame']).sort(),['name','sourceNodeId','src']);
}
await h.api.submitAll();assert.equal(h.data.submitted.length,5,'continue cannot duplicate accepted/completed segments');assert.equal(h.data.extractions.length,4);
const reload=harness({queue,saved:h.data.saved,runs:h.data.runs,assets});await reload.api.submitAll();assert.equal(reload.data.submitted.length,0);

// Failed source blocks only its dependants; successful independent sources still run.
const badAssets=[];const bad=harness({queue,assets:badAssets,hooks:{accepted(state){if(state.editor.getShape(state.run.ownerNodeId).props.shotTitle==='A'){state.run.status='failed';return;}markCompleted(state);}}});
await bad.api.submitAll();assert.deepEqual(bad.data.submitted.map(id=>bad.editor.getShape(id).props.shotTitle),['A','B']);
assert.ok(bad.data.saved.entries.filter(e=>e.frameInputs===undefined&&e.shot!==0&&e.shot!==2).every(e=>e.waitingReason));
const mixed=make([shot('bad'),shot('good'),shot('blocked',{generationMode:'first-last',firstFrameFrom:from('bad')}),shot('independent',{generationMode:'first-last',firstFrameFrom:from('good')})]);
const independent=harness({queue:mixed,assets:[],hooks:{accepted(state){if(state.editor.getShape(state.run.ownerNodeId).props.shotTitle==='bad')state.run.status='failed';else markCompleted(state);}}});await independent.api.submitAll();assert.deepEqual(independent.data.submitted.map(id=>independent.editor.getShape(id).props.shotTitle),['bad','good','independent']);

// A primary left unsubmitted in another chapter must not skip continuations whose own source is done.
const partial=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'partial chapter',defaults:{seed:789,megapixels:0.88},chapters:[{title:'one',shots:[shot('A'),shot('tail',{generationMode:'first-last',firstFrameFrom:from('A')})]},{title:'two',shots:[shot('later')]}]}));
const chapterHarness=harness({queue:partial,assets:[],hooks:{accepted:markCompleted}});
await chapterHarness.api.submit(0);
assert.deepEqual(chapterHarness.data.submitted.map(id=>chapterHarness.editor.getShape(id).props.shotTitle),['A','tail']);
const partialSaved=newQueueSession('page:g-test',partial,{x:11,y:22});
partialSaved.entries[0].nodeId='shape:A';partialSaved.entries[0].submissionState='accepted';
partialSaved.entries[1].nodeId='shape:T';partialSaved.entries[1].submissionState='pending';
partialSaved.entries[2].nodeId='shape:L';partialSaved.entries[2].submissionState='pending';
const partialRun={runId:'a-run',ownerNodeId:'shape:A',status:'completed',createdAt:1,outputAssetIds:['v-a']};
const partialAsset={assetId:'v-a',kind:'video',filename:'a.mp4',storageReference:'media:a'};
assert.deepEqual(frameEntriesToResume(partialSaved,[partialRun]).map(entry=>entry.nodeId),['shape:T']);
const resumed=harness({queue:make([shot('Z')]),saved:partialSaved,runs:[partialRun],assets:[partialAsset],hooks:{accepted:markCompleted}});
await resumed.api.resumeFrames();
assert.equal(resumed.data.saved.id,partialSaved.id,'resume reuses the saved session and does not import a new batch');
assert.equal(resumed.data.created.length,0);
assert.deepEqual(resumed.data.submitted,['shape:T']);
// Wall-clock age does not turn normal queue/running time into uncertainty.
for (const status of ['queued','running']) {
  const timed=newQueueSession('page:long-wait',make([shot('A'),shot('tail',{generationMode:'first-last',firstFrameFrom:from('A')})]),{x:0,y:0});
  timed.entries[0].nodeId='node:A';timed.entries[0].submissionState='accepted';
  let pauses=0;
  await waitForQueuePrimaries(timed,{guard(){},runs:async()=>[{runId:'long',ownerNodeId:'node:A',status:pauses? 'completed':status,submission:'accepted',createdAt:Date.now()-24*60*60*1000,startedAt:Date.now()-12*60*60*1000}],observeRun:async()=>status,asset:async()=>null,read:async()=>new Blob(['x']),pause:async()=>{pauses++;},extract:async()=>{throw Error('no extract');}});
  assert.equal(pauses,1);assert.equal(timed.entries[0].outcome,undefined);assert.equal(timed.entries[0].error,undefined);
}

// Freeze specific successful output before submission; newer source candidates do not replace it on resume.
const saved=structuredClone(h.data.saved);for(const e of saved.entries.filter(e=>e.frameInputs)){e.submissionState='pending';e.outcome=undefined;}
const mainRuns=h.data.runs.filter(r=>['A','B'].includes(h.editor.getShape(r.ownerNodeId).props.shotTitle));
const retry=harness({queue,saved,runs:mainRuns,assets,hooks:{accepted:markCompleted}});await retry.api.submitAll();
assert.equal(retry.data.extractions.length,0,'persisted frames reused, including chained source if its old Run remains');
// A2 and bridge reuse frozen main inputs. A3 correctly waits if the pinned A2 Run was removed.
assert.equal(retry.data.submitted.length,2);assert.match(retry.data.saved.entries[4].waitingReason,/尚未成功/);

const pending=newQueueSession('page:g-test',queue,{x:1,y:2});
for(let i=0;i<pending.entries.length;i++){pending.entries[i].nodeId='saved-'+i;delete pending.entries[i].submissionState;}
const missing=harness({queue,saved:pending});await missing.api.submit(0);assert.equal(missing.data.submitted.length,0,'legacy prebuilt nodes lacking evidence do not submit');

// Validate role, scene, dialogue and independent per-segment settings survive props mapping unchanged.
const dialogue={roleId:'role1',text:'仅测试绑定'};
const configured=make([shot('A'),shot('tail',{generationMode:'first-last',firstFrameFrom:from('A'),roleIds:['role1'],sceneAssetIds:['scene'],soundMode:'av',autoVoiceDisabled:false,dialogue:[dialogue],workflow:'fast',seconds:8})]);
const roles=[{roleId:'role1',displayName:'测试角色',primaryAppearanceAssetId:'appearance'}], map=new Map([['appearance',{assetId:'appearance',kind:'image',filename:'face.png',storageReference:'image:face'}],['scene',{assetId:'scene',kind:'image',filename:'scene.png',storageReference:'image:scene'}]]);
const s=configured.chapters[0].shots[1],props=shotQueueH3Props(s,planShotReferences(s,roles,map),configured.defaults);
assert.deepEqual(props.roleIds,['role1']);assert.deepEqual(props.dialogueLines,[dialogue]);assert.equal(props.duration,'8');assert.equal(props.workflowOptionId,'community-dialogue');assert.equal(props.referenceImages[0].src,'image:scene');assert.equal(props.prompt,s.prompt);

// Stale controller cannot enqueue the updated frame inputs, even when its taskMode is already ready.
const only=make([shot('A'),shot('tail',{generationMode:'first-last',firstFrameFrom:from('A')})]);
const stale=harness({queue:only,assets:[],hooks:{accepted:markCompleted,staleController:true}});await stale.api.submitAll();assert.equal(stale.data.submitted.length,1);assert.match(stale.data.messages.at(-1),/节点暂未就绪/);

const source=readFileSync('components/use-shot-queue-execution.ts','utf8');
const persistIdx=source.indexOf('await save(batch); guard();')!==-1?source.indexOf('await save(batch); guard();'):source.indexOf('await persist(batch); guard();');
assert.ok(persistIdx!==-1&&persistIdx<source.indexOf('shotQueueFrameToken:entry.frameToken'),'frame inputs must persist before writing shotQueueFrameToken');
assert.ok(source.includes('cause.retryable && /无法读取或截帧/.test(cause.message)'),'I/O waiting_frame is recorded, then the pass moves on');
assert.ok(!/无法读取或截帧\/\.test\(cause\.message\)\) \{\s*await frameIO\.pause\(\);\s*continue;/.test(source),'a transient tail read must not pin the only submit controller');
assert.ok(source.includes('for(let attempt=0;attempt<150&&stopRef.current;attempt++){signal?.throwIfAborted();await sleep(200);}'),'rerunShots must wait for the current submit controller to finish after abort');
const hdFailure=harness({queue:ioQueue,assets:[],hooks:{accepted(state){markCompleted(state);},enhancementFailure:true}});
await hdFailure.api.submitAll();assert.equal(hdFailure.data.submitted.length,1,'HD failure never submits low-quality dependent H3');
assert.ok(hdFailure.data.saved.entries[1].frameInputs?.first,'original frame checkpointed before failed HD');
assert.match(hdFailure.data.saved.entries[1].waitingReason,/HD failed/);
assert.doesNotMatch(source,/concatenate|mergeVideos|createFinalCut/);
console.log('PASS queue frame phases: graph/forward/cycle validation, actual execution hook primary barrier, serial dependencies, independent outputs, waiting-source isolation, source pinning/reload, strict frame objects, settings retention and stale-controller fence; no network/GPU');
