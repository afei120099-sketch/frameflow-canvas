import {boundedLock} from './operation-scope.ts';
import {imageProof} from './image-integrity.ts';
import {getAsset,getMeta,putMeta,registerAsset,listAllAssets,type AssetRecord} from './production-records.ts';
import {extractVideoFrameAt,getLocalImageBlob,storeLocalImage} from './local-video-store.ts';
import {submitFrameImageEnhance,waitFrameImageEnhance} from './comfyui/frame-image-enhance.ts';
import {tailFrameSeconds} from './tail-frame-hd.ts';

export type TailHDState={originalAssetId:string;expectedSrc:string;sourceNodeId:string;status:'pending'|'running'|'error'|'completed'|'detached';stage:string;promptId?:string;enhancedAssetId?:string};
export function readTailHD(meta:Record<string,unknown>|undefined):TailHDState|undefined{
  const value=meta?.tailFrameHD as TailHDState|undefined;
  return value&&typeof value.originalAssetId==='string'&&typeof value.expectedSrc==='string'?value:undefined;
}
export function tailHDBlocked(meta:Record<string,unknown>|undefined){
  const state=readTailHD(meta);
  return !!state&&state.status!=='completed'&&state.status!=='detached';
}
export const tailFrameEnhanceKey=(assetId:string)=>'frame-image-enhance:tail-lab-v1:'+assetId;
/** Meta wins. A prompt id already stored on the continuation is the same reservation, not a second job. */
export function tailEnhancePromptId(saved?: {promptId?: string} | null, reservedPromptId?: string) {
  const recorded = saved?.promptId?.trim();
  const reserved = reservedPromptId?.trim();
  return recorded || reserved || undefined;
}
/**
 * The manual HD button keeps waiting inside `waitFrameImageEnhance`.
 * The queue scheduler must not: one tail still sitting in ComfyUI's queue would block every later continuation.
 * After a single observation that this prompt is queued or running, the next history read throws and the caller moves on.
 * The original waiter is not modified and is not asked to submit again.
 */
export function createFrameEnhanceYieldingFetch(promptId: () => string | undefined, base: typeof fetch = fetch): typeof fetch {
  let queued = false;
  return async (input, init) => {
    const url = String(input);
    const id = promptId();
    if (queued && id && url.includes('/history/')) {
      const error = new Error('尾帧高清仍在 ComfyUI 队列或处理中：' + id);
      error.name = 'FrameEnhanceQueuedError';
      throw error;
    }
    const response = await base(input, init);
    if (id && url.includes('/queue')) {
      try {
        const body = await response.clone().json() as {queue_running?: unknown[][]; queue_pending?: unknown[][]};
        const listed = (rows?: unknown[][]) => rows?.some(row => row?.[1] === id);
        if (listed(body.queue_running) || listed(body.queue_pending)) queued = true;
      } catch { /* The waiter reports an unreadable queue itself. */ }
    }
    return response;
  };
}
export async function originalTailPNG(source:AssetRecord,duration:number){
  const key='tail-hd-original:'+source.assetId,saved=await getMeta<{assetId:string}>(key);
  const existing=saved&&await getAsset(saved.assetId);
  if(existing&&!existing.recycled)return existing;
  const frame=await extractVideoFrameAt(source.storageReference,tailFrameSeconds(duration));
  const filename=source.filename.replace(/\.[^.]+$/,'')+'-尾帧.png';
  const blob=await getLocalImageBlob(frame.dataUrl),src=await storeLocalImage(blob,filename);
  const asset=await registerAsset({kind:'image',origin:'generated',filename,mimeType:'image/png',storageReference:src,sourceRunId:null,width:frame.width,height:frame.height,fileSize:blob.size,sourceVideoAssetId:source.assetId,sourceStartTime:frame.seconds,sourceAssetIds:[source.assetId]});
  await putMeta(key,{assetId:asset.assetId,seconds:frame.seconds});return asset;
}
export async function enhanceTailPNG(originalAssetId:string,onStage:(stage:string)=>void,onReserved:(id:string)=>Promise<void>,allowSubmit=false,submissionControl:'submit'|'chain'='submit',beforeSubmit?:()=>void,submissionSessionId?:string,yieldWhileQueued=false,reservedPromptId?:string,signal?:AbortSignal){
  const original=await getAsset(originalAssetId);if(!original||original.recycled)throw Error('原尾帧不可用，请从素材库恢复');
  const key=tailFrameEnhanceKey(original.assetId);
  const check=()=>{signal?.throwIfAborted();beforeSubmit?.();};
  // Only reservation / POST is locked. Polling never keeps this lock or a page lock.
  const promptId=await boundedLock('frameflow-tail-hd-reserve:'+original.assetId,async scope=>{
    const guard=()=>{scope.check();check();};guard();
    let saved=await getMeta<{promptId?:string;completedAssetId?:string}>(key);guard();
    if(!saved){const legacy=await getMeta<{promptId?:string;completedAssetId?:string}>('frame-image-enhance:'+original.assetId);guard();if(legacy?.promptId&&!legacy.completedAssetId&&!reservedPromptId)throw Error('旧尾帧高清任务尚未核实，请先核实原任务；不会叠加提交色彩匹配任务');}
    const id=tailEnhancePromptId(saved,reservedPromptId);
    if(id){if(saved?.promptId!==id)await putMeta(key,{...saved,promptId:id},scope.signal);return id;}
    if(saved?.completedAssetId)throw Error('高清产物记录缺少原promptId，需核实来源；不会新建任务');
    if(!allowSubmit)throw Error('尚无已登记的增强任务，不会自动重提');
    const image=await getLocalImageBlob(original.storageReference);guard();
    return submitFrameImageEnhance(image,original.width!,original.height!,{signal:scope.signal,colorCorrection:'lab',onStage,submissionControl,beforeSubmit:guard,submissionSessionId,onReserved:async id=>{
      guard();await putMeta(key,{promptId:id},scope.signal);guard();await onReserved(id);guard();
    }});
  },{signal,waitMs:1000,workMs:19000,ifAvailable:yieldWhileQueued});
  check();
  if(!promptId){const error=new Error('同一尾帧增强正在登记，下轮核实');error.name='FrameEnhanceQueuedError';throw error;}
  const saved=await getMeta<{promptId?:string;completedAssetId?:string}>(key);check();
  if(saved?.completedAssetId){const ready=await getAsset(saved.completedAssetId);check();if(!ready||ready.recycled)throw Error('已完成的高清图不可用，请从素材库恢复');await imageProof(await getLocalImageBlob(ready.storageReference),signal);check();return ready;}
  // A previous writer may have saved an asset but failed before linking meta / session.
  const orphan=(await listAllAssets('image')).find(asset=>!asset.recycled&&asset.enhancementPromptId===promptId&&asset.sourceAssetIds?.includes(original.assetId));check();
  if(orphan){await imageProof(await getLocalImageBlob(orphan.storageReference),signal);check();await putMeta(key,{promptId,completedAssetId:orphan.assetId},signal);return orphan;}
  const options={signal,colorCorrection:'lab' as const,onStage,submissionControl,beforeSubmit,submissionSessionId,...(yieldWhileQueued?{pollMs:0,fetch:createFrameEnhanceYieldingFetch(()=>promptId)}:{})};
  const result=await waitFrameImageEnhance(promptId,options);check();
  const proof=await imageProof(result.image,signal),size={width:proof.width,height:proof.height};check();
  const src=await storeLocalImage(result.image,result.filename,signal);check();
  const persisted=await imageProof(await getLocalImageBlob(src),signal);check();if(persisted.sha256!==proof.sha256)throw Error("高清图写入IDB后SHA-256不一致；原输出保留，不提交H3");
  const asset=await registerAsset({kind:'image',origin:'generated',filename:result.filename,mimeType:'image/png',storageReference:src,sourceRunId:null,...size,fileSize:result.image.size,sourceAssetIds:[original.assetId],sourceVideoAssetId:original.sourceVideoAssetId,sourceStartTime:original.sourceStartTime,imageIntegrity:proof,enhancementPromptId:promptId},signal);
  check();await putMeta(key,{promptId:result.promptId,completedAssetId:asset.assetId},signal);return asset;
}
