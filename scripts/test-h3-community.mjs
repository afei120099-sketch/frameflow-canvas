import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCommunityWorkflow, communityTemplate } from '../lib/comfyui/experimental/h3-community.ts';
import { planH3Submission, ComfyUIH3Adapter } from '../lib/comfyui/h3-adapter.ts';
import { communitySettings, communityInputProblem } from '../lib/h3-workflow-options.ts';
import { snapshotH3 } from '../lib/production-snapshots.ts';
import { saveNodeForRun, watchRun } from '../lib/run-recovery.ts';

const settings = { length: 124, aspect: '16:9', megapixels: .3, turbo: true, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: 'lanczos', resolutionSteps: 32, soundMode: 'av' };
for (const id of ['community-ultimate', 'community-dialogue']) {
  const original = JSON.stringify(communityTemplate(id).template);
  for (const count of [1, 4, 5, 9]) {
    const names = Array.from({length: count}, (_, i) => `ref${i}.png`);
    const graph = buildCommunityWorkflow(id, names, 'test prompt', 123, settings);
    assert.equal(graph['138'].inputs.value, 'test prompt');
    assert.equal(graph['129'].inputs.noise_seed, 123);
    assert.equal(graph['136'].inputs.length, 124);
    assert.equal(Object.keys(graph['136'].inputs).filter(k => k.startsWith('ref_images.')).length, count);
    names.forEach((name, i) => assert.equal(graph[`ff-community-image-${i}`].inputs.image, name));
    assert.equal(graph['137'], undefined);
    for (const key of ['127','128','145','125','123']) assert.deepEqual(graph[key], communityTemplate(id).template[key], `frozen model/sampler ${key}`);
    assert.equal(JSON.stringify(communityTemplate(id).template), original, 'never mutate frozen template');
    const input = { workflowOptionId: id, taskMode:'ref2va', prompt:'raw', compiledPrompt:'compiled exact', seed:123, settings };
    const plan = planH3Submission(input, {references:{images:names,videos:[],audios:[]}});
    assert.equal(plan.saveNodeId, '148'); assert.equal(plan.workflow['138'].inputs.value, 'compiled exact');
    const snap = await snapshotH3({ ...input, referenceMode:true, sourceWidth:0, sourceHeight:0, hasLastFrame:false, referenceCounts:{images:count,videos:0,audios:0,videoAudioFlags:[]} });
    assert.equal(snap.parameters.workflowOptionId, id); assert.equal(snap.parameters.saveNodeId, '148');
    if (count > 4) assert.equal(snap.parameters.acceptance, 'not_render_tested');
    assert.equal(snap.parameters.steps, communitySettings(id).steps);
    assert.equal(snap.parameters.loraStrength, communitySettings(id).loraStrength);
    assert.equal(snap.parameters.width, graph['136'].inputs.width);
    assert.equal(snap.workflowIdentity.templateVersion, 'sha256:' + createHash('sha256').update(original).digest('hex'));
    assert.equal(saveNodeForRun(snap), '148');
  }
  const textGraph = buildCommunityWorkflow(id, [], 'p', 1, settings);
  assert.equal(textGraph['136'].inputs.task_type, 'T2VA');
  assert.equal(textGraph['136'].inputs.first_frame, undefined);
  const textPlan = planH3Submission({workflowOptionId:id,taskMode:'ref2va',prompt:'p',seed:1,settings},{references:{images:[],videos:[],audios:[]}});
  assert.equal(textPlan.workflow['136'].inputs.task_type,'T2VA');
  const textSnapshot = await snapshotH3({workflowOptionId:id,referenceMode:true,prompt:'p',seed:1,settings,sourceWidth:0,sourceHeight:0,hasLastFrame:false,referenceCounts:{images:0,videos:0,audios:0,videoAudioFlags:[]}});
  assert.equal(textSnapshot.parameters.acceptance,'not_render_tested');
  assert.equal(textSnapshot.parameters.mode,'community_text_experimental');
  for (const key of ['127','128','145','125','123']) assert.deepEqual(textGraph[key],communityTemplate(id).template[key]);
  const endpointGraph = buildCommunityWorkflow(id,['first.png','last.png'],'p',1,settings,0,0,{first:1,last:2});
  assert.equal(endpointGraph['136'].inputs.task_type,'FL2VA');
  assert.deepEqual(endpointGraph['136'].inputs.last_frame,['ff-community-image-1',0]);
  assert.throws(() => buildCommunityWorkflow(id, Array(10).fill('a.png'), 'p', 1, settings), /最多9/);
  const voices = ['voice1.wav', 'voice2.wav', 'voice3.wav'];
  const voiceGraph = buildCommunityWorkflow(id, Array(9).fill('a.png'), 'p', 1, settings, 0, 0, undefined, voices);
  voices.forEach((name, i) => {
    assert.equal(voiceGraph[`ff-community-audio-${i}`].inputs.audio, name);
    assert.deepEqual(voiceGraph['136'].inputs[`ref_audios.ref_audio_${i}`], [`ff-community-audio-${i}`, 0]);
  });
  for (const key of ['127','128','145','125','123']) assert.deepEqual(voiceGraph[key], communityTemplate(id).template[key]);
  assert.throws(() => buildCommunityWorkflow(id, ['a.png'], 'p', 1, settings, 0, 0, undefined, [...voices, 'extra.wav']), /最多3/);
  assert.throws(() => buildCommunityWorkflow(id, ['a.png'], 'p', 1, {...settings,length:125}), /帧数/);
  assert.throws(() => buildCommunityWorkflow(id, ['a.png'], 'p', -1, settings), /Seed/);
  assert.throws(() => buildCommunityWorkflow(id, ['a.png'], 'p', 1, {...settings,aspect:'follow'}), /比例/);
  const follow = buildCommunityWorkflow(id,['a.png'],'p',1,{...settings,aspect:'follow',soundMode:'silent'},768,1376);
  assert.ok(follow['136'].inputs.height > follow['136'].inputs.width);
  assert.equal(follow['148'].inputs.audio, undefined);
  assert.equal(saveNodeForRun({capabilityId:'h3_ref2va',parameters:{}}), '92');
  let probed;
  const outcome = await watchRun({runId:'test',capabilityId:'h3_ref2va',comfyPromptId:'test',parameters:{workflowOptionId:id}}, {
    isAvailable:async()=>true, probeJob:async(job,save)=>{probed=save;return {state:'completed',file:{filename:'result.mp4'}};}
  });
  assert.equal(probed,'148'); assert.equal(outcome.phase,'completed');
}
assert.ok(communityInputProblem({pictures:1,videos:1}));
const keyframes = {first:1,last:2};
const keyImages = ['first.png','last.png','ref1.png','ref2.png','ref3.png','ref4.png'];
const keyGraph = buildCommunityWorkflow('community-ultimate',keyImages,'p',1,settings,0,0,keyframes);
assert.equal(keyGraph['136'].class_type,'MiniMaxH3AudioConditioningT8');
assert.equal(keyGraph['136'].inputs.task_type,'Hybrid');
assert.deepEqual(keyGraph['136'].inputs.first_frame,['ff-community-image-0',0]);
assert.deepEqual(keyGraph['136'].inputs.last_frame,['ff-community-image-1',0]);
for(let i=0;i<4;i++) assert.deepEqual(keyGraph['136'].inputs[`ref_images.ref_image_${i}`],[`ff-community-image-${i+2}`,0]);
for(const id of ['127','128','145','125','123']) assert.deepEqual(keyGraph[id],communityTemplate('community-ultimate').template[id]);
assert.equal(buildCommunityWorkflow('community-ultimate',['f.png'],'p',1,settings,0,0,{first:1})['136'].inputs.task_type,'I2VA');
assert.equal(buildCommunityWorkflow('community-ultimate',['f.png','l.png'],'p',1,settings,0,0,keyframes)['136'].inputs.task_type,'FL2VA');
assert.equal(buildCommunityWorkflow('community-dialogue',keyImages,'p',1,settings,0,0,keyframes)['136'].inputs.task_type,'Hybrid');
assert.throws(()=>buildCommunityWorkflow('community-ultimate',keyImages,'p',1,settings,0,0,{first:1,last:1}),/首尾帧/);
assert.throws(()=>buildCommunityWorkflow('community-ultimate',keyImages,'p',1,settings,0,0,{last:2}),/首尾帧/);
const nineKeyRefs = ['first.png', 'last.png', ...Array.from({length:9}, (_,i)=>`ref${i}.png`)];
for (const id of ['community-ultimate','community-dialogue']) {
  const graph = buildCommunityWorkflow(id, nineKeyRefs, 'p', 1, settings, 0, 0, keyframes);
  assert.equal(Object.keys(graph['136'].inputs).filter(k=>k.startsWith('ref_images.')).length,9);
  assert.deepEqual(graph['136'].inputs.last_frame,['ff-community-image-1',0]);
  assert.throws(()=>buildCommunityWorkflow(id,[...nineKeyRefs,'extra.png'],'p',1,settings,0,0,keyframes),/最多9/);
}
const keyPlan=planH3Submission({workflowOptionId:'community-ultimate',communityKeyframes:keyframes,taskMode:'ref2va',prompt:'p',seed:1,settings},{references:{images:keyImages,videos:[],audios:[]}});
assert.equal(keyPlan.workflow['136'].class_type,'MiniMaxH3AudioConditioningT8');
const keySnapshot=await snapshotH3({workflowOptionId:'community-ultimate',communityKeyframes:keyframes,referenceMode:true,prompt:'p',seed:1,settings,sourceWidth:0,sourceHeight:0,hasLastFrame:true,referenceCounts:{images:6,videos:0,audios:0,videoAudioFlags:[]}});
assert.equal(keySnapshot.parameters.acceptance,'not_render_tested');
assert.deepEqual(keySnapshot.parameters.communityKeyframes,keyframes);
assert.match(keySnapshot.workflowIdentity.templateFile,/keyframes-T8/);
assert.equal(communityInputProblem({pictures:9,audios:3}),null);
assert.ok(communityInputProblem({pictures:1,audios:4}));
assert.ok(communityInputProblem({pictures:1,hasLastFrame:true}));
assert.ok(communityInputProblem({pictures:1,guides:1}));
const savedFetch=globalThis.fetch;
try {
  const adapter=new ComfyUIH3Adapter('http://test');
  globalThis.fetch=async()=>new Response(JSON.stringify({prompt_id:'partial',node_errors:{'148':{errors:['invalid']}}}));
  await assert.rejects(()=>adapter.submit({capability:'comfyui-h3',inputs:{workflow:{}}}), /节点校验/);
  let uploads=0;
  globalThis.fetch=async(url)=>{ if(String(url).includes('upload')) uploads++; return new Response(JSON.stringify({})); };
  await assert.rejects(()=>adapter.generate({workflowOptionId:'community-dialogue',taskMode:'ref2va',referenceImages:[{blob:new Blob(['x']),name:'x.png'}],prompt:'p',seed:1,settings}), /缺少工作流节点/);
  assert.equal(uploads,0,'missing dependencies fail before media upload');
  globalThis.fetch=async()=>new Response(JSON.stringify({job:{status:{status_str:'success'},outputs:{'148':{gifs:[{filename:'ok.mp4',type:'output'}]}}}}));
  assert.equal((await adapter.getStatus('job','148')).status,'completed');
} finally { globalThis.fetch=savedFetch; }
console.log('PASS community workflow integration: exact graph routing, 1–9 refs, 3 voices, frozen sampling, real snapshots, recovery save 148, fail closed, VHS output');
