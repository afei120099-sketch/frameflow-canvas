// 镜头卡片「程序体检」：画布自己的提醒（lib/h3-prompt-health.ts、对白语速、帧数对齐、锚点间隔、旧 dialogue 字段）。
// 只是提醒，不拦截。和正本 h3q 或卡片别处已经说了的同一件事，在卡片上合并成一条（列在「已合并」里，不显示两遍）。
import { durationAlignmentWarning, shotPromptWarnings } from "./shot-prompt-checks.ts";
import { shotHealthHints, timeAnchorWarnings, type ShotQueueDefaults, type ShotQueueShot } from "./shot-queue.ts";

export interface HealthEntry { code: string; message: string }
export interface MergedEntry extends HealthEntry { into: string }
export interface CardHealth { items: HealthEntry[]; merged: MergedEntry[] }

/**
 * 这一镜的全部体检提示（带 code）。和 shotQueueWarnings 里每镜那部分同一套来源，
 * 只是不含「本集设定」的整集提示（那些在「本集设定」小卡片里；单镜算会把别的镜用到的设定误报成「整集没有一镜用到」）。
 */
export function rawShotHealth(shot: ShotQueueShot, defaults?: ShotQueueDefaults): HealthEntry[] {
  const out: HealthEntry[] = [];
  if (shot.autoVoiceAssigned) out.push({ code: "dialogue_voice", message: "检测到台词且未指定 voiceRoleId，已自动使用本镜头第一个角色的主声音；请核对角色和 Audio 编号" });
  (shot.dialogue ?? []).forEach((line, index) => { if (!line.roleId) out.push({ code: "dialogue_speaker", message: `第${index + 1}句「${line.speaker}」${line.voice?.startsWith("audio:") ? "使用指定声音素材，不带角色主声音" : "该句不带角色声音（无声音参考）"}；请在提示词里明确此人的身份、外观及声音特征${shot.prompt.includes(line.speaker ?? "") ? "" : "；当前提示词未找到该说话者名称"}` }); });
  for (const message of shotPromptWarnings(shot.prompt, shot.seconds, shot.dialogue)) out.push({ code: message.startsWith("对白可能过快") ? "dialogue_fast" : message.startsWith("对白可能偏慢") ? "dialogue_slow" : "dialogue_unread", message });
  const align = durationAlignmentWarning(shot.seconds);
  if (align) out.push({ code: "duration_align", message: align });
  for (const hint of shotHealthHints(shot, defaults)) out.push({ code: `health:${hint.code}`, message: `体检：${hint.message}` });
  for (const message of timeAnchorWarnings(shot)) out.push({ code: "time_anchor", message });
  return out;
}

/** 正本从哪一版开始有「[时长]」检查（h3工具 v2026-11-11.6）。 */
export const H3Q_DURATION_SINCE = "v2026-11-11.6";
export function versionAtLeast(version: string | undefined, need: string) {
  const parse = (text: string | undefined) => { const m = /v?(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?/.exec(text ?? ""); return m ? m.slice(1).map((part) => Number(part ?? 0)) : null; };
  const have = parse(version), want = parse(need)!;
  if (!have) return false;
  for (let i = 0; i < 4; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}

/**
 * 去重：只合并能确定说的是同一件事的。
 * - duration_align「请求 X 秒，帧数对齐后约 Y 秒」= 参数列「实际」格子，永远合并。
 * - 体检 timeline_overflow「时间段写到 X 秒，但镜头只有 Y 秒」= 卡片检查 timeline_overflow / timeline_trim（有那条时合并）。
 * - dialogue_fast（> 6 字当量/秒）：h3q 的「字/秒 > 3.5」更严，h3q 报了就合并。
 * - dialogue_slow（< 1.5 字当量/秒，「偏慢或留白」）：h3q 有「[时长]」就合并进去；h3q 跑成了、正本 ≥ v2026-11-11.6 却没报 [时长]，
 *   说明正本认为时长合适（正本还要求台词后留 1～2 秒），也合并（以正本为准）。
 * - 体检 too_many_beats（动作节点太密）：h3q 报「[时长] 偏短」时合并。
 */
export function cardHealth(raw: readonly HealthEntry[], ctx: { h3q: readonly { message: string }[] | null; h3qVersion?: string; cardCodes: readonly string[] }): CardHealth {
  const h3q = ctx.h3q ?? [];
  const duration = h3q.find((item) => item.message.trim().startsWith("[时长]"));
  const rate = h3q.find((item) => /字\s*\/\s*秒/.test(item.message));
  const timeline = ctx.cardCodes.includes("timeline_overflow") || ctx.cardCodes.includes("timeline_trim");
  const hasDurationCheck = ctx.h3q !== null && versionAtLeast(ctx.h3qVersion, H3Q_DURATION_SINCE);
  const items: HealthEntry[] = [], merged: MergedEntry[] = [];
  for (const entry of raw) {
    const into = entry.code === "duration_align" ? "参数列「实际」格子（实际秒数和帧数）"
      : entry.code === "health:timeline_overflow" && timeline ? "卡片检查「时间轴写到 … 秒」"
      : entry.code === "dialogue_fast" && rate ? "正本 h3q 的台词字数 / 秒检查"
      : entry.code === "dialogue_slow" && duration ? "正本 h3q「[时长]」"
      : entry.code === "dialogue_slow" && hasDurationCheck ? "正本 h3q 时长检查（没报 = 正本认为时长合适；正本要求台词后留停顿）"
      : entry.code === "health:too_many_beats" && duration && /^\[时长\]\s*偏短/.test(duration.message.trim()) ? "正本 h3q「[时长] 偏短」"
      : "";
    if (into) merged.push({ ...entry, into }); else items.push(entry);
  }
  return { items, merged };
}

/** 顶部「程序体检」小卡片的计数。 */
export function healthDigest(list: readonly (CardHealth | undefined)[]) {
  const shots = list.filter((health) => (health?.items.length ?? 0) > 0).length;
  const items = list.reduce((sum, health) => sum + (health?.items.length ?? 0), 0);
  const merged = list.reduce((sum, health) => sum + (health?.merged.length ?? 0), 0);
  return { shots, items, merged, text: items ? `${shots} 镜有 ${items} 条体检提示${merged ? ` · 另有 ${merged} 条和 h3q / 卡片重复，已合并` : ""}` : merged ? `没有要看的体检提示（${merged} 条和 h3q / 卡片重复，已合并）` : "没有体检提示" };
}
