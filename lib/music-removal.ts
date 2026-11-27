/**
 * 去配乐（CDX23，Frameflow-Demix 节点）on the canvas: queue, Run record, result → new version of the same video.
 *
 * - One video = one ComfyUI job. Jobs go out one at a time (the next is submitted only after the previous
 *   finished), through the same submission scheduler as every other job, so they line up behind the H3 jobs
 *   already in ComfyUI and never hold the GPU for a whole batch.
 * - The original video is never changed. The result is a new Asset (`derivationType: "music_removal"`,
 *   `sourceVideoAssetId` = original) produced by a `music_removal` Run on the same Shot, so the H3 node lists it
 *   as a version of the same candidate (候选B → 去配乐) and A/B/C letters do not move.
 * - Job state lives in one meta row (`music-removal-v1`) keyed by the original asset id, so a node can show
 *   排队中 / 处理中 / 失败 / 已去配乐 without scanning every Run.
 * - Refresh: a job that was only waiting in this tab's memory was never sent; it is marked failed with a clear
 *   message (no GPU used, can be retried). A job already reserved / sent is looked up again by its prompt id
 *   (= Run id). Nothing here ever re-sends a job by itself.
 * - Passes (用户 2026-11-11：二遍明显更好，但只在需要时手动做): every job is ONE CDX23 pass. An original gets pass 1;
 *   a 1-pass 去配乐版 may get pass 2 by hand (「再去一次」 → new version 「候选C → 去配乐 ×2」, both earlier versions kept);
 *   a 2-pass version is never processed again (已处理过).
 */
import { createRun, getAsset, getMeta, getRun, patchMeta, registerAsset, updateRun, addRunToShot, markShotHasCandidates, isH3Capability, type AssetRecord, type MusicRemovalPass, type RunRecord } from "./production-records.ts";
import { inspectMediaWorkflow, mediaRequest, type MediaJobOptions } from "./comfyui/media-workflow-job.ts";
import { scheduledPromptFetch } from "./comfyui/submission-scheduler.ts";
import { COMFYUI_PROXY_PATH } from "./comfyui/config.ts";
import { formatComfyNodeErrors } from "./comfyui/node-errors.ts";
import { withLock } from "./run-recovery.ts";
import { buildMusicRemovalWorkflow, readDemixOutput, DEFAULT_MUSIC_REMOVAL, MUSIC_REMOVAL_LOAD_NODE, MUSIC_REMOVAL_MODEL, MUSIC_REMOVAL_SAVE_NODE, MUSIC_REMOVAL_TEMPLATE_FILE, type DemixNodeOutput, type MusicRemovalSettings } from "./comfyui/music-removal-workflow.ts";

export const MUSIC_REMOVAL_STATE_KEY = "music-removal-v1";
export const MUSIC_REMOVAL_CHANNEL = "frameflow-music-removal";
export type DemixJobState = "waiting" | "running" | "done" | "skipped" | "failed";
export interface DemixJob {
  sourceAssetId: string;
  state: DemixJobState;
  runId?: string;
  outputAssetId?: string;
  error?: string;
  /** Short progress text: 上传原视频 / ComfyUI排队中 / 正在去配乐 / 保存结果. */
  stage?: string;
  /** Started by 「出片后自动去配乐」. */
  auto?: boolean;
  /** Canvas node that asked (display hint only). */
  nodeId?: string;
  /** Tab that holds a waiting job in memory (to tell a live queue from one lost on refresh). */
  tabId?: string;
  device?: string;
  updatedAt: number;
}
export interface DemixStateRow { version: 1; jobs: Record<string, DemixJob> }

export interface MusicRemovalIO {
  fetch: typeof fetch;
  loadVideo(source: string): Promise<Blob>;
  storeVideo(blob: Blob, name: string): Promise<string>;
  readMetadata(blob: Blob): Promise<{ width?: number; height?: number; duration?: number }>;
  onShotChanged?(shotId: string): void;
  /** Best effort: give the new file a cover image (same picture as the original). Never fails the job. */
  onOutputStored?(originalReference: string | undefined, outputReference: string, blob: Blob): Promise<void> | void;
  /** True when the tab that queued a waiting job is still open. */
  tabAlive?(tabId: string): Promise<boolean>;
  pollMs?: number;
  now?(): number;
}

const TERMINAL: DemixJobState[] = ["done", "skipped", "failed"];
export const isActiveDemix = (job: DemixJob | undefined) => !!job && (job.state === "waiting" || job.state === "running");
export const demixJobLabel = (job: DemixJob | undefined) => !job ? "去配乐" : job.state === "waiting" ? "去配乐排队中" : job.state === "running" ? (job.stage || "正在去配乐") : job.state === "done" ? "已去配乐" : job.state === "skipped" ? "已处理过" : "去配乐失败";

let tabId = "";
export const currentDemixTab = () => tabId || (tabId = `tab-${crypto.randomUUID()}`);

// ---- state row (one meta record; cached + subscribed) ----
let cache: DemixStateRow | null = null;
let cacheReady: Promise<DemixStateRow> | null = null;
const listeners = new Set<(row: DemixStateRow) => void>();
let channel: BroadcastChannel | null | undefined;
function openChannel() {
  if (channel !== undefined) return channel;
  channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(MUSIC_REMOVAL_CHANNEL);
  (channel as unknown as { unref?: () => void } | null)?.unref?.();
  if (channel) channel.onmessage = () => { void refreshDemixJobs(); };
  return channel;
}
const empty = (): DemixStateRow => ({ version: 1, jobs: {} });
function publish(row: DemixStateRow) { cache = row; for (const listener of listeners) listener(row); }
export async function refreshDemixJobs() {
  const row = (await getMeta<DemixStateRow>(MUSIC_REMOVAL_STATE_KEY)) ?? empty();
  publish(row);
  return row;
}
export function readDemixJobs(): Promise<DemixStateRow> {
  if (cache) return Promise.resolve(cache);
  openChannel();
  return cacheReady ??= refreshDemixJobs().finally(() => { cacheReady = null; });
}
export const peekDemixJobs = () => cache;
export function subscribeDemixJobs(listener: (row: DemixStateRow) => void) {
  listeners.add(listener); void readDemixJobs().then(listener).catch(() => {});
  return () => { listeners.delete(listener); };
}
/** Atomic change of the row. `change` returns the new job, `null` to delete, or `undefined` for no change. */
let writes: Promise<unknown> = Promise.resolve();
/** Same-tab writes go one after another (IndexedDB also serialises them across tabs). */
function changeJob(sourceAssetId: string, change: (job: DemixJob | undefined) => DemixJob | null | undefined): Promise<DemixJob | undefined> {
  const next = writes.then(() => writeJob(sourceAssetId, change));
  writes = next.catch(() => {});
  return next;
}
async function writeJob(sourceAssetId: string, change: (job: DemixJob | undefined) => DemixJob | null | undefined) {
  let result: DemixJob | undefined;
  const row = await patchMeta<DemixStateRow>(MUSIC_REMOVAL_STATE_KEY, (current) => {
    const value = current?.version === 1 ? current : empty();
    const next = change(value.jobs[sourceAssetId]);
    if (next === undefined) { result = value.jobs[sourceAssetId]; return null; }
    const jobs = { ...value.jobs };
    if (next === null) delete jobs[sourceAssetId]; else jobs[sourceAssetId] = next;
    result = next ?? undefined;
    return { version: 1, jobs };
  });
  if (row) { publish(row); openChannel()?.postMessage({ sourceAssetId }); }
  else if (!cache) await refreshDemixJobs();
  return result;
}

// ---- passes ----
/** 「再去一次」 is allowed once: 1 pass → 2 passes. */
export const MAX_MUSIC_REMOVAL_PASSES = 2;
/** How many 去配乐 passes this video already went through (0 = an original). Older outputs = 1. */
export const musicRemovalPassesOf = (asset: Pick<AssetRecord, "derivationType" | "musicRemovalPasses"> | null | undefined) =>
  asset?.derivationType === "music_removal" ? Math.max(1, asset.musicRemovalPasses ?? 1) : 0;
export const demixPassLabel = (total: number) => total > 1 ? `去配乐 ×${total}` : "去配乐";

// ---- queue ----
export type EnqueueResult = { queued: true; pass: number } | { queued: false; reason: "already_done" | "already_skipped" | "active" | "is_output" | "max_passes" | "missing" | "not_video" };
export const enqueueReasonText: Record<Exclude<EnqueueResult, { queued: true }>["reason"], string> = {
  already_done: "这个视频已经去过配乐",
  already_skipped: "这个视频已处理过",
  active: "这个视频正在去配乐",
  is_output: "这已经是去配乐版本",
  max_passes: `已处理过（已经去过 ${MAX_MUSIC_REMOVAL_PASSES} 遍配乐）`,
  missing: "找不到这个视频的素材记录",
  not_video: "只能给视频去配乐",
};
let io: MusicRemovalIO | null = null;
const pending: string[] = [];
let draining: Promise<void> | null = null;
export function configureMusicRemoval(next: MusicRemovalIO) { io = next; }
const need = () => { if (!io) throw new Error("去配乐还没初始化"); return io; };
const now = () => io?.now?.() ?? Date.now();

/**
 * Put one video in the queue (one CDX23 pass). An original → pass 1; a 去配乐版 with 1 pass → pass 2 (「再去一次」).
 * Already processed / running videos and 2-pass versions are refused with a reason, never re-run.
 */
export async function enqueueMusicRemoval(input: { sourceAssetId: string; nodeId?: string; auto?: boolean; retry?: boolean }): Promise<EnqueueResult> {
  const asset = await getAsset(input.sourceAssetId);
  if (!asset) return { queued: false, reason: "missing" };
  if (asset.kind !== "video") return { queued: false, reason: "not_video" };
  const done = musicRemovalPassesOf(asset);
  if (done >= MAX_MUSIC_REMOVAL_PASSES) return { queued: false, reason: "max_passes" };
  let refused: EnqueueResult | null = null;
  await changeJob(input.sourceAssetId, (job) => {
    if (job && isActiveDemix(job)) { refused = { queued: false, reason: "active" }; return undefined; }
    if (job?.state === "done") { refused = { queued: false, reason: "already_done" }; return undefined; }
    if (job?.state === "skipped" && !input.retry) { refused = { queued: false, reason: "already_skipped" }; return undefined; }
    return { sourceAssetId: input.sourceAssetId, state: "waiting", auto: input.auto ?? false, ...(input.nodeId ? { nodeId: input.nodeId } : {}), tabId: currentDemixTab(), stage: "排队等待提交", updatedAt: now() };
  });
  if (refused) return refused;
  pending.push(input.sourceAssetId);
  void drain();
  return { queued: true, pass: done + 1 };
}

/** Withdraw jobs that were not sent to ComfyUI yet (nothing already sent is cancelled). */
export async function withdrawWaiting(sourceAssetIds: string[]) {
  let count = 0;
  for (const id of sourceAssetIds) {
    const index = pending.indexOf(id);
    if (index >= 0) pending.splice(index, 1);
    // Only this tab's waiting jobs; processOne claims a job (waiting → running) before it reads or sends anything.
    await changeJob(id, (job) => job?.state === "waiting" && job.tabId === currentDemixTab() ? (count++, null) : undefined);
  }
  return count;
}

export const musicRemovalQueueLength = () => pending.length + (draining ? 1 : 0);
export function drainMusicRemoval() { return drain(); }
function drain(): Promise<void> {
  return draining ??= (async () => {
    try {
      while (pending.length) {
        const id = pending.shift()!;
        await withLock(`frameflow-music-removal-${id}`, () => processOne(id)).catch(() => {});
      }
    } finally { draining = null; }
  })();
}

async function failJob(sourceAssetId: string, error: string, runId?: string) {
  if (runId) await updateRun(runId, { status: "failed", completedAt: now(), error }).catch(() => {});
  await changeJob(sourceAssetId, (job) => ({ ...(job ?? { sourceAssetId }), state: "failed", error, stage: undefined, tabId: undefined, updatedAt: now() }));
}

type SavedFile = { filename: string; subfolder?: string; type?: string };
type PassOutcome = { kind: "done"; file: SavedFile; info: { device?: string; seconds?: number } } | { kind: "skipped"; info: { reason?: string; device?: string } } | null;
const outputPath = (file: SavedFile) => [file.subfolder, file.filename].filter(Boolean).join("/");

async function processOne(sourceAssetId: string, settings: MusicRemovalSettings = DEFAULT_MUSIC_REMOVAL) {
  const deps = need();
  let latest: DemixJob | undefined;
  await changeJob(sourceAssetId, (job) => job?.state === "waiting" ? (latest = { ...job, state: "running", stage: "读取原视频", updatedAt: now() }) : undefined);
  if (!latest) return;
  const asset = await getAsset(sourceAssetId);
  if (!asset) return failJob(sourceAssetId, "原视频的素材记录不见了，没有提交");
  let blob: Blob;
  try { blob = await deps.loadVideo(asset.storageReference); if (!blob.size) throw new Error("视频是空的"); }
  catch (cause) { return failJob(sourceAssetId, `读不到原视频，没有提交：${cause instanceof Error ? cause.message : String(cause)}`); }
  const already = musicRemovalPassesOf(asset);
  const pass = already + 1;
  // Pass 1 of an original: the node skips a file it already demixed. 「再去一次」 (pass 2) must run again.
  const passSettings: MusicRemovalSettings = { ...settings, ifAlreadyDemixed: already > 0 ? "run_again" : settings.ifAlreadyDemixed };
  const run = await createRun({
    capabilityId: "music_removal", inputAssetIds: [sourceAssetId], rawPrompt: null, finalPrompt: null, seed: null, shotId: asset.shotId,
    referenceInputs: [{ assetId: sourceAssetId, kind: "video", role: "source_video", order: 0 }],
    parameters: { model: MUSIC_REMOVAL_MODEL, quality: settings.quality, modelCount: settings.quality === "high" ? 3 : 1, device: settings.device, musicGainDb: settings.musicGainDb, ifAlreadyDemixed: passSettings.ifAlreadyDemixed, pass, previousPasses: already, keeps: "dialogue+effects", sourceTag: sourceAssetId, inputFilename: asset.filename, auto: latest.auto ?? false, ...(latest.nodeId ? { canvasNodeId: latest.nodeId } : {}) },
    workflowIdentity: { capabilityId: "music_removal", templateVersion: "frameflow-demix-video-v1", templateFile: MUSIC_REMOVAL_TEMPLATE_FILE },
  }, { reservePromptId: true });
  await changeJob(sourceAssetId, (job) => ({ ...(job ?? { sourceAssetId }), state: "running", runId: run.runId, stage: pass > 1 ? "再去一次：检查节点" : "检查节点", error: undefined, updatedAt: now() }));
  const records: MusicRemovalPass[] = [{ pass, promptId: run.runId, input: asset.filename, inputAssetId: sourceAssetId, startedAt: now() }];
  // Written before anything is sent, so a refresh can look the pass up instead of sending it again.
  await updateRun(run.runId, { musicRemoval: { status: "running", passes: records.map((item) => ({ ...item })), totalPasses: pass } });
  if (!await submitPass(run.runId, sourceAssetId, run.runId, blob, passSettings, pass)) return;
  const outcome = await waitPass(run.runId, sourceAssetId, run.runId, pass);
  if (!outcome) return;
  if (outcome.kind === "skipped") {
    if (already === 0) return markSkipped(run.runId, sourceAssetId, outcome.info);
    return failJob(sourceAssetId, "再去一次被节点跳过了（不应该发生），没有结果", run.runId);
  }
  Object.assign(records[0], { output: outputPath(outcome.file), outputFile: outcome.file, device: outcome.info.device, seconds: outcome.info.seconds, completedAt: now() });
  return finish(run.runId, sourceAssetId, records);
}

/** Upload + send one pass. false = failed (already recorded). Network trouble after the POST only looks the job up. */
async function submitPass(runId: string, sourceAssetId: string, promptId: string, input: Blob, settings: MusicRemovalSettings, pass: number) {
  const deps = need();
  const options: MediaJobOptions = { fetch: deps.fetch };
  const stage = (text: string) => changeJob(sourceAssetId, (job) => job?.runId === runId && job.state === "running" ? { ...job, stage: `${pass > 1 ? "再去一次：" : ""}${text}`, updatedAt: now() } : undefined);
  const graph = buildMusicRemovalWorkflow("input.mp4", sourceAssetId, settings);
  let submitted: MediaGraph;
  try {
    const inspection = await inspectMediaWorkflow(graph, options);
    if (inspection.errors.length) throw new Error(`${inspection.errors.join("；")}（ComfyUI 里没有去配乐节点，请确认 Frameflow-Demix 已装好并重启过 ComfyUI）`);
    submitted = inspection.graph;
    await stage(pass === 1 ? "上传原视频" : "上传去配乐版");
    const form = new FormData();
    form.append("image", input, `frameflow_demix_${crypto.randomUUID()}.mp4`); form.append("type", "input"); form.append("overwrite", "false");
    const file = await (await mediaRequest("/upload/image", options, { method: "POST", body: form })).json() as { name?: string; subfolder?: string };
    if (!file.name) throw new Error("上传视频失败：ComfyUI 没有返回文件名");
    submitted[MUSIC_REMOVAL_LOAD_NODE].inputs.file = [file.subfolder, file.name].filter(Boolean).join("/");
  } catch (cause) {
    await failJob(sourceAssetId, `没有提交（没占显卡）：${cause instanceof Error ? cause.message : String(cause)}`, runId);
    return false;
  }
  await stage("提交到 ComfyUI 队列");
  let response: Response;
  try {
    response = await scheduledPromptFetch(`${COMFYUI_PROXY_PATH}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: submitted, prompt_id: promptId, client_id: `frameflow-demix-${runId}` }) }, deps.fetch);
  } catch { return true; } // may or may not have arrived: only look it up, never send it again
  const body = await response.json().catch(() => null) as { node_errors?: Record<string, unknown>; error?: { message?: string } } | null;
  if (!response.ok) { await failJob(sourceAssetId, `ComfyUI 拒绝了任务：${formatComfyNodeErrors(body?.node_errors) || body?.error?.message || `HTTP ${response.status}`}`, runId); return false; }
  await updateRun(runId, { submission: "accepted" });
  return true;
}
type MediaGraph = ReturnType<typeof buildMusicRemovalWorkflow>;

type HistoryEntry = { status?: { completed?: boolean; status_str?: string; messages?: [string, { exception_message?: string }][] }; outputs?: Record<string, DemixNodeOutput> };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Look one pass up by its prompt id until it finishes. Never re-sends. null = failed (already recorded). */
async function waitPass(runId: string, sourceAssetId: string, promptId: string, pass: number): Promise<PassOutcome> {
  const deps = need();
  const options: MediaJobOptions = { fetch: deps.fetch };
  const label = (text: string) => `${pass > 1 ? "再去一次：" : ""}${text}`;
  const stage = (text: string) => changeJob(sourceAssetId, (job) => job?.runId === runId && job.state === "running" && job.stage !== label(text) ? { ...job, stage: label(text), updatedAt: now() } : undefined);
  let missing = 0, unreachable = 0, markedRunning = false;
  for (;;) {
    let entry: HistoryEntry | undefined;
    let place: "running" | "pending" | "none" = "none";
    try {
      entry = (await (await mediaRequest(`/history/${encodeURIComponent(promptId)}`, options, { cache: "no-store" })).json() as Record<string, HistoryEntry>)[promptId];
      if (!entry) {
        const queue = await (await mediaRequest("/queue", options, { cache: "no-store" })).json() as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
        place = queue.queue_running?.some((item) => item[1] === promptId) ? "running" : queue.queue_pending?.some((item) => item[1] === promptId) ? "pending" : "none";
      }
      unreachable = 0;
    } catch {
      if (++unreachable >= 40) { await failJob(sourceAssetId, `连不上 ComfyUI，暂停查询；任务可能还在 ComfyUI 里，刷新页面会再查一次，没有自动重新提交`, runId); return null; }
      await stage("等待连接 ComfyUI"); await sleep(deps.pollMs ?? 1500); continue;
    }
    const failure = entry?.status?.messages?.find(([type]) => type === "execution_error" || type === "execution_interrupted");
    if (entry?.status?.status_str === "error" || failure) { await failJob(sourceAssetId, `去配乐失败：${failure?.[1]?.exception_message ?? "任务失败或被中断"}`, runId); return null; }
    const result = entry ? readDemixOutput(entry.outputs?.[MUSIC_REMOVAL_SAVE_NODE]) : null;
    if (result?.kind === "skipped") return { kind: "skipped", info: result.info };
    if (result?.kind === "done") return { kind: "done", file: result.file, info: result.info };
    if (entry?.status?.completed) { await failJob(sourceAssetId, `任务结束了，但没有找到去配乐后的视频文件`, runId); return null; }
    if (entry || place !== "none") {
      missing = 0;
      if (place === "running" && !markedRunning) { markedRunning = true; await updateRun(runId, { status: "running", startedAt: now() }); }
      await stage(place === "pending" ? "ComfyUI排队中" : "正在去配乐");
    } else if (++missing >= 3) { await failJob(sourceAssetId, `ComfyUI 的队列和历史里都没有这个任务（可能没提交成功，或 ComfyUI 重启过）；没有自动重新提交，可以点重试`, runId); return null; }
    await sleep(deps.pollMs ?? 1500);
  }
}

async function markSkipped(runId: string, sourceAssetId: string, info: { reason?: string; device?: string }) {
  await updateRun(runId, { status: "completed", completedAt: now(), outputAssetIds: [], musicRemoval: { status: "skipped", reason: info.reason ?? "already_demixed", device: info.device } });
  await changeJob(sourceAssetId, (job) => ({ ...(job ?? { sourceAssetId }), state: "skipped", runId, stage: undefined, tabId: undefined, error: undefined, updatedAt: now() }));
}

/** Last pass done: download its file, register ONE new version (×N), record every pass on the Run. */
async function finish(runId: string, sourceAssetId: string, records: MusicRemovalPass[]) {
  const deps = need();
  const last = records[records.length - 1];
  const file = last.outputFile!;
  try {
    await changeJob(sourceAssetId, (job) => job?.runId === runId ? { ...job, stage: "保存结果到画布", updatedAt: now() } : undefined);
    const current = await getRun(runId);
    if (current?.status === "completed" && current.outputAssetIds[0]) {
      // Another tab already attached it.
      await changeJob(sourceAssetId, (job) => ({ ...(job ?? { sourceAssetId }), state: "done", runId, outputAssetId: current.outputAssetIds[0], stage: undefined, tabId: undefined, updatedAt: now() }));
      return;
    }
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
    const raw = await (await mediaRequest(`/view?${query}`, { fetch: deps.fetch })).blob();
    if (!raw.size) throw new Error("去配乐后的视频文件是空的");
    const blob = raw.slice(0, raw.size, "video/mp4");
    const source = await getAsset(sourceAssetId);
    const total = last.pass;
    const root = source?.derivationType === "music_removal" && source.sourceVideoAssetId ? await getAsset(source.sourceVideoAssetId) : source;
    const name = `${(source?.filename ?? "视频").replace(/\.mp4$/i, "").replace(/-去配乐(x\d+)?$/, "")}-去配乐${total > 1 ? `x${total}` : ""}.mp4`;
    const storageReference = await deps.storeVideo(blob, name);
    try { await deps.onOutputStored?.(root?.storageReference ?? source?.storageReference, storageReference, blob); } catch { /* cover image only */ }
    const metadata = await deps.readMetadata(blob).catch(() => ({} as { width?: number; height?: number; duration?: number }));
    const asset = await registerAsset({
      kind: "video", origin: "generated", filename: name, mimeType: "video/mp4", storageReference, sourceRunId: runId,
      ...(source?.shotId ? { shotId: source.shotId } : {}), fileSize: blob.size,
      width: metadata.width ?? source?.width, height: metadata.height ?? source?.height, duration: metadata.duration ?? source?.duration, fps: source?.fps,
      // Always the untouched original, so every 去配乐 version hangs under the same candidate.
      derivationType: "music_removal", sourceVideoAssetId: root?.assetId ?? sourceAssetId, musicRemovalPasses: total,
    });
    const passes = records.map(({ outputFile: _file, ...item }) => item);
    const seconds = passes.reduce((sum, item) => sum + (item.seconds ?? 0), 0);
    await updateRun(runId, { status: "completed", completedAt: now(), outputAssetIds: [asset.assetId], error: null, musicRemoval: { status: "done", device: last.device, seconds: Math.round(seconds * 10) / 10, output: last.output, passes, totalPasses: total } });
    if (source?.shotId) { await addRunToShot(source.shotId, runId); await markShotHasCandidates(source.shotId); deps.onShotChanged?.(source.shotId); }
    await changeJob(sourceAssetId, (job) => ({ ...(job ?? { sourceAssetId }), state: "done", runId, outputAssetId: asset.assetId, device: last.device, stage: undefined, tabId: undefined, error: undefined, updatedAt: now() }));
  } catch (cause) {
    await failJob(sourceAssetId, `去配乐已完成，但保存到画布失败：${cause instanceof Error ? cause.message : String(cause)}；ComfyUI 输出文件还在 output/${outputPath(file)}`, runId);
  }
}

/** After a refresh: look the pass up by its prompt id (= Run id) and attach the result. Never re-sends. */
async function resumeRun(runId: string, sourceAssetId: string) {
  const run = await getRun(runId);
  if (!run) return failJob(sourceAssetId, "找不到这条去配乐的生成记录，没有自动重新提交");
  if (!run.comfyPromptId) return failJob(sourceAssetId, "上次刷新前还没提交，没有自动重新提交；可以点重试", runId);
  const previous = Number(run.parameters?.previousPasses) || 0;
  const record: MusicRemovalPass = { ...(run.musicRemoval?.passes?.[0] ?? { pass: previous + 1, promptId: run.comfyPromptId, input: String(run.parameters?.inputFilename ?? ""), inputAssetId: sourceAssetId }) };
  if (!record.outputFile) {
    const outcome = await waitPass(runId, sourceAssetId, record.promptId, record.pass);
    if (!outcome) return;
    if (outcome.kind === "skipped") {
      if (!previous) return markSkipped(runId, sourceAssetId, outcome.info);
      return failJob(sourceAssetId, "再去一次被节点跳过了（不应该发生），没有结果", runId);
    }
    Object.assign(record, { output: outputPath(outcome.file), outputFile: outcome.file, device: outcome.info.device, seconds: outcome.info.seconds, completedAt: now() });
  }
  return finish(runId, sourceAssetId, [record]);
}

/**
 * After a page load: waiting jobs from a closed tab were never sent → failed with a clear message.
 * Reserved / sent jobs → looked up again by prompt id. Returns what it did, for the canvas toast.
 */
export async function recoverMusicRemovals() {
  const deps = need();
  const row = (await getMeta<DemixStateRow>(MUSIC_REMOVAL_STATE_KEY)) ?? empty();
  const lost: string[] = [], resumed: string[] = [];
  for (const job of Object.values(row.jobs)) {
    if (job.state === "waiting") {
      if (job.tabId === currentDemixTab() || (job.tabId && await deps.tabAlive?.(job.tabId))) continue;
      lost.push(job.sourceAssetId);
      await changeJob(job.sourceAssetId, (current) => current?.state === "waiting" && current.tabId === job.tabId ? { ...current, state: "failed", stage: undefined, tabId: undefined, error: "页面刷新前还在画布里排队，没有提交给 ComfyUI（没占显卡）；可以点重试", updatedAt: now() } : undefined);
      continue;
    }
    if (job.state !== "running" || !job.runId) continue;
    const runId = job.runId;
    void withLock(`frameflow-music-removal-${job.sourceAssetId}`, async () => {
      const latest = (await getMeta<DemixStateRow>(MUSIC_REMOVAL_STATE_KEY))?.jobs[job.sourceAssetId];
      if (latest?.state !== "running" || latest.runId !== runId) return;
      const run = await getRun(runId);
      if (!run) return failJob(job.sourceAssetId, "找不到这条去配乐的生成记录，没有自动重新提交");
      if (run.status === "completed") return void await changeJob(job.sourceAssetId, (current) => ({ ...(current ?? job), state: run.outputAssetIds[0] ? "done" : "skipped", outputAssetId: run.outputAssetIds[0], stage: undefined, updatedAt: now() }));
      if (run.status === "failed" || run.status === "cancelled") return failJob(job.sourceAssetId, run.error ?? "上次去配乐没有完成");
      return resumeRun(runId, job.sourceAssetId);
    }).catch(() => {});
    resumed.push(job.sourceAssetId);
  }
  return { lost, resumed };
}

/**
 * 出片后自动去配乐: called for every Run change. Only an H3 Run that finished just now AND recorded
 * `autoRemoveMusic: true` at submission is processed — older Runs never carry that flag, so old videos are never touched.
 * Always one pass (「再去一次」 is by hand only).
 */
export async function maybeAutoRemoveMusic(runId: string, maxAgeMs = 30 * 60_000) {
  const run: RunRecord | null = await getRun(runId);
  if (!run || run.status !== "completed" || !isH3Capability(run.capabilityId) || run.parameters?.autoRemoveMusic !== true) return null;
  if (!run.completedAt || now() - run.completedAt > maxAgeMs) return null;
  const assetId = run.outputAssetIds[0];
  if (!assetId) return null;
  const known = (await readDemixJobs()).jobs[assetId];
  if (known) return null;
  return enqueueMusicRemoval({ sourceAssetId: assetId, auto: true, ...(run.ownerNodeId ? { nodeId: run.ownerNodeId } : {}) });
}

/** For a node: is this asset a 去配乐 output (→ its original, passes so far, its own 「再去一次」 job), or an original (→ its job)? */
export function demixViewFor(asset: Pick<AssetRecord, "assetId" | "derivationType" | "sourceVideoAssetId" | "musicRemovalPasses"> | null | undefined, row: DemixStateRow | null) {
  if (!asset) return { kind: "none" as const };
  if (asset.derivationType === "music_removal") return { kind: "output" as const, originalAssetId: asset.sourceVideoAssetId ?? null, passes: musicRemovalPassesOf(asset), canRunAgain: musicRemovalPassesOf(asset) < MAX_MUSIC_REMOVAL_PASSES, job: row?.jobs[asset.assetId] };
  return { kind: "source" as const, job: row?.jobs[asset.assetId] };
}
export const terminalDemix = (job: DemixJob | undefined) => !!job && TERMINAL.includes(job.state);

/** Test hook: forget the in-memory cache / queue (state stays in the database). */
export function resetMusicRemovalMemory() { cache = null; cacheReady = null; pending.splice(0); listeners.clear(); tabId = ""; }
