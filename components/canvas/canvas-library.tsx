"use client";
import { useEffect, useState } from 'react';
import { PageRecordType, getSnapshot, useValue, type Editor } from 'tldraw';
import { canvasName, waitForCanvasSave, requireCanvasSwitchIdle } from '@/lib/canvas-library';
import { getGeneratingSnapshot } from '@/lib/link-highlight';
import { isPostprocessBatchActive } from '@/lib/postprocess-queue';
import { showCanvasToast } from './canvas-events';
import { PencilLine, Plus, Save } from 'lucide-react';

export function CanvasLibrary({editor,persistenceKey}:{editor:Editor;persistenceKey:string}){
  const pages=useValue('named canvases',()=>editor.getPages(),[editor]);
  const current=useValue('current named canvas',()=>editor.getCurrentPage(),[editor]);
  useEffect(() => { window.dispatchEvent(new Event('frameflow-canvas-library-changed')); }, [current.id]);
  const [creating,setCreating]=useState(false),[name,setName]=useState(''),[renaming,setRenaming]=useState(false),[rename,setRename]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
  const requireIdle=()=>requireCanvasSwitchIdle(!!getGeneratingSnapshot(),isPostprocessBatchActive());
  const save=async()=>{
    setStatus('正在核实保存…');
    // Reuse tldraw's writer. A success label is issued only after IndexedDB matches the document.
    const document=getSnapshot(editor.store).document;
    await waitForCanvasSave(persistenceKey,new Map(Object.entries(document.store)));
    setStatus('所有画布已保存到本机浏览器');
  };
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);try{await action();}catch(cause){const error=cause instanceof Error?cause.message:'画布操作失败';setStatus(error);showCanvasToast(error);}finally{setBusy(false);}};
  const switchCanvas=(id:string)=>void run(async()=>{if(id===current.id)return;requireIdle();await save();requireIdle();editor.setCurrentPage(id as typeof current.id);setCreating(false);setRenaming(false);});
  const create=()=>void run(async()=>{requireIdle();const nextName=canvasName(name,pages.map(page=>page.name));if(pages.length>=100)throw Error('最多100张画布');await save();requireIdle();const id=PageRecordType.createId();editor.markHistoryStoppingPoint('before creating named canvas');editor.createPage({id,name:nextName});editor.setCurrentPage(id);setCreating(false);setName('');await save();showCanvasToast('新画布已建立，原画布保留');});
  return <nav className="canvas-library-bar" aria-label="画布管理" title={status||'自动保存 · 各画布节点、角色和素材独立'}>
    <select aria-label="切换画布" value={current.id} disabled={busy} onChange={event=>switchCanvas(event.target.value)}>{pages.map(page=><option key={page.id} value={page.id}>{page.name}</option>)}</select>
    <button type="button" className="canvas-library-icon" title="新建画布" aria-label="新建画布" disabled={busy} onClick={()=>{setCreating(!creating);setRenaming(false);setName('');}}><Plus size={14}/></button>
    <button type="button" className="canvas-library-icon" title="重命名画布" aria-label="重命名画布" disabled={busy} onClick={()=>{setRenaming(!renaming);setCreating(false);setRename(current.name);}}><PencilLine size={14}/></button>
    <button type="button" className="canvas-library-icon" title="保存画布" aria-label="保存画布" disabled={busy} onClick={()=>void run(save)}><Save size={14}/></button>
    {creating&&<form onSubmit={event=>{event.preventDefault();create();}}><input aria-label="新画布名称" autoFocus value={name} maxLength={60} placeholder="画布名称" onChange={event=>setName(event.target.value)}/><button disabled={busy||!name.trim()}>创建</button><button type="button" onClick={()=>setCreating(false)}>取消</button></form>}
    {renaming&&<form onSubmit={event=>{event.preventDefault();void run(async()=>{const next=canvasName(rename,pages.map(page=>page.name),current.name);editor.updatePage({id:current.id,name:next});await save();setRenaming(false);});}}><input aria-label="画布新名称" autoFocus value={rename} maxLength={60} onChange={event=>setRename(event.target.value)}/><button disabled={busy||!rename.trim()}>确认名称</button><button type="button" onClick={()=>setRenaming(false)}>取消</button></form>}
    <span className="canvas-library-status" role="status">{status||'自动保存 · 各画布节点、角色和素材独立'}</span>
  </nav>;
}
