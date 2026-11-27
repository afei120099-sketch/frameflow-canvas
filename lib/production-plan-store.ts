import { getMeta, putMeta, listAssets, listRuns, listShots } from "./production-records.ts";
import { PRODUCTION_PLAN_KEY, createProductionPlan, validatePlans, type ProductionPlans } from "./production-plan.ts";
import type { StoryChapters } from "./story-chapters.ts";
import { parseStoryChapters } from "./story-chapters.ts";
import { buildBoardRows, emptyBoard, SHOT_BOARD_KEY, type ShotBoardState } from "./shot-board.ts";
import { collectAdoptedClips } from "./production-assembly.ts";
import { mutateFinalCutList } from "./final-cut-store.ts";
export const PLAN_CHANGED = "frameflow-production-plan-changed";
export const loadProductionPlans = async () => validatePlans(await getMeta(PRODUCTION_PLAN_KEY));
let pending: Promise<unknown> = Promise.resolve();
export function mutateProductionPlans(change: (current: ProductionPlans) => ProductionPlans) {
  const task = pending.then(async () => {
    const apply = async () => { const next = validatePlans(change(await loadProductionPlans())); await putMeta(PRODUCTION_PLAN_KEY, next); if (typeof window !== "undefined") window.dispatchEvent(new Event(PLAN_CHANGED)); return next; };
    return typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request("frameflow-production-plan-edit", apply) : apply();
  });
  pending = task.catch(() => undefined); return task;
}
export function saveStoryPlan(story: StoryChapters) {
  const normalized = parseStoryChapters(JSON.stringify(story), story.script);
  return mutateProductionPlans((current) => {
    if (current.plans.some((p) => JSON.stringify(p.story) === JSON.stringify(normalized))) return current;
    if (current.plans.length >= 20) throw new Error("已保存 20 个制作计划，请先备份；不会覆盖旧计划");
    return { ...current, plans: [...current.plans, createProductionPlan(normalized)] };
  });
}
/** Explicitly order plan clips before unrelated items; preserve edits/reviews, reject ambiguity. */
export async function collectPlanClips(planId: string) {
  const plans = await loadProductionPlans(), plan = plans.plans.find((p) => p.id === planId);
  if (!plan) throw new Error("制作计划不存在");
  if (plan.chapters.some((c) => !c.shotIds.length)) throw new Error("先为每章绑定镜头；不会静默跳过空章");
  const [shots, assets, runs, board] = await Promise.all([listShots(), listAssets(), listRuns(), getMeta<ShotBoardState>(SHOT_BOARD_KEY)]);
  const runMap = new Map(runs.map((r) => [r.runId, r]));
  const all = buildBoardRows(board ?? emptyBoard(), shots, new Map(assets.map((a) => [a.assetId, a])), runMap);
  const ordered = plan.chapters.flatMap((c) => c.shotIds).map((id) => { const row = all.find((r) => r.shot.shotId === id); if (!row || !row.adopted || !row.item.included) throw new Error(`镜头 ${id} 未采用、被排除或绑定失效`); return row; });
  return mutateFinalCutList((current) => {
    const result = collectAdoptedClips(current, ordered, runMap);
    if (result.skipped.length) throw new Error(result.skipped.join("；"));
    const ids = ordered.map((r) => r.adopted!.assetId);
    if (new Set(ids).size !== ids.length || ids.some((id) => result.list.items.filter((i) => i.assetId === id).length !== 1)) throw new Error("同一素材有多个成片片段，不能猜测剧本顺序，请先人工整理");
    const picked = ids.map((id) => result.list.items.find((i) => i.assetId === id)!);
    return { ...result.list, updatedAt: Date.now(), items: [...picked, ...result.list.items.filter((i) => !ids.includes(i.assetId))] };
  });
}
