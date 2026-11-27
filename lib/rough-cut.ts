import { createRun, listAssets, listRuns, registerAsset, updateRun, type AssetRecord, type RunRecord } from "./production-records.ts";
import { PROBLEM_LABELS, type FinalCutList, type FinalCutRow } from "./final-cut-list.ts";
import { clipReviewState, REVIEW_LABELS } from "./production-review.ts";

/**
 * Phase 19: rough export of the Final Cut List (browser side; the rendering is scripts/rough-cut.py).
 *
 * A snapshot is frozen when "开始生成粗剪" is pressed: only enabled, valid items, in the user's
 * order, with their in/out points. Later edits to the list never reach a running export. Source
 * Assets are never modified; exactly one new video Asset is created, and only on success.
 */

export const ROUGH_CUT_CAPABILITY = "final_cut_rough" as const;
/** Identifies this page session, so a rough cut left "running" by a closed / refreshed page can be recognised. */
export const ROUGH_CUT_SESSION = globalThis.crypto.randomUUID();

export interface RoughCutClip {
  transition?: {type:"cut"|"dissolve"|"fade";seconds:number};
  /** 1-based position in the rough cut. */
  position: number;
  /** 1-based position in the Final Cut List (what the user sees as “第 N 段”). */
  order: number;
  itemId: string;
  assetId: string;
  title: string;
  filename: string;
  storageReference: string;
  inPoint: number;
  outPoint: number;
  /** Upload key for the local job (one per distinct Asset). */
  sourceKey: string;
}

export interface RoughCutSnapshot {
  /** Human approvals frozen with the output's Run; old snapshots remain readable. */
  review?: { required: boolean; items: { itemId: string; decision: string; reviewedAt: number; fingerprint: string }[] };
  schemaVersion: 1;
  sequenceId: string;
  title: string;
  listUpdatedAt: number;
  frozenAt: number;
  clips: RoughCutClip[];
  /** Enabled = false items: kept out of the cut on purpose. */
  disabled: { order: number; itemId: string; title: string }[];
}

export type RoughCutFreeze = { ok: true; snapshot: RoughCutSnapshot } | { ok: false; problems: string[] };

/**
 * Freezes the list for one export. Blocks (never skips) when an enabled item cannot be exported:
 * missing / invalid Asset, unknown duration, invalid range, or legacy inline media without a Blob.
 */
export function freezeRoughCut(list: FinalCutList, rows: readonly FinalCutRow[], now = Date.now()): RoughCutFreeze {
  const problems: string[] = [];
  const clips: RoughCutClip[] = [];
  const disabled: RoughCutSnapshot["disabled"] = [];
  for (const row of rows) {
    const order = row.index + 1;
    if (!row.item.enabled) { disabled.push({ order, itemId: row.item.itemId, title: row.item.title }); continue; }
    if (list.requireReview && clipReviewState(row.item, row.asset) !== "approved") {
      problems.push(`第${order}段：${REVIEW_LABELS[clipReviewState(row.item, row.asset)]}；审核通过或停用后才能粗剪`); continue;
    }
    if (row.problem) { problems.push(row.problem === "missing" ? `第${order}段素材已失效` : `第${order}段：${PROBLEM_LABELS[row.problem]}`); continue; }
    const asset = row.asset!;
    if (!asset.storageReference.startsWith("media:")) { problems.push(`第${order}段素材没有可导出的本地视频文件（旧版内嵌视频）`); continue; }
    clips.push({ position: clips.length + 1, order, itemId: row.item.itemId, assetId: asset.assetId, title: row.item.title, filename: asset.filename, storageReference: asset.storageReference, inPoint: row.item.inPoint, outPoint: Math.min(row.item.outPoint!, row.duration ?? row.item.outPoint!), transition: row.item.transition, sourceKey: asset.assetId.replace(/[^A-Za-z0-9_-]/g, "_") });
  }
  if (!problems.length && !clips.length) problems.push("没有可输出的启用片段");
  if (problems.length) return { ok: false, problems };
  const review = { required: list.requireReview === true, items: rows.filter((row) => row.item.enabled && row.item.review).map((row) => ({ itemId: row.item.itemId, ...row.item.review! })) };
  return { ok: true, snapshot: structuredClone({ schemaVersion: 1 as const, sequenceId: list.sequenceId, title: list.title, listUpdatedAt: list.updatedAt, frozenAt: now, clips, disabled, review }) };
}

/** Two snapshots describe the same export (order, sources, in/out). */
export const sameRoughCut = (a: RoughCutSnapshot, b: RoughCutSnapshot) => JSON.stringify(a.clips.map((clip) => [clip.itemId, clip.assetId, clip.inPoint, clip.outPoint,clip.transition])) === JSON.stringify(b.clips.map((clip) => [clip.itemId, clip.assetId, clip.inPoint, clip.outPoint,clip.transition])) && JSON.stringify(a.review ?? null) === JSON.stringify(b.review ?? null);

export const roughCutSeconds = (snapshot: RoughCutSnapshot) => snapshot.clips.reduce((sum, clip, index) => sum + (clip.outPoint - clip.inPoint) - (index > 0 && clip.transition?.type === "dissolve" ? clip.transition.seconds : 0), 0);

/** Distinct source Assets, first-use order (each is uploaded once even when used several times). */
export const roughCutSources = (snapshot: RoughCutSnapshot) => [...new Map(snapshot.clips.map((clip) => [clip.sourceKey, clip])).values()];

const pad = (value: number) => String(value).padStart(2, "0");
/** 粗剪_YYYYMMDD_HHmmss.mp4, or 标题_粗剪_… when the list has its own title; never reuses an existing name. */
export function roughCutFileName(title: string, now: number, existing: ReadonlySet<string> = new Set()) {
  const date = new Date(now);
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const safe = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 40);
  const base = safe && safe !== "成片序列" ? `${safe}_粗剪_${stamp}` : `粗剪_${stamp}`;
  let name = `${base}.mp4`;
  for (let n = 2; existing.has(name); n += 1) name = `${base}_${n}.mp4`;
  return name;
}

/** What the renderer reports back (scripts/rough-cut.py `render` result). */
export interface RoughCutOutput { fps: string; fpsValue: number; fpsReason: string; width: number; height: number; sizePolicy: string; frames: number; duration: number; clips: { index: number; frames: number; seconds: number; inPoint: number; outPoint: number }[]; warnings: string[]; bytes: number }

export const FPS_REASONS: Record<string, string> = {
  same: "所有片段帧率相同，保持不变",
  mixed_48_majority: "混合帧率：48 FPS（FILM）片段占一半以上时长，统一为 48 FPS",
  mixed_default_24: "混合帧率：统一为 24 FPS",
};

/** One Run per export (capability final_cut_rough), created when the export starts. */
export async function beginRoughCutRun(snapshot: RoughCutSnapshot, options: { sizePolicy: string; scriptVersion: string; plannedOutput: unknown }) {
  const run = await createRun({
    capabilityId: ROUGH_CUT_CAPABILITY,
    parameters: { snapshot, sizePolicy: options.sizePolicy, plannedOutput: options.plannedOutput, sessionId: ROUGH_CUT_SESSION, engine: "PyAV（ComfyUI 内嵌 Python）· libx264 + AAC" },
    workflowIdentity: { capabilityId: ROUGH_CUT_CAPABILITY, templateVersion: options.scriptVersion, templateFile: "rough-cut.py" },
    inputAssetIds: [...new Set(snapshot.clips.map((clip) => clip.assetId))],
    rawPrompt: null, finalPrompt: null, seed: null,
  });
  return updateRun(run.runId, { status: "running", startedAt: Date.now() });
}

/**
 * Stores the rendered MP4 and registers the single Rough Cut Asset. `store` writes the Blob into
 * the existing media store and returns its storage reference.
 */
export async function saveRoughCut(input: { run: RunRecord; snapshot: RoughCutSnapshot; output: RoughCutOutput; video: Blob; store: (blob: Blob, filename: string) => Promise<string>; now?: number }) {
  const now = input.now ?? Date.now();
  if (!input.video.size) throw new Error("粗剪结果文件为空");
  const existing = new Set((await listAssets("video")).map((asset) => asset.filename));
  const filename = roughCutFileName(input.snapshot.title, now, existing);
  const storageReference = await input.store(input.video, filename);
  const asset: AssetRecord = await registerAsset({
    kind: "video", origin: "generated", filename, mimeType: "video/mp4", storageReference, sourceRunId: input.run.runId,
    width: input.output.width, height: input.output.height, fps: input.output.fpsValue, duration: input.output.duration, fileSize: input.video.size,
    derivationType: "final_cut_rough", sourceSequenceId: input.snapshot.sequenceId,
    sourceItemIds: input.snapshot.clips.map((clip) => clip.itemId), sourceAssetIds: input.snapshot.clips.map((clip) => clip.assetId),
  });
  await updateRun(input.run.runId, { status: "completed", completedAt: now, outputAssetIds: [asset.assetId] });
  return asset;
}

export const failRoughCut = (runId: string, message: string, cancelled = false) => updateRun(runId, { status: cancelled ? "cancelled" : "failed", completedAt: Date.now(), error: message });

/** A rough cut still "running" from an earlier page session was interrupted (its local job is gone). */
export async function markInterruptedRoughCuts(session = ROUGH_CUT_SESSION) {
  const stale = (await listRuns()).filter((run) => run.capabilityId === ROUGH_CUT_CAPABILITY && (run.status === "queued" || run.status === "running") && run.parameters.sessionId !== session);
  await Promise.all(stale.map((run) => failRoughCut(run.runId, "页面刷新或关闭时粗剪被中断，未生成结果")));
  return stale.length;
}
