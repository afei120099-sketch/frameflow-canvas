"use client";
import { useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";
import { useValue,type Editor,type TLShape,type TLContent } from "tldraw";
import { TOOLKIT_EVENT,PROMPT_LIBRARY_KEY,NODE_TEMPLATES_KEY,BUILTIN_SNIPPETS,insertSnippet,cleanTemplateContent,promotionSnapshot,promotedNodeProps,type PromptSnippet } from "@/lib/canvas-toolkit";
import { getMeta,putMeta,listAssets,getAsset,getAssetBySource,getRun,listRuns,createRun,updateRun,addRunToShot,adoptShotAsset,getShotAssetVersions,type AssetRecord } from "@/lib/production-records";
import { candidateRunInput } from "@/lib/generation-batch";
import { waitForCanvasSave } from "@/lib/canvas-library";
import { withLock,claimNode,createRunExclusively } from "@/lib/run-recovery";
import { comfyUIH3Adapter } from "@/lib/comfyui/h3-adapter";
import { auditAsset,auditKey,type AutomaticAudit } from "@/lib/automatic-audit";
import { useAcquiredMediaUrl } from "./media-hooks";
import { showCanvasToast } from "./canvas-events";
import { MediaAuditPanel } from "@/components/media-audit-panel";
import { askConfirm } from "@/components/in-page-dialog";
type NodeTemplate={id:string;name:string;content:TLContent;assetIds:string[];roleIds:string[]};
type ToolsAction="compare"|"promote"|"audit"|"templates"|"save-template"|"prompts";
export function openCanvasTools(action:ToolsAction,assetIds?:string[]){window.dispatchEvent(new CustomEvent(TOOLKIT_EVENT,{detail:{action,assetIds}}));}
export function AuditBadge({assetId}:{assetId?:string}){
 const [result,setResult]=useState<AutomaticAudit|null>(null);
 useEffect(()=>{let live=true;const read=()=>{if(assetId)void getMeta<AutomaticAudit>(auditKey(assetId)).then(r=>{if(live)setResult(r);});};read();window.addEventListener("frameflow-audit-changed",read);return()=>{live=false;window.removeEventListener("frameflow-audit-changed",read);};},[assetId]);
 if(!assetId)return null;
 const state=result?.assetId===assetId?result.state:"unknown";
 return <button type="button" title={[...(result?.errors??[]),...(result?.warnings??[])].join("\n")} style={{color:state==="failed"?"var(--ff-bad)":state==="warning"?"var(--ff-warn)":state==="pass"?"var(--ff-ok)":"var(--ff-text-2)"}} onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();openCanvasTools("audit",[assetId]);}}>{state==="failed"?"质检不合格":state==="warning"?"质检需确认":state==="pass"?"质检通过":"待质检"}</button>;
}
function CompareVideo({asset,index,audible,register}:{asset:AssetRecord;index:number;audible:number;register:(index:number,video:HTMLVideoElement|null)=>void}){
 const url=useAcquiredMediaUrl(asset.storageReference,true);
 return <video ref={v=>register(index,v)} src={url||undefined} muted={index!==audible} playsInline preload="metadata" style={{width:"100%",maxHeight:"43vh",background:"var(--ff-bg)"}}/>;
}
export function CanvasTools({editor,resolveSource,persistenceKey}:{editor:Editor;persistenceKey:string;resolveSource:(shape:TLShape)=>Promise<{asset:AssetRecord;duration:number}>}){
 const [mode,setMode]=useState<ToolsAction|null>(null),[assets,setAssets]=useState<AssetRecord[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const [snippets,setSnippets]=useState<PromptSnippet[]>([]),[templates,setTemplates]=useState<NodeTemplate[]>([]),[query,setQuery]=useState("");
 const [name,setName]=useState(""),[category,setCategory]=useState("自定义"),[text,setText]=useState(""),[editId,setEditId]=useState("");
 const [compared,setCompared]=useState<string[]>([]),[audible,setAudible]=useState(0),[seconds,setSeconds]=useState(0),[playing,setPlaying]=useState(false);
 const [reports,setReports]=useState<Record<string,AutomaticAudit>>({});
 const target=useRef<{field:HTMLTextAreaElement;start:number;end:number}|null>(null),players=useRef<Record<number,HTMLVideoElement|null>>({});
 const pageId=useValue("toolkit page",()=>editor.getCurrentPageId(),[editor]);
 useEffect(()=>{queueMicrotask(()=>{setMode(null);setPlaying(false);});},[pageId]);
 useEffect(()=>{
  let live=true;const seen=new Set<string>();let timer:ReturnType<typeof setTimeout>|undefined,pending=false;
  const tick=async()=>{
   if(!live||pending)return;pending=true;timer=undefined;
   try{
    const key="automatic-audit-enabled-since-v1";let since=await getMeta<number>(key);if(!since){since=Date.now();await putMeta(key,since);}
    const referenced=new Set<string>();
    for(const shape of editor.getCurrentPageShapes()){
     const props=shape.props as {src?:unknown;inheritedVideo?:{src?:string};extensionSourceVideo?:{src?:string};referenceVideos?:{src?:string}[]};
     if(typeof props.src==="string")referenced.add(props.src);
     if(props.inheritedVideo?.src)referenced.add(props.inheritedVideo.src);
     if(props.extensionSourceVideo?.src)referenced.add(props.extensionSourceVideo.src);
     for(const item of props.referenceVideos??[])if(item?.src)referenced.add(item.src);
    }
    for(const asset of await listAssets("video")){
     if(!live||seen.has(asset.assetId)||asset.createdAt<since||asset.origin!=="generated"||!referenced.has(asset.storageReference))continue;
     seen.add(asset.assetId);await auditAsset(asset);
    }
   }catch{/* Manual check stays available if background scan cannot read. */}
   finally{pending=false;if(live)timer=setTimeout(()=>void tick(),document.hidden?60000:30000);}
  };
  const onVisibility=()=>{if(pending||!live)return;if(timer!==undefined)clearTimeout(timer);timer=setTimeout(()=>void tick(),document.hidden?60000:30000);};
  document.addEventListener("visibilitychange",onVisibility);
  void tick();return()=>{live=false;if(timer!==undefined)clearTimeout(timer);document.removeEventListener("visibilitychange",onVisibility);};
 },[editor]);
 useEffect(()=>{
  const focus=(e:FocusEvent)=>{const field=e.target;if(field instanceof HTMLTextAreaElement&&!field.readOnly&&!field.disabled&&!field.closest(".canvas-toolkit"))target.current={field,start:field.selectionStart,end:field.selectionEnd};};
  const remember=()=>{const field=document.activeElement;if(field instanceof HTMLTextAreaElement&&!field.readOnly&&!field.closest(".canvas-toolkit"))target.current={field,start:field.selectionStart,end:field.selectionEnd};};
  const open=async(e:Event)=>{
   remember();Object.values(players.current).forEach(v=>v?.pause());setPlaying(false);
   const detail=(e as CustomEvent<{action:ToolsAction;assetIds?:string[]}>).detail;
   setMode(detail.action);setError("");setQuery("");setEditId("");setName("");setText("");
   try{
    setSnippets(await getMeta<PromptSnippet[]>(PROMPT_LIBRARY_KEY)??[]);setTemplates(await getMeta<NodeTemplate[]>(NODE_TEMPLATES_KEY)??[]);
    let selected=detail.assetIds?await Promise.all(detail.assetIds.map(getAsset)):await Promise.all(editor.getSelectedShapes().filter(s=>["h3-node","video-node","audio-video-node"].includes(s.type)).map(async s=>(await resolveSource(s)).asset));
    if(detail.action==="compare"&&selected.length===1&&selected[0]?.shotId)selected=await getShotAssetVersions(selected[0].shotId);
    const videos=[...new Map(selected.filter((a):a is AssetRecord=>!!a&&a.kind==="video").map(a=>[a.assetId,a])).values()];
    setAssets(videos);setCompared(videos.slice(0,4).map(a=>a.assetId));setSeconds(0);setAudible(0);
    const values=await Promise.all(videos.map(async a=>[a.assetId,await getMeta<AutomaticAudit>(auditKey(a.assetId))] as const));
    setReports(Object.fromEntries(values.filter((v):v is readonly [string,AutomaticAudit]=>!!v[1])));
   }catch(e){setError(e instanceof Error?e.message:String(e));}
  };
  document.addEventListener("focusin",focus);document.addEventListener("selectionchange",remember);window.addEventListener(TOOLKIT_EVENT,open);
  return()=>{document.removeEventListener("focusin",focus);document.removeEventListener("selectionchange",remember);window.removeEventListener(TOOLKIT_EVENT,open);Object.values(players.current).forEach(v=>v?.pause());};
 },[editor,resolveSource]);
 useEffect(()=>{
  if(!playing)return;
  const timer=setInterval(()=>{
   const items=Object.values(players.current).filter((v):v is HTMLVideoElement=>!!v),master=items[0];if(!master)return;
   if(items.some(v=>v.ended)||items.some(v=>v.readyState<3)){items.forEach(v=>v.pause());setPlaying(false);return;}
   for(const v of items.slice(1))if(Math.abs(v.currentTime-master.currentTime)>.12)v.currentTime=master.currentTime;
   setSeconds(master.currentTime);
  },150);return()=>clearInterval(timer);
 },[playing,compared]);
 const act=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError("");try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 const saveSnippet=()=>act(async()=>{if(!name.trim()||!text.trim())throw Error("请填写名称和内容");const next=[...snippets.filter(s=>s.id!==editId),{id:editId||crypto.randomUUID(),name:name.trim(),category:category.trim()||"自定义",text}];await putMeta(PROMPT_LIBRARY_KEY,next);setSnippets(next);setEditId("");setName("");setText("");});
 const insert=(snippet:PromptSnippet)=>{
  const saved=target.current,field=saved?.field;
  if(!saved||!field?.isConnected||field.readOnly||field.disabled){setError("请先点击画布中可编辑的提示词框，再打开模板库；只读生成信息不能插入。");return;}
  const next=insertSnippet(field.value,snippet.text,saved.start,saved.end);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(field,next);field.dispatchEvent(new Event("input",{bubbles:true}));
  setMode(null);field.focus();field.setSelectionRange(saved.start+snippet.text.length,saved.start+snippet.text.length);
 };
 const saveTemplate=()=>act(async()=>{
  if(!name.trim())throw Error("请给模板命名");
  const selected=editor.getSelectedShapes();if(!selected.length)throw Error("请先框选要保存的节点");
  if(selected.some(s=>Boolean(s.props&&("pendingId" in s.props)&&s.props.pendingId)))throw Error("请等待所选节点生成完成");
  const content=editor.getContentFromCurrentPage(editor.getSelectedShapeIds());if(!content)throw Error("没有可保存内容");
  const cleaned=cleanTemplateContent(content),assetIds:string[]=[],roleIds:string[]=[];
  const references=new Set<string>();
  const visit=(v:unknown)=>{if(typeof v==="string"&&/^(image|media|audio):/.test(v))references.add(v);else if(v&&typeof v==="object")Object.values(v).forEach(visit);};
  visit(cleaned);
  for(const source of references){const asset=await getAssetBySource(source);if(!asset)throw Error("模板含未登记的素材，请先完成素材登记");assetIds.push(asset.assetId);}
  for(const shape of cleaned.shapes){const p=shape.props as Record<string,unknown>;if(typeof p.assetId==="string"&&p.assetId)assetIds.push(p.assetId);if(Array.isArray(p.roleIds))roleIds.push(...p.roleIds as string[]);}
  const template={id:crypto.randomUUID(),name:name.trim(),content:cleaned,assetIds:[...new Set(assetIds)],roleIds:[...new Set(roleIds)]};
  const next=[...templates,template];await putMeta(NODE_TEMPLATES_KEY,next);setTemplates(next);setMode("templates");setName("");
 });
 const reuse=(template:NodeTemplate)=>act(async()=>{
  for(const id of template.assetIds)if(!await getAsset(id))throw Error("模板素材缺失："+id);
  const roles=await import("@/lib/role-records");for(const id of template.roleIds)if(!await roles.getRole(id))throw Error("模板角色缺失："+id);
  editor.putContentOntoCurrentPage(structuredClone(template.content),{point:editor.getViewportPageBounds().center,select:true});setMode(null);showCanvasToast("模板已创建；不会自动提交生成");
 });
 const promote=(choices:AssetRecord[])=>act(async()=>{
  if(!choices.length)throw Error("请选择极速版候选");
  if(!await askConfirm("保留所选试片的实际输入、seed、比例、音色和像素预算，切换终极版重新生成。动作与声音可能变化；原试片保留，正式片不自动采用。确认提交？"))return;
  const plans=await Promise.all(choices.map(async asset=>{if(!asset.sourceRunId)throw Error("候选没有生成记录");const run=await getRun(asset.sourceRunId);if(!run||!run.shotId)throw Error("找不到候选镜头生成记录");for(const id of run.inputAssetIds)if(!await getAsset(id))throw Error("试片素材已缺失："+id);return {run,snapshot:await promotionSnapshot(run),props:promotedNodeProps(run)};}));
  if(new Set(plans.map(p=>p.run.ownerNodeId)).size!==plans.length)throw Error("同一镜头请只选一个试片候选，再执行转正");
  for(const {run,snapshot,props} of plans){
   if(editor.getCurrentPageId()!==pageId)throw Error("画布已切换，停止后续提交");
   if(!run.ownerNodeId||!editor.getCurrentPageShapes().some(s=>s.id===run.ownerNodeId&&s.type==="h3-node"))throw Error("原视频节点不在当前画布；请先找回原节点");
   const release=claimNode(run.ownerNodeId);if(!release)throw Error("该节点正在提交，请稍后再试");
   try{await withLock("frameflow-promote:"+run.ownerNodeId,async()=>{
    if((await listRuns()).some(r=>r.ownerNodeId===run.ownerNodeId&&["queued","running"].includes(r.status)))throw Error("原节点仍有任务，请先等待完成");
    const next=await createRunExclusively(run.ownerNodeId!,listRuns,()=>createRun({...candidateRunInput(run,run.seed!,{id:crypto.randomUUID(),index:1,count:1}),parameters:{...run.parameters,workflowOptionId:"community-ultimate",steps:10,loraStrength:.75,promotedFromRunId:run.runId,productionStage:"final",generationBatch:undefined},workflowIdentity:{...run.workflowIdentity,templateFile:"experimental/h3-community-ultimate.json",templateVersion:"promotion-v1:"+snapshot.digest}},{reservePromptId:true}));
    await updateRun(next.runId,{submissionSnapshot:snapshot});
    await addRunToShot(run.shotId!,next.runId);
    const node=editor.getShape(run.ownerNodeId as TLShape["id"]);
    if(!node||node.type!=="h3-node")throw Error("原视频节点已移除");
    editor.markHistoryStoppingPoint("before promoting draft");
    editor.run(()=>{
      // Freeze former connected inputs into the chosen candidate's local references.
      const arrows=editor.getBindingsToShape(node.id,"arrow").filter(b=>b.props.terminal==="end").map(b=>b.fromId);
      editor.deleteShapes([...new Set(arrows)]);
      editor.updateShape({id:node.id,type:"h3-node",props,meta:{...node.meta,toolkitRecovery:true}});
    });
    try{await waitForCanvasSave(persistenceKey,new Map([[node.id,editor.getShape(node.id)]]));}
    catch(e){await updateRun(next.runId,{status:"failed",error:"画布保存失败，未提交转正",completedAt:Date.now()});throw e;}
    try{const job=await comfyUIH3Adapter.submit({capability:"comfyui-h3",inputs:{workflow:snapshot.graph,promptId:next.runId}});await updateRun(next.runId,{comfyPromptId:job.jobId,submission:"accepted"});}
    catch(e){const uncertain=!(e instanceof Error&&(e.name==="SubmissionNotSentError"||e.message.includes("节点校验")||e.message.includes("HTTP 400")));if(!uncertain)await updateRun(next.runId,{status:"failed",error:e instanceof Error?e.message:String(e),completedAt:Date.now()});throw e;}
   });}finally{release();}
  }
  showCanvasToast("正式片已排队；原试片保留，完成后进入同一镜头候选");setMode(null);
 });
 const inspect=(choices:AssetRecord[])=>act(async()=>{for(const asset of choices){const report=await auditAsset(asset,true);setReports(r=>({...r,[asset.assetId]:report}));}});
 const shown=assets.filter(a=>compared.includes(a.assetId));
 const close=()=>{if(busy)return;Object.values(players.current).forEach(v=>v?.pause());setPlaying(false);setMode(null);};
 if(!mode)return null;
 return createPortal(<div className="canvas-toolkit-backdrop" onPointerDown={e=>{e.stopPropagation();if(e.target===e.currentTarget)close();}}><section className="canvas-toolkit" role="dialog" aria-modal="true" aria-label="画布制作工具" onKeyDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
 <header><h2>{{compare:"候选并排对比",promote:"试片转正",audit:"成片质检",templates:"节点模板库","save-template":"保存选中节点为模板",prompts:"提示词模板库"}[mode]}</h2><button disabled={busy} onClick={close}>关闭</button></header>
 {error&&<p role="alert" style={{color:"var(--ff-bad)"}}>{error}</p>}
 {(mode==="prompts"||mode==="templates")&&<input aria-label="搜索模板" placeholder="搜索名称、分类或内容" value={query} onChange={e=>setQuery(e.target.value)}/>}
 {mode==="prompts"&&<><p className="ff-hint">内置句是起始示例，未替你验证具体镜头效果。插入只修改当前提示词；不会自动生成。</p>{[...BUILTIN_SNIPPETS,...snippets].filter(s=>(s.name+s.category+s.text).toLowerCase().includes(query.toLowerCase())).map(s=><article key={s.id}><b>{s.category} · {s.name}</b><pre>{s.text}</pre><button onClick={()=>insert(s)}>插入光标位置</button><button onClick={()=>{setName(s.name);setCategory(s.category);setText(s.text);setEditId(s.id.startsWith("builtin:")?"":s.id);}}>编辑{ s.id.startsWith("builtin:")?"为副本":""}</button>{!s.id.startsWith("builtin:")&&<button onClick={()=>void act(async()=>{const next=snippets.filter(v=>v.id!==s.id);await putMeta(PROMPT_LIBRARY_KEY,next);setSnippets(next);})}>删除</button>}</article>)}<h3>{editId?"编辑段落":"保存自定义段落"}</h3><input placeholder="名称" value={name} onChange={e=>setName(e.target.value)}/><input placeholder="分类" value={category} onChange={e=>setCategory(e.target.value)}/><textarea rows={5} value={text} onChange={e=>setText(e.target.value)} placeholder="粘贴验证过的固定段落"/><button disabled={busy} onClick={saveSnippet}>保存段落</button></>}
 {mode==="save-template"&&<><p className="ff-hint">保存节点、内部连线、参数与素材引用；不保存任务状态，不自动生成。复用时重新生成节点ID。跨项目素材需随项目备份迁移。</p><input placeholder="例如：开场、对白、飞起" value={name} onChange={e=>setName(e.target.value)}/><button disabled={busy} onClick={saveTemplate}>保存模板</button></>}
 {mode==="templates"&&<><p>模板和提示词库包含在项目备份的元数据中。</p>{templates.filter(t=>t.name.includes(query)).map(t=><article key={t.id}><b>{t.name} · {t.content.shapes.length} 个节点</b><button disabled={busy} onClick={()=>void reuse(t)}>在当前画布复用</button><button disabled={busy} onClick={()=>void act(async()=>{const next=templates.filter(x=>x.id!==t.id);await putMeta(NODE_TEMPLATES_KEY,next);setTemplates(next);})}>删除模板</button></article>)}</>}
 {(mode==="compare"||mode==="promote")&&<><p className="ff-hint">最多同时播放4个候选；只开启一路声音。不同长度播放到最短片结束；浏览器同步不等于逐帧锁定。</p><div>{assets.map(a=><label key={a.assetId}><input type="checkbox" checked={compared.includes(a.assetId)} onChange={e=>{setPlaying(false);Object.values(players.current).forEach(v=>v?.pause());setCompared(ids=>e.target.checked?(ids.length<4?[...ids,a.assetId]:ids):ids.filter(id=>id!==a.assetId));}}/>{a.filename}</label>)}</div><div className="compare-grid">{shown.map((a,i)=><article key={a.assetId}><CompareVideo asset={a} index={i} audible={audible} register={(index,v)=>{players.current[index]=v;}}/><b>{a.filename}</b><AuditBadge assetId={a.assetId}/><button onClick={()=>setAudible(i)}>{i===audible?"正在听此路":"听此路声音"}</button><button disabled={busy||!a.shotId} onClick={()=>void act(async()=>{await adoptShotAsset(a.shotId!,a.assetId);window.dispatchEvent(new CustomEvent("frameflow-shot-changed",{detail:{shotId:a.shotId}}));showCanvasToast("已采用此版本");})}>★ 采用</button></article>)}</div><button onClick={()=>void act(async()=>{const items=shown.map((_,i)=>players.current[i]).filter((v):v is HTMLVideoElement=>!!v);if(playing){items.forEach(v=>v.pause());setPlaying(false);}else{for(const v of items)v.currentTime=seconds;try{await Promise.all(items.map(v=>v.play()));setPlaying(true);}catch(e){items.forEach(v=>v.pause());throw e;}}})}>{playing?"同步暂停":"同步播放"}</button><input aria-label="同步定位秒数" type="number" min="0" step=".1" value={seconds} onChange={e=>{const t=Math.max(0,Number(e.target.value));setSeconds(t);shown.forEach((_,i)=>{const v=players.current[i];if(v)v.currentTime=Math.min(t,Number.isFinite(v.duration)?v.duration:t);});}}/><button disabled={busy||!shown.length} onClick={()=>void promote(shown)}>选中候选 → 终极版正式片</button></>}
 {mode==="audit"&&<><p className="ff-hint">自动检查新生成视频；红色为明确异常，橙色为疑似黑帧／静止，灰色为未检查或检查失败。不检测 BGM，不自动重渲。静态镜头和淡入淡出需人工确认。</p><button disabled={busy||!assets.length} onClick={()=>void inspect(assets)}>{busy?"CPU检查中…":"检查／重新检查所选视频"}</button>{!assets.length&&<p>请先选中画布视频再从右键打开质检。</p>}{assets.map(a=><article key={a.assetId}><b>{a.filename}</b><AuditBadge assetId={a.assetId}/>{reports[a.assetId]&&<><p>{[...reports[a.assetId].errors,...reports[a.assetId].warnings].join("；")||"技术检查通过；不代表画面语义或表演质量通过"}</p><details><summary>检查数据与时间段</summary><pre>{JSON.stringify({...reports[a.assetId],report:{...reports[a.assetId].report,samples:undefined}},null,2)}</pre>{reports[a.assetId].report?.samples.map(s=><img key={s.time} src={s.image} alt={s.time+"秒"} style={{width:160}}/>)}</details></>}<details><summary>人工复查与抽帧报告</summary><MediaAuditPanel asset={a}/></details></article>)}</>}
 <style>{`.canvas-toolkit-backdrop{position:fixed;inset:0;z-index:1500;background:#000a;display:grid;place-items:center}.canvas-toolkit{width:min(1300px,94vw);max-height:90vh;overflow:auto;background:var(--ff-control);color:#eee;padding:22px;border:1px solid var(--ff-border-hover);border-radius:18px}.canvas-toolkit header{display:flex;justify-content:space-between;align-items:center}.canvas-toolkit button,.canvas-toolkit input,.canvas-toolkit textarea{background:var(--ff-control);color:#eee;border:1px solid var(--ff-border-hover);border-radius:7px;padding:9px;margin:5px}.canvas-toolkit textarea{display:block;width:95%}.canvas-toolkit article{padding:12px;border:1px solid var(--ff-border-strong);border-radius:10px;margin:10px 0}.canvas-toolkit pre{white-space:pre-wrap;overflow-wrap:anywhere}.canvas-toolkit label{display:inline-flex;max-width:95%;word-break:break-all;align-items:center}.compare-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}.compare-grid article{min-width:0}.compare-grid b{display:block;overflow-wrap:anywhere}`}</style>
 </section></div>,document.body);
}

