import {bounded,boundedLock,fetchBody,type OperationScope} from './operation-scope.ts';
import {saveSessionDelta} from './queue-session-store.ts';
import {entryDue} from './queue-entry-state.ts';
import {getSnapshot,type Editor} from 'tldraw';
import {getMeta,putMeta,patchMeta,updateRun,getRun,getAsset,listAllAssets,registerAsset,attachCompletedRunToShot,type RunRecord,type AssetRecord} from './production-records.ts';
import {queueSessionKey,latestQueueRun,maySubmitQueueEntry,type QueueSession} from './shot-queue-session.ts';
import {rememberFileSession,fileSessionIsCurrent} from './inbox-session-registry.ts';
import {nextComfyLostStreak,releaseSettledSourceContinuations,rearmVerifiedChainContinuations,isVerifiedComfyLoss,isComfyConnectionFailure,verifiedLossError,autoRetryAcceptsProbe,VERIFIED_COMFY_LOSS_ERROR,type ComfyLostStreak} from './comfy-lost-verdict.ts';
import {readInboxRecovery} from './inbox-queue-protocol.ts';
import {inboxBatchReport} from './inbox-batch-report.ts';
import {inboxReviewFrames} from './inbox-frame-review.ts';
import {waitForCanvasSave} from './canvas-library.ts';
import {comfyUIH3Adapter} from './comfyui/h3-adapter.ts';
import {finalizeRunOutput,saveNodeForRun} from './run-recovery.ts';
import {readVideoMetadata,storeLocalVideo} from './local-video-store.ts';
import {readMp4VideoFps,readMp4VideoTiming} from './video-fps.ts';
import {refreshInboxRootControl,rootSessionAllows,type InboxRootControl} from './inbox-root-control.ts';
import {shotFileDisposition,selectedKeys,type ShotSelector} from './inbox-file-policy.ts';
import {queueRowKey} from './shot-queue-session.ts';
import {reconcileComfyHolds,ComfyHoldNotSent,type HeldJob} from './inbox-comfy-hold.ts';
import {scheduledPromptFetch} from './comfyui/submission-scheduler.ts';
import {assertHeldGraphImages} from './held-image-integrity.ts';

const json=<T=Record<string,unknown>>(url:string,init?:RequestInit):Promise<T>=>fetchBody(url,init??{},r=>r.json() as Promise<T>,12000);
const fingerprint=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),n=>n.toString(16).padStart(2,'0')).join('');
type IndexedOutput={filename:string;subfolder:string;type:string};
export function createInboxFileService(editor:Editor,persistenceKey:string){
 let working=false,frameWorking=false,activatedAt=Date.now();let inspectionCursor=0,observeCursor=0,reconciling=false;
 const diagnostic:{phase:string;attemptId?:string;sessionId?:string;nodeId?:string;startedAt?:number;lastProgressAt?:number;lockName:string;error?:string}={phase:'idle',lockName:'frameflow-inbox-file-service-v2'};const effects:Record<string,unknown>={},framesDone=new Set<string>();
 // History keeps only a handful of rows. A prompt that already succeeded stays recoverable by filename after it is pushed out.
 const observation:{phase:string;startedAt?:number;lastProgressAt?:number;lastSuccessfulScanAt?:number;sessionId?:string;error?:string}={phase:'idle'};
 const OUTPUT_CACHE_TTL_MS=10_000;
 let outputIndex:Record<string,IndexedOutput>|undefined;
 let outputIndexAt=0;
 let historyOutputs:Record<string,IndexedOutput>|undefined;
 let historyOutputsAt=0;
 const collectMp4=(value:unknown,found:IndexedOutput[]=[])=>{
  if(!value||typeof value!=='object')return found;
  if(Array.isArray(value)){for(const item of value)collectMp4(item,found);return found;}
  const record=value as Record<string,unknown>;
  if(typeof record.filename==='string'&&record.filename.toLowerCase().endsWith('.mp4'))found.push({filename:record.filename,subfolder:typeof record.subfolder==='string'?record.subfolder:'',type:typeof record.type==='string'?record.type:'output'});
  else for(const child of Object.values(record))collectMp4(child,found);
  return found;
 };
 const knownOutput=async(promptId:string)=>{
  const now=Date.now();
  if(!historyOutputs||now-historyOutputsAt>=OUTPUT_CACHE_TTL_MS){
   const fresh:Record<string,IndexedOutput>={};
   try{
    const history=await json<Record<string,{status?:{status_str?:string};outputs?:unknown}>>('/comfyui/history?max_items=64');
    for(const [id,entry] of Object.entries(history)){
     if(entry?.status?.status_str!=='success')continue;
     const files=collectMp4(entry.outputs);
     const file=files.find(item=>item.filename.includes('-audio.mp4'))??files[0];
     if(file)fresh[id]=file;
    }
    historyOutputs=fresh;
    historyOutputsAt=now;
   }catch{
    if(!historyOutputs)historyOutputs=fresh;
    historyOutputsAt=now;
   }
  }
  return historyOutputs[promptId]??(await loadOutputIndex())[promptId];
 };
 const loadOutputIndex=async()=>{
  const now=Date.now();
  if(outputIndex&&now-outputIndexAt<OUTPUT_CACHE_TTL_MS)return outputIndex;
  const found:Record<string,IndexedOutput>={};
  try{
   const {projects}=await json<{projects:string[]}>('/api/inbox?op=projects');
   for(const project of projects){
    const body=await json<{files?:Record<string,IndexedOutput>}>('/api/inbox?'+new URLSearchParams({op:'file',project,name:'_comfy_output_index.json'})).catch(()=>null);
    for(const [id,file] of Object.entries(body?.files??{}))if(file&&typeof file.filename==='string'&&file.filename.toLowerCase().endsWith('.mp4'))found[id]={filename:file.filename,subfolder:typeof file.subfolder==='string'?file.subfolder:'',type:typeof file.type==='string'?file.type:'output'};
   }
   outputIndex=found;
   outputIndexAt=now;
  }catch{/* A missing index must not block a prompt that is still in /history. */}
  return found;
 };
 const noteLostPrompts=async(batch:QueueSession,runs:RunRecord[],trackLoss:boolean,scope:OperationScope)=>{
  const before=structuredClone(batch),check=()=>scope.check();
  const held=new Set((await getMeta<HeldJob[]>('inbox-file-held-comfy')??[]).filter(j=>['held','deleting','restoring','uncertain'].includes(j.state)).map(j=>j.promptId));check();
  const inspectable=batch.entries.filter(entry=>{const run=latestQueueRun(entry,runs);return run&&['queued','running','failed'].includes(run.status);});
  const selected=new Set(inspectable.length?Array.from({length:Math.min(2,inspectable.length)},(_,i)=>inspectable[(inspectionCursor+i)%inspectable.length]):[]);inspectionCursor+=2;
  let harvested=0;
  let dirty=false;
  for(const entry of batch.entries){
   check();if(!selected.has(entry))continue;observation.sessionId=batch.id;observation.phase='reconciling_original_prompt';observation.lastProgressAt=Date.now();
   if(entry.removedAt||entry.cancelledAt||entry.cancelRequestedAt)continue;
   const run=latestQueueRun(entry,runs);
   if(run?.comfyPromptId&&held.has(run.comfyPromptId))continue; // A deliberate dequeue is neither loss nor permission to retry.
   const active=run?.status==='queued'||run?.status==='running';
   const failedAbsent=run?.status==='failed'&&!isVerifiedComfyLoss(run);
   // A reserved prompt was never accepted. The one exception is a failed connection:
   // the prompt id exists, Comfy may have restarted, and the same 3-miss rule can close it.
   const connectionFailed=!!run&&run.status==='failed'&&isComfyConnectionFailure(run.error)&&!isVerifiedComfyLoss(run);
   if(!run?.comfyPromptId||(!active&&!failedAbsent))continue;
   if(run.submission==='reserved'&&!connectionFailed)continue;
   if(run.status==='queued'&&run.submission!=='accepted')continue;
   let probe:{state:string;file?:import('./comfyui/h3-adapter.ts').ComfyFile;error?:string}|undefined;
   if(active&&run.submission==='accepted'){const known=await knownOutput(run.comfyPromptId);if(known)probe={state:'completed',file:known};}
   // A batch that does not own the page slot is harvested only. Do not probe its unfinished or failed rows into a loss streak.
   if(!probe&&!trackLoss)continue;
   if(!probe){try{probe=await comfyUIH3Adapter.probeJob(run.comfyPromptId,saveNodeForRun(run));}catch{continue;}}
   if(!probe)continue;check();
   if(probe.state==='completed'&&probe.file&&(run.status==='queued'||run.status==='running')){
    try{
     const result=await finalizeRunOutput(run.runId,{getRun,getAsset,listAssets:(kind?:AssetRecord['kind'])=>listAllAssets(kind),updateRun},async (current,attemptSignal)=>{
      const check=()=>{scope.check();attemptSignal?.throwIfAborted();};
      check();
      const output=await comfyUIH3Adapter.fetchOutputFile(probe!.file!,attemptSignal);check();
      // Prefer the MP4 boxes. A video element that never fires loadedmetadata must not sit inside the output lock.
      const timing=await readMp4VideoTiming(output.video).catch(()=>null);
      const metadata=timing?.fps?null:await bounded(async()=>readVideoMetadata(output.video).catch(()=>null),8000,attemptSignal,'取片元数据');check();
      const fps=timing?.fps??await readMp4VideoFps(output.video).catch(()=>null);
      check();const src=await storeLocalVideo(output.video,output.filename,attemptSignal);check();
      const duration=metadata?Number.parseFloat(metadata.duration):timing&&timing.fps?timing.frames/timing.fps:NaN;
      const width=metadata?.width??timing?.width??0;
      const height=metadata?.height??timing?.height??0;
      return registerAsset({kind:'video',origin:'generated',filename:output.filename,mimeType:'video/mp4',storageReference:src,sourceRunId:current.runId,shotId:current.shotId,...(width?{width}:{}),...(height?{height}:{}),...(Number.isFinite(duration)?{duration}:{}),fps:fps??(typeof current.parameters?.fps==='number'?current.parameters.fps:24),fileSize:output.video.size},attemptSignal);
     },scope.signal);check();
     run.status='completed';run.outputAssetIds=result.run.outputAssetIds;run.completedAt=result.run.completedAt??Date.now();run.error=null;
     if(result.run.shotId)await attachCompletedRunToShot(result.run.shotId,result.run.runId);
     effects['harvest:'+run.runId]={state:'completed',promptId:run.comfyPromptId,assetId:result.asset.assetId};
     dirty=true;harvested++;
    }catch(error){effects['harvest:'+run.runId]={state:'error',error:String(error)};}
    continue;
   }
   if(!trackLoss)continue;
   const streakKey='comfy-lost-streak:'+run.runId+':'+run.comfyPromptId;
   const previous=await getMeta<ComfyLostStreak>(streakKey);
   const next=nextComfyLostStreak(previous,run.comfyPromptId,probe.state==='not_found'?'not_found':'present',Date.now());
   const streakChanged=!previous||previous.promptId!==next.promptId||previous.misses!==next.misses||previous.verified!==next.verified;
   if(streakChanged&&(next.misses>0||previous))await putMeta(streakKey,next,scope.signal);
   if(!next.verified||previous?.verified)continue;
   check();
   entry.outcome='uncertain';entry.error='原 promptId 不在当前队列或保留历史中，待核实；不自动重提';
   effects['comfy-lost:'+run.runId]={state:'unconfirmed',promptId:run.comfyPromptId,misses:next.misses};
   dirty=true;
  }
  // A displaced batch is harvested only. Do not rewrite its loss bookkeeping or release tails until it is the page slot again.
  if(!trackLoss&&!harvested)return harvested;
  // A failed run stays accepted until rerunShots. Pending here would make fileResume enqueue it.
  // Clearing outcome also lifts the batch fence: one uncertain shot otherwise aborts every later title.
  if(rearmVerifiedChainContinuations(batch,runs))dirty=true;
  if(releaseSettledSourceContinuations(batch,runs))dirty=true;
  if(!dirty)return harvested;
  check();await saveSessionDelta(batch,before,{signal:scope.signal});
  return harvested;
 };
 const switchTo=async(batch:QueueSession,signal?:AbortSignal)=>{
  signal?.throwIfAborted();
  if(editor.getCurrentPageId()===batch.pageId){if(!await fileSessionIsCurrent(batch)){const controller=readInboxRecovery(batch.pageId);if(!controller?.activateFileSession)throw Error('原批次归档，等待受控激活入口');return controller.activateFileSession(batch,signal);}return true;}
  // Yield only the current local submission owner; no GPU cancel or stop flag.
  const controller=readInboxRecovery(editor.getCurrentPageId());if(controller?.yield&&!await controller.yield(signal))return false;
  await waitForCanvasSave(persistenceKey,new Map(Object.entries(getSnapshot(editor.store).document.store)));
  signal?.throwIfAborted();editor.setCurrentPage(batch.pageId as ReturnType<Editor['getCurrentPageId']>);return false;
 };
 const observe=async(sessions:QueueSession[],runs:RunRecord[],assets:AssetRecord[],control:InboxRootControl)=>{
  if(reconciling)return;reconciling=true;observation.startedAt=Date.now();
  try{await boundedLock('frameflow-inbox-file-observer-v3',async scope=>{
    // The page slot can be replaced by a later one-shot queue. Harvest still belongs to the batch that owns the accepted prompt, otherwise Comfy success stays "running" forever.
    const active=sessions.filter(batch=>!batch.stoppedAt&&batch.autoContinueFrames===true);
    if(active.length){const batch=structuredClone(active[observeCursor++%active.length]);observation.sessionId=batch.id;const tracked=await fileSessionIsCurrent(batch)||!!await getMeta('inbox-file-authorized:'+batch.id);const harvested=await noteLostPrompts(batch,runs,tracked,scope);scope.check();if(harvested&&!tracked&&batch.entries.some(entry=>maySubmitQueueEntry(entry,runs)&&shotFileDisposition(batch,queueRowKey(entry),control)==='ready'))await putMeta('inbox-file-authorized:'+batch.id,true,scope.signal);}
    scope.check();observation.phase='publishing_reports';observation.lastProgressAt=Date.now();
    const locations=new Map<string,{project:string;requestId:string}>();
    try{
    const {projects}=await json('/api/inbox?op=projects',{signal:scope.signal}) as {projects:string[]};
    for(const project of projects){const state=await json<{queues?:Record<string,{sessionId?:string;requestId?:string}>}>('/api/inbox?'+new URLSearchParams({op:'file',project,name:'_inbox_state.json'}),{signal:scope.signal}).catch(()=>null);for(const receipt of Object.values(state?.queues??{}))if(receipt.sessionId)locations.set(receipt.sessionId,{project,requestId:receipt.requestId??''});}
    for(const batch of sessions)if(!locations.has(batch.id)){const known=await getMeta<{project:string;requestId:string}>('inbox-file-location:'+batch.id);if(known)locations.set(batch.id,known);}
    scope.check();observation.lastSuccessfulScanAt=Date.now();observation.error=undefined;delete effects.observation;delete effects.inbox;
    // Reports for all known batches, no page switching required.
    for(const batch of sessions){const location=locations.get(batch.id);if(!location)continue;
     const heldIds=new Set((effects.pauseSessions as {state:string;promptId:string}[]??[]).filter(job=>job.state==='held').map(job=>job.promptId));
     const report={...inboxBatchReport(batch,runs,assets,control,heldIds),observedAt:Date.now(),retryHistory:await Promise.all(batch.entries.map(async e=>({nodeId:e.nodeId,record:await getMeta('inbox-auto-retry:'+batch.id+':'+e.nodeId)})))};
     const publish=(frames?:unknown,signal:AbortSignal=scope.signal)=>json('/__inbox/artifacts',{method:'POST',headers:{'content-type':'application/json'},signal,body:JSON.stringify({project:location.project,batch:report,...(frames?{frames}:{})})});
     scope.check();await publish();scope.check();
     const shot=report.shots.find(s=>s.state==='completed'&&s.runId&&!framesDone.has(s.runId)&&s.outputs.some(o=>o.available));
     if(shot?.runId&&!frameWorking&&!batch.stoppedAt&&batch.autoContinueFrames===true&&(await fileSessionIsCurrent(batch)||await getMeta('inbox-file-authorized:'+batch.id))){const key='inbox-review-frames:'+shot.runId;if(await getMeta(key))framesDone.add(shot.runId);else{frameWorking=true;void bounded(async frameScope=>{try{const images=await inboxReviewFrames(shot.outputs.find(o=>o.available)!.storageReference);const title=(shot.title??String(shot.index)).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,95)+'_'+shot.index;frameScope.check();const result=await publish({title,runId:shot.runId,images},frameScope.signal);frameScope.check();await putMeta(key,result,frameScope.signal);framesDone.add(shot.runId!);}catch(error){effects['frames:'+shot.runId]={state:'error',error:String(error)};framesDone.add(shot.runId!);}finally{frameWorking=false;}},25000,undefined,'预览帧报告').catch(error=>{effects['frames:'+shot.runId]={state:'error',error:String(error)};frameWorking=false;});}}
    }
    }catch(error){effects.inbox={state:'offline',at:new Date().toISOString(),message:String(error)};}

  },{workMs:30000,ifAvailable:true});}catch(error){observation.error=String(error);effects.observation={state:'error',error:String(error)};}finally{reconciling=false;observation.phase='idle';}
 };
 return{status:()=>({working,reconciling,activatedAt,diagnostic:{...diagnostic},observation:{...observation},effects}),tick:async(sessions:QueueSession[],runs:RunRecord[],assets:AssetRecord[],control:InboxRootControl)=>{
  if(working)return;working=true;const observed=observe(sessions,runs,assets,control);
  try{
   delete diagnostic.error;delete effects.error;diagnostic.attemptId=crypto.randomUUID();diagnostic.startedAt=Date.now();diagnostic.lastProgressAt=Date.now();diagnostic.phase='waiting_lock';
   await boundedLock('frameflow-inbox-file-service-v2',async scope=>{
    const mark=(phase:string)=>{scope.check();diagnostic.phase=phase;diagnostic.lastProgressAt=Date.now();};
    const checkpointMeta=async<T>(key:string,value:T)=>{scope.check();await putMeta(key,value,scope.signal);scope.check();};
    mark('reading_controls');
    activatedAt=await getMeta<number>('inbox-file-v2-activated')??activatedAt;await checkpointMeta('inbox-file-v2-activated',activatedAt);
    const explicitlySelected=new Set([...(control.priority??[]),...(control.pauseSessions??[]),...(control.rerunShots??[]).map(s=>s.sessionId),...(control.skipShots??[]).map(s=>s.sessionId)]);
    for(const batch of sessions)if(explicitlySelected.has(batch.id)&&!batch.stoppedAt&&batch.autoContinueFrames===true)await checkpointMeta('inbox-file-authorized:'+batch.id,true);
    for(const batch of sessions){const key='skip:'+batch.id;delete effects[key];for(const selector of (control.skipShots??[]).filter(s=>s.sessionId===batch.id))try{selectedKeys(batch,{...selector,cascade:false});}catch(error){effects[key]={state:'rejected',error:String(error),reason:'本批等待修正 skipShots 标题，其他批次继续'};}}
    const owned=new Map<string,string>();for(const batch of sessions)for(const entry of batch.entries){const run=latestQueueRun(entry,runs);if(run?.comfyPromptId)owned.set(run.comfyPromptId,batch.id);for(const frame of [entry.frameInputs?.first,entry.frameInputs?.last])if(frame?.enhancement?.promptId)owned.set(frame.enhancement.promptId,batch.id);}
    const blockedPrompts=sessions.flatMap(batch=>batch.entries.filter(entry=>shotFileDisposition(batch,queueRowKey(entry),control)!=='ready').flatMap(entry=>{const id=latestQueueRun(entry,runs)?.comfyPromptId;return id?[id]:[];}));
    effects.pauseSessions=await reconcileComfyHolds({...control,blockedPrompts},owned,{
      queue:()=>json<{queue_running:unknown[][];queue_pending:unknown[][]}>('/comfyui/queue',{signal:scope.signal}),history:async id=>!!(await json<Record<string,unknown>>('/comfyui/history/'+encodeURIComponent(id),{signal:scope.signal}))[id],
      load:async()=>{scope.check();return await getMeta<HeldJob[]>('inbox-file-held-comfy')??[];},save:jobs=>checkpointMeta('inbox-file-held-comfy',jobs),
      // ComfyUI returns an empty HTTP 200 here, not JSON. Parsing it would
      // misclassify a successful dequeue as a lost acknowledgement.
      remove:async ids=>{scope.check();const response=await fetch('/comfyui/queue',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({delete:ids}),signal:AbortSignal.any([scope.signal,AbortSignal.timeout(12000)])});if(!response.ok)throw Error(`移出等待队列:HTTP ${response.status}`);},
      restore:async(job,rank)=>{scope.check();const fresh=await refreshInboxRootControl();scope.check();if(!rootSessionAllows('automatic',job.sessionId,fresh)||fresh.stopSessions?.includes(job.sessionId))throw new ComfyHoldNotSent('门禁变更，仍未发送');
       const batch=sessions.find(s=>s.id===job.sessionId);if(!batch||batch.stoppedAt||batch.autoContinueFrames!==true)throw new ComfyHoldNotSent('原批已停止/缺失，不恢复领取任务');
       const run=runs.find(r=>r.comfyPromptId===job.promptId),entry=run&&batch.entries.find(e=>e.nodeId===run.ownerNodeId);if(run?.status==='cancelled'||entry&&(entry.removedAt||entry.cancelRequestedAt||entry.cancelledAt))throw new ComfyHoldNotSent('原镜头已删除或取消，不恢复');
       try{await assertHeldGraphImages(job.graph,scope.signal);}catch(error){throw new ComfyHoldNotSent('原领取任务图片完整性校验未通过，未发送：'+String(error));}
       const again=await refreshInboxRootControl();scope.check();if(!rootSessionAllows('automatic',job.sessionId,again))throw new ComfyHoldNotSent('核图期间门禁变更，仍未发送');
       const response=await scheduledPromptFetch('/comfyui/prompt',{method:'POST',headers:{'content-type':'application/json','x-frameflow-session-id':job.sessionId,'x-frameflow-control-kind':'automatic'},body:JSON.stringify({prompt:job.graph,prompt_id:job.promptId,extra_data:job.extraData,number:rank<0?job.number:-1e12+rank*1e8+Date.now()/1000}),signal:AbortSignal.any([scope.signal,AbortSignal.timeout(15000)])});if(response.status===423&&response.headers.get('x-frameflow-submission-held')==='1')throw new ComfyHoldNotSent('代理已确认未发送');if(!response.ok)throw Error('恢复原排队任务失败');const receipt=await response.json() as {prompt_id?:string};if(receipt.prompt_id!==job.promptId)throw Error('恢复回执ID不符，停止核实');}
    });
    // Edge-triggered intent: observing removal rearms only this interrupt command, never stop flags.
    mark('file_intents');
    const previousInterrupts=await getMeta<string[]>('inbox-interrupt-list')??[];
    for(const id of previousInterrupts)if(!control.interruptRunning?.includes(id)){const key='inbox-interrupt:'+id,previous=await getMeta(key);if(previous)await checkpointMeta(key,{state:'armed',previous});}
    await checkpointMeta('inbox-interrupt-list',control.interruptRunning??[]);
    for(const id of control.interruptRunning??[]){const batch=sessions.find(s=>s.id===id);if(!batch){effects['interrupt:'+id]={state:'not_found'};continue;}const key='inbox-interrupt:'+id,prior=await getMeta<{state:string}>(key);if(prior&&prior.state!=='armed'){effects['interrupt:'+id]={state:'already_consumed',receipt:prior};continue;}
     const queue=await json<{queue_running:unknown[][]}>('/comfyui/queue');const active=queue.queue_running?.filter((job:unknown[])=>owned.get(String(job[1]))===id)??[];
     if(active.length!==1){effects['interrupt:'+id]={state:'waiting',reason:'未发现唯一匹配的运行任务'};continue;}
     const promptId=active[0][1] as string;await checkpointMeta(key,{state:'sending',promptId,at:Date.now()});
     try{const response=await json<{cancelled?:boolean}>('/comfyui/api/jobs/'+encodeURIComponent(promptId)+'/cancel',{method:'POST'});if(response.cancelled!==true)throw Error('未确认单任务取消');await checkpointMeta(key,{state:'accepted',promptId,at:Date.now()});effects['interrupt:'+id]={state:'accepted',promptId};}catch(error){effects['interrupt:'+id]={state:'uncertain',promptId,error:String(error)};}
    }
    if(control.stop||!control.effective.submit)return;
    const candidates=[...sessions].sort((a,b)=>{const rank=(s:QueueSession)=>{const i=control.priority?.indexOf(s.id)??-1;return i<0?9999:i;};return rank(a)-rank(b);});
    for(const batch of candidates){if(batch.stoppedAt||batch.autoContinueFrames!==true||control.stopSessions?.includes(batch.id)||control.pauseSessions?.includes(batch.id))continue;
     if(!await fileSessionIsCurrent(batch)&&!await getMeta('inbox-file-authorized:'+batch.id))continue;
     const selectors=(control.rerunShots??[]).filter(s=>s.sessionId===batch.id);
     const explicitPending:ShotSelector[]=[];for(const selector of selectors){const id=selector.requestId??await fingerprint(selector),prior=await getMeta<{state:string}>('inbox-file-rerun:'+batch.id+':'+id);if(!prior||!['accepted','rejected'].includes(prior.state))explicitPending.push(selector);}
     const failed=batch.entries.map(e=>latestQueueRun(e,runs)).filter((r):r is RunRecord=>!!r&&r.status==='failed'&&(r.completedAt??0)>=activatedAt);
     for(const run of failed){const max=control.retry?.maxRetries??1,key='inbox-auto-retry:'+batch.id+':'+run.ownerNodeId;const record=await getMeta<{count:number;errors:unknown[];seen:string[]}>(key)??{count:0,errors:[],seen:[]};
      const ownedEntry=batch.entries.find(e=>e.nodeId===run.ownerNodeId)!;
      if(ownedEntry.submissionState==='pending'&&ownedEntry.rerun?.previousRunId===run.runId||explicitPending.some(selector=>selectedKeys(batch,selector).has(queueRowKey(ownedEntry))))continue;
      if(record.seen.includes(run.runId)){const entry=batch.entries.find(e=>e.nodeId===run.ownerNodeId)!;selectors.push({sessionId:batch.id,titles:[batch.queue.chapters[entry.chapter].shots[entry.shot].title],cascade:false,requestId:'auto-retry-'+run.runId});continue;}
      if(record.count>=max)continue;
      const history=await json('/comfyui/history/'+encodeURIComponent(run.comfyPromptId??''));const probe=await comfyUIH3Adapter.probeJob(run.comfyPromptId!,saveNodeForRun(run));if(!autoRetryAcceptsProbe(run,probe.state))continue;
      record.errors.push({runId:run.runId,promptId:run.comfyPromptId,error:run.error,history,at:Date.now()});record.seen.push(run.runId);record.count++;await checkpointMeta(key,record);
      const entry=batch.entries.find(e=>e.nodeId===run.ownerNodeId)!;selectors.push({sessionId:batch.id,titles:[batch.queue.chapters[entry.chapter].shots[entry.shot].title],cascade:false,requestId:'auto-retry-'+run.runId});
     }
     for(const selector of selectors){const requestId=selector.requestId??await fingerprint(selector),key='inbox-file-rerun:'+batch.id+':'+requestId;
      const prior=await getMeta<{state:string}>(key);if(prior?.state==='accepted'||prior?.state==='rejected'){effects[key]=prior;continue;}
      if(!await switchTo(batch,scope.signal)){effects[key]={state:'waiting_page'};return;}
      const controller=readInboxRecovery(batch.pageId);if(!controller?.fileRerun){effects[key]={state:'waiting_controller'};return;}
      try{const result=await controller.fileRerun(selector,requestId,scope.signal) as {state:string};effects[key]=result;if(result.state==='accepted')await checkpointMeta(key,{...result,acceptedAt:Date.now(),meaning:'intent_persisted_not_gpu_receipt'});}catch(error){const result={state:'rejected',error:String(error)};await checkpointMeta(key,result);effects[key]=result;}return;
     }
     const actionable=batch.entries.some(e=>entryDue(e)&&maySubmitQueueEntry(e,runs)&&shotFileDisposition(batch,queueRowKey(e),control)==='ready');
     if(actionable&&(editor.getCurrentPageId()===batch.pageId||batch.queue.autoSwitchPage||control.priority?.includes(batch.id))){if(!await switchTo(batch,scope.signal))return;const controller=readInboxRecovery(batch.pageId);if(controller?.fileResume)effects['resume:'+batch.id]=await controller.fileResume(batch.id,scope.signal);return;}
    }
   },{workMs:30000,ifAvailable:true});
  }catch(error){diagnostic.error=String(error);effects.error={at:new Date().toISOString(),message:String(error)};}finally{diagnostic.phase='idle';diagnostic.lastProgressAt=Date.now();working=false;await observed;}
 }};
}
