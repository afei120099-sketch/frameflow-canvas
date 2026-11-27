"use client";
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {useValue,type Editor,type TLShape} from 'tldraw';
import {canvasCutList,isCuttableVideo,leftToRight,moveCutClip,OPEN_CANVAS_ROUGH_CUT,type CanvasCutClip} from '@/lib/canvas-rough-cut';
import {useAcquiredMediaUrl} from './media-hooks';
import {validateRange} from '@/lib/final-cut-list';
import {getMeta,putMeta,getAsset} from "@/lib/production-records";
import type {AssetRecord} from '@/lib/production-records';
import {RoughCutDialog} from '@/components/rough-cut-dialog';
import {showCanvasToast} from './canvas-events';
import { askConfirm } from "@/components/in-page-dialog";

function ClipPreview({clip,onClose}:{clip:CanvasCutClip;onClose:()=>void}){
 const url=useAcquiredMediaUrl(clip.asset.storageReference,true);const error='';const video=useRef<HTMLVideoElement>(null);
 return createPortal(<div className="canvas-cut-preview-backdrop" onPointerDown={e=>{e.stopPropagation();if(e.target===e.currentTarget)onClose();}}><section role="dialog" aria-label="粗剪片段预览"><header><b>{clip.asset.filename} · {clip.inPoint}～{clip.outPoint} 秒</b><button onClick={onClose}>关闭预览</button></header>{error?<p role="alert">{error}</p>:<video ref={video} src={url||undefined} controls autoPlay playsInline onLoadedMetadata={e=>{e.currentTarget.currentTime=clip.inPoint;}} onTimeUpdate={e=>{if(e.currentTarget.currentTime>=clip.outPoint)e.currentTarget.pause();}}/>}<button onClick={()=>{if(video.current){video.current.currentTime=clip.inPoint;void video.current.play().catch(()=>{});}}}>重播选定片段</button></section></div>,document.body);
}

export function CanvasRoughCut({editor,resolveSource,onReady}:{editor:Editor;resolveSource:(shape:TLShape)=>Promise<{asset:AssetRecord;duration:number}>;onReady:(asset:AssetRecord)=>void}){
 const [draft,setDraft]=useState<{pageId:string;id:string;clips:CanvasCutClip[]}|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<CanvasCutClip|null>(null),[exporting,setExporting]=useState<ReturnType<typeof canvasCutList>|null>(null);
 const token=useRef(0),opening=useRef(false);
 const [readyPage,setReadyPage]=useState(""),[savingDraft,setSavingDraft]=useState(false); const saves=useRef(Promise.resolve()),pendingSaves=useRef(0);
 useEffect(()=>{const guard=(e:BeforeUnloadEvent)=>{if(pendingSaves.current){e.preventDefault();e.returnValue="";}};window.addEventListener("beforeunload",guard);return()=>window.removeEventListener("beforeunload",guard);},[]);
 const pageId=useValue('rough cut page',()=>editor.getCurrentPageId(),[editor]);
 const clipIds=draft?.pageId===pageId?draft.clips.map(c=>c.nodeId).join('\n'):'';
 const view=useValue('rough cut positions',()=>{if(!clipIds)return null;const ids=clipIds.split('\n');return {zoom:editor.getZoomLevel(),viewport:editor.getViewportScreenBounds(),bounds:new Map(ids.map(id=>[id,editor.getShapePageBounds(id as TLShape['id'])]))};},[editor,clipIds]);
 useEffect(()=>{let live=true;void getMeta<typeof draft>("canvas-cut-draft-v1:"+pageId).then(async saved=>{
  if(!live)return;
  setDraft(saved??null);setReadyPage(pageId);
  if(saved){const missing=await Promise.all(saved.clips.map(c=>getAsset(c.asset.assetId)));if(live&&missing.some(a=>!a))setError("已恢复草稿，但有素材缺失；请从项目备份找回，不会自动替换候选");}
 }).catch(()=>{if(live)setError("粗剪草稿读取失败，请勿覆盖");});return()=>{live=false;};},[pageId]);
 useEffect(()=>{if(readyPage!==pageId)return;const key="canvas-cut-draft-v1:"+pageId,value=structuredClone(draft);
  pendingSaves.current++;queueMicrotask(()=>setSavingDraft(true));
  saves.current=saves.current.catch(()=>{}).then(()=>putMeta(key,value)).catch(()=>setError("粗剪草稿保存失败")).finally(()=>{pendingSaves.current--;if(!pendingSaves.current)setSavingDraft(false);});
 },[draft,readyPage,pageId]);
 useEffect(()=>{const open=async(event:Event)=>{
  if(opening.current)return;
  const detail=(event as CustomEvent<{ids?:TLShape['id'][]}>).detail;
  const shapes=leftToRight((detail?.ids?detail.ids.map(id=>editor.getShape(id)).filter((s):s is TLShape=>!!s):editor.getSelectedShapes()).filter(isCuttableVideo));
  if(!shapes.length){showCanvasToast('请先选中要粗剪的视频');return;}
  if(readyPage!==pageId){showCanvasToast('正在恢复草稿，请稍候');return;}
  if(draft){opening.current=true;const again=await askConfirm('重新按所选视频建立粗剪？取消则保留并继续当前草稿。原视频不会改变。');opening.current=false;if(!again)return;}
  opening.current=true;const current=++token.current,openPageId=editor.getCurrentPageId();setLoading(true);setError('');
  try{const clips=await Promise.all(shapes.map(async shape=>{const source=await resolveSource(shape);return {nodeId:shape.id,...source,inPoint:0,outPoint:source.duration};}));if(current===token.current&&editor.getCurrentPageId()===openPageId){setDraft({pageId:openPageId,id:crypto.randomUUID(),clips});editor.select(...shapes.map(s=>s.id));}}
  catch(cause){if(current===token.current)setError(cause instanceof Error?cause.message:'读取所选视频失败');}
  finally{if(current===token.current){opening.current=false;setLoading(false);}}
 };window.addEventListener(OPEN_CANVAS_ROUGH_CUT,open);return()=>{window.removeEventListener(OPEN_CANVAS_ROUGH_CUT,open);token.current++;opening.current=false;};},[editor,resolveSource,draft,readyPage,pageId]);
 const active=draft?.pageId===pageId?draft:null;
 useEffect(()=>{if(active)document.body.classList.add('canvas-cut-editing');else document.body.classList.remove('canvas-cut-editing');return()=>document.body.classList.remove('canvas-cut-editing');},[active]);
 const change=(index:number,field:'inPoint'|'outPoint',value:string)=>{if(!active||exporting)return;setError('');setDraft({...active,clips:active.clips.map((c,i)=>i===index?{...c,[field]:value===''?NaN:Number(value)}:c)});};
 const move=(index:number,to:number)=>{if(active&&!exporting)setDraft({...active,clips:moveCutClip(active.clips,index,to)});};
 const finish=()=>{if(!active)return;try{if(active.clips.some(c=>!editor.getShape(c.nodeId as TLShape['id'])))throw Error('有粗剪节点已被删除，请重新选择视频');setExporting(canvasCutList(active.clips,active.id));setError('');}catch(cause){setError(cause instanceof Error?cause.message:'截取时间无效');}};
 const close=()=>{setDraft(null);setError('');setPreview(null);};
 return createPortal(<>
  {active&&view&&!exporting&&active.clips.map((clip,index)=>{
   const b=view.bounds.get(clip.nodeId as TLShape['id']);if(!b)return null;
   const top=editor.pageToScreen({x:b.center.x,y:b.minY}),bottom=editor.pageToScreen({x:b.center.x,y:b.maxY});
   if(bottom.x<view.viewport.minX-700||bottom.x>view.viewport.maxX+700||bottom.y<view.viewport.minY-250||top.y>view.viewport.maxY+200)return null;
   const scale=Math.min(1,view.zoom),width=Math.min(520,Math.max(340,b.w));
   let problem='';try{validateRange(clip.inPoint,clip.outPoint,clip.duration);}catch(cause){problem=cause instanceof Error?cause.message:'时间无效';}
   return <div key={clip.nodeId} data-testid="canvas-cut-clip" data-node-id={clip.nodeId}>
    <div className="canvas-cut-number" style={{left:top.x,top:top.y-62*scale,transform:`translateX(-50%) scale(${scale})`,transformOrigin:'top center'}} aria-label={`粗剪顺序 ${index+1}`}>{index+1}</div>
    <section className="canvas-cut-time" aria-label={`粗剪第${index+1}段`} style={{left:bottom.x,top:bottom.y+12*scale,width,transform:`translateX(-50%) scale(${scale})`,transformOrigin:'top center'}} onPointerDown={e=>e.stopPropagation()}>
     <header><b title={clip.asset.filename}>第 {index+1} 段 · {clip.asset.filename}</b><button aria-label={`移除第${index+1}段`} onClick={()=>{if(active.clips.length===1)close();else setDraft({...active,clips:active.clips.filter((_,i)=>i!==index)});}}>移除</button></header>
     <div className="canvas-cut-range"><label>从（秒）<input aria-label={`第${index+1}段开始秒数`} type="number" min={0} max={clip.duration} step={.01} value={Number.isFinite(clip.inPoint)?clip.inPoint:''} onChange={e=>change(index,'inPoint',e.target.value)}/></label><span>→</span><label>到（秒）<input aria-label={`第${index+1}段结束秒数`} type="number" min={0} max={clip.duration} step={.01} value={Number.isFinite(clip.outPoint)?clip.outPoint:''} onChange={e=>change(index,'outPoint',e.target.value)}/></label><small>原片 {clip.duration.toFixed(2)} 秒<br/>截取 {Number.isFinite(clip.outPoint-clip.inPoint)?Math.max(0,clip.outPoint-clip.inPoint).toFixed(2):'—'} 秒</small></div>
     <label>进入本段的转场<select aria-label={`第${index+1}段转场`} disabled={index===0} value={clip.transition?.type??"cut"} onChange={e=>setDraft({...active,clips:active.clips.map((c,i)=>i===index?{...c,transition:{type:e.target.value as "cut"|"dissolve"|"fade",seconds:c.transition?.seconds??.25}}:c)})}><option value="cut">硬切</option><option value="dissolve">叠化</option><option value="fade">淡出淡入</option></select></label>{index>0&&clip.transition&&clip.transition.type!=="cut"&&<label>转场秒数<input type="number" min=".05" max="1" step=".05" value={clip.transition.seconds} onChange={e=>setDraft({...active,clips:active.clips.map((c,i)=>i===index?{...c,transition:{...clip.transition!,seconds:Number(e.target.value)}}:c)})}/></label>}<footer><button disabled={index===0} aria-label={`第${index+1}段前移`} onClick={()=>move(index,index-1)}>← 前移</button><label>顺序<select aria-label={`第${index+1}段顺序`} value={index} onChange={e=>move(index,Number(e.target.value))}>{active.clips.map((_,i)=><option key={i} value={i}>{i+1}</option>)}</select></label><button disabled={index===active.clips.length-1} aria-label={`第${index+1}段后移`} onClick={()=>move(index,index+1)}>后移 →</button><button disabled={!!problem} onClick={()=>setPreview(clip)}>预览片段</button></footer>{problem&&<small className="canvas-cut-error" role="alert">{problem}</small>}
    </section>
   </div>;
  })}
  {(active||loading||error)&&!exporting&&<div className="canvas-cut-toolbar" role="region" aria-label="画布粗剪操作" onPointerDown={e=>e.stopPropagation()}><b>{loading?'正在读取视频…':`粗剪 ${active?.clips.length??0} 段`}</b>{active&&<><span>预计 {Math.max(0,active.clips.reduce((n,c,i)=>n+(Number.isFinite(c.outPoint-c.inPoint)?Math.max(0,c.outPoint-c.inPoint):0)-(i>0&&c.transition?.type==='dissolve'?c.transition.seconds:0),0)).toFixed(2)} 秒 · {savingDraft?"草稿保存中…":"草稿已保存"}，转场以输出帧数核对</span><button onClick={()=>{const shapes=leftToRight(active.clips.flatMap(c=>{const s=editor.getShape(c.nodeId as TLShape['id']);return s?[{...s,clip:c}]:[];}));setDraft({...active,clips:shapes.map(s=>s.clip)});}}>恢复从左到右</button><button className="canvas-cut-confirm" onClick={finish}>确认并生成粗剪</button></>}{!loading&&<button onClick={()=>{void askConfirm("退出并清空本次草稿？刷新则会自动恢复尚未清空的草稿。").then(ok=>{if(ok)close();});}}>清空草稿</button>}{error&&<span role="alert" className="canvas-cut-error">{error}</span>}</div>}
  {preview&&active&&!exporting&&<ClipPreview clip={preview} onClose={()=>setPreview(null)}/>}
  {exporting&&<RoughCutDialog list={exporting.list} rows={exporting.rows} autoStart onClose={()=>setExporting(null)} onReady={asset=>{close();onReady(asset);}}/>}
  <style>{`.canvas-cut-editing .batch-video-actions,.canvas-cut-editing .h3-inline-composer{display:none!important}.canvas-cut-number{position:fixed;z-index:310;pointer-events:none;min-width:56px;height:52px;line-height:52px;text-align:center;font-size:44px;font-weight:850;color:white;background:var(--ff-white);color:var(--ff-ink);border:2px solid var(--ff-white);border-radius:16px;box-shadow:0 4px 18px #0009}.canvas-cut-time{position:fixed;z-index:311;box-sizing:border-box;padding:12px;border:1px solid var(--ff-text-3);border-radius:12px;background:var(--ff-raised);color:#fff;box-shadow:0 5px 16px #0006;font-size:13px}.canvas-cut-time header,.canvas-cut-time footer,.canvas-cut-range,.canvas-cut-toolbar{display:flex;align-items:center;gap:10px}.canvas-cut-time header b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.canvas-cut-range{margin:10px 0}.canvas-cut-time label{display:grid;gap:4px}.canvas-cut-time input{width:90px}.canvas-cut-time input,.canvas-cut-time select{box-sizing:border-box;background:var(--ff-canvas);color:white;border:1px solid var(--ff-border-hover);border-radius:6px;padding:7px}.canvas-cut-time button,.canvas-cut-toolbar button,.canvas-cut-preview-backdrop button{border:1px solid var(--ff-border-hover);border-radius:7px;background:var(--ff-hover);color:white;padding:7px 10px;cursor:pointer;white-space:nowrap}.canvas-cut-time button:disabled{opacity:.35;cursor:default}.canvas-cut-time footer{justify-content:space-between;flex-wrap:wrap}.canvas-cut-time footer label{display:flex;align-items:center;gap:6px}.canvas-cut-time small{color:var(--ff-text-2)}.canvas-cut-toolbar{position:fixed;z-index:350;left:50%;bottom:24px;transform:translateX(-50%);max-width:calc(100vw - 40px);flex-wrap:wrap;padding:14px 18px;border:1px solid var(--ff-text-3);border-radius:14px;background:var(--ff-raised);color:white;box-shadow:0 8px 30px #0009;font-size:14px}.canvas-cut-toolbar .canvas-cut-confirm{background:var(--ff-white);color:var(--ff-ink);border-color:var(--ff-text-3)}.canvas-cut-error{color:var(--ff-bad)!important}.canvas-cut-preview-backdrop{position:fixed;inset:0;z-index:1200;background:#000b;display:grid;place-items:center}.canvas-cut-preview-backdrop section{width:min(900px,90vw);padding:18px;border:1px solid var(--ff-text-3);border-radius:15px;background:var(--ff-raised);color:white}.canvas-cut-preview-backdrop header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px}.canvas-cut-preview-backdrop video{display:block;width:100%;max-height:65vh;margin-bottom:12px}`}</style>
 </>,document.body);
}
