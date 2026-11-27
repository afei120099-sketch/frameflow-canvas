import assert from 'node:assert/strict';
import { parseShotQueue, shotQueueExample, shotQueueH3Props } from '../lib/shot-queue.ts';
import { newQueueSession } from '../lib/shot-queue-session.ts';
import { buildReferenceManifest, manifestPayload } from '../lib/reference-manifest.ts';
import { compileH3Ref2vaPrompt } from '../lib/h3-prompt-compiler.ts';
import { planH3Submission } from '../lib/comfyui/h3-adapter.ts';
import { prepareKeyframeSubmission } from '../lib/video-frame-handoff.ts';
import { voiceReferenceLabels, submittedVoiceLabels } from '../lib/voice-reference-status.ts';

const rawPrompt = 'From 1 to 4 s <Subject 1> (S1), off-screen, says: <d>[Chinese] 给我一分钟。</d> Nobody on screen speaks.';
const sample = shotQueueExample();
const rawShot = { ...sample.chapters[0].shots[0], roleIds: ['host'], sceneAssetIds: ['scene'], prompt: rawPrompt, aspect: '16:9' };
const parse = patch => parseShotQueue(JSON.stringify({ ...sample, chapters: [{ title: '章节', shots: [{ ...rawShot, ...patch }] }] }));
const old = parse({});
assert.equal(old.chapters[0].shots[0].voiceRoleId, 'host');
const queue = parse({ voiceRoleId: 'host' });
assert.deepEqual(parseShotQueue(JSON.stringify(queue)), queue);
assert.equal(newQueueSession('page:voice', queue, {x:0,y:0}).queue.chapters[0].shots[0].voiceRoleId, 'host');
for (const voiceRoleId of ['', ' ', null, 1, true, [], 'other']) assert.throws(() => parse({voiceRoleId}), /voiceRoleId/);
for (const soundMode of ['ambient','silent']) {
  assert.throws(() => parse({soundMode}), /av/);
  assert.doesNotThrow(() => parse({soundMode,prompt:'A landscape with no dialogue.'}));
  assert.throws(() => parse({voiceRoleId:'host',soundMode}), /av/);
}

const asset = (assetId,kind) => ({assetId,kind,filename:assetId+(kind==='audio'?'.wav':'.png'),storageReference:kind+':'+assetId});
const assets = Object.fromEntries([['face','image'],['scene','image'],['voice','audio'],['otherVoice','audio'],['ambience','audio']].map(([id,kind])=>[id,asset(id,kind)]));
const role = {roleId:'host',displayName:'自己',description:'',appearanceAssetIds:['face'],voiceAssetIds:['voice','otherVoice'],primaryAppearanceAssetId:'face',primaryVoiceAssetId:'voice'};
const plan = {scenes:[{assetId:'scene',name:'scene.png',src:'image:scene'}],appearances:[],pictures:[]};
const props = shotQueueH3Props(queue.chapters[0].shots[0],plan);
assert.equal(props.voiceRoleId,'host');
assert.equal(props.prompt,rawPrompt);
assert.equal(props.dialogueLines,undefined,'queue must not duplicate spoken text into structured dialogue');
const input = {images:[{...assets.scene,source:'reference_image'}],videos:[],audios:[],roles:[role],roleAssets:assets,dialogue:[],soundMode:'av',voiceRoleId:props.voiceRoleId};
const manifest = buildReferenceManifest(input);
assert.equal(manifest.dialogue.length,0);
assert.deepEqual(manifestPayload(manifest).audios.map(a=>a.assetId),['voice']);
assert.deepEqual(manifestPayload(manifest).images.map(a=>a.assetId),['scene','face']);
assert.equal(manifest.roleBindings[0].audioRefIndex,1);
assert.deepEqual(voiceReferenceLabels(manifest),['自己 主声音 · Audio 1']);
const compiled = compileH3Ref2vaPrompt({rawPrompt,soundMode:'av',mode:'plain',manifest});
assert.ok(compiled.prompt.startsWith(rawPrompt));
assert.equal(compiled.prompt.split('给我一分钟。').length-1,1,'speech not duplicated');
assert.match(compiled.prompt,/<Audio 1>: reference.*<Subject 1>/);
assert.match(compiled.prompt,/on-screen\/off-screen/);
assert.doesNotMatch(compiled.prompt,/自己\) does not speak/);
assert.equal(input.roles[0].primaryVoiceAssetId,'voice');
assert.equal(input.dialogue.length,0);

// Preserve existing audio order: video soundtrack, explicit audio, role primary.
const mixed=buildReferenceManifest({...input,videos:[{assetId:'video',storageReference:'media:video',filename:'v.mp4',withAudio:true}],audios:[assets.ambience]});
assert.equal(mixed.roleBindings[0].audioRefIndex,3);
assert.match(compileH3Ref2vaPrompt({rawPrompt,soundMode:'av',mode:'plain',manifest:mixed}).prompt,/<Audio 3>: reference/);
assert.deepEqual(manifestPayload(mixed).audios.map(a=>a.assetId),['ambience','voice']);
const deduped=buildReferenceManifest({...input,audios:[assets.voice],dialogue:[{roleId:'host',text:'只有一次'}]});
assert.equal(deduped.audioRefs.length,1);
assert.equal(deduped.speakers.length,1);
assert.throws(()=>buildReferenceManifest({...input,audios:[assets.otherVoice]}),/冲突/);
assert.throws(()=>buildReferenceManifest({...input,roles:[{...role,primaryVoiceAssetId:null}]}),/没有可用主声音/);
assert.throws(()=>buildReferenceManifest({...input,roleAssets:{...assets,voice:null}}),/主声音/);
assert.throws(()=>buildReferenceManifest({...input,roleAssets:{...assets,voice:asset('voice','video')}}),/主声音/);
assert.throws(()=>buildReferenceManifest({...input,voiceRoleId:'missing'}),/说话角色未加入/);
assert.throws(()=>buildReferenceManifest({...input,soundMode:'silent'}),/视听生成/);
assert.throws(()=>buildReferenceManifest({...input,includeRoleVoices:false}),/不支持/);
const legacy=buildReferenceManifest({...input,voiceRoleId:undefined});
assert.equal(legacy.audioRefs.length,0);
assert.equal(compileH3Ref2vaPrompt({rawPrompt,soundMode:'av',mode:'plain',manifest:legacy}).prompt,rawPrompt);

// Verify the actual queued graph contains LoadAudio wired into conditioning, for both routes.
const settings={length:141,aspect:'16:9',megapixels:.5,turbo:true,steps:10,fps:24,loraStrength:.75,upscaleMethod:'lanczos',resolutionSteps:32,soundMode:'av'};
for (const frames of [undefined,{first:1}]) {
  const adapted=prepareKeyframeSubmission(manifest,rawPrompt,frames);
  const prompt=compileH3Ref2vaPrompt({rawPrompt:adapted.prompt,soundMode:'av',mode:'plain',manifest:adapted.manifest}).prompt;
  const payload=manifestPayload(adapted.manifest);
  const result=planH3Submission({workflowOptionId:'community-ultimate',taskMode:'ref2va',referenceMode:true,communityKeyframes:adapted.frames,prompt:rawPrompt,compiledPrompt:prompt,seed:1,settings},{references:{images:payload.images.map(a=>a.filename),videos:[],audios:payload.audios.map(a=>a.filename)}});
  const workflow=result.workflow;
  assert.equal(workflow['ff-community-audio-0'].class_type,'LoadAudio');
  assert.equal(workflow['ff-community-audio-0'].inputs.audio,'voice.wav');
  assert.deepEqual(workflow['136'].inputs['ref_audios.ref_audio_0'],['ff-community-audio-0',0]);
  assert.equal(workflow['136'].class_type,frames?'MiniMaxH3AudioConditioningT8':'MiniMaxH3ReferenceToVideo');
  const sentPrompt=typeof workflow['136'].inputs.prompt==='string'?workflow['136'].inputs.prompt:workflow['138'].inputs.value;
  assert.match(sentPrompt,/<Audio 1>: reference/);
}

const run={ownerNodeId:'node',createdAt:1,comfyPromptId:'reserved-id',submission:'reserved',referenceManifest:manifest};
assert.deepEqual(submittedVoiceLabels('node',[run]),[],'reserved ID does not mean submitted');
const accepted={...run,submission:'accepted'};
assert.deepEqual(submittedVoiceLabels('node',[accepted]),['自己 主声音 · Audio 1']);
assert.deepEqual(submittedVoiceLabels('node',[accepted,{...run,createdAt:2}]),[],'new pending task must not borrow old accepted badge');
assert.deepEqual(submittedVoiceLabels('node',[{...accepted,referenceManifest:legacy}]),[]);
assert.deepEqual(submittedVoiceLabels('other',[accepted]),[]);
assert.deepEqual(submittedVoiceLabels('node',[{...accepted,comfyPromptId:null}]),[]);
console.log('PASS queue voice schema, old queues, primary voice validation, dedupe/order, prompt binding, native and keyframe H3 graphs, accepted-only status');
