import assert from 'node:assert/strict';
import { inspectH3Submission } from '../lib/h3-submission-review.ts';
import { h3ReferenceLayout, prepareH3ReferenceSubmission } from '../lib/h3-reference-submission.ts';
import { manifestPayload } from '../lib/reference-manifest.ts';
import { planH3Submission } from '../lib/comfyui/h3-adapter.ts';
import { voiceReferenceLabels } from '../lib/voice-reference-status.ts';

const asset = (id, kind) => ({assetId:id,kind,filename:id+(kind==='audio'?'.wav':kind==='video'?'.mp4':'.png'),storageReference:`${kind}:${id}`});
const assets = Object.fromEntries([['scene','image'],['face','image'],['voice','audio'],['first','image'],['last','image'],['ambience','audio'],['clip','video']].map(([id,kind])=>[id,asset(id,kind)]));
assets.clip.duration=5; assets.clip.fps=24;
const role = {roleId:'host',displayName:'自己',description:'',appearanceAssetIds:['face'],voiceAssetIds:['voice'],primaryAppearanceAssetId:'face',primaryVoiceAssetId:'voice'};
const media = id => ({src:assets[id].storageReference,name:assets[id].filename});
const settings={length:141,aspect:'16:9',megapixels:.88,turbo:true,steps:10,fps:24,loraStrength:.75,upscaleMethod:'lanczos',resolutionSteps:32,soundMode:'av'};
const layoutOptions={first:null,last:null,capturedFirst:false,capturedLast:false,extension:false,keyframes:false,references:[{...media('scene'),source:'reference_image'}],guides:[]};
const spec={prompt:'<Subject 1> says <d>你好</d> in <Picture 1>.',promptMode:'plain',settings,workflowOptionId:'community-ultimate',referenceMode:true,community:true,mode:'ref2va',layout:h3ReferenceLayout(layoutOptions),videos:[],audios:[],roleIds:['host'],voiceRoleId:'host',dialogue:[],guides:[],problems:[]};
let checked=[];
const readers={
  assetBySource:async src=>Object.values(assets).find(a=>a.storageReference===src)??null,
  asset:async id=>assets[id]??null, role:async id=>id==='host'?role:null,
  imageSize:async()=>({width:1920,height:1080}),
  checkMedia:async(src,kind,name)=>{ checked.push({src,kind,name}); },
};
const before=JSON.stringify({spec,assets,role});
const review=await inspectH3Submission(spec,readers);
assert.deepEqual(review.errors,[]);
assert.equal(review.parameters.megapixels,.88);
assert.ok(review.parameters.width>1000 && review.parameters.height>650);
assert.deepEqual(voiceReferenceLabels(review.manifest),['自己 主声音 · Audio 1']);
assert.deepEqual(review.inputs.map(i=>i.label),['Picture 1','Picture 2','Audio 1']);
assert.match(review.finalPrompt,/<Audio 1>: reference/);
assert.deepEqual(checked.map(i=>i.src),['image:scene','image:face','audio:voice']);
assert.equal(JSON.stringify({spec,assets,role}),before,'inspection cannot mutate node or assets');

// The preview and actual submission compile through the SAME plan, including keyframe remapping.
const framed={...spec,layout:h3ReferenceLayout({...layoutOptions,first:media('first'),last:media('last'),capturedFirst:true,capturedLast:true,keyframes:true}),keyframes:{first:'image:first',last:'image:last'}};
const frameReview=await inspectH3Submission(framed,readers);
assert.deepEqual(frameReview.errors,[]);
assert.deepEqual(frameReview.manifest.pictureRefs.map(ref=>ref.assetId),['first','last','scene','face']);
assert.deepEqual(frameReview.inputs.map(i=>i.label),['Picture 1 · 首帧','Picture 2 · 尾帧','Picture 3','Picture 4','Audio 1']);
assert.match(frameReview.finalPrompt,/in <Picture 3>/);
assert.match(frameReview.finalPrompt,/identity reference <Picture 4>/);
const explicit=item=>({...Object.values(assets).find(a=>a.storageReference===item.src),source:item.source});
const actual=prepareH3ReferenceSubmission({images:framed.layout.images.map(explicit),trailingImages:framed.layout.trailingImages.map(explicit),videos:[],audios:[],roles:[role],roleAssets:assets,dialogue:[],voiceRoleId:'host',soundMode:'av'},
  {prompt:spec.prompt,promptMode:'plain',community:true,keyframes:framed.keyframes});
assert.equal(frameReview.finalPrompt,actual.compiled.prompt);
assert.deepEqual(frameReview.manifest.submissionOrder,actual.manifest.submissionOrder);
const payload=manifestPayload(frameReview.manifest);
const plan=planH3Submission({workflowOptionId:spec.workflowOptionId,taskMode:'ref2va',referenceMode:true,communityKeyframes:actual.communityKeyframes,prompt:spec.prompt,compiledPrompt:actual.compiled.prompt,seed:1,settings},
 {references:{images:payload.images.map(i=>i.filename),videos:[],audios:payload.audios.map(i=>i.filename)}});
assert.equal(plan.workflow['136'].inputs.width,frameReview.parameters.width);
assert.equal(plan.workflow['136'].inputs.height,frameReview.parameters.height);
assert.equal(plan.workflow['ff-community-audio-0'].inputs.audio,'voice.wav');

const missingVoice=await inspectH3Submission(spec,{...readers,role:async()=>({...role,primaryVoiceAssetId:null})});
assert.ok(missingVoice.errors.some(e=>/主声音/.test(e)));
assert.equal(missingVoice.manifest,undefined,'never fabricate a trustworthy manifest after validation failure');
const missingRole=await inspectH3Submission(spec,{...readers,role:async()=>null});
assert.ok(missingRole.errors.some(e=>/角色/.test(e)));
const unreadable=await inspectH3Submission(spec,{...readers,checkMedia:async src=>{if(src==='audio:voice'||src==='image:scene')throw Error('missing');}});
assert.ok(unreadable.errors.some(e=>e.includes('Audio 1')&&e.includes('不可读取')));
assert.ok(unreadable.errors.some(e=>e.includes('Picture 1')&&e.includes('不可读取')));
const missingTag=await inspectH3Submission({...spec,prompt:'Use <Picture 9> and <Audio 3>.'},readers);
assert.ok(missingTag.errors.some(e=>e.includes('Picture 9')));
assert.ok(missingTag.errors.some(e=>e.includes('Audio 3')));
const empty=await inspectH3Submission({...spec,prompt:''},readers);
assert.ok(empty.errors.some(e=>/缺少提示词/.test(e)));

const silent={...spec,prompt:'A peaceful landscape.',voiceRoleId:undefined,settings:{...settings,soundMode:'ambient'}};
const silentReview=await inspectH3Submission(silent,{...readers,role:async()=>({...role,primaryVoiceAssetId:null})});
assert.deepEqual(silentReview.errors,[]);
assert.deepEqual(voiceReferenceLabels(silentReview.manifest),[]);
// No-dialogue shots need no voice reference. The only hint is the 正本 rule that every shot writes a 声音 row
// (room tone + action sounds), so H3 does not invent speech; once the row is there, nothing is flagged.
assert.ok(!silentReview.warnings.some(e=>/固定音色|主声音|Audio/.test(e)),'no-dialogue shots need no voice');
assert.deepEqual(silentReview.warnings.filter(e=>!/^体检：无台词镜头没写声音/.test(e)),[],'only the 正本 sound-row hint');
const silentWithSound=await inspectH3Submission({...silent,prompt:'A peaceful landscape.\n声音：很轻的房间底噪，风吹过草地的沙沙声。'},{...readers,role:async()=>({...role,primaryVoiceAssetId:null})});
assert.deepEqual(silentWithSound.errors,[]);
assert.deepEqual(silentWithSound.warnings,[],'a written 声音 row clears the hint');
const rawSpeech=await inspectH3Submission({...spec,voiceRoleId:undefined},readers);
assert.deepEqual(rawSpeech.errors,[]);
assert.deepEqual(voiceReferenceLabels(rawSpeech.manifest),['自己 主声音 · Audio 1']);
const noSpeaker=await inspectH3Submission({...spec,voiceRoleId:undefined,roleIds:[]},readers);
assert.ok(noSpeaker.errors.some(e=>/没有说话角色/.test(e)));
const optedOut=await inspectH3Submission({...spec,voiceRoleId:undefined,autoVoiceDisabled:true},readers);
assert.deepEqual(optedOut.errors,[]);
assert.deepEqual(voiceReferenceLabels(optedOut.manifest),[]);
const globalOff=await inspectH3Submission({...spec,voiceRoleId:undefined,autoVoiceEnabled:false},readers);
assert.ok(globalOff.errors.some(e=>/没有说话角色/.test(e)));
const offscreen=await inspectH3Submission({...spec,voiceRoleId:undefined,offscreenRoleIds:['host']},readers);
assert.deepEqual(offscreen.errors,[]);
assert.deepEqual(offscreen.inputs.map(i=>i.label),['Picture 1','Audio 1']);

const withOtherAudio=await inspectH3Submission({...spec,workflowOptionId:'stable',community:false,videos:[{...media('clip'),withAudio:true}],audios:[media('ambience')]},readers);
assert.deepEqual(withOtherAudio.errors,[]);
assert.deepEqual(voiceReferenceLabels(withOtherAudio.manifest),['自己 主声音 · Audio 3']);
assert.equal(withOtherAudio.parameters.width,null,'native reference workflow resolves size on the backend');
assert.equal(withOtherAudio.parameters.megapixels,.88);

for(const community of [false,true]) {
 const text=await inspectH3Submission({...spec,community,workflowOptionId:community?'community-ultimate':'stable',referenceMode:community,mode:community?'ref2va':'t2va',prompt:'A landscape.',roleIds:[],voiceRoleId:undefined,layout:h3ReferenceLayout({...layoutOptions,references:[]})},readers);
 assert.deepEqual(text.errors,[]); assert.equal(text.mode,'t2va'); assert.deepEqual(text.inputs,[]);
}
const first=await inspectH3Submission({...spec,community:false,workflowOptionId:'stable',referenceMode:false,mode:'i2va',prompt:'A landscape.',voiceRoleId:undefined,roleIds:[],primary:media('first')},readers);
assert.deepEqual(first.errors,[]); assert.equal(first.inputs[0].label,'Picture 1 · 首帧');
console.log('PASS H3 pre-submit review: exact shared manifest/prompt and graph dimensions, keyframe order, Audio numbering, missing inputs, no-dialogue compatibility, no mutations');
