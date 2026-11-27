/**
 * 🧪 plain 声音路（队列字段 voiceRoleIds，2026-11-12，未试渲）。
 *
 * 正本「第一集写法」：dialogue 留空、台词只在正文「对白（中文普通话，口型同步）：」行。这种写法以前一条角色声音都不送。
 * voiceRoleIds 按对白行里第一次开口的顺序列说话角色（最多 3 个，都在 roleIds 里），每人的主声音按顺序送成
 * ref_audio_0…（<Audio 1>、<Audio 2>…，不占 9 张图的名额）。正文只在「参考说明」那一句末尾加一句，格式和图片一样：
 *   <Audio 1>是王五的声音，只用于王五说话的音色；<Audio 2>是张三的声音，只用于张三说话的音色。
 * 不加英文 binding 段、<Subject N>、(S1)、「Do not copy words…」这类元指令（会被念出来）。
 * 声音样本提交时由 ComfyUI 自带的 TrimAudioDuration 截成前 VOICE_SAMPLE_SECONDS 秒（原样本 39～51 秒）。
 * 依据：内部诊断「角色声音没送进模型」。
 */
import { H3_REF_LIMITS } from "./reference-manifest.ts";

/** 提交时只送声音样本的前这么多秒（5～10 秒的干净人声）。 */
export const VOICE_SAMPLE_SECONDS = 8;
/** 卡片：声音样本超过这么多秒报警告。 */
export const VOICE_SAMPLE_WARN_SECONDS = 15;

/** 正文里的参考说明那一句：以「参考说明」开头的那一行。 */
const REFERENCE_LINE = /^\s*参考说明/;
export const hasReferenceLine = (prompt: string) => prompt.split("\n").some((line) => REFERENCE_LINE.test(line));

export function voiceRoleIdsProblems(input: { voiceRoleIds: readonly string[]; roleIds: readonly string[]; voiceRoleId?: string; structured?: boolean; disabled?: boolean; soundMode?: string }) {
  const errors: string[] = [];
  const ids = input.voiceRoleIds;
  if (ids.length > H3_REF_LIMITS.audios) errors.push(`voiceRoleIds 最多 ${H3_REF_LIMITS.audios} 个说话角色（H3 最多 ${H3_REF_LIMITS.audios} 条参考声音）`);
  if (new Set(ids).size !== ids.length) errors.push("voiceRoleIds 不能重复");
  const outside = ids.filter((id) => !input.roleIds.includes(id));
  if (outside.length) errors.push(`voiceRoleIds 里的角色必须都在本镜头 roleIds 里：${outside.join("、")}`);
  if (input.voiceRoleId) errors.push("voiceRoleIds 和 voiceRoleId 不能同时写；列说话人只用 voiceRoleIds");
  if (input.structured) errors.push("voiceRoleIds 只配合「对白（…）：」行用，dialogue 要留空");
  if (input.disabled) errors.push("写了 voiceRoleIds 就不能同时写 autoVoiceDisabled");
  if (input.soundMode && input.soundMode !== "av") errors.push("voiceRoleIds 送角色声音，soundMode 必须是 av");
  return errors;
}

/** 「<Audio 1>是王五的声音，只用于王五说话的音色；<Audio 2>是张三的声音，只用于张三说话的音色。」 */
export function voiceReferenceSentence(voices: readonly { label: string; name: string }[]) {
  return voices.length ? `${voices.map((voice) => `${voice.label}是${voice.name}的声音，只用于${voice.name}说话的音色`).join("；")}。` : "";
}

/** 把声音说明接在参考说明那一行末尾；其余正文一个字不动。没有参考说明行就报错（不另找地方写名字）。 */
export function appendVoiceReference(prompt: string, voices: readonly { label: string; name: string }[]) {
  const sentence = voiceReferenceSentence(voices);
  if (!sentence) return prompt;
  const lines = prompt.split("\n");
  const at = lines.findIndex((line) => REFERENCE_LINE.test(line));
  if (at < 0) throw new Error("写了 voiceRoleIds，但正文没有「参考说明」那一句；声音说明只接在参考说明末尾");
  const cr = lines[at].endsWith("\r") ? "\r" : "";
  const body = lines[at].replace(/\r$/, "").replace(/\s+$/, "");
  lines[at] = `${body}${/[。；;.]$/.test(body) ? "" : "。"}${sentence}${cr}`;
  return lines.join("\n");
}
