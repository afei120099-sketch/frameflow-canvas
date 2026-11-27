import { isOfficialFormat } from "../official-format.ts";

export type H3SoundMode = "av" | "ambient" | "silent";

/** Queue prompts are capped at this length; the per-segment sound lines are dropped rather than push a prompt past it. */
export const H3_PROMPT_SOFT_LIMIT = 12000;

/** H3's node passes this plain string to clip.tokenize; it does not accept a JSON envelope. */
export function compileH3Prompt(raw: string, soundMode: H3SoundMode = "av", noBackgroundMusic = false) {
  const trimmed = raw.trim();
  // 官方 Ref2VA 六段式（正本 v2026-11-13）：原样提交，一个字不加；配乐由正文 non_diegetic_music 控制（lib/official-format.ts）。
  if (isOfficialFormat(trimmed)) return trimmed;
  const prompt = noBackgroundMusic ? suppressBackgroundMusic(trimmed, soundMode)
    : soundMode === "ambient" ? markAudibleSegments(trimmed, false) : trimmed;
  if (!prompt) return "";
  if (soundMode === "av") return prompt;
  if (soundMode === "ambient") return `${prompt}\n\n声音要求：可听到的只有与画面同步的房间底噪和动作声。`;
  return prompt;
}

export const NO_MUSIC_MARKER = "Audible audio is room tone and the action sounds already described.";
/** Same marker for an old queue whose lines sit in the `dialogue` field (正本 wants it empty; the card check flags it). */
export const NO_MUSIC_MARKER_WITH_LINES = "Audible audio is room tone, the numbered dialogue lines listed below, and the action sounds already described.";

/** Deterministic prompt constraint, not audio separation or a model-level guarantee. */
export function suppressBackgroundMusic(prompt: string, soundMode: H3SoundMode = "av") {
  if (!prompt.trim() || isOfficialFormat(prompt)) return prompt;
  const marker = /对白[（(]/.test(prompt)
    ? "Audible audio is room tone, the lines written in the 对白 section, and the action sounds already described."
    : NO_MUSIC_MARKER;
  const cleaned = prompt.replace(/(^|\n)(non_diegetic_music\s*:\s*)[\s\S]*?(?=\n(?:subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|integrated_multimodal_description)\s*:|$)/gi, "$1$2N/A");
  const segmented = markAudibleSegments(cleaned, soundMode !== "ambient");
  return segmented.includes(marker) ? segmented : `${segmented}\n\n${marker}`;
}

/*
 * Each time segment (「0-2秒：」, "[0s-2s]", "00:00-03:00") gets one sentence saying what is heard in it:
 * room tone, that segment's action sounds, and the dialogue when the segment has speech.
 * Positive wording only (commit cd92d7c), and never a name, 「开口」 or a meta instruction: 正本 v2026-11-09.6
 * says the model speaks those out loud. Whether there is speech at all comes from the 对白 row (or <d> tags), not
 * from 「开口」 in the segment (正本 forbids that word). A segment counts as speaking when it says 说话 / speaks;
 * when the shot has lines but no segment says so, every segment gets the generic 「对白和动作的声响」.
 */
const SEGMENT = /(?<![\d:])\d{1,2}:\d{2}(?:\.\d+)?[ \t]*[-–—~][ \t]*\d{1,2}:\d{2}(?:\.\d+)?|\[[ \t]*\d+(?:\.\d+)?[ \t]*s?[ \t]*[-–—~][ \t]*\d+(?:\.\d+)?[ \t]*s[ \t]*\]|(?:^|(?<=[。；;！？]))[ \t]*\d+(?:\.\d+)?[ \t]*(?:秒|s)?[ \t]*[-–—~～至到][ \t]*\d+(?:\.\d+)?[ \t]*(?:秒|s)[ \t]*[:：]/gm;
/** Fixed English endings that follow the last segment on the same line. */
const SEGMENT_TAIL = /\s(?:After the last word|One continuous take|No extra people|Any logos)/;
// 哪一段有人说话：和正本 h3q 的 GAP_SPEAK / GAP_NOT（[开场空白]）同一套词（2026-11-12：以前不认「说完」，
// 「把下一句说完」的段被加了「房间底噪和这段动作的声响」，和正文矛盾）。
// 前面带 不 / 没 / 别 的、「已经说完」「听他说完」不算说话。
const SPEAK_WORDS = /说话|说道|问道|答道|开口|回答|说完|接着说|说出|说一句|说那一?句|问一句|回一句|回了一句|应一声|应了一声|念|喊|说[：:“「"]|<d>|\bspeaks?\b|\bspeaking\b|\bsays?\b|\bsaying\b|\basks?\b|\banswers?\b/i;
const NOT_SPEAKING = /(?:不|没|别|没有|不再)(?:说话|开口|回答|说完|说出|念|喊)|已经说完|已说完|听[^，。；]{0,6}说完/g;
/** 这段文字里有人说话吗（时间段正文；对白行不用这个）。 */
export const segmentSpeaks = (text: string) => SPEAK_WORDS.test(text.replace(NOT_SPEAKING, ""));
const SPEAKS = { test: segmentSpeaks };
const ALREADY = /Heard in this segment:|这段听到的：/;
/** The 对白 row with at least one quoted line, or a non-empty <d> tag. */
const HAS_LINES = /(?:^|\n)[ \t]*(?:对白|台词)[ \t]*(?:（[^）\n]*）|\([^)\n]*\))?[ \t]*[：:][^\n]*[“"「][^\n]*\S[^\n]*[”"」]|<d>\s*(?:\[[^\]]*\])?\s*[^<\s][\s\S]*?<\/d>/;
export const hasDialogueLines = (prompt: string) => HAS_LINES.test(prompt);

export const AUDIBLE_SEGMENT_LINES = {
  en: "Heard in this segment: room tone and the sounds of this action.",
  enLine: "Heard in this segment: room tone, the dialogue spoken here and the sounds of this action.",
  zh: "这段听到的：房间底噪和这段动作的声响。",
  zhLine: "这段听到的：房间底噪、这段的对白和动作的声响。",
  /** The shot has lines, but no segment says where they are spoken. */
  enAny: "Heard in this segment: room tone, the dialogue and the sounds of this action.",
  zhAny: "这段听到的：房间底噪、对白和动作的声响。",
} as const;

/** Chinese segment = Chinese outside quoted lines and <d> tags. */
const isChinese = (text: string) => /[㐀-鿿]/.test(text.replace(/<d>[\s\S]*?<\/d>|“[^”]*”|「[^」]*」|"[^"]*"/g, ""));

/** Each segment's [start, end): to the next segment mark or the end of its line, minus a fixed English ending. */
function segmentRanges(prompt: string) {
  const marks = [...prompt.matchAll(SEGMENT)].map((m) => (m.index ?? 0) + (m[0].length - m[0].trimStart().length));
  return marks.map((start, i) => {
    const lineEnd = prompt.indexOf("\n", start);
    let end = Math.min(marks[i + 1] ?? prompt.length, lineEnd < 0 ? prompt.length : lineEnd);
    const tail = SEGMENT_TAIL.exec(prompt.slice(start, end));
    if (tail) end = start + tail.index;
    return { start, end };
  });
}

export function markAudibleSegments(prompt: string, allowLines: boolean) {
  const ranges = segmentRanges(prompt);
  if (!ranges.length) return prompt;
  const spoken = allowLines && hasDialogueLines(prompt);
  const placed = spoken && ranges.some(({ start, end }) => SPEAKS.test(prompt.slice(start, end)));
  let out = "";
  let cursor = 0;
  for (const { start, end } of ranges) {
    const body = prompt.slice(start, end);
    const kept = body.trimEnd();
    out += prompt.slice(cursor, start);
    cursor = end;
    if (ALREADY.test(body)) { out += body; continue; }
    const zh = isChinese(body);
    const kind = !spoken ? "plain" : !placed ? "any" : SPEAKS.test(body) ? "line" : "plain";
    const sentence = kind === "any" ? (zh ? AUDIBLE_SEGMENT_LINES.zhAny : AUDIBLE_SEGMENT_LINES.enAny)
      : kind === "line" ? (zh ? AUDIBLE_SEGMENT_LINES.zhLine : AUDIBLE_SEGMENT_LINES.enLine)
      : (zh ? AUDIBLE_SEGMENT_LINES.zh : AUDIBLE_SEGMENT_LINES.en);
    const closed = /(?:[.!?。！？…]["”」』）)]*|<\/d>)$/.test(kept) ? kept : `${kept}${zh ? "。" : "."}`;
    out += `${closed}${zh ? "" : " "}${sentence}${body.slice(kept.length)}`;
  }
  out += prompt.slice(cursor);
  return out.length > H3_PROMPT_SOFT_LIMIT && prompt.length <= H3_PROMPT_SOFT_LIMIT ? prompt : out;
}
