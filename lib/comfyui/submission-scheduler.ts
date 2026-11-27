/** Only orders NOT-YET-SUBMITTED requests. ComfyUI remains the authoritative serial GPU queue.
 * Never edits /queue, interrupts a job, unloads a model, retries a POST, or starts work on reload.
 */
import {readInboxRootSnapshot,subscribeInboxRootControl,rootControlAllows,rootSessionAllows,refreshInboxRootControl,InboxRootProxyHeldError,assertInboxSessionActive} from '../inbox-root-control.ts';
import {loadFrameflowInstance} from '../frameflow-instance.ts';
type Graph=Record<string,{class_type:string;inputs:Record<string,unknown>}>;
export function workflowModelKey(graph:Graph) {
  const keys=['unet_name','clip_name','clip_name1','clip_name2','vae_name','lora_name','model_name','model_version','fp16','llm_checkpoint','strength_model','strength'];
  return JSON.stringify(Object.values(graph).filter(n=>n && typeof n==="object" && n.inputs && keys.some(k=>n.inputs[k]!==undefined))
    .map(n=>[n.class_type,...keys.map(k=>n.inputs[k]??null)]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
/** Topological/affinity order; dependencies win over model reuse, ties preserve input order. */
export function planModelBatches<T extends {id:string;modelKey:string;dependsOn?:string[]}>(items:readonly T[],initialKey=''):T[] {
  if(new Set(items.map(i=>i.id)).size!==items.length)throw new Error('调度任务ID重复');
  const remaining=[...items],done=new Set<string>(),result:T[]=[];let key=initialKey;
  const ids=new Set(items.map(i=>i.id));
  if(items.some(i=>i.dependsOn?.some(id=>!ids.has(id))))throw new Error('调度依赖不存在');
  while(remaining.length) {
    const ready=remaining.filter(i=>i.dependsOn?.every(id=>done.has(id))??true);
    if(!ready.length)throw new Error('调度依赖有循环');
    const next=ready.find(i=>i.modelKey===key)??ready[0];
    result.push(next);done.add(next.id);key=next.modelKey;remaining.splice(remaining.indexOf(next),1);
  }
  return result;
}
type ControlKind='submit'|'automatic'|'chain';
type Ticket={id:string;modelKey:string;controlKind:ControlKind;sessionId?:string;run:()=>Promise<Response>;resolve:(r:Response)=>void;reject:(e:unknown)=>void};
class ParkUnsentTicket extends Error {}
const pending:Ticket[]=[],suspended:Ticket[]=[];let running=false,lastKey='',clearedUnsent=0;
export const submissionSchedulerStatus=()=>({pending:pending.length,suspendedPlans:suspended.length,working:running,clearedUnsent});
subscribeInboxRootControl(control=>{
  if(typeof window==='undefined')return;
  for(const list of [pending,suspended])for(let i=list.length-1;i>=0;i--){try{assertInboxSessionActive(list[i].sessionId);}catch(error){list.splice(i,1)[0].reject(error);}}
  for(let i=pending.length-1;i>=0;i--)if(!rootSessionAllows(pending[i].controlKind,pending[i].sessionId,control)){if(control.stop)clearedUnsent++;suspended.unshift(...pending.splice(i,1));}
  for(let i=suspended.length-1;i>=0;i--)if(rootSessionAllows(suspended[i].controlKind,suspended[i].sessionId,control))pending.unshift(...suspended.splice(i,1));
  if(pending.length)void drain();
});
async function drain(){
  if(running)return;running=true;
  try {
    while(pending.length){
      if(typeof window!=='undefined'&&readInboxRootSnapshot().stop){clearedUnsent+=pending.length;suspended.push(...pending.splice(0));break;}
      const priority=readInboxRootSnapshot().priority??[],rank=(ticket:Ticket)=>{const i=priority.indexOf(ticket.sessionId??'');return i<0?Number.MAX_SAFE_INTEGER:i;};
      const best=Math.min(...pending.map(rank)),next=planModelBatches(pending.filter(t=>rank(t)===best),lastKey)[0];pending.splice(pending.indexOf(next),1);
      try {const response=await next.run();if(response.ok)lastKey=next.modelKey;next.resolve(response);}catch(e){
        if(e instanceof ParkUnsentTicket){if(readInboxRootSnapshot().stop)clearedUnsent++;(rootSessionAllows(next.controlKind,next.sessionId)?pending:suspended).push(next);}
        else next.reject(e);
      }
    }
  }finally{running=false;}
}
/**
 * VideoHelperSuite writes a silent "x.mp4", then muxes audio into "x-audio.mp4" and keeps the silent one
 * unless the submitter says otherwise — only ComfyUI's own web UI sends that setting. Ask it to drop the
 * intermediate for graphs that save video. Image-only graphs are left alone so their PNG metadata stays clean.
 */
export function withVideoOutputOptions(body:{prompt:Graph;extra_data?:Record<string,unknown>}){
  const savesVideo=Object.values(body.prompt??{}).some(node=>(node as {class_type?:string})?.class_type==='VHS_VideoCombine');
  if(!savesVideo)return false;
  const extra=(body.extra_data??{}) as {extra_pnginfo?:{workflow?:{extra?:Record<string,unknown>}}};
  const pnginfo=extra.extra_pnginfo??{},workflow=pnginfo.workflow??{};
  body.extra_data={...extra,extra_pnginfo:{...pnginfo,workflow:{...workflow,extra:{...(workflow.extra??{}),VHS_KeepIntermediate:false}}}};
  return true;
}
export function scheduledPromptFetch(url:string,init:RequestInit,request:typeof fetch=fetch,controlKind:ControlKind='submit',guard?:()=>void,sessionId?:string):Promise<Response>{
  // Native server/worker adapters have no browser storage/locks; still use the same serialized lane.
  const body=JSON.parse(String(init.body)) as {prompt:Graph;prompt_id?:string;extra_data?:Record<string,unknown>};
  const check=()=>{init.signal?.throwIfAborted();assertInboxSessionActive(sessionId);guard?.();};
  const sendInit={...init,headers:new Headers(init.headers)};sendInit.headers.set('x-frameflow-control-kind',controlKind);
  if(withVideoOutputOptions(body))sendInit.body=JSON.stringify(body);
  if(sessionId)sendInit.headers.set('x-frameflow-session-id',sessionId);
  const run=async()=>{
    check();
    if(typeof window!=='undefined'){await refreshInboxRootControl();check();if(!rootSessionAllows(controlKind,sessionId))throw new ParkUnsentTicket();}
    const send=async()=>{
        check();
        if(typeof window!=='undefined'&&!rootSessionAllows(controlKind,sessionId))throw new ParkUnsentTicket();
        if(typeof window!=='undefined'){
          const instance=await loadFrameflowInstance();
          if(instance.id){body.extra_data={...(body.extra_data??{}),frameflowInstance:instance.id};sendInit.body=JSON.stringify(body);}
        }
        const rank=readInboxRootSnapshot().priority?.indexOf(sessionId??'')??-1;
        if(rank>=0)sendInit.body=JSON.stringify({...body,number:-1e12+rank*1e8+Date.now()/1000});
        try{
          const result=await request(url,sendInit);
          // This special receipt is generated BEFORE the proxy forwards anything.
          if(typeof window!=='undefined'&&result.status===423&&result.headers.get('x-frameflow-submission-held')==='1'){await refreshInboxRootControl();check();throw new ParkUnsentTicket();}
          return result;
        }catch(error){if(typeof window==='undefined'||!(error instanceof InboxRootProxyHeldError))throw error;await refreshInboxRootControl();throw new ParkUnsentTicket();}
    };
    if(typeof navigator!=='undefined' && navigator.locks) return navigator.locks.request('frameflow-comfy-submit-v1',send);
    return send();
  };
  return new Promise((resolve,reject)=>{
    const aborted=()=>{
      for(const list of [pending,suspended]){const index=list.indexOf(ticket);if(index>=0)list.splice(index,1);}
      reject(init.signal?.reason??new DOMException('已取消未提交任务','AbortError'));
    };
    const cleanup=()=>init.signal?.removeEventListener('abort',aborted);
    const ticket:Ticket={id:crypto.randomUUID(),modelKey:workflowModelKey(body.prompt),controlKind,sessionId,run,resolve:value=>{cleanup();resolve(value);},reject:error=>{cleanup();reject(error);}};
    try{check();}catch(error){reject(error);return;}
    if(init.signal?.aborted){reject(init.signal.reason);return;}
    init.signal?.addEventListener('abort',aborted,{once:true});
    if(typeof window!=='undefined'&&!rootSessionAllows(controlKind,sessionId)){suspended.push(ticket);if(readInboxRootSnapshot().stop)clearedUnsent++;}else pending.push(ticket);
    if(!running)setTimeout(()=>void drain(),40);
  });
}
