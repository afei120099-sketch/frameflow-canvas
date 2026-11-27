import {boundedLock} from './operation-scope.ts';
import type { AssetRecord, CapabilityId, RunRecord } from "./production-records.ts";
import type { ComfyFile, ComfyJobProbe } from "./comfyui/h3-adapter.ts";
import { FILM_SAVE_NODE_ID } from "./comfyui/film-workflow.ts";
import { isCommunityWorkflow } from "./h3-workflow-options.ts";
/** Save node of the retired video-extension graph (lib/comfyui/h3-extend.ts, removed 2026-11-11); old Runs still recover their output from it. */
const H3_EXTEND_SAVE_NODE = "ff-extend-save";
import { COMMUNITY_SAVE_NODE_ID } from "./comfyui/experimental/h3-community.ts";
import type { EnhancementCheckpoint } from './enhancement-pipeline.ts';
import { isNodeBeingRemoved } from './node-task-activity.ts';

/**
 * Phase 6: refresh recovery and duplicate-submit protection.
 *
 * Identity is the existing Run ID. New Runs reserve it as the ComfyUI prompt_id and persist it
 * *before* /prompt is sent, so after a refresh the job can always be looked up by that ID.
 * Nothing in this module ever submits a workflow: recovery only reads /queue and /history,
 * fetches a finished output once, or cancels.
 */

export const ACTIVE_RUN_STATUSES: RunRecord["status"][] = ["queued", "running"];
export const isActiveRun = (run: RunRecord) => ACTIVE_RUN_STATUSES.includes(run.status);

const SAVE_NODES: Record<CapabilityId, string> = { h3_fl2va: "15", h3_ref2va: "92", h3_addguide_experimental: "15", h3_ultimate_guide: "148", seedvr2_upscale: "76", film_interpolation: FILM_SAVE_NODE_ID, final_cut_rough: "", cover_generation:"7", music_removal: "2" }; // rough cuts run locally (PyAV), never in ComfyUI
export const saveNodeForCapability = (capabilityId: CapabilityId) => SAVE_NODES[capabilityId];
export const saveNodeForRun = (run: { capabilityId: CapabilityId; parameters?: RunRecord["parameters"] }) => run.parameters?.workflowOptionId === "h3-extend" ? H3_EXTEND_SAVE_NODE : isCommunityWorkflow(run.parameters?.workflowOptionId as string | undefined) ? COMMUNITY_SAVE_NODE_ID : saveNodeForCapability(run.capabilityId);

/** Only Phase 6+ Runs carry ownerNodeId; older Runs are never re-attached to a node. */
export function findActiveRunForNode(nodeId: string, runs: RunRecord[]) {
  return runs.filter((run) => run.ownerNodeId === nodeId && isActiveRun(run)).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

export type RecoveryPhase = "submitting" | "queued" | "running" | "waiting_connection" | "unconfirmed" | "paused" | "completed" | "failed" | "cancelled";
export const recoveryPhaseLabels: Record<RecoveryPhase, string> = { submitting: "提交中", queued: "排队中", running: "生成中", waiting_connection: "等待连接", unconfirmed: "状态待确认", paused: "待继续", completed: "已完成", failed: "失败", cancelled: "已取消" };

export interface RecoveryClient {
  isAvailable(): Promise<boolean>;
  probeJob(jobId: string, saveNodeId: string): Promise<ComfyJobProbe>;
}

export type WatchOutcome =
  | { phase: "completed"; file: ComfyFile }
  | { phase: "failed"; error: string }
  | { phase: "unconfirmed" | "paused"; reason: string }
  | { phase: "completed_local"; source: string; filename: string }
  | { phase: "settled"; status: "completed" | "failed" | "cancelled"; reason: string }
  /** ComfyUI is online, has it in neither queue nor history, and the Run is long past any submit race: it will never finish. */
  | { phase: "lost"; reason: string }
  | { phase: "detached" };

export interface WatchOptions {
  /** Read only this Run's persisted checkpoint. Never submit, merge or alter a step here. */
  readEnhancement?: (runId: string) => Promise<EnhancementCheckpoint | null>;
  readRunState?: (runId: string) => Promise<{status: RunRecord['status']; error?: string | null} | null>;
  signal?: AbortSignal;
  onPhase?: (phase: RecoveryPhase, stage: string) => void;
  /** Called once when ComfyUI reports the job running (the Run may still say "queued"). */
  onRunning?: (startedAt?:number) => void;
  onTiming?: (timing:{startedAt?:number;completedAt?:number})=>void;
  pollMs?: number;
  reconnectMs?: number;
  /**
   * Opt-in. When set, a Run whose last activity (startedAt, else createdAt) is at least this old and that ComfyUI
   * (reachable) still cannot find ends as "lost" instead of "unconfirmed". Nothing is submitted or cancelled; the
   * caller only settles the local record. Unset → old behaviour ("unconfirmed" forever).
   */
  lostAfterMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  // The watcher reuses one signal across polls: detach on a normal wake so listeners don't pile up.
  const onAbort = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

/**
 * Re-attach to a submitted job. Loops while it is queued/running or ComfyUI is unreachable.
 * Never resubmits. "not_found" twice in a row (queue and history both empty for this ID) ends as
 * "unconfirmed": the job may never have been accepted, or ComfyUI restarted and lost its history.
 */
async function watchEnhancement(runId: string, client: RecoveryClient, options: WatchOptions): Promise<WatchOutcome> {
  if (!options.readEnhancement) return {phase:'unconfirmed',reason:'缺少分段检查点读取接口，不能安全确认任务；未重新提交'};
  const {signal, onPhase, pollMs=1500, reconnectMs=5000, sleep=defaultSleep}=options;
  let lastPrompt='', missing=0, finished=0, announcedRunning=false;
  while (!signal?.aborted) {
    const latest=await options.readRunState?.(runId);
    if (signal?.aborted) break;
    if (latest && (latest.status==='completed'||latest.status==='failed'||latest.status==='cancelled')) return {phase:'settled',status:latest.status,reason:latest.error??'原任务已结束'};
    const checkpoint=await options.readEnhancement(runId);
    if (signal?.aborted) break;
    if (!checkpoint || checkpoint.version!==1 || checkpoint.runId!==runId || !Array.isArray(checkpoint.steps)) return {phase:'unconfirmed',reason:'本节点分段检查点缺失或不匹配，无法确认；不会使用其它节点的任务ID'};
    if (checkpoint.finalSource && checkpoint.finalName) return {phase:'completed_local',source:checkpoint.finalSource,filename:checkpoint.finalName};
    const pending=checkpoint.steps.filter(step=>step.state==='reserved'||step.state==='accepted');
    if (pending.length>1) return {phase:'unconfirmed',reason:'本任务存在多个未确认分段，停止自动判断以免串用任务'};
    const step=pending[0];
    const done=checkpoint.steps.filter(step=>step.state==='completed').length;
    if (!step) return {phase:'paused',reason:done===checkpoint.steps.length?'所有分段已保存，待继续合并最终视频（不会重新渲染成功段）':`已保存 ${done}/${checkpoint.steps.length} 个分段，当前没有已提交的后续分段；若原页面仍在准备请等待，否则点击“继续分段任务”`};
    if (!step.promptId) return {phase:'unconfirmed',reason:'当前分段缺少任务ID，不能安全查询；不会重新提交'};
    if (lastPrompt!==step.promptId) { lastPrompt=step.promptId;missing=0;finished=0; }
    let probe: ComfyJobProbe;
    try {
      if (!await client.isAvailable()) throw Error('offline');
      probe=await client.probeJob(step.promptId,step.stage==='upscale'?SAVE_NODES.seedvr2_upscale:FILM_SAVE_NODE_ID);
    } catch {
      if (signal?.aborted) break;
      missing=0;finished=0;
      onPhase?.('waiting_connection','ComfyUI 未连接，等待重新查询本节点分段任务（不会重提）');
      await sleep(reconnectMs,signal);continue;
    }
    if (signal?.aborted) break;
    const label=`${step.stage==='upscale'?'高清':'60 FPS插帧'} 第${step.segment.index+1}/${checkpoint.plan.segments.length}段 · 已保存 ${done}/${checkpoint.steps.length}`;
    if (probe.state==='failed') return {phase:'failed',error:`${label}：${probe.error||'ComfyUI 任务失败'}`};
    if (probe.state==='queued'||probe.state==='running') {
      missing=0;finished=0;
      if (probe.state==='running'&&!announcedRunning) {announcedRunning=true;options.onRunning?.();}
      onPhase?.(probe.state,`${label} · ${probe.state==='queued'?'等待 ComfyUI 队列':'ComfyUI 正在执行'}`);
    } else if (probe.state==='completed') {
      missing=0;finished++;
      // Let a live owner save/advance its checkpoint; a segment is NEVER a whole output.
      onPhase?.('running',`${label} · 当前段已完成，等待原页面登记或推进下一段`);
      if (finished>=3) return {phase:'paused',reason:`${label} · 当前段已完成，待继续取回并处理后续；不会重复渲染已成功的段`};
    } else {
      finished=0;missing++;
      if (missing>=2) return {phase:'unconfirmed',reason:`${label} · ComfyUI 队列和历史中找不到此分段，可能尚未提交或历史已清空；不会重提`};
      onPhase?.('submitting',`${label} · 正在核对当前分段是否已提交`);
    }
    await sleep(pollMs,signal);
  }
  return {phase:'detached'};
}

export const LOST_RUN_AFTER_MS = 10 * 60_000;
export const LOST_RUN_REASON = "ComfyUI 正常在线，但队列和历史里都找不到这个任务（ComfyUI 多半重启过，任务已经没了）。已自动结束；没有重新提交，也没有取消任何 ComfyUI 任务。需要的话请手动重新生成。";
export async function watchRun(run: Pick<RunRecord, "runId" | "capabilityId" | "comfyPromptId" | "submission"> & { parameters?: RunRecord["parameters"]; createdAt?: number; startedAt?: number | null }, client: RecoveryClient, options: WatchOptions = {}): Promise<WatchOutcome> {
  if(run.parameters?.enhancementPipeline === true) return watchEnhancement(run.runId, client, options);
  if(run.parameters?.segmentedUpscale === true) return {phase:'unconfirmed',reason:'分段高清页面已中断：当前 ComfyUI 输出仅是一段，不能当作完整视频。不会自动重提任务；请确认当前段结束后放弃此任务并重试。'};
  const { signal, onPhase, onRunning, pollMs = 1_500, reconnectMs = 5_000, sleep = defaultSleep } = options;
  if (!run.comfyPromptId) return { phase: "unconfirmed", reason: "刷新前未记录 ComfyUI 任务 ID，无法确认任务状态" };
  const jobId = run.comfyPromptId;
  const saveNodeId = saveNodeForRun(run);
  let notFound = 0;
  let announcedRunning = false;
  while (!signal?.aborted) {
    let probe: ComfyJobProbe;
    try {
      if (!(await client.isAvailable())) throw new Error("offline");
      probe = await client.probeJob(jobId, saveNodeId);
    } catch {
      onPhase?.("waiting_connection", "ComfyUI 未连接，任务状态待确认");
      await sleep(reconnectMs, signal);
      continue;
    }
    if (signal?.aborted) break;
    if (probe.state === "completed" && probe.file) {options.onTiming?.({startedAt:probe.startedAt,completedAt:probe.completedAt});return { phase: "completed", file: probe.file };}
    if (probe.state === "failed") return { phase: "failed", error: probe.error || "ComfyUI 生成失败" };
    if (probe.state === "queued" || probe.state === "running") {
      notFound = 0;
      if (probe.state === "running" && !announcedRunning) { announcedRunning = true; onRunning?.(); }
      onPhase?.(probe.state, probe.state === "queued" ? "等待 ComfyUI 队列" : "ComfyUI 正在执行");
      await sleep(pollMs, signal);
      continue;
    }
    notFound += 1;
    const lastActivity = run.startedAt ?? run.createdAt;
    if (notFound >= 2 && options.lostAfterMs !== undefined && typeof lastActivity === "number" && (options.now ?? Date.now)() - lastActivity >= options.lostAfterMs) return { phase: "lost", reason: LOST_RUN_REASON };
    if (notFound >= 2) return { phase: "unconfirmed", reason: run.submission === "reserved" ? "ComfyUI 中找不到此任务：可能提交前页面已关闭，或 ComfyUI 已重启" : "ComfyUI 中找不到此任务（ComfyUI 可能已重启，历史记录已清空）" };
    await sleep(Math.min(pollMs, 1_000), signal);
  }
  return { phase: "detached" };
}

/** Cross-tab exclusive section when Web Locks exist; in-process chain otherwise (tests, old browsers). */
const localLocks = new Map<string, Promise<unknown>>();
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: { request: (name: string, fn: () => Promise<T>) => Promise<T> } } }).navigator?.locks;
  if (locks?.request) return locks.request(name, fn);
  const previous = localLocks.get(name) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  localLocks.set(name, next);
  try { return await next; } finally { if (localLocks.get(name) === next) localLocks.delete(name); }
}

export interface FinalizeStore {
  getRun(runId: string): Promise<RunRecord | null>;
  getAsset(assetId: string): Promise<AssetRecord | null>;
  listAssets(kind?: "video"): Promise<AssetRecord[]>;
  updateRun(runId: string, changes: Partial<Pick<RunRecord, "status" | "completedAt" | "outputAssetIds" | "comfyPromptId" | "submission">>,signal?:AbortSignal): Promise<RunRecord>;
}

/**
 * Idempotent output registration: one Run → one output Asset, no matter how many times
 * WS, HTTP polling, a refresh or a second tab reach "completed".
 * 1. Run already lists outputAssetIds → reuse.  2. An Asset with sourceRunId = Run exists
 *    (crash after Asset write, before Run update) → attach it.  3. Otherwise produce once.
 */
export function finalizeRunOutput(runId: string, store: FinalizeStore, produce: (run: RunRecord,signal?:AbortSignal) => Promise<AssetRecord>,signal?:AbortSignal):Promise<{asset:AssetRecord;created:boolean;run:RunRecord}> {
  const finish = async (attemptSignal=signal) => {
    const check=()=>attemptSignal?.throwIfAborted();
    check();const run = await store.getRun(runId);
    check();if (!run) throw new Error("生成记录不存在");
    if (run.outputAssetIds.length) {
      const existing = await store.getAsset(run.outputAssetIds[0]);
      if (existing) return { asset: existing, created: false, run };
    }
    const orphan = (await store.listAssets("video")).find((asset) => asset.sourceRunId === runId);
    if (orphan) {
      check();const updated = await store.updateRun(runId, { status: "completed", completedAt: run.completedAt ?? Date.now(), outputAssetIds: [orphan.assetId] },attemptSignal);
      return { asset: orphan, created: false, run: updated };
    }
    check();const asset = await produce(run,attemptSignal);check();
    const fresh = await store.getRun(runId);
    check();const updated = await store.updateRun(runId, { status: "completed", completedAt: fresh?.completedAt ?? Date.now(), outputAssetIds: [asset.assetId], ...(run.submission === "reserved" ? { submission: "accepted" as const } : {}) },attemptSignal);
    return { asset, created: true, run: updated };
  };
  if(signal)return boundedLock(`frameflow-run-output-${runId}`,async scope=>{scope.check();return finish(scope.signal);},{signal,waitMs:1000,workMs:25000}).then(value=>{if(!value)throw Error('取片锁未取得');return value;});
  // Waiting forever for a holder stuck in video metadata froze the whole file-service tick.
  const locks = (globalThis as { navigator?: { locks?: { request: (name: string, options: { signal?: AbortSignal }, fn: () => Promise<unknown>) => Promise<unknown> } } }).navigator?.locks;
  if (locks?.request) return locks.request(`frameflow-run-output-${runId}`, { signal: AbortSignal.timeout(25_000) }, ()=>finish()) as Promise<{asset:AssetRecord;created:boolean;run:RunRecord}>;
  return withLock(`frameflow-run-output-${runId}`, ()=>finish());
}

/**
 * Duplicate-submit guard for one canvas node.
 * - claimNode(): synchronous, so a second click in the same tick is rejected before any await.
 * - createRunExclusively(): under a cross-tab lock, refuses when the node already has an active Run.
 */
const claimedNodes = new Set<string>();
export function claimNode(nodeId: string) {
  if (isNodeBeingRemoved(nodeId)) return null;
  if (claimedNodes.has(nodeId)) return null;
  claimedNodes.add(nodeId);
  let released = false;
  return () => { if (!released) { released = true; claimedNodes.delete(nodeId); } };
}
/** User cancel must drop the claim before the in-flight function reaches finally, or delete stays blocked. */
export function releaseNodeClaim(nodeId: string) { claimedNodes.delete(nodeId); }
export const isNodeClaimed = (nodeId: string) => claimedNodes.has(nodeId);

export const ACTIVE_RUN_ERROR = "该节点已有进行中的任务，请等待完成或先取消";
export function createRunExclusively(nodeId: string, listRuns: () => Promise<RunRecord[]>, create: (signal?:AbortSignal) => Promise<RunRecord>,signal?:AbortSignal) {
  const run=async(attemptSignal=signal)=>{attemptSignal?.throwIfAborted();const runs=await listRuns();attemptSignal?.throwIfAborted();if(findActiveRunForNode(nodeId,runs))throw new Error(ACTIVE_RUN_ERROR);return create(attemptSignal);};
  if(signal)return boundedLock(`frameflow-node-submit-${nodeId}`,async scope=>{scope.check();return run(scope.signal);},{signal,waitMs:3000,workMs:15000}).then(value=>{if(!value)throw Error(ACTIVE_RUN_ERROR);return value;});
  return withLock(`frameflow-node-submit-${nodeId}`,()=>run());
}

/**
 * Phase 9: calls made in the same tick share one read that starts after all of them (on the next
 * macrotask). A broadcast that makes N nodes re-check therefore costs one Run read instead of N,
 * and the read is never older than the change that triggered it.
 */
export function createTickBatcher<T>(read: () => Promise<T>, schedule: (fn: () => void) => void = (fn) => { setTimeout(fn, 0); }) {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) pending = new Promise<void>((resolve) => schedule(resolve)).then(() => { pending = null; return read(); });
    return pending;
  };
}
