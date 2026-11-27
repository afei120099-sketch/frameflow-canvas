// 镜头卡片排版的几条显示规则（纯函数，卡片和测试共用）。
import type { CategoryResult } from "./prompt-completeness.ts";
import type { ShotQueueShot } from "./shot-queue.ts";

/** 完整度标签：五项和其他都没有漏写时，整排收成一行。 */
export const TAGS_ALL_PASS = "✓ 画面五项全过 · 其他全写了";
export const tagsAllPass = (results: readonly CategoryResult[]) => results.every((result) => result.state !== "missing");
/** 有问题的标签放前面（漏写 → 写了 → 不适用），同一档保持原来的顺序。 */
export function orderTags<T extends Pick<CategoryResult, "state">>(results: readonly T[]): T[] {
  const rank = { missing: 0, ok: 1, na: 2 } as const;
  return results.map((result, index) => ({ result, index })).sort((a, b) => rank[a.result.state] - rank[b.result.state] || a.index - b.index).map((item) => item.result);
}

/**
 * 整份队列有没有用到关键帧：写了 keyframe、定了首帧（firstFrameAssetId）、出过候选图、或正在出图。
 * 都没有时卡片不显示「关键帧」这一列，把宽度让给剧情；「＋ 先出关键帧」挪到左边按钮下面。
 */
export function queueUsesKeyframes(shots: readonly ShotQueueShot[], hasCandidates: (title: string) => boolean) {
  // 接帧（firstFrameFrom / lastFrameFrom）也显示在这一列（「首帧接 X 的尾帧」），有就保留这一列。
  return shots.some((shot) => Boolean(shot.keyframe) || Boolean(shot.firstFrameAssetId) || Boolean(shot.firstFrameFrom) || Boolean(shot.lastFrameFrom) || hasCandidates(shot.title));
}

/** 卡片顶栏主按钮的字：没入过队「全部入队（N 镜）」，入过「继续未完成（N 镜）」，排队中显示进度。 */
export function enqueueLabel(s: { checking: boolean; asking: boolean; submitting: boolean; done: number; total: number; enqueuedBefore: boolean }) {
  if (s.checking) return "正在盘点…";
  if (s.asking) return "等你确认…";
  if (s.submitting) return `排队中 ${s.done}/${s.total}`;
  if (!s.enqueuedBefore) return `全部入队（${s.total} 镜）`;
  return s.done >= s.total ? "全部已出片" : `继续未完成（${s.total - s.done} 镜）`;
}

/** 改好、载入后的告知：以前写「尚未提交」，用户看不懂是不是出错了。几秒后淡出。 */
export const NOT_QUEUED = "还没入队（点顶栏「全部入队」才开始渲染）";
export const SOFT_MESSAGE_MS = 5000;
