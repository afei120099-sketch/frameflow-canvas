import assert from 'node:assert/strict';
import {communityInputMode} from '../lib/h3-workflow-options.ts';
import {runH3Preflight} from '../lib/h3-preflight.ts';
import {planH3Submission} from '../lib/comfyui/h3-adapter.ts';
import {buildReferenceManifest,manifestPayload} from '../lib/reference-manifest.ts';
const empty={pictures:0,videos:0,audios:0,standaloneAudios:0,subjects:0};
const input={prompt:'A bird flies across a garden.',counts:empty,length:124,megapixels:.5,dimensions:{width:960,height:544}};
assert.equal(runH3Preflight({...input,mode:communityInputMode(empty)}).ok,true,'text needs no material');
const emptyInput={images:[],videos:[],audios:[],roles:[],roleAssets:{},dialogue:[],soundMode:'av'};
assert.throws(()=>buildReferenceManifest(emptyInput),/至少需要一项/,'ordinary Ref2VA still requires material');
const manifest=buildReferenceManifest({...emptyInput,allowEmptyForTextGeneration:true});
assert.deepEqual(manifestPayload(manifest),{images:[],videos:[],audios:[]});
assert.equal(runH3Preflight({...input,prompt:'Use <Picture 1>.',mode:communityInputMode(empty)}).ok,false,'missing references still rejected');
assert.equal(communityInputMode({...empty,pictures:1}),'ref2va');
assert.equal(communityInputMode({...empty,audios:1}),'ref2va');
assert.equal(communityInputMode(empty,true),'ref2va','endpoint mode never falls back silently');
for(const id of ['community-ultimate','community-dialogue']) {
 const plan=planH3Submission({workflowOptionId:id,taskMode:communityInputMode(empty),prompt:input.prompt,seed:1,settings:{length:124,aspect:'16:9',megapixels:.5,turbo:true,steps:10,fps:24,loraStrength:.75,upscaleMethod:'lanczos',resolutionSteps:32}},{references:{images:[],videos:[],audios:[]}});
 assert.equal(plan.workflow['136'].class_type,'MiniMaxH3AudioConditioningT8');
 assert.equal(plan.workflow['136'].inputs.task_type,'T2VA');
 assert.throws(()=>planH3Submission({workflowOptionId:id,taskMode:'t2va',prompt:'',seed:1,settings:{length:124,aspect:'16:9',megapixels:.5,turbo:true,steps:10,fps:24,loraStrength:.75,upscaleMethod:'lanczos',resolutionSteps:32}},{references:{images:[],videos:[],audios:[]}}),/Prompt/);
}
console.log('PASS community text preflight: no mandatory materials, correct T2VA graphs, reference-mode and prompt checks preserved');
