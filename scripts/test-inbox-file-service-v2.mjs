import {bounded,boundedLock,fetchBody} from '../lib/operation-scope.ts';
import {entryDue,mergeSessionDelta} from '../lib/queue-entry-state.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {newQueueSession,latestQueueRun,maySubmitQueueEntry,queueRowKey} from '../lib/shot-queue-session.ts';
import {nextComfyLostStreak,releaseSettledSourceContinuations,rearmVerifiedChainContinuations,isVerifiedComfyLoss,isComfyConnectionFailure,verifiedLossError,autoRetryAcceptsProbe,VERIFIED_COMFY_LOSS_ERROR,VERIFIED_CONNECTION_LOSS_ERROR} from '../lib/comfy-lost-verdict.ts';
import {parseShotQueue} from '../lib/shot-queue.ts';
import {shotFileDisposition,selectedKeys} from '../lib/inbox-file-policy.ts';
import {inboxBatchReport} from '../lib/inbox-batch-report.ts';
import {reconcileComfyHolds,ComfyHoldNotSent} from '../lib/inbox-comfy-hold.ts';
const source=fs.readFileSync('lib/inbox-file-service.ts','utf8').replace(/^import .*;\r?\n/gm,'').replace('export function createInboxFileService','function createInboxFileService');
const code=ts.transpileModule(source+'\nglobalThis.createService=createInboxFileService;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const controls={autoEnqueue:true,autoChain:true,submit:true,stopSessions:[],pauseSessions:[],priority:[],rerunShots:[],skipShots:[],interruptRunning:[],retry:{maxRetries:1},stop:false,effective:{autoEnqueue:true,autoChain:true,submit:true},readAt:'',error:null,version:1};
const make=(id='A')=>({...newQueueSession('page:'+id,{version:'shot-queue-v1',title:id,chapters:[{title:'one',shots:[{title:'L01',shotId:'L01',prompt:'CPU',sceneAssetIds:[],roleIds:[],seconds:6,aspect:'16:9',soundMode:'ambient'}]}]},{x:0,y:0}),id,entries:[{chapter:0,shot:0,nodeId:'node:'+id,submissionState:'accepted'}]});
function harness({batches=[make()],runs=[],queue={queue_running:[],queue_pending:[]},rerunStates=['accepted'],archived=[],saveError=false,probeState='failed',inboxDown=false,metadataMode='ok',heldImageError=false}={}){
 const disk=new Map(),calls=[],reports=[];let page=batches[0].pageId,rerunCall=0,saves=0;
 const editor={getCurrentPageId:()=>page,setCurrentPage:id=>page=id,store:{},getPages:()=>batches.map(b=>({id:b.pageId}))};
 const context=vm.createContext({Date,JSON,Map,Set,Promise,Error,Array,Object,crypto,structuredClone,AbortSignal,URLSearchParams,setTimeout,clearTimeout,navigator:{locks:{request:async(_key,_options,fn)=>fn({})}},
  bounded,boundedLock,entryDue,fetchBody:(url,init,read,ms)=>fetchBody(url,init,read,ms,context.fetch),
  assertHeldGraphImages:async()=>{if(heldImageError)throw Error('all zero image');return 0;},
  saveSessionDelta:async(value,before)=>{const page=disk.get(value.pageId)??batches.find(b=>b.id===value.id);const merged=mergeSessionDelta(page,value,before);disk.set(value.pageId,structuredClone(merged));return merged;},
  getMeta:async key=>structuredClone(disk.get(key)??null),putMeta:async(key,value)=>disk.set(key,structuredClone(value)),
  getRun:async id=>structuredClone(runs.find(r=>r.runId===id)??null),getAsset:async()=>null,listAssets:async()=>[],
  registerAsset:async a=>({assetId:'asset-'+a.sourceRunId,schemaVersion:1,createdAt:1,...a}),
  attachCompletedRunToShot:async()=>true,
  finalizeRunOutput:async(id,_store,produce)=>{const run=runs.find(r=>r.runId===id);const asset=await produce(run);Object.assign(run,{status:'completed',outputAssetIds:[asset.assetId],completedAt:Date.now(),error:null});calls.push(['updateRun',id,'completed']);return{asset,created:true,run};},
  storeLocalVideo:async()=>'media:harvested',readVideoMetadata:async()=>{if(metadataMode==='reject')throw Error('视频元数据超时');return {width:1280,height:720,duration:'15'};},readMp4VideoFps:async()=>24,readMp4VideoTiming:async()=>metadataMode==='reject'?{fps:24,frames:48,width:1280,height:736}:null,Blob,
  readInboxRecovery:()=>({activateFileSession:async batch=>{calls.push(['activate',batch.id]);archived=archived.filter(id=>id!==batch.id);return false;},yield:async()=>true,fileResume:async id=>{calls.push(['resume',id]);return{state:'accepted'};},fileRerun:async(selector,id)=>{calls.push(['rerun',selector,id]);return{state:rerunStates[Math.min(rerunCall++,rerunStates.length-1)]};}}),
  waitForCanvasSave:async()=>{saves++;if(saveError)throw Error('保存尚未确认');},getSnapshot:()=>({document:{store:{}}}),reconcileComfyHolds,ComfyHoldNotSent,queueSessionKey:id=>id,latestQueueRun,maySubmitQueueEntry,queueRowKey,shotFileDisposition,selectedKeys,inboxBatchReport,
  fileSessionIsCurrent:async batch=>!archived.includes(batch.id),inboxReviewFrames:async()=>{throw Error('no media decode in CPU service test');},refreshInboxRootControl:async()=>controls,rootSessionAllows:()=>true,
  rememberFileSession:async session=>disk.set('shot-queue-file-v2:'+session.id,structuredClone(session)),
  nextComfyLostStreak,releaseSettledSourceContinuations,rearmVerifiedChainContinuations,isVerifiedComfyLoss,isComfyConnectionFailure,verifiedLossError,autoRetryAcceptsProbe,VERIFIED_COMFY_LOSS_ERROR,VERIFIED_CONNECTION_LOSS_ERROR,
  updateRun:async(id,patch)=>{calls.push(['updateRun',id,patch.status]);},
  comfyUIH3Adapter:{probeJob:async()=>probeState==='completed'?{state:'completed',file:{filename:'out.mp4',subfolder:'',type:'output'}}:{state:probeState},fetchOutputFile:async()=>{calls.push(['fetchOutput']);return{video:new Blob(['mp4']),filename:'out.mp4'};}},saveNodeForRun:()=> '148',
  fetch:async(url,init={})=>{calls.push([url,init.method??'GET']);let body={};
   if(url==='/api/inbox?op=projects'){if(inboxDown)throw Error('/api/inbox?op=projects:HTTP 503');body={projects:['CPU']};}
   else if(String(url).includes('name=_comfy_output_index.json'))body={files:{'p-evicted':{filename:'Frameflow_H3_ultimate_00769-audio.mp4',subfolder:'video',type:'output'}}};
   else if(url.startsWith('/api/inbox?'))body={queues:Object.fromEntries(batches.map(b=>[b.id,{sessionId:b.id,requestId:'request:'+b.id}]))};
   else if(url==='/comfyui/queue'){if(init.method==='POST'){const ids=JSON.parse(init.body).delete;queue.queue_pending=queue.queue_pending.filter(job=>!ids.includes(job[1]));return{ok:true,json:async()=>{throw new SyntaxError('empty HTTP 200 body');}};}body=queue;}
   else if(url.startsWith('/comfyui/history'))body=url.endsWith('p-failed')?{'p-failed':{status:{status_str:'error',messages:[['execution_error',{exception_message:'ORIGINAL GPU ERROR'}]]}}}:{};
   else if(url==='/__inbox/artifacts'){reports.push(JSON.parse(init.body));body={ok:true};}
   else if(url.startsWith('/comfyui/api/jobs/'))body={cancelled:true};else throw Error('unapproved endpoint '+url);
   return{ok:true,json:async()=>body};}
 });vm.runInContext(code,context);return{service:context.createService(editor,'CPU'),disk,calls,reports,getPage:()=>page,getSaves:()=>saves};
}
{
 const batch=make(),run={runId:'old',ownerNodeId:'node:A',status:'completed',submission:'accepted',comfyPromptId:'p',outputAssetIds:[],createdAt:1,finalPrompt:'FINAL TEXT'};
 const h=harness({batches:[batch],runs:[run]});const command={sessionId:'A',titles:['L01'],requestId:'unique'};
 await h.service.tick([batch],[run],[],{...controls,rerunShots:[command]});await h.service.tick([batch],[run],[],{...controls,rerunShots:[command]});assert.equal(h.calls.filter(c=>c[0]==='rerun').length,1);assert.equal(h.reports[0].batch.shots[0].compiledPrompt,'FINAL TEXT');
 const stop=harness({batches:[{...batch,stoppedAt:123}]});await stop.service.tick([{...batch,stoppedAt:123}],[run],[],{...controls,rerunShots:[command]});assert.equal(stop.calls.filter(c=>c[0]==='rerun').length,0);
}
{
 const batch=make(),h=harness({batches:[batch],rerunStates:['waiting_controller','accepted']});const failed={runId:'failure',ownerNodeId:'node:A',status:'failed',comfyPromptId:'p-failed',outputAssetIds:[],createdAt:Date.now(),completedAt:Date.now()+10000,error:'ORIGINAL ERROR'};
 await h.service.tick([batch],[failed],[],controls);await h.service.tick([batch],[failed],[],controls);await h.service.tick([batch],[failed],[],controls);
 assert.equal(h.calls.filter(c=>c[0]==='rerun').length,2);const retry=h.disk.get('inbox-auto-retry:A:node:A');assert.equal(retry.count,1);assert.equal(retry.errors[0].error,'ORIGINAL ERROR');assert.ok(retry.errors[0].history['p-failed']);
}
{
 const batch=make(),run={runId:'r',ownerNodeId:'node:A',status:'running',submission:'accepted',comfyPromptId:'p-owned',outputAssetIds:[],createdAt:1};
 const h=harness({queue:{queue_running:[[0,'p-owned',{},{}]],queue_pending:[]}});await h.service.tick([batch],[run],[],{...controls,interruptRunning:['A']});await h.service.tick([batch],[run],[],{...controls,interruptRunning:['A']});assert.equal(h.calls.filter(c=>String(c[0]).startsWith('/comfyui/api/jobs/')).length,1);assert.ok(!h.calls.some(c=>c[0]==='/comfyui/interrupt'));
 const other=harness({queue:{queue_running:[[0,'not-owned',{},{}]],queue_pending:[]}});await other.service.tick([batch],[run],[],{...controls,interruptRunning:['A']});assert.equal(other.calls.filter(c=>String(c[0]).includes('/cancel')).length,0);
}
{
 const a=make('A'),b=make('B');a.entries[0].submissionState='pending';b.entries[0].submissionState='pending';const h=harness({batches:[a,b]});await h.service.tick([a,b],[],[],{...controls,priority:['B']});assert.equal(h.getPage(),'page:B');assert.equal(h.getSaves(),1);await h.service.tick([a,b],[],[],{...controls,priority:['B']});assert.ok(h.calls.some(c=>c[0]==='resume'&&c[1]==='B'));
}
console.log('PASS actual file-service CPU harness: command once-only, stopped batch refusal, retry intent survives waiting/controller restart and preserves raw history, owned interrupt only/no global fallback, priority page handoff after save, actual batch reports. No real GPU/GUI.');
{
 const a=make('A'),b=make('B');b.entries[0].submissionState='pending';const h=harness({batches:[a,b],saveError:true});
 await h.service.tick([a,b],[],[],{...controls,priority:['B']});
 assert.equal(h.getPage(),'page:A','unconfirmed save must not switch pages');assert.equal(h.getSaves(),1);
 assert.ok(!h.calls.some(c=>c[0]==='resume'||c[0]==='rerun'));assert.match(h.service.status().effects.error.message,/保存尚未确认/);
}
{
 const batch=make(),run={runId:'queued',ownerNodeId:'node:A',status:'queued',comfyPromptId:'p-held',outputAssetIds:[],createdAt:1};
 const h=harness({queue:{queue_running:[],queue_pending:[[1,'p-held',{graph:'unchanged'},{}]]}});
 await h.service.tick([batch],[run],[],{...controls,pauseSessions:['A']});
 const jobs=h.disk.get('inbox-file-held-comfy');assert.equal(jobs[0].state,'held');assert.equal(jobs[0].deleteConfirmed,true,'empty HTTP 200 is a valid dequeue transport acknowledgement');
 assert.ok(!h.calls.some(c=>c[0]==='/comfyui/interrupt'));
}
{
 const a=make('A'),b=make('B');a.entries[0].submissionState='pending';b.entries[0].submissionState='pending';b.pageId=a.pageId;
 const h=harness({batches:[a,b]});const invalid={...controls,skipShots:[{sessionId:'A',titles:['missing title']}]};
 await h.service.tick([a,b],[],[],invalid);
 assert.equal(h.service.status().effects['skip:A'].state,'rejected');
 assert.ok(h.calls.some(c=>c[0]==='resume'&&c[1]==='B'),'bad skip title must not starve another batch');
 assert.ok(!h.calls.some(c=>c[0]==='resume'&&c[1]==='A'),'invalid selector must fail closed for its own batch');
 assert.equal(h.reports.length,2,'both reports continue publishing');
 await h.service.tick([a,b],[],[],controls);assert.equal(h.service.status().effects['skip:A'],undefined,'corrected file clears stale rejection');
}
{
 const a=make('A'),b=make('B');b.pageId=a.pageId;a.entries[0].submissionState='pending';b.entries[0].submissionState='pending';const h=harness({batches:[a,b],archived:['B']});await h.service.tick([a,b],[],[],{...controls,priority:['B']});assert.ok(h.calls.some(c=>c[0]==='activate'&&c[1]==='B'));await h.service.tick([a,b],[],[],{...controls,priority:['B']});assert.ok(h.calls.some(c=>c[0]==='resume'&&c[1]==='B'));
 const cold=harness({batches:[b],archived:['B']});await cold.service.tick([b],[],[],controls);assert.ok(!cold.calls.some(c=>c[0]==='activate'||c[0]==='resume'),'archives never auto-resume without explicit file selection');
}
{
 const batch=make(),run={runId:'lost-run',ownerNodeId:'node:A',status:'queued',submission:'accepted',comfyPromptId:'p-lost',outputAssetIds:[],createdAt:1,error:null};
 const once=harness({batches:[batch],runs:[run],probeState:'not_found'});
 await once.service.tick([batch],[run],[],controls);
 assert.equal(run.status,'queued');assert.equal(once.disk.get('comfy-lost-streak:lost-run:p-lost').misses,1);
 assert.equal(once.calls.filter(c=>c[0]==='updateRun'||c[0]==='rerun').length,0,'one miss is not a verified loss');
 const early=harness({batches:[structuredClone(batch)],runs:[structuredClone(run)],probeState:'not_found'});
 const still={...run};const held=structuredClone(batch);
 early.disk.set('comfy-lost-streak:lost-run:p-lost',{promptId:'p-lost',misses:2,lastAt:Date.now()-1000,verified:false});
 await early.service.tick([held],[still],[],controls);
 assert.equal(still.status,'queued');assert.equal(early.disk.get('comfy-lost-streak:lost-run:p-lost').misses,2);
 assert.equal(early.calls.filter(c=>c[0]==='rerun').length,0,'a miss inside 10 seconds does not count');
 const ready=harness({batches:[structuredClone(batch)],runs:[{...run}],probeState:'not_found'});
 const lost={...run};const lostBatch=structuredClone(batch);
 ready.disk.set('comfy-lost-streak:lost-run:p-lost',{promptId:'p-lost',misses:2,lastAt:Date.now()-11_000,verified:false});
 await ready.service.tick([lostBatch],[lost],[],controls);
 assert.equal(lost.status,'queued');assert.equal(ready.disk.get(batch.pageId).entries[0].outcome,'uncertain');assert.match(ready.disk.get(batch.pageId).entries[0].error,/禁止|不自动重提/);
 assert.equal(lostBatch.entries[0].submissionState,'accepted','verdict alone must not open maySubmit');
 assert.equal(ready.calls.filter(c=>c[0]==='rerun'||c[0]==='resume').length,0,'not_found is not a history failure, so auto-retry does not post');
 assert.ok(!ready.calls.some(c=>String(c[0]).includes('/prompt')));
 const alive=harness({batches:[structuredClone(batch)],runs:[{...run}],probeState:'queued'});
 const aliveRun={...run};const aliveBatch=structuredClone(batch);
 alive.disk.set('comfy-lost-streak:lost-run:p-lost',{promptId:'p-lost',misses:2,lastAt:Date.now()-11_000,verified:false});
 await alive.service.tick([aliveBatch],[aliveRun],[],controls);
 assert.equal(aliveRun.status,'queued');assert.equal(alive.disk.get('comfy-lost-streak:lost-run:p-lost').misses,0);
 assert.equal(alive.calls.filter(c=>c[0]==='rerun'||c[0]==='updateRun').length,0,'a prompt that reappears is not resubmitted');
}
{
 const shot=(title,extra={})=>({title,shotId:title,prompt:'CPU',roleIds:[],sceneAssetIds:[],soundMode:'ambient',seconds:6,aspect:'16:9',...extra});
 const queue=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'tails',autoSwitchPage:true,chapters:[{title:'one',shots:[shot('L01'),shot('L02',{generationMode:'first-last',firstFrameFrom:{shot:'L01',frame:'last'}})]}]}));
 const batch=newQueueSession('page:T',queue,{x:0,y:0});batch.id='T';
 batch.entries[0].nodeId='node:src';batch.entries[0].submissionState='accepted';
 batch.entries[1].nodeId='node:tail';batch.entries[1].submissionState='pending';batch.entries[1].outcome='uncertain';
 batch.entries[1].error='来源「L01」原任务在队列与历史中无法确认；不会重提或换用其他视频';
 const blocked=structuredClone(batch);const queued={runId:'src-run',ownerNodeId:'node:src',status:'queued',submission:'accepted',comfyPromptId:'p-src',outputAssetIds:[],createdAt:1,error:null};
 const waiting=harness({batches:[blocked],runs:[queued],probeState:'queued'});
 await waiting.service.tick([blocked],[queued],[],controls);
 assert.equal(blocked.entries[1].outcome,'uncertain');assert.equal(waiting.calls.filter(c=>c[0]==='rerun'||c[0]==='resume').length,0,'a live source still blocks the tail');
 const source={runId:'src-run',ownerNodeId:'node:src',status:'failed',submission:'accepted',comfyPromptId:'p-src',outputAssetIds:[],createdAt:Date.now(),completedAt:Date.now()+60_000,error:VERIFIED_COMFY_LOSS_ERROR};
 const h=harness({batches:[batch],runs:[source],probeState:'not_found'});
 await h.service.tick([batch],[source],[],controls);
 assert.equal(h.disk.get(batch.pageId).entries[1].outcome,undefined);assert.equal(h.disk.get(batch.pageId).entries[1].frameInputs,undefined);
 assert.match(h.disk.get(batch.pageId).entries[1].waitingReason,/没有继承首帧/);
 assert.equal(h.calls.filter(c=>c[0]==='rerun').length,0,'a verified-lost source is not auto-posted');
 await h.service.tick([h.disk.get(batch.pageId)],[source],[],controls);
 assert.ok(h.calls.some(c=>c[0]==='resume'&&c[1]==='T'));
 assert.equal(batch.entries[1].frameInputs,undefined,'resume intent still has no inherited frame');
 assert.ok(!h.calls.some(c=>String(c[0]).includes('/prompt')));
 const connected=structuredClone(batch);
 connected.entries[1].outcome=undefined;connected.entries[1].error=undefined;connected.entries[1].waitingReason=undefined;connected.entries[1].submissionState='accepted';
 connected.entries[0].outcome='uncertain';connected.entries[0].error='无法连接本地 ComfyUI，请确认 127.0.0.1:8188 已启动';
 const refused={...source,status:'failed',error:'无法连接本地 ComfyUI，请确认 127.0.0.1:8188 已启动'};
 const gate=harness({batches:[connected],runs:[refused],probeState:'not_found'});
 gate.disk.set('comfy-lost-streak:'+refused.runId+':'+refused.comfyPromptId,{promptId:refused.comfyPromptId,misses:2,lastAt:Date.now()-11_000,verified:false});
 await gate.service.tick([connected],[refused],[],controls);
 assert.match(refused.error,/无法连接/);
 assert.ok(isComfyConnectionFailure(refused.error),'connection verdict keeps the connection cause so auto-retry can see it');
 assert.equal(gate.disk.get(connected.pageId).entries[0].outcome,'uncertain');
 assert.equal(connected.entries[0].submissionState,'accepted','a connection failure stays closed until rerun or auto-retry');
 assert.equal(gate.calls.filter(c=>c[0]==='rerun').length,0,'history missing after a connection error is still unconfirmed, never an automatic retry');
 assert.ok(!gate.calls.some(c=>String(c[0]).includes('/prompt')));
 await gate.service.tick([connected],[refused],[],controls);
 assert.equal(gate.calls.filter(c=>c[0]==='rerun').length,0,'missing history never authorizes a second attempt');
 const reserved={...refused,runId:'reserved-run',comfyPromptId:'p-reserved',error:'无法连接本地 ComfyUI，请确认 127.0.0.1:8188 已启动',submission:'reserved'};
 const reservedBatch=structuredClone(batch);
 reservedBatch.entries[0].nodeId='node:src';
 const held=harness({batches:[reservedBatch],runs:[reserved],probeState:'not_found'});
 held.disk.set('comfy-lost-streak:'+reserved.runId+':'+reserved.comfyPromptId,{promptId:reserved.comfyPromptId,misses:2,lastAt:Date.now()-11_000,verified:false});
 await held.service.tick([reservedBatch],[reserved],[],{...controls,retry:{maxRetries:0}});
 assert.match(reserved.error,/无法连接/);
 assert.equal(held.calls.filter(c=>c[0]==='rerun').length,0,'maxRetries 0 still does not post');
 const liveRun={...refused,error:'无法连接本地 ComfyUI，请确认 127.0.0.1:8188 已启动'};
 const liveBatch=structuredClone(batch);
 const live=harness({batches:[liveBatch],runs:[liveRun],probeState:'queued'});
 live.disk.set('comfy-lost-streak:'+liveRun.runId+':'+liveRun.comfyPromptId,{promptId:liveRun.comfyPromptId,misses:2,lastAt:Date.now()-11_000,verified:false});
 await live.service.tick([liveBatch],[liveRun],[],controls);
 assert.equal(live.disk.get('comfy-lost-streak:'+liveRun.runId+':'+liveRun.comfyPromptId).misses,0);
 assert.doesNotMatch(liveRun.error??'',/已核实丢失/);
 assert.equal(live.calls.filter(c=>c[0]==='rerun').length,0,'a prompt that is still queued is never resubmitted');
 assert.equal(autoRetryAcceptsProbe({status:'queued',error:VERIFIED_CONNECTION_LOSS_ERROR},'not_found'),false);
}
console.log('PASS comfy-loss verdict: three spaced misses, 10s gap, reappearance reset, tail stays frame-gated. CPU mocks only.');
{
 const batch=make();
 const run={runId:'done-run',ownerNodeId:'node:A',status:'queued',submission:'accepted',comfyPromptId:'p-done',outputAssetIds:[],createdAt:1,shotId:'shot-A',error:null,capabilityId:'h3_ref2va'};
 const h=harness({batches:[batch],runs:[run],probeState:'completed'});
 await h.service.tick([batch],[run],[],controls);
 assert.equal(run.status,'completed');
 assert.equal(h.calls.filter(c=>c[0]==='fetchOutput').length,1);
 assert.ok(!h.calls.some(c=>String(c[0]).includes('/prompt')));
 assert.equal(h.service.status().effects['harvest:done-run'].state,'completed');
 const again=harness({batches:[structuredClone(batch)],runs:[run],probeState:'completed'});
 await again.service.tick([structuredClone(batch)],[run],[],controls);
 assert.equal(again.calls.filter(c=>c[0]==='fetchOutput').length,0,'already completed runs are not fetched again');
}
{
 const shot=(title,extra={})=>({title,shotId:title,prompt:'CPU',roleIds:[],sceneAssetIds:[],soundMode:'ambient',seconds:6,aspect:'16:9',...extra});
 const queue=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'harvest-tail',autoSwitchPage:true,chapters:[{title:'one',shots:[shot('L00'),shot('L00b',{generationMode:'first-last',firstFrameFrom:{shot:'L00',frame:'last'}})]}]}));
 const batch=newQueueSession('page:H',queue,{x:0,y:0});batch.id='H';
 batch.entries[0].nodeId='node:src';batch.entries[0].submissionState='accepted';
 batch.entries[1].nodeId='node:tail';batch.entries[1].submissionState='pending';batch.entries[1].waitingReason='等待来源完成截尾帧';
 const source={runId:'src-done',ownerNodeId:'node:src',status:'running',submission:'accepted',comfyPromptId:'p-src-done',outputAssetIds:[],createdAt:1,shotId:'L00',error:null,capabilityId:'h3_ref2va'};
 const down=harness({batches:[batch],runs:[source],probeState:'completed',inboxDown:true});
 await down.service.tick([batch],[source],[],controls);
 assert.equal(source.status,'completed');
 assert.equal(down.service.status().effects.inbox.state,'offline');
 assert.ok(down.calls.some(c=>c[0]==='resume'&&c[1]==='H'),'source harvest must unblock waiting_frame resume');
 assert.ok(!down.calls.some(c=>String(c[0]).includes('/prompt')));
}
console.log('PASS harvest completed Comfy history into Run records without /prompt; inbox 503 does not skip harvest or tail resume. CPU mocks only.');
{
 const batch=make('box');
 const run={runId:'box-run',ownerNodeId:'node:box',status:'running',submission:'accepted',comfyPromptId:'p-box',outputAssetIds:[],createdAt:1,shotId:'shot-box',error:null,capabilityId:'h3_ref2va'};
 const h=harness({batches:[batch],runs:[run],probeState:'completed',metadataMode:'reject'});
 await h.service.tick([batch],[run],[],controls);
 assert.equal(run.status,'completed');
 assert.equal(h.service.status().effects['harvest:box-run'].state,'completed');
 assert.equal(run.outputAssetIds.length,1);
}
console.log('PASS harvest still registers when video metadata rejects and MP4 boxes are readable. CPU mocks only.');
{
 const shot=(title,extra={})=>({title,shotId:title,prompt:'CPU',roleIds:[],sceneAssetIds:[],soundMode:'ambient',seconds:6,aspect:'16:9',...extra});
 const queue=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'displaced',autoSwitchPage:true,chapters:[{title:'one',shots:[shot('L00'),shot('L00b',{generationMode:'first-last',firstFrameFrom:{shot:'L00',frame:'last'}})]}]}));
 const batch=newQueueSession('page:D',queue,{x:0,y:0});batch.id='D';
 batch.entries[0].nodeId='node:src';batch.entries[0].submissionState='accepted';
 batch.entries[1].nodeId='node:tail';batch.entries[1].submissionState='pending';batch.entries[1].waitingReason='等待来源完成截尾帧';
 const occupant=newQueueSession('page:D',parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'slot',chapters:[{title:'one',shots:[shot('other')]}]})),{x:0,y:0});occupant.id='slot';occupant.entries[0].submissionState='accepted';occupant.entries[0].nodeId='node:slot';
 const source={runId:'evicted-run',ownerNodeId:'node:src',status:'running',submission:'accepted',comfyPromptId:'p-evicted',outputAssetIds:[],createdAt:1,shotId:'L00',error:null,capabilityId:'h3_ref2va'};
 const h=harness({batches:[occupant,batch],runs:[source],probeState:'not_found',archived:['D']});
 await h.service.tick([occupant,batch],[source],[],controls);
 await h.service.tick([occupant,batch],[source],[],controls);
 await h.service.tick([occupant,batch],[source],[],controls);
 assert.equal(source.status,'completed','an evicted history row is completed from the output index');
 assert.equal(h.calls.filter(c=>c[0]==='fetchOutput').length,1);
 assert.equal(h.disk.get('comfy-lost-streak:evicted-run:p-evicted'),undefined,'a known output is not a Comfy loss');
 assert.ok(h.calls.some(c=>c[0]==='activate'&&c[1]==='D'),'the displaced batch is put back on the page slot');
 assert.ok(!h.calls.some(c=>String(c[0]).includes('/prompt')));
 await h.service.tick([occupant,batch],[source],[],controls);
 assert.ok(h.calls.some(c=>c[0]==='resume'&&c[1]==='D'),'tail resume runs after the original batch owns the page slot');
 const untouched={...source,runId:'still-running',comfyPromptId:'p-live',status:'running'};
 const quiet=harness({batches:[batch],runs:[untouched],probeState:'not_found',archived:['D']});
 await quiet.service.tick([batch],[untouched],[],controls);
 assert.equal(untouched.status,'running');
 assert.equal(quiet.disk.get('comfy-lost-streak:still-running:p-live'),undefined,'a displaced batch is not failed just because history rolled over');
 assert.ok(!quiet.calls.some(c=>c[0]==='activate'||c[0]==='resume'||String(c[0]).includes('/prompt')));
}
console.log('PASS displaced page slot still harvests history and indexed MP4s, then resumes tails; no /prompt. CPU mocks only.');

{
 const batch=make(),run={runId:'held',ownerNodeId:'node:A',status:'queued',comfyPromptId:'p-held',outputAssetIds:[],createdAt:1};
 const h=harness({batches:[batch],runs:[run],queue:{queue_running:[],queue_pending:[[1,'p-held',{image:{class_type:'LoadImage',inputs:{image:'bad.png'}}},{}]]},heldImageError:true});
 await h.service.tick([batch],[run],[],{...controls,pauseSessions:['A']});
 await h.service.tick([batch],[run],[],controls);
 assert.equal(h.disk.get('inbox-file-held-comfy')[0].state,'held');
 assert.match(h.disk.get('inbox-file-held-comfy')[0].error,/all zero/);
 assert.ok(!h.calls.some(c=>c[0]==='/comfyui/prompt'),'bad held input is rejected before GPU POST');
}
