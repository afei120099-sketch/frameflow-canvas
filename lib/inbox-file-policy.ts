import {queueFramePlan} from './shot-queue-frames.ts';
import {latestQueueRun,queueRowKey,type QueueSession} from './shot-queue-session.ts';
import type {RunRecord} from './production-records.ts';
export type ShotSelector={sessionId:string;titles:string[];cascade?:boolean;requestId?:string};
export type FileControls={pauseSessions?:string[];priority?:string[];interruptRunning?:string[];rerunShots?:ShotSelector[];skipShots?:ShotSelector[];retry?:{maxRetries:number}};
export function selectedKeys(batch:QueueSession,selector:ShotSelector){
 const keys=new Set<string>();
 for(const title of selector.titles){const matches=batch.entries.filter(e=>batch.queue.chapters[e.chapter].shots[e.shot].title===title);if(matches.length!==1)throw Error(`镜头标题不存在或不唯一：${title}`);keys.add(queueRowKey(matches[0]));}
 if(selector.cascade){let changed=true;while(changed){changed=false;for(const [key,deps]of dependencyMap(batch))if(!keys.has(key)&&deps.some(dep=>keys.has(dep))){keys.add(key);changed=true;}}}
 return keys;
}
export function dependencyMap(batch:QueueSession){
 const plan=queueFramePlan(batch.queue),result=new Map<string,string[]>();
 for(const entry of batch.entries){const key=queueRowKey(entry),shot=batch.queue.chapters[entry.chapter].shots[entry.shot];result.set(key,[shot.firstFrameFrom,shot.lastFrameFrom,shot.sourceShot].filter(Boolean).map(ref=>plan.sourceKey(ref!,key)));}
 return result;
}
export function shotFileDisposition(batch:QueueSession,key:string,controls:FileControls):'skip'|'waiting_upstream'|'ready'{
 const skipped=new Set<string>();
 // Bad file input must fail closed for this batch, not throw out the global
 // coordinator tick and starve unrelated sessions. The service reports it.
 for(const selector of (controls.skipShots??[]).filter(s=>s.sessionId===batch.id)){
  try{for(const selected of selectedKeys(batch,{...selector,cascade:false}))skipped.add(selected);}
  catch{return 'waiting_upstream';}
 }
 if(skipped.has(key))return 'skip';
 const deps=dependencyMap(batch),seen=new Set<string>();
 const blocked=(k:string):boolean=>{if(skipped.has(k))return true;if(seen.has(k))return false;seen.add(k);return(deps.get(k)??[]).some(blocked);};
 return blocked(key)?'waiting_upstream':'ready';
}
export function prepareFileRerun(batch:QueueSession,selector:ShotSelector,runs:RunRecord[],requestId:string){
 if(batch.stoppedAt||batch.autoContinueFrames!==true)throw Error('已停止或未授权批次禁止文件重渲恢复');
 const selected=selectedKeys(batch,selector);
 for(const entry of batch.entries.filter(e=>selected.has(queueRowKey(e)))){
  const run=latestQueueRun(entry,runs);
  if(entry.removedAt||entry.cancelRequestedAt||entry.cancelledAt||run?.status==='cancelled')throw Error('已删除/取消镜头不恢复');
  // waiting_frame: never submitted. Re-enter frame resolve; do not require a finished GPU run.
  if(!run&&(entry.submissionState==='pending'||!!entry.waitingReason))continue;
  if(!run||!['completed','failed'].includes(run.status)||!run.comfyPromptId)throw Error('重渲要求原镜头有可核实终态任务；运行/等待/状态不明不重提');
 }
 for(const entry of batch.entries.filter(e=>selected.has(queueRowKey(e)))){
  const run=latestQueueRun(entry,runs);entry.rerun={requestId,previousRunId:run?.runId??'',requestedAt:Date.now()};
  entry.submissionState='pending';entry.outcome=undefined;entry.error=undefined;entry.waitingReason=undefined;entry.execution={attemptId:crypto.randomUUID(),phase:'accepted_intent',startedAt:Date.now(),lastProgressAt:Date.now(),leaseUntil:0,lockName:'',requestId};
  // Keep extracted/HD checkpoints when this shot never had a run; wiping them would drop a reserved tail-HD promptId.
  if(run){entry.frameToken=undefined;} // Keep proven inputs; resolver invalidates only a rerun source in this dependency chain.
 }
 return [...selected];
}
export function fileRetryEligible(batch:QueueSession,run:RunRecord,max:number,retries:number){return !batch.stoppedAt&&batch.autoContinueFrames===true&&run.status==='failed'&&!!run.comfyPromptId&&retries<max&&!batch.entries.find(e=>e.nodeId===run.ownerNodeId)?.cancelRequestedAt;}
