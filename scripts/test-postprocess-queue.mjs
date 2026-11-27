import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runSerialProcessing,registerProcessing,runRegisteredProcessing} from '../lib/postprocess-queue.ts';
import { readWorkspaceSource } from './workspace-source.mjs';
let concurrent=0,peak=0;const calls=[];
const success=await runSerialProcessing([1,2,3],async item=>{concurrent++;peak=Math.max(peak,concurrent);calls.push(item);await new Promise(r=>setTimeout(r,2));concurrent--;return 'completed';},()=>false,()=>{});
assert.equal(peak,1);assert.deepEqual(calls,[1,2,3]);assert.deepEqual(success,{completed:3,status:'completed'});
for(const terminal of ['failed','cancelled','uncertain']){
  const visited=[];const result=await runSerialProcessing([1,2,3],async item=>{visited.push(item);return item===2?terminal:'completed';},()=>false,()=>{});
  assert.deepEqual(visited,[1,2]);assert.equal(result.completed,1);assert.equal(result.status,terminal);
}
let stopped=false;
const result=await runSerialProcessing([1,2],async()=>{stopped=true;return 'completed';},()=>stopped,()=>{});
assert.deepEqual(result,{completed:1,status:'cancelled'});
let runs=0;const unregister=registerProcessing('test',()=>({ready:true,generate:async()=>{runs++;return 'completed';}}));
assert.equal(await runRegisteredProcessing('test',()=>false),'completed');assert.equal(runs,1);unregister();
assert.equal(await runRegisteredProcessing('missing',()=>true),'cancelled');
let failureCalls=0;await assert.rejects(()=>runSerialProcessing([1,2],async()=>{failureCalls++;throw Error('offline');},()=>false,()=>{}),/offline/);assert.equal(failureCalls,1);
const stages=[];
await runSerialProcessing(['A','B'],async item=>{
  stages.push(item+'高清');await new Promise(resolve=>setTimeout(resolve,2));
  stages.push(item+'插帧60');await new Promise(resolve=>setTimeout(resolve,2));
  stages.push(item+'最终视频');return 'completed';
},()=>false,()=>{});
assert.deepEqual(stages,['A高清','A插帧60','A最终视频','B高清','B插帧60','B最终视频']);
const ui=readWorkspaceSource();
const batch=ui.slice(ui.indexOf('function BatchVideoActions'),ui.indexOf('function BatchReferenceAction'));
assert.match(batch,/start\('smooth'\)[\s\S]*?start\('upscale-60'\)/,'combined button follows interpolation');
assert.match(batch,/createUpscaleNode\(editor,point,current,kind==='upscale-60'\?"1080p":"2x",kind==='upscale-60'\)/);
assert.match(batch,/await runRegisteredProcessing\(node.id/,'wait for the entire pipeline before the next video');
assert.match(batch,/批量1080P＋60 FPS/);
assert.match(batch,/runSerialProcessing\(sources/);
assert.match(batch,/useState<'safe'\|'quality'\|null>\(null\)/,'batch must not silently pick safe');
assert.match(batch,/kind!=='smooth'&&!upscaleProfile/,'no profile blocks HD batches before creating/submitting tasks');
assert.match(batch,/aria-label="批量 SeedVR2 档位"/);
assert.match(batch,/setUpscaleProfile\('safe'\)/);assert.match(batch,/setUpscaleProfile\('quality'\)/);
assert.match(batch,/const batchProfile=upscaleProfile/,'freeze the user choice for the complete batch');
assert.match(batch,/props:\{upscaleProfile:batchProfile!/,'write the chosen profile into every HD node before starting');
console.log('PASS serial execution, batch 1080P+60 wiring and final-before-next order; failure/cancel/uncertain stops, no retries, controller registration. No GPU/API calls.');
