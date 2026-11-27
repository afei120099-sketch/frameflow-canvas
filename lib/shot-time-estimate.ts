/**
 * 预计耗时 — an ESTIMATE from measured runs on this machine (one GPU, shots render one at a time):
 * 10 步（默认终极版）约 140 秒一镜；理解优先 211–321 秒一镜；Flux 关键帧约 64 秒一张。
 * 极速版没有实测，暂按 10 步算。Not counted: ComfyUI queue waits, model loading after a switch,
 * tail-frame HD and other post-processing. Every place that shows these numbers says 「估算」.
 */
import { queueGeneration, type QueueGenerationOptions } from "./shot-queue.ts";
import { keyframeCount, type KeyframeDefaults, type ShotKeyframe } from "./shot-queue-keyframe.ts";

export const MEASURED = { tenStepSeconds: 140, understandingSeconds: [211, 321] as const, keyframeSeconds: 64 } as const;
export type Estimate = { min: number; max: number };
export type ShotEstimate = Estimate & { kind: "ten-step" | "understanding" | "fast"; note: string };

export function shotEstimate(shot: QueueGenerationOptions, defaults?: QueueGenerationOptions): ShotEstimate {
  const option = queueGeneration(shot, defaults);
  if (option.workflow === "ultimate" && option.tuning === "understanding" && option.generationMode !== "extend")
    return { min: MEASURED.understandingSeconds[0], max: MEASURED.understandingSeconds[1], kind: "understanding", note: "理解优先实测 211–321 秒一镜" };
  if (option.workflow === "fast") return { min: MEASURED.tenStepSeconds, max: MEASURED.tenStepSeconds, kind: "fast", note: "极速版没有实测，暂按 10 步约 140 秒算" };
  return { min: MEASURED.tenStepSeconds, max: MEASURED.tenStepSeconds, kind: "ten-step", note: "10 步实测约 140 秒一镜" };
}

const add = (a: Estimate, b: Estimate): Estimate => ({ min: a.min + b.min, max: a.max + b.max });
const ZERO: Estimate = { min: 0, max: 0 };

type QueueLike = { defaults?: QueueGenerationOptions; chapters: { shots: QueueGenerationOptions[] }[] };
/** Whole queue and what is left. `done(chapter, index)` = this shot already has its video. */
export function queueEstimate(queue: QueueLike, done: (chapter: number, index: number) => boolean = () => false, only?: (chapter: number, index: number) => boolean) {
  let total = ZERO, remaining = ZERO, shots = 0, left = 0;
  queue.chapters.forEach((chapter, c) => chapter.shots.forEach((shot, s) => {
    if (only && !only(c, s)) return;
    const one = shotEstimate(shot, queue.defaults);
    total = add(total, one); shots++;
    if (!done(c, s)) { remaining = add(remaining, one); left++; }
  }));
  return { total, remaining, shots, left };
}

export function keyframeEstimate(items: readonly { keyframe: ShotKeyframe; count?: number }[], defaults?: KeyframeDefaults): Estimate & { images: number } {
  const images = items.reduce((sum, item) => sum + (item.count ?? keyframeCount(item.keyframe, defaults)), 0);
  return { min: images * MEASURED.keyframeSeconds, max: images * MEASURED.keyframeSeconds, images };
}

const unit = (seconds: number) => {
  if (seconds < 90) return { value: Math.round(seconds), label: "秒" };
  if (seconds < 3600) { const m = seconds / 60; return { value: m < 10 ? Math.round(m * 10) / 10 : Math.round(m), label: "分钟" }; }
  return { value: Math.round(seconds / 360) / 10, label: "小时" };
};
/** 「约 2.3 分钟」「约 3.5–5.4 分钟」「约 1.2 小时」. 0 → 「不用等」. */
export function formatEstimate(estimate: Estimate) {
  if (estimate.max <= 0) return "不用等";
  const hi = unit(estimate.max);
  if (estimate.min === estimate.max) return `约 ${hi.value} ${hi.label}`;
  const lo = unit(estimate.min);
  if (lo.label === hi.label) return `约 ${lo.value}–${hi.value} ${hi.label}`;
  return `约 ${lo.value} ${lo.label}–${hi.value} ${hi.label}`;
}
/** Short form for a small card cell: 「≈2.3分」「≈3.5–5.4分」. */
export function shortEstimate(estimate: Estimate) {
  const m = (s: number) => (Math.round((s / 60) * 10) / 10).toString();
  return estimate.min === estimate.max ? `≈${m(estimate.max)}分` : `≈${m(estimate.min)}–${m(estimate.max)}分`;
}
export const ESTIMATE_NOTE = "估算：按本机实测，10 步约 140 秒一镜、理解优先 211–321 秒一镜、关键帧约 64 秒一张；不含排队、换模型、尾帧高清等后处理";
