"use client";

import { runRegisteredProcessing, runSerialProcessing } from "@/lib/postprocess-queue";
import { nightAttempts, runNightAttempts } from "@/lib/night-postprocess";
import { COMFYUI_PROXY_PATH } from "@/lib/comfyui/config";
import { resolveCandidatePreview } from "@/lib/candidate-preview";
import { getAsset, getShot, getShotAssetVersions } from "@/lib/production-records";
import { batchOutputPosition } from "@/lib/batch-output-layout";
import { Plus } from "lucide-react";
import { Editor, type TLShape, useValue } from "tldraw";
import { useEffect, useRef, useState } from "react";
import { showCanvasToast } from "@/components/canvas/canvas-events";
import { askConfirm } from "@/components/in-page-dialog";
import { type H3Node, type ImageNode, type VideoNode, createSmoothNode, createUpscaleNode, processingVideoFromH3, runPortAction, selectedReferenceImages, shotName, stopPropagation } from "@/components/canvas/workspace-shared";

const BATCH_ADOPTED_ONLY_KEY='ff-batch-adopted-only-v1';

export function BatchVideoActions({editor}:{editor:Editor}){
  const [busy,setBusy]=useState(false),[stage,setStage]=useState(''),[progress,setProgress]=useState({done:0,total:0});
  const [upscaleMode,setUpscaleMode]=useState<'whole'|'segmented'>('whole');
  const [upscaleProfile,setUpscaleProfile]=useState<'safe'|'quality'|null>(null);
  const [nightMode,setNightMode]=useState(false);
  const [adoptedOnly,setAdoptedOnly]=useState<boolean>(()=>{
    try{const saved=typeof localStorage!=='undefined'?localStorage.getItem(BATCH_ADOPTED_ONLY_KEY):null;return saved===null?true:saved==='1'||saved==='true';}catch{return true;}
  });
  const [skippedItems,setSkippedItems]=useState<{id:TLShape['id'];title:string}[]>([]);
  const stop=useRef(false),active=useRef(false),captured=useRef<TLShape['id'][]>([]);
  useEffect(()=>()=>{stop.current=true;},[]);
  const selection=useValue('video batch selection',()=>editor.getSelectedShapes().filter(s=>s.type==='video-node'&&!!s.props.src||s.type==='h3-node'&&!!s.props.shotId).map(s=>s.id),[editor]);
  const start=async(kind:'upscale'|'smooth'|'upscale-60')=>{
    if(kind!=='smooth'&&!upscaleProfile){setStage('请先选择 SeedVR2 档位，再开始批量高清处理');return;}
    const batchProfile=upscaleProfile;
    const batchNight=nightMode;
    const batchMode=upscaleMode;
    const batchAdoptedOnly=adoptedOnly;
    if(active.current)return;active.current=true;stop.current=false;setBusy(true);setSkippedItems([]);
    const ids=captured.current.length?[...captured.current]:[...selection];captured.current=[];
    const sources:VideoNode[]=[];
    const originalBySource=new Map<string,TLShape['id']>();
    try{
      // Resolve all selected previews before creating or submitting processing tasks.
      const resolved=await Promise.all(ids.map(async id=>{
        const shape=editor.getShape(id);if(!shape)throw Error('选中视频已删除');
        if(shape.type==='video-node')return {skipped:false as const,video:structuredClone(shape as VideoNode),asset:null,shape,title:shape.props.name||'视频'};
        const h3=shape as H3Node;
        const [shot,versions]=await Promise.all([getShot(h3.props.shotId!),getShotAssetVersions(h3.props.shotId!)]);
        const title=h3.props.shotTitle?.trim()||shot?.title?.trim()||(shot?shotName(shot):h3.id);
        if(batchAdoptedOnly){
          const adoptedId=shot?.adoptedAssetId;
          const adoptedAsset=adoptedId?(versions.find(v=>v.assetId===adoptedId)??await getAsset(adoptedId).then(a=>a&&a.kind==='video'&&!a.recycled?a:null)):null;
          if(!adoptedAsset)return {skipped:true as const,video:null,asset:null,shape:h3,title};
          return {skipped:false as const,video:processingVideoFromH3(h3,adoptedAsset),asset:adoptedAsset,shape:h3,title};
        }
        const asset=resolveCandidatePreview(versions,[h3.props.previewAssetId,shot?.adoptedAssetId]);
        if(!asset)throw Error('选中的镜头还没有视频，请先生成或选择候选');
        return {skipped:false as const,video:processingVideoFromH3(h3,asset),asset,shape:h3,title};
      }));
      const skipped:{id:TLShape['id'];title:string}[]=[];
      const seen=new Set<string>();
      for(const item of resolved){
        if(item.skipped){skipped.push({id:item.shape.id,title:item.title});continue;}
        const video=item.video;
        if(!video)throw Error('无法定位处理视频');
        if(!seen.has(video.props.src)){seen.add(video.props.src);sources.push(structuredClone(video));originalBySource.set(video.id,item.shape.id);}
      }
      setSkippedItems(skipped);
      if(!sources.length){
        const message=skipped.length?`共 ${ids.length} 条，全部 ${skipped.length} 条未采用，已跳过：${skipped.map(s=>s.title).join('、')}`:'没有可处理的视频';
        setStage(message);showCanvasToast(message);return;
      }
      const actionLabel=kind==='upscale-60'?'批量1080P＋60 FPS':kind==='upscale'?'批量排队高清':'批量排队插帧';
      const skipText=skipped.length?`\n跳过 ${skipped.length} 条（未采用，已跳过）：${skipped.map(s=>s.title).join('、')}`:'\n跳过 0 条';
      const confirmed=await askConfirm(`${actionLabel}：共 ${ids.length} 条，将处理 ${sources.length} 条（${batchAdoptedOnly?'只处理★已采用版本':'按当前显示版本'}）。${skipText}\n确认开始吗？`);
      if(!confirmed){
        setStage(skipped.length?`已取消（${skipped.length} 条未采用，已跳过）`:'已取消批量处理');
        return;
      }
      setProgress({done:0,total:sources.length});setStage('等待ComfyUI空闲，逐条处理');
      const result=await runSerialProcessing(sources,async(source,index)=>{
        while(!stop.current){
          const response=await fetch(COMFYUI_PROXY_PATH+'/queue',{signal:AbortSignal.timeout(8000)});
          if(!response.ok)throw Error('无法读取ComfyUI队列，已停止后续处理');
          const q=await response.json() as {queue_running?:unknown[];queue_pending?:unknown[]};
          if(!Array.isArray(q.queue_running)||!Array.isArray(q.queue_pending))throw Error('队列状态无效');
          if(!q.queue_running.length&&!q.queue_pending.length)break;
          setStage('第'+(index+1)+'条：等待现有任务完成');await new Promise(resolve=>setTimeout(resolve,3000));
        }
        if(stop.current)return 'cancelled';
        const current=editor.getShape(source.id) as VideoNode|H3Node|undefined;
        if(!current || (current.type!=='video-node' && current.type!=='h3-node') || current.type==='video-node'&&current.props.src!==source.props.src || current.type==='h3-node'&&current.props.shotId!==source.props.shotId)throw Error('原视频已删除或更换，已停止排队');
        if(current.type==='h3-node'){
          const input=source.props.assetId?await getAsset(source.props.assetId):null;
          if(!input || input.kind!=='video' || input.storageReference!==source.props.src)throw Error('批量选中的原视频版本已失效，已停止排队');
        }
        const originalId=originalBySource.get(source.id)??source.id;
        const originalBounds=editor.getShapePageBounds(originalId);
        if(!originalBounds)throw Error('无法读取原视频位置，已停止排队');
        const priorChain=editor.getCurrentPageShapes().filter(shape=>shape.meta.batchOutputFor===originalId || shape.meta.batchOutputAnchorId===originalId&&shape.meta.batchVerticalLayout===true).flatMap(shape=>{const box=editor.getShapePageBounds(shape);return box?[{x:box.x,y:box.y,w:box.w,h:box.h}]:[];});
        const point=batchOutputPosition(originalBounds,{w:350,h:kind==='smooth'?264:310},priorChain);
        const node=kind==='smooth'?createSmoothNode(editor,point,current):createUpscaleNode(editor,point,current,kind==='upscale-60'?"1080p":"2x",kind==='upscale-60');
        if(!node)throw Error('无法创建处理节点');
        editor.updateShape({id:node.id,type:node.type,meta:{...node.meta,batchOutputAnchorId:originalId,batchVerticalLayout:true,...(source.props.assetId?{batchInputAssetId:source.props.assetId,batchInputSource:source.props.src}:{}),batchOutputAnchor:{x:originalBounds.x,y:originalBounds.y,w:originalBounds.w,h:originalBounds.h}}});
        if(kind!=='smooth')editor.updateShape({id:node.id,type:'upscale-node',props:{upscaleProfile:batchProfile!,clipMode:batchMode},meta:{...editor.getShape(node.id)!.meta,batchRequestedRangeMode:batchMode}});
        editor.select(node.id);editor.zoomToSelection();
        setStage('第'+(index+1)+'/'+sources.length+'条：'+(kind==='upscale-60'?`1080P＋60 FPS · ${batchMode==='segmented'?'分段':'整段'}（整条完成后处理下一条）`:kind==='upscale'?(batchMode==='segmented'?'2×分段高清':'2×整段高清'):'60 FPS插帧'));
        const status=batchNight&&kind!=='smooth'?await runNightAttempts(nightAttempts(batchProfile!,batchMode==='segmented'),async(attempt,attemptIndex)=>{
          if(attemptIndex){
            while(!stop.current){
              const response=await fetch(COMFYUI_PROXY_PATH+'/queue',{signal:AbortSignal.timeout(8000),cache:'no-store'});
              if(!response.ok)throw Error('降档前无法确认队列状态，停止而不重提');
              const queue=await response.json() as {queue_running?:unknown[];queue_pending?:unknown[]};
              if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending))throw Error('降档前队列状态无效');
              if(!queue.queue_running.length&&!queue.queue_pending.length)break;
              setStage('等待队列空闲后降档');await new Promise(resolve=>setTimeout(resolve,3000));
            }
          }
          if(stop.current)return 'cancelled';
          const live=editor.getShape(node.id);if(!live||live.type!=='upscale-node')return 'cancelled';
          const record={attempt:attemptIndex+1,label:attempt.label,at:Date.now()};
          const attempts=Array.isArray(live.meta.nightAttempts)?live.meta.nightAttempts:[];
          editor.updateShape({id:live.id,type:'upscale-node',props:{upscaleProfile:attempt.profile,clipMode:attempt.segmented?'segmented':'whole'},meta:{...live.meta,nightMode:true,nightAttemptLabel:attempt.label,nightAttempts:[...attempts,record],nightSegmentSeconds:attempt.segmentSeconds??0}});
          setStage('第'+(index+1)+'条：'+attempt.label);
          await new Promise(resolve=>setTimeout(resolve,100));
          return runRegisteredProcessing(node.id,()=>stop.current);
        },()=>stop.current):await runRegisteredProcessing(node.id,()=>stop.current);
        if(status==='completed'||batchNight&&status==='failed')setProgress({done:index+1,total:sources.length});
        if(batchNight&&status==='failed'){const live=editor.getShape(node.id);if(live)editor.updateShape({id:live.id,type:live.type,meta:{...live.meta,nightFailed:true,nightAttemptLabel:'多次尝试失败，已跳过；原视频保留'}});}
        return status;
      },()=>stop.current,()=>{},{continueOnFailure:batchNight});
      setStage(result.status==='completed'?'批量处理结束：成功'+result.completed+'条，失败跳过'+(result.failed??0)+'条'+(skipped.length?'，未采用已跳过'+skipped.length+'条':''):'已停止：完成'+result.completed+'条，'+(result.status==='uncertain'?'任务状态待确认，不重复提交':result.status==='failed'?'当前任务失败':'停止后续任务'));
    }catch(cause){const message=cause instanceof Error?cause.message:'批量处理失败';setStage(message);showCanvasToast(message);}
    finally{active.current=false;setBusy(false);}
  };
  // Single-video actions live on the node; keep only active batch progress visible.
  if(selection.length<2&&!busy)return null;
  return <div className="batch-video-actions" data-testid="batch-video-actions" onPointerDownCapture={event=>{event.stopPropagation();editor.markEventAsHandled(event);captured.current=[...selection];}} onPointerUp={stopPropagation} onClick={stopPropagation}>
    <b>{busy?progress.done+'/'+progress.total+'条已处理':'选中'+selection.length+'个视频'}</b>
    <select aria-label="批量高清处理方式" value={upscaleMode} disabled={busy} onChange={event=>setUpscaleMode(event.target.value as 'whole'|'segmented')}><option value="segmented">分段高清 · 降低内存峰值</option><option value="whole">整段高清</option></select>
    <fieldset className="batch-upscale-profile" aria-label="批量 SeedVR2 档位" disabled={busy}><legend>SeedVR2 档位</legend><button type="button" aria-pressed={upscaleProfile==='safe'} onClick={()=>setUpscaleProfile('safe')}>16G 安全 · 9帧分块</button><button type="button" aria-pressed={upscaleProfile==='quality'} onClick={()=>setUpscaleProfile('quality')}>画质实验 · 21帧＋重叠</button></fieldset>
    <label title="勾上后每个 H3 镜头只处理★已采用版本，没有采用版的镜头跳过并标出；取消勾选则按当前显示版本处理"><input type="checkbox" checked={adoptedOnly} disabled={busy} onChange={e=>{const next=e.target.checked;setAdoptedOnly(next);try{localStorage.setItem(BATCH_ADOPTED_ONLY_KEY,next?'1':'0');}catch{}}}/>只处理★已采用版本</label>
    <label><input type="checkbox" checked={nightMode} disabled={busy} onChange={e=>setNightMode(e.target.checked)}/>夜间容错：{upscaleMode==='segmented'?'分段所选档→分段安全档→更小分段→失败跳过':'整段所选档→整段安全档→分段安全档→失败跳过'}</label>
    <button type="button" disabled={busy||!selection.length||!upscaleProfile} title="先选档位；2×高清，逐条执行；原视频保留，不自动降低分辨率" onClick={()=>void start('upscale')}>批量排队高清</button>
    <button type="button" disabled={busy||!selection.length} title="增强至60 FPS，逐条执行；原视频保留" onClick={()=>void start('smooth')}>批量排队插帧</button>
    <button type="button" disabled={busy||!selection.length||!upscaleProfile} title="先选档位；每条先提升至1080P再插帧至60 FPS，完整处理一条后再处理下一条；只显示最终视频，原视频保留" onClick={()=>void start('upscale-60')}>批量1080P＋60 FPS</button>
    {busy?<button type="button" onClick={()=>{stop.current=true;setStage('当前已提交任务保留，停止后续排队');}}>停止后续</button>:(stage||skippedItems.length>0)&&<button type="button" onClick={()=>{setStage('');setSkippedItems([]);}}>收起状态</button>}
    {skippedItems.length>0&&<small data-testid="batch-skipped-unadopted">未采用，已跳过（{skippedItems.length}条）：{skippedItems.map(item=>`${item.title}（未采用，已跳过）`).join('、')}</small>}
    {stage&&<small>{stage}</small>}<small>{!upscaleProfile?'批量高清请先选择上面的 SeedVR2 档位；单独插帧无需选择。':'本批次高清使用你选择的 SeedVR2 档位。'} 点击批量按钮先确认条数再排队；原视频保留，请保持页面打开。刷新不会自动续跑。</small>
  </div>;
}

export function BatchReferenceAction({ editor }: { editor: Editor }) {
  const [creating, setCreating] = useState(false);
  const captured = useRef<ImageNode["id"][]>([]);
  const selection = useValue("batch image reference action", () => {
    const images = selectedReferenceImages(editor);
    if (images.length < 2) return null;
    const bounds = images.map(image => editor.getShapePageBounds(image)).filter(bound => bound !== undefined);
    if (!bounds.length) return null;
    const viewport = editor.getViewportScreenBounds();
    const screen = editor.pageToScreen({ x: Math.max(...bounds.map(bound => bound.maxX)), y: (Math.min(...bounds.map(bound => bound.minY)) + Math.max(...bounds.map(bound => bound.maxY))) / 2 });
    return { ids: images.map(image => image.id), left: Math.max(8, Math.min(screen.x - viewport.x + 14, viewport.w - 170)), top: Math.max(8, Math.min(screen.y - viewport.y - 20, viewport.h - 48)) };
  }, [editor]);
  if (!selection) return null;
  return <button type="button" className="batch-reference-action" data-testid="batch-reference-action" style={{ left: selection.left, top: selection.top }} disabled={creating}
    title="将所有选中图片加入同一个视频节点的参考，填写提示词后生成"
    onPointerDownCapture={event => { event.stopPropagation(); editor.markEventAsHandled(event); captured.current = [...selection.ids]; }}
    onClick={async event => {
      event.stopPropagation(); editor.markEventAsHandled(event);
      if (creating) return;
      const ids = captured.current.length ? [...captured.current] : [...selection.ids];
      captured.current = [];
      const source = ids.map(id => editor.getShape(id)).find((shape): shape is ImageNode => shape?.type === "image-node");
      if (!source) return;
      setCreating(true);
      try { await runPortAction(editor, source, undefined, undefined, ids); }
      catch (cause) { showCanvasToast(cause instanceof Error ? cause.message : "无法创建视频参考节点"); }
      finally { setCreating(false); }
    }}><Plus size={16} />{creating ? "正在加入…" : `${selection.ids.length}图生成视频`}</button>;
}
