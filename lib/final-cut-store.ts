import { getAsset, getMeta, getRun, getShot, listAssets, listRuns, listShots, putMeta, type AssetRecord } from "./production-records.ts";
import { buildBoardRows, emptyBoard, SHOT_BOARD_KEY, type ShotBoardState } from "./shot-board.ts";
import { collectAdoptedClips } from "./production-assembly.ts";
import { addItem, assetMembership, FINAL_CUT_KEY, normalizeFinalCutList, removeItem, removeLatestForAsset, type FinalCutItem, type FinalCutList } from "./final-cut-list.ts";

/**
 * Phase 18: Final Cut List persistence in the existing meta store (key "finalCutList").
 * Every change is read → change → write in one queue, so an "加入成片" from a node, the library, the
 * Shot Board or the lineage view can never overwrite an edit made in the open panel (or vice versa).
 */

export const FINAL_CUT_CHANGED_EVENT = "frameflow-final-cut-changed";

export async function loadFinalCutList(): Promise<FinalCutList> {
  return normalizeFinalCutList(await getMeta<FinalCutList>(FINAL_CUT_KEY));
}

/** CPU/storage only: no generation, no adoption changes. One queued write for the whole collection. */
export async function collectAdoptedToFinalCutList() {
  const [shots, assets, runs, board] = await Promise.all([listShots(), listAssets("video"), listRuns(), getMeta<ShotBoardState>(SHOT_BOARD_KEY)]);
  const runMap = new Map(runs.map((run) => [run.runId, run]));
  const rows = buildBoardRows(board ?? emptyBoard(), shots, new Map(assets.map((asset) => [asset.assetId, asset])), runMap);
  return mutateFinalCutList((current) => {
    const result = collectAdoptedClips(current, rows, runMap);
    return { list: result.list, result: { added: result.added, skipped: result.skipped } };
  });
}

/**
 * Phase 18.1: one cached copy of the list for every "加入成片" button (hundreds of video nodes read it
 * without touching IndexedDB each). Loaded lazily on first subscription, refreshed by every mutation.
 */
let snapshot: FinalCutList | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
function publish(next: FinalCutList) { snapshot = next; for (const listener of listeners) listener(); }
export const getFinalCutSnapshot = () => snapshot;
export function subscribeFinalCut(listener: () => void) {
  listeners.add(listener);
  if (!snapshot && !loading) loading = loadFinalCutList().then(publish, () => undefined).finally(() => { loading = null; });
  return () => { listeners.delete(listener); };
}
/** Drops the cache (e.g. after a backup restore replaced the stored list). */
export function refreshFinalCutSnapshot() { return loadFinalCutList().then(publish); }

let queue: Promise<unknown> = Promise.resolve();
/** Serialised read-modify-write; the saved list is announced to every open view. */
export function mutateFinalCutList<T = void>(change: (list: FinalCutList) => { list: FinalCutList; result?: T } | FinalCutList): Promise<{ list: FinalCutList; result: T | undefined }> {
  const task = queue.then(async () => {
    const current = await loadFinalCutList();
    const outcome = change(current);
    const next = "list" in outcome ? outcome.list : outcome;
    const result = "list" in outcome ? outcome.result : undefined;
    await putMeta(FINAL_CUT_KEY, next);
    publish(next);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(FINAL_CUT_CHANGED_EVENT, { detail: next }));
    return { list: next, result };
  });
  queue = task.catch(() => undefined);
  return task;
}

export interface AddToFinalCutOptions {
  /** Used only when the Asset record has no duration (reads the video's own metadata). */
  probeDuration?: (asset: AssetRecord) => Promise<number | null>;
  /** Provenance hint, e.g. from the Shot Board; never required. */
  shotId?: string;
  title?: string;
  now?: number;
  itemId?: string;
}

/**
 * The one entry point for every "加入成片" button. Any video Asset qualifies — adopted or not, with or
 * without Shot / Run / Role. Shot and Run are looked up only to label the clip.
 */
export async function addAssetToFinalCutList(assetId: string, options: AddToFinalCutOptions = {}): Promise<{ list: FinalCutList; item: FinalCutItem; durationKnown: boolean }> {
  const asset = await getAsset(assetId);
  if (!asset) throw new Error("素材记录不存在，无法加入成片序列");
  if (asset.kind !== "video") throw new Error("只有视频素材可以加入成片序列");
  const run = asset.sourceRunId ? await getRun(asset.sourceRunId).catch(() => undefined) : undefined;
  const shotId = options.shotId ?? asset.shotId ?? run?.shotId;
  const shot = shotId ? await getShot(shotId).catch(() => undefined) : undefined;
  const hasDuration = typeof asset.duration === "number" && Number.isFinite(asset.duration) && asset.duration > 0;
  const probed = hasDuration || !options.probeDuration ? null : await options.probeDuration(asset).catch(() => null);
  const { list, result } = await mutateFinalCutList((current) => {
    const added = addItem(current, { asset, run: run ?? null, shot: shot ?? (shotId ? { shotId, title: "" } : null), duration: probed, title: options.title }, { now: options.now, itemId: options.itemId });
    return { list: added.list, result: added.item };
  });
  return { list, item: result!, durationKnown: result!.outPoint !== null };
}

/**
 * The one cancel used by every "加入成片" entry. Decided again inside the write queue from the stored
 * list, so a stale button can never remove the wrong item: "only" cancels an Asset that is in the list
 * exactly once; "latest" cancels just its most recent addition. Never removes all uses at once.
 */
export async function removeAssetFromFinalCutList(assetId: string, which: "only" | "latest") {
  const { list, result } = await mutateFinalCutList<{ removedItemId: string; remaining: number }>((current) => {
    const membership = assetMembership(current, assetId);
    if (membership.count === 0) throw new Error("该素材已不在成片序列中");
    if (which === "only" && membership.count !== 1) throw new Error(`该素材在成片序列中出现 ${membership.count} 次，请在成片序列中选择要取消的片段`);
    const removedItemId = which === "only" ? membership.itemIds[0] : membership.latestItemId!;
    const next = which === "only" ? removeItem(current, removedItemId) : removeLatestForAsset(current, assetId);
    return { list: next, result: { removedItemId, remaining: membership.count - 1 } };
  });
  return { list, removedItemId: result!.removedItemId, remaining: result!.remaining };
}
