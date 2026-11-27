// Read-only inspection of the running ComfyUI; never posts a job or uploads media.
import assert from 'node:assert/strict';
import {buildMusic3} from '../lib/comfyui/music3.ts';
import {buildAudioLock} from '../lib/comfyui/audio-lock.ts';
import {inspectMediaWorkflow} from '../lib/comfyui/media-workflow-job.ts';
const fetchLocal=(url,init)=>fetch(String(url).replace('/comfyui','http://127.0.0.1:8188'),init);
for(const graph of [buildMusic3({caption:'check',lyrics:'',seconds:30,seed:1,instrumental:false}),buildAudioLock({prompt:'check',audioName:'pending.wav',imageName:'pending.png',start:0,seconds:5,audioDuration:10,aspect:'16:9',megapixels:.5,seed:1})]){
 const result=await inspectMediaWorkflow(graph,{fetch:fetchLocal});assert.deepEqual(result.errors,[]);
 for(const node of Object.values(graph)){
  const info=(await(await fetchLocal('/comfyui/object_info/'+node.class_type)).json())[node.class_type];
  for(const [key,spec] of Object.entries(info.input?.required??{})){
   assert.ok(key in node.inputs,'Missing '+node.class_type+'.'+key);
   const value=node.inputs[key];if(Array.isArray(value)||node.class_type==='LoadAudio'||node.class_type==='LoadImage')continue;
   const options=Array.isArray(spec[0])?spec[0]:spec[1]?.options;
   if(Array.isArray(options)&&!options.some(x=>typeof x==='object'))assert.ok(options.includes(value),'Invalid '+node.class_type+'.'+key+': '+value);
   if(typeof value==='number'){assert.ok(spec[1]?.min===undefined||value>=spec[1].min);assert.ok(spec[1]?.max===undefined||value<=spec[1].max);}
  }
 }
}
console.log('PASS live read-only check: all Music3 and audio-lock nodes, models and required parameters recognized; no rendering submitted');
