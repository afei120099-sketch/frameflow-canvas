import assert from 'node:assert/strict';
import {buildMusic3,MUSIC3_MODELS} from '../lib/comfyui/music3.ts';
import {buildAudioLock,audioLockTiming} from '../lib/comfyui/audio-lock.ts';
import {inspectMediaWorkflow,runMediaWorkflow,waitForMediaWorkflow} from '../lib/comfyui/media-workflow-job.ts';
const input={prompt:'人物向镜头说话，保持自然表情。',audioName:'voice.wav',start:1,seconds:5,audioDuration:20,aspect:'16:9',megapixels:.5,seed:1};
const video=buildAudioLock(input);
assert.deepEqual(video['14'].inputs.audio,['8',2],'mux original source, not generated audio');
assert.deepEqual(video['15'].inputs.audio,['14',1]);
assert.equal(video['8'].inputs.audio_mode,'lock_source');
assert.equal(video['8'].inputs.add_source_as_reference,true);
assert.equal(video['8'].inputs.audio_denoise_strength,0);
assert.equal(video['8'].inputs['ref_images.ref_image_0'],undefined);
assert.deepEqual(buildAudioLock({...input,imageName:'face.png'})['8'].inputs['ref_images.ref_image_0'],['20',0]);
for(const seconds of [.2,1,5,5.17,8,15]){const t=audioLockTiming(1,seconds);assert.equal((t.frames-5)%17,0);assert.ok(t.renderSeconds>=seconds);assert.ok(t.frames<=362);}
assert.throws(()=>buildAudioLock({...input,seconds:16}),/15秒/);
assert.throws(()=>buildAudioLock({...input,audioDuration:4}),/长度不足/);
assert.throws(()=>buildAudioLock({...input,prompt:'<Subject 1>'}));
const song=buildMusic3({caption:'warm pop',lyrics:'hello',seconds:30,seed:2,instrumental:false});
assert.deepEqual(song['6'].inputs.seconds,['4',1],'latent follows actual encoder duration');
assert.equal(song['2'].inputs.device,'cpu');
assert.equal(song['8'].class_type,'VAEDecodeAudioTiled');
assert.equal(buildMusic3({caption:'pop',lyrics:'keep UI lyrics',seconds:30,seed:2,instrumental:true})['4'].inputs.lyrics,'');
let posts=0,pending='',rejected=0;
const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
const fake=async(url,init)=>{
 const path=String(url).replace('/comfyui','');
 if(path.startsWith('/object_info/')){const type=path.split('/').at(-1);const fields=type==='UNETLoader'?{unet_name:[[MUSIC3_MODELS.unet]]}:type==='CLIPLoader'?{clip_name:['COMBO',{options:[MUSIC3_MODELS.clip]}]}:type==='VAELoader'?{vae_name:[[MUSIC3_MODELS.vae]]}:{};return json({[type]:{input:{required:fields}}});}
 if(path==='/prompt'){posts++;const data=JSON.parse(init.body);assert.equal(data.prompt_id,pending);return json({prompt_id:pending});}
 if(path.startsWith('/history/'))return json({[pending]:{status:{completed:true},outputs:{'9':{audio:[{filename:'song.mp3'}]}}}});
 if(path.startsWith('/view?'))return new Response(new Uint8Array([1,2,3]));
 throw Error('Unexpected request '+path);
};
assert.deepEqual((await inspectMediaWorkflow(song,{fetch:fake})).errors,[]);
const output=await runMediaWorkflow(song,'9','audio',[],{fetch:fake,onPending:id=>pending=id});
assert.equal(output.filename,'song.mp3');assert.equal(posts,1);
await waitForMediaWorkflow(pending,'9','audio',{fetch:fake});assert.equal(posts,1,'recovery never re-submits');
await assert.rejects(runMediaWorkflow(song,'9','audio',[],{fetch:async()=>json({})}),/缺少节点/);assert.equal(posts,1);
await assert.rejects(waitForMediaWorkflow('bad','9','audio',{fetch:async()=>json({bad:{status:{status_str:'error',messages:[['execution_error',{exception_message:'specific failure'}]]}}}),onRejected:()=>rejected++}),/specific failure/);assert.equal(rejected,1);
await assert.rejects(runMediaWorkflow(song,'9','audio',[],{fetch:async(url,init)=>String(url).endsWith('/prompt')?Promise.reject(Error('network lost')):fake(url,init),onPending:id=>pending=id}),/不会自动重新提交/);assert.ok(pending);
console.log('PASS builders, source-audio mux, duration grid, music duration, models, single submission, recovery, failures; no GPU generation');
