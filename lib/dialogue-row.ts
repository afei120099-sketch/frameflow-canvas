/**
 * 正文「对白」行：台词唯一的位置（正本 %FRAMEFLOW_H3_TOOLS%\SKILL_h3-video.md「第一集写法」）。
 *   对白（中文普通话，口型同步）：张三（平淡）：“这张表算错了。” 李四：“不行啊。”
 * 队列 dialogue 字段一律留空：画布会给它追加中文角色名和声音录音，角色会喊名字、冒乱话。
 * 这里只读写正文里的这一行；其余正文一字不动。
 */
import { dialogueLines } from "./shot-card-breakdown.ts";
import { isOfficialFormat } from "./official-format.ts";
/** 官方 Ref2VA 六段式不往正文写中文对白行。 */
export const OFFICIAL_LINES_EDIT = "官方格式的台词写在 detailed_description 的 <d>[Chinese] …</d> 里（前面标 <Subject N> 和 S 编号），画布不改官方格式正文；请在「编辑这一镜」里改原文，或用「复制给 AI 修改」";

export const DIALOGUE_ROW_LABEL = "对白（中文普通话，口型同步）：";
/** A line that is the 对白 row: 「对白（…）：」/「台词：」. 「台词语气：」 is not. */
const ROW = /^(\s*(?:对白|台词)\s*(?:（[^）]*）|\([^)]*\))?\s*[：:])(.*)$/;

export interface DialogueEntry { speaker: string; text: string; tone?: string }

/** "张三（得意）：“这张表算错了。”" → { speaker: "张三", text: "这张表算错了。", tone: "得意" } */
export function parseDialogueLine(line: string): DialogueEntry | null {
  const m = /^([^：:（(“"]{1,12})(?:（([^）]*)）|\(([^)]*)\))?\s*[：:]\s*(.+)$/.exec(line.trim());
  if (!m) return null;
  const tone = (m[2] ?? m[3] ?? "").trim();
  return { speaker: m[1].trim(), text: m[4].trim().replace(/^[“"「]/, "").replace(/[”"」]$/, "").trim(), ...(tone ? { tone } : {}) };
}

/** Every entry of the 对白 row(s), in playback order. Pieces that name no speaker are listed in `unparsed`. */
export function parseDialogueRow(prompt: string): { found: boolean; entries: DialogueEntry[]; unparsed: string[] } {
  const entries: DialogueEntry[] = [];
  const unparsed: string[] = [];
  let found = false;
  for (const line of prompt.split("\n")) {
    const m = ROW.exec(line.replace(/\r$/, ""));
    if (!m) continue;
    found = true;
    const body = m[2].trim();
    if (!body) continue;
    for (const piece of dialogueLines(body)) {
      const entry = parseDialogueLine(piece);
      if (entry && entry.text) entries.push(entry); else unparsed.push(piece);
    }
  }
  return { found, entries, unparsed };
}

const formatEntry = (entry: DialogueEntry) => `${entry.speaker}${entry.tone ? `（${entry.tone}）` : ""}：“${entry.text.replace(/^[“"「]|[”"」]$/g, "")}”`;
export const formatDialogueEntries = (entries: readonly DialogueEntry[]) => entries.map(formatEntry).join(" ");

/**
 * Write `entries` as the 对白 row. The first row keeps its own label; extra rows are folded into it.
 * No entries → the row is removed. No row yet → it goes in before 「画面要求」, else at the end.
 */
export function writeDialogueRow(prompt: string, entries: readonly DialogueEntry[]): string {
  const lines = prompt.split("\n");
  const rows = lines.flatMap((line, i) => ROW.test(line.replace(/\r$/, "")) ? [i] : []);
  const body = formatDialogueEntries(entries);
  if (rows.length) {
    const first = rows[0];
    const cr = lines[first].endsWith("\r") ? "\r" : "";
    const label = ROW.exec(lines[first].replace(/\r$/, ""))![1];
    const out = lines.flatMap((line, i) => i === first ? (body ? [`${label}${body}${cr}`] : []) : rows.includes(i) ? [] : [line]);
    return out.join("\n");
  }
  if (!body) return prompt;
  const row = `${DIALOGUE_ROW_LABEL}${body}`;
  const at = lines.findIndex((line) => /^\s*画面(?:要求|约束)\s*[：:]/.test(line));
  if (at >= 0) return [...lines.slice(0, at), row, ...lines.slice(at)].join("\n");
  const trimmed = prompt.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n${row}` : row;
}

/** One role's lines in the 对白 row. */
export const rowLinesOf = (prompt: string, speaker: string) => parseDialogueRow(prompt).entries.filter((entry) => entry.speaker === speaker).map((entry) => entry.text);

/**
 * Replace one role's lines in the 对白 row where they were (first old position), keeping everyone else's
 * order and this role's tone notes. Returns an error instead of guessing when the row has a piece with no speaker.
 */
export function setRowLines(prompt: string, speaker: string, lines: readonly string[]): { prompt: string } | { error: string } {
  if (isOfficialFormat(prompt)) return { error: OFFICIAL_LINES_EDIT };
  const parsed = parseDialogueRow(prompt);
  if (parsed.unparsed.length) return { error: `正文对白行里这句看不出是谁说的：${parsed.unparsed[0]}。先在「编辑这一镜」里把它改成「名字：“台词”」` };
  const old = parsed.entries;
  const mine = old.filter((entry) => entry.speaker === speaker);
  const at = old.findIndex((entry) => entry.speaker === speaker);
  const kept = old.filter((entry) => entry.speaker !== speaker);
  const fresh = lines.map((text) => text.trim()).filter(Boolean).map((text, i) => {
    const tone = mine[i]?.tone ?? mine[0]?.tone;
    return { speaker, text, ...(tone ? { tone } : {}) };
  });
  const insertAt = at < 0 ? kept.length : old.slice(0, at).filter((entry) => entry.speaker !== speaker).length;
  return { prompt: writeDialogueRow(prompt, [...kept.slice(0, insertAt), ...fresh, ...kept.slice(insertAt)]) };
}
