import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Plugin} from 'vite';
import {COMFYUI_SERVER_URL,COMFYUI_PROXY_PATH} from '../lib/comfyui/config.ts';
import {validateVoiceDesign,type VoiceDesignInput} from '../lib/voice-design.ts';
import {thermalSafety} from './gpu-thermal-vite-plugin.ts';

const registry=globalThis as typeof globalThis&{frameflowVoiceDesignActive?:string};
export const isVoiceDesignGpuActive=()=>!!registry.frameflowVoiceDesignActive;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function voiceDesignPlugin():Plugin{
 return {name:'frameflow-ai-voice-design',configureServer(server){
  server.middlewares.use('/__voice_design',voiceDesignMiddleware(server.config.root));
  server.middlewares.use(`${COMFYUI_PROXY_PATH}/prompt`,(request,response,next)=>{
   if(request.method==='POST'&&isVoiceDesignGpuActive()){response.statusCode=409;response.setHeader('Content-Type','application/json');response.end(JSON.stringify({error:{message:'AI音色试听正在占用显卡，请完成后再提交视频任务'}}));return;}
   next();
  });
 }};
}
export function voiceDesignMiddleware(root:string){
 const jobs=path.resolve(root,'runtime/voice-design-jobs');
 const python=path.resolve(root,'runtime/qwen-voice-design-env/Scripts/python.exe');
 const worker=path.resolve(root,'scripts/generate-voice-design.py');
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Cache-Control','no-store');
  const reply=(status:number,body:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));};
  const host=req.headers.host??'';
  if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)||!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress??'')||(req.headers.origin&&req.headers.origin!==`http://${host}`))return reply(403,{error:'只允许本机画布调用音色设计'});
  try{
   const url=new URL(req.url??'/','http://localhost');
   if(req.method==='GET'){
    const id=url.searchParams.get('id')??'';if(!uuid.test(id))return reply(422,{error:'试听任务ID无效'});
    let status;try{status=JSON.parse(await readFile(path.join(jobs,id,'status.json'),'utf8'));}catch{return reply(404,{error:'未找到原试听任务，不会自动重新生成；请核实后手动清除任务记录'});}
    if(url.searchParams.has('file')){
     const index=Number(url.searchParams.get('file')),candidate=status.candidates?.[index];
     if(status.status!=='completed'||!Number.isInteger(index)||index<0||!candidate||path.basename(candidate.filename)!==candidate.filename)return reply(422,{error:'试听文件尚未完成或编号无效'});
     const wav=await readFile(path.join(jobs,id,candidate.filename));res.setHeader('Content-Type','audio/wav');res.end(wav);return;
    }
    if(status.status==='completed'&&registry.frameflowVoiceDesignActive===id)return reply(200,{...status,status:'running',stage:'AI试听已生成，正在释放模型显存'});
    return reply(200,status);
   }
   if(req.method!=='POST')return reply(405,{error:'请使用POST创建试听，GET查询原任务'});
   if(!req.headers['content-type']?.startsWith('application/json'))return reply(415,{error:'需要JSON请求'});
   const chunks:Buffer[]=[];let bytes=0;
   for await(const chunk of req){bytes+=chunk.length;if(bytes>20000)return reply(413,{error:'音色描述请求过大'});chunks.push(Buffer.from(chunk));}
   let input:VoiceDesignInput&{id:string};
   try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));validateVoiceDesign(input);if(!uuid.test(input.id))throw Error('试听任务ID无效');}catch(error){return reply(422,{error:error instanceof Error?error.message:'试听参数错误'});}
   const directory=path.join(jobs,input.id);
   try{const existing=JSON.parse(await readFile(path.join(directory,'status.json'),'utf8'));return reply(200,existing);}catch{/* A new explicit request only; an existing job is never resubmitted. */}
   if(isVoiceDesignGpuActive())return reply(409,{error:'已有AI音色试听任务，请等待完成后再生成'});
   try{await access(python);await access(path.resolve(root,'runtime/voice-design-environment.json'));await access(path.resolve(root,'runtime/models/Qwen3-TTS-12Hz-1.7B-VoiceDesign/frameflow-source.json'));}catch{return reply(409,{error:'AI音色模型或独立环境尚未安装完成，未提交GPU任务'});}
   registry.frameflowVoiceDesignActive=input.id;
   let launched=false;
   try{
    const checkQueue=async()=>{
     const thermal=thermalSafety()?.status();if(thermal?.blocked)throw Error(thermal.reason);
     const response=await fetch(`${COMFYUI_SERVER_URL}/queue`,{signal:AbortSignal.timeout(4000)});if(!response.ok)throw Error('无法检查ComfyUI队列，未启动音色GPU任务');
     const queue=await response.json() as {queue_running?:unknown[];queue_pending?:unknown[]};
     if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending))throw Error('ComfyUI队列状态不明确');
     if(queue.queue_running.length||queue.queue_pending.length)throw Error('ComfyUI有任务正在执行或排队，请完成后再生成音色试听');
    };
    await checkQueue();
    await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,'input.json'),JSON.stringify({id:input.id,text:input.text,description:input.description,count:input.count,seed:input.seed,comfyUrl:COMFYUI_SERVER_URL}));
    await writeFile(path.join(directory,'status.json'),JSON.stringify({id:input.id,status:'running',stage:'加载AI音色设计模型',description:input.description,candidates:[],createdAt:Date.now()}));
    const child=spawn(python,['-X','faulthandler',worker,directory],{windowsHide:true,cwd:root,env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});
    launched=true;let stderr='',reason='',finishing=false,checking=false;
    child.stdout.resume();child.stderr.on('data',data=>{stderr=(stderr+data.toString('utf8')).slice(-8000);});
    const stop=(message:string)=>{if(!reason){reason=message;child.kill();}};
    const timer=setTimeout(()=>stop('AI音色试听超过15分钟，已停止自己的任务，不会自动重试'),15*60*1000);
    const guard=setInterval(()=>{if(checking)return;checking=true;void checkQueue().catch(()=>stop('检测到外部GPU任务或队列失联，已停止音色试听以保护现有视频任务')).finally(()=>{checking=false;});},2000);
    const finish=async(code:number|null,error?:Error)=>{
     if(finishing)return;finishing=true;clearTimeout(timer);clearInterval(guard);
     try{
      let status;try{status=JSON.parse(await readFile(path.join(directory,'status.json'),'utf8'));}catch{status={id:input.id,candidates:[]};}
      if(reason||error||code!==0||status.status!=='completed')await writeFile(path.join(directory,'status.json'),JSON.stringify({...status,status:'failed',error:reason||error?.message||status.error||stderr.slice(-2500)||'音色设计进程退出',stderr,finishedAt:Date.now()}));
     }finally{if(registry.frameflowVoiceDesignActive===input.id)registry.frameflowVoiceDesignActive=undefined;}
    };
    child.on('error',error=>void finish(null,error));child.on('exit',code=>void finish(code));
    return reply(202,{id:input.id,status:'running'});
   }catch(error){return reply(409,{error:error instanceof Error?error.message:'音色设计启动失败'});}
   finally{if(!launched&&registry.frameflowVoiceDesignActive===input.id)registry.frameflowVoiceDesignActive=undefined;}
  }catch(error){return reply(500,{error:error instanceof Error?error.message:'音色设计服务异常'});}
 };
}
