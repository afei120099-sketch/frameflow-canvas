/**
 * 镜头卡片改结构（复制 / 挪动 / 删除 / 用尾帧接一镜）前，先把相对引用钉成绝对标题：
 * sourceShot: "previous"、firstFrameFrom / lastFrameFrom / timeAnchors[].frameFrom 的 { shot: "previous" } 和 { shotNumber: n }，
 * 都换成 { shot: "那一镜的标题" }。这样挪了顺序，接的还是原来那一镜。
 */
import type { ShotQueue, ShotQueueShot } from "./shot-queue.ts";
import type { QueueFrameSource } from "./shot-queue-frames.ts";

export function pinRelativeReferences(queue: ShotQueue): ShotQueue {
  const flat = queue.chapters.flatMap((chapter) => chapter.shots);
  let index = -1;
  const pin = (from: QueueFrameSource | undefined, at: number): QueueFrameSource | undefined => {
    if (!from) return from;
    if (from.shotNumber !== undefined) { const target = flat[from.shotNumber - 1]; return target ? { shot: target.title, frame: from.frame } : from; }
    if (from.shot === "previous") { const target = flat[at - 1]; return target ? { shot: target.title, frame: from.frame } : from; }
    return from;
  };
  return {
    ...queue,
    chapters: queue.chapters.map((chapter) => ({
      ...chapter,
      shots: chapter.shots.map((shot) => {
        index++;
        const next: ShotQueueShot = { ...shot };
        if (shot.sourceShot === "previous" && flat[index - 1]) next.sourceShot = flat[index - 1].title;
        if (shot.firstFrameFrom) next.firstFrameFrom = pin(shot.firstFrameFrom, index);
        if (shot.lastFrameFrom) next.lastFrameFrom = pin(shot.lastFrameFrom, index);
        if (shot.timeAnchors?.some((anchor) => anchor.frameFrom)) next.timeAnchors = shot.timeAnchors.map((anchor) => anchor.frameFrom ? { ...anchor, frameFrom: pin(anchor.frameFrom, index) } : anchor);
        return next;
      }),
    })),
  };
}

/** Shots that point at this title (as source video or frame source) — deleting it would break them. */
export function dependentsOf(queue: ShotQueue, title: string) {
  const pinned = pinRelativeReferences(queue).chapters.flatMap((chapter) => chapter.shots);
  return pinned.filter((shot) => shot.title !== title && (shot.sourceShot === title || shot.firstFrameFrom?.shot === title || shot.lastFrameFrom?.shot === title || shot.timeAnchors?.some((anchor) => anchor.frameFrom?.shot === title))).map((shot) => shot.title);
}

/** Titles used more than once: videos, ignores and chaining all key on the title. */
export function duplicateTitles(queue: ShotQueue) {
  const seen = new Set<string>(), dup = new Set<string>();
  for (const shot of queue.chapters.flatMap((chapter) => chapter.shots)) (seen.has(shot.title) ? dup : seen).add(shot.title);
  return [...dup];
}
