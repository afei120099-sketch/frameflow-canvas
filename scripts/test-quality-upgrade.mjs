import assert from 'node:assert/strict';
import {newEnhancementCheckpoint,executeEnhancement,interpolationTensorBytes} from '../lib/enhancement-pipeline.ts';
import {boundInterpolationPlan,INTERPOLATION_OUTPUT_LIMIT} from '../lib/enhancement-memory.ts';
import {planModelBatches,workflowModelKey,scheduledPromptFetch} from '../lib/comfyui/submission-scheduler.ts';
import {captureWorkflow,lockedWorkflow} from '../lib/locked-generation.ts';
import {historyExecutionTiming,createExecutionClock} from '../lib/execution-timing.ts';
import {buildSeedVR2Workflow} from '../lib/comfyui/extra-workflows.ts';
import {buildFilmWorkflow,film60Plan} from '../lib/comfyui/film-workflow.ts';
import {buildFluxDev} from '../lib/comfyui/flux-dev.ts';

const plan={fps:24,frames:96,width:864,height:480,outputWidth:1920,outputHeight:1080,segments:[]};
for(const fps of [24,25,30,48,50,60,120]) {
  const p=boundInterpolationPlan({...plan,fps,frames:fps*8});
  assert.equal(p.segments.reduce((sum,s)=>sum+s.frames,0),fps*8);
  for(const s of p.segments)assert.ok(interpolationTensorBytes(s.inputFrames+1,p.outputWidth,p.outputHeight,film60Plan(fps).multiplier)<=INTERPOLATION_OUTPUT_LIMIT);
  assert.equal(p.segments.reduce((sum,s)=>sum+Math.round((s.startFrame+s.frames)/fps*60)-Math.round(s.startFrame/fps*60),0),480);
}
const p=boundInterpolationPlan(plan),blobs=new Map([['original',new Blob(['original'])]]);
let checkpoint,serial=0,merges=0,interrupted=true;const events=[];
const io={
  save:async c=>{checkpoint=structuredClone(c);},load:async source=>{assert.ok(blobs.has(source));return blobs.get(source);},
  store:async(blob,name)=>{const src=`saved-${serial++}`;blobs.set(src,blob);return src;},
  cut:async(original,c,s)=>{assert.equal(await original.text(),'original');return new Blob([`cut${s.index}`]);},
  render:async(stage,blob,name,options)=>{
    const step=checkpoint.steps.find(s=>s.promptId===options.promptId);
    assert.equal(step.state,'reserved','durable checkpoint before POST');
    events.push(`${stage}:${step.segment.index}`);
    if(interrupted && events.length===2){interrupted=false;throw new Error('connection lost after acceptance');}
    options.onTiming?.({startedAt:1000+events.length*100,completedAt:1100+events.length*100,stages:{sampling:100}});
    return {video:new Blob([stage]),filename:name,promptId:options.promptId};
  },
  recover:async id=>{events.push(`recover:${id}`);return {video:new Blob(['recovered']),filename:'recovered.mp4',promptId:id};},
  merge:async(c,original,outputs)=>{merges++;assert.ok(outputs.every(o=>o.step.stage==='interpolate'));return new Blob(['final']);},
};
const initial=newEnhancementCheckpoint({runId:'r1',plan:p,combined:true,profile:'safe',originalSource:'original',originalName:'original.mp4'});
await assert.rejects(executeEnhancement(initial,io),/connection lost/);
assert.equal(checkpoint.steps[0].state,'completed');assert.equal(checkpoint.steps[1].state,'reserved');
const lostId=checkpoint.steps[1].promptId;
const result=await executeEnhancement(checkpoint,io);
assert.equal(await result.video.text(),'final');assert.equal(merges,1);
assert.equal(events.filter(s=>s===`recover:${lostId}`).length,1);
assert.equal(events.filter(s=>s==='upscale:0').length,1,'completed segment never resubmitted');
const firstFilm=events.findIndex(e=>e.startsWith('interpolate:'));
assert.ok(events.slice(firstFilm).every(e=>e.startsWith('interpolate:')),'all HD before all FILM');
const count=events.length;await executeEnhancement(checkpoint,io);assert.equal(events.length,count);assert.equal(merges,1,'final output checkpoint is reusable');
const abort=new AbortController();abort.abort();await assert.rejects(executeEnhancement(initial,io,{signal:abort.signal}),e=>e.name==='AbortError');
const unknown={...checkpoint,finalSource:undefined,steps:[{...checkpoint.steps[0],state:'reserved',source:undefined}]};
await assert.rejects(executeEnhancement(unknown,{...io,recover:async()=>{throw new Error('unknown task; no retry');}}),/no retry/);

const jobs=[{id:'a',modelKey:'H3'},{id:'b',modelKey:'HD',dependsOn:['a']},{id:'c',modelKey:'H3'},{id:'d',modelKey:'FILM',dependsOn:['b']},{id:'e',modelKey:'HD',dependsOn:['c']}];
assert.deepEqual(planModelBatches(jobs).map(j=>j.id),['a','c','b','e','d']);
assert.throws(()=>planModelBatches([{id:'a',modelKey:'H3',dependsOn:['b']},{id:'b',modelKey:'HD',dependsOn:['a']}]),/循环/);
assert.throws(()=>planModelBatches([{id:'a',modelKey:'H3',dependsOn:['missing']}]),/不存在/);
const posted=[];const mock=async(url,init)=>{posted.push(JSON.parse(init.body));return Response.json({prompt_id:'x'});};
const graph=buildFilmWorkflow('a.mp4');
await Promise.all([scheduledPromptFetch('/prompt',{method:'POST',body:JSON.stringify({prompt:graph,prompt_id:'one'})},mock),scheduledPromptFetch('/prompt',{method:'POST',body:JSON.stringify({prompt:graph,prompt_id:'two'})},mock)]);
assert.deepEqual(posted.map(p=>p.prompt_id),['one','two']);assert.ok(workflowModelKey(graph).includes('film_net'));
const cancelled=new AbortController();cancelled.abort();await assert.rejects(scheduledPromptFetch('/prompt',{body:JSON.stringify({prompt:graph}),signal:cancelled.signal},mock),e=>e.name==='AbortError');assert.equal(posted.length,2);

const submitted=await captureWorkflow(graph,'7'),run={submissionSnapshot:submitted,seed:42,finalPrompt:'same prompt',status:'completed'};
const clone=await lockedWorkflow(run);clone.graph['4'].inputs.file='changed';assert.equal(submitted.graph['4'].inputs.file,'a.mp4');
await assert.rejects(lockedWorkflow({...run,submissionSnapshot:undefined}),/旧候选/);
await assert.rejects(lockedWorkflow({...run,submissionSnapshot:{...submitted,digest:'wrong'}}),/校验失败/);
const clock=createExecutionClock((()=>{let time=1000;return ()=>time+=100;})());clock.observe('queued');clock.observe('loading');clock.observe('running');clock.observe('decoding');const timing=clock.finish();assert.equal(timing.startedAt,1100);assert.deepEqual(timing.stages,{'准备/加载':100,'采样':100,'解码/保存':100});
assert.deepEqual(historyExecutionTiming({status:{messages:[['execution_start',{timestamp:123}],['execution_success',{timestamp:456}]]}}),{stages:{},startedAt:123,completedAt:456,source:'history'});
for(const profile of ['safe','quality']){
  const graph=buildSeedVR2Workflow('in.mp4',{profile});
  assert.equal(graph['66:99'].inputs['chunking_mode.frames_per_chunk'],profile==='safe'?9:21);
  assert.equal(graph['66:105'].inputs.value,true);assert.equal(graph['66:48'].inputs.tile_size,512);
}
const fluxInput={prompt:'change hair colour',seed:1,width:768,height:1024,imageName:'i.png',maskName:'m.png',denoise:.45};
assert.equal(buildFluxDev(fluxInput)['5'].inputs.denoise,.45);assert.equal(buildFluxDev(fluxInput)['26'],undefined);assert.equal(buildFluxDev({...fluxInput,extraLora:false})['26'],undefined);assert.equal(buildFluxDev({...fluxInput,extraLora:true})['26'],undefined);
console.log('PASS quality upgrade: bounded memory/frames, durable reserve and reconnect, stage order, one final output, no unknown retry, scheduler dependencies, immutable snapshots, actual timing, SeedVR profiles and Flux controls. All render calls mocked; no GPU submission.');
