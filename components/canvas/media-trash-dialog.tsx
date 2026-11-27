'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type {Editor, TLShapeId} from 'tldraw';
import {buildMediaTrashPlan,recyclePlannedMedia,type MediaTrashPlan} from '@/lib/media-trash-client';
import {offerDeleteUndo} from '@/lib/canvas-delete-events';
import {showCanvasToast} from './canvas-events';
import {getGeneratingSnapshot} from '@/lib/link-highlight';
import {isNodeClaimed} from '@/lib/run-recovery';
import {safeDeleteNodes} from '@/lib/safe-delete';

export function MediaTrashDialog({editor}:{editor:Editor}) {
  const [ids,setIds]=useState<TLShapeId[]|null>(null);
  const [plan,setPlan]=useState<MediaTrashPlan|null>(null);
  const [error,setError]=useState('');
  const [available,setAvailable]=useState(false);
  const [busy,setBusy]=useState(false);
  const [done,setDone]=useState(0);
  const close=()=>{setIds(null);editor.focus();};
  useEffect(()=>{
    const request=(event:Event)=>{setIds([...(event as CustomEvent<TLShapeId[]>).detail]);setPlan(null);setError('');setDone(0);};
    window.addEventListener('canvas-delete-request',request);
    return()=>window.removeEventListener('canvas-delete-request',request);
  },[]);
  useEffect(()=>{
    if(!ids)return;
    let live=true;
    void buildMediaTrashPlan(editor,ids).then(value=>{if(live)setPlan(value);}).catch(cause=>{if(live)setError(cause instanceof Error?cause.message:'引用检查失败，未清理');});
    void fetch('/api/media-trash').then(r=>r.json()).then(value=>{if(live)setAvailable((value as {available?:boolean}).available===true);}).catch(()=>{if(live)setAvailable(false);});
    return()=>{live=false;};
  },[editor,ids]);
  useEffect(()=>{
    if(!ids)return;
    const guard=(event:KeyboardEvent)=>{
      event.stopImmediatePropagation();
      if(event.key==='Escape'){event.preventDefault();if(!busy)close();}
      if(event.key==='Delete'||event.key==='Backspace'){event.stopImmediatePropagation();event.preventDefault();}
      if((event.ctrlKey||event.metaKey)&&['z','y','a'].includes(event.key.toLowerCase()))event.preventDefault();
    };
    window.addEventListener('keydown',guard,true);
    return()=>{window.removeEventListener('keydown',guard,true);};
  },[ids,busy]);
  if(!ids)return null;
  const removeOnly=async()=>{
    const active=new Set(getGeneratingSnapshot().split(','));
    if(ids.some(id=>active.has(id)||isNodeClaimed(id))){setError('节点仍有进行中的任务，请先核实并取消任务');return;}
    setBusy(true);
    try {
      const result=await safeDeleteNodes(editor,ids,'canvas-only');
      if(result.ok){if(result.undo)offerDeleteUndo(result.undo,result.message);close();}
      else if(result.canForce&&result.confirmationKey){close();window.dispatchEvent(new CustomEvent('canvas-delete-unconfirmed',{detail:{ids:[...ids],confirmationKey:result.confirmationKey,message:result.message}}));}
      else setError(result.message);
    }
    catch(cause){setError(cause instanceof Error?cause.message:'节点任务未核实，未删除');}
    finally{setBusy(false);}
  };
  const clean=async()=>{
    if(!plan)return;
    setBusy(true);setError('');
    try {const count=await recyclePlannedMedia(editor,plan,setDone);close();showCanvasToast(`已将 ${count} 份素材文件移入 Windows 回收站；恢复文件后可重新导入画布`);}
    catch(cause){setError(cause instanceof Error?cause.message:'清理未完成');}
    finally{setBusy(false);}
  };
  const blocked=!plan?.assets.length||plan.assets.some(a=>a.reasons.length>0);
  return createPortal(<div className="media-trash-backdrop" onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
    <section className="media-trash-dialog" role="dialog" aria-modal="true" aria-label="删除节点与素材文件">
      <h2>删除 {ids.length} 个节点</h2>
      <p className="ff-hint">普通删除会取消对应任务并自动回收无共享引用的文件；受保护文件保留。此高级入口仍可明确选择仅移除节点。清理前检查其他画布、角色、生成输入、已采用版本和成片引用。</p>
      <p className="ff-hint">本机生成原文件仅在历史记录和内容校验匹配后回收。导入素材只清理画布保存的副本，桌面等位置的原件不会被猜测删除。</p>
      <p className="ff-hint">文件在 Windows 回收站中可恢复；恢复后需重新导入画布。Ctrl+Z 只能恢复节点，不能还原回收站文件。放入回收站不会立即释放该盘空间。</p>
      {!plan&&!error&&<p role="status">正在核查素材引用…</p>}
      {plan&&<ul>{plan.assets.map(({asset,reasons})=><li key={asset.assetId}><strong>{asset.filename}</strong><span>{reasons.length?'保留：'+reasons.join('；'):'可回收：文件与画布副本'}</span></li>)}</ul>}
      {plan&&!plan.assets.length&&<p>所选节点没有可核实的独立素材文件，可仅从画布移除。</p>}
      {!available&&<p>本机回收站助手未就绪，文件清理暂不可用。</p>}
      {error&&<p role="alert">{error}</p>}
      {busy&&<p role="status">正在回收 {done}/{plan?.assets.length}，请勿关闭页面…</p>}
      <footer><button autoFocus disabled={busy} onClick={close}>取消</button><button disabled={busy} onClick={()=>void removeOnly()}>仅从画布移除</button><button disabled={busy||!available||blocked||!!error} onClick={()=>void clean()}>同时清理素材文件，放入回收站</button></footer>
    </section>
  </div>,document.body);
}
