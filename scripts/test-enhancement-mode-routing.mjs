// Execute the real node's generate function with fake media/ComfyUI. No network or GPU.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {boundInterpolationPlan} from '../lib/enhancement-memory.ts';
import {planUpscaleSegments} from '../lib/segmented-upscale.ts';
import {nightAttempts,runNightAttempts} from '../lib/night-postprocess.ts';
import { readWorkspaceSource } from './workspace-source.mjs';
const source=readWorkspaceSource();
const batch=source.slice(source.indexOf('function BatchVideoActions'),source.indexOf('function BatchReferenceAction'));
assert.match(batch,/props:\{upscaleProfile:batchProfile!,clipMode:batchMode\}/,'both HD entry points must write the selected mode');
assert.doesNotMatch(batch,/kind==='upscale'\?\{clipMode:/,'combined batches must not skip the mode');
assert.match(batch,/nightAttempts\(batchProfile!,batchMode==='segmented'\)/);
assert.match(batch,/value=\{upscaleMode\} disabled=\{busy\}/,'night mode must not force or lock the selector to whole');
const start=source.indexOf('  const generate = async',source.indexOf('function UpscaleNodeContent'));
const body=source.slice(start,source.indexOf('\n  useProcessingController',start));
const js=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
async function execute(mode,profile='quality',options={}){
 const calls=[],updates=[],failures=[],runs=[],checkpoints=[];
 const input=new Blob(['source']),output=new Blob(['processed']);
 const live={id:'node',type:'upscale-node',props:{clipMode:mode,upscaleProfile:profile,start:2,duration:1},meta:{batchRequestedRangeMode:mode}};
 const result={video:output,filename:'final.mp4'};
 const context={
  busy:false,recovery:{blocking:false,recheck:async()=>{}},
  source:{props:{src:'local:source',name:'source.mp4'}},
  // Simulate a stale React closure: actual editor selection has already become segmented.
  shape:{...live,props:{...live.props,clipMode:options.staleMode??'whole'}},
  editor:{getShape:()=>live},combined:true,target1080:true,targetEdge:1080,
  claimNode:()=>()=>calls.push('release'),setStatus:()=>{},setError:()=>{},setProgress:()=>{},
  abortRef:{current:null},jobRef:{current:''},runIdRef:{current:''},
  getLocalVideoBlob:async()=>input,
  readVideoMetadata:async blob=>blob===input?{width:1280,height:736,duration:'15秒'}:{width:1920,height:1080,duration:'15秒'},
  assetForSource:async()=>({assetId:'input',storageReference:'local:source'}),
  durationSeconds:()=>15,video1080Dimensions:()=>({width:1920,height:1080}),
  readMp4VideoFps:async blob=>blob===input?24:60,
  snapshotUpscale60:async()=>({parameters:{},workflowIdentity:{}}),snapshotUpscale:async()=>({parameters:{}}),
  prepareSegmentedUpscale:async(_blob,_name,_duration,_signal,_dims,config)=>{
   calls.push('prepare-segments');return {fps:24,frames:360,width:1280,height:736,outputWidth:1920,outputHeight:1080,segments:planUpscaleSegments(360,24,config.seconds,config.contextFrames)};
  },boundInterpolationPlan,
  createRunExclusively:async(_id,_list,create)=>create(),listRuns:async()=>[],
  createRun:async value=>{const run={...value,runId:'run'};runs.push(run);return run;},addRunToShot:async()=>{},
  recordRunUpdate:(_id,patch)=>updates.push(patch),
  saveEnhancement:async checkpoint=>checkpoints.push(checkpoint),newEnhancementCheckpoint:value=>value,
  resumeEnhancement:async run=>{calls.push('segmented');assert.equal(run.parameters.executionRangeMode,'segmented');if(options.segmentFailure)throw Error('测试分段失败');return result;},
  comfyUIH3Adapter:{upscale60:async()=>{calls.push('whole');throw Error('整段内存预检未通过：插帧中间张量约42.0 GiB');},upscale:async()=>result},
  finalizeRunOutput:async(_id,_store,create)=>({asset:await create()}),runOutputStore:{},
  storeLocalVideo:async()=> 'local:output',generatedVideoAsset:()=>({assetId:'output'}),
  presentDerivedVideo:()=>calls.push('present'),logTaskDone:()=>{},showCanvasToast:()=>{},
  isUncertainAfterSubmit:()=>false,logTaskUncertain:()=>{},humanizeGenerationError:e=>e.message,
  logTaskFailure:(...args)=>failures.push(args),
 };
 const generate=new Function(...Object.keys(context),js+'\nreturn generate;')(...Object.values(context));
 const status=await generate();return {status,calls,updates,failures,runs,checkpoints};
}
const segmented=await execute('segmented');
assert.equal(segmented.status,'completed');assert.ok(!segmented.calls.includes('whole'),'selected segmented must never call the whole adapter');
assert.equal(segmented.checkpoints.length,1);assert.equal(segmented.runs[0].parameters.segmentedUpscale,true);
assert.match(segmented.runs[0].parameters.executionModeLabel,/分段高清.*画质实验档/);
const whole=await execute('whole','quality');assert.equal(whole.status,'failed');assert.ok(whole.calls.includes('whole'));
assert.match(whole.failures[0][3],/本次执行：整段.*42.0/);
const failedSegment=await execute('segmented','safe',{segmentFailure:true});assert.equal(failedSegment.status,'failed');
assert.match(failedSegment.failures[0][3],/本次执行：分段高清.*16G安全档/);
assert.match(failedSegment.updates.at(-1).error,/分段高清/);
// A rejected whole preflight still advances to bounded segments in night mode.
const wholeVisits=[];
assert.equal(await runNightAttempts(nightAttempts('quality',false),async a=>{const r=await execute(a.segmented?'segmented':'whole',a.profile);wholeVisits.push(r.calls);return r.status;},()=>false),'completed');
assert.equal(wholeVisits.length,3);assert.ok(wholeVisits[2].includes('segmented'));
const segmentVisits=[];
assert.equal(await runNightAttempts(nightAttempts('quality',true),async(a,i)=>{segmentVisits.push(a.segmented);const r=await execute('segmented',a.profile,{segmentFailure:i===0});return r.status;},()=>false),'completed');
assert.deepEqual(segmentVisits,[true,true]);
console.log('PASS actual generate routing with stale whole props: segmented never calls whole preflight; night fallback respects selection; Run and errors retain actual mode. Mocked media only, no GPU/network.');
