import { isH3Capability, type AssetRecord, type CapabilityId, type RunRecord, type ShotRecord } from "./production-records.ts";

/**
 * Phase 14: read-only lineage. From one Asset: which Run produced it, which Shot it belongs to,
 * what went in (source images / videos / voices, recursively), what was derived from it, and
 * whether it is a candidate or the ★ adopted version. Built from records only; nothing is inferred
 * from canvas position, and nothing here can change a relationship.
 */

export const CAPABILITY_NAMES: Record<CapabilityId, string> = { cover_generation:"AI短剧封面", h3_fl2va: "H3 生成（首帧 / 首尾帧）", h3_ref2va: "H3 生成（多参考）", h3_addguide_experimental: "H3 生成（首帧 + 🧪引导锚点）", h3_ultimate_guide: "H3 生成（终极版 / 极速版 + 🧪时间锚点）", seedvr2_upscale: "SeedVR2 高清增强", film_interpolation: "FILM 流畅增强" , final_cut_rough: "成片序列粗剪", music_removal: "去配乐（CDX23，留台词和音效）" };
export type ShotRole = { shot: ShotRecord; label: string | null; adopted: boolean } | null;
export interface LineageNode {
  asset: AssetRecord | null;
  assetId: string;
  /** How this asset was used by the child it hangs under (e.g. "first_frame", "reference_image"). */
  relation: string;
  producedBy: { run: RunRecord; capability: string } | null;
  derivation: string | null;
  shot: ShotRole;
  inputs: LineageNode[];
  truncated?: "cycle" | "depth" | "missing";
}
export interface Lineage { root: LineageNode; derived: LineageNode[] }
type Records = { assets: ReadonlyMap<string, AssetRecord>; runs: ReadonlyMap<string, RunRecord>; shots: ReadonlyMap<string, ShotRecord> };

const RELATION_NAMES: Record<string, string> = { first_frame: "首帧", last_frame: "尾帧", reference_image: "参考图", connected_reference: "已连接参考图", role_appearance: "角色主外观", reference_video: "参考视频", reference_audio: "参考声音", role_voice: "角色主声音", source_video: "源视频", source_audio: "源声音", rough_source: "粗剪片段", input: "输入" };
export const relationName = (relation: string) => relation.split("+").map((part) => RELATION_NAMES[part] ?? part).join(" / ");

/** Candidate letters match ShotCandidatesPanel: completed H3 Runs with output, in Shot run order. */
export function candidateLabels(shot: ShotRecord, runs: ReadonlyMap<string, RunRecord>) {
  const labels = new Map<string, string>();
  let index = 0;
  for (const runId of shot.runIds) {
    const run = runs.get(runId);
    if (!run || run.status !== "completed" || !isH3Capability(run.capabilityId) || !run.outputAssetIds.length) continue;
    let value = index + 1; let label = "";
    while (value > 0) { value -= 1; label = String.fromCharCode(65 + (value % 26)) + label; value = Math.floor(value / 26); }
    labels.set(run.outputAssetIds[0], label); index += 1;
  }
  return labels;
}

function shotRole(asset: AssetRecord | null, records: Records): ShotRole {
  if (!asset?.shotId) return null;
  const shot = records.shots.get(asset.shotId);
  if (!shot) return null;
  return { shot, label: candidateLabels(shot, records.runs).get(asset.assetId) ?? null, adopted: shot.adoptedAssetId === asset.assetId };
}

const MAX_DEPTH = 8;
function upstream(assetId: string, relation: string, records: Records, seen: Set<string>, depth: number): LineageNode {
  const asset = records.assets.get(assetId) ?? null;
  const base = { assetId, asset, relation, shot: shotRole(asset, records) };
  if (!asset) return { ...base, producedBy: null, derivation: null, inputs: [], truncated: "missing" };
  if (seen.has(assetId)) return { ...base, producedBy: null, derivation: null, inputs: [], truncated: "cycle" };
  if (depth >= MAX_DEPTH) return { ...base, producedBy: null, derivation: null, inputs: [], truncated: "depth" };
  const nextSeen = new Set(seen).add(assetId);
  const run = asset.sourceRunId ? records.runs.get(asset.sourceRunId) ?? null : null;
  const inputs: LineageNode[] = [];
  if (run) {
    const roles = new Map((run.referenceInputs ?? []).map((input) => [input.assetId, input.role]));
    const fallback = run.capabilityId === "seedvr2_upscale" || run.capabilityId === "film_interpolation" || run.capabilityId === "music_removal" ? "source_video" : run.capabilityId === "final_cut_rough" ? "rough_source" : "input";
    for (const id of new Set(run.inputAssetIds)) inputs.push(upstream(id, roles.get(id) ?? fallback, records, nextSeen, depth + 1));
  }
  if (asset.derivationType === "audio_clip" && asset.sourceAudioAssetId) inputs.push(upstream(asset.sourceAudioAssetId, "source_audio", records, nextSeen, depth + 1));
  else if (asset.derivationType === "audio_extract" && asset.sourceVideoAssetId) inputs.push(upstream(asset.sourceVideoAssetId, "source_video", records, nextSeen, depth + 1));
  const derivation = asset.derivationType === "audio_extract" ? "视频提取声音" : asset.derivationType === "audio_clip" ? `声音裁剪${typeof asset.sourceStartTime === "number" && typeof asset.sourceEndTime === "number" ? `（${asset.sourceStartTime.toFixed(2)}–${asset.sourceEndTime.toFixed(2)} 秒）` : ""}` : null;
  return { ...base, producedBy: run ? { run, capability: CAPABILITY_NAMES[run.capabilityId] ?? run.capabilityId } : null, derivation, inputs };
}

/** Direct downstream results: Run outputs that used this asset as input, and audio derived from it. */
function downstream(assetId: string, records: Records): LineageNode[] {
  const out = new Map<string, LineageNode>();
  for (const run of records.runs.values()) {
    if (!run.inputAssetIds.includes(assetId) || run.status !== "completed") continue;
    for (const id of run.outputAssetIds) { const asset = records.assets.get(id) ?? null; out.set(id, { assetId: id, asset, relation: CAPABILITY_NAMES[run.capabilityId] ?? run.capabilityId, producedBy: { run, capability: CAPABILITY_NAMES[run.capabilityId] ?? run.capabilityId }, derivation: null, shot: shotRole(asset, records), inputs: [] }); }
  }
  for (const asset of records.assets.values()) {
    if ((asset.derivationType === "audio_extract" && asset.sourceVideoAssetId === assetId) || (asset.derivationType === "audio_clip" && asset.sourceAudioAssetId === assetId)) out.set(asset.assetId, { assetId: asset.assetId, asset, relation: asset.derivationType === "audio_extract" ? "视频提取声音" : "声音裁剪", producedBy: null, derivation: null, shot: shotRole(asset, records), inputs: [] });
  }
  return [...out.values()].sort((a, b) => (a.asset?.createdAt ?? 0) - (b.asset?.createdAt ?? 0));
}

export function buildLineage(assetId: string, records: Records): Lineage {
  return { root: upstream(assetId, "result", records, new Set(), 0), derived: downstream(assetId, records) };
}

/** Flattened for tests / text export: "depth|filename|relation|capability|shot". */
export function lineageLines(node: LineageNode, depth = 0): string[] {
  const shot = node.shot ? `${node.shot.adopted ? "★采用" : node.shot.label ? `候选${node.shot.label}` : "镜头衍生"}@${node.shot.shot.shotNumber}` : "";
  return [`${depth}|${node.asset?.filename ?? `缺失:${node.assetId}`}|${node.relation}|${node.producedBy?.run.capabilityId ?? node.derivation ?? ""}|${shot}${node.truncated ? `|${node.truncated}` : ""}`, ...node.inputs.flatMap((child) => lineageLines(child, depth + 1))];
}
