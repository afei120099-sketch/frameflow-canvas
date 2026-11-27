import assert from 'node:assert/strict';
import {cancelTasksBeforeNodeRemoval} from '../lib/node-removal-cancel.ts';
import {isNodeBeingRemoved,registerNodeTaskCancel,cancelRegisteredNodeTask,fenceNodeRemoval} from '../lib/node-task-activity.ts';
import {claimNode} from '../lib/run-recovery.ts';
import {maySubmitQueueEntry,queueEntryUncertain} from '../lib/shot-queue-session.ts';
import {harness} from './test-queue-fail-closed.mjs';

globalThis.fetch=async()=>{throw Error('real network forbidden');};
const shape=(id='shape:a')=>({id,typeName:'shape',type:'h3-node',parentId:'page:test',props:{},meta:{}});
function fixture({nodes=[shape()],runs=[],initial='running',after='failed',busy=false,offline=false}={}){
  const shapes=new Map(nodes.map(n=>[n.id,n]));const calls=[],writes=[];let stopped=false;
  const editor={store:{allRecords:()=>[...shapes.values()]},getCurrentPageId:()=> 'page:test',getShape:id=>shapes.get(id),updateShape:s=>shapes.set(s.id,{...shapes.get(s.id),...s})};
  const deps={runs:async()=>structuredClone(runs),update:async(id,patch)=>{writes.push([id,patch]);Object.assign(runs.find(r=>r.runId===id),patch);},
    cover:async()=>null,voice:async()=> 'running',local:async id=>{assert.ok(isNodeBeingRemoved(id));calls.push(['local',id]);},queue:async(_page,ids)=>calls.push(['queue',...ids]),
    probe:async id=>{calls.push(['probe',id]);return stopped?after:initial;},busy:()=>busy,wait:async()=>{},
    request:async(url,options)=>{calls.push(['cancel',url,options.method]);if(offline)throw Error('offline');stopped=true;return new Response('{"cancelled":true}');}};
  return {editor,deps,calls,writes,shapes};
}
const active={runId:'run:a',ownerNodeId:'shape:a',comfyPromptId:'prompt:a',status:'running',submission:'accepted',capabilityId:'h3_fl2va'};
for(const state of ['queued','running']){
  const f=fixture({runs:[{...active},{...active,runId:'other',ownerNodeId:'shape:other',comfyPromptId:'other'}],initial:state});
  const release=await cancelTasksBeforeNodeRemoval(f.editor,['shape:a'],f.deps);
  assert.equal(isNodeBeingRemoved('shape:a'),true);assert.equal(claimNode('shape:a'),null);
  assert.deepEqual(f.calls.filter(c=>c[0]==='cancel'),[['cancel','/comfyui/api/jobs/prompt%3Aa/cancel','POST']]);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0][0],'run:a');release();assert.equal(isNodeBeingRemoved('shape:a'),false);
}
for(const opts of [{offline:true},{after:'running'},{after:'uncertain'},{busy:true}]){
  const f=fixture({runs:[{...active}],...opts});
  await assert.rejects(()=>cancelTasksBeforeNodeRemoval(f.editor,['shape:a'],f.deps));
  assert.equal(isNodeBeingRemoved('shape:a'),false);assert.ok(f.editor.getShape('shape:a'));
}
const unknown=fixture({runs:[{...active,submission:'reserved'}],initial:'not_found'});
await assert.rejects(()=>cancelTasksBeforeNodeRemoval(unknown.editor,['shape:a'],unknown.deps),/状态不明/);
assert.equal(unknown.calls.some(c=>c[0]==='cancel'),false);
const locked=fixture({nodes:[{...shape(),isLocked:true}],runs:[{...active}]});
await assert.rejects(()=>cancelTasksBeforeNodeRemoval(locked.editor,['shape:a'],locked.deps),/锁定/);assert.equal(locked.calls.length,0);
const done=fixture({runs:[{...active,status:'completed'}]});(await cancelTasksBeforeNodeRemoval(done.editor,['shape:a'],done.deps))();assert.equal(done.calls.some(c=>c[0]==='cancel'),false);
const voice=fixture({nodes:[{...shape(),type:'tts-node',props:{pendingDesignId:'voice1'}}]});
await assert.rejects(()=>cancelTasksBeforeNodeRemoval(voice.editor,['shape:a'],voice.deps),/暂无安全取消接口/);assert.equal(voice.calls.some(c=>c[0]==='cancel'),false);
const shared=fixture({runs:[{...active}],nodes:[shape(),{...shape('shape:other'),props:{pendingId:'prompt:a'}}]});
await assert.rejects(()=>cancelTasksBeforeNodeRemoval(shared.editor,['shape:a'],shared.deps),/共用/);assert.equal(shared.calls.some(c=>c[0]==='cancel'),false);
let localCancelled=0;const off=registerNodeTaskCancel('shape:a',async()=>{localCancelled++;return true;});await cancelRegisteredNodeTask('shape:a');off();await cancelRegisteredNodeTask('shape:a');assert.equal(localCancelled,1);
const unlock=fenceNodeRemoval(['shape:a']);assert.throws(()=>fenceNodeRemoval(['shape:a']));unlock();
assert.equal(maySubmitQueueEntry({removedAt:1,submissionState:'pending'},[]),false);assert.equal(queueEntryUncertain({removedAt:1,submissionState:'started'},[]),false);

// Execute the actual queue hook: selected entry gets a durable tombstone;
// subsequent resume preserves other nodes and never submits/recreates the deleted one.
const h=harness();await h.api.submitAll();const original=h.data.saved.entries.map(e=>e.nodeId);
await h.data.removeQueueNodes([original[1]]);
assert.ok(h.data.saved.entries[1].removedAt);assert.equal(h.data.saved.entries[0].removedAt,undefined);assert.equal(h.data.stopCalls,0);
h.editor.shapes.delete(original[1]);await h.api.submitAll();assert.equal(h.data.created.length,3);assert.equal(h.data.submitted.length,3);
let pendingRemoval;
const live=harness({hooks:{accepted:({data,run})=>{if(!pendingRemoval)pendingRemoval=data.removeQueueNodes([run.ownerNodeId]);}}});
await live.api.submitAll();await pendingRemoval;
assert.equal(live.data.submitted.length,1);assert.equal(live.data.stopCalls,0,'abort frontend submission, never cancel other accepted ComfyUI jobs');
assert.ok(live.data.saved.entries[0].removedAt);assert.equal(live.data.saved.entries[1].removedAt,undefined);
console.log('PASS delete-cancel: exact owner/prompt, running and queued, local abort hook, fence, offline/uncertain/locked refusal, no global interrupt, persisted queue deletion, no recreation/repost, other jobs preserved. CPU mocks only.');
