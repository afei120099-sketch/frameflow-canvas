import type { AssetRecord, CapabilityId, RunRecord, ShotRecord } from "./production-records.ts";

/**
 * Phase 10: Shot Board V1 (shown as 镜头板 since Phase 19; formerly 成片清单).
 * Reads Shots and their ★ adopted Asset; stores only light editing metadata of its own (order,
 * include flag, note, in/out points) under meta key "shotBoard". Shot / Candidate / Adopted records
 * are never written here. In/out points are metadata only: nothing is cut or rendered (no FFmpeg).
 */

export const SHOT_BOARD_KEY = "shotBoard";
export interface ShotBoardItem { shotId: string; included: boolean; note: string; inPoint: number | null; outPoint: number | null }
export interface ShotBoardState { schemaVersion: 1; items: ShotBoardItem[]; updatedAt: number }
export const emptyBoard = (): ShotBoardState => ({ schemaVersion: 1, items: [], updatedAt: 0 });

export type SourceLabel = "H3" | "高清" | "流畅" | "未知";
const SOURCE: Record<CapabilityId, SourceLabel> = { cover_generation:"未知", h3_fl2va: "H3", h3_ref2va: "H3", h3_addguide_experimental: "H3", h3_ultimate_guide: "H3", seedvr2_upscale: "高清", film_interpolation: "流畅", final_cut_rough: "未知", music_removal: "H3" };

export interface ShotBoardRow {
  shot: ShotRecord;
  item: ShotBoardItem;
  adopted: AssetRecord | null;
  source: SourceLabel | null;
  /** Full adopted duration (seconds), if known. */
  duration: number | null;
  /** Duration after in/out metadata, if known. */
  effectiveDuration: number | null;
  /** Only an adopted version can be part of the cut. */
  canInclude: boolean;
}

const defaultItem = (shotId: string, canInclude: boolean): ShotBoardItem => ({ shotId, included: canInclude, note: "", inPoint: null, outPoint: null });

/** Saved order first (still-existing Shots only), then new Shots by shot number. */
export function buildBoardRows(board: ShotBoardState, shots: readonly ShotRecord[], assets: ReadonlyMap<string, AssetRecord>, runs: ReadonlyMap<string, Pick<RunRecord, "capabilityId">>): ShotBoardRow[] {
  const byId = new Map(shots.map((shot) => [shot.shotId, shot]));
  const saved = board.items.filter((item) => byId.has(item.shotId));
  const seen = new Set(saved.map((item) => item.shotId));
  const fresh = shots.filter((shot) => !seen.has(shot.shotId)).sort((a, b) => a.shotNumber - b.shotNumber);
  const order: (ShotBoardItem | ShotRecord)[] = [...saved, ...fresh];
  return order.map((entry) => {
    const shot = "shotNumber" in entry ? entry : byId.get(entry.shotId)!;
    const adopted = shot.adoptedAssetId ? assets.get(shot.adoptedAssetId) ?? null : null;
    const canInclude = Boolean(adopted);
    const stored = "shotNumber" in entry ? defaultItem(shot.shotId, canInclude) : entry;
    const item = { ...stored, included: canInclude && stored.included };
    const capability = adopted?.sourceRunId ? runs.get(adopted.sourceRunId)?.capabilityId : undefined;
    const duration = typeof adopted?.duration === "number" && Number.isFinite(adopted.duration) ? adopted.duration : null;
    return { shot, item, adopted, source: adopted ? (capability ? SOURCE[capability] : "未知") : null, duration, effectiveDuration: effectiveDuration(item, duration), canInclude };
  });
}

export function effectiveDuration(item: Pick<ShotBoardItem, "inPoint" | "outPoint">, duration: number | null) {
  if (duration === null) return item.inPoint !== null && item.outPoint !== null ? Math.max(0, item.outPoint - item.inPoint) : null;
  const start = item.inPoint ?? 0; const end = item.outPoint ?? duration;
  return Math.max(0, Math.min(end, duration) - Math.max(0, start));
}

/** The board as it should be stored: the rows' current order and items. */
export const boardFromRows = (rows: readonly ShotBoardRow[], now = Date.now()): ShotBoardState => ({ schemaVersion: 1, items: rows.map((row) => ({ ...row.item })), updatedAt: now });

export function moveRow<T>(rows: readonly T[], from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return [...rows];
  const next = [...rows]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); return next;
}

export function updateItem(rows: readonly ShotBoardRow[], shotId: string, change: Partial<Pick<ShotBoardItem, "included" | "note">>) {
  return rows.map((row) => {
    if (row.shot.shotId !== shotId) return row;
    if (change.included && !row.canInclude) throw new Error("该镜头还没有 ★采用 的版本，不能纳入成片");
    return { ...row, item: { ...row.item, ...change } };
  });
}

/** In/out are seconds within the adopted version; null clears. Validated, never silently clamped. */
export function setInOut(rows: readonly ShotBoardRow[], shotId: string, inPoint: number | null, outPoint: number | null) {
  return rows.map((row) => {
    if (row.shot.shotId !== shotId) return row;
    for (const [label, value] of [["入点", inPoint], ["出点", outPoint]] as const) {
      if (value === null) continue;
      if (!Number.isFinite(value) || value < 0) throw new Error(`${label}必须是不小于 0 的秒数`);
      if (row.duration !== null && value > row.duration + 1e-6) throw new Error(`${label}超出采用版本时长（${row.duration.toFixed(2)} 秒）`);
    }
    if (inPoint !== null && outPoint !== null && outPoint - inPoint < 0.1) throw new Error("出点必须晚于入点至少 0.1 秒");
    const item = { ...row.item, inPoint, outPoint };
    return { ...row, item, effectiveDuration: effectiveDuration(item, row.duration) };
  });
}

export function boardTotals(rows: readonly ShotBoardRow[]) {
  const included = rows.filter((row) => row.item.included);
  const known = included.filter((row) => row.effectiveDuration !== null);
  return { shots: rows.length, adopted: rows.filter((row) => row.canInclude).length, included: included.length, seconds: known.reduce((sum, row) => sum + (row.effectiveDuration ?? 0), 0), unknownDurations: included.length - known.length };
}

export const formatSeconds = (value: number | null) => value === null ? "—" : `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, "0")}`;
