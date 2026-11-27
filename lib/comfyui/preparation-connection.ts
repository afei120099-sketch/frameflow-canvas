import {SubmissionNotSentError} from '../ai-adapter.ts';
export class PreparationUnavailableError extends SubmissionNotSentError {
  constructor(){super('提交前连接检查失败，任务尚未发送至ComfyUI；已暂停后续提交');this.name='PreparationUnavailableError';}
}
/** Bounded GET-only checks, strictly before any /prompt call. */
export async function ensurePreparationConnection(check:()=>Promise<boolean>,signal?:AbortSignal,wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))){
  for(let attempt=0;attempt<3;attempt++){
    signal?.throwIfAborted();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{if(await Promise.race([check(),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),8000);})])){signal?.throwIfAborted();return;}}
    catch(cause){if(signal?.aborted)throw cause;}
    finally{clearTimeout(timer);}
    if(attempt<2)await wait(500*(attempt+1));
  }
  signal?.throwIfAborted();throw new PreparationUnavailableError();
}
