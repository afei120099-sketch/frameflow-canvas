/**
 * 开场空白（用户 2026-11-12 定为硬规则，正本 v2026-11-12.1）：有台词的镜头，第一句前不能空超过 1 秒。
 * 剧情需要先沉默的，拆成单独一个不带台词的镜头，或者挪进上一镜结尾。
 * 判定以正本 h3q 为准：h3q check 报 ERROR，消息带前缀 [开场空白]（只按前缀认，后面的文字正本窗口还会改）。
 * h3q 没跑成时用画布自己的判断兜底（canvasOpeningGap）：说话词和禁背景乐追加句同一套（lib/comfyui/h3-prompt.ts segmentSpeaks，
 * 也和 h3q 的 GAP_SPEAK / GAP_NOT 一致）。判断不了（没有对白行、没有时间段、找不到说话段）不报。
 * 拦法和画布五项一样（lib/shot-gate.ts）：这镜标红，渲染这一镜 / 全部入队 / 本章入队 / 收件箱都不提交；用户亲手「我确认没问题」可放行。
 */
import { segmentSpeaks } from "./comfyui/h3-prompt.ts";
import { isOfficialFormat } from "./official-format.ts";

export const OPENING_GAP_ID = "opening_gap" as const;
export const OPENING_GAP_LABEL = "开场空白";
export const OPENING_GAP_MAX = 1;
/** 卡片报错处、「复制给 AI 修改」里都写这三种改法。 */
export const OPENING_GAP_FIXES = "三种改法任选一种：① 把第一句挪到 0～1 秒内开始；② 剧情需要先沉默的，把沉默那段拆成单独一个不带台词的镜头；③ 把这段沉默挪进上一镜的结尾";
export const OPENING_GAP_RULE = "有台词的镜头，第一句说话要在 0～1 秒内开始，前面不能空超过 1 秒";

/** h3q v2026-11-12.2 起原话里自己带了 ①②③ 改法：带了就不再重复。 */
export const withOpeningGapFixes = (note: string) => /①/.test(note) ? note : `${note}。${OPENING_GAP_FIXES}`;

export const isOpeningGapMessage = (message: string) => message.includes("[开场空白]");

const HAS_DIALOGUE_ROW = /^\s*对白\s*[（(]/m;
const SEGMENT = /(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~～至到]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[:：]/g;

/** 正文里的时间段：[开始秒, 这段文字]（文字到下一个时间段或行尾）。 */
export function promptSegments(prompt: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  for (const line of prompt.split("\n")) {
    const marks = [...line.matchAll(SEGMENT)];
    marks.forEach((mark, i) => {
      const from = (mark.index ?? 0) + mark[0].length;
      const to = marks[i + 1]?.index ?? line.length;
      out.push({ start: Number(mark[1]), text: line.slice(from, to) });
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 画布兜底：第一句说话在第几秒开始；没超过 1 秒、或判断不了时返回 null。 */
export function canvasOpeningGap(prompt: string): number | null {
  // 官方 Ref2VA 六段式没有时间段，正本 v2026-11-13 也不查它的开场空白（h3q 不报 [开场空白]）。
  if (!HAS_DIALOGUE_ROW.test(prompt) || isOfficialFormat(prompt)) return null;
  const first = promptSegments(prompt).find((segment) => segmentSpeaks(segment.text));
  return first && first.start > OPENING_GAP_MAX ? first.start : null;
}

export const canvasOpeningGapNote = (title: string, start: number) => `${title}：有台词，但第一句说话在第 ${start} 秒才开始（开头空了 ${start} 秒）`;
