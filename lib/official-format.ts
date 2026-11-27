/**
 * MiniMax 官方格式正文（正本 v2026-11-13 起的写法，h3工具 6f71917；v2026-11-13.1 f053768 加了三栏式）：
 * - Ref2VA 六段式（绑了场景图 / 角色图的镜头）：subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music；
 * - 三栏式（T2VA / I2VA / FL2VA / L2VA，没有参考图）：[对齐句] integrated_multimodal_description / overall_soundscape / non_diegetic_music。
 * 认法和正本 h3q 一模一样（h3q.py official_kind）：行首有 integrated_multimodal_description: 是三栏式；否则行首六段栏目名出现两种以上是六段式。
 * 画布和 h3q 永远对同一镜下同一个结论。
 *
 * 画布对官方格式（2026-11-13 定）：
 * - 原样提交：不加禁背景乐的「这段听到的」和结尾英文句，不加 dialogue / voice 的英文追加段，不改参考说明，不自动送角色声音。
 *   配乐只由正文 non_diegetic_music 控制（不要配乐写 N/A）。
 * - 卡片：h3q 的 [官方·xx] ERROR 按单镜拦；画布自己的中文写法检查不判官方格式，五项兜底用和 h3q official_five 同一套英文词。
 * 只读解析，不改正文。
 */

export const OFFICIAL_FIELDS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"] as const;
/** 三栏式（T2VA / I2VA / FL2VA / L2VA） */
export const BASE_FIELDS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"] as const;
export type OfficialField = typeof OFFICIAL_FIELDS[number] | typeof BASE_FIELDS[number];
const HEAD = new RegExp(`^(${[...OFFICIAL_FIELDS, BASE_FIELDS[0]].join("|")}):`, "gm");

/** 正本 h3q 的 official_kind：ref = Ref2VA 六段式，base = 三栏式，null = 旧格式（第一集中文写法）。 */
export function officialKind(prompt: string | null | undefined): "ref" | "base" | null {
  const found = new Set([...(prompt ?? "").matchAll(HEAD)].map((m) => m[1]));
  if (found.has("integrated_multimodal_description")) return "base";
  return found.size >= 2 ? "ref" : null;
}
/** 正本 h3q 的 is_official。 */
export const isOfficialFormat = (prompt: string | null | undefined) => officialKind(prompt) !== null;

/** 各栏正文（第一次出现的那一段，去掉首尾空白）。三栏式第一行的对齐句不属于任何栏。 */
export function officialSections(prompt: string): Partial<Record<OfficialField, string>> {
  const fields: readonly string[] = officialKind(prompt) === "base" ? BASE_FIELDS : OFFICIAL_FIELDS;
  const head = new RegExp(`^(${fields.join("|")}):`, "gm");
  const marks = [...prompt.matchAll(head)].map((m) => ({ name: m[1] as OfficialField, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const out: Partial<Record<OfficialField, string>> = {};
  marks.forEach((mark, i) => { if (!(mark.name in out)) out[mark.name] = prompt.slice(mark.end, marks[i + 1]?.start ?? prompt.length).trim(); });
  return out;
}

export interface OfficialSubject {
  /** <Subject N> 的 N */
  index: number;
  /** 来自哪几张 <Picture N>（按出现先后） */
  pictures: number[];
  /** 「is」后面到「from / in / defined by / ,」之前的说法，例如 Zhang San、the daytime boardroom */
  name: string;
  /** 这一行原文 */
  line: string;
}

/** subject_definitions 里每个 <Subject N> 是谁、来自哪张图。 */
export function officialSubjects(prompt: string): OfficialSubject[] {
  const text = officialSections(prompt).subject_definitions ?? "";
  const out: OfficialSubject[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = /^<Subject\s*(\d+)>\s*(?:is|=|:)?\s*(.*)$/i.exec(line);
    if (!m) continue;
    const rest = m[2];
    const pictures = [...new Set([...rest.matchAll(/<Picture\s*(\d+)>/gi)].map((p) => Number(p[1])))];
    const name = rest.split(/\s+(?:from|in|defined by)\s+<Picture|,|:|;|\(/i)[0].replace(/^(?:the|a|an)\s+/i, "").trim().replace(/[.。]$/, "");
    if (!out.some((s) => s.index === Number(m[1]))) out.push({ index: Number(m[1]), pictures, name, line });
  }
  return out;
}

/** <Picture N> → 用它定义的 <Subject> 编号（一张图可以对多个 Subject，通常一个）。 */
export function subjectsByPicture(prompt: string): Map<number, OfficialSubject[]> {
  const map = new Map<number, OfficialSubject[]>();
  for (const subject of officialSubjects(prompt)) for (const p of subject.pictures) (map.get(p) ?? map.set(p, []).get(p)!).push(subject);
  return map;
}

export interface OfficialLine {
  /** 第几句（从 1 数，按正文先后） */
  order: number;
  /** 在哪个 [Shot N] 里；写在 [Shot] 之前是 0 */
  shot: number;
  /** <Subject N>；前面没写是 null */
  subject: number | null;
  /** S1、S2……；前面没写是 null */
  speakerId: string | null;
  /** 方括号里的语言，例如 Chinese；没写是 null */
  language: string | null;
  /** 台词原话 */
  text: string;
}

/**
 * detailed_description 里的 <d>[Chinese] …</d>：每句台词、谁说的（<Subject N>）、说话人编号（Sx）。
 * 说话人和编号取这句台词前面、上一句台词（或这个 [Shot]）之后最近的那个——正本写法是
 * 「<Subject 4>, a man … voice (S1), asks: <d>[Chinese] 又绕回原样了？</d>」。
 */
export function officialDialogue(prompt: string): OfficialLine[] {
  const sections = officialSections(prompt);
  const text = sections.detailed_description ?? sections.integrated_multimodal_description ?? prompt;
  const out: OfficialLine[] = [];
  let cursor = 0;
  for (const m of text.matchAll(/<d>([\s\S]*?)<\/d>/g)) {
    const at = m.index ?? 0;
    const shotMarks = [...text.slice(0, at).matchAll(/\[Shot\s*(\d+)\]/gi)];
    const shot = shotMarks.length ? Number(shotMarks.at(-1)![1]) : 0;
    const shotStart = shotMarks.length ? shotMarks.at(-1)!.index ?? 0 : 0;
    const before = text.slice(Math.max(cursor, shotStart), at);
    const subjects = [...before.matchAll(/<Subject\s*(\d+)>/gi)];
    const speakers = [...before.matchAll(/\((S\d+)\)/g)];
    const body = m[1].trim();
    const lang = /^\[([^\]]+)\]\s*/.exec(body);
    out.push({ order: out.length + 1, shot, subject: subjects.length ? Number(subjects.at(-1)![1]) : null, speakerId: speakers.length ? speakers.at(-1)![1] : null, language: lang ? lang[1].trim() : null, text: (lang ? body.slice(lang[0].length) : body).trim() });
    cursor = at + m[0].length;
  }
  return out;
}

/** 「S1（<Subject 4> 王五）：又绕回原样了？」这样一句一行，给卡片、复制给 AI、导出台词用。whoOf 把 Subject 编号翻成人名（翻不出给 null）。 */
export function officialDialogueLines(prompt: string, whoOf: (subject: number) => string | null = () => null) {
  return officialDialogue(prompt).map((line) => {
    const who = line.subject === null ? "" : `<Subject ${line.subject}>${whoOf(line.subject) ? ` ${whoOf(line.subject)}` : ""}`;
    const head = [line.speakerId ?? "", who].filter(Boolean).join(" ");
    return `${head ? `${head}：` : "（没标说话人）："}${line.text}`;
  });
}

/** [Shot N] At 00:04.000 的切点（秒）；[Shot 1] 是 0。 */
export function officialCuts(prompt: string): { shot: number; at: number }[] {
  const sections = officialSections(prompt);
  const text = sections.detailed_description ?? sections.integrated_multimodal_description ?? "";
  return [...text.matchAll(/\[Shot\s*(\d+)\](?:\s*At\s*(\d{1,2}):(\d{2}(?:\.\d+)?))?/gi)].map((m) => ({ shot: Number(m[1]), at: m[2] ? Number(m[2]) * 60 + Number(m[3]) : 0 }));
}

/**
 * 画面五项的官方格式写法：和正本 h3q official_five 同一套英文词（detailed_description / integrated_multimodal_description + subject_definitions 里找）。
 * 返回没写的类别和改法；h3q 没跑成时画布用它兜底。
 */
export const OFFICIAL_FIVE: readonly { id: "style" | "light" | "shotsize" | "compose" | "camera"; re: RegExp; how: string }[] = [
  { id: "style", re: /film grain|Kodak|grain\b|35mm film|film stock/i, how: "开头风格句写胶片和颗粒（Kodak Vision3 250D film grain）" },
  { id: "light", re: /light|lit\b|lamp|sun|window|daylight|neon|candle/i, how: "写光源、方向、冷暖（window light from the left, warm downlights）" },
  { id: "shotsize", re: /(close-up|close up|medium|wide|full shot|long shot|extreme close)[\s\S]*?(\d+\s?mm|depth of field|focus|bokeh)|(\d+\s?mm|depth of field)[\s\S]*?(close-up|close up|medium|wide|full shot|long shot)/i, how: "每个 [Shot] 写景别（close-up / medium shot），整体写焦段或景深（35mm-equivalent lens, shallow depth of field）" },
  { id: "compose", re: /(left|right|center|centre|middle|upper third|lower third)[\s\S]*?(foreground|background|midground|depth of field|blurred|behind)|(foreground|background|midground|depth of field)[\s\S]*?(left|right|center|centre|middle)/i, how: "写人在画面哪边（on the left of the frame）和层次（foreground / background 或 depth of field）" },
  { id: "camera", re: /(eye level|eye-level|low angle|high angle|overhead|top-down|three-quarter|side view|profile)[\s\S]*?(fixed|static|locked|push(es)? in|pull(s)? (out|back)|track|pan|tilt|dolly|handheld|follows)|(fixed|static|push(es)? in|track|pan|dolly|handheld)[\s\S]*?(eye level|low angle|high angle|three-quarter)/i, how: "写机位角度（eye level / low angle）和镜头怎么动（fixed camera / slowly pushes in）" },
];
export function officialFiveText(prompt: string) {
  const s = officialSections(prompt);
  return `${s.detailed_description ?? ""}\n${s.integrated_multimodal_description ?? ""}\n${s.subject_definitions ?? ""}`;
}

/** 卡片上的一句说明。 */
export const OFFICIAL_MUSIC_NOTE = "官方格式：配乐由正文 non_diegetic_music 控制";
export const OFFICIAL_SUBMIT_NOTE = "官方格式：正文原样提交（不加禁背景乐句、不加台词 / 声音追加段；写了 voiceRoleIds 才送角色声音）";
export const OFFICIAL_VOICE_NOTE = (n: number) => `🧪 官方格式送了 ${n} 条角色声音（voiceRoleIds 的顺序 = <Audio 1>…，各截前 8 秒），正文一字没改`;

/**
 * 官方格式送角色声音（2026-11-13，依据内部对比实验）：默认不送；队列写了 voiceRoleIds 才送，
 * 按顺序截前 8 秒接到 ref_audio_0…（= <Audio 1>…），正文一字不改，<Audio N> 由写队列的人写在正文里。
 * 这里查两边对不对得上：voiceRoleIds 的人数 = 正文里 <Audio N> 的个数，编号从 1 连续。对不上返回一句人话（含改法），对得上返回 null。
 * 不是官方格式返回 null（旧格式的 voiceRoleIds 另有规则）。
 */
export function officialVoiceProblem(prompt: string, voiceRoleIds: readonly string[] | undefined): string | null {
  if (!isOfficialFormat(prompt)) return null;
  const numbers = [...new Set([...prompt.matchAll(/<Audio\s*(\d+)>/gi)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const n = voiceRoleIds?.length ?? 0;
  const written = numbers.map((k) => `<Audio ${k}>`).join("、");
  if (!n && !numbers.length) return null;
  if (!n) return `正文写了 ${written}，但这一镜没写 voiceRoleIds，画布不会送声音，模型找不到这些声音。改法：在这一镜加 voiceRoleIds，按 <Audio 1>、<Audio 2> 的顺序列说话角色的 ID；或者删掉正文里的 <Audio N>`;
  const expected = Array.from({ length: n }, (_, i) => i + 1);
  if (numbers.length === n && numbers.every((k, i) => k === expected[i])) return null;
  return `voiceRoleIds 写了 ${n} 个人，${numbers.length ? `正文里写的是 ${written}` : "正文里一个 <Audio N> 都没写"}；两边要一样多，编号从 <Audio 1> 连续（<Audio 1> 是 voiceRoleIds 第 1 个人的声音，<Audio 2> 是第 2 个人的……）。改法：正文按 voiceRoleIds 的顺序写 ${expected.map((k) => `<Audio ${k}>`).join("、")}（在 subject_definitions 写清是谁的声音、台词前写 using the voice timbre referenced from <Audio N>），或者把 voiceRoleIds 改成和正文一样的人数和顺序`;
}
export const OFFICIAL_VOICE_ID = "official_voice";
export const OFFICIAL_VOICE_LABEL = "官方·角色声音";
