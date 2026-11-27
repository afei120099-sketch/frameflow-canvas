// Retired engine: read-only recovery of previously accepted audio tasks only.
import { COMFYUI_PROXY_PATH } from './config.ts';

type Options = {fetch?:typeof fetch;signal?:AbortSignal;pollMs?:number;onStage?:(stage:string)=>void;onPending?:(id:string)=>void;onRejected?:()=>void};
type AudioFile = {filename:string;subfolder?:string;type?:string};
type Entry = {status?:{completed?:boolean;status_str?:string;messages?:[string,{exception_message?:string}][]};outputs?:Record<string,{audio?:AudioFile[]}>};
async function request(path:string,options:Options,init?:RequestInit) {
  const response=await (options.fetch ?? fetch)(`${COMFYUI_PROXY_PATH}${path}`,{...init,signal:options.signal});
  if (!response.ok) throw new Error(`ComfyUI连接失败（HTTP ${response.status}）`);
  return response;
}
export async function waitForCosyVoice(id:string,options:Options={}) {
  let missing=0;
  for (;;) {
    options.signal?.throwIfAborted();
    const history=await (await request(`/history/${encodeURIComponent(id)}`,options,{cache:'no-store'})).json() as Record<string,Entry>;
    const entry=history[id];
    const failure=entry?.status?.messages?.find(([kind])=>kind==='execution_error'||kind==='execution_interrupted');
    if (entry?.status?.status_str==='error'||failure) { options.onRejected?.(); throw new Error(`配音失败：${failure?.[1]?.exception_message ?? '任务失败或被中断'}`); }
    const file=entry?.outputs?.['4']?.audio?.[0];
    if (file) {
      options.onStage?.('保存配音到画布');
      const query=new URLSearchParams({filename:file.filename,subfolder:file.subfolder ?? '',type:file.type ?? 'output'});
      const blob=await (await request(`/view?${query}`,options)).blob();
      if (!blob.size) throw new Error('配音输出为空，请查询原任务');
      return {blob:blob.slice(0,blob.size,'audio/mpeg'),filename:file.filename,promptId:id};
    }
    if (entry?.status?.completed) { options.onRejected?.(); throw new Error('配音任务已结束，但没有声音输出'); }
    const queue=await (await request('/queue',options,{cache:'no-store'})).json() as {queue_running?:unknown[][];queue_pending?:unknown[][]};
    if (queue.queue_running?.some(item=>item[1]===id)) {missing=0;options.onStage?.('正在生成配音');}
    else if (queue.queue_pending?.some(item=>item[1]===id)) {missing=0;options.onStage?.('ComfyUI排队中');}
    else if (++missing>=3) throw new Error('原配音任务不在队列或历史中，请检查ComfyUI；没有自动重新提交');
    await new Promise<void>((resolve,reject)=>{
      const finish=()=>{options.signal?.removeEventListener('abort',abort);resolve();};
      const timer=setTimeout(finish,options.pollMs ?? 1500);
      const abort=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);reject(new DOMException('已暂停查询','AbortError'));};
      options.signal?.addEventListener('abort',abort,{once:true});
      if(options.signal?.aborted)abort();
    });
  }
}
