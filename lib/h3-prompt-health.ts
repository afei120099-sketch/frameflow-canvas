/**
 * H3 提示词体检 — writing-pattern hints for the user's RAW prompt (never the compiled text: the compiler
 * appends its own fixed sentences). Hints only: nothing is blocked, truncated or rewritten.
 *
 * Grounded in: local H3 runs at cfg=1 (no negative branch, so "no X" tends to add X — Comfy H3 guide);
 * first-frame shots should open by describing the visible frame (I2V guides); empty sound fields invite
 * invented voices (Comfy H3 guide); 2026-11-08 same-seed tests here: the 10-step DMAD config lags ~1 s and
 * drops beats on multi-action shots, the understanding preset keeps the timeline.
 * There is deliberately no length rule: the old 4000-character warning was removed for lack of evidence.
 */

import { isUnderstandingPreset, parseCommunityValues } from "./comfyui/experimental/h3-community-controls.ts";
import { hasDialogueLines } from "./comfyui/h3-prompt.ts";
import { isOfficialFormat, officialCuts } from "./official-format.ts";

/** "understanding" when a node's saved community parameters are exactly the preset; anything else runs the 10-step graph. */
export function tuningOfParameters(serialized?: string): "default" | "understanding" {
  try { return isUnderstandingPreset(parseCommunityValues(serialized, "community-ultimate")) ? "understanding" : "default"; } catch { return "default"; }
}

export interface PromptHealthContext {
  seconds: number;
  /** The shot starts from a keyframe / first frame (first-last, firstFrameFrom, production keyframe). */
  firstFrame?: boolean;
  soundMode?: "av" | "ambient" | "silent";
  /** Structured dialogue lines exist (queue dialogue[] / production dialogue). */
  hasDialogue?: boolean;
  /** Roles that speak off screen. */
  offscreen?: boolean;
  /** "understanding" = no DMAD LoRA, 25 steps. Anything else is the 10-step accelerated graph. */
  tuning?: "default" | "understanding";
}

export interface PromptHint { code: string; message: string }

// The H3 compiler's own constraint sentences and tag syntax are not the user's wording.
const IGNORE = [/<\/?d[^>]*>/gi, /<(?:Subject|Picture|Audio|Video) \d+>/gi];
const ACTION_EN = /\b(?:turns?|walks?|runs?|jumps?|raises?|lifts?|swings?|strikes?|punch(?:es)?|kicks?|draws?|grabs?|pulls?|pushes?|steps?|rushes?|charges?|leaps?|spins?|slashes?|throws?|falls?|stands? up|sits? down|reaches?|looks? (?:up|back|down|around))\b/i;
const ACTION_ZH = /转身|抬起|举起|走向|走到|跑|跳|冲|挥|劈|砍|刺|踢|拳|拔剑|抓|拉|推|扑|迈步|起身|坐下|回头|扭头|伸手/;
// Compound words only: "blocking" is staging, 剑眉/手掌/刺眼 are not fights.
const FIGHT = /\b(?:fight(?:s|ing)?(?! (?:a |the |back |off )?(?:smile|grin|laugh|tears?|urge|blush|yawn))|punch(?:es|ing)?|kick(?:s|ing)?|sword(?:s|play)?|slash(?:es|ing)?|strikes? (?:at|back)|duel|combat|parr(?:y|ies|ied)|dodg(?:e|es|ing)|swings? (?:the|his|her) (?:sword|blade|staff)|lunges?)\b|打斗|打戏|过招|出招|交手|厮杀|格挡|闪避|挥剑|拔剑|出剑|剑光|剑锋|剑气|剑招|挥刀|拔刀|刀光|出掌|掌风|出拳|挥拳|一拳|飞踢|踢中|劈向|砍向|刺向|刺出/i;
const SOUND = /\b(?:sound|ambience|ambient|silence|silent|quiet|footsteps?|wind|rain|music|hum|chime|noise|echo|breath(?:ing)?|rustl\w*|crackl\w*|groan\w*|rattl\w*|rumbl\w*|clang\w*|thud\w*|splash\w*|roar\w*|whisper\w*|creak\w*|bang\w*|crash\w*|whoosh\w*|drip\w*)\b|声|音|风|雨|脚步|静|鸟鸣|呼吸/i;
/** H3's structured sound field with real content counts as a written soundscape. */
const SOUND_FIELD = /overall_soundscape\s*[:：]\s*(?!N\/?A\b|none\b|无)\S/i;
const OFFSCREEN_OK = /off-?screen|voice-?over|画外|旁白/i;
const TIMESTAMP = /\[\s*(\d+(?:\.\d+)?)\s*s?\s*[-–~～至到]\s*(\d+(?:\.\d+)?)\s*s?\s*\]|(\d+(?:\.\d+)?)\s*[-–~～至到]\s*(\d+(?:\.\d+)?)\s*秒/g;

function clean(prompt: string) {
  let text = prompt;
  for (const pattern of IGNORE) text = text.replace(pattern, " ");
  return text;
}

/** First sentence of the user's own description, skipping a "<Picture 1> is the first frame" style binding. */
function firstDescriptiveSentence(prompt: string) {
  const sentences = prompt.replace(/\r/g, "").split(/(?<=[.。!！?？\n])\s*/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (/^\s*(?:<Picture 1>|Picture 1\b).{0,60}\b(?:first|opening|starting) frame\b[.。]?$/i.test(sentence)) continue;
    if (/^(?:subject_definitions|角色|人物)\s*[:：]/i.test(sentence)) continue;
    return sentence;
  }
  return "";
}

export function h3PromptHealth(rawPrompt: string, context: PromptHealthContext): PromptHint[] {
  const hints: PromptHint[] = [];
  const text = clean(rawPrompt);

  // 「否定写法」检查已删：正本「画面要求」本身就写「没有字幕、水印或文字叠加」「不要互换脸」，和它冲突；写法以正本 h3q 为准。

  // 2. First-frame shots: open with what is visible.
  if (context.firstFrame) {
    const first = firstDescriptiveSentence(rawPrompt);
    if (first && (ACTION_EN.test(first) || ACTION_ZH.test(first)) && first.length < 160) {
      hints.push({ code: "first_sentence", message: `有首帧，但第一句直接写动作（"${first.slice(0, 60)}${first.length > 60 ? "…" : ""}"）：建议先用一句话描述首帧里能看到的人物、站位、服装、光线，再写动作，减少开头冻一秒或跳画面` });
    }
  }

  // 3. Sound: shots without dialogue need a concrete soundscape. 正本: 声音段只写房间底噪、对白和动作声;
  // never 「不出声 / stays silent」 (spoken out loud).
  if (context.soundMode !== "silent" && !context.hasDialogue && !hasDialogueLines(rawPrompt) && !SOUND.test(text) && !SOUND_FIELD.test(rawPrompt)) {
    hints.push({ code: "soundscape", message: "无台词镜头没写声音：H3 可能自己编人声。写一行「声音：很轻的房间底噪，纸页轻响。」这类房间底噪和动作声；不要写不出声、不说话、没有背景音乐" });
  }

  // 4. Off-screen speech: mark it in the 对白 row. No mouth wording (正本: 「嘴唇闭着」 gets spoken).
  if (context.offscreen && !OFFSCREEN_OK.test(rawPrompt)) {
    hints.push({ code: "offscreen", message: "有画外音角色：在对白行里标明画外音，如「对白（中文普通话，口型同步）：张三（画外音）：“……”」；动作段不写嘴" });
  }

  // 5. Timeline: segments past the shot length; too many beats for the length.
  const segments: { start: number; end: number }[] = [];
  for (const match of rawPrompt.matchAll(TIMESTAMP)) {
    const start = Number(match[1] ?? match[3]); const end = Number(match[2] ?? match[4]);
    if (Number.isFinite(start) && Number.isFinite(end)) segments.push({ start, end });
  }
  const over = segments.filter((segment) => segment.end > context.seconds + 0.25);
  if (over.length) hints.push({ code: "timeline_overflow", message: `时间段写到 ${Math.max(...over.map((s) => s.end))} 秒，但镜头只有 ${context.seconds} 秒：超出部分的动作大概率被挤掉或压缩` });
  // 官方 Ref2VA 六段式：节点按 [Shot N] 数（正文里的 then 是动作先后，不是节点）。
  const official = isOfficialFormat(rawPrompt);
  const beats = official ? officialCuts(rawPrompt).length || 1 : segments.length || (rawPrompt.match(/\b(?:then|after that|next)\b|然后|接着|随后|紧接着/gi) ?? []).length + 1;
  if (beats >= 3 && context.seconds / beats < 1.4) hints.push({ code: "too_many_beats", message: `${beats} 个动作节点挤在 ${context.seconds} 秒里（每个不到 1.4 秒）：实测 7 秒 4 个节点能做完，再密容易漏动作。拆成两镜或减少节点` });

  // 6. Fights / multi-beat action on the accelerated graph.
  if (context.tuning !== "understanding") {
    if (FIGHT.test(text)) hints.push({ code: "fight_accelerated", message: "打斗/大动作镜头还在用 10 步加速配置：加速 LoRA 容易让招式变慢、中途冻住。建议这一镜改用「理解优先」（队列写 tuning: \"understanding\"，约 1.5–2.3 倍耗时）" });
    else if (beats >= 4) hints.push({ code: "beats_accelerated", message: `${beats} 个按时间排的动作节点：同种子实测 10 步配置会整体慢约 1 秒、跳过中间动作；要卡准时间点可改用「理解优先」` });
  }
  return hints;
}

export const h3PromptHealthMessages = (rawPrompt: string, context: PromptHealthContext) => h3PromptHealth(rawPrompt, context).map((hint) => `体检：${hint.message}`);
