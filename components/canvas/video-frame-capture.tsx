"use client";
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {Editor,TLShape} from 'tldraw';
import {acquireMediaUrl,extractVideoFrameAt,getLocalImageBlob,releaseMediaUrl,storeLocalImage} from '@/lib/local-video-store';
import {getMeta,putMeta,registerAsset,type AssetRecord} from '@/lib/production-records';
import {runFrameImageEnhance,waitFrameImageEnhance} from '@/lib/comfyui/frame-image-enhance';
import {showCanvasToast} from './canvas-events';
export const OPEN_VIDEO_FRAME_CAPTURE='frameflow-open-video-frame-capture';
type Source={asset:AssetRecord;duration:number};
type Selection={source:Source;nodeId:TLShape['id'];pageId:TLShape['parentId'];ai:boolean};
export function VideoFrameCapture({editor,resolveSource,place}:{editor:Editor;resolveSource:(shape:TLShape)=>Promise<Source>;place:(asset:AssetRecord,sourceId:TLShape['id'])=>Promise<void>}){
 const [selection,setSelection]=useState<Selection|null>(null),[url,setUrl]=useState(''),[seconds,setSeconds]=useState(0),[busy,setBusy]=useState(false),[stage,setStage]=useState(''),[error,setError]=useState('');
 const video=useRef<HTMLVideoElement>(null),active=useRef(false),opening=useRef(false),captured=useRef<{asset:AssetRecord;seconds:number}|null>(null);
 const [pending,setPending]=useState<{promptId:string;assetId:string}|null>(null);
 useEffect(()=>{const open=async(event:Event)=>{
  if(active.current||opening.current)return;opening.current=true;
  const d=(event as CustomEvent<{sourceId:TLShape['id'];ai?:boolean}>).detail;
  try{const shape=editor.getShape(d.sourceId);if(!shape)throw Error('视频节点不存在');const source=await resolveSource(shape);
   captured.current=null;setPending(null);setSeconds(0);setError('');setStage('');setSelection({source,nodeId:shape.id,pageId:editor.getCurrentPageId(),ai:!!d.ai});
  }catch(cause){showCanvasToast(cause instanceof Error?cause.message:'无法读取视频');}finally{opening.current=false;}
 };window.addEventListener(OPEN_VIDEO_FRAME_CAPTURE,open);return()=>window.removeEventListener(OPEN_VIDEO_FRAME_CAPTURE,open);},[editor,resolveSource]);
 useEffect(()=>{let live=true,key:string|null=null,revoke=false,owned='';setUrl('');if(selection)void acquireMediaUrl(selection.source.asset.storageReference).then(r=>{if(!live){releaseMediaUrl(r.key);if(r.revoke&&r.url)URL.revokeObjectURL(r.url);return;}key=r.key;revoke=r.revoke;owned=r.revoke?r.url:'';setUrl(r.url);}).catch(c=>{if(live)setError(String(c));});return()=>{live=false;releaseMediaUrl(key);if(revoke&&owned)URL.revokeObjectURL(owned);};},[selection]);
 const capture=async(ai:boolean,resume=false)=>{
  if(!selection||active.current)return;active.current=true;setBusy(true);setError('');video.current?.pause();
  const chosen=selection,time=video.current?.currentTime??seconds;
  try{
   let original=captured.current;
   if(!resume&&(!original||Math.abs(original.seconds-time)>.001)){
    setStage('提取视频原始尺寸 PNG');const frame=await extractVideoFrameAt(chosen.source.asset.storageReference,time);
    const filename=chosen.source.asset.filename.replace(/\.[^.]+$/,'')+`-截帧-${frame.seconds.toFixed(3)}s.png`;
    const blob=await getLocalImageBlob(frame.dataUrl),src=await storeLocalImage(blob,filename);
    const asset=await registerAsset({kind:'image',origin:'generated',filename,mimeType:'image/png',storageReference:src,sourceRunId:null,width:frame.width,height:frame.height,fileSize:blob.size,sourceVideoAssetId:chosen.source.asset.assetId,sourceStartTime:frame.seconds,sourceAssetIds:[chosen.source.asset.assetId]});
    original={asset,seconds:frame.seconds};captured.current=original;await place(asset,chosen.nodeId);
   }
   if(!original)throw Error('没有可增强的原截图');
   if(ai){
    const key='frame-image-enhance:'+original.asset.assetId;
    const saved=await getMeta<{promptId:string;completedAssetId?:string}>(key);
    if(saved?.completedAssetId){setStage('这张截图已完成增强，请在画布或素材库查看');return;}
    const options={onStage:setStage,onReserved:async(promptId:string)=>{await putMeta(key,{promptId});setPending({promptId,assetId:original!.asset.assetId});}};
    const result=saved?.promptId?await waitFrameImageEnhance(saved.promptId,options):await runFrameImageEnhance(await getLocalImageBlob(original.asset.storageReference),original.asset.width!,original.asset.height!,options);
    const bitmap=await createImageBitmap(result.image);const size={width:bitmap.width,height:bitmap.height};bitmap.close();
    const src=await storeLocalImage(result.image,result.filename);
    const asset=await registerAsset({kind:'image',origin:'generated',filename:result.filename,mimeType:'image/png',storageReference:src,sourceRunId:null,...size,fileSize:result.image.size,sourceAssetIds:[original.asset.assetId],sourceVideoAssetId:chosen.source.asset.assetId,sourceStartTime:original.seconds});
    await putMeta(key,{promptId:result.promptId,completedAssetId:asset.assetId});setPending(null);await place(asset,chosen.nodeId);
   }
   setStage(ai?'原图和 AI 高清图都已加入画布':'原画质 PNG 已加入画布');
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{active.current=false;setBusy(false);}
 };
 if(!selection)return null;
 return createPortal(<div className="generation-info-backdrop" onPointerDown={e=>e.stopPropagation()}><section className="generation-info-panel ff-panel" role="dialog" aria-label="视频截帧" style={{maxWidth:900,padding:24}}>
 <header><h2>视频截帧 · 原画质／AI 高清</h2><button disabled={busy} onClick={()=>setSelection(null)}>关闭</button></header>
 <p>{selection.source.asset.filename} · 拖动视频进度条，暂停在想要的画面</p>
 <video ref={video} src={url||undefined} controls playsInline preload="metadata" style={{width:'100%',maxHeight:'50vh'}} onTimeUpdate={e=>setSeconds(e.currentTarget.currentTime)} onError={()=>setError('视频预览读取失败')}/>
 <label>截帧时间（秒）<input type="number" min={0} max={selection.source.duration} step={.001} value={seconds} disabled={busy} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n)&&n>=0&&n<selection.source.duration){setSeconds(n);if(video.current)video.current.currentTime=n;}}}/></label>
 <p className="ff-hint">原画质按视频原始尺寸输出 PNG，不受画布缩放影响。AI 使用本机 SeedVR2，约 2×、最长边不超过4096；脸部、文字等细节可能变化，原图始终保留。</p>
 {selection.ai&&<p>已选择 AI 高清，请定位画面后点击下方增强按钮。</p>}
 <p role="status">{stage}</p>{error&&<p role="alert" className="role-error">{error}</p>}
 <footer style={{display:'flex',gap:12}}><button disabled={busy||!url} onClick={()=>void capture(false)}>截取原画质 PNG</button><button disabled={busy||!url||!!pending} onClick={()=>void capture(true)}>截取并 AI 高清</button>{pending&&<button disabled={busy} onClick={()=>void capture(true,true)}>查询原增强任务（不重提）</button>}</footer>
 </section></div>,document.body);
}
