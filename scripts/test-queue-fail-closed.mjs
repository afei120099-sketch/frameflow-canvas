import {bounded,boundedLock} from '../lib/operation-scope.ts';
import {entryDue,mergeSessionDelta,adoptSessionSnapshot} from '../lib/queue-entry-state.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {prepareInboxShotRetry,cancelInboxShot} from '../lib/inbox-shot-actions.ts';
import {SubmissionNotSentError,SubmissionUncertainError,ComfyConnectionError} from '../lib/ai-adapter.ts';
import {classifyQueueSubmissionError,QueuePersistenceError} from '../lib/queue-submission-policy.ts';
import {latestQueueRun,maySubmitQueueEntry,queueEntryUncertain,newQueueSession,queueNodePosition,queueRowKey,queueSessionKey,healPowerLossQueueEntries} from '../lib/shot-queue-session.ts';
import {queueGeneration,planShotReferences,shotQueueH3Props,parseShotQueue} from '../lib/shot-queue.ts';
import {queueFramePlan,queueFrameDescription,assertQueueFrameRemoval,QueueFrameWaitingError,waitForQueuePrimaries,resolveQueueFrameInputs,frameEntriesToResume,hasQueueFrameSources} from '../lib/shot-queue-frames.ts';
import {planInboxResume} from '../lib/inbox-resume-plan.ts';
import {missingPrimaryVoice} from '../lib/queue-voice-validation.ts';
import {PreparationUnavailableError} from '../lib/comfyui/preparation-connection.ts';
import {legacyPreparationNotSentCandidate,provenPreparationNotSent} from '../lib/preparation-not-sent.ts';
import {createQueueFrameRunObserver} from '../lib/queue-frame-run-observer.ts';
import {shotFileDisposition,prepareFileRerun} from '../lib/inbox-file-policy.ts';
import {releaseSettledSourceContinuations,rerunProbeAllows} from '../lib/comfy-lost-verdict.ts';
import {findReusableShots,planBatchStart} from '../lib/shot-queue-batch-plan.ts';
import {abortable,waitUntil,describeStop,STOP_EXIT_MS,FORCE_UNLOCK_NOTE} from '../lib/queue-stop.ts';

for(const error of [new SubmissionNotSentError(),new ComfyConnectionError('refused',{cause:{cause:{code:'ECONNREFUSED'}}})])assert.equal(classifyQueueSubmissionError(error),'not_sent');
for(const error of [new SubmissionUncertainError(),Error('node_errors'),new TypeError('unknown'),new ComfyConnectionError(),new ComfyConnectionError('reset',{cause:{code:'ECONNRESET'}}),new ComfyConnectionError('mixed',{cause:{errors:[{code:'ECONNREFUSED'},{code:'ETIMEDOUT'}]}}),{message:'not an error'},null])assert.equal(classifyQueueSubmissionError(error),'uncertain');
assert.equal(classifyQueueSubmissionError(new DOMException('stop','AbortError')),'aborted');
assert.equal(classifyQueueSubmissionError(new SubmissionNotSentError(),true),'aborted');
assert.equal(latestQueueRun({chapter:0,shot:0},[{status:'completed',createdAt:3}]),undefined,'unowned historical Runs never match an unbuilt entry');

const raw=()=>({version:'shot-queue-v1',title:'isolated G',defaults:{seed:123,megapixels:0.88},chapters:[{title:'first',shots:Array.from({length:3},(_,i)=>({title:'G-'+i,prompt:'CPU mock test',seconds:6,aspect:'16:9',roleIds:[],sceneAssetIds:[],autoVoiceDisabled:true}))}]});
const hookSource=readFileSync('components/use-shot-queue-execution.ts','utf8').replace(/^import .*;\r?\n/gm,'').replace('export function useShotQueueExecution','function useShotQueueExecution');
const code=ts.transpileModule(hookSource+'\nglobalThis.useQueue=useShotQueueExecution;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;

export function harness({queue=parseShotQueue(JSON.stringify(raw())),saved=null,failAt=-1,failure,storageFailure,assets=[],runs:initialRuns=[],readable=true,roles=[],hooks={}}={}){
  const data={saved:structuredClone(saved),metaWrites:[],runs:structuredClone(initialRuns),submitted:[],created:[],messages:[],blobReads:0,stopCalls:0,rows:{},focus:[],extractions:[],enhancements:[],pauseCalls:0};
  const editor={shapes:new Map(),getCurrentPageId:()=> 'page:g-test',getCurrentPageShapes(){return [...this.shapes.values()];},getShape(id){return this.shapes.get(id);},getShapePageBounds:()=>({x:0,y:0,w:717,h:824}),updateShape(patch){const old=this.shapes.get(patch.id);this.shapes.set(patch.id,{...old,...patch,props:{...old?.props,...patch.props},meta:{...old?.meta,...patch.meta}});},select(){},zoomToSelection(){},selectNone(){}};
  if(saved)for(const entry of saved.entries)if(entry.nodeId)editor.shapes.set(entry.nodeId,{id:entry.nodeId,type:'h3-node',meta:{},props:{},x:44,y:55});
  let call=0;
  const context=vm.createContext({Error,DOMException,AbortController,crypto,console,Map,Set,Promise,Date,JSON,Uint32Array,structuredClone,QueuePersistenceError,SubmissionUncertainError,classifyQueueSubmissionError,
    bounded,boundedLock,entryDue,adoptSessionSnapshot,
    abortable,waitUntil,describeStop,STOP_EXIT_MS,FORCE_UNLOCK_NOTE,
    checkQueueGate:hooks.checkQueueGate??(async()=>({ok:true})),
    fetchZhengbenVersion:hooks.fetchZhengbenVersion??(async()=>null),
    getSnapshot:()=>({document:{store:Object.fromEntries(editor.shapes)}}),
    recoverTailOutput:hooks.recoverTailOutput??(async()=>{throw Error('recoverTailOutput stub');}),
    retireInvalidHeldTail:hooks.retireInvalidHeldTail??(async()=>undefined),
    auditQueueFrame:hooks.auditQueueFrame??(async()=>({ok:true})),
    saveSessionDelta:async(value,before)=>{if(storageFailure?.(value))throw Error('fake disk full');const merged=data.saved?.id===value.id&&before?mergeSessionDelta(data.saved,value,before):structuredClone(value);data.metaWrites.push({key:queueSessionKey(value.pageId),value:structuredClone(merged)});data.saved=structuredClone(merged);return merged;},
    rememberFileSession:async()=>{},readInboxRootSnapshot:()=>hooks.controls??{},shotFileDisposition,prepareFileRerun,
    assertInboxSessionActive:id=>{if(hooks.stoppedSessionIds?.includes(id))throw new DOMException('batch stopped','AbortError');},subscribeInboxRootControl:()=>()=>{},
    waitForInboxRootControl:async(kind,guard)=>{guard?.();await hooks.rootGate?.(kind);guard?.();},
    prepareInboxShotRetry,cancelInboxShot,fetch:hooks.fetch,AbortSignal,planInboxResume,missingPrimaryVoice,PreparationUnavailableError,legacyPreparationNotSentCandidate,provenPreparationNotSent,beginInboxRequest:request=>{data.inboxRequest=request;},matchingInboxRequest:()=>data.inboxRequest??hooks.inboxRequest,reportInboxRequest(...args){hooks.inboxReport?.(...args);},
    registerInboxRecovery:(_page,controller)=>{data.recovery=controller;return()=>{};},diagnoseCanvasRecords:async()=>({checked:editor.shapes.size,matches:!hooks.saveMismatch,differences:hooks.saveMismatch?[{field:'props.h'}]:[]}),
    registerQueueRemovalCancel:(_page,controller)=>{data.removeQueueNodes=controller;return()=>{};},
    useValue:(_name,getter)=>getter(),useState:initial=>[initial===''?'page:g-test':initial,value=>{if(typeof value==='function')data.rows=value(data.rows);}],useRef:value=>({current:value}),useEffect(fn){if(/registerInboxRecovery|registerQueueRemovalCancel/.test(fn.toString()))fn();},
    getMeta:async()=>structuredClone(data.saved),putMeta:async(_key,value)=>{if(storageFailure?.(value))throw Error('fake disk full');data.metaWrites.push({key:_key,value:structuredClone(value)});if(!_key.startsWith('shot-queue-session-archive-v1:'))data.saved=structuredClone(value);},
    listRoles:async()=>roles,listRuns:async()=>structuredClone(data.runs),getAsset:async id=>assets.find(a=>a.assetId===id)??null,
    waitForCanvasSave:async()=>{},withLock:async(_key,fn)=>fn(),saveNodeForRun:()=> '148',updateRun:async(id,patch)=>{if(!hooks.allowRepair)throw Error('Run mutation forbidden');Object.assign(data.runs.find(r=>r.runId===id),patch);},
    comfyUIH3Adapter:{cancelPendingJobs:async()=>{data.stopCalls++;return[];},probeJob:async(id)=>({state:hooks.probeById?.[id]??hooks.probeState??'running'}),queueJobs:async()=>hooks.queueIds??(hooks.queueRunning?['other-job']:[]),queueSize:async()=>({running:hooks.queueRunning??0,pending:0})},
    readH3Automation:id=>({taskMode:'t2va',queueFrameToken:hooks.staleController?'stale':editor.shapes.get(id)?.meta?.shotQueueFrameToken,enqueue:async()=>{const n=call++;data.submitted.push(id);if(n===failAt)throw failure;const run={runId:'run-'+n,comfyPromptId:'fake-'+n,ownerNodeId:id,status:'queued',submission:'accepted',createdAt:Date.now()+n};data.runs.push(run);await hooks.accepted?.({data,run,editor,assets});return{runId:'run-'+n,promptId:'fake-'+n};}}),
    findReusableShots,planBatchStart,healPowerLossQueueEntries,
    queueGeneration,planShotReferences,shotQueueH3Props,latestQueueRun,maySubmitQueueEntry,queueEntryUncertain,newQueueSession,queueNodePosition,queueRowKey,queueSessionKey,
    queueFramePlan,queueFrameDescription,assertQueueFrameRemoval,QueueFrameWaitingError,waitForQueuePrimaries,resolveQueueFrameInputs,frameEntriesToResume,hasQueueFrameSources,createQueueFrameRunObserver,releaseSettledSourceContinuations,rerunProbeAllows,
    retiredHeldAllows:async()=>!!hooks.retiredHeldProof,
    enhanceQueueTailFrame:async(frame,checkpoint,guard)=>{guard();data.enhancements.push(frame.sourceAssetId);if(hooks.enhancementFailure)throw Error('mock HD failed');if(hooks.deferEnhancement?.(frame)){const promptId=frame.enhancement?.promptId??'hd-queued';await checkpoint({...frame,enhancement:{...frame.enhancement,originalAssetId:frame.enhancement?.originalAssetId??'original-'+frame.sourceAssetId,promptId}});const queued=new Error('尾帧高清仍在 ComfyUI 队列或处理中：'+promptId);queued.name='FrameEnhanceQueuedError';throw queued;}const enhanced={...frame,src:'image:hd-'+frame.sourceAssetId,width:frame.width*2,height:frame.height*2,enhancement:{originalAssetId:'original-'+frame.sourceAssetId,promptId:'hd-prompt',completedAssetId:'hd-'+frame.sourceAssetId}};await checkpoint(enhanced);return enhanced;},
    storeQueueFrame:async(dataUrl,name)=>{assert.ok(dataUrl.startsWith('data:image/'));(data.storedFrames??=[]).push(name);return 'image:frame-'+data.storedFrames.length;},
    getLocalVideoBlob:async(src)=>{data.blobReads++;const failure=await hooks.blobError?.(src);if(failure)throw failure;if(!readable)throw Error('unreadable');return new Blob(['fake video bytes'],{type:'video/mp4'});},
    extractVideoFrameAt:async (src,seconds)=>{assert.equal(seconds,Number.MAX_SAFE_INTEGER);data.extractions.push([src,'last']);return{dataUrl:'data:image/png;base64,ZmFrZS1sYXN0',seconds:5.999,width:320,height:180};},
    extractVideoFirstFrame:async src=>{data.extractions.push([src,'first']);return{dataUrl:'data:image/jpeg;base64,ZmFrZS1maXJzdA==',seconds:0,width:320,height:180};},
    setTimeout:fn=>{if(++data.pauseCalls>200)throw Error('test bounded wait exceeded');hooks.pause?.({data,editor,assets});queueMicrotask(fn);return 1;},clearTimeout(){},
  });
  vm.runInContext(code,context);
  const api=context.useQueue({editor,queue,restore(){},message:m=>data.messages.push(m),origin:()=>({x:11,y:22}),persistenceKey:'G-ISOLATED',focusNode:id=>data.focus.push(id),createNode:async(props,point)=>{const id='shape:g-'+(data.created.length+1);const node={id,type:'h3-node',props,...point,meta:{}};data.created.push(structuredClone(node));editor.shapes.set(id,node);return{id};}});
  return{data,api,editor,queue};
}

const proven=harness({failAt:1,failure:new SubmissionNotSentError()});
await proven.api.submitAll();
assert.equal(proven.data.submitted.length,3);assert.equal(proven.data.saved.entries[1].outcome,'failed');
assert.match(proven.data.messages.at(-1),/已入队 2 镜；明确失败 1 镜/);
await proven.api.retryFailed();
assert.equal(proven.data.submitted.length,4);assert.equal(proven.data.submitted[3],proven.data.submitted[1]);
assert.equal(proven.data.saved.entries[1].submissionState,'accepted');
for(const failure of [new SubmissionUncertainError(),new TypeError('unknown'),Error('node_errors'),new ComfyConnectionError('timeout')]){
  const h=harness({failAt:1,failure});await h.api.submitAll();
  assert.equal(h.data.submitted.length,2);assert.equal(h.data.saved.entries[1].outcome,'uncertain');
  assert.equal(h.data.saved.entries[2].submissionState,'pending');assert.match(h.data.messages.at(-1),/状态不明 1 镜/);assert.match(h.data.messages.at(-1),/尚未处理 1 镜/);
  const reload=harness({queue:h.queue,saved:h.data.saved,runs:h.data.runs});await reload.api.retryFailed();assert.equal(reload.data.submitted.length,0,'reload/retry never resubmits uncertain or fresh pending shots');
  await reload.api.submitAll();assert.equal(reload.data.submitted.length,0,'explicit continue must pause at the unresolved shot, not skip it and start later shots');
}
for(const stage of ['started','accepted']){
  const h=harness({storageFailure:value=>value.entries.some(e=>e.submissionState===stage)});await h.api.submitAll();
  assert.equal(h.data.submitted.length,stage==='started'?0:1);assert.match(h.data.messages.at(-1),/本地队列保存失败/);
  if(stage==='accepted'){assert.equal(h.data.saved.entries[0].submissionState,'started');const reload=harness({queue:h.queue,saved:h.data.saved});await reload.api.retryFailed();assert.equal(reload.data.submitted.length,0);}
}
const abort=harness({failAt:1,failure:new DOMException('stop','AbortError')});await abort.api.submitAll();assert.equal(abort.data.submitted.length,2);assert.equal(abort.data.saved.entries[1].outcome,undefined);assert.equal(abort.data.stopCalls,0);

const chapters=raw();chapters.chapters.push({title:'bad later chapter',shots:[{...chapters.chapters[0].shots[0],title:'later bad',sceneAssetIds:['missing']}]});
const scoped=harness({queue:parseShotQueue(JSON.stringify(chapters))});await scoped.api.submit(0);
assert.equal(scoped.data.created.length,3,'skip invalid node; do not fabricate empty references');assert.equal(scoped.data.submitted.length,3);assert.equal(scoped.data.saved.entries[3].outcome,'failed');assert.match(scoped.data.messages.at(-1),/已入队 3 镜；明确失败 0 镜/);
assert.ok(scoped.data.created.every((node,i)=>node.x===11+i*817),'global layout index remains unchanged');

// Retired 2026-11-10: video extension (generationMode 'extend') is rejected at parse time; cross-chapter sources now use firstFrameFrom.
const dependencyQueue=raw();dependencyQueue.chapters[0].shots=dependencyQueue.chapters[0].shots.slice(0,1);dependencyQueue.chapters.push({title:'next',shots:[{...dependencyQueue.chapters[0].shots[0],title:'extend',generationMode:'extend',sourceShot:'previous'}]});
assert.throws(()=>parseShotQueue(JSON.stringify(dependencyQueue)),/已停用/);
{
 const stoppedSessionIds=[];
 const h=harness({hooks:{stoppedSessionIds,accepted:async({data})=>{stoppedSessionIds.push(data.saved.id);}}});
 await h.api.submitAll();assert.equal(h.data.submitted.length,1);assert.equal(h.data.stopCalls,0,'do not cancel accepted ComfyUI queue');assert.equal(h.data.saved.stopSource,'root_stopSessions');assert.equal(h.data.saved.autoContinueFrames,false);
 await h.api.submitAll();assert.equal(h.data.submitted.length,1,'stopped session must not revive');
}
// A batch item 6: 「渲染这一镜」 already made G-1 (same title + prompt, video done) → a manual 入队 that chose 跳过 adopts that node.
{
  const runs=[{runId:'single',ownerNodeId:'shape:single',status:'completed',createdAt:5,outputAssetIds:['v1']}];
  for(const reuse of ['skip','rerender',undefined]){
    const h=harness({runs});
    h.editor.shapes.set('shape:single',{id:'shape:single',type:'h3-node',props:{shotTitle:'G-1',prompt:'CPU mock test'},meta:{},x:0,y:0});
    const plan=await h.api.previewStart();
    assert.equal(plan.newBatch,true);assert.equal(plan.total,3);assert.deepEqual(plan.reusable.map(r=>[r.title,r.nodeId,r.state]),[['G-1','shape:single','done']]);
    await h.api.submitAll(true,reuse);
    if(reuse==='skip'){
      assert.equal(h.data.created.length,2,'no second node for the shot that already has a video');
      assert.equal(h.data.submitted.includes('shape:single'),false,'reused node is not submitted again');
      assert.equal(h.data.submitted.length,2);
      const entry=h.data.saved.entries.find(e=>e.shot===1);assert.equal(entry.nodeId,'shape:single');assert.equal(entry.reusedNode,'done');
      assert.equal(h.editor.shapes.get('shape:single').meta.shotQueueSessionId,h.data.saved.id);
      assert.match(h.data.messages.join('|'),/已认领画布上 1 个/);
    }else{
      assert.equal(h.data.created.length,3,'re-render / inbox path keeps old behaviour');assert.equal(h.data.submitted.length,3);
    }
  }
  // Same queue as the saved session → continuing, not a new batch: nothing to ask.
  const q=parseShotQueue(JSON.stringify(raw()));const same=newQueueSession('page:g-test',q,{x:0,y:0});
  const h=harness({queue:q,saved:same});const plan=await h.api.previewStart();assert.equal(plan.newBatch,false);assert.deepEqual(plan.reusable,[]);
}
console.log('PASS G actual hook: whitelist and mixed causes, unknown pause, persisted uncertainty/reload, failed-only retry, before/after-submit IDB failure, Abort, chapter isolation, global layout, readable cross-chapter reuse and recycled refusal; no network/GPU');
