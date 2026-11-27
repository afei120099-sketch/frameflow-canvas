import {scheduledPromptFetch} from './submission-scheduler.ts';
import {COMFYUI_PROXY_PATH} from './config.ts';
import {waitForFluxSchnell} from './flux-schnell.ts';

export const KLEIN_MODELS={unet:'flux-2-klein-4b-fp8.safetensors',clip:'qwen_3_4b.safetensors',vae:'flux2-vae.safetensors'};
export const KLEIN_TEMPLATE_REVISION='04a508b31bec1818e48122ca0761c1de4140a234';
type Graph=Record<string,{class_type:string;inputs:Record<string,unknown>}>;
export type KleinInput={prompt:string;width:number;height:number;seed:number;imageNames?:string[]};
/** Native distilled official graph: Qwen3/Flux2 VAE, chained reference latents on both conditions. No Dev graph or LoRA. */
export function buildFluxKlein(input:KleinInput):Graph{
 if(!input.prompt.trim())throw Error('请填写Klein编辑提示词');
 if(!Number.isSafeInteger(input.seed)||input.seed<0)throw Error('Klein seed无效');
 if(![input.width,input.height].every(n=>Number.isInteger(n)&&n>=256&&n%16===0)||input.width*input.height>1_048_576)throw Error('Klein实验限制Batch 1、256以上的16倍数，最大1MP');
 if((input.imageNames?.length??0)>3)throw Error('Klein实验最多3个独立参考');
 const g:Graph={
  '1':{class_type:'UNETLoader',inputs:{unet_name:KLEIN_MODELS.unet,weight_dtype:'default'}},
  '10':{class_type:'CLIPLoader',inputs:{clip_name:KLEIN_MODELS.clip,type:'flux2',device:'cpu'}},
  '11':{class_type:'VAELoader',inputs:{vae_name:KLEIN_MODELS.vae}},
  '2':{class_type:'CLIPTextEncode',inputs:{clip:['10',0],text:input.prompt}},
  '4':{class_type:'ConditioningZeroOut',inputs:{conditioning:['2',0]}},
  '3':{class_type:'EmptyFlux2LatentImage',inputs:{width:input.width,height:input.height,batch_size:1}},
  '12':{class_type:'Flux2Scheduler',inputs:{steps:4,width:input.width,height:input.height}},
  '13':{class_type:'KSamplerSelect',inputs:{sampler_name:'euler'}},
  '14':{class_type:'RandomNoise',inputs:{noise_seed:input.seed}},
  '15':{class_type:'CFGGuider',inputs:{model:['1',0],positive:['2',0],negative:['4',0],cfg:1}},
  '5':{class_type:'SamplerCustomAdvanced',inputs:{noise:['14',0],guider:['15',0],sampler:['13',0],sigmas:['12',0],latent_image:['3',0]}},
  '6':{class_type:'VAEDecode',inputs:{samples:['5',0],vae:['11',0]}},
  '7':{class_type:'SaveImage',inputs:{images:['6',0],filename_prefix:'Frameflow_Cover_Klein_4B_Experimental'}},
 };
 let positive:unknown=['2',0],negative:unknown=['4',0];
 for(const [i,name] of (input.imageNames??[]).entries()){
  const n=20+i*5;
  g[n]={class_type:'LoadImage',inputs:{image:name}};
  g[n+1]={class_type:'ImageScaleToTotalPixels',inputs:{image:[String(n),0],upscale_method:'lanczos',megapixels:.4,resolution_steps:1}};
  g[n+2]={class_type:'VAEEncode',inputs:{pixels:[String(n+1),0],vae:['11',0]}};
  g[n+3]={class_type:'ReferenceLatent',inputs:{conditioning:positive,latent:[String(n+2),0]}};
  g[n+4]={class_type:'ReferenceLatent',inputs:{conditioning:negative,latent:[String(n+2),0]}};
  positive=[String(n+3),0];negative=[String(n+4),0];
 }
 g['15'].inputs.positive=positive;g['15'].inputs.negative=negative;return g;
}
type Options={fetch?:typeof fetch;pollMs?:number;images:Blob[];onStage?:(s:string)=>void;onReserved?:(id:string,g:Graph)=>Promise<void>;onSubmitted?:(id:string)=>void};
export async function runFluxKlein(input:KleinInput,options:Options){
 buildFluxKlein(input);if(!options.images.length||options.images.length>3)throw Error('Klein需1～3张独立参考');
 const request=async(path:string,init?:RequestInit)=>{const r=path==='/prompt'?await scheduledPromptFetch(COMFYUI_PROXY_PATH+path,init!,options.fetch??fetch):await (options.fetch??fetch)(COMFYUI_PROXY_PATH+path,init);if(!r.ok)throw Error(`Klein HTTP ${r.status}: ${(await r.text()).slice(0,1200)}`);return r;};
 const q=await (await request('/queue')).json() as {queue_running:unknown[];queue_pending:unknown[]};
 if(q.queue_running.length||q.queue_pending.length)throw Error('ComfyUI有任务；未并行提交Klein，请稍后重试');
 for(const [node,field,model] of [['UNETLoader','unet_name',KLEIN_MODELS.unet],['CLIPLoader','clip_name',KLEIN_MODELS.clip],['VAELoader','vae_name',KLEIN_MODELS.vae]]){
  const info=await (await request('/object_info/'+node)).json() as Record<string,{input?:{required?:Record<string,[string[]|string,{options?:string[]}?]>}}>;
  const entry=info[node]?.input?.required?.[field];const names=Array.isArray(entry?.[0])?entry[0]:entry?.[1]?.options;if(!names?.includes(model))throw Error('缺少Klein模型：'+model);
 }
 for(const name of ['ReferenceLatent','Flux2Scheduler','EmptyFlux2LatentImage']){const info=await (await request('/object_info/'+name)).json() as Record<string,unknown>;if(!info[name])throw Error('生产核心不支持Klein，停止；不会自动升级环境');}
 const imageNames=[];for(const blob of options.images){if(!blob.size)throw Error('Klein参考图为空');const form=new FormData();form.append('image',blob,'cover_klein_'+crypto.randomUUID()+'.png');form.append('type','input');form.append('overwrite','false');const result=await (await request('/upload/image',{method:'POST',body:form})).json() as {name?:string;subfolder?:string};if(!result.name)throw Error('Klein参考上传失败');imageNames.push([result.subfolder,result.name].filter(Boolean).join('/'));}
 const graph=buildFluxKlein({...input,imageNames}),id=crypto.randomUUID();await options.onReserved?.(id,graph);options.onStage?.('Klein实验编辑 · 4步 · 不加载Dev LoRA');
 try{const result=await (await request('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:graph,prompt_id:id,client_id:'frameflow-klein-'+crypto.randomUUID()})})).json() as {prompt_id?:string};if(result.prompt_id!==id)throw Error('任务ID不一致');}catch(e){throw Error('Klein提交状态待核对，禁止自动重复提交：'+String(e));}
 options.onSubmitted?.(id);return waitForFluxSchnell(id,input.seed,options);
}
export const waitForFluxKlein=waitForFluxSchnell;
