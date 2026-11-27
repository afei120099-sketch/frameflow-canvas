/**
 * 镜头卡片「画布自己的检查」：只留正本 h3q check 查不到的（画布独有）——参考图实际提交顺序和数量、
 * 素材 / 角色 ID 找不到、主外观没绑、帧数对齐后的时间轴、对白说话人不在本镜、每段有没有看得见的动作、
 * 绑了的角色有没有被提到、有没有写声音。
 * 写法规则（dialogue 留空、人名位置、嘴、点名配乐、定格、no logos、元指令、景别 / 构图 / 光线 / 左右手、
 * 说话段字数、8 秒以上分段……）只认正本 %FRAMEFLOW_H3_TOOLS%\SKILL_h3-video.md 的 h3q check 一处，
 * 卡片直接调用 h3q 显示（lib/h3q-report.ts），这里不再重复，免得两边说法打架。只读，不改提示词。
 */
import { nameSubjects, type ShotBreakdown, type ShotBeat } from "./shot-card-breakdown.ts";
import { VOICE_SAMPLE_SECONDS, VOICE_SAMPLE_WARN_SECONDS } from "./voice-roles.ts";
import { isOfficialFormat } from "./official-format.ts";

export type CheckLevel = "error" | "warn" | "hint";
/** source "h3q" = 正本 h3q check 给的（卡片标「正本 h3q」）；没有 source = 画布自己的检查。hint 只给 h3q 的 HINT 用，不算漏写。 */
export interface ShotCheck { code: string; level: CheckLevel; message: string; source?: "h3q" }

export interface CheckRole {
  name: string; offscreen: boolean; speaks: boolean; hasAppearance: boolean; hasVoice: boolean; missing: boolean;
  /** 🧪 在这一镜的 voiceRoleIds 里（会送主声音）。 */
  voiceListed?: boolean;
  /** 主声音样本的时长（秒），角色库里没记就是 null。 */
  voiceSeconds?: number | null;
}
export interface CheckInput {
  prompt: string;
  breakdown: ShotBreakdown;
  /** Actual H3 seconds after frame alignment. */
  actualSeconds: number;
  /** What the queue asked for (shot.seconds). Defaults to actualSeconds. */
  requestedSeconds?: number;
  soundMode: "av" | "ambient" | "silent";
  /** Picture labels in submission order, e.g. { label: "Picture 3", name: "角色 张三" }. Empty when the plan failed. */
  pictures: { label: string; name: string }[];
  roles: CheckRole[];
  /** Old queues: `dialogue` field lines by speaker name. 正本 wants this empty. */
  fieldLines: Record<string, string[]>;
  autoVoiceDisabled?: boolean;
  noBackgroundMusic: boolean;
  /** 🧪 这一镜写了 voiceRoleIds（plain 声音路）。没写就不做下面的声音检查，旧队列一条不多报。 */
  voiceRoles?: boolean;
}

const SPEAK = /^(.+?)(?:\s+speaks\b|开口|说话|说道|问道|回答|说[：:“]|说$)/;
const STATIC = /^(看着|看向|盯着|眼睛还|视线还|目光还|人留在|保持|停在|stays?|remains?|keeps? looking|still looking|looks at)/i;
// 正本 h3q check 的同一组词：点名配乐就会配上音乐。只给「一键删掉点名配乐」用，判断以 h3q 为准。
const NAMED_MUSIC = /没有背景音乐|无背景音乐|不要背景音乐|禁止背景音乐|没有配乐|无配乐|不要配乐|不要音乐|no background music|background music|without (?:any )?music|soundtrack|musical score|non-diegetic music|any music|BGM/i;
/** 正文点名了配乐（给整集「一键删掉」按钮找镜头用）。 */
export const namesMusic = (prompt: string) => NAMED_MUSIC.test(prompt);
const timed = (b: ShotBreakdown) => b.beats.filter((beat) => beat.start >= 0);
const plainLine = (text: string) => text.replace(/^[^：:]*[：:]\s*/, "").replace(/[“”"「」]/g, "");

/** Speaker of a beat: "张三开口" / "Subject 1 speaks" (names already substituted). */
export function beatSpeaker(beat: ShotBeat, names: readonly string[]) {
  for (const clause of beat.story) {
    const who = SPEAK.exec(nameSubjects(clause.replace(/^最终：/, ""), names))?.[1]?.trim().replace(/^(?:同时|然后|接着|随后|紧接着|这时|此时|再|又|也|and|then)\s*/i, "").trim();
    if (who && who.length <= 12) return who;
  }
  return null;
}

/** Dialogue lines from the prompt text: the 对白 row ("张三：“…” 李四：“…”") and <d>…</d> tags, grouped by speaker. */
export function promptLines(prompt: string, breakdown: ShotBreakdown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of breakdown.dialogue) {
    const m = /^([^：:（(“"]{1,12})(?:（[^）]*）|\([^)]*\))?\s*[：:]\s*(.+)$/.exec(line.trim());
    if (m) (out[m[1].trim()] ??= []).push(plainLine(m[2]));
  }
  for (const m of prompt.matchAll(/<d>\s*(?:\[[^\]]*\])?\s*([\s\S]*?)<\/d>/g)) (out["?"] ??= []).push(m[1].trim());
  return out;
}

/**
 * 正本：人名只许出现在参考说明「是张三，只用于」、对白行和设定档光线句。Same lines h3q check skips:
 * 参考说明 / 对白 / 画面要求 lines, and a line without 秒 that is a light sentence (灯火 / 光照 / 灯光).
 * Only for the 第一集写法 (has 参考说明, not the six English sections). Names = this shot's roles + 「是X，…只用于」.
 */
export function misplacedNames(prompt: string, roleNames: readonly string[]) {
  if (!prompt.includes("参考说明") || prompt.includes("subject_definitions:")) return [];
  const names = [...new Set([...roleNames.filter((name) => name && name.length >= 2), ...[...prompt.matchAll(/是([一-鿿]{2,4})[，,][^。\n]{0,40}?只用于/g)].map((m) => m[1])])];
  const kept = prompt.split("\n").filter((raw) => {
    const line = raw.trim();
    if (/^(?:参考说明|对白|台词|画面要求)/.test(line) && !/^台词语气/.test(line)) return false;
    if (!line.includes("秒") && /灯火|光照|灯光/.test(line)) return false;
    return true;
  }).join("\n");
  return names.filter((name) => kept.includes(name));
}

export function checkShot(input: CheckInput): ShotCheck[] {
  const { prompt, breakdown: b, actualSeconds, roles, pictures } = input;
  const checks: ShotCheck[] = [];
  const error = (code: string, message: string) => checks.push({ code, level: "error", message });
  const warn = (code: string, message: string) => checks.push({ code, level: "warn", message });
  const names = roles.map((role) => role.name);
  const visible = roles.filter((role) => !role.offscreen && !role.missing);
  const beats = timed(b);
  // 官方 Ref2VA 六段式（正本 v2026-11-13）：只查画布独有、和写法无关的（Picture 编号够不够、角色库找不到、没绑主外观）；
  // 时间段、对白行、声音行、每段动作、人名 / Subject 对应这些中文写法的检查不判，写法对错只看 h3q [官方·…]。
  const official = isOfficialFormat(prompt);

  // 1. Picture 编号 vs the real submission order.
  const usedNumbers = [...prompt.matchAll(/<Picture\s*(\d+)>/g)].map((m) => Number(m[1]));
  if (pictures.length && usedNumbers.length && Math.max(...usedNumbers) > pictures.length) error("picture_count", `提示词用到 <Picture ${Math.max(...usedNumbers)}>，但这一镜实际只有 ${pictures.length} 张参考图`);
  if (pictures.length && !official) {
    for (const m of b.reference.matchAll(/<Picture\s*(\d+)>\s*(?:是|is|:|：)?\s*([^；;。<]*)/g)) {
      const k = Number(m[1]); const said = m[2];
      const actual = pictures[k - 1]; if (!actual) continue;
      const actualRole = actual.name.startsWith("角色 ") ? actual.name.slice(3) : null;
      // The name right after "是" decides ("<Picture 1>是李四，只用于李四的脸"), so take the earliest one.
      const saidRole = names.filter((name) => name && said.includes(name)).sort((a, b) => said.indexOf(a) - said.indexOf(b))[0];
      if (actualRole && saidRole && saidRole !== actualRole) error("picture_order", `参考说明写 <Picture ${k}> 是${saidRole}，实际第 ${k} 张是${actualRole}`);
      else if (!actualRole && saidRole) error("picture_order", `参考说明写 <Picture ${k}> 是${saidRole}，实际第 ${k} 张是${actual.name}`);
      else if (actualRole && !saidRole && /场景|scene|办公室|房间|office|room/i.test(said)) error("picture_order", `参考说明写 <Picture ${k}> 是场景图，实际第 ${k} 张是${actualRole}`);
    }
  }

  // 2. 时间轴.
  if (beats.length && !official) {
    const last = beats[beats.length - 1];
    const requested = input.requestedSeconds ?? actualSeconds;
    if (last.end > Math.max(requested, actualSeconds) + 0.05) error("timeline_overflow", `时间轴写到 ${last.end} 秒，超过了这一镜的 ${requested} 秒，最后一段会被切掉`);
    else if (last.end > actualSeconds + 0.25) warn("timeline_trim", `H3 实际只出 ${actualSeconds.toFixed(2)} 秒，比时间轴短 ${(last.end - actualSeconds).toFixed(2)} 秒，最后一段会被压缩一点`);
    if (beats[0].start > 0.05) error("timeline_gap", `时间轴从 ${beats[0].start} 秒才开始，前面没写`);
    for (let i = 1; i < beats.length; i++) {
      const gap = beats[i].start - beats[i - 1].end;
      if (gap > 0.05) error("timeline_gap", `${beats[i - 1].range} 和 ${beats[i].range} 之间空了 ${gap.toFixed(1)} 秒`);
      if (gap < -0.05) error("timeline_overlap", `${beats[i - 1].range} 和 ${beats[i].range} 重叠`);
    }
    if (last.end < actualSeconds - 1) warn("timeline_short", `时间轴只写到 ${last.end} 秒，后面 ${(actualSeconds - last.end).toFixed(1)} 秒没写动作，模型会自己编或冻住`);
  }

  // 3. 对白说话人（dialogue 留空、说话段字数由 h3q 查）.
  const textLines = promptLines(prompt, b);
  if (!official) for (const speaker of Object.keys(textLines)) if (speaker !== "?" && names.length && !names.includes(speaker)) warn("dialogue_speaker", `对白里的「${speaker}」不在这一镜的角色里`);

  // 4. 角色绑定.
  for (const role of roles) {
    if (role.missing) { error("role_missing", `角色「${role.name}」在角色库里找不到`); continue; }
    if (!role.offscreen && !role.hasAppearance) error("role_appearance", `${role.name} 出镜但没绑主外观`);
    // No voice check: 正本 submits the 对白 row as written, without role voices.
  }

  // 4b. 🧪 voiceRoleIds（送角色声音）：对白行里每个说话人都要列进去、都要有主声音；样本太长报警告（提交时只送前 VOICE_SAMPLE_SECONDS 秒）。
  if (input.voiceRoles && !official) {
    const speakers = Object.keys(textLines).filter((speaker) => speaker !== "?");
    for (const speaker of speakers) {
      const role = roles.find((item) => item.name === speaker);
      if (!role) continue; // 不在这一镜的角色里，上面 dialogue_speaker 已经报了
      if (!role.voiceListed) error("voice_role_unlisted", `对白里${speaker}有台词，但没写进 voiceRoleIds，这句不会带${speaker}的声音`);
      else if (!role.hasVoice) error("voice_role_no_voice", `${speaker}在 voiceRoleIds 里，但角色库里没有可用的主声音，提交会失败；先在角色库给${speaker}设主声音`);
    }
    for (const role of roles) if (role.voiceListed && !speakers.includes(role.name)) warn("voice_role_silent", `${role.name}写进了 voiceRoleIds，但对白行里没有这个人的台词；不说话的人不要送声音`);
    for (const role of roles) if (role.voiceListed && role.hasVoice && typeof role.voiceSeconds === "number" && role.voiceSeconds > VOICE_SAMPLE_WARN_SECONDS) warn("voice_sample_long", `${role.name}的声音样本有 ${role.voiceSeconds.toFixed(1)} 秒，超过 ${VOICE_SAMPLE_WARN_SECONDS} 秒；提交时只送前 ${VOICE_SAMPLE_SECONDS} 秒，前 ${VOICE_SAMPLE_SECONDS} 秒要是这个人干净的说话声（没有音乐、底噪、别人说话）`);
  }

  // 5. 没写声音（h3q 不查有没有声音段）.
  if (official) {
    // 官方格式写了 voiceRoleIds：每人要有主声音（没有提交会失败）；样本太长照旧提醒。人数和 <Audio N> 对不上在画面检查里拦（lib/shot-gate.ts）。
    if (input.voiceRoles) for (const role of roles) {
      if (!role.voiceListed || role.missing) continue;
      if (!role.hasVoice) error("voice_role_no_voice", `${role.name}在 voiceRoleIds 里，但角色库里没有可用的主声音，提交会失败；先在角色库给${role.name}设主声音`);
      else if (typeof role.voiceSeconds === "number" && role.voiceSeconds > VOICE_SAMPLE_WARN_SECONDS) warn("voice_sample_long", `${role.name}的声音样本有 ${role.voiceSeconds.toFixed(1)} 秒，超过 ${VOICE_SAMPLE_WARN_SECONDS} 秒；提交时只送前 ${VOICE_SAMPLE_SECONDS} 秒，前 ${VOICE_SAMPLE_SECONDS} 秒要是这个人干净的说话声（没有音乐、底噪、别人说话）`);
    }
    return checks;
  }
  if (input.soundMode !== "silent" && !b.sound.length && !beats.some((beat) => beat.sound.length)) warn("no_sound", "没写声音或环境声，H3 可能自己编人声或配乐");

  // 6. 每段有人动.
  // "张三的眼睛还看着她" → "眼睛还看着她": drop the leading subject before testing for a static verb.
  const subject = new RegExp(`^(?:${[...names.filter(Boolean).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "他", "她", "两人", "两个人", "he", "she", "they"].join("|")})(?:的|'s)?\\s*`, "i");
  const isStatic = (clause: string) => STATIC.test(nameSubjects(clause, names).replace(subject, "").trim());
  for (const beat of beats) {
    const story = beat.story.filter((clause) => !clause.startsWith("最终："));
    if (!story.length) warn("beat_empty", `${beat.range} 没写人在做什么（只有口型或镜头）`);
    else if (story.every(isStatic)) warn("beat_static", `${beat.range} 只有「看着 / 停在」，没有看得见的动作，模型会冻住或自己编`);
  }

  // 7. 绑了外观的角色没被提到.
  const named = nameSubjects(prompt, names);
  for (const role of visible) if (!named.includes(role.name)) warn("role_unmentioned", `${role.name} 绑了外观，但提示词里一次都没提到（也没有对应的 Subject 编号）`);

  return checks;
}
