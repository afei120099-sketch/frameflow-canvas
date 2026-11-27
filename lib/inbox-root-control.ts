export type InboxRootControl=import('./inbox-file-policy.ts').FileControls&{autoEnqueue:boolean;autoChain:boolean;submit:boolean;stopSessions?:string[];stop:boolean;effective:{autoEnqueue:boolean;autoChain:boolean;submit:boolean};error:string|null;readAt:string;version:number};
const closed=():InboxRootControl=>({autoEnqueue:false,autoChain:false,submit:false,stop:false,effective:{autoEnqueue:false,autoChain:false,submit:false},error:'尚未确认根总控',readAt:'',version:1});
let current=closed();
// A stop is a user action, not a reversible global gate. Removing the file entry never revives a live plan.
const stoppedSessions=new Set<string>();
export function assertInboxSessionActive(sessionId?:string){if(sessionId&&(current.stopSessions?.includes(sessionId)||stoppedSessions.has(sessionId)))throw new DOMException('用户通过_control.json stopSessions停止本批；已接单任务保留，未提交镜头不再续跑','AbortError');}
const listeners=new Set<(control:InboxRootControl)=>void>();
export const readInboxRootSnapshot=()=>current;
export function applyInboxRootControl(control:InboxRootControl){current=control;for(const id of control.stopSessions??[])stoppedSessions.add(id);for(const listener of listeners)listener(control);}
export function subscribeInboxRootControl(listener:(control:InboxRootControl)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
export async function refreshInboxRootControl(request:typeof fetch=fetch){
  try{
    const response=await request('/__inbox/control',{cache:'no-store',signal:AbortSignal.timeout(3500)});
    if(!response.ok)throw Error(`HTTP ${response.status}`);
    const control=await response.json() as InboxRootControl;
    if(!control.effective||['autoEnqueue','autoChain','submit'].some(key=>typeof control.effective[key as keyof typeof control.effective]!=='boolean'))throw Error('总控响应无效');
    applyInboxRootControl(control);
  }catch(error){applyInboxRootControl({...closed(),error:`总控无法确认：${error instanceof Error?error.message:String(error)}`});}
  return current;
}
export function rootControlAllows(kind:'submit'|'automatic'|'chain',control=current){
  return control.effective.submit&&(kind!=='automatic'||control.effective.autoEnqueue)&&(kind!=='chain'||control.effective.autoChain);
}
export function rootSessionAllows(kind:'submit'|'automatic'|'chain',sessionId?:string,control=current){return rootControlAllows(kind,control)&&(!sessionId||!control.pauseSessions?.includes(sessionId));}
/** Reversible hold, not task failure. Original controller's guard preserves user-stop/deletion fences. */
export async function waitForInboxRootControl(kind:'submit'|'automatic'|'chain',guard:()=>void=()=>{},waiting?:(text:string)=>void,sessionId?:string){
  while(!rootSessionAllows(kind,sessionId)){
    guard();waiting?.(current.stop?'根目录STOP生效：已暂停未提交工作，保留镜头计划和已生成文件':`根总控等待：${kind==='chain'?'autoChain / ':kind==='automatic'?'autoEnqueue / ':''}submit；更改文件后自动重新判断`);
    await new Promise<void>(resolve=>setTimeout(resolve,200));
  }
  guard();
}
/**
 * The canvas switches (自动入队 / 急停). Writes the same `autoEnqueue` field of _control.json and the same
 * STOP file a person edits by hand (server: scripts/inbox-root-control.mjs). Resolves with the re-read control.
 */
export async function switchInboxRootControl(patch:{autoEnqueue?:boolean;stop?:boolean},request:typeof fetch=fetch){
  const response=await request('/__inbox/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch),cache:'no-store',signal:AbortSignal.timeout(5000)});
  const body=await response.json().catch(()=>null) as {error?:string;control?:InboxRootControl}&Partial<InboxRootControl>|null;
  if(!response.ok){if(body?.control?.effective)applyInboxRootControl(body.control);throw Error(body?.error??`HTTP ${response.status}`);}
  if(!body?.effective)throw Error('总控响应无效');
  applyInboxRootControl(body as InboxRootControl);return body as InboxRootControl;
}
/** Only raised on a positive proxy receipt proving /prompt never reached ComfyUI. */
export class InboxRootProxyHeldError extends Error { constructor(){super('根总控已拦截，尚未发送ComfyUI');} }
