"use client";
import {activeEnhancementPrompt,resumeEnhancement,enhancementKey} from "@/lib/resume-enhancement";
import type { EnhancementCheckpoint } from '@/lib/enhancement-pipeline';
import { getLocalVideoBlob } from '@/lib/local-video-store';
import {withLock,claimNode,releaseNodeClaim} from "@/lib/run-recovery";
import { runTiming } from "@/lib/run-timing";
import { runSyncWarning } from "@/lib/run-sync-warning";
// Stage I: Phase 6 recovery glue extracted from canvas-workspace.tsx without behaviour change.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { nodeRuns } from './run-observer';
import { getCanvasInteracting } from '@/lib/canvas-interaction';
import { ComfyConnectionError, SubmissionUncertainError } from "@/lib/ai-adapter";
import { comfyUIH3Adapter } from "@/lib/comfyui/h3-adapter";
import { readVideoMetadata, storeLocalVideo } from "@/lib/local-video-store";
import { getAsset, getRun, getMeta, listAllAssets, listAssets, listRuns, registerAsset, updateRun, type AssetRecord, type RunRecord } from "@/lib/production-records";
import { createTickBatcher, finalizeRunOutput, findActiveRunForNode, isActiveRun, LOST_RUN_AFTER_MS, recoveryPhaseLabels, watchRun, type RecoveryPhase } from "@/lib/run-recovery";
import { UNCONFIRMED_RUN_TITLE, unconfirmedOnceKey } from "@/lib/unconfirmed-run-actions";
import { setNodeGenerating } from "@/lib/link-highlight";
import { categorize, logEvent, resolveRunEntries } from "@/lib/error-log";
import { readMp4VideoTiming } from "@/lib/video-fps";
import { showCanvasToast } from "./canvas-events";
import { loggedRecoveryRetries, recordRunUpdate } from "./task-log";
import {cancelRecoveredJob} from '@/lib/cancel-recovered-job';
import {saveNodeForRun} from '@/lib/run-recovery';

const durationSeconds = (value: string) => { const parsed = Number.parseFloat(value); return Number.isFinite(parsed) ? parsed : undefined; };
export async function generatedVideoAsset(source: string, result: { video: Blob; filename: string }, metadata: { width: number; height: number; duration: string }, runId: string, fps?: number, shotId?: string) {
  return registerAsset({ kind: "video", origin: "generated", filename: result.filename, mimeType: "video/mp4", storageReference: source, sourceRunId: runId, shotId, width: metadata.width, height: metadata.height, duration: durationSeconds(metadata.duration), fps, fileSize: result.video.size });
}

// Phase 6: refresh recovery glue. The logic lives in lib/run-recovery.ts; this only binds it to nodes.
export const runOutputStore = { getRun, getAsset, listAssets: (kind?: "video") => listAllAssets(kind), updateRun };
/** A connection loss after ComfyUI may have accepted the job: keep the Run active for recovery instead of marking it failed. */
export const isUncertainAfterSubmit = (cause: unknown, jobAccepted: boolean) => cause instanceof SubmissionUncertainError || (jobAccepted && cause instanceof ComfyConnectionError);
export async function registerRunVideo(run: RunRecord, output: { video: Blob; filename: string }, fallbackFps?: number) {
  // MP4 boxes first. The video element often never fires for these Comfy files and would keep the output lock.
  const timing = await readMp4VideoTiming(output.video).catch(() => null);
  const metadata = timing?.fps
    ? { width: timing.width ?? 0, height: timing.height ?? 0, duration: `${(timing.frames / timing.fps).toFixed(1)} 秒` }
    : await readVideoMetadata(output.video);
  const fps = timing?.fps ?? fallbackFps;
  const src = await storeLocalVideo(output.video, output.filename);
  return generatedVideoAsset(src, output, metadata, run.runId, fps, run.shotId);
}

/** Recovery re-checks from one broadcast (one per node) share a single Run read that starts after the broadcast. */
export const listRunsBatched = createTickBatcher(listRuns);

/** Tells the link overlay which nodes are generating right now (live job or re-attached job). */
export function useGeneratingSignal(nodeId: string, busy: boolean, recoveryPhase: RecoveryPhase | undefined) {
  const active = busy || recoveryPhase === "submitting" || recoveryPhase === "queued" || recoveryPhase === "running";
  useEffect(() => { setNodeGenerating(nodeId, active); return () => setNodeGenerating(nodeId, false); }, [nodeId, active]);
}

export type RecoveryView = { run: RunRecord; phase: RecoveryPhase; stage: string };
export const RECOVERY_BLOCKING: RecoveryPhase[] = ["submitting", "queued", "running", "waiting_connection", "unconfirmed", "paused"];
/**
 * Re-attaches a node to its active Run after refresh (or when another tab owns the live job).
 * Never submits. `isLive` tells it this tab's own generate() is already following the job.
 */
export function useRunRecovery(nodeId: string, isLive: () => boolean, present: (run: RunRecord, asset: AssetRecord, created: boolean) => Promise<void> | void) {
  const [view, setView] = useState<RecoveryView | null>(null);
  const watcher = useRef<AbortController | null>(null);
  const presentRef = useRef(present);
  const liveRef = useRef(isLive);
  useEffect(() => { presentRef.current = present; liveRef.current = isLive; });
  const recheck = useCallback(async () => {
    if (watcher.current || liveRef.current()) return;
    const controller = new AbortController();
    watcher.current = controller;
    let retry = false;
    try {
      const run = findActiveRunForNode(nodeId, await nodeRuns.read(nodeId));
      if (!run) { setView((previous) => previous && !RECOVERY_BLOCKING.includes(previous.phase) ? previous : null); return; }
      if (liveRef.current()) return;
      setView({ run, phase: run.submission === "reserved" ? "submitting" : run.status === "running" ? "running" : "queued", stage: "正在确认 ComfyUI 任务状态" });
      const outcome = await watchRun(run, comfyUIH3Adapter, {
        readEnhancement: id=>getMeta<EnhancementCheckpoint>(enhancementKey(id)),
        readRunState: getRun,
        signal: controller.signal,
        // Online ComfyUI that has the job in neither queue nor history 10+ minutes on: it is gone. Settle instead of 「待确认」 forever.
        lostAfterMs: LOST_RUN_AFTER_MS,
        onTiming: timing=>{if(timing.startedAt)run.startedAt=timing.startedAt;if(timing.completedAt)run.completedAt=timing.completedAt;recordRunUpdate(run.runId,{...(timing.startedAt?{startedAt:timing.startedAt}:{}),...(timing.completedAt?{completedAt:timing.completedAt}:{}),executionTiming:{...timing,stages:{},source:"history",...(timing.startedAt && timing.completedAt?{executionMs:Math.max(0,timing.completedAt-timing.startedAt)}:{})}});},
        onPhase: (phase, stage) => { if (!controller.signal.aborted) setView({ run, phase, stage }); },
        onRunning: () => { const first = run.startedAt ?? Date.now(); run.startedAt = first; run.status = "running"; recordRunUpdate(run.runId, { status: "running", startedAt: first, ...(run.submission === "reserved" ? { submission: "accepted" as const } : {}) }); },
      });
      if (controller.signal.aborted || outcome.phase === "detached") return;
      // A queue stop may remove a waiting job while this watcher is polling.
      const currentRun = await getRun(run.runId);
      if (currentRun?.status === "cancelled" || currentRun?.status === "failed") {
        setView({ run: currentRun, phase: currentRun.status, stage: currentRun.error ?? "任务已结束" });
        void resolveRunEntries(run.runId, currentRun.error ?? "任务已结束", [UNCONFIRMED_RUN_TITLE]);
        return;
      }
      if (outcome.phase === 'settled') {
        const latest=await getRun(run.runId);
        if(latest?.status==='completed' && latest.outputAssetIds[0]) {
          const asset=await getAsset(latest.outputAssetIds[0]);
          if(asset) await presentRef.current(latest,asset,false);
        }
        setView({run:latest??run,phase:outcome.status,stage:outcome.status==='completed'?'任务已完成':outcome.reason});
        void resolveRunEntries(run.runId, outcome.status==='completed'?'任务已完成':outcome.reason, [UNCONFIRMED_RUN_TITLE]);
      } else if (outcome.phase === "completed" || outcome.phase === 'completed_local') {
        setView({ run, phase: "running", stage: "获取生成结果" });
        const output = outcome.phase==='completed_local'
          ? {video:await getLocalVideoBlob(outcome.source),filename:outcome.filename}
          : await Promise.race([comfyUIH3Adapter.fetchOutputFile(outcome.file), new Promise<never>((_resolve, reject) => setTimeout(() => reject(Error('取片超时')), 20000))]);
        const result = await finalizeRunOutput(run.runId, runOutputStore, async (current) => registerRunVideo(current, output, typeof current.parameters.outputFps === 'number'?current.parameters.outputFps:typeof current.parameters.fps === "number" ? current.parameters.fps : undefined));
        await presentRef.current(result.run, result.asset, result.created);
        setView({ run: result.run, phase: "completed", stage: result.created ? "已恢复并取回结果" : "结果已登记，未重复创建" });
        void resolveRunEntries(run.runId, "任务已完成并取回结果", [UNCONFIRMED_RUN_TITLE]);
        void logEvent({ level: "info", category: "recovery", title: "刷新前的任务已完成并恢复", detail: result.created ? "输出已取回并登记。" : "输出此前已登记，未重复创建。", nodeId, runId: run.runId, shotId: run.shotId });
      } else if (outcome.phase === "failed") {
        await updateRun(run.runId, { status: "failed", completedAt: Date.now(), error: outcome.error });
        setView({ run, phase: "failed", stage: outcome.error });
        void resolveRunEntries(run.runId, outcome.error, [UNCONFIRMED_RUN_TITLE]);
        void logEvent({ level: "error", category: "recovery", title: "恢复后确认：ComfyUI 任务失败", detail: outcome.error, nodeId, runId: run.runId, shotId: run.shotId });
      } else if (outcome.phase === "lost") {
        // Only the local record changes. Nothing is submitted or cancelled in ComfyUI.
        if (!currentRun || !isActiveRun(currentRun)) return;
        await updateRun(run.runId, { status: "failed", completedAt: Date.now(), error: outcome.reason });
        setView({ run, phase: "failed", stage: outcome.reason });
        await resolveRunEntries(run.runId, "ComfyUI 里已找不到，已自动结束（未重新提交）", [UNCONFIRMED_RUN_TITLE]);
        void logEvent({ level: "info", category: "recovery", title: "找不到的任务已自动结束", detail: outcome.reason, nodeId, runId: run.runId, shotId: run.shotId, onceKey: `lost:${run.runId}` });
      } else if (outcome.phase === 'paused') {
        setView({run,phase:'paused',stage:outcome.reason});
      } else {
        retry = true;
        setView({ run, phase: "unconfirmed", stage: outcome.reason });
        // Re-checked every few seconds: one entry per Run, never a growing ×N count.
        void logEvent({ level: "warning", category: "recovery", title: UNCONFIRMED_RUN_TITLE, detail: outcome.reason, nodeId, runId: run.runId, shotId: run.shotId, onceKey: unconfirmedOnceKey(run.runId) });
      }
    } catch (cause) {
      retry = true;
      const detail = cause instanceof Error ? cause.message : String(cause);
      setView((previous) => { if (previous && !loggedRecoveryRetries.has(previous.run.runId)) { loggedRecoveryRetries.add(previous.run.runId); void logEvent({ level: "warning", category: categorize(detail, "recovery"), title: "恢复任务时出错，稍后自动重试", detail, nodeId, runId: previous.run.runId }); } return previous; });
      setView((previous) => previous && { ...previous, phase: "waiting_connection", stage: cause instanceof Error ? `${cause.message}；稍后自动重新确认` : "稍后自动重新确认" });
    } finally {
      if (watcher.current === controller) watcher.current = null;
      if (retry && !controller.signal.aborted) window.setTimeout(() => void recheck(), 5_000);
    }
  }, [nodeId]);
  useEffect(() => {
    const unsubscribe=nodeRuns.subscribe(nodeId,()=>void recheck());
    void recheck();
    return () => { unsubscribe();watcher.current?.abort(); watcher.current = null; };
  }, [recheck,nodeId]);
  const blocking = Boolean(view && RECOVERY_BLOCKING.includes(view.phase));
  const cancel = async () => {
    if (!view) return true;
    try {
      const latest=await getRun(view.run.runId);
      const id=view.run.parameters.enhancementPipeline?await activeEnhancementPrompt(view.run.runId):latest?.comfyPromptId;
      if(latest?.status==='completed' || (id && await cancelRecoveredJob(comfyUIH3Adapter,id,saveNodeForRun(latest ?? view.run))==='completed')) {
        await recheck(); showCanvasToast('原任务已完成，正在恢复结果；恢复后可移除节点'); return false;
      }
    }
    catch (cause) { showCanvasToast(cause instanceof Error ? cause.message : "取消任务失败"); return false; }
    watcher.current?.abort(); watcher.current = null;
    await updateRun(view.run.runId, { status: "cancelled", completedAt: Date.now(), error: "用户取消" });
    releaseNodeClaim(nodeId); setNodeGenerating(nodeId, false);
    setView({ ...view, phase: "cancelled", stage: "任务已取消" });
    return true;
  };
  const abandon = async () => {
    if (!view) return;
    if(view.run.parameters.segmentedUpscale === true) {
      try {
        const id=view.run.parameters.enhancementPipeline?await activeEnhancementPrompt(view.run.runId):view.run.comfyPromptId;
        if(id) {
          const probe=await comfyUIH3Adapter.probeJob(id,view.run.capabilityId==="film_interpolation"?"7":"76");
          if(probe.state==="queued"||probe.state==="running")await comfyUIH3Adapter.cancel(id);
        }
      }
      catch(cause) { showCanvasToast(cause instanceof Error ? cause.message : '无法确认当前分段已停止，暂不放弃'); return; }
    }
    watcher.current?.abort(); watcher.current = null;
    await updateRun(view.run.runId, { status: "failed", completedAt: Date.now(), error: `任务状态无法确认，已由用户放弃（未重新提交）：${view.stage}` });
    setView({ ...view, phase: "failed", stage: "已放弃，未重新提交" });
    void resolveRunEntries(view.run.runId, "已在节点上放弃（未重新提交）", [UNCONFIRMED_RUN_TITLE]);
  };
  const resume = async () => {
    if(!view?.run.parameters.enhancementPipeline || watcher.current || liveRef.current()) return;
    const release=claimNode(nodeId); if(!release)return;
    const controller=new AbortController(); watcher.current=controller;
    try {
      await withLock(`frameflow-resume-output-${view.run.runId}`,async()=>{
        const run=await getRun(view.run.runId);
        if(!run || run.status==='cancelled' || run.status==='failed') throw new Error('原任务已结束，请重新确认状态');
        const output=await resumeEnhancement(run,{signal:controller.signal,
          onUpdate:update=>setView({run,phase:update.status==='queued'?'queued':'running',stage:update.stage??'恢复分段任务'}),
          onJobId:id=>{run.comfyPromptId=id;recordRunUpdate(run.runId,{comfyPromptId:id,submission:'accepted'});},
        });
        const result=await finalizeRunOutput(run.runId,runOutputStore,current=>registerRunVideo(current,output,run.parameters.outputFps as number|undefined));
        await presentRef.current(result.run,result.asset,result.created);
        setView({run:result.run,phase:'completed',stage:'分段任务已继续完成，未重复创建视频'});
      });
    } catch(cause) {setView({...view,phase:'unconfirmed',stage:cause instanceof Error?cause.message:'恢复中断，未重新提交状态不明的段'});}
    finally {if(watcher.current===controller)watcher.current=null;release();}
  };
  return { view, blocking, recheck, cancel, abandon, resume };
}
export function RecoveryStatus({ recovery }: { recovery: ReturnType<typeof useRunRecovery> }) {
  const view = recovery.view;
  if (!view || !recovery.blocking) return null;
  return <div className={`recovery-status phase-${view.phase}`}><div><b>{recoveryPhaseLabels[view.phase]}</b><span>{view.stage}</span></div><div className="recovery-actions">
    {(view.phase==="unconfirmed" || view.phase==='paused') && view.run.parameters.enhancementPipeline===true && <button type="button" onClick={()=>void recovery.resume()}>继续分段任务</button>}
    {view.phase === "unconfirmed" || view.phase==='paused' ? <button type="button" onClick={() => void recovery.abandon()}>放弃此任务</button> : <button type="button" onClick={() => void recovery.cancel()}>取消任务</button>}
  </div></div>;
}


/** Only read persisted Run timestamps; refresh/recovery does not reset the stopwatch. */
const clockListeners=new Set<()=>void>();
let clockTimer:ReturnType<typeof setInterval>|undefined;
let clockNow=0;
function subscribeClock(listener:()=>void){
  clockListeners.add(listener);
  if(!clockTimer){clockNow=Date.now();clockTimer=setInterval(()=>{if(document.hidden||getCanvasInteracting())return;clockNow=Date.now();for(const callback of clockListeners)callback();},1000);}
  return()=>{clockListeners.delete(listener);if(!clockListeners.size){clearInterval(clockTimer);clockTimer=undefined;}};
}
const noClock=()=>()=>{};
export function useRunTiming(nodeId: string, active: boolean) {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [sync, setSync] = useState({ nodeId, at: 0, failed: false });
  const now=useSyncExternalStore(active?subscribeClock:noClock,()=>active?clockNow:0,()=>0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () => { void nodeRuns.read(nodeId).then(runs => {
      if (!live) return;
      const latest = runs.filter(r => r.ownerNodeId === nodeId).sort((a,b) => b.createdAt-a.createdAt)[0] ?? null;
      setSync({ nodeId, at: Date.now(), failed: false });
      setRun(current => current?.runId === latest?.runId && current?.startedAt === latest?.startedAt && current?.completedAt === latest?.completedAt && current?.executionTiming===latest?.executionTiming ? current : latest);
    }).catch(() => { if (live) setSync(current => ({ nodeId, at: current.nodeId === nodeId ? current.at : 0, failed: true })); }); };
    const changed = () => read();
    const unsubscribe=nodeRuns.subscribe(nodeId,changed);
    read();
    return () => { live=false;unsubscribe(); };
  },[nodeId,active]);
  return { ...(run ? runTiming(run,now || run.createdAt) : {queueSeconds:0,generationSeconds:null}), lastSync: sync.nodeId === nodeId ? sync.at : 0, syncWarning: active && sync.nodeId === nodeId ? runSyncWarning(sync.at, sync.failed, now) : null };
}
