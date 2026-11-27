// 镜头卡片「接尾帧」提示 + 一键接上。规则只认正本 h3q：它判断「同场、同人、同机位、动作连续」时报一条 HINT，
// 卡片只把这条 HINT 解析出来显示在镜头上，并提供一个按钮把这一镜改成接上一镜尾帧。画布自己不判断该不该接。
// 约定格式（正本 v2026-11-12「什么时候用接尾帧」，h3q tail_checks）：
//   [接尾帧] 可以考虑接上一镜尾帧：<上一镜完整标题> → <这一镜完整标题>；理由：…。接上就在这一镜写 …
import type { ShotQueueShot } from "./shot-queue.ts";

export interface ChainHint { from: string; to: string; why: string }

const HINT = /^\s*\[接尾帧\]\s*可以考虑接上一镜尾帧：(.+?) → (.+?)；理由：([\s\S]*)$/;

/** 解析一条 h3q 消息；不是 [接尾帧] 提示就返回 null。理由截到「。接上就…」之前（后面是给写 JSON 的人看的做法）。 */
export function parseChainHint(message: string): ChainHint | null {
  const match = HINT.exec(message);
  if (!match) return null;
  const [, from, to, rest] = match;
  const cut = rest.search(/。\s*接上就|。\s*代价/);
  const why = (cut >= 0 ? rest.slice(0, cut) : rest).replace(/[。.\s]+$/, "").trim();
  return { from: from.trim(), to: to.trim(), why };
}

/** 这一镜的 h3q 结果里的第一条 [接尾帧] 提示。 */
export function chainHintOf(items: readonly { message: string }[] | null | undefined): ChainHint | null {
  for (const item of items ?? []) { const hint = parseChainHint(item.message); if (hint) return hint; }
  return null;
}

/**
 * 一键接上：返回改好的这一镜，或一句说明为什么不能接。
 * - 提示里的两个标题必须就是「上一镜 → 这一镜」（队列改过、h3q 结果旧了就不接，等 h3q 重跑）；
 * - 已经定了首帧图（firstFrameAssetId）不动，要用户先取消首帧；
 * - 写了关键帧描述但没定首帧：接帧后首帧由上一镜决定，keyframe 去掉（可以撤销）；
 * - 提示词原样不动：首帧不占 <Picture N> 编号（提交时画布自己处理）。
 */
export function applyChainHint(shot: ShotQueueShot, previous: ShotQueueShot | undefined, hint: ChainHint): { shot: ShotQueueShot; note: string } | { problem: string } {
  if (!previous) return { problem: "这一镜是本章第一镜，没有上一镜可接" };
  if (hint.to !== shot.title || hint.from !== previous.title) return { problem: `提示说的是「${hint.from} → ${hint.to}」，和现在的上一镜 / 这一镜对不上（队列刚改过？等正本 h3q 重新查完再点）` };
  if (shot.firstFrameFrom) return { problem: "这一镜已经接了帧" };
  if (shot.firstFrameAssetId) return { problem: "这一镜已经定了首帧图：要接上一镜尾帧，先在关键帧列「取消首帧」" };
  const next: ShotQueueShot = structuredClone(shot);
  next.generationMode = "first-last";
  next.firstFrameFrom = { shot: previous.title, frame: "last" };
  const droppedKeyframe = Boolean(next.keyframe);
  delete next.keyframe;
  return { shot: next, note: `已改成接「${previous.title}」的尾帧${droppedKeyframe ? "（这一镜的关键帧描述去掉了，首帧由上一镜决定；不想要可以撤销）" : ""}。入队时会等上一镜出完再截帧排这一镜` };
}
