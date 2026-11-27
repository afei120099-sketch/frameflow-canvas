import assert from 'node:assert/strict';
import {planUpscaleSegments,prepareSegmentedUpscale,runSegmentedUpscale} from '../lib/segmented-upscale.ts';
import {watchRun} from '../lib/run-recovery.ts';
for(const fps of [24,30,48,29.97]) for(const frames of [1,71,72,73,362,365,1000]) {
  const segments=planUpscaleSegments(frames,fps);
  assert.equal(segments.reduce((sum,s)=>sum+s.frames,0),frames);
  assert.equal(segments[0].startFrame,0);
  segments.forEach((s,i)=>{assert.ok(s.inputFrames<=Math.round(3*fps)+16);assert.ok(s.trimFrames+s.frames<=s.inputFrames);if(i)assert.equal(s.startFrame,segments[i-1].startFrame+segments[i-1].frames);});
}
assert.throws(()=>planUpscaleSegments(20,0));
const original={frames:362,fps:24,width:768,height:1376};
const blob=new Blob([JSON.stringify(original)],{type:'video/mp4'});
const jobs=new Map();let sequence=0;
const saved=globalThis.fetch;
globalThis.fetch=async(url,init={})=>{
  const path=String(url).replace('/__rough_cut/jobs','');
  const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  if(path==='') {const input=JSON.parse(init.body);const id=String(++sequence);jobs.set(id,{clips:input.clips,sources:new Map()});return json({id,sources:[...new Set(input.clips.flatMap(c=>[c.key,...(c.audioSourceKey?[c.audioSourceKey]:[])]))]});}
  const [id,action,key]=path.slice(1).split('/');const job=jobs.get(id);
  if(action==='sources'){job.sources.set(key,JSON.parse(await init.body.text()));return json({received:1});}
  if(action==='plan') {
    const first=job.sources.get(job.clips[0].key);const frames=job.clips.reduce((sum,c)=>sum+Math.round((Math.min(c.outPoint,job.sources.get(c.key).frames/first.fps)-c.inPoint)*first.fps),0);
    job.output={...first,frames};
    return json({output:{...job.output,fpsValue:first.fps},clips:job.clips.map(c=>({...job.sources.get(c.key),duration:job.sources.get(c.key).frames/first.fps}))});
  }
  if(action==='start')return json({state:'running'});
  if(action==='result')return new Response(JSON.stringify(job.output),{headers:{'Content-Type':'video/mp4'}});
  if(action==='cancel')return json({});
  if(init.method==='DELETE')return json({});
  return json({state:'done'});
};
try {
  const oversized=new Blob([JSON.stringify({...original,width:1536,height:2752})],{type:'video/mp4'});
  await assert.rejects(()=>prepareSegmentedUpscale(oversized,'already-upscaled.mp4',15.1),/1536×2752.*3072×5504.*4096.*未提交渲染/);
  const plan=await prepareSegmentedUpscale(blob,'original.mp4',15.1);
  const seen=[];
  const result=await runSegmentedUpscale(blob,'original.mp4',plan,async(cut,name,clip,options)=>{
    assert.equal(clip,undefined,'already physically cut before ComfyUI');
    const data=JSON.parse(await cut.text());assert.ok(data.frames<=88);
    seen.push(options.promptId);
    return {video:new Blob([JSON.stringify({...data,width:data.width*2,height:data.height*2})]),filename:name,promptId:options.promptId};
  },{promptId:'parent',beforeSegment:async()=>{}});
  assert.deepEqual(seen,plan.segments.map(s=>s.promptId));
  const output=JSON.parse(await result.video.text());
  assert.equal(output.frames,original.frames);assert.equal(output.fps,original.fps);assert.equal(output.width,1536);assert.equal(output.height,2752);
  const final=[...jobs.values()].at(-1);assert.ok(final.clips.every(c=>c.audioSourceKey==='original'),'original audio, not chunk audio');
  assert.equal(final.clips[0].audioInPoint,0);
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>runSegmentedUpscale(blob,'x',plan,async()=>{throw Error('must not submit');},{signal:controller.signal,beforeSegment:async()=>{}}),e=>e.name==='AbortError');
  const recovered=await watchRun({runId:'parent',capabilityId:'seedvr2_upscale',comfyPromptId:'chunk',parameters:{segmentedUpscale:true}}, {isAvailable:async()=>true,probeJob:async()=>{throw Error('must not finalize a chunk');}});
  assert.equal(recovered.phase,'unconfirmed');
}finally{globalThis.fetch=saved;}
console.log('PASS segmented upscale: frame-exact plan, physical pre-VAE cuts, sequential prompts, final-only video, original audio, cancel and fail-closed recovery');
