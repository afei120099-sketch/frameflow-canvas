"use client";
import {CulledShape} from "./culled-shape";
import {useAcquiredMediaUrl} from "./media-hooks";
import { useEffect, useRef, useState } from 'react';
import { BaseBoxShapeUtil, HTMLContainer, T, createShapeId, useValue, type Editor, type TLBaseShape } from 'tldraw';
import { Mic2, Sparkles, X } from 'lucide-react';
import { waitForCosyVoice } from '@/lib/comfyui/cosyvoice';
import { runVoiceDesign, waitForVoiceDesign } from '@/lib/voice-design';
import { registerAsset } from '@/lib/production-records';
import { storeLocalAudio, storeLocalImage } from '@/lib/local-video-store';
import { downloadSavedMedia } from '@/lib/media-download';
import { RoleLibrary } from '@/components/role-library';
import { VoiceRoleDialog } from './voice-role-dialog';
import { showCanvasToast } from './canvas-events';
import {deleteCanvasNodes} from './safe-delete-action';
import {holdNodeTask} from '@/lib/node-task-activity';

type Take={voiceDescription?:string;src:string;assetId:string;name:string;duration:number;promptId:string;text:string;seed:number};
type Props={voiceDescription?:string;auditionText?:string;auditionCount?:number;pendingDesignId?:string;followRoleVoice?:boolean;voiceMode?:string;presetGender?:string;w:number;h:number;text:string;instruction:string;speed:number;seed:string;referenceSrc:string;referenceName:string;referenceRoleId:string;src:string;assetId:string;name:string;duration:number;pendingId:string;lastSeed:number;stage:string;takes:Take[]};
export type TTSNode=TLBaseShape<'tts-node',Props>;
declare module 'tldraw' { interface TLGlobalShapePropsMap { 'tts-node':Props } }
const active=new Set<string>();
const takeValidator=T.object({voiceDescription:T.optional(T.string),src:T.string,assetId:T.string,name:T.string,duration:T.number,promptId:T.string,text:T.string,seed:T.number});
const AUDITION_TEXT='你好，别担心，先把事情慢慢说清楚。我会认真听，也会陪你一起想办法。';
function VoiceAuditionCard({take,index,current,active,disabled,onChoose}:{take:Take;index:number;current:boolean;active:boolean;disabled:boolean;onChoose:()=>void}){
  const src=useAcquiredMediaUrl(take.src,active);
  return <div style={{padding:10,border:current?'2px solid var(--ff-text-3)':'1px solid var(--ff-border-strong)',borderRadius:8}}><strong>试听候选 {index+1} · {take.duration.toFixed(1)}秒</strong><audio aria-label={`试听候选${index+1}`} controls preload="none" src={src||undefined}/><button type="button" aria-pressed={current} disabled={disabled} onClick={onChoose}>{current?'已选中试听候选':'选中试听候选'} {index+1}</button></div>;
}
const AUDIO_NODE_W=330,AUDIO_NODE_H=155,AUDIO_NODE_GAP=20;
/** Put each freshly generated take on the right of the TTS node, stacked downwards. Takes already on the canvas are skipped. */
function placeGeneratedAudioNodes(editor:Editor,source:TTSNode,takes:readonly Take[]){
  const x=source.x+source.props.w+100;
  const placed=editor.getCurrentPageShapes().filter(s=>s.type==='audio-node').map(s=>({assetId:(s.props as {assetId?:string}).assetId,x:s.x,y:s.y,h:(s.props as {h?:number}).h??AUDIO_NODE_H}));
  for(const take of takes){
    if(placed.some(item=>item.assetId===take.assetId))continue;
    let y=source.y;
    while(placed.some(item=>Math.abs(item.x-x)<8&&y<item.y+item.h+AUDIO_NODE_GAP&&item.y<y+AUDIO_NODE_H+AUDIO_NODE_GAP))y+=AUDIO_NODE_H+AUDIO_NODE_GAP;
    const id=createShapeId();
    editor.createShape({id,type:'audio-node',x,y,props:{w:AUDIO_NODE_W,h:AUDIO_NODE_H,src:take.src,name:take.name,duration:take.duration,assetId:take.assetId}});
    placed.push({assetId:take.assetId,x,y,h:AUDIO_NODE_H});
  }
}
export function createTTSNode(editor:Editor,point:{x:number;y:number}=editor.getViewportPageBounds().center) {
  const id=createShapeId();editor.createShape({id,type:'tts-node',x:point.x-240,y:point.y-160});editor.select(id);editor.setCurrentTool('select');return id;
}
export class TTSNodeUtil extends BaseBoxShapeUtil<TTSNode> {
  static override type='tts-node' as const;
  static override props={voiceDescription:T.optional(T.string),auditionText:T.optional(T.string),auditionCount:T.optional(T.number),pendingDesignId:T.optional(T.string),followRoleVoice:T.optional(T.boolean),voiceMode:T.optional(T.string),presetGender:T.optional(T.string),w:T.number,h:T.number,text:T.string,instruction:T.string,speed:T.number,seed:T.string,referenceSrc:T.string,referenceName:T.string,referenceRoleId:T.string,src:T.string,assetId:T.string,name:T.string,duration:T.number,pendingId:T.string,lastSeed:T.number,stage:T.string,takes:T.arrayOf(takeValidator)};
  // Legacy fields remain readable so saved nodes and their audio are never discarded.
  override getDefaultProps():Props{return {voiceMode:'design',presetGender:'female',w:480,h:650,text:'',instruction:'',speed:1,seed:'',referenceSrc:'',referenceName:'',referenceRoleId:'',src:'',assetId:'',name:'',duration:0,pendingId:'',lastSeed:0,stage:'就绪',takes:[]};}
  override canResize(){return false;}
  override component(shape:TTSNode){return <CulledShape editor={this.editor} shapeId={shape.id}><TTSContent shape={shape} editor={this.editor}/></CulledShape>;}
  override getIndicatorPath(shape:TTSNode){const p=new Path2D();p.rect(0,0,shape.props.w,shape.props.h);return p;}
}
function TTSContent({shape,editor}:{shape:TTSNode;editor:Editor}) {
  const [error,setError]=useState(''),[busy,setBusy]=useState(active.has(shape.id));
  const [rolePicker,setRolePicker]=useState(false),[roleInfo,setRoleInfo]=useState('');
  const controller=useRef<AbortController|null>(null);
  const selected=useValue('配音节点选择',()=>editor.getOnlySelectedShapeId()===shape.id,[editor,shape.id]);
  const locked=busy||!!shape.props.pendingId||!!shape.props.pendingDesignId;
  const patch=(props:Partial<Props>)=>{if(editor.getShape(shape.id))editor.updateShape({id:shape.id,type:'tts-node',props});};
  useEffect(()=>()=>controller.current?.abort(),[]);
  const resultUrl=useAcquiredMediaUrl(shape.props.src,selected);
  const generate=async()=>{
    if(active.has(shape.id))return;
    const ownerPageId=editor.getCurrentPageId();
    // Query-only compatibility for a legacy accepted task. Never submit another CosyVoice job.
    const recovery=!!shape.props.pendingId;
    const designRecovery=!!shape.props.pendingDesignId;
    if(recovery&&designRecovery){setError('存在两条未确认任务，请先核对原任务；不会重新提交');return;}
    const seed=recovery||designRecovery?shape.props.lastSeed:shape.props.seed.trim()?Number(shape.props.seed):crypto.getRandomValues(new Uint32Array(1))[0]%2147483645;
    const text=recovery?shape.props.text:shape.props.auditionText??AUDITION_TEXT;
    const current=new AbortController();controller.current=current;const releaseDeletion=holdNodeTask(shape.id);
    active.add(shape.id);setBusy(true);setError('');
    const freshTakes:Take[]=[];
    try {
      const options={signal:current.signal,onStage:(stage:string)=>patch({stage}),onRejected:()=>patch(recovery?{pendingId:''}:{pendingDesignId:''})};
      const designOptions={...options,onPending:(pendingDesignId:string)=>patch({pendingDesignId,lastSeed:seed,voiceMode:'design'})};
      const resultList: {blob:Blob;filename:string;promptId:string;seed?:number;voiceDescription?:string}[]=recovery
        ?[await waitForCosyVoice(shape.props.pendingId,options)]
        :designRecovery?await waitForVoiceDesign(shape.props.pendingDesignId!,designOptions)
        :await runVoiceDesign({text,description:shape.props.voiceDescription??'',count:shape.props.auditionCount??3,seed},designOptions);
      for(const result of resultList){
        if(!editor.getShape(shape.id))return;
        const duration=await new Promise<number>((resolve,reject)=>{
          const player=new Audio();const src=URL.createObjectURL(result.blob);
          const finish=(value?:number)=>{clearTimeout(timer);player.removeAttribute('src');player.load();URL.revokeObjectURL(src);if(value&&Number.isFinite(value))resolve(value);else reject(new Error('无法解析配音时长，请查询原任务重取结果'));};
          const timer=setTimeout(()=>finish(),15000);player.onloadedmetadata=()=>finish(player.duration);player.onerror=()=>finish();player.src=src;
        });
        const src=await storeLocalAudio(result.blob,result.filename);
        const asset=await registerAsset({kind:'audio',origin:'generated',filename:result.filename,mimeType:result.blob.type||'audio/wav',storageReference:src,sourceRunId:null,fileSize:result.blob.size,duration,canvasPageIds:[ownerPageId]});
        const currentShape=editor.getShape(shape.id) as TTSNode|undefined;
        if(!currentShape)return;
        const take:Take={...(result.voiceDescription?{voiceDescription:result.voiceDescription}:{}),src,assetId:asset.assetId,name:result.filename,duration,promptId:result.promptId,text,seed:result.seed??seed};
        const isNewTake=!currentShape.props.takes.some(t=>t.name===take.name);
        if(isNewTake)freshTakes.push(take);
        patch({src,assetId:asset.assetId,name:result.filename,duration,stage:'试听已完成，选中喜欢的声音后保存为角色主声音',takes:isNewTake?[...currentShape.props.takes,take]:currentShape.props.takes});
      }
      patch(recovery?{pendingId:''}:{pendingDesignId:''});
      const latest=editor.getShape(shape.id) as TTSNode|undefined;
      if(latest&&freshTakes.length)placeGeneratedAudioNodes(editor,latest,freshTakes);
    }catch(cause){
      const message=current.signal.aborted?'已暂停查询，后台任务不会重提；点击查询原任务取回结果':cause instanceof Error?cause.message:'配音失败';
      setError(message);patch({stage:message});
    }finally{releaseDeletion();active.delete(shape.id);setBusy(false);if(controller.current===current)controller.current=null;}
  };
  const placeAudio=()=>{
    const existing=editor.getCurrentPageShapes().find(s=>s.type==='audio-node'&&(s.props as {assetId?:string}).assetId===shape.props.assetId);
    if(existing){editor.select(existing.id);editor.zoomToSelection();return;}
    const id=createShapeId();editor.createShape({id,type:'audio-node',x:shape.x+shape.props.w+100,y:shape.y,props:{w:330,h:155,src:shape.props.src,name:shape.props.name,duration:shape.props.duration,assetId:shape.props.assetId}});editor.select(id);
  };
  const stopEvent=(event:{stopPropagation:()=>void})=>event.stopPropagation();
  const interaction={onPointerDown:stopEvent,onPointerUp:stopEvent,onKeyDown:stopEvent,onWheel:stopEvent,onContextMenu:stopEvent};
  return <HTMLContainer className="tts-canvas-node" style={{width:shape.props.w,height:shape.props.h,pointerEvents:'all'}}>
    <header><span className="tts-heading"><span className="tts-icon"><Mic2 size={20}/></span><span><strong>AI 音色设计</strong><small>文字定义声音 · 试听选角</small></span></span><button type="button" disabled={locked} aria-label="删除配音节点" onPointerDown={stopEvent} onClick={()=>deleteCanvasNodes(editor,[shape.id])}><X size={16}/></button></header>
    <div className="tts-controls" {...interaction}>
      <div className="tts-intro"><Sparkles size={17}/><span>描述你想要的声音，听见角色的第一句话。<small>无需参考录音 · 本机 Qwen3-TTS · 候选由你选定</small></span></div>
      <label>角色音色描述<textarea aria-label="角色音色描述" disabled={locked} value={shape.props.voiceDescription??''} placeholder="例如：25岁女性，温柔清澈的中音，普通话自然亲近，带一点克制的关心。" onChange={e=>patch({voiceDescription:e.target.value})}/></label>
      <label>试听台词 <span className="tts-count">{(shape.props.auditionText??AUDITION_TEXT).length}/300</span><textarea aria-label="音色试听台词" disabled={locked} maxLength={300} value={shape.props.auditionText??AUDITION_TEXT} onChange={e=>patch({auditionText:e.target.value})}/></label>
      <div className="tts-fields"><label>试听候选数<select aria-label="音色试听候选数" disabled={locked} value={shape.props.auditionCount??3} onChange={e=>patch({auditionCount:Number(e.target.value)})}><option value={1}>1条</option><option value={2}>2条</option><option value={3}>3条 · 依次生成</option></select></label><label>随机种子<input aria-label="配音种子" disabled={locked} value={shape.props.seed} placeholder="留空随机" onChange={e=>patch({seed:e.target.value})}/></label></div>
      {shape.props.src&&<section className="tts-result"><strong>试听与历史声音 <small>选中后再保存，不会自动采用</small></strong>
        {shape.props.takes.filter(t=>t.voiceDescription).map((take,index)=><VoiceAuditionCard key={take.src} take={take} index={index} current={shape.props.src===take.src} active={selected} disabled={locked} onChoose={()=>patch({src:take.src,assetId:take.assetId,name:take.name,duration:take.duration})}/>)}
        {shape.props.takes.length>1&&<select aria-label="配音版本" disabled={locked} value={shape.props.src} onChange={e=>{const take=shape.props.takes.find(t=>t.src===e.target.value);if(take)patch({src:take.src,assetId:take.assetId,name:take.name,duration:take.duration});}}>{shape.props.takes.map((take,i)=><option key={take.src} value={take.src}>版本 {i+1} · {take.duration.toFixed(1)} 秒</option>)}</select>}
        <audio aria-label="生成配音试听" controls preload="metadata" src={resultUrl||undefined}/>
        <div className="tts-actions"><button type="button" disabled={locked} onClick={()=>setRolePicker(true)}>选中声音保存为角色主声音</button><button type="button" onClick={placeAudio}>放为声音节点</button><button type="button" onClick={()=>void downloadSavedMedia(shape.props.src,shape.props.name,'audio').catch(cause=>showCanvasToast(String(cause)))}>下载</button></div>
      </section>}
    </div>
    <footer className="tts-footer" {...interaction}>
      <div role="status" className="tts-status">{busy?<span className="tts-working"/>:<span className="tts-ready"/>}{shape.props.stage}</div>
      {error&&<p role="alert" className="role-error">{error}</p>}
      <div className="tts-actions"><button type="button" className="ff-primary tts-generate" disabled={busy||(!shape.props.pendingId&&!shape.props.pendingDesignId&&(!(shape.props.voiceDescription??'').trim()||!(shape.props.auditionText??AUDITION_TEXT).trim()))} onClick={()=>void generate()}><Sparkles size={16}/>{busy?'正在准备试听…':shape.props.pendingDesignId?'查询原试听任务':shape.props.pendingId?'查询原任务':'生成AI试听候选'}</button>{busy&&<button type="button" onClick={()=>controller.current?.abort()}>暂停查询</button>}</div>
      {!busy&&shape.props.pendingDesignId&&shape.props.stage.includes('未找到原试听任务')&&<button type="button" onClick={()=>{patch({pendingDesignId:'',stage:'已清除失效试听记录，请手动重新生成'});setError('');}}>清除失效试听记录</button>}
      {!busy&&shape.props.pendingId&&shape.props.stage.includes('不在队列或历史中')&&<button type="button" onClick={()=>{patch({pendingId:'',stage:'原任务记录已清除，可以重新生成'});setError('');}}>清除失效任务记录</button>}
    </footer>
    {rolePicker&&<VoiceRoleDialog assetId={shape.props.assetId} defaultPrimary={true} onClose={()=>setRolePicker(false)} onSaved={id=>{setRolePicker(false);setRoleInfo(id);patch({voiceMode:'design',stage:'已保存为角色主声音，可在视频节点中使用该角色声音'});showCanvasToast('已保存角色主声音');}}/>}
    {roleInfo&&<RoleLibrary initialRoleId={roleInfo} onClose={()=>setRoleInfo('')} onUpload={async(kind,file)=>{
      if(kind==='image'&&!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('请选择 JPG、PNG 或 WEBP 图片');
      if(kind==='audio'&&!file.type.startsWith('audio/')&&!/\.(wav|mp3|m4a|flac|ogg)$/i.test(file.name))throw new Error('请选择声音文件');
      const src=kind==='image'?await storeLocalImage(file,file.name):await storeLocalAudio(file,file.name);
      return registerAsset({kind,origin:'imported',filename:file.name,mimeType:file.type||(kind==='image'?'image/png':'audio/wav'),storageReference:src,sourceRunId:null,fileSize:file.size});
    }}/>}
    <style>{ttsStyles}</style>
  </HTMLContainer>;
}
const ttsStyles=`
.tts-canvas-node{box-sizing:border-box;display:flex;flex-direction:column;background:var(--ff-raised);border:1px solid var(--ff-border-strong);border-radius:18px;color:var(--ff-text);overflow:hidden;box-shadow:0 12px 36px #0003}
.tts-canvas-node>header{flex:none;display:flex;align-items:center;justify-content:space-between;padding:17px 20px;border-bottom:1px solid #ffffff12;background:linear-gradient(115deg,var(--ff-hover),var(--ff-control))}
.tts-heading{display:flex;gap:12px;align-items:center}.tts-heading>span:last-child{display:grid;gap:4px}.tts-heading strong{font-size:17px}.tts-heading small{font-size:11px;color:var(--ff-text-2)}.tts-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:rgba(255,255,255,0.13);color:var(--ff-text-2)}
.tts-controls{flex:1;min-height:0;padding:18px 20px;display:flex;flex-direction:column;gap:15px;overflow:auto;box-sizing:border-box;scrollbar-width:thin;scrollbar-color:var(--ff-border-hover) transparent}
.tts-intro{display:flex;gap:9px;align-items:flex-start;color:var(--ff-text);font-size:12px;line-height:1.6}.tts-intro svg{flex:none;margin-top:2px}.tts-intro small{display:block;color:var(--ff-text-2);font-size:11px}
.tts-controls label{display:flex;position:relative;flex-direction:column;gap:8px;font-size:12px;font-weight:500}.tts-count{position:absolute;right:0;font-size:11px;color:var(--ff-text-2);font-weight:400}
.tts-controls input,.tts-controls select,.tts-controls textarea{box-sizing:border-box;width:100%;background:var(--ff-surface);border:1px solid var(--ff-border-strong);border-radius:10px;padding:11px 12px;color:var(--ff-text);font:inherit;font-weight:400;min-width:0;outline:none}
.tts-controls :is(input,select,textarea):focus{border-color:var(--ff-text-3);box-shadow:0 0 0 2px rgba(255,255,255,0.13)}.tts-controls textarea{height:94px;min-height:65px;resize:vertical;line-height:1.65}.tts-controls textarea::placeholder,.tts-controls input::placeholder{color:var(--ff-text-3)}.tts-controls audio{width:100%;height:36px;margin-top:7px}
.tts-controls small,.tts-status{font-size:11px;color:var(--ff-text-2);overflow-wrap:anywhere}.tts-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.tts-actions{display:flex;gap:8px;flex-wrap:wrap}
.tts-canvas-node button{background:var(--ff-hover);color:var(--ff-text);border:1px solid rgba(88,88,88,0.33);border-radius:9px;padding:9px 12px;cursor:pointer;font-size:12px}.tts-canvas-node button:disabled{opacity:.45;cursor:default}.tts-canvas-node button:focus-visible{outline:2px solid var(--ff-white);outline-offset:2px}.tts-canvas-node>header button{padding:8px;display:grid;place-items:center;background:transparent}
.tts-result{display:grid;gap:10px;padding-top:16px;border-top:1px solid #ffffff16}.tts-result>strong small{display:block;margin-top:5px;font-weight:400}
.tts-footer{flex:none;padding:13px 20px 17px;border-top:1px solid #ffffff14;background:var(--ff-control);display:grid;gap:10px}.tts-status{display:flex;align-items:center;gap:7px;line-height:1.5;max-height:48px;overflow:auto}.tts-ready,.tts-working{display:inline-block;flex:none;width:6px;height:6px;border-radius:50%;background:#b0b0b0}.tts-working{background:var(--ff-run)}.tts-footer .role-error{margin:0;font-size:12px;line-height:1.5;max-height:56px;overflow:auto}.tts-footer .tts-generate{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;min-height:42px;background:var(--ff-white);color:var(--ff-ink);font-weight:600;font-size:13px}
`;
