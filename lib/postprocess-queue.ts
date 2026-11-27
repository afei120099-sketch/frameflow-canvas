export type ProcessingResult='completed'|'failed'|'cancelled'|'uncertain';
type Controller={ready:boolean;generate:()=>Promise<ProcessingResult|undefined>};
const controllers=new Map<string,()=>Controller>();
let activeBatches=0;
export const isPostprocessBatchActive=()=>activeBatches>0;
export function registerProcessing(id:string,read:()=>Controller){controllers.set(id,read);return ()=>{if(controllers.get(id)===read)controllers.delete(id);};}
export async function runRegisteredProcessing(id:string,stopped:()=>boolean){
  for(let attempt=0;attempt<60;attempt++){
    if(stopped())return 'cancelled';
    const controller=controllers.get(id)?.();
    if(controller?.ready)return await controller.generate()??'failed';
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error('处理节点未准备好，请检查输入视频和ComfyUI连接');
}
/** Default stops on failure. Explicit night policy may skip definitive failures only;
 * cancelled/uncertain submissions always stop and this helper never retries a POST. */
export async function runSerialProcessing<T>(items:T[],run:(item:T,index:number)=>Promise<ProcessingResult>,stopped:()=>boolean,onProgress:(index:number)=>void,options:{continueOnFailure?:boolean}={}){
  activeBatches++;
  try{
  let completed=0,failed=0;
  for(let index=0;index<items.length;index++){
    if(stopped())return {completed,status:'cancelled' as const};
    onProgress(index);
    const status=await run(items[index],index);
    if(status==='failed'&&options.continueOnFailure){failed++;continue;}
    if(status!=='completed')return {completed,status};
    completed++;
  }
  return {completed,...(options.continueOnFailure?{failed}:{}),status:'completed' as const};
  }finally{activeBatches--;}
}
