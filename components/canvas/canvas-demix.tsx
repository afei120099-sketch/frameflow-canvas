"use client";
/**
 * 去配乐 on the canvas: the node control (button + 原声 / 去配乐 switch), the right-click batch
 * 「一键去背景音（N个视频）」 with its in-page confirm and progress panel, refresh recovery and
 * 「出片后自动去配乐」. Logic lives in lib/music-removal.ts; this file only wires it to the canvas.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor, TLShape } from "tldraw";
import { askConfirm } from "@/components/in-page-dialog";
import { announceShotChange, showCanvasToast } from "./canvas-events";
import { getAsset, RUN_CHANGE_CHANNEL, type AssetRecord } from "@/lib/production-records";
import { getLocalVideoBlob, readVideoDurationSeconds, readVideoMetadata, storeLocalVideo } from "@/lib/local-video-store";
import { configureMusicRemoval, currentDemixTab, demixJobLabel, demixPassLabel, demixViewFor, MAX_MUSIC_REMOVAL_PASSES, enqueueMusicRemoval, enqueueReasonText, isActiveDemix, maybeAutoRemoveMusic, recoverMusicRemovals, subscribeDemixJobs, withdrawWaiting, type DemixJob, type DemixStateRow } from "@/lib/music-removal";
import { estimateMusicRemovalSeconds, demixDeviceLabel } from "@/lib/comfyui/music-removal-workflow";
import { capturePoster, getPoster, loadPoster, rememberPoster } from "@/lib/poster-cache";

export const OPEN_CANVAS_DEMIX = "frameflow-open-canvas-demix";

/** Nodes whose video can be demixed and switched in place (the rough-cut workshop nodes are left out). */
export function isDemixableVideo(shape: { type: string; props: object }) {
  const p = shape.props as { src?: string; shotId?: string; inheritedVideo?: { src?: string } };
  return shape.type === "video-node" ? !!p.src : shape.type === "h3-node" && !!(p.shotId || p.inheritedVideo?.src);
}

/**
 * Cover image for a 去配乐 file. The picture is the original's, copied untouched, so the original's cover is
 * reused; without one, the first frame is decoded from the new file. Without a cover the H3 node shows only an
 * icon until the video is played (the cover cache is keyed by file).
 */
const posterWork = new Map<string, Promise<void>>();
export function ensureDemixPoster(outputReference: string, originalReference?: string, blob?: Blob) {
  if (!outputReference || getPoster(outputReference)) return Promise.resolve();
  const running = posterWork.get(outputReference);
  if (running) return running;
  const work = (async () => {
    if (await loadPoster(outputReference)) return;
    const original = originalReference ? await loadPoster(originalReference) : undefined;
    if (original) { rememberPoster(outputReference, original); return; }
    await decodeFirstFrame(outputReference, blob ?? await getLocalVideoBlob(outputReference));
  })().catch(() => {}).finally(() => posterWork.delete(outputReference));
  posterWork.set(outputReference, work);
  return work;
}
function decodeFirstFrame(source: string, blob: Blob) {
  return new Promise<void>((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    const done = () => { clearTimeout(timer); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); resolve(); };
    const timer = setTimeout(done, 15000);
    video.muted = true; video.playsInline = true; video.preload = "auto";
    video.onloadeddata = () => { video.currentTime = Math.min(0.05, (video.duration || 1) / 2); };
    video.onseeked = () => { capturePoster(source, video); done(); };
    video.onerror = done;
    video.src = url;
  });
}

let configured = false;
function ensureConfigured() {
  if (configured || typeof window === "undefined") return;
  configured = true;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  // Held for this tab's lifetime: other tabs can tell a live queue from one lost on refresh.
  void locks?.request(`frameflow-demix-tab-${currentDemixTab()}`, () => new Promise<void>(() => {})).catch(() => {});
  configureMusicRemoval({
    fetch: (...args) => fetch(...args),
    loadVideo: getLocalVideoBlob,
    storeVideo: (blob, name) => storeLocalVideo(blob, name),
    readMetadata: async (blob) => {
      const [meta, seconds] = await Promise.all([readVideoMetadata(blob), readVideoDurationSeconds(blob)]);
      return { width: meta.width || undefined, height: meta.height || undefined, duration: seconds ?? undefined };
    },
    onShotChanged: announceShotChange,
    onOutputStored: (original, output, blob) => ensureDemixPoster(output, original, blob),
    tabAlive: async (id) => !!(await locks?.query())?.held?.some((lock) => lock.name === `frameflow-demix-tab-${id}`),
  });
}

export function useDemixRow() {
  const [row, setRow] = useState<DemixStateRow | null>(null);
  useEffect(() => { ensureConfigured(); return subscribeDemixJobs(setRow); }, []);
  return row;
}

const formatBytes = (bytes: number) => bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
/** Show `asset` in the node (H3: its version picker; video node: swap the file). Original stays in the records. */
export function showDemixVersion(editor: Editor, shapeId: TLShape["id"], asset: AssetRecord) {
  const shape = editor.getShape(shapeId);
  if (!shape || shape.isLocked) return false;
  if (asset.derivationType === "music_removal") void getAsset(asset.sourceVideoAssetId ?? "").then((original) => ensureDemixPoster(asset.storageReference, original?.storageReference)).catch(() => {});
  if (shape.type === "h3-node") { editor.updateShape({ id: shape.id, type: "h3-node", props: { previewAssetId: asset.assetId } } as never); return true; }
  if (shape.type === "video-node") {
    editor.updateShape({ id: shape.id, type: "video-node", props: { src: asset.storageReference, name: asset.filename, originalPath: asset.filename, assetId: asset.assetId, runId: asset.sourceRunId ?? undefined, shotId: asset.shotId, ...(asset.fileSize ? { size: formatBytes(asset.fileSize) } : {}), ...(asset.duration ? { duration: `${asset.duration.toFixed(1)} 秒` } : {}) } } as never);
    return true;
  }
  return false;
}
const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

/** Header control for one node. `assetId` = the video the node shows right now. */
export function DemixNodeControl({ editor, shapeId, assetId, disabled }: { editor: Editor; shapeId: TLShape["id"]; assetId?: string; disabled?: boolean }) {
  const row = useDemixRow();
  const [asset, setAsset] = useState<AssetRecord | null>(null);
  useEffect(() => { let live = true; if (!assetId) { queueMicrotask(() => setAsset(null)); return; } void getAsset(assetId).then((value) => { if (live) setAsset(value); }).catch(() => {}); return () => { live = false; }; }, [assetId]);
  const view = demixViewFor(asset, row);
  // 去配乐 versions made before covers were added: give them one the first time a node shows them.
  useEffect(() => { if (asset?.derivationType === "music_removal") void getAsset(asset.sourceVideoAssetId ?? "").then((original) => ensureDemixPoster(asset.storageReference, original?.storageReference)).catch(() => {}); }, [asset]);
  if (!assetId || !asset || asset.kind !== "video") return null;
  const switchTo = async (id: string | null | undefined, toast: string) => {
    const target = id ? await getAsset(id) : null;
    if (!target) { showCanvasToast("那个版本的素材找不到了"); return; }
    if (showDemixVersion(editor, shapeId, target)) showCanvasToast(toast);
  };
  const run = async (retry = false) => {
    const result = await enqueueMusicRemoval({ sourceAssetId: asset.assetId, nodeId: shapeId, retry });
    showCanvasToast(result.queued ? `已排进去配乐队列（${result.pass > 1 ? "再去一次，" : ""}排在已有出片任务后面）` : enqueueReasonText[result.reason]);
  };
  if (view.kind === "output") {
    const back = <button type="button" className="node-header-button demix-chip" data-demix="output" title={`这是${demixPassLabel(view.passes)}版（原声版一直保留）。点一下切回原声`} onPointerDown={stop} onClick={(event) => { stop(event); void switchTo(view.originalAssetId, "已切回原声版"); }}>{demixPassLabel(view.passes)}版 · 切回原声</button>;
    const again = view.job;
    // 只放开「1 遍 → 2 遍」: a 1-pass version may get one more pass; a 2-pass one is never processed again.
    const more = !view.canRunAgain ? <span className="node-header-button demix-chip" data-demix="skipped" title={`已经去过 ${MAX_MUSIC_REMOVAL_PASSES} 遍配乐，不再处理`}>已处理过</span>
      : again?.state === "done" ? <button type="button" className="node-header-button demix-chip" data-demix="done" title="已再去一次。点一下看去配乐 ×2 版" onPointerDown={stop} onClick={(event) => { stop(event); void switchTo(again.outputAssetId, "已切到去配乐 ×2 版"); }}>看 ×2 版</button>
      : isActiveDemix(again) ? <span className="node-header-button demix-chip" data-demix={again!.state} aria-live="polite">{demixJobLabel(again)}…</span>
      : <button type="button" className="node-header-button demix-chip" data-demix={again?.state === "failed" ? "failed" : "none"} disabled={disabled} title={again?.state === "failed" ? `再去一次失败：${again.error ?? "未知原因"}。点一下重试` : "把这个去配乐版再交一次 CDX23（结果是「去配乐 ×2」新版本，这一版和原声版都保留）"} onPointerDown={stop} onClick={(event) => { stop(event); void run(again?.state === "failed"); }}>{again?.state === "failed" ? "再去一次失败 · 重试" : "再去一次"}</button>;
    return <>{back}{more}</>;
  }
  const job: DemixJob | undefined = view.kind === "source" ? view.job : undefined;
  if (job?.state === "done") return <button type="button" className="node-header-button demix-chip" data-demix="done" title={`已去配乐${job.device ? ` · ${demixDeviceLabel(job.device)}` : ""}。点一下看去配乐版，原声版保留`} onPointerDown={stop} onClick={(event) => { stop(event); void switchTo(job.outputAssetId, "已切到去配乐版"); }}>看去配乐版</button>;
  if (job?.state === "skipped") return <span className="node-header-button demix-chip" data-demix="skipped" title="这个视频本身已经去过配乐，节点跳过了，没有出新文件">已处理过</span>;
  if (isActiveDemix(job)) return <span className="node-header-button demix-chip" data-demix={job!.state} aria-live="polite" title={job!.state === "waiting" ? "在画布里排队，前一个去配乐完成后才提交" : "已提交到 ComfyUI"}>{demixJobLabel(job)}…</span>;
  if (job?.state === "failed") return <button type="button" className="node-header-button demix-chip" data-demix="failed" disabled={disabled} title={`去配乐失败：${job.error ?? "未知原因"}。点一下重试`} onPointerDown={stop} onClick={(event) => { stop(event); void run(true); }}>去配乐失败 · 重试</button>;
  return <button type="button" className="node-header-button demix-chip" data-demix="none" disabled={disabled} title="去掉背景音乐，只留台词和音效（CDX23）。结果是新版本，原声版保留。还能听到音乐时，可以在去配乐版上点「再去一次」" onPointerDown={stop} onClick={(event) => { stop(event); void run(); }}>去配乐</button>;
}

type BatchItem = { shapeId: TLShape["id"]; assetId: string; name: string; skip?: string };

/** Mounted once per canvas: recovery after refresh, auto after H3, the right-click batch and its panel. */
export function CanvasDemix({ editor, resolveSource }: { editor: Editor; resolveSource: (shape: TLShape) => Promise<{ asset: AssetRecord; duration: number }> }) {
  const row = useDemixRow();
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  useEffect(() => {
    ensureConfigured();
    void recoverMusicRemovals().then(({ lost, resumed }) => {
      if (lost.length) showCanvasToast(`有 ${lost.length} 个去配乐在刷新前还没提交（没占显卡），已标成失败，可以重试`);
      else if (resumed.length) showCanvasToast(`正在找回 ${resumed.length} 个已提交的去配乐任务`);
    }).catch(() => showCanvasToast("去配乐任务恢复失败，请查看节点状态"));
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(RUN_CHANGE_CHANNEL);
    if (channel) channel.onmessage = (event: MessageEvent<{ runId?: string }>) => { if (event.data?.runId) void maybeAutoRemoveMusic(event.data.runId).catch(() => {}); };
    return () => channel?.close();
  }, []);
  // A finished job: show the new version in the node that still shows the original.
  const [seen, setSeen] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!row) return;
    const next: Record<string, string> = {};
    for (const job of Object.values(row.jobs)) next[job.sourceAssetId] = job.state;
    const finished = Object.values(row.jobs).filter((job) => job.state === "done" && job.outputAssetId && seen[job.sourceAssetId] && seen[job.sourceAssetId] !== "done");
    queueMicrotask(() => setSeen(next));
    if (!finished.length) return;
    void (async () => {
      for (const job of finished) {
        const output = await getAsset(job.outputAssetId!);
        if (!output) continue;
        for (const shape of editor.getCurrentPageShapes()) {
          const p = shape.props as { assetId?: string; previewAssetId?: string };
          if ((shape.type === "video-node" && p.assetId === job.sourceAssetId) || (shape.type === "h3-node" && (p.previewAssetId === job.sourceAssetId || (!p.previewAssetId && shape.id === job.nodeId)))) showDemixVersion(editor, shape.id, output);
        }
      }
    })().catch(() => {});
  }, [row, editor]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const open = async (event: Event) => {
      const ids = (event as CustomEvent<{ ids?: TLShape["id"][] }>).detail?.ids ?? editor.getSelectedShapeIds();
      const shapes = ids.map((id) => editor.getShape(id)).filter((shape): shape is TLShape => !!shape && isDemixableVideo(shape));
      if (!shapes.length) { showCanvasToast("请先框选要去背景音的视频"); return; }
      const jobs = row?.jobs ?? {};
      const items: (BatchItem & { duration: number })[] = [];
      for (const shape of shapes) {
        try {
          const { asset, duration } = await resolveSource(shape);
          const job = jobs[asset.assetId];
          const skip = asset.derivationType === "music_removal" ? "这已经是去配乐版（要再去一次，请在节点上点「再去一次」）" : job?.state === "done" ? "已经去过配乐" : job?.state === "skipped" ? "已处理过" : isActiveDemix(job) ? "正在去配乐" : items.some((item) => item.assetId === asset.assetId) ? "和前面的是同一个视频" : undefined;
          items.push({ shapeId: shape.id, assetId: asset.assetId, name: asset.filename, duration, ...(skip ? { skip } : {}) });
        } catch (cause) { items.push({ shapeId: shape.id, assetId: "", name: (shape.props as { name?: string }).name ?? "视频", duration: 0, skip: cause instanceof Error ? cause.message : "读不到这个视频" }); }
      }
      const todo = items.filter((item) => !item.skip);
      const skipped = items.length - todo.length;
      const estimate = estimateMusicRemovalSeconds(todo.map((item) => item.duration));
      if (!todo.length) { showCanvasToast(`选中的 ${items.length} 个视频都不用处理（已经去过配乐或正在处理）`); setBatch(items); return; }
      const ok = await askConfirm({
        title: "一键去背景音",
        message: `选中 ${items.length} 个视频，要处理 ${todo.length} 个${skipped ? `，${skipped} 个会跳过（已经去过配乐或正在处理）` : ""}。\n\n每个视频单独提交一个任务，一个做完再交下一个，排在已有的出片任务后面，不会一次占住显卡。\n预计：显卡约 ${Math.max(1, Math.round(estimate.gpu / 60))} 分钟；如果显存不够改用 CPU，约 ${Math.max(1, Math.round(estimate.cpu / 60))} 分钟。\n\n原视频不会改动，去配乐版作为新版本挂在原来的节点上，可以切回原声。`,
        confirmLabel: `开始去背景音（${todo.length}个）`,
      });
      if (!ok) return;
      const queued: BatchItem[] = [];
      for (const item of items) {
        if (item.skip) { queued.push(item); continue; }
        const result = await enqueueMusicRemoval({ sourceAssetId: item.assetId, nodeId: item.shapeId });
        queued.push(result.queued ? item : { ...item, skip: enqueueReasonText[result.reason] });
      }
      setBatch(queued);
    };
    window.addEventListener(OPEN_CANVAS_DEMIX, open);
    return () => window.removeEventListener(OPEN_CANVAS_DEMIX, open);
  }, [editor, resolveSource, row]);
  return batch ? <DemixBatchPanel items={batch} row={row} onClose={() => setBatch(null)} /> : null;
}

function DemixBatchPanel({ items, row, onClose }: { items: BatchItem[]; row: DemixStateRow | null; onClose: () => void }) {
  const lines = useMemo(() => items.map((item) => ({ item, job: item.assetId ? row?.jobs[item.assetId] : undefined })), [items, row]);
  const work = lines.filter((line) => !line.item.skip);
  const done = work.filter((line) => line.job && ["done", "skipped"].includes(line.job.state)).length;
  const failed = work.filter((line) => line.job?.state === "failed");
  const waiting = work.filter((line) => line.job?.state === "waiting").map((line) => line.item.assetId);
  const active = work.findIndex((line) => line.job?.state === "running");
  const retry = async (assetId: string) => { const result = await enqueueMusicRemoval({ sourceAssetId: assetId, retry: true }); if (!result.queued) showCanvasToast(enqueueReasonText[result.reason]); };
  return createPortal(<section className="demix-batch" role="region" aria-label="一键去背景音进度" onPointerDown={stop} onWheel={stop}>
    <header><b>一键去背景音 · {done}/{work.length} 完成{failed.length ? ` · ${failed.length} 个失败` : ""}</b>{active >= 0 && <span>第 {active + 1} / {work.length} 条</span>}<button type="button" onClick={onClose}>收起</button></header>
    <ol>{lines.map(({ item, job }, index) => <li key={`${item.shapeId}-${index}`} data-state={item.skip ? "skip" : job?.state ?? "none"}>
      <span title={item.name}>{index + 1}. {item.name}</span>
      <em>{item.skip ? `跳过：${item.skip}` : !job ? "等待" : job.state === "failed" ? `失败：${job.error ?? ""}` : job.state === "done" ? `完成${job.device ? ` · ${demixDeviceLabel(job.device)}` : ""}` : job.state === "skipped" ? "节点认出已处理过，跳过" : job.state === "waiting" ? "排队中（前一个做完才提交）" : job.stage || "正在去配乐"}</em>
      {!item.skip && job?.state === "failed" && <button type="button" onClick={() => void retry(item.assetId)}>重试</button>}
    </li>)}</ol>
    <footer>{failed.length > 1 && <button type="button" onClick={() => { for (const line of failed) void retry(line.item.assetId); }}>全部重试（{failed.length}）</button>}{waiting.length > 0 && <button type="button" onClick={() => void withdrawWaiting(waiting).then((count) => showCanvasToast(`已撤掉 ${count} 个还没提交的；已经交给 ComfyUI 的不受影响`))}>撤掉还没提交的（{waiting.length}）</button>}<small>原声版一直保留，节点上可以切回。</small></footer>
    <style>{`.demix-batch{position:fixed;z-index:340;right:20px;bottom:20px;width:min(440px,calc(100vw - 40px));max-height:60vh;display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--ff-border-strong);border-radius:12px;background:var(--ff-raised);color:var(--ff-text);box-shadow:0 8px 30px rgba(0,0,0,.6);font-size:13px}.demix-batch header,.demix-batch footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.demix-batch header b{flex:1}.demix-batch header span,.demix-batch small{color:var(--ff-text-2)}.demix-batch ol{margin:0;padding:0;list-style:none;overflow:auto;display:grid;gap:6px}.demix-batch li{display:grid;grid-template-columns:1fr auto;gap:2px 8px;padding:7px 9px;border:1px solid var(--ff-border);border-radius:8px;background:var(--ff-surface)}.demix-batch li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.demix-batch li em{grid-column:1;font-style:normal;color:var(--ff-text-2);word-break:break-all}.demix-batch li[data-state=failed]{border-style:dashed;border-color:var(--ff-text-3)}.demix-batch li[data-state=failed] em{color:var(--ff-text)}.demix-batch li[data-state=done] em{color:var(--ff-text)}.demix-batch li button{grid-column:2;grid-row:1/3;align-self:center}.demix-batch button{border:1px solid var(--ff-border-hover);border-radius:7px;background:var(--ff-control);color:var(--ff-text);padding:5px 10px;cursor:pointer;white-space:nowrap}.demix-batch button:hover{background:var(--ff-hover)}`}</style>
  </section>, document.body);
}
