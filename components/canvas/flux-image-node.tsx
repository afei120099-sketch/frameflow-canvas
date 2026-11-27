"use client";
import { CopyPromptButton } from "./copy-prompt-button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BaseBoxShapeUtil, HTMLContainer, T, createShapeId, useValue, type Editor, type TLBaseShape } from "tldraw";
import { buildFluxDev, runFluxDev, waitForFluxDev } from "@/lib/comfyui/flux-dev";
import { FluxMaskEditor } from "./flux-mask-editor";
import { CulledShape } from "./culled-shape";
import { useImageThumbnail } from "./use-image-thumbnail";
import { useAcquiredMediaUrl } from "./media-hooks";
import { storeLocalImage, getLocalImageBlob } from "@/lib/local-video-store";
import { registerAsset } from "@/lib/production-records";
import { imageNodeSize } from "@/lib/media-node-layout";
import { COMFYUI_PROXY_PATH } from "@/lib/comfyui/config";
import { Download, Expand, ImageIcon, X } from "lucide-react";
import { previewMedia, offerDeleteUndo } from "./interaction-ui";
import { deleteWithRestore } from "@/lib/canvas-delete-undo";
import {deleteCanvasNodes} from './safe-delete-action';
import {holdNodeTask} from '@/lib/node-task-activity';
import { downloadSavedMedia } from "@/lib/media-download";
import { showCanvasToast } from "./canvas-events";

type FluxCandidate = { src: string; assetId: string; filename: string; width: number; height: number; seed: number };
function candidateList(props: Props): FluxCandidate[] {
  const candidates = [...(props.candidates ?? [])];
  const [width, height] = props.size.split("x").map(Number);
  if (props.src && !candidates.some(c => c.src === props.src)) candidates.push({ src: props.src, assetId: props.assetId, filename: props.filename, width: props.resultWidth ?? width, height: props.resultHeight ?? height, seed: props.lastSeed });
  return candidates;
}

type Props = { extraLora?: boolean; fluxVersion?: string; guidance?: number; editMode?: string; maskSrc?: string; maskInputSrc?: string; maskGrow?: number; maskBlur?: number; w: number; h: number; prompt: string; size: string; seed: string; src: string; assetId: string; filename: string; pendingId: string; lastSeed: number; stage: string; resultWidth?: number; resultHeight?: number; steps?: number; cfg?: number; sampler?: string; scheduler?: string; denoise?: number; imageMode?: boolean; inputSrc?: string; inputName?: string; imageDenoise?: number; count?: number; candidates?: FluxCandidate[]; adoptedAssetId?: string };
export type FluxImageNode = TLBaseShape<"flux-image-node", Props>;
declare module "tldraw" { interface TLGlobalShapePropsMap { "flux-image-node": Props } }
const active = new Set<string>();
export function createFluxImageNode(editor: Editor, point?: { x: number; y: number }) {
  const center = point ?? editor.getViewportPageBounds().center;
  const id = createShapeId();
  editor.createShape({ id, type: "flux-image-node", x: center.x - 150, y: center.y - 225 });
  editor.select(id); editor.setCurrentTool("select");
  return id;
}
export class FluxImageNodeUtil extends BaseBoxShapeUtil<FluxImageNode> {
  static renderPort?: (editor: Editor, shape: FluxImageNode) => ReactNode;
  static incomingImage?: (editor: Editor, shape: FluxImageNode) => { src: string; name: string } | undefined;
  static override type = "flux-image-node" as const;
  static override props = { extraLora: T.optional(T.boolean), fluxVersion: T.optional(T.string), guidance: T.optional(T.number), editMode: T.optional(T.string), maskSrc: T.optional(T.string), maskInputSrc: T.optional(T.string), maskGrow: T.optional(T.number), maskBlur: T.optional(T.number), w: T.number, h: T.number, prompt: T.string, size: T.string, seed: T.string, src: T.string, assetId: T.string, filename: T.string, pendingId: T.string, lastSeed: T.number, stage: T.string, resultWidth: T.optional(T.number), resultHeight: T.optional(T.number), steps: T.optional(T.number), cfg: T.optional(T.number), sampler: T.optional(T.string), scheduler: T.optional(T.string), denoise: T.optional(T.number), imageMode: T.optional(T.boolean), inputSrc: T.optional(T.string), inputName: T.optional(T.string), imageDenoise: T.optional(T.number), count: T.optional(T.number), candidates: T.optional(T.arrayOf(T.object({ src: T.string, assetId: T.string, filename: T.string, width: T.number, height: T.number, seed: T.number }))), adoptedAssetId: T.optional(T.string) };
  override getDefaultProps(): Props { return { extraLora: true, w: 300, h: 450, prompt: "", size: "1024x1536", seed: "", src: "", assetId: "", filename: "", pendingId: "", lastSeed: 0, stage: "就绪", fluxVersion: "dev", steps: 24, guidance: 3.5, cfg: 1, sampler: "euler", scheduler: "simple", denoise: 1, imageDenoise: 0.8, editMode: "img2img", maskGrow: 8, maskBlur: 8 }; }
  override canResize() { return false; }
  override component(shape: FluxImageNode) { return <CulledShape editor={this.editor} shapeId={shape.id}><FluxNodeContent shape={shape} editor={this.editor} /></CulledShape>; }
  override getIndicatorPath(shape: FluxImageNode) { const p = new Path2D(); p.rect(0, 0, shape.props.w, shape.props.h); return p; }
}
function FluxCandidateCard({ candidate, label, selected, disabled, onChoose }: { candidate: FluxCandidate; label: string; selected: boolean; disabled: boolean; onChoose: () => void }) {
  const url = useImageThumbnail(candidate.src, 320).url;
  return <button type="button" disabled={disabled} aria-pressed={selected} onClick={onChoose}>{url && <img src={url} alt={label} decoding="async" draggable={false} />}<span>{label}</span><span title={candidate.filename}>{candidate.filename}</span></button>;
}
function FluxNodeContent({ shape, editor }: { shape: FluxImageNode; editor: Editor }) {
  const selected = useValue("Flux composer selection", () => editor.getOnlySelectedShapeId() === shape.id, [editor, shape.id]);
  const incoming = useValue("Flux input image", () => FluxImageNodeUtil.incomingImage?.(editor, shape), [editor, shape.id]);
  const imageMode = !!incoming || !!shape.props.imageMode;
  const inputSrc = incoming?.src ?? shape.props.inputSrc ?? "";
  const inputName = incoming?.name ?? shape.props.inputName ?? "原图";
  const inpaint = imageMode && shape.props.editMode === "inpaint";
  const maskValid = !!shape.props.maskSrc && shape.props.maskInputSrc === inputSrc;
  const devSteps = shape.props.fluxVersion === "dev" ? shape.props.steps ?? 24 : 24;
  const devDenoise = shape.props.fluxVersion === "dev" ? shape.props.imageDenoise ?? (inpaint ? 0.8 : 0.5) : 0.5;
  const [showMaskEditor, setShowMaskEditor] = useState(false);
  const fullInputUrl = useAcquiredMediaUrl(inputSrc, showMaskEditor);
  const maskUrl = useAcquiredMediaUrl(shape.props.maskSrc ?? "", showMaskEditor && maskValid);
  const inputUrl = useImageThumbnail(selected && inputSrc && !showMaskEditor ? inputSrc : "", 480).url;
  const fileInput = useRef<HTMLInputElement>(null);
  const url = useImageThumbnail(shape.props.src, 640).url;
  const [busy, setBusy] = useState(active.has(shape.id));
  const [error, setError] = useState("");
  const [showCandidates, setShowCandidates] = useState(false);
  const candidates = candidateList(shape.props);
  const chooseCandidate = (candidate: FluxCandidate) => update({ src: candidate.src, assetId: candidate.assetId, filename: candidate.filename, resultWidth: candidate.width, resultHeight: candidate.height, lastSeed: candidate.seed });
  const [samplers, setSamplers] = useState(["euler"]);
  const [schedulers, setSchedulers] = useState(["simple"]);
  const locked = busy || !!shape.props.pendingId;
  const [width, height] = shape.props.size.split("x").map(Number);
  const update = (patch: Partial<Props>) => { if (editor.getShape(shape.id)) editor.updateShape({ id: shape.id, type: "flux-image-node", props: { ...(shape.props.fluxVersion === "dev" ? {} : { fluxVersion: "dev", steps: 24, cfg: 1, guidance: 3.5, imageDenoise: 0.8, sampler: "euler", scheduler: "simple" }), ...patch } }); };
  useEffect(() => {
    // Reclaim only old automatically placed results with no connections. Manual images stay.
    const oldResults = editor.getCurrentPageShapes().filter(s => s.type === "image-node" && s.meta.fluxResultOf === shape.id && !editor.getBindingsToShape(s.id, "arrow").length);
    if (!oldResults.length) return;
    const list = candidateList(shape.props);
    for (const old of oldResults) {
      const p = old.props as { src: string; assetId?: string; name: string; naturalWidth?: number; naturalHeight?: number };
      if (!list.some(c => c.src === p.src)) list.unshift({ src: p.src, assetId: p.assetId ?? "", filename: p.name, width: p.naturalWidth ?? 1024, height: p.naturalHeight ?? 1536, seed: 0 });
    }
    update({ candidates: list });
    offerDeleteUndo(deleteWithRestore(editor, oldResults.map(s => s.id)));
  }, [editor, shape.id]);
  const chooseInput = async (file: File) => {
    if (locked) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setError("请选择 PNG、JPG 或 WEBP 图片"); return; }
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
      const fittedWidth = Math.max(256, Math.round(bitmap.width * scale / 16) * 16), fittedHeight = Math.max(256, Math.round(bitmap.height * scale / 16) * 16);
      bitmap.close();
      const src = await storeLocalImage(file, file.name);
      update({ imageMode: true, inputSrc: src, inputName: file.name, maskSrc: "", maskInputSrc: "", size: `${fittedWidth}x${fittedHeight}` });
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "原图导入失败"); }
  };
  useEffect(() => {
    // Old nodes included the expanded composer in their hit box. Keep the image centre.
    if (shape.props.w === 560 && shape.props.h === 890) editor.updateShape({ id: shape.id, type: "flux-image-node", x: shape.x + 130, props: { w: 300, h: 480 } });
  }, [editor, shape.id, shape.props.w, shape.props.h, shape.x]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    void fetch(`${COMFYUI_PROXY_PATH}/object_info/KSampler`).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(info => {
      if (!live) return;
      const inputs = (info as { KSampler?: { input?: { required?: { sampler_name?: string[][]; scheduler?: string[][] } } } }).KSampler?.input?.required;
      if (Array.isArray(inputs?.sampler_name?.[0])) setSamplers(inputs.sampler_name[0]);
      if (Array.isArray(inputs?.scheduler?.[0])) setSchedulers(inputs.scheduler[0]);
    }).catch(() => { /* Keep known defaults when ComfyUI is offline. */ });
    return () => { live = false; };
  }, [selected]);
  useEffect(() => {
    const mediaWidth = shape.props.resultWidth ?? width, mediaHeight = shape.props.resultHeight ?? height;
    if (!(mediaWidth > 0 && mediaHeight > 0) || shape.props.w === 560) return;
    const nextHeight = Math.round(300 * mediaHeight / mediaWidth);
    // Lift the header out without shifting existing images on the canvas.
    if (shape.props.h !== nextHeight) editor.updateShape({ id: shape.id, type: "flux-image-node", y: shape.props.h === nextHeight + 30 ? shape.y + 30 : shape.y, props: { h: nextHeight } });
  }, [shape.props.resultWidth, shape.props.resultHeight, shape.props.w, shape.props.h, width, height]);
  useEffect(() => { setBusy(active.has(shape.id)); }, [shape.id, shape.props.stage, shape.props.pendingId]);
  const generate = async (recover = false) => {
    if (active.has(shape.id)) return;
    const [width, height] = shape.props.size.split("x").map(Number);
    const seed = recover ? shape.props.lastSeed : shape.props.seed.trim() ? Number(shape.props.seed) : crypto.getRandomValues(new Uint32Array(1))[0];
    const count = recover ? 1 : shape.props.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 8) { setError("生成次数需为 1–8"); return; }
    if (!recover && imageMode && !inputSrc) { setError("请添加图生图原图，或从画布图片右侧加号拖线连接到此节点"); return; }
    if (!recover && inpaint && !maskValid) { setError("请先为当前原图绘制遮罩；更换原图后需重画"); return; }
    const input = { prompt: shape.props.prompt, width, height, seed, steps: devSteps, guidance: shape.props.guidance ?? 3.5, sampler: shape.props.sampler ?? "euler", scheduler: shape.props.scheduler ?? "simple", extraLora: shape.props.extraLora !== false, denoise: imageMode ? devDenoise : shape.props.denoise ?? 1, imageName: imageMode ? "pending-original.png" : undefined, maskName: inpaint ? "pending-mask.png" : undefined, maskGrow: shape.props.maskGrow ?? 8, maskBlur: shape.props.maskBlur ?? 8 };
    try { if (!recover) { buildFluxDev(input); if (shape.props.seed.trim()) buildFluxDev({ ...input, seed: seed + count - 1 }); } } catch (cause) { setError((cause as Error).message); return; }
    const releaseDeletion = holdNodeTask(shape.id); active.add(shape.id); setBusy(true); setError("");
    let completed = 0;
    try {
      const sourceImage = !recover && imageMode ? await getLocalImageBlob(inputSrc) : undefined;
      const maskImage = !recover && inpaint ? await getLocalImageBlob(shape.props.maskSrc!) : undefined;
      for (let index = 0; index < count; index++) {
      if (!editor.getShape(shape.id)) break;
      const nextSeed = index === 0 ? seed : shape.props.seed.trim() ? seed + index : crypto.getRandomValues(new Uint32Array(1))[0];
      const options = { onStage: (stage: string) => update({ stage: `${index + 1}/${count} · ${stage}` }), onSubmitted: (pendingId: string) => update({ pendingId, lastSeed: nextSeed }) };
      const result = recover ? await waitForFluxDev(shape.props.pendingId, nextSeed, options) : await runFluxDev({ ...input, seed: nextSeed }, { ...options, sourceImage, maskImage });
      const src = await storeLocalImage(result.image, result.filename);
      const asset = await registerAsset({ kind: "image", origin: "generated", filename: result.filename, mimeType: "image/png", storageReference: src, sourceRunId: null, width, height, fileSize: result.image.size });
      const current = editor.getShape(shape.id) as FluxImageNode | undefined;
      if (!current) break;
      const list = candidateList(current.props);
      list.push({ src, assetId: asset.assetId, filename: result.filename, width, height, seed: nextSeed });
      completed++;
      update({ src, assetId: asset.assetId, filename: result.filename, candidates: list, pendingId: "", lastSeed: nextSeed, stage: `生成完成 ${completed}/${count}`, resultWidth: width, resultHeight: height });
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); update({ stage: `已完成 ${completed}/${count}，其余未完成；不会自动重试`, ...((cause as Error).message.startsWith("Flux 生成失败") ? { pendingId: "" } : {}) }); }
    finally { releaseDeletion(); active.delete(shape.id); setBusy(false); }
  };
  const placeImage = () => {
    const [selectedWidth, selectedHeight] = shape.props.size.split("x").map(Number);
    const width = shape.props.resultWidth ?? selectedWidth, height = shape.props.resultHeight ?? selectedHeight;
    const dimensions = imageNodeSize(width, height);
    const id = createShapeId();
    editor.createShape({ id, type: "image-node", x: shape.x + shape.props.w + 40, y: shape.y, props: { ...dimensions, src: shape.props.src, assetId: shape.props.assetId, name: shape.props.filename, originalPath: shape.props.filename, naturalWidth: width, naturalHeight: height } });
    editor.select(id);
  };
  return <HTMLContainer className={`flux-canvas-node node-shell${selected ? " is-selected" : ""}`} style={{ width: shape.props.w, height: shape.props.h, pointerEvents: "all", overflow: "visible" }}>
    <style>{`.flux-canvas-node.node-shell{border:0;background:none;box-shadow:none;--node-accent:#858585}.flux-canvas-node.node-shell::before{display:none}.flux-media-header{position:absolute;left:0;right:0;top:-32px;height:26px;display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--ff-text-2);font-size:12px}.flux-media-title{display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap}.flux-media-actions{display:flex;align-items:center;gap:2px;opacity:0;pointer-events:none}.flux-canvas-node:hover .flux-media-actions,.flux-canvas-node.is-selected .flux-media-actions,.flux-canvas-node:focus-within .flux-media-actions{opacity:1;pointer-events:auto}.flux-canvas-node .flux-canvas-preview img,.flux-canvas-node .flux-empty-image{height:100%}.flux-media-actions button:disabled{opacity:.3;cursor:default}`}</style>
    <div className="flux-media-header">
      <span className="flux-media-title"><ImageIcon size={13} />Flux Dev · 图片</span>
      <div className="flux-media-actions" onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}>
        {candidates.length > 0 && <button type="button" className="node-header-button" aria-label={`查看图片候选 ${candidates.length}`} title="候选结果" onClick={e => { e.stopPropagation(); editor.select(shape.id); setShowCandidates(v => !v); }}>候选 {candidates.length}</button>}
        <button type="button" className="node-header-button" disabled={!shape.props.src} aria-label="查看图片大图" title="查看大图" onClick={e => { e.stopPropagation(); previewMedia(shape.props.src, "image", shape.props.filename || "Flux Dev 图片"); }}><Expand size={13} /></button>
        <button type="button" className="node-header-button" disabled={!shape.props.src} aria-label="下载生成图片" title="下载图片" onClick={e => { e.stopPropagation(); void downloadSavedMedia(shape.props.src, shape.props.filename || "Flux-Dev.png", "image").catch(cause => showCanvasToast(cause instanceof Error ? cause.message : "图片下载失败")); }}><Download size={13} /></button>
        <button type="button" className="node-header-button" disabled={locked} aria-label="删除文生图节点" title={locked ? "任务结束后可删除节点" : "删除节点或回收素材文件"} onClick={e => { e.stopPropagation(); deleteCanvasNodes(editor, [shape.id]); }}><X size={13} /></button>
      </div>
    </div>
    <div className="flux-canvas-preview">{url ? <img src={url} alt="Flux 生成结果" decoding="async" draggable={false} /> : <div className="flux-empty-image">{busy ? "正在生成图片…" : "填写下面的提示词生成图片"}</div>}</div>
    {shape.props.src ? FluxImageNodeUtil.renderPort?.(editor, shape) : <button className="workflow-port" type="button" disabled aria-label="生成图片后可连接视频" title="生成图片后可连接视频">+</button>}
    <section className="flux-canvas-composer" style={{ display: selected ? "block" : "none", top: shape.props.h + 12, left: (shape.props.w - 560) / 2 }} onPointerDown={e => { e.stopPropagation(); editor.select(shape.id); }} onKeyDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}>
      <header><b>{imageMode ? inpaint ? "局部重绘" : "图生图" : "文生图"}</b><span>Flux Dev · FP8 · {devSteps} 步</span></header>
      {candidates.length > 0 && <div className="flux-candidate-toolbar"><select aria-label="图片候选版本" disabled={locked} value={shape.props.src} onChange={e => { const candidate = candidates.find(c => c.src === e.target.value); if (candidate) chooseCandidate(candidate); }}>{candidates.map((c, i) => <option key={c.src} value={c.src}>候选 {i + 1}{c.assetId && c.assetId === shape.props.adoptedAssetId ? " · ★ 已采用" : ""}</option>)}</select><button type="button" disabled={locked || !shape.props.assetId || shape.props.assetId === shape.props.adoptedAssetId} onClick={() => update({ adoptedAssetId: shape.props.assetId })}>{shape.props.assetId === shape.props.adoptedAssetId ? "★ 已采用" : "☆ 采用此版本"}</button><button type="button" onClick={() => setShowCandidates(v => !v)}>候选 {candidates.length} · {showCandidates ? "收起" : "查看全部"}</button></div>}
      {showCandidates && <div className="flux-candidate-list">{candidates.map((c, i) => <FluxCandidateCard key={c.src} candidate={c} label={`候选 ${i + 1}${c.assetId && c.assetId === shape.props.adoptedAssetId ? " · ★ 已采用" : ""}`} selected={c.src === shape.props.src} disabled={locked} onChoose={() => chooseCandidate(c)} />)}</div>}
      {imageMode && <div className="flux-edit-mode"><label>修改方式 <select aria-label="Flux修改方式" disabled={locked} value={shape.props.editMode ?? "img2img"} onChange={e => update({ editMode: e.target.value })}><option value="img2img">整图修改</option><option value="inpaint">局部重绘</option></select></label><label>重绘强度 <input aria-label="重绘强度" type="number" min={0.01} max={1} step={0.01} value={devDenoise} disabled={locked} onChange={e => update({ imageDenoise: Number(e.target.value) })} /></label><small className="ff-hint">头发改色：0.40–0.55；换衣服：0.50–0.65。局部重绘只合回遮罩范围，生成效果仍需检查。</small></div>}
      <style>{`.flux-media-actions .node-header-button{width:auto;min-width:24px;white-space:nowrap}.flux-candidate-toolbar{display:flex;gap:6px;margin-bottom:12px;align-items:center}.flux-candidate-toolbar button{font-size:12px;padding:7px 9px}.flux-candidate-list{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-height:260px;overflow:auto;margin-bottom:14px}.flux-candidate-list button{display:flex;flex-direction:column;gap:5px;padding:8px;font-size:11px;background:var(--ff-hover)}.flux-candidate-list button[aria-pressed=true]{outline:2px solid var(--ff-text-3)}.flux-candidate-list img{width:100%;height:120px;object-fit:contain}`}</style>
      {imageMode && <div className="flux-input-slot" data-flux-input onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={e => { e.preventDefault(); e.stopPropagation(); const file = e.dataTransfer.files[0]; if (file) void chooseInput(file); }}>
        {inputUrl && <img src={inputUrl} alt="图生图原图" decoding="async" draggable={false} />}
        <span>{incoming ? "连线原图：" : inputSrc ? "原图：" : "拖入原图或连接画布图片"}{inputSrc ? inputName : ""}</span>
        {!incoming && <button type="button" disabled={locked} onClick={() => fileInput.current?.click()}>{inputSrc ? "更换原图" : "选择原图"}</button>}
        {!incoming && shape.props.src && <button type="button" disabled={locked} onClick={() => update({ inputSrc: shape.props.src, inputName: shape.props.filename, maskSrc: "", maskInputSrc: "" })}>用当前图片</button>}
        {inputSrc && <button type="button" disabled={locked} onClick={() => { if (incoming) { editor.deleteShapes(editor.getBindingsToShape(shape.id, "arrow").filter(b => b.props.terminal === "end").map(b => b.fromId)); } update({ inputSrc: "", inputName: "", maskSrc: "", maskInputSrc: "", imageMode: true }); }}>移除原图</button>}
      </div>}
      {inpaint && <div className="flux-mask-controls"><button type="button" disabled={locked || !inputSrc} onClick={() => setShowMaskEditor(true)}>{maskValid ? "修改遮罩" : "绘制遮罩"}</button><span>{maskValid ? "遮罩已绑定当前原图" : "请涂出要改的头发或衣服"}</span>{maskValid && <button type="button" disabled={locked} onClick={() => update({ maskSrc: "", maskInputSrc: "" })}>移除遮罩</button>}<label>范围扩展 <input aria-label="遮罩范围扩展" type="number" min={0} max={64} value={shape.props.maskGrow ?? 8} disabled={locked} onChange={e => update({ maskGrow: Number(e.target.value) })} /></label><label>边缘柔化 <input aria-label="遮罩边缘柔化" type="number" min={1} max={31} value={shape.props.maskBlur ?? 8} disabled={locked} onChange={e => update({ maskBlur: Number(e.target.value) })} /></label></div>}
      {showMaskEditor && fullInputUrl && <FluxMaskEditor imageUrl={fullInputUrl} maskUrl={maskValid && maskUrl ? maskUrl : undefined} onClose={() => setShowMaskEditor(false)} onSave={async blob => { const maskSrc = await storeLocalImage(blob, "Flux_Dev_mask.png"); update({ maskSrc, maskInputSrc: inputSrc }); }} />}
      <style>{`.flux-edit-mode{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}.flux-edit-mode label,.flux-mask-controls label{display:grid;gap:5px;font-size:12px}.flux-edit-mode small{grid-column:1/-1}.flux-mask-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0}.flux-mask-controls input{width:70px}.flux-mask-controls span{font-size:12px;color:var(--ff-text)}`}</style>
      <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void chooseInput(file); }} />
      <CopyPromptButton text={shape.props.prompt} />
      <textarea aria-label="图片提示词" value={shape.props.prompt} disabled={busy || !!shape.props.pendingId} onChange={e => update({ prompt: e.target.value })} placeholder="描述人物、场景、光线和画面风格…" />
<div className="flux-canvas-fields"><label>尺寸<select value={shape.props.size} disabled={busy || !!shape.props.pendingId} onChange={e => update({ size: e.target.value })}>{!["1024x1536", "768x1152", "1024x1024", "1536x1024"].includes(shape.props.size) && <option value={shape.props.size}>{width} × {height} · 自定义</option>}<option value="1024x1536">1024 × 1536 · 竖图</option><option value="768x1152">768 × 1152 · 更快</option><option value="1024x1024">1024 × 1024 · 方图</option><option value="1536x1024">1536 × 1024 · 横图</option></select></label><label>种子<input aria-label="种子" value={shape.props.seed} disabled={busy || !!shape.props.pendingId} onChange={e => update({ seed: e.target.value })} placeholder="留空随机" /></label></div>
      <details><summary>生成参数 · 实际写入 ComfyUI</summary><div className="flux-canvas-fields">
        <label>宽度<input aria-label="图片宽度" type="number" min={256} max={1536} step={16} value={width} disabled={locked} onChange={e => update({ size: `${Number(e.target.value)}x${height}` })} /></label>
        <label>高度<input aria-label="图片高度" type="number" min={256} max={1536} step={16} value={height} disabled={locked} onChange={e => update({ size: `${width}x${Number(e.target.value)}` })} /></label>
        <label>采样步数<input aria-label="采样步数" type="number" min={1} max={10000} value={devSteps} disabled={locked} onChange={e => update({ steps: Number(e.target.value) })} /></label>
        <label>Flux引导强度<input aria-label="Flux引导强度" type="number" min={0} max={100} step={0.1} value={shape.props.guidance ?? 3.5} disabled={locked} onChange={e => update({ guidance: Number(e.target.value) })} /></label>
        <label>采样器<select aria-label="采样器" value={shape.props.sampler ?? "euler"} disabled={locked} onChange={e => update({ sampler: e.target.value })}>{[...new Set([shape.props.sampler ?? "euler", ...samplers])].map(v => <option key={v}>{v}</option>)}</select></label>
        <label>调度器<select aria-label="调度器" value={shape.props.scheduler ?? "simple"} disabled={locked} onChange={e => update({ scheduler: e.target.value })}>{[...new Set([shape.props.scheduler ?? "simple", ...schedulers])].map(v => <option key={v}>{v}</option>)}</select></label>
        <label>去噪强度<input aria-label="去噪强度" type="number" min={0} max={1} step={0.01} value={imageMode ? devDenoise : shape.props.denoise ?? 1} disabled={locked} onChange={e => update(imageMode ? { imageDenoise: Number(e.target.value) } : { denoise: Number(e.target.value) })} /></label>
      </div><small className="ff-hint">Dev 推荐24步 / 引导3.5 / Euler / Simple；KSampler CFG固定1。纯文生图重绘强度保持1。</small></details>
      <div className="flux-node-stage" role="status">{shape.props.stage}{shape.props.src ? ` · 种子 ${shape.props.lastSeed}` : ""}</div>{error && <div className="flux-node-error" role="alert">{error}</div>}
      {imageMode && <small>{inpaint ? "局部重绘去噪固定为 1。遮罩外像素保持原图；0.8 会把衣服结构留在白色区域内。" : "原图与遮罩同步缩放到所选尺寸。强度越低越保留原图。"}</small>}
      <style>{`.flux-input-slot{display:flex;align-items:center;flex-wrap:wrap;gap:8px;border:1px dashed var(--ff-border-hover);border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px}.flux-input-slot img{width:70px;height:85px;object-fit:contain}.flux-input-slot span{flex:1;overflow-wrap:anywhere}.flux-input-slot button{padding:6px 9px}`}</style>
      <footer><label>生成次数<select aria-label="生图次数" value={shape.props.count ?? 1} disabled={locked} onChange={e => update({ count: Number(e.target.value) })}>{[1,2,3,4,5,6,7,8].map(n => <option key={n} value={n}>{n} 次</option>)}</select></label>{shape.props.src && <button type="button" onClick={placeImage}>放为图片节点</button>}<button type="button" disabled={busy || (!shape.props.pendingId && !shape.props.prompt.trim())} onClick={() => void generate(!!shape.props.pendingId)}>{busy ? "生成中…" : shape.props.pendingId ? "查看原任务结果" : shape.props.src ? "重新生成图片" : "生成图片"}</button></footer>
    </section>
    <style>{`.flux-canvas-node{position:relative;color:var(--ff-text)}.flux-canvas-preview{height:100%;width:100%;display:flex;flex-direction:column;align-items:center;gap:10px}.flux-canvas-preview>span{height:20px;font-size:14px;color:var(--ff-text-2)}.flux-canvas-preview img{width:100%;height:calc(100% - 30px);object-fit:contain;border-radius:15px}.flux-empty-image{height:calc(100% - 30px);width:100%;border:1px solid var(--ff-border-strong);border-radius:15px;background:var(--ff-surface);display:grid;place-items:center;color:var(--ff-text-2);font-size:15px}.flux-canvas-composer{position:absolute;box-sizing:border-box;width:560px;max-height:680px;padding:20px;background:var(--ff-control);border:1px solid var(--ff-border-strong);border-radius:16px;overflow:auto;pointer-events:all}.flux-canvas-composer header{display:flex;justify-content:space-between;margin-bottom:14px}.flux-canvas-composer header span,.flux-canvas-composer small{color:var(--ff-text-2);font-size:13px}.flux-canvas-composer textarea{box-sizing:border-box;width:100%;height:115px;resize:vertical}.flux-canvas-composer input,.flux-canvas-composer select,.flux-canvas-composer textarea{background:var(--ff-surface);color:#eee;border:1px solid var(--ff-border-strong);border-radius:8px;padding:10px;font:inherit;min-width:0}.flux-canvas-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}.flux-canvas-fields label{display:grid;gap:6px;font-size:13px}.flux-canvas-composer footer{display:flex;gap:10px;justify-content:flex-end;margin-top:12px}.flux-canvas-composer button{background:var(--ff-control);color:var(--ff-text);border:1px solid var(--ff-border-strong);border-radius:9px;padding:11px 18px;cursor:pointer}.flux-canvas-composer button:disabled{opacity:.5;cursor:default}.flux-canvas-composer summary{cursor:pointer;margin:12px 0;color:var(--ff-text)}.flux-canvas-node:hover .workflow-port,.flux-canvas-node.is-selected .workflow-port{opacity:1}.flux-node-stage{margin-top:8px;font-size:12px;overflow-wrap:anywhere;color:var(--ff-text-2)}.flux-node-error{font-size:13px;color:var(--ff-bad);overflow-wrap:anywhere}`}</style>
  </HTMLContainer>;
}
