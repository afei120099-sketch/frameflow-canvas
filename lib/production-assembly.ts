import { addItem, setItemRange, type FinalCutList } from "./final-cut-list.ts";
import type { RunRecord } from "./production-records.ts";
import type { ShotBoardRow } from "./shot-board.ts";

/** Append in the existing board order; never replace edits or duplicate an already collected take. */
export function collectAdoptedClips(list: FinalCutList, rows: readonly ShotBoardRow[], runs: ReadonlyMap<string, RunRecord>, now = Date.now()) {
  let next = list;
  let added = 0;
  const skipped: string[] = [];
  for (const row of rows) {
    if (!row.item.included) continue;
    const asset = row.adopted;
    if (!asset || asset.kind !== "video" || !asset.storageReference.startsWith("media:") ||
      (asset.shotId && asset.shotId !== row.shot.shotId)) { skipped.push(`${row.shot.title}：没有有效的已采用本地视频`); continue; }
    const run = asset.sourceRunId ? runs.get(asset.sourceRunId) : null;
    if (asset.sourceRunId && (!run || run.status !== "completed" || !run.outputAssetIds.includes(asset.assetId) ||
      (run.shotId && run.shotId !== row.shot.shotId))) {
      skipped.push(`${row.shot.title}：生成记录与素材不一致`); continue;
    }
    if (next.items.some((item) => item.assetId === asset.assetId)) continue;
    try {
      const result = addItem(next, { asset, run, shot: row.shot }, { now });
      const ranged = setItemRange(result.list, result.item.itemId, row.item.inPoint ?? 0, row.item.outPoint ?? row.duration ?? NaN, row.duration, now);
      next = { ...ranged, items: ranged.items.map((item) => item.itemId === result.item.itemId ? { ...item, note: row.item.note } : item) };
      added += 1;
    } catch (cause) { skipped.push(`${row.shot.title}：${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  return { list: next, added, skipped };
}
