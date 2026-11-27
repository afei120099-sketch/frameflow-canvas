import assert from 'node:assert/strict';
import {buildCommunityWorkflow,communityTemplate} from '../lib/comfyui/experimental/h3-community.ts';
import {communityControls,communityActualSteps,parseCommunityValues} from '../lib/comfyui/experimental/h3-community-controls.ts';
import {snapshotH3} from '../lib/production-snapshots.ts';
import {planH3Submission} from '../lib/comfyui/h3-adapter.ts';
const base={length:124,aspect:'16:9',megapixels:.3,turbo:true,steps:6,fps:24,loraStrength:1,upscaleMethod:'lanczos',resolutionSteps:32};
for(const id of ['community-ultimate','community-dialogue']) {
  const original=JSON.stringify(communityTemplate(id).template);
  const values={'145.strength_model':.6,'123.sampler_name':'euler','115.multiple':64,'165.selection.tau':1.5,'150.preview_frames':1,'148.frame_rate':30,'148.crf':22,'136.ref_image_size':'max'};
  if(id==='community-ultimate') values['147.sigmas']='1, .8, .4, 0';
  else { values['177.steps']=6; values['178.steps']=3; values['181.shift_audio']=3; }
  const settings={...base,communityParameters:JSON.stringify(values)};
  const graph=buildCommunityWorkflow(id,['a.png'],'p',1,settings);
  for(const [key,value] of Object.entries(values)) {
    const split=key.indexOf('.');
    assert.equal(graph[key.slice(0,split)].inputs[key.slice(split+1)],value);
  }
  assert.equal(graph['136'].inputs.width%64,0);
  assert.equal(graph['136'].inputs.height%64,0);
  assert.equal(JSON.stringify(communityTemplate(id).template),original);
  const snap=await snapshotH3({workflowOptionId:id,referenceMode:true,prompt:'p',seed:1,settings,sourceWidth:0,sourceHeight:0,hasLastFrame:false,referenceCounts:{images:1,videos:0,audios:0,videoAudioFlags:[]}});
  assert.equal(snap.parameters.acceptance,'not_render_tested');
  assert.equal(snap.parameters.loraStrength,.6);
  assert.equal(snap.parameters.sampler,'euler');
  assert.equal(snap.parameters.fps,30);
  assert.equal(snap.parameters.duration,124/30);
  assert.deepEqual(snap.parameters.communityParameters,values);
  assert.match(snap.workflowIdentity.templateFile,/custom-parameters/);
  assert.equal(snap.parameters.steps,id==='community-ultimate'?3:null);
  const plan=planH3Submission({workflowOptionId:id,prompt:'p',seed:1,settings},{references:{images:['a.png'],videos:[],audios:[]}});
  assert.deepEqual(plan.workflow,graph);
  assert.ok(communityControls(id).every(c=>!c.key.startsWith('160.')));
  for(const invalid of [{'115.multiple':48},{'148.crf':Infinity},{'145.strength_model':'x'},{'123.sampler_name':'not-real'},{'127.unet_name':'other'},{'165.start_percent':.9,'165.end_percent':.2}]) {
    assert.throws(()=>buildCommunityWorkflow(id,['a.png'],'p',1,{...base,communityParameters:JSON.stringify(invalid)}));
  }
  const defaults=buildCommunityWorkflow(id,['a.png'],'p',1,{...base,communityParameters:''});
  assert.deepEqual(defaults['145'],communityTemplate(id).template['145']);
}
assert.equal(communityActualSteps('community-ultimate',{'147.sigmas':'1, .8, 0'}),2);
const separate=JSON.stringify({'community-ultimate':{'145.strength_model':.6},'community-dialogue':{'177.steps':6}});
assert.deepEqual(parseCommunityValues(separate,'community-ultimate'),{'145.strength_model':.6});
assert.deepEqual(parseCommunityValues(separate,'community-dialogue'),{'177.steps':6});
assert.throws(()=>buildCommunityWorkflow('community-ultimate',['a.png'],'p',1,{...base,communityParameters:JSON.stringify({'147.sigmas':'1,.8,.9,0'})}));
console.log('PASS advanced controls: real graph mappings, plan, snapshots, frozen defaults, validation, 24fps generation vs output fps');
