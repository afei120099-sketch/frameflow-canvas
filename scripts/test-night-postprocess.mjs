import assert from 'node:assert/strict';
import {nightAttempts,runNightAttempts} from '../lib/night-postprocess.ts';
import {runSerialProcessing} from '../lib/postprocess-queue.ts';
const attempts=nightAttempts('quality',false);
assert.deepEqual(attempts.map(a=>[a.profile,a.segmented,a.segmentSeconds]),[['quality',false,undefined],['safe',false,undefined],['safe',true,.5]]);
assert.equal(nightAttempts('safe',true).length,2);
assert.deepEqual(nightAttempts('quality',true).map(a=>[a.profile,a.segmented,a.segmentSeconds]),[['quality',true,undefined],['safe',true,undefined],['safe',true,.5]],'explicit segmented choice must never go back to whole');
assert.deepEqual(nightAttempts('safe',true).map(a=>[a.profile,a.segmented,a.segmentSeconds]),[['safe',true,undefined],['safe',true,.5]],'safe segmented only retries with smaller segments');
assert.deepEqual(nightAttempts('safe').map(a=>a.segmented),[false,true],'safe selected: no duplicate safe whole attempt');
let visited=[];
assert.equal(await runNightAttempts(attempts,async(a,i)=>{visited.push(a.label);return i===2?'completed':'failed';},()=>false),'completed');assert.equal(visited.length,3);
for(const status of ['uncertain','cancelled']){visited=[];assert.equal(await runNightAttempts(attempts,async()=>{visited.push(1);return status;},()=>false),status);assert.equal(visited.length,1);}
visited=[];await assert.rejects(runNightAttempts(attempts,async()=>{visited.push(1);throw Error('queue unreadable');},()=>false));assert.equal(visited.length,1);
const seen=[];
const result=await runSerialProcessing(['a','b','c'],async item=>{seen.push(item);return item==='b'?'failed':'completed';},()=>false,()=>{},{continueOnFailure:true});
assert.deepEqual(seen,['a','b','c']);assert.equal(result.completed,2);assert.equal(result.failed,1);
seen.length=0;const stop=await runSerialProcessing(['a','b','c'],async item=>{seen.push(item);return item==='b'?'uncertain':'completed';},()=>false,()=>{},{continueOnFailure:true});
assert.equal(stop.status,'uncertain');assert.deepEqual(seen,['a','b']);
console.log('PASS bounded quality -> safe -> tiny segments, skip definitive failure and continue; ambiguity/cancel/exceptions stop, no GPU');
