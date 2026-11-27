import type { AssetRecord, CapabilityId, RunRecord, ShotRecord } from "./production-records.ts";
import type { RoleRecord } from "./role-records.ts";
import { candidateLabels } from "./lineage.ts";
import { scoreText } from "./command-palette.ts";

/**
 * Phase 16: global search & locate. Searches canvas node titles, file names, Shot number / title,
 * Role names, Asset file names, Run IDs (last characters) and candidate / ★ adopted status.
 * Results carry a target; the canvas decides whether to locate a node or open a detail view.
 */

export type SearchTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "asset"; assetId: string }
  | { kind: "shot"; shotId: string; adoptedAssetId: string | null }
  | { kind: "role"; roleId: string }
  | { kind: "run"; runId: string; outputAssetId: string | null; status: RunRecord["status"] };
export interface SearchResult { id: string; group: "画布节点" | "镜头" | "素材" | "角色" | "生成记录"; label: string; detail: string; score: number; target: SearchTarget }
export interface CanvasNodeInfo { id: string; type: string; title: string; assetId?: string; shotId?: string }
export interface SearchData { nodes: CanvasNodeInfo[]; assets: AssetRecord[]; runs: RunRecord[]; shots: ShotRecord[]; roles: RoleRecord[] }

const NODE_TYPES: Record<string, string> = { "image-node": "图片", "video-node": "视频", "audio-node": "声音", "tts-node": "文生配音", "audio-video-node": "原音轨锁定视频", "music-node": "AI 作歌", "h3-node": "H3", "upscale-node": "高清增强", "smooth-node": "流畅增强" };
const CAPABILITY: Record<CapabilityId, string> = { cover_generation:"AI短剧封面", h3_fl2va: "H3", h3_ref2va: "H3 多参考", h3_addguide_experimental: "H3 🧪引导锚点", h3_ultimate_guide: "H3 🧪时间锚点", seedvr2_upscale: "SeedVR2", film_interpolation: "FILM", final_cut_rough: "粗剪", music_removal: "去配乐" };
const KIND: Record<string, string> = { image: "图片", video: "视频", audio: "声音" };
const RUN_STATUS: Record<string, string> = { queued: "排队中", running: "生成中", completed: "已完成", failed: "失败", cancelled: "已取消" };
const pad = (number: number) => String(number).padStart(2, "0");

/** Parses the special intents inside a query: status words, shot numbers and Run-id fragments. */
export function parseQuery(query: string) {
  const text = query.trim();
  const adopted = /已采用|★|采用版/.test(text);
  const candidate = /候选/.test(text);
  const shotMatch = text.match(/(?:镜头|shot|#)\s*0*(\d{1,4})/i);
  const runFragment = /^[0-9a-f-]{4,36}$/i.test(text.replace(/^run\s*/i, "")) ? text.replace(/^run\s*/i, "").toLowerCase() : null;
  const rest = text.replace(/已采用|★|采用版|候选/g, "").replace(/(?:镜头|shot|#)\s*0*\d{1,4}/gi, "").trim();
  return { text, adopted, candidate, shotNumber: shotMatch ? Number(shotMatch[1]) : null, runFragment, rest };
}

export function searchAll(data: SearchData, query: string, limit = 30): SearchResult[] {
  const q = parseQuery(query);
  if (!q.text) return [];
  const results: SearchResult[] = [];
  const shots = new Map(data.shots.map((shot) => [shot.shotId, shot]));
  const runs = new Map(data.runs.map((run) => [run.runId, run]));
  const labels = new Map<string, string>();
  for (const shot of data.shots) for (const [assetId, label] of candidateLabels(shot, runs)) labels.set(assetId, label);
  const statusOf = (asset: AssetRecord) => { const shot = asset.shotId ? shots.get(asset.shotId) : undefined; return shot?.adoptedAssetId === asset.assetId ? "adopted" : labels.has(asset.assetId) ? "candidate" : null; };
  const statusFilter = (status: string | null) => (!q.adopted || status === "adopted") && (!q.candidate || status === "candidate");
  const textScore = (label: string, keywords: string[] = []) => q.rest ? scoreText(q.rest, label, keywords) : (q.adopted || q.candidate || q.shotNumber !== null ? 50 : 0);

  for (const node of data.nodes) {
    const asset = node.assetId ? data.assets.find((item) => item.assetId === node.assetId) : undefined;
    const status = asset ? statusOf(asset) : null;
    if (!statusFilter(status) || (q.shotNumber !== null && (!node.shotId || shots.get(node.shotId)?.shotNumber !== q.shotNumber))) continue;
    const score = textScore(node.title, [NODE_TYPES[node.type] ?? node.type, asset?.filename ?? ""]);
    if (score > 0) results.push({ id: `node:${node.id}`, group: "画布节点", label: node.title || "（未命名节点）", detail: [NODE_TYPES[node.type] ?? node.type, status === "adopted" ? "★ 已采用" : status === "candidate" ? `候选${labels.get(node.assetId!)}` : "", node.shotId && shots.get(node.shotId) ? `镜头 ${pad(shots.get(node.shotId)!.shotNumber)}` : ""].filter(Boolean).join(" · "), score: score + 5, target: { kind: "node", nodeId: node.id } });
  }
  for (const shot of data.shots) {
    if (q.shotNumber !== null && shot.shotNumber !== q.shotNumber) continue;
    if (q.adopted && !shot.adoptedAssetId) continue;
    if (q.candidate) continue;
    const score = q.shotNumber !== null && !q.rest ? 90 : textScore(shot.title, [`镜头${pad(shot.shotNumber)}`, `镜头${shot.shotNumber}`, `shot${shot.shotNumber}`]);
    if (score > 0) results.push({ id: `shot:${shot.shotId}`, group: "镜头", label: `镜头 ${pad(shot.shotNumber)} · ${shot.title}`, detail: shot.adoptedAssetId ? "★ 已采用版本" : shot.runIds.length ? `${shot.runIds.length} 次生成，尚未采用` : "尚无生成", score, target: { kind: "shot", shotId: shot.shotId, adoptedAssetId: shot.adoptedAssetId } });
  }
  if (!q.adopted && !q.candidate && q.shotNumber === null) for (const role of data.roles) {
    const score = textScore(role.displayName, [role.description]);
    if (score > 0) results.push({ id: `role:${role.roleId}`, group: "角色", label: role.displayName, detail: `外观 ${role.appearanceAssetIds.length} · 声音 ${role.voiceAssetIds.length}`, score, target: { kind: "role", roleId: role.roleId } });
  }
  for (const asset of data.assets) {
    if (asset.storageReference.startsWith("legacy-inline:")) continue;
    const status = statusOf(asset);
    if (!statusFilter(status) || (q.shotNumber !== null && (!asset.shotId || shots.get(asset.shotId)?.shotNumber !== q.shotNumber))) continue;
    const score = textScore(asset.filename);
    if (score > 0) results.push({ id: `asset:${asset.assetId}`, group: "素材", label: asset.filename, detail: [KIND[asset.kind] ?? asset.kind, status === "adopted" ? "★ 已采用" : status === "candidate" ? `候选${labels.get(asset.assetId)}` : "", asset.shotId && shots.get(asset.shotId) ? `镜头 ${pad(shots.get(asset.shotId)!.shotNumber)}` : ""].filter(Boolean).join(" · "), score, target: { kind: "asset", assetId: asset.assetId } });
  }
  if (q.runFragment) for (const run of data.runs) {
    const id = run.runId.toLowerCase();
    if (!id.includes(q.runFragment)) continue;
    results.push({ id: `run:${run.runId}`, group: "生成记录", label: `Run …${run.runId.slice(-8)}`, detail: `${CAPABILITY[run.capabilityId] ?? run.capabilityId} · ${RUN_STATUS[run.status] ?? run.status}${run.shotId && shots.get(run.shotId) ? ` · 镜头 ${pad(shots.get(run.shotId)!.shotNumber)}` : ""}`, score: id.endsWith(q.runFragment) ? 95 : 75, target: { kind: "run", runId: run.runId, outputAssetId: run.outputAssetIds[0] ?? null, status: run.status } });
  }
  const order = ["画布节点", "镜头", "素材", "角色", "生成记录"];
  return results.sort((a, b) => b.score - a.score || order.indexOf(a.group) - order.indexOf(b.group)).slice(0, limit);
}
