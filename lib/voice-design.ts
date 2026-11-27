export const VOICE_DESIGN_MODEL = 'Qwen3-TTS-12Hz-1.7B-VoiceDesign';
export type VoiceDesignInput = { text: string; description: string; count: number; seed: number };
export type DesignedVoice = { blob: Blob; filename: string; promptId: string; seed: number; voiceDescription: string; model: string };
type Options = {signal?:AbortSignal;fetch?:typeof fetch;pollMs?:number;onStage?:(stage:string)=>void;onPending?:(id:string)=>void;onRejected?:()=>void};
export function validateVoiceDesign(input: VoiceDesignInput) {
  if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 300) throw Error('试听台词请填写1–300字，正式长台词在选角后配音');
  if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 1000) throw Error('音色描述请填写1–1000字');
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 3) throw Error('每次试听候选数为1–3条');
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 2147483644) throw Error('种子需为0–2147483644的整数');
}
async function json(response: Response) {
  const result = await response.json() as {error?:string;[key:string]:unknown};
  if (!response.ok) throw Error(result.error ?? `音色设计请求失败（HTTP ${response.status}）`);
  return result;
}
export async function runVoiceDesign(input: VoiceDesignInput, options: Options = {}) {
  validateVoiceDesign(input);
  const id=crypto.randomUUID(); options.onPending?.(id);
  const submit=async()=>{
    options.onStage?.('检查显存与GPU队列，提交AI音色选角');
    let response:Response;
    try {response=await (options.fetch??fetch)('/__voice_design',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,...input}),signal:options.signal});}
    catch {throw Error('音色设计提交结果待确认，请查询原任务，不要重复生成');}
    if(response.status>=400&&response.status<500)options.onRejected?.();
    await json(response);
    return waitForVoiceDesign(id,options);
  };
  // Keep normal canvas GPU submissions behind the whole audition job, not just its POST.
  if(typeof navigator!=='undefined'&&navigator.locks)return navigator.locks.request('frameflow-comfy-submit-v1',{signal:options.signal},submit);
  return submit();
}
export async function waitForVoiceDesign(id:string,options:Options={}):Promise<DesignedVoice[]> {
  for(;;){
    options.signal?.throwIfAborted();
    const result=await json(await (options.fetch??fetch)(`/__voice_design?id=${encodeURIComponent(id)}`,{signal:options.signal,cache:'no-store'}));
    if(result.status==='failed'){options.onRejected?.();throw Error(String(result.error??'AI音色设计失败'));}
    if(result.status==='completed'){
      const candidates=result.candidates as {filename:string;seed:number}[];
      if(!Array.isArray(candidates)||!candidates.length)throw Error('试听任务已完成但没有声音输出');
      const outputs:DesignedVoice[]=[];
      for(let i=0;i<candidates.length;i++){
        const response=await (options.fetch??fetch)(`/__voice_design?id=${encodeURIComponent(id)}&file=${i}`,{signal:options.signal});
        if(!response.ok)throw Error('试听文件读取失败，可查询原任务重取，不会重新生成');
        outputs.push({blob:await response.blob(),filename:candidates[i].filename,promptId:id,seed:candidates[i].seed,voiceDescription:String(result.description),model:VOICE_DESIGN_MODEL});
      }
      return outputs;
    }
    options.onStage?.(String(result.stage??'AI音色试听生成中'));
    await new Promise<void>((resolve,reject)=>{const done=()=>{options.signal?.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,options.pollMs??1500);const abort=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);reject(new DOMException('已暂停试听查询','AbortError'));};options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();});
  }
}
