/**
 * 一键选预设：从用户词库 vocab.json（%FRAMEFLOW_H3_TOOLS%\源文件\vocab.json，开发服务器实时读，画布只读不写）
 * 选一条，替换这一镜正文里对应的那句。景别另有一排快捷按钮（特写 / 近景 / 中景 / 全景 / 远景）。
 * 替换进去的文字按正本「第一集写法」清理：「主体」换成他 / 她（或删掉），不写人名，不点名配乐，
 * 不写「开口 / 不出声 / 嘴唇闭着」、定格、唯一光源和「不暗」类否定句。
 */
import type { PresetKind } from "./zhengben-categories.ts";
import type { ShotQueue } from "./shot-queue.ts";
import { episodeSegments, episodeUsage, withEpisode, type EpisodeSettings } from "./episode-settings.ts";
import { isOfficialFormat } from "./official-format.ts";
/** 官方格式镜头不能用中文词库预设。 */
export const OFFICIAL_PRESET_NOTE = "官方格式：词库是中文句子，不能放进官方格式正文（要全英文）；在「编辑这一镜」里写英文，或用「复制给 AI 修改」";

export const SHOT_SIZES = ["特写", "近景", "中景", "全景", "远景"] as const;
export const PRESET_KIND_LABEL: Record<PresetKind, string> = { film: "胶片", light: "光线", camera: "运镜", lens: "焦段镜头", compose: "构图" };

export interface PresetItem { kind: PresetKind; name: string; text: string }
/** vocab.json: { film: [[名称, 中文提示词, …], …], … } */
export function presetItems(vocab: unknown, kind: PresetKind): PresetItem[] {
  const rows = (vocab as Record<string, unknown> | null)?.[kind];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string" && row[1].trim() ? [{ kind, name: row[0].trim(), text: row[1].trim() }] : []);
}

// ── 行和小句 ──
const SKIP_LINE = /^\s*(?:参考说明|画面要求|对白|台词|声音|主要动作|\d+(?:\.\d+)?\s*[-–~～至到]\s*\d+(?:\.\d+)?\s*秒)/;
export const TARGET: Record<PresetKind, RegExp> = {
  film: /胶片|颗粒|Kodak|柯达|Fuji|富士|Vision\s?3|Portra|Ektachrome|Cinestill|film grain|film stock|色彩科学/i,
  light: /光|灯|日照|阳光|月光|light|lamp/i,
  camera: /机位|仰拍|俯拍|平拍|平视|固定镜头|镜头固定|镜头不动|推近|推镜|缓推|慢推|前推|拉远|后拉|镜头拉|跟拍|跟随|摇镜|横移|平移|升降|手持|环绕|航拍|轨道镜头|摄影机|dolly|push.?in|pull.?(?:back|out)|tracking|handheld|orbit|crane/i,
  lens: /\d{2,3}\s*(?:mm|毫米)|焦段|广角|长焦|标准镜头|景深|虚化|焦外|散景|depth of field|bokeh/i,
  compose: /三分之一|黄金|居中构图|居中|对称|留白|构图|third|golden/i,
};
const SIZE_WORD = /大特写|中近景|中全景|大远景|特写|近景|中景|全景|远景/;

/** One clause of one line: [start, end) in the line, without the separator. */
type Span = { line: number; start: number; end: number; text: string };
function clauseSpans(line: string, index: number): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (let i = 0; i <= line.length; i++) {
    if (i === line.length || "，,。；;".includes(line[i])) {
      const raw = line.slice(start, i); const lead = raw.length - raw.trimStart().length; const text = raw.trim();
      if (text) spans.push({ line: index, start: start + lead, end: start + lead + text.length, text });
      start = i + 1;
    }
  }
  return spans;
}

export interface PresetTarget { kind: PresetKind; line: number; /** whole line replaced (光线句) */ wholeLine: boolean; spans: Span[]; text: string }

/** Where a preset of this kind goes in the prompt: the sentence(s) it replaces, or null when the shot has none yet. */
export function locatePreset(prompt: string, kind: PresetKind): PresetTarget | null {
  const lines = prompt.split("\n").map((line) => line.replace(/\r$/, ""));
  const usable = (line: string) => line.trim() && !SKIP_LINE.test(line);
  // 光线句：设定档的光线句单独一行、开头就在说光，整行换掉。
  if (kind === "light") {
    const i = lines.findIndex((line) => usable(line) && TARGET.light.test(clauseSpans(line, 0)[0]?.text ?? ""));
    if (i >= 0) return { kind, line: i, wholeLine: true, spans: [{ line: i, start: 0, end: lines[i].length, text: lines[i] }], text: lines[i] };
  }
  for (let i = 0; i < lines.length; i++) {
    if (!usable(lines[i])) continue;
    const spans = clauseSpans(lines[i], i).filter((span) => TARGET[kind].test(span.text));
    if (spans.length) return { kind, line: i, wholeLine: false, spans, text: spans.map((span) => span.text).join("，") };
  }
  return null;
}

/** Pronoun for 主体: the shot's own writing decides (只写了她 → 她，只写了他 → 他，两个都有 → 两人，都没有 → 删掉). */
export function subjectWord(prompt: string) {
  const body = prompt.split("\n").filter((line) => !/^\s*(?:参考说明|对白|台词)/.test(line)).join("\n");
  const he = /他(?!们)/.test(body), she = /她(?!们)/.test(body);
  return he && she ? "两人" : she ? "她" : he ? "他" : "";
}

const DROP = [
  /背景音乐|配乐|音乐|soundtrack|music|BGM/i,
  /开口|不出声|嘴唇闭着/,
  /定格|静止不动|画面静止|freeze/i,
  /只有一盏|唯一的?光源/,
  /不(?:偏)?暗|不死黑|不发暗/,
];

/** Vocab text → text that may go into a 第一集写法 prompt. Names of this shot's roles become the pronoun too. */
export function cleanPresetText(raw: string, prompt: string, names: readonly string[] = []) {
  const who = subjectWord(prompt);
  let text = raw.replace(/\s*\|\s*[\d.]+s?\s*$/, "");
  for (const name of names.filter((name) => name.length >= 2)) text = text.split(name).join("主体");
  // 「主体，使用 Kodak…」：开头单独的「主体」直接去掉。
  text = text.replace(/^\s*主体\s*[，,]\s*/, "");
  text = who ? text.replace(/\s*主体\s*上的/g, `${who}身上的`).replace(/\s*主体\s*/g, who) : text.replace(/\s*主体\s*(?:上)?的?\s*/g, "");
  const kept = text.split(/[，,]/).map((piece) => piece.trim()).filter((piece) => piece && !DROP.some((re) => re.test(piece)));
  return kept.join("，").replace(/\s{2,}/g, " ").replace(/[。.]+$/, "");
}

export interface PresetChange { prompt: string; before: string; after: string; inserted: boolean }

/** Replace the located sentence with `text` (first clause replaced, the others of that line removed), or insert it. */
export function applyPresetText(prompt: string, kind: PresetKind, text: string): PresetChange {
  const lines = prompt.split("\n");
  const target = locatePreset(prompt, kind);
  const clean = text.trim().replace(/[。]+$/, "");
  if (!clean) return { prompt, before: "", after: "", inserted: false };
  if (target) {
    const line = lines[target.line];
    const cr = line.endsWith("\r") ? "\r" : "";
    let body = line.replace(/\r$/, "");
    if (target.wholeLine) body = `${clean}。`;
    else {
      // Right to left so earlier offsets stay valid; the first span takes the new text, later spans go with their separator.
      for (const span of [...target.spans].reverse()) {
        if (span === target.spans[0]) body = body.slice(0, span.start) + clean + body.slice(span.end);
        else { const from = /[，,]/.test(body[span.start - 1] ?? "") ? span.start - 1 : span.start; body = body.slice(0, from) + body.slice(span.end); }
      }
    }
    lines[target.line] = body + cr;
    return { prompt: lines.join("\n"), before: target.text, after: clean, inserted: false };
  }
  // 没有就插：光线句单独一行放在风格行后面；其余接在风格行（第一条正文行）末尾。
  const styleAt = lines.findIndex((line) => line.trim() && !SKIP_LINE.test(line));
  if (styleAt < 0) {
    const at = Math.max(0, lines.findIndex((line) => /^\s*参考说明/.test(line)) + 1);
    lines.splice(at, 0, `${clean}。`);
  } else if (kind === "light") lines.splice(styleAt + 1, 0, `${clean}。`);
  else {
    const cr = lines[styleAt].endsWith("\r") ? "\r" : "";
    const body = lines[styleAt].replace(/\r$/, "").replace(/[。]\s*$/, "");
    lines[styleAt] = `${body}，${clean}。${cr}`;
  }
  return { prompt: lines.join("\n"), before: "", after: clean, inserted: true };
}

/** 景别快捷按钮：只换第一处景别词（中近景 → 近景）；没写就接在风格行末尾。 */
export function applyShotSize(prompt: string, size: string): PresetChange {
  const lines = prompt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (SKIP_LINE.test(lines[i]) || /^\s*\d+(?:\.\d+)?\s*[-–~～至到]/.test(lines[i])) continue;
    const m = SIZE_WORD.exec(lines[i]);
    if (!m) continue;
    const clause = clauseSpans(lines[i].replace(/\r$/, ""), i).find((span) => span.text.includes(m[0]))?.text ?? m[0];
    lines[i] = lines[i].slice(0, m.index) + size + lines[i].slice(m.index + m[0].length);
    return { prompt: lines.join("\n"), before: clause, after: clause.replace(m[0], size), inserted: false };
  }
  const styleAt = lines.findIndex((line) => line.trim() && !SKIP_LINE.test(line));
  if (styleAt < 0) return { prompt, before: "", after: "", inserted: false };
  const cr = lines[styleAt].endsWith("\r") ? "\r" : "";
  lines[styleAt] = `${lines[styleAt].replace(/\r$/, "").replace(/[。]\s*$/, "")}，${size}。${cr}`;
  return { prompt: lines.join("\n"), before: "", after: size, inserted: true };
}

export type PresetEdit = { kind: PresetKind; text: string } | { kind: "size"; size: string };
const editPrompt = (prompt: string, edit: PresetEdit) => edit.kind === "size" ? applyShotSize(prompt, edit.size) : applyPresetText(prompt, edit.kind, edit.text);
const targetOf = (prompt: string, edit: PresetEdit) => edit.kind === "size" ? (SIZE_WORD.exec(prompt.split("\n").filter((line) => !SKIP_LINE.test(line)).join("\n"))?.[0] ?? null) : locatePreset(prompt, edit.kind)?.text ?? null;

/**
 * 这一镜改完以后，改动是不是整个落在某一句本集设定里（{{本集.光线.办公室}} 换回来的那段）。是的话返回新设定值。
 */
export function episodeEditOf(shot: { prompt: string; promptTemplate?: string }, episode: EpisodeSettings | undefined, nextPrompt: string): { key: string; value: string } | null {
  if (!shot.promptTemplate || !episode || nextPrompt === shot.prompt) return null;
  const old = shot.prompt;
  let head = 0; while (head < old.length && head < nextPrompt.length && old[head] === nextPrompt[head]) head++;
  let tail = 0; while (tail < old.length - head && tail < nextPrompt.length - head && old[old.length - 1 - tail] === nextPrompt[nextPrompt.length - 1 - tail]) tail++;
  let at = 0;
  for (const piece of episodeSegments(shot.promptTemplate, episode, old)) {
    const start = at, end = at + piece.text.length; at = end;
    if (!piece.key || head < start || old.length - tail > end) continue;
    const value = nextPrompt.slice(start, end + nextPrompt.length - old.length);
    return value && value === value.trim() ? { key: piece.key, value } : null;
  }
  return null;
}

const setEpisodeValue = (episode: EpisodeSettings, key: string, value: string): EpisodeSettings => {
  const [kind, scene] = key.split(".");
  const field = ({ 风格: "style", 光线: "lighting", 画面要求: "frameRequirements", 底声: "ambience" } as const)[kind as "风格"];
  if (scene === undefined) return { ...episode, [field]: value };
  const perScene = field as "lighting" | "ambience";
  return { ...episode, [perScene]: { ...episode[perScene], [scene]: value } };
};

/**
 * 「整集都换」：每一镜里同一类的那句和这一镜原来那句一字不差的，才一起换（正本要求风格、画面要求整集逐字复用，光线句同场照抄）。
 * 写法不同的镜头不动，列在 skipped 里。这一镜自己总是换。
 * 这一句在本镜来自本集设定（占位）→ 直接改本集设定那一项，所有用它的镜头一起变（episodeKey 写明是哪一项）。
 */
export function planEpisodePreset(queue: ShotQueue, chapter: number, index: number, edit: PresetEdit) {
  const own = queue.chapters[chapter].shots[index];
  const original = targetOf(own.prompt, edit);
  const settingEdit = queue.episode ? episodeEditOf(own, queue.episode, editPrompt(own.prompt, edit).prompt) : null;
  const users = new Set(settingEdit ? episodeUsage(queue).get(settingEdit.key) ?? [] : []);
  const changed: string[] = [], skipped: string[] = [];
  const literal: ShotQueue = { ...queue, chapters: queue.chapters.map((ch, c) => ({ ...ch, shots: ch.shots.map((shot, s) => {
    if (settingEdit && users.has(shot.title)) { changed.push(shot.title); return shot; }
    const self = c === chapter && s === index;
    // 官方格式：词库是中文句子，不往官方格式正文里加（h3q [官方·中文]）；整集都换跳过这些镜头。
    if (isOfficialFormat(shot.prompt)) { skipped.push(shot.title); return shot; }
    if (!self && (original === null || targetOf(shot.prompt, edit) !== original)) { skipped.push(shot.title); return shot; }
    const result = editPrompt(shot.prompt, edit);
    if (result.prompt === shot.prompt) return shot;
    changed.push(shot.title);
    return { ...shot, prompt: result.prompt };
  }) })) };
  const next = settingEdit ? withEpisode(literal, setEpisodeValue(queue.episode!, settingEdit.key, settingEdit.value)) : literal;
  return { queue: next, changed, skipped, original, ...(settingEdit ? { episodeKey: settingEdit.key } : {}) };
}

export function planShotPreset(prompt: string, edit: PresetEdit) { return editPrompt(prompt, edit); }
