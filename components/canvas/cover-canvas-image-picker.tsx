'use client';
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {Editor,TLShapeId} from 'tldraw';
import {canvasCoverImage,type CanvasCoverImage} from '@/lib/cover-canvas-selection';
/** Actual canvas picking, not a global Asset-library list. Does not move/select the source. */
export function CoverCanvasImagePicker({editor,ownerId,onChoose,onClose}:{editor:Editor;ownerId:TLShapeId;onChoose:(image:CanvasCoverImage)=>Promise<void>;onClose:()=>void}){
 const [error,setError]=useState(''),[working,setWorking]=useState(false);const callbacks=useRef({onChoose,onClose});
 useEffect(()=>{callbacks.current={onChoose,onClose};},[onChoose,onClose]);
 useEffect(()=>{
  let alive=true,pending=false,candidate:CanvasCoverImage|null=null;const camera={...editor.getCamera()},container=editor.getContainer(),cursor=container.style.cursor;container.style.cursor='crosshair';
  const close=()=>callbacks.current.onClose();
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!pending)close();}};
  const pick=(event:PointerEvent)=>{
   if(event.button!==0||!(event.target instanceof Element)||event.target.closest('[data-cover-picker-ui]')||!container.contains(event.target))return;
   const shape=editor.getShapeAtPoint(editor.screenToPage({x:event.clientX,y:event.clientY}),{hitInside:true,filter:s=>s.id!==ownerId&&!!canvasCoverImage(s)});
   if(!shape)return;const image=canvasCoverImage(shape);if(!image)return;
   event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();if(!pending)candidate=image;
  };
  // Consume the entire click before closing: header actions (delete/download) must never fire.
  const up=(event:PointerEvent)=>{if(candidate){event.preventDefault();event.stopImmediatePropagation();}};
  const click=(event:MouseEvent)=>{if(!candidate)return;event.preventDefault();event.stopImmediatePropagation();const image=candidate;candidate=null;if(pending)return;pending=true;setWorking(true);setError('');void callbacks.current.onChoose(image).then(()=>{if(alive)close();}).catch(e=>{if(alive)setError(e instanceof Error?e.message:String(e));}).finally(()=>{pending=false;if(alive)setWorking(false);});};
  window.addEventListener('pointerdown',pick,true);window.addEventListener('pointerup',up,true);window.addEventListener('click',click,true);window.addEventListener('keydown',escape,true);
  return()=>{alive=false;window.removeEventListener('pointerdown',pick,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('click',click,true);window.removeEventListener('keydown',escape,true);container.style.cursor=cursor;if(editor.getShape(ownerId)){editor.setCamera(camera);editor.select(ownerId);}};
 },[editor,ownerId]);
 return createPortal(<div data-cover-picker-ui role="dialog" aria-label="从画布选择封面图片" style={{position:'fixed',top:20,left:'50%',transform:'translateX(-50%)',zIndex:100000,background:'var(--ff-control)',color:'white',border:'1px solid var(--ff-text-3)',borderRadius:12,padding:'14px 20px',boxShadow:'0 8px 35px #0008',maxWidth:'85vw'}} onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}><strong>{working?'正在引用图片…':'请直接点击画布上的一张图片'}</strong><p style={{margin:'6px 0',fontSize:13}}>可以缩放、平移寻找图片；选完自动回到封面。不会移动或删除原图片。</p><button type="button" disabled={working} onClick={onClose}>取消（Esc）</button>{error&&<p role="alert" style={{color:'var(--ff-bad)'}}>{error}</p>}</div>,editor.getContainer());
}
