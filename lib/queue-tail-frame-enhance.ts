import {imageProof} from './image-integrity.ts';
import {boundedLock,type OperationScope} from './operation-scope.ts';
import type {QueueFrameInput} from './shot-queue-frames.ts';
import {getAsset,getAssetBySource,getMeta,putMeta,registerAsset} from './production-records.ts';
import {getLocalImageBlob,storeLocalImage} from './local-video-store.ts';
import {enhanceTailPNG,tailFrameEnhanceKey} from './tail-frame-hd-job.ts';

/** Persist an extracted queue frame as an image asset so sessions and nodes keep an `image:` reference, not base64. */
export async function storeQueueFrame(dataUrl:string,name:string,source:{assetId:string;seconds:number;width:number;height:number},signal?:AbortSignal){
  const blob=await getLocalImageBlob(dataUrl);
  const proof=await imageProof(blob,signal);signal?.throwIfAborted();
  const src=await storeLocalImage(blob,name,signal);
  await registerAsset({kind:'image',origin:'generated',filename:name,mimeType:blob.type||'image/png',storageReference:src,sourceRunId:null,width:source.width,height:source.height,fileSize:blob.size,sourceVideoAssetId:source.assetId,sourceStartTime:source.seconds,sourceAssetIds:[source.assetId],imageIntegrity:proof},signal);
  return src;
}

/** No queue/Run edits or H3 submission here. The caller checkpoints the original session. */
export async function enhanceQueueTailFrame(frame:QueueFrameInput,checkpoint:(frame:QueueFrameInput)=>Promise<void>,guard:()=>void,onStage:(stage:string)=>void,submissionSessionId?:string,signal?:AbortSignal){
  guard();
  if(frame.sourceFrame!=='last')return frame;
  // Freeze the exact already-extracted frame, never decode a different time on resume.
  const key=`queue-tail-original:${frame.sourceRunId}:${frame.sourceAssetId}:${frame.seconds}`;
  const run=async(scope:OperationScope)=>{
    const check=()=>{scope.check();guard();};
    const signal=scope.signal;
    check();
    const prior=frame.enhancement?.originalAssetId??(await getMeta<{assetId:string}>(key))?.assetId;
    let original=prior?await getAsset(prior):null;check();
    if(prior&&(!original||original.recycled))throw Error('原尾帧素材已丢失或回收，请恢复；不会换图重提');
    // A frame already stored by storeQueueFrame is reused instead of saved twice.
    if(!original&&!frame.src.startsWith('data:')){
      const stored=await getAssetBySource(frame.src);check();
      if(stored&&!stored.recycled){original=stored;await putMeta(key,{assetId:original.assetId},signal);check();}
    }
    if(!original){
      const blob=await getLocalImageBlob(frame.src);check();
      const proof=await imageProof(blob,signal);check();
      const src=await storeLocalImage(blob,frame.name,signal);check();
      original=await registerAsset({kind:'image',origin:'generated',filename:frame.name,mimeType:blob.type||'image/png',storageReference:src,sourceRunId:null,width:frame.width,height:frame.height,fileSize:blob.size,sourceVideoAssetId:frame.sourceAssetId,sourceStartTime:frame.seconds,sourceAssetIds:[frame.sourceAssetId],imageIntegrity:proof},signal);check();
      await putMeta(key,{assetId:original.assetId},signal);check();
    }
    const originalAssetId=original.assetId;
    let current:QueueFrameInput={...frame,enhancement:{...frame.enhancement,originalAssetId}};
    await checkpoint(current);check();
    onStage('尾帧 AI 高清：准备或查询原任务');
    const enhanced=await enhanceTailPNG(originalAssetId,stage=>{check();onStage('尾帧 AI 高清：'+stage);},async promptId=>{check();current={...current,enhancement:{originalAssetId,promptId}};await checkpoint(current);check();},true,'chain',check,submissionSessionId,true,current.enhancement?.promptId,signal);
    check();
    const receipt=await getMeta<{promptId?:string}>(tailFrameEnhanceKey(originalAssetId));check();
    const blob=await getLocalImageBlob(enhanced.storageReference);check();
    await imageProof(blob,signal);check();
    // Keep the stored asset reference; inlining it as base64 bloats the canvas document and queue session.
    return {...current,src:enhanced.storageReference,name:enhanced.filename,width:enhanced.width!,height:enhanced.height!,enhancement:{...current.enhancement!,...(receipt?.promptId?{promptId:receipt.promptId}:{}),completedAssetId:enhanced.assetId}};
  };
  const result=await boundedLock('frameflow-queue-tail-hd-'+key,async scope=>{scope.check();return run(scope);},{signal,workMs:20000,ifAvailable:true});
  if(!result){const error=new Error('同一原尾帧正在核实，稍后查询原任务');error.name='FrameEnhanceQueuedError';throw error;}
  return result;
}
