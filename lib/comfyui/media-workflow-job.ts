import {scheduledPromptFetch} from "./submission-scheduler.ts";
import { COMFYUI_PROXY_PATH } from './config.ts';
import { formatComfyNodeErrors } from './node-errors.ts';
export type MediaGraph=Record<string,{class_type:string;inputs:Record<string,unknown>}>;
export type MediaJobOptions={fetch?:typeof fetch;signal?:AbortSignal;pollMs?:number;onStage?:(stage:string)=>void;onPending?:(id:string)=>void;onRejected?:()=>void};
type NodeInfo={input?:{required?:Record<string,unknown>;optional?:Record<string,unknown>}};
export async function mediaRequest(path:string,options:MediaJobOptions={},init?:RequestInit){
 const response=await (options.fetch??fetch)(`${COMFYUI_PROXY_PATH}${path}`,{...init,signal:options.signal});
 if(!response.ok)throw new Error(`ComfyUI连接失败（HTTP ${response.status}）`);return response;
}
const modelFields:Record<string,string[]>={UNETLoader:['unet_name'],CLIPLoader:['clip_name'],VAELoader:['vae_name'],MiniMaxH3TurboLoRA:['lora_name']};
export async function inspectMediaWorkflow(graph:MediaGraph,options:MediaJobOptions={}){
 const resolved=structuredClone(graph),errors:string[]=[];
 const infos=new Map<string,NodeInfo>();
 await Promise.all([...new Set(Object.values(graph).map(node=>node.class_type))].map(async type=>{
  const info=await(await mediaRequest(`/object_info/${type}`,options)).json() as Record<string,NodeInfo>;
  if(!info[type])errors.push(`缺少节点：${type}`);else infos.set(type,info[type]);
 }));
 for(const node of Object.values(resolved)){
  const info=infos.get(node.class_type);if(!info)continue;
  for(const field of modelFields[node.class_type]??[]){
   const spec=(info.input?.required?.[field]??info.input?.optional?.[field]) as [unknown,{options?:unknown[]}]|undefined;
   const choices=Array.isArray(spec?.[0])?spec[0]:spec?.[1]?.options??[];
   const wanted=String(node.inputs[field]??'');
   const matches=choices.filter((name):name is string=>typeof name==='string'&&(name===wanted||name.replaceAll('\\','/').endsWith('/'+wanted)));
   if(!matches.length)errors.push(`缺少模型：${wanted}`);else if(matches.includes(wanted))node.inputs[field]=wanted;else if(matches.length===1)node.inputs[field]=matches[0];else errors.push(`同名模型存在多份，请明确模型路径：${wanted}`);
  }
 }
 return {graph:resolved,errors:[...new Set(errors)]};
}
export async function runMediaWorkflow(graph:MediaGraph,saveId:string,kind:'audio'|'video',uploads:{nodeId:string;field:string;blob:Blob;name:string}[]=[],options:MediaJobOptions={}){
 options.onStage?.('检查工作流与模型');const inspection=await inspectMediaWorkflow(graph,options);
 if(inspection.errors.length)throw new Error(inspection.errors.join('\n'));
 for(const upload of uploads){
  if(!upload.blob.size)throw new Error('输入素材为空');
  if(!inspection.graph[upload.nodeId])throw new Error('上传素材对应节点不存在');
  options.onStage?.('上传输入素材');const extension=upload.name.match(/\.([a-z0-9]{2,8})$/i)?.[1]??(upload.blob.type.startsWith('image/')?'png':'wav');
  const form=new FormData();form.append('image',upload.blob,`frameflow_media_${crypto.randomUUID()}.${extension}`);form.append('type','input');form.append('overwrite','false');
  const file=await(await mediaRequest('/upload/image',options,{method:'POST',body:form})).json() as {name?:string;subfolder?:string};
  if(!file.name)throw new Error('素材上传失败：未返回文件名');inspection.graph[upload.nodeId].inputs[upload.field]=[file.subfolder,file.name].filter(Boolean).join('/');
 }
 const id=crypto.randomUUID();options.onPending?.(id);options.onStage?.('提交工作流任务');
 let response:Response;
 try{response=await scheduledPromptFetch(`${COMFYUI_PROXY_PATH}/prompt`,{method:'POST',signal:options.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:inspection.graph,prompt_id:id,client_id:`frameflow-media-${id}`})},options.fetch??fetch);}
 catch{throw new Error('提交状态待确认，请查询原任务；不会自动重新提交');}
 const result=await response.json().catch(()=>null) as {prompt_id?:string;node_errors?:Record<string,unknown>;error?:{message?:string}}|null;
 if(!response.ok){if(response.status>=400&&response.status<500)options.onRejected?.();throw new Error(formatComfyNodeErrors(result?.node_errors)||result?.error?.message||`提交失败（HTTP ${response.status}），请查询原任务`);}
 if(!result?.prompt_id)throw new Error('未返回任务ID，请查询原任务确认提交状态');
 options.onPending?.(result.prompt_id);return waitForMediaWorkflow(result.prompt_id,saveId,kind,options);
}
type SavedFile={filename:string;subfolder?:string;type?:string};
type HistoryEntry={status?:{completed?:boolean;status_str?:string;messages?:[string,{exception_message?:string}][]};outputs?:Record<string,{audio?:SavedFile[];images?:SavedFile[];videos?:SavedFile[];gifs?:SavedFile[]}>};
export async function waitForMediaWorkflow(id:string,saveId:string,kind:'audio'|'video',options:MediaJobOptions={}){
 let missing=0;
 for(;;){
  options.signal?.throwIfAborted();
  const history=await(await mediaRequest(`/history/${encodeURIComponent(id)}`,options,{cache:'no-store'})).json() as Record<string,HistoryEntry>;
  const entry=history[id],failure=entry?.status?.messages?.find(([type])=>type==='execution_error'||type==='execution_interrupted');
  if(entry?.status?.status_str==='error'||failure){options.onRejected?.();throw new Error(`渲染失败：${failure?.[1]?.exception_message??'任务失败或已中断'}`);}
  const output=entry?.outputs?.[saveId];
  const file=kind==='audio'?output?.audio?.[0]:[...(output?.videos??[]),...(output?.gifs??[]),...(output?.images??[])].find(file=>/\.mp4$/i.test(file.filename));
  if(file){
   options.onStage?.('保存结果到画布');const query=new URLSearchParams({filename:file.filename,subfolder:file.subfolder??'',type:file.type??'output'});
   const blob=await(await mediaRequest(`/view?${query}`,options)).blob();if(!blob.size)throw new Error('输出文件为空，请查询原任务');
   return {blob:blob.slice(0,blob.size,kind==='audio'?'audio/mpeg':'video/mp4'),filename:file.filename,promptId:id};
  }
  if(entry?.status?.completed){options.onRejected?.();throw new Error('工作流已完成，但未找到所需输出文件');}
  const queue=await(await mediaRequest('/queue',options,{cache:'no-store'})).json() as {queue_running?:unknown[][];queue_pending?:unknown[][]};
  if(queue.queue_running?.some(item=>item[1]===id)){missing=0;options.onStage?.('正在渲染');}
  else if(queue.queue_pending?.some(item=>item[1]===id)){missing=0;options.onStage?.('ComfyUI排队中');}
  else if(++missing>=3)throw new Error('原任务不在队列或历史中，请检查ComfyUI；没有自动重新提交');
  await new Promise<void>((resolve,reject)=>{const finish=()=>{options.signal?.removeEventListener('abort',abort);resolve();};const timer=setTimeout(finish,options.pollMs??1500);const abort=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);reject(new DOMException('已暂停查询','AbortError'));};options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();});
 }
}
