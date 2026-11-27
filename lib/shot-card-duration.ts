// 镜头卡片「参数」列的快改：秒数 ▲▼、像素 0.45 / 0.88 快选、正本 h3q「[时长]」建议秒数。
// 纯函数：卡片按钮和测试共用。改动都返回新的镜头 / 队列，由卡片走同一条修改路径（进撤销历史）。
import type { ShotQueue, ShotQueueShot } from "./shot-queue.ts";
import { shotQueueMegapixels } from "./shot-queue.ts";

/** 正本 h3q（h3q.py「seconds 必须是 5～15」）和 lib/shot-queue.ts 的范围。 */
export const SECONDS_MIN = 5;
export const SECONDS_MAX = 15;

/** ±1 秒，到头停在边界；小数秒（如 12.5）先按 1 秒走、再夹到边界。 */
export function stepSeconds(seconds: number, delta: 1 | -1) {
  return Math.min(SECONDS_MAX, Math.max(SECONDS_MIN, seconds + delta));
}
export const canStepSeconds = (seconds: number, delta: 1 | -1) => delta > 0 ? seconds < SECONDS_MAX : seconds > SECONDS_MIN;

/** 像素预算快选。0.45 = 测试 / 小样（用户定的规矩）。 */
export const MP_PRESETS = [0.45, 0.88] as const;
export type MpPreset = (typeof MP_PRESETS)[number];
/** 当前生效的像素是不是快选里的一个；别的值（如 0.5）返回 null，两个都不高亮。 */
export function mpPreset(value: number): MpPreset | null {
  return MP_PRESETS.find((preset) => Math.abs(preset - value) < 1e-6) ?? null;
}
/** 这一镜写成指定像素（逐镜 megapixels，同级比 resolution 优先）。 */
export function withMegapixels(shot: ShotQueueShot, value: MpPreset): ShotQueueShot {
  return { ...shot, megapixels: value };
}

/** 整集统一像素：返回新队列和要改的镜数（已经是这个值的不算）。 */
export function planEpisodeMegapixels(queue: ShotQueue, value: MpPreset) {
  let changed = 0;
  const chapters = queue.chapters.map((chapter) => ({ ...chapter, shots: chapter.shots.map((shot) => {
    if (Math.abs(shotQueueMegapixels(shot, queue.defaults) - value) < 1e-6) return shot;
    changed++;
    return withMegapixels(shot, value);
  }) }));
  return { changed, queue: { ...queue, chapters } };
}

/** 整集像素现在是什么：全部同一个快选值 → current；不一样 → current = null，counts 写「混合：0.45 ×20 / 0.88 ×6」。 */
export function episodeMpState(queue: ShotQueue) {
  const tally = new Map<string, number>();
  for (const chapter of queue.chapters) for (const shot of chapter.shots) { const key = shotQueueMegapixels(shot, queue.defaults).toFixed(2); tally.set(key, (tally.get(key) ?? 0) + 1); }
  const counts = [...tally].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  const current = counts.length === 1 ? mpPreset(Number(counts[0].value)) : null;
  return { current, counts, mixed: counts.length > 1 ? `混合：${counts.map((item) => `${item.value} ×${item.count}`).join(" / ")}` : "" };
}

/** 正本 h3q 的时长提醒（WARN，前缀固定「[时长]」，见共享笔记「时长检查-给画布的约定」）。 */
export interface DurationAdvice {
  /** 整条原话（卡片原样显示） */
  text: string;
  kind: "long" | "short" | null;
  /** 「建议约 N 秒」的 N（5～15 整数）；认不出就是 null，只显示原话、不出按钮 */
  suggest: number | null;
  /** 有角色的镜头偏长时的另一条路：「保留 M 秒，把 X-Y秒 补成有内容的（…）」原话；没有就是 null */
  keep: string | null;
}

/** 解析一条 h3q 消息；不是「[时长]」开头的返回 null。 */
export function parseDurationAdvice(message: string): DurationAdvice | null {
  const text = message.trim();
  if (!text.startsWith("[时长]")) return null;
  const kind = /^\[时长\]\s*偏长/.test(text) ? "long" : /^\[时长\]\s*偏短/.test(text) ? "short" : null;
  // 只取「建议约 N 秒」（最后一个）；「保留 M 秒」里的 M 不是建议值。
  const all = [...text.matchAll(/建议约\s*(\d+)\s*秒/g)];
  const n = all.length ? Number(all[all.length - 1][1]) : NaN;
  const suggest = kind && Number.isInteger(n) && n >= SECONDS_MIN && n <= SECONDS_MAX ? n : null;
  const keepMatch = text.match(/要么(保留\s*\d+(?:\.\d+)?\s*秒[^；;]*?)[；;]\s*要么缩短/);
  return { text, kind, suggest, keep: keepMatch ? keepMatch[1].trim() : null };
}

/** 这一镜 h3q 结果里的时长提醒（一镜最多一条，取第一条）。 */
export function durationAdviceOf(items: readonly { message: string }[] | null | undefined): DurationAdvice | null {
  for (const item of items ?? []) { const advice = parseDurationAdvice(item.message); if (advice) return advice; }
  return null;
}

/** 「全部改成建议秒数」：只改有建议值、而且和现在不一样的镜头。返回逐镜旧 → 新和新队列。 */
export function planDurationFixes(queue: ShotQueue, adviceAt: (chapter: number, index: number) => DurationAdvice | null) {
  const rows: { title: string; from: number; to: number }[] = [];
  const chapters = queue.chapters.map((chapter, c) => ({ ...chapter, shots: chapter.shots.map((shot, s) => {
    const advice = adviceAt(c, s);
    if (!advice?.suggest || advice.suggest === shot.seconds) return shot;
    rows.push({ title: shot.title, from: shot.seconds, to: advice.suggest });
    return { ...shot, seconds: advice.suggest };
  }) }));
  return { rows, queue: { ...queue, chapters } };
}
