import type { AssetRecord, CapabilityId, RunRecord, ShotRecord } from "./production-records.ts";
import { clipReviewState, type ClipReview } from "./production-review.ts";

/**
 * Phase 18: Final Cut List V1 (成片序列) — the final edit order, independent of Shots.
 *
 * Any valid video Asset can be added: H3 / SeedVR2 / FILM output, imported video, adopted or not,
 * with or without Shot / Run. shotId / runId are provenance only, never a precondition.
 * Items have their own itemId (the same Asset may appear many times); the array order, mirrored in
 * `order`, is the user's order and is never re-sorted by shot number, time, source or ID.
 * In/out points are metadata: nothing is cut, joined or re-encoded here. This list is meant to be the
 * single input of a later rough-cut step (FinalCutList + Asset Blob).
 *
 * Stored under meta key "finalCutList" in frameflow-production-records (no new database or version),
 * so Phase 8 backups include it unchanged. Asset / Shot / Run records are never written.
 */

export const FINAL_CUT_KEY = "finalCutList";
export const FINAL_CUT_EXPORT_FORMAT = "frameflow-final-cut-list";
export const MEDIA_NOTE = "媒体文件为原始完整视频，入点/出点记录在剪辑清单中";
export const UNKNOWN_DURATION = "无法确认视频时长";
const EPSILON = 1e-6;
/** Times are shown and typed to the millisecond: an out point within 0.5 ms past the end IS the end (e.g. 2.462 for 2.461533 s). */
const END_TOLERANCE = 0.0005;

export type SourceCapability = "h3" | "seedvr2" | "film" | "imported" | "rough" | "other";
export const SOURCE_LABELS: Record<SourceCapability, string> = { h3: "H3", seedvr2: "SeedVR2", film: "FILM", imported: "导入视频", rough: "粗剪成片", other: "其他" };
const CAPABILITY_SOURCE: Record<CapabilityId, SourceCapability> = { cover_generation:"other", h3_fl2va: "h3", h3_ref2va: "h3", h3_addguide_experimental: "h3", h3_ultimate_guide: "h3", seedvr2_upscale: "seedvr2", film_interpolation: "film", final_cut_rough: "rough", music_removal: "h3" };

export interface FinalCutItem {
  transition?: {type:"cut"|"dissolve"|"fade";seconds:number};
  review?: ClipReview;
  itemId: string;
  /** 1-based position in the user's order (always equal to the array position). */
  order: number;
  assetId: string;
  /** The list's own title; the Asset / Shot / node titles are never changed. */
  title: string;
  /** Seconds within the source video. */
  inPoint: number;
  /** Seconds; null only while the video duration cannot be confirmed. */
  outPoint: number | null;
  /** Duration confirmed when the item was added (Asset.duration or a metadata probe). A duration on the Asset record takes precedence. */
  sourceDuration: number | null;
  note: string;
  enabled: boolean;
  shotId?: string;
  runId?: string;
  sourceCapability?: SourceCapability;
  createdAt: number;
  updatedAt: number;
}

export interface FinalCutList {
  requireReview?: boolean;
  schemaVersion: 1;
  sequenceId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  items: FinalCutItem[];
}

const newId = () => globalThis.crypto.randomUUID();
const clean = (value: number) => Math.round(value * 1000) / 1000;
const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function createFinalCutList(options: { now?: number; sequenceId?: string; title?: string } = {}): FinalCutList {
  const now = options.now ?? Date.now();
  return { schemaVersion: 1, sequenceId: options.sequenceId ?? newId(), title: options.title ?? "成片序列", createdAt: now, updatedAt: now, items: [] };
}

/** Stored value → list. Missing Assets are kept; only structurally broken entries are skipped. Order follows `order`. */
export function normalizeFinalCutList(raw: unknown): FinalCutList {
  if (!raw || typeof raw !== "object") return createFinalCutList();
  const value = raw as Partial<FinalCutList>;
  const items = (Array.isArray(value.items) ? value.items : [])
    .filter((item): item is FinalCutItem => Boolean(item) && typeof item.itemId === "string" && typeof item.assetId === "string")
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (Number.isFinite(a.item.order) ? a.item.order : a.index + 1) - (Number.isFinite(b.item.order) ? b.item.order : b.index + 1) || a.index - b.index)
    .map(({ item }) => ({
      ...item,
      title: typeof item.title === "string" ? item.title : "",
      note: typeof item.note === "string" ? item.note : "",
      enabled: item.enabled !== false,
      inPoint: typeof item.inPoint === "number" && Number.isFinite(item.inPoint) ? item.inPoint : 0,
      outPoint: typeof item.outPoint === "number" && Number.isFinite(item.outPoint) ? item.outPoint : null,
      sourceDuration: finitePositive(item.sourceDuration) ? item.sourceDuration : null,
    }));
  const base = createFinalCutList({ now: value.createdAt, sequenceId: typeof value.sequenceId === "string" ? value.sequenceId : undefined, title: typeof value.title === "string" && value.title.trim() ? value.title : undefined });
  return { ...base, requireReview: value.requireReview === true, updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : base.updatedAt, items: renumber(items) };
}

const renumber = (items: FinalCutItem[]) => items.map((item, index) => item.order === index + 1 ? item : { ...item, order: index + 1 });
const withItems = (list: FinalCutList, items: FinalCutItem[], now: number): FinalCutList => ({ ...list, items: renumber(items), updatedAt: now });
function indexOf(list: FinalCutList, itemId: string) {
  const index = list.items.findIndex((item) => item.itemId === itemId);
  if (index < 0) throw new Error("该片段已不在成片序列中");
  return index;
}

export function sourceCapabilityFor(asset: Pick<AssetRecord, "origin">, run: Pick<RunRecord, "capabilityId"> | null | undefined): SourceCapability {
  if (run) return CAPABILITY_SOURCE[run.capabilityId] ?? "other";
  return asset.origin === "imported" ? "imported" : "other";
}

/** Shots get "镜头 NN" automatically; only a title the user gave says more than the Shot label. */
const namedShotTitle = (title: string | undefined) => { const value = title?.trim() ?? ""; return /^镜头\s*\d+$/.test(value) ? "" : value; };
/** Default title: a user-named Shot title, otherwise the file name. */
export const defaultItemTitle = (asset: Pick<AssetRecord, "filename">, shot?: Pick<ShotRecord, "title"> | null) => namedShotTitle(shot?.title) || asset.filename || "未命名片段";

/** Duration used for validation: the Asset record first, then the one confirmed when the item was added. */
export const itemDuration = (item: Pick<FinalCutItem, "sourceDuration">, asset: Pick<AssetRecord, "duration"> | null | undefined) => finitePositive(asset?.duration) ? asset!.duration! : item.sourceDuration;

export interface AddItemInput {
  asset: AssetRecord;
  run?: Pick<RunRecord, "runId" | "capabilityId"> | null;
  shot?: Pick<ShotRecord, "shotId" | "title"> | null;
  /** Duration when Asset.duration is missing (e.g. read from the video's metadata). */
  duration?: number | null;
  title?: string;
}

/** Appends one clip at the end. Any video Asset qualifies; adopted / Shot / Run are not required. */
export function addItem(list: FinalCutList, input: AddItemInput, options: { now?: number; itemId?: string } = {}) {
  const { asset } = input;
  if (asset.kind !== "video") throw new Error("只有视频素材可以加入成片序列");
  const now = options.now ?? Date.now();
  const duration = finitePositive(asset.duration) ? asset.duration : finitePositive(input.duration) ? input.duration : null;
  const item: FinalCutItem = {
    itemId: options.itemId ?? newId(), order: list.items.length + 1, assetId: asset.assetId,
    title: input.title?.trim() || defaultItemTitle(asset, input.shot), inPoint: 0, outPoint: duration,
    sourceDuration: duration, note: "", enabled: true,
    ...(input.shot?.shotId ? { shotId: input.shot.shotId } : asset.shotId ? { shotId: asset.shotId } : {}),
    ...(input.run?.runId ? { runId: input.run.runId } : asset.sourceRunId ? { runId: asset.sourceRunId } : {}),
    sourceCapability: sourceCapabilityFor(asset, input.run), createdAt: now, updatedAt: now,
  };
  return { list: withItems(list, [...list.items, item], now), item };
}

/** Same Asset again, right after the original, with its own itemId (e.g. a second range of the same take). */
export function duplicateItem(list: FinalCutList, itemId: string, options: { now?: number; itemId?: string } = {}) {
  const index = indexOf(list, itemId);
  const now = options.now ?? Date.now();
  const copy: FinalCutItem = { ...list.items[index], itemId: options.itemId ?? newId(), createdAt: now, updatedAt: now };
  const items = [...list.items]; items.splice(index + 1, 0, copy);
  return { list: withItems(list, items, now), item: copy };
}

/** Moves one item; the result is exactly the user's order. */
export function moveItem(list: FinalCutList, from: number, to: number, now = Date.now()) {
  if (from === to || from < 0 || to < 0 || from >= list.items.length || to >= list.items.length) return list;
  const items = [...list.items]; const [moved] = items.splice(from, 1); items.splice(to, 0, moved);
  return withItems(list, items, now);
}

/** How often an Asset is in the list; "latest" is the most recently added of its items. */
export function assetMembership(list: FinalCutList | null | undefined, assetId: string) {
  const items = (list?.items ?? []).filter((item) => item.assetId === assetId);
  const latest = items.reduce<FinalCutItem | null>((best, item) => !best || item.createdAt >= best.createdAt ? item : best, null);
  return { count: items.length, itemIds: items.map((item) => item.itemId), latestItemId: latest?.itemId ?? null };
}

export type FinalCutToggle = { kind: "add" } | { kind: "remove"; itemId: string } | { kind: "choose"; itemIds: string[]; latestItemId: string };

/**
 * What one click on an "加入成片" button means (Phase 18.1). Not in the list → add. Exactly once →
 * that click cancels it. Several times → never delete them all in one click; the user chooses
 * (view the sequence / cancel only the most recent addition).
 */
export function finalCutToggleAction(list: FinalCutList | null | undefined, assetId: string): FinalCutToggle {
  const membership = assetMembership(list, assetId);
  if (membership.count === 0) return { kind: "add" };
  if (membership.count === 1) return { kind: "remove", itemId: membership.itemIds[0] };
  return { kind: "choose", itemIds: membership.itemIds, latestItemId: membership.latestItemId! };
}

/** Removes only the most recently added item of this Asset; other uses (and their in/out) stay. */
export function removeLatestForAsset(list: FinalCutList, assetId: string, now = Date.now()) {
  const { latestItemId } = assetMembership(list, assetId);
  if (!latestItemId) throw new Error("该素材不在成片序列中");
  return removeItem(list, latestItemId, now);
}

export function removeItem(list: FinalCutList, itemId: string, now = Date.now()) {
  const index = indexOf(list, itemId);
  return withItems(list, list.items.filter((_, position) => position !== index), now);
}

export function updateItem(list: FinalCutList, itemId: string, change: Partial<Pick<FinalCutItem, "title" | "note" | "enabled">>, now = Date.now()) {
  const index = indexOf(list, itemId);
  if (change.title !== undefined && !change.title.trim()) throw new Error("片段标题不能为空");
  const items = [...list.items];
  items[index] = { ...items[index], ...change, ...(change.title !== undefined ? { title: change.title.trim() } : {}), updatedAt: now };
  return withItems(list, items, now);
}

export function renameList(list: FinalCutList, title: string, now = Date.now()) {
  if (!title.trim()) throw new Error("序列名称不能为空");
  return { ...list, title: title.trim(), updatedAt: now };
}

/** 0 ≤ in < out ≤ duration, in seconds. Explicit errors, never silently clamped. */
export function validateRange(inPoint: number, outPoint: number, duration: number | null) {
  if (duration === null) throw new Error(`${UNKNOWN_DURATION}，不能设置入点 / 出点`);
  if (!Number.isFinite(inPoint) || inPoint < 0) throw new Error("入点必须是不小于 0 的秒数");
  if (!Number.isFinite(outPoint)) throw new Error("出点必须是秒数");
  if (outPoint > duration + END_TOLERANCE) throw new Error(`出点超出视频时长（${duration.toFixed(3)} 秒）`);
  if (Math.min(outPoint, duration) - inPoint <= EPSILON) throw new Error("出点必须晚于入点");
}

export function setItemRange(list: FinalCutList, itemId: string, inPoint: number, outPoint: number, duration: number | null, now = Date.now()) {
  const index = indexOf(list, itemId);
  validateRange(inPoint, outPoint, duration);
  const items = [...list.items];
  // Validated above; only a typed end within display precision is snapped to the exact end.
  items[index] = { ...items[index], inPoint: clean(inPoint), outPoint: Math.min(clean(outPoint), duration!), updatedAt: now };
  return withItems(list, items, now);
}

/** A duration read later for an item added while it was unknown; the out point defaults to the full length. */
export function confirmDuration(list: FinalCutList, itemId: string, duration: number, now = Date.now()) {
  const index = indexOf(list, itemId);
  if (!finitePositive(duration)) throw new Error(UNKNOWN_DURATION);
  const items = [...list.items];
  const item = items[index];
  items[index] = { ...item, sourceDuration: duration, outPoint: item.outPoint ?? duration, updatedAt: now };
  return withItems(list, items, now);
}

export type ItemProblem ="missing" | "unknown_duration" | "invalid_range";
export type ItemStatus = "ok" | "disabled" | "review_pending" | "review_rejected" | "review_stale" | ItemProblem;
export const PROBLEM_LABELS: Record<ItemProblem, string> = { missing: "素材已失效", unknown_duration: UNKNOWN_DURATION, invalid_range: "入点 / 出点超出视频时长" };

export interface FinalCutRow {
  item: FinalCutItem;
  index: number;
  asset: AssetRecord | null;
  duration: number | null;
  clipDuration: number | null;
  problem: ItemProblem | null;
  /** enabled, Asset present and a valid range: part of the cut, the total and the media export. */
  counted: boolean;
  status: ItemStatus;
  sourceLabel: string;
  /** "镜头 01 · 标题", or "独立素材" — having no Shot is normal. */
  shotLabel: string;
}

export interface FinalCutLookups {
  assets: ReadonlyMap<string, AssetRecord>;
  shots?: ReadonlyMap<string, Pick<ShotRecord, "shotNumber" | "title">>;
}

export const shotLabelFor = (shot: Pick<ShotRecord, "shotNumber" | "title"> | null | undefined, shotId?: string) => shot ? `镜头 ${String(shot.shotNumber).padStart(2, "0")}${namedShotTitle(shot.title) ? ` · ${namedShotTitle(shot.title)}` : ""}` : shotId ? "镜头记录缺失" : "独立素材";

export function resolveRows(list: FinalCutList, lookups: FinalCutLookups): FinalCutRow[] {
  return list.items.map((item, index) => {
    const found = lookups.assets.get(item.assetId);
    const asset = found && found.kind === "video" ? found : null;
    const duration = asset ? itemDuration(item, asset) : null;
    let problem: ItemProblem | null = null;
    if (!asset) problem = "missing";
    else if (duration === null || item.outPoint === null) problem = "unknown_duration";
    else if (item.outPoint > duration + END_TOLERANCE || item.inPoint < 0 || Math.min(item.outPoint, duration) - item.inPoint <= EPSILON) problem = "invalid_range";
    const clipDuration = problem === null ? clean(Math.min(item.outPoint!, duration!) - item.inPoint) : null;
    const counted = item.enabled && problem === null && (!list.requireReview || clipReviewState(item, asset) === "approved");
    return {
      item, index, asset, duration, clipDuration, problem, counted,
      status: problem ?? (!item.enabled ? "disabled" : list.requireReview && clipReviewState(item, asset) !== "approved" ? `review_${clipReviewState(item, asset)}` as ItemStatus : "ok"),
      sourceLabel: SOURCE_LABELS[item.sourceCapability ?? "other"] ?? SOURCE_LABELS.other,
      shotLabel: shotLabelFor(item.shotId ? lookups.shots?.get(item.shotId) : null, item.shotId),
    };
  });
}

/** Totals over enabled, valid items only: sum(out − in). */
export function finalCutTotals(rows: readonly FinalCutRow[]) {
  let enabled = 0; let counted = 0; let seconds = 0; let problems = 0;
  for (const row of rows) {
    if (row.item.enabled) enabled += 1;
    if (row.problem) problems += 1;
    if (row.counted) { counted += 1; seconds += row.clipDuration!; }
  }
  return { items: rows.length, enabled, counted, seconds: clean(seconds), problems, enabledNotCounted: enabled - counted };
}

/** Case-insensitive search over the list's title, note, file name, source and Shot label. Order kept. */
export function filterRows(rows: readonly FinalCutRow[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => `${row.item.title}\n${row.item.note}\n${row.asset?.filename ?? ""}\n${row.sourceLabel}\n${row.shotLabel}`.toLocaleLowerCase().includes(needle));
}

export interface FinalCutExportEntry {
  review: ClipReview | null;
  /** Position in the user's order (every item, 1-based). */
  order: number;
  /** Position among the clips that make the cut; null for disabled / invalid items. */
  cutOrder: number | null;
  title: string;
  assetId: string;
  filename: string | null;
  inPoint: number;
  outPoint: number | null;
  clipDuration: number | null;
  enabled: boolean;
  status: ItemStatus;
  shotId: string | null;
  runId: string | null;
  sourceCapability: SourceCapability | null;
  note: string;
  /** Name in an exported media folder (cutOrder items only). */
  mediaFile: string | null;
}

/**
 * Every item, in the user's order, with its status. Disabled and invalid items stay in the list
 * (cutOrder = null) so nothing silently disappears; only status "ok" items make the cut.
 */
export function exportEntries(rows: readonly FinalCutRow[]): FinalCutExportEntry[] {
  let cut = 0;
  return rows.map((row) => {
    const cutOrder = row.counted ? ++cut : null;
    return {
      review: row.item.review ?? null,
      order: row.index + 1, cutOrder, title: row.item.title, assetId: row.item.assetId, filename: row.asset?.filename ?? null,
      inPoint: row.item.inPoint, outPoint: row.item.outPoint, clipDuration: row.clipDuration, enabled: row.item.enabled, status: row.status,
      shotId: row.item.shotId ?? null, runId: row.item.runId ?? null, sourceCapability: row.item.sourceCapability ?? null, note: row.item.note,
      mediaFile: cutOrder === null ? null : mediaFileName(cutOrder, row.item.title, row.asset?.filename ?? ""),
    };
  });
}

export function finalCutJson(list: FinalCutList, rows: readonly FinalCutRow[], exportedAt = Date.now()) {
  const totals = finalCutTotals(rows);
  return JSON.stringify({
    format: FINAL_CUT_EXPORT_FORMAT, schemaVersion: 1, exportedAt: new Date(exportedAt).toISOString(),
    sequenceId: list.sequenceId, title: list.title, timeUnit: "seconds", mediaNote: MEDIA_NOTE, requireReview: list.requireReview === true,
    totals: { items: totals.items, enabled: totals.enabled, inCut: totals.counted, seconds: totals.seconds },
    items: exportEntries(rows),
  }, null, 2);
}

export const CSV_COLUMNS = ["order", "cutOrder", "title", "assetId", "filename", "inPoint", "outPoint", "clipDuration", "enabled", "status", "shotId", "runId", "sourceCapability", "note", "mediaFile"] as const;
function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`; // keep spreadsheets from evaluating titles / notes
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
/** UTF-8 with BOM (so spreadsheet apps read Chinese correctly), CRLF, RFC 4180 quoting. */
export function finalCutCsv(rows: readonly FinalCutRow[]) {
  const lines = [CSV_COLUMNS.join(","), ...exportEntries(rows).map((entry) => CSV_COLUMNS.map((column) => csvCell(entry[column])).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** "001_标题.mp4": Windows-safe, bounded length, extension from the source file (default .mp4). */
export function mediaFileName(cutOrder: number, title: string, sourceFilename = "") {
  const extension = /\.(mp4|mov|webm|m4v)$/i.exec(sourceFilename)?.[0].toLowerCase() ?? ".mp4";
  const base = title.replace(/\.(mp4|mov|webm|m4v)$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 60) || "片段";
  return `${String(cutOrder).padStart(3, "0")}_${base}${extension}`;
}

export interface MediaSink { writeBlob(path: string, blob: Blob): Promise<void>; writeText(path: string, text: string): Promise<void> }
export interface MediaExportReport { written: { file: string; assetId: string; bytes: number }[]; skipped: { order: number; title: string; reason: string }[] }

/**
 * Copies the source video of every clip in the cut (enabled + valid), in the user's order, plus the
 * JSON / CSV edit list. Files are the original full videos: in/out stay in the edit list.
 */
export async function exportFinalCutMedia(list: FinalCutList, rows: readonly FinalCutRow[], sink: MediaSink, readBlob: (asset: AssetRecord) => Promise<Blob>, options: { now?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<MediaExportReport> {
  const entries = exportEntries(rows);
  const report: MediaExportReport = { written: [], skipped: [] };
  const clips = rows.filter((row) => row.counted);
  let done = 0;
  for (const [position, row] of rows.entries()) {
    const entry = entries[position];
    if (!row.counted) { report.skipped.push({ order: entry.order, title: row.item.title, reason: row.problem ? PROBLEM_LABELS[row.problem] : row.item.enabled && list.requireReview ? "审核未通过或已过期" : "未纳入成片" }); continue; }
    const blob = await readBlob(row.asset!).catch((cause) => { throw new Error(`第 ${entry.order} 段「${row.item.title}」的视频读取失败：${cause instanceof Error ? cause.message : String(cause)}`); });
    if (!blob.size) throw new Error(`第 ${entry.order} 段「${row.item.title}」的视频为空`);
    await sink.writeBlob(entry.mediaFile!, blob);
    report.written.push({ file: entry.mediaFile!, assetId: row.item.assetId, bytes: blob.size });
    options.onProgress?.(++done, clips.length);
  }
  await sink.writeText("剪辑清单.json", finalCutJson(list, rows, options.now));
  await sink.writeText("剪辑清单.csv", finalCutCsv(rows));
  await sink.writeText("说明.txt", `${list.title}\r\n${MEDIA_NOTE}。\r\n文件名前的编号就是成片顺序；每段的入点 / 出点（秒）见 剪辑清单.csv / 剪辑清单.json。\r\n`);
  return report;
}

export const formatClock = (seconds: number | null) => seconds === null ? "—" : `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
