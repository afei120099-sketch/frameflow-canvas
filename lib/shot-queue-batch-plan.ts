/**
 * 「全部镜头入队／继续未完成」之前的盘点（纯函数，不碰 GPU）。
 * - 镜头表和本页上次入队的会话完全一样 → 继续原批次，不弹确认。
 * - 不一样（改过文字、贴回旧队列、换了队列）→ 会新建一批：先告诉用户要渲几镜。
 * - 画布本页已有同标题、同提示词的 H3 节点，且它最新一次任务已出片或正在排队/渲染 → 可以直接认作这一镜，不再出一条。
 */
import type { ShotQueue } from "./shot-queue.ts";

export interface PlanNode { nodeId: string; title: string; prompt: string }
export interface PlanRun { ownerNodeId?: string; status: string; createdAt: number; outputAssetIds?: string[] }
export interface ReusableShot { chapter: number; shot: number; title: string; nodeId: string; state: "done" | "busy" }
export interface BatchStartPlan {
  /** true = 会新建一批（旧会话归档）；false = 继续本页原批次 */
  newBatch: boolean;
  /** 本次范围内的镜头数（整队列，或只算这一章） */
  total: number;
  reusable: ReusableShot[];
}

function latestRun(nodeId: string, runs: readonly PlanRun[]) {
  let latest: PlanRun | undefined;
  for (const run of runs) if (run.ownerNodeId === nodeId && (!latest || run.createdAt > latest.createdAt)) latest = run;
  return latest;
}

/** Same title + same prompt + latest Run finished with output (done) or queued/running (busy). Each node is used once. */
export function findReusableShots(queue: ShotQueue, nodes: readonly PlanNode[], runs: readonly PlanRun[], chapterIndex?: number): ReusableShot[] {
  const used = new Set<string>();
  const result: ReusableShot[] = [];
  queue.chapters.forEach((chapter, c) => chapter.shots.forEach((shot, s) => {
    if (chapterIndex !== undefined && c !== chapterIndex) return;
    type Candidate = { node: PlanNode; run: PlanRun; state: ReusableShot["state"] };
    const candidates = nodes.flatMap((node): Candidate[] => {
      if (used.has(node.nodeId) || node.title !== shot.title || node.prompt !== shot.prompt) return [];
      const run = latestRun(node.nodeId, runs);
      if (!run) return [];
      if (run.status === "completed" && run.outputAssetIds?.length) return [{ node, run, state: "done" as const }];
      if (run.status === "queued" || run.status === "running") return [{ node, run, state: "busy" as const }];
      return [];
    }).sort((a, b) => (a.state === b.state ? b.run.createdAt - a.run.createdAt : a.state === "done" ? -1 : 1));
    const pick = candidates[0];
    if (!pick) return;
    used.add(pick.node.nodeId);
    result.push({ chapter: c, shot: s, title: shot.title, nodeId: pick.node.nodeId, state: pick.state });
  }));
  return result;
}

export function planBatchStart(input: { savedQueue: ShotQueue | null; queue: ShotQueue; nodes: readonly PlanNode[]; runs: readonly PlanRun[]; chapterIndex?: number }): BatchStartPlan {
  const { savedQueue, queue, chapterIndex } = input;
  const newBatch = !savedQueue || JSON.stringify(savedQueue) !== JSON.stringify(queue);
  const total = queue.chapters.reduce((sum, chapter, c) => sum + (chapterIndex === undefined || c === chapterIndex ? chapter.shots.length : 0), 0);
  return { newBatch, total, reusable: newBatch ? findReusableShots(queue, input.nodes, input.runs, chapterIndex) : [] };
}
