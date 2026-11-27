import {fetchBody,bounded} from '../operation-scope.ts';
import {imageProof,verifyUploadedImage} from '../image-integrity.ts';
import template from './seedvr2-workflow.json' with {type:'json'};
import {COMFYUI_PROXY_PATH} from './config.ts';
import {scheduledPromptFetch} from './submission-scheduler.ts';
import type {Workflow} from './extra-workflows.ts';

export function frameEnhanceSize(width:number,height:number){
  if(![width,height].every(n=>Number.isInteger(n)&&n>0))throw Error('截图尺寸无效');
  const scale=Math.min(2,4096/Math.max(width,height));
  if(scale<=1)throw Error('原图已达到4096尺寸上限，请使用原画质截图');
  return {width:Math.max(2,Math.round(width*scale/2)*2),height:Math.max(2,Math.round(height*scale/2)*2)};
}
export function buildFrameImageEnhance(imageName:string,width:number,height:number,colorCorrection:'none'|'lab'='none'):Workflow{
  const size=frameEnhanceSize(width,height),graph=structuredClone(template) as Workflow;
  for(const id of ['73','76','66:74','66:75','66:79','66:81','66:99','66:100','66:102','66:103','66:105'])delete graph[id];
  graph['load-frame']={class_type:'LoadImage',inputs:{image:imageName}};
  graph['66:57'].inputs={input:['load-frame',0],resize_type:'scale dimensions','resize_type.width':Math.ceil(size.width/32)*32,'resize_type.height':Math.ceil(size.height/32)*32,'resize_type.crop':'disabled',scale_method:'lanczos'};
  graph['66:54'].inputs.latent_image=['66:48',0];
  graph['66:61'].inputs.vae_conditioning=['66:48',0];
  graph['66:55'].inputs.samples=['66:54',0];
  graph['66:59'].inputs.color_correction_method=colorCorrection;
  graph['66:52'].inputs.unet_name='seedvr2_7b_sharp_int8_convrot.safetensors'; // 2026-11-21 A/B: 7B sharp keeps original colour, sharper, 3s vs 6s
  for(const id of ['66:48','66:55']){graph[id].inputs.temporal_size=16;graph[id].inputs.temporal_overlap=4;}
  graph['frame-size']={class_type:'ImageScale',inputs:{image:['66:59',0],width:size.width,height:size.height,upscale_method:'lanczos',crop:'disabled'}};
  graph['7']={class_type:'SaveImage',inputs:{images:['frame-size',0],filename_prefix:'Frameflow_Frame_HD'}};
  return graph;
}
type Options={fetch?:typeof fetch;pollMs?:number;onStage?:(stage:string)=>void;onReserved?:(id:string)=>Promise<void>;colorCorrection?:'none'|'lab';submissionControl?:'submit'|'chain';beforeSubmit?:()=>void;submissionSessionId?:string;signal?:AbortSignal};
async function request<T>(path:string,options:Options,read:(response:Response)=>Promise<T>,init?:RequestInit):Promise<T>{
  options.signal?.throwIfAborted();
  if(path==='/prompt'){
    // Never turn an ambiguous POST timeout into permission to submit again.
    return bounded(async scope=>{const response=await scheduledPromptFetch(COMFYUI_PROXY_PATH+path,{...init!,signal:scope.signal},options.fetch??fetch,options.submissionControl??'submit',options.beforeSubmit,options.submissionSessionId);
      scope.check();if(!response.ok)throw Error('ComfyUI '+response.status);const value=await read(response);scope.check();return value;},15000,options.signal,'高清提交回执');
  }
  return fetchBody(COMFYUI_PROXY_PATH+path,init??{},read,12000,options.fetch??fetch,options.signal);
}
export async function waitFrameImageEnhance(promptId:string,options:Options={}){
  let missing=0,ghost=0;
  for(;;){
    options.signal?.throwIfAborted();
    type Entry={status?:{completed?:boolean;status_str?:string;messages?:[string,{exception_message?:string}][]};outputs?:Record<string,{images?:{filename:string;subfolder?:string;type?:string}[]}>};
    const entries=await request('/history/'+encodeURIComponent(promptId),options,r=>r.json(),{cache:'no-store'}) as Record<string,Entry>;
    const entry=entries[promptId];
    if(entry?.status?.status_str==='error')throw Error(entry.status.messages?.find(m=>m[0]==='execution_error'||m[0]==='execution_interrupted')?.[1].exception_message??'AI截图增强失败');
    const file=entry?.outputs?.['7']?.images?.[0];
    if(file){const query=new URLSearchParams({filename:file.filename,subfolder:file.subfolder??'',type:file.type??'output'});const image=await request('/view?'+query,options,r=>r.blob());if(!image.size)throw Error('增强图片为空');return {image,filename:file.filename,promptId};}
    if(entry?.status?.completed)throw Error('任务已结束但没有增强图片');
    const queue=await request('/queue',options,r=>r.json(),{cache:'no-store'}) as {queue_running?:unknown[][];queue_pending?:unknown[][]};
    const running=queue.queue_running?.some(item=>item[1]===promptId),pending=queue.queue_pending?.some(item=>item[1]===promptId);
    // A history row with no image that is not in the queue used to reset `missing` and, with pollMs 0, tight-loop forever inside the only submit lock.
    if(running||pending){missing=0;ghost=0;}
    else if(entry){if(++ghost>=3)throw Error('原增强任务不在队列中且历史未完成，状态待确认；不会自动重提');}
    else if(++missing>=3)throw Error('原增强任务不在队列或历史中，状态待确认；不会自动重提');
    options.onStage?.(running?'AI高清处理中':pending?'等待ComfyUI排队':'查询原任务');
    await new Promise(resolve=>setTimeout(resolve,options.pollMs??1500));
  }
}
export async function submitFrameImageEnhance(image:Blob,width:number,height:number,options:Options={}){
  await imageProof(image,options.signal);
  frameEnhanceSize(width,height);
  const info=await request('/object_info',options,r=>r.json()) as Record<string,{input?:{required?:Record<string,unknown>}}>;
  const graph=buildFrameImageEnhance('pending.png',width,height,options.colorCorrection);
  for(const node of Object.values(graph))if(!info[node.class_type])throw Error('本机缺少图片增强节点：'+node.class_type);
  for(const [id,field] of [['66:52','unet_name'],['66:51','vae_name']]){
    const node=graph[id],choices=info[node.class_type]?.input?.required?.[field] as [string[]]|undefined;
    if(!choices?.[0]?.includes(String(node.inputs[field])))throw Error('本机未识别增强模型：'+node.inputs[field]);
  }
  const form=new FormData();form.append('image',image,`frame_${crypto.randomUUID()}.png`);form.append('type','input');form.append('overwrite','false');
  options.onStage?.('上传原画质截图');
  const file=await request('/upload/image',options,r=>r.json(),{method:'POST',body:form}) as {name?:string;subfolder?:string};
  if(!file.name)throw Error('截图上传没有返回路径');
  await verifyUploadedImage(image,{name:file.name,subfolder:file.subfolder},options.fetch??fetch,COMFYUI_PROXY_PATH,options.signal);
  graph['load-frame'].inputs.image=[file.subfolder,file.name].filter(Boolean).join('/');
  const id=crypto.randomUUID();await options.onReserved?.(id);
  try {
    const reply=await request('/prompt',options,r=>r.json(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:graph,prompt_id:id,client_id:'frameflow-frame-'+id})}) as {prompt_id?:string};
    if(reply.prompt_id!==id)throw Error('返回任务ID不一致');
  }catch(cause){throw Error('提交状态待确认，请查询原任务，不要重复增强：'+(cause instanceof Error?cause.message:String(cause)));}
  return id;
}
export async function runFrameImageEnhance(image:Blob,width:number,height:number,options:Options={}){
  return waitFrameImageEnhance(await submitFrameImageEnhance(image,width,height,options),options);
}
