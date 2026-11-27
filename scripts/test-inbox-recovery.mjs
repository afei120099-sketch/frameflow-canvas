import assert from 'node:assert/strict';
import {diffCanvasRecord,diagnoseCanvasRecords} from '../lib/canvas-save-status.ts';
import {newQueueSession} from '../lib/shot-queue-session.ts';
import {parseShotQueue} from '../lib/shot-queue.ts';
import {harness} from './test-queue-fail-closed.mjs';
import {ensurePreparationConnection,PreparationUnavailableError} from '../lib/comfyui/preparation-connection.ts';
import {classifyQueueSubmissionError} from '../lib/queue-submission-policy.ts';
import {LEGACY_PREPARATION_CONNECTION_ERROR} from '../lib/preparation-not-sent.ts';

let checks=0;await ensurePreparationConnection(async()=>++checks===3,undefined,async()=>{});assert.equal(checks,3);
checks=0;await assert.rejects(()=>ensurePreparationConnection(async()=>{checks++;return false;},undefined,async()=>{}),PreparationUnavailableError);assert.equal(checks,3);
assert.equal(classifyQueueSubmissionError(new PreparationUnavailableError()),'not_sent');
const cancelled=new AbortController();cancelled.abort();await assert.rejects(()=>ensurePreparationConnection(async()=>true,cancelled.signal,async()=>{}));

assert.deepEqual(diffCanvasRecord('n',{props:{h:2}},{props:{h:3}}),[{id:'n',field:'props.h',expected:2,stored:3}]);
assert.equal(diffCanvasRecord('n',{x:1},undefined)[0].field,'$record');
assert.equal(diffCanvasRecord('n',{x:1,y:2},{y:2,x:1})[0].field,'$propertyOrder');
assert.deepEqual(diffCanvasRecord('n',{x:1},{x:1}),[]);
// Exercise the real readonly-IDB diagnostic without opening any browser database.
let closed=0,writes=0;
globalThis.indexedDB={open:()=>{
  const request={};queueMicrotask(()=>{request.result={objectStoreNames:{contains:()=>true},close:()=>closed++,transaction:(name,mode)=>{
    assert.equal(name,'records');assert.equal(mode,'readonly');
    const tx={objectStore:()=>({get:id=>{const r={};queueMicrotask(()=>{r.result={id,props:{h:3}};r.onsuccess();queueMicrotask(()=>tx.oncomplete());});return r;},put:()=>writes++})};return tx;
  }};request.onsuccess();});return request;
}};
const d=await diagnoseCanvasRecords('CPU',new Map([['n',{id:'n',props:{h:2}}]]));
assert.equal(d.matches,false);assert.equal(d.differences[0].field,'props.h');assert.equal(writes,0);assert.equal(closed,1);
delete globalThis.indexedDB;

const queue=parseShotQueue(JSON.stringify({version:'shot-queue-v1',title:'CPU resume',chapters:[{title:'one',shots:Array.from({length:3},(_,i)=>({title:'r'+i,prompt:'CPU only',seconds:6,aspect:'16:9',roleIds:[],sceneAssetIds:[],autoVoiceDisabled:true}))}]}));
function setup({hooks={},runs=[],mutate}={}){
  const saved=newQueueSession('page:g-test',queue,{x:1,y:2});
  saved.entries.forEach((entry,i)=>entry.nodeId='shape:existing-'+i);mutate?.(saved);
  const h=harness({queue,saved,runs,hooks});
  saved.entries.forEach(entry=>h.editor.shapes.get(entry.nodeId).meta={shotQueueSessionId:saved.id,shotQueueEntry:`${entry.chapter}:${entry.shot}`});
  return{...h,target:{requestId:'original-request',sessionId:saved.id,pageId:saved.pageId},saved};
}
const completed={ownerNodeId:'shape:existing-0',runId:'done',comfyPromptId:'prior',status:'completed',submission:'accepted',createdAt:1};
const good=setup({runs:[completed],hooks:{probeState:'completed'}});
await good.data.recovery.resume(good.target);
for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(good.data.created.length,0);assert.equal(good.data.saved.id,good.saved.id);
assert.equal(good.data.submitted.length,2);assert.ok(!good.data.submitted.includes(completed.ownerNodeId));
for(const opts of [
  {hooks:{saveMismatch:true}},
  {hooks:{queueRunning:1}},
  {runs:[{...completed,status:'queued',submission:'reserved'}]},
  {runs:[completed],hooks:{probeState:'not_found'}},
  {mutate:s=>{s.entries[1].submissionState='started';}},
]){
  const h=setup(opts);await assert.rejects(()=>h.data.recovery.resume(h.target));
  assert.equal(h.data.created.length,0);assert.equal(h.data.submitted.length,0);
}
const wrong=setup();await assert.rejects(()=>wrong.data.recovery.resume({...wrong.target,sessionId:'wrong'}));
const missing=setup();missing.editor.shapes.delete('shape:existing-1');await assert.rejects(()=>missing.data.recovery.resume(missing.target));
assert.equal(missing.data.created.length,0);
const legacy={...completed,runId:'never-sent',comfyPromptId:'never-sent',status:'failed',submission:'reserved',error:LEGACY_PREPARATION_CONNECTION_ERROR,startedAt:null,outputAssetIds:[],parameters:{}};
const repaired=setup({runs:[legacy],hooks:{allowRepair:true,probeState:'not_found'},mutate:s=>{s.entries[0].submissionState='started';s.entries[0].outcome='uncertain';}});
await repaired.data.recovery.resume({...repaired.target,allowPreparationRepair:true});
for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(repaired.data.created.length,0);assert.equal(repaired.data.submitted.length,3);assert.equal(repaired.data.runs[0].preparationNotSent.workflowCaptureAbsent,true);
const ownActive=setup({runs:[{...completed,status:'queued'}],hooks:{queueIds:['prior'],probeState:'queued'}});
await ownActive.data.recovery.resume(ownActive.target);
for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(ownActive.data.submitted.length,2);assert.equal(ownActive.data.created.length,0);
const hadSnapshot=setup({runs:[{...legacy,submissionSnapshot:{graph:{}}}],hooks:{allowRepair:true,probeState:'not_found'},mutate:s=>{s.entries[0].submissionState='started';s.entries[0].outcome='uncertain';}});
await hadSnapshot.data.recovery.resume({...hadSnapshot.target,allowPreparationRepair:true});
for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(hadSnapshot.data.submitted.length,2);assert.ok(!hadSnapshot.data.submitted.includes('shape:existing-0'));assert.equal(hadSnapshot.data.saved.entries[0].outcome,'uncertain');
const lostAck=setup({runs:[{...legacy,submissionSnapshot:{graph:{}}}],hooks:{allowRepair:true,probeState:'queued',queueIds:['never-sent']},mutate:s=>{s.entries[0].submissionState='started';s.entries[0].outcome='uncertain';}});
await lostAck.data.recovery.resume({...lostAck.target,allowPreparationRepair:true});
for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(lostAck.data.runs[0].submission,'accepted');assert.equal(lostAck.data.submitted.length,2);assert.ok(!lostAck.data.submitted.includes('shape:existing-0'));
console.log('PASS readonly save field diagnostics; existing-session resume skips prior Runs, creates zero nodes, blocks missing nodes, save mismatch, unknown acceptance/history, wrong session and busy GPU queue; CPU mocks only');
const voiceMissing=setup({hooks:{allowRepair:true},mutate:s=>{s.entries[0].submissionState='started';s.entries[0].outcome='uncertain';s.entries[0].error='角色“裴知微”没有可用主声音';}});
await voiceMissing.data.recovery.resume({...voiceMissing.target,allowPreparationRepair:true});
for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(voiceMissing.data.submitted.length,2);assert.equal(voiceMissing.data.saved.entries[0].outcome,'failed');assert.equal(voiceMissing.data.created.length,0);
const unknownSkip=setup({runs:[{...legacy,error:'HTTP acknowledgment lost',submissionSnapshot:{graph:{}}}],hooks:{allowRepair:true,probeState:'not_found'},mutate:s=>{s.entries[0].submissionState='started';s.entries[0].outcome='uncertain';}});
await unknownSkip.data.recovery.resume({...unknownSkip.target,allowPreparationRepair:true});
for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(unknownSkip.data.submitted.length,2);assert.equal(unknownSkip.data.saved.entries[0].outcome,'uncertain');assert.equal(unknownSkip.data.runs[0].submission,'reserved');
const noPrompt=setup({hooks:{allowRepair:true},mutate:s=>{s.entries[0].submissionState='started';s.entries[0].outcome='uncertain';}});
await noPrompt.data.recovery.resume({...noPrompt.target,allowPreparationRepair:true});
for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(noPrompt.data.submitted.length,2);assert.equal(noPrompt.data.saved.entries[0].outcome,'uncertain');
console.log('PASS controlled resume: skip missing-voice validation with no Run; query and preserve unknown Runs; never resubmit unknown/no-ID nodes; submit other pending nodes only');
