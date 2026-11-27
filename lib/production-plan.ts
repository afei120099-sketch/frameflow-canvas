import type { StoryChapters } from "./story-chapters.ts";
import { parseStoryChapters } from "./story-chapters.ts";
import type { AssetRecord, RunRecord, ShotRecord } from "./production-records.ts";
import type { FinalCutList } from "./final-cut-list.ts";
import { clipReviewState } from "./production-review.ts";

export const PRODUCTION_PLAN_KEY = "productionPlansV1";
export interface ContinuityNotes { person: string; clothing: string; scene: string; action: string }
export interface ProductionChapter { shotIds: string[]; notes: ContinuityNotes }
export interface ProductionPlan { id: string; story: StoryChapters; chapters: ProductionChapter[]; createdAt: number }
export interface ProductionPlans { version: 1; plans: ProductionPlan[] }
export function validatePlans(value: unknown): ProductionPlans {
  if (value === null) return { version: 1, plans: [] };
  const data = value as ProductionPlans;
  if (!data || data.version !== 1 || !Array.isArray(data.plans) || data.plans.length > 20) throw new Error("制作计划格式不兼容，不能覆盖");
  const ids = new Set<string>();
  for (const p of data.plans) {
    if (typeof p.id !== "string" || !p.id || ids.has(p.id) || !Number.isFinite(p.createdAt)) throw new Error("制作计划身份无效");
    ids.add(p.id); parseStoryChapters(JSON.stringify(p.story), p.story.script);
    if (!Array.isArray(p.chapters) || p.chapters.length !== p.story.chapters.length) throw new Error("章节绑定数量错误");
    const bound = new Set<string>();
    for (const c of p.chapters) {
      if (!Array.isArray(c.shotIds) || c.shotIds.length > 12) throw new Error("每章最多绑定 12 个镜头");
      for (const id of c.shotIds) { if (typeof id !== "string" || !id || bound.has(id)) throw new Error("同一镜头不能重复绑定章节"); bound.add(id); }
      for (const key of ["person", "clothing", "scene", "action"] as const) if (typeof c.notes?.[key] !== "string" || c.notes[key].length > 300) throw new Error("连续性记录无效");
    }
  }
  return structuredClone(data);
}
export function createProductionPlan(story: StoryChapters, id = crypto.randomUUID(), now = Date.now()): ProductionPlan {
  return { id, story: parseStoryChapters(JSON.stringify(story), story.script), createdAt: now, chapters: story.chapters.map(() => ({ shotIds: [], notes: { person: "", clothing: "", scene: "", action: "" } })) };
}
export function chapterStatus(c: ProductionChapter, shots: readonly ShotRecord[], runs: readonly RunRecord[], assets: readonly AssetRecord[], cut?: FinalCutList) {
  if (!c.shotIds.length) return "待绑定镜头";
  const selected = c.shotIds.map((id) => shots.find((s) => s.shotId === id));
  if (selected.some((s) => !s)) return "绑定失效";
  const records = runs.filter((r) => selected.some((s) => s!.runIds.includes(r.runId) && r.shotId === s!.shotId));
  if (records.some((r) => r.status === "running" || r.status === "queued")) return "生成中 / 排队中";
  if (selected.every((s) => assets.some((a) => a.assetId === s!.adoptedAssetId && a.kind === "video" && (!a.shotId || a.shotId === s!.shotId) && (!a.sourceRunId || runs.some((r) => r.runId === a.sourceRunId && r.status === "completed" && r.shotId === s!.shotId && r.outputAssetIds.includes(a.assetId)))))) {
    if (cut) {
      const reviews = selected.map((s) => { const items = cut.items.filter((i) => i.assetId === s!.adoptedAssetId && i.enabled); const item = items.length === 1 ? items[0] : null; return item ? clipReviewState(item, assets.find((a) => a.assetId === item.assetId) ?? null) : "pending"; });
      if (reviews.every((r) => r === "approved")) return "审核通过，可粗剪";
      if (reviews.some((r) => r === "rejected" || r === "stale")) return "需重做 / 重新审核";
    }
    return "已采用（待成片审核）";
  }
  if (selected.some((s) => s!.adoptedAssetId && !assets.some((a) => a.assetId === s!.adoptedAssetId))) return "采用素材失效";
  if (records.some((r) => r.status === "completed" && r.outputAssetIds.some((id) => assets.some((a) => a.assetId === id && a.kind === "video")))) return "待选片";
  if (records.length && records.every((r) => r.status === "failed" || r.status === "cancelled")) return "失败 / 已取消";
  return "待生成";
}
/** Notes are declared continuity, not visual AI identity recognition. */
export function continuityWarnings(plan: ProductionPlan): string[] {
  const warnings: string[] = [];
  plan.chapters.forEach((c, i) => {
    if (!c.notes.person || !c.notes.scene) warnings.push(`第 ${i + 1} 章：人物或场景记录未填写`);
    if (i) for (const [key, label] of [["person", "人物"], ["clothing", "服装"], ["scene", "场景"], ["action", "动作衔接"]] as const) {
      const before = plan.chapters[i - 1].notes[key].trim(), after = c.notes[key].trim();
      if (before && after && before !== after) warnings.push(`第 ${i} → ${i + 1} 章：${label}记录不同，请确认是剧情变化还是接错`);
    }
  });
  return warnings;
}
