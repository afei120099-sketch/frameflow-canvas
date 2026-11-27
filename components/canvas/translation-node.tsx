"use client";
import {deleteCanvasNodes} from './safe-delete-action';
import { useEffect, useRef, useState } from 'react';
import { BaseBoxShapeUtil, HTMLContainer, T, createShapeId, type Editor, type TLBaseShape } from 'tldraw';
import { translateText, type TranslationDirection } from '@/lib/translation';
type Props={w:number;h:number;input:string;output:string;direction:string};
type TranslationNode=TLBaseShape<'translation-node',Props>;
declare module 'tldraw' { interface TLGlobalShapePropsMap { 'translation-node':Props } }
export function createTranslationNode(editor:Editor,point:{x:number;y:number}){const id=createShapeId();editor.createShape({id,type:'translation-node',x:point.x,y:point.y});editor.select(id);editor.setCurrentTool('select');return id;}
export class TranslationNodeUtil extends BaseBoxShapeUtil<TranslationNode>{
  static override type='translation-node' as const;
  static override props={w:T.number,h:T.number,input:T.string,output:T.string,direction:T.string};
  override getDefaultProps():Props{return {w:480,h:510,input:'',output:'',direction:'zh-en'};}
  override canResize(){return false;}
  override component(shape:TranslationNode){return <TranslationContent shape={shape} editor={this.editor}/>;}
  override getIndicatorPath(shape:TranslationNode){const path=new Path2D();path.rect(0,0,shape.props.w,shape.props.h);return path;}
}
function TranslationContent({shape,editor}:{shape:TranslationNode;editor:Editor}){
  const [consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[status,setStatus]=useState('就绪');
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const patch=(props:Partial<Props>)=>editor.updateShape({id:shape.id,type:'translation-node',props});
  const change=(props:Partial<Props>)=>{controller.current?.abort();controller.current=null;setBusy(false);setStatus('就绪');patch(props);};
  const translate=async()=>{
    if(!consent||busy)return;
    const current=new AbortController();controller.current=current;setBusy(true);setStatus('翻译中…');
    const timer=setTimeout(()=>current.abort(),60000);
    try{const result=await translateText(shape.props.input,shape.props.direction as TranslationDirection,{signal:current.signal});
      if(current.signal.aborted||controller.current!==current||!editor.getShape(shape.id))return;
      const decoder=document.createElement('textarea');decoder.innerHTML=result;patch({output:decoder.value});setStatus('翻译完成');
    }catch(cause){if(controller.current===current)setStatus(current.signal.aborted?'已取消或超时，请重试':cause instanceof Error?cause.message:'翻译失败');}
    finally{clearTimeout(timer);if(controller.current===current){controller.current=null;setBusy(false);}}
  };
  const area={width:'100%',height:140,resize:'none' as const,background:'var(--ff-canvas)',color:'var(--ff-text)',border:'1px solid var(--ff-border-strong)',borderRadius:10,padding:12,fontSize:14,boxSizing:'border-box' as const};
  return <HTMLContainer style={{width:shape.props.w,height:shape.props.h,pointerEvents:'all',background:'var(--ff-raised)',color:'var(--ff-text)',border:'1px solid var(--ff-border-strong)',borderRadius:16,padding:18,boxSizing:'border-box'}}>
    <div style={{display:'flex',justifyContent:'space-between',marginBottom:14}}><strong>中英互译</strong><button type="button" aria-label="删除翻译节点" onPointerDown={e=>e.stopPropagation()} onClick={()=>deleteCanvasNodes(editor,[shape.id])}>×</button></div>
    <div onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
      <select aria-label="翻译方向" value={shape.props.direction} onChange={e=>change({direction:e.target.value})} style={{marginBottom:10}}><option value="zh-en">中文 → 英文</option><option value="en-zh">英文 → 中文</option></select>
      <textarea aria-label="翻译原文" placeholder="输入或粘贴需要翻译的文字…" style={area} value={shape.props.input} onChange={e=>change({input:e.target.value})}/>
      <div style={{fontSize:12,margin:'10px 0'}}><label><input type="checkbox" checked={consent} onChange={e=>{setConsent(e.target.checked);if(!e.target.checked){controller.current?.abort();}}}/> 同意将文字发送至 MyMemory 在线翻译（有免费额度限制）</label></div>
      <textarea aria-label="翻译结果" readOnly placeholder="译文显示在这里，原文不会被覆盖" style={area} value={shape.props.output}/>
      <div style={{display:'flex',gap:10,marginTop:12}}><button type="button" disabled={!consent||busy||!shape.props.input.trim()} onClick={()=>void translate()}>{busy?'翻译中…':'开始翻译'}</button><button type="button" disabled={!shape.props.output} onClick={()=>void navigator.clipboard.writeText(shape.props.output).then(()=>setStatus('译文已复制')).catch(()=>setStatus('复制失败，请手动选中译文复制'))}>复制译文</button><button type="button" disabled={busy||!shape.props.output} onClick={()=>change({input:shape.props.output,output:shape.props.input,direction:shape.props.direction==='zh-en'?'en-zh':'zh-en'})}>反向翻译</button></div>
      <div role="status" style={{fontSize:12,color:'var(--ff-text-2)',marginTop:12}}>{status}</div>
    </div>
  </HTMLContainer>;
}
