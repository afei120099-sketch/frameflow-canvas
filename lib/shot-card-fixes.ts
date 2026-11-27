/**
 * 镜头卡片「一键改」：只改队列 JSON 里的这一镜，改完仍要通过 parseShotQueue。
 * - 旧队列 dialogue 字段 → 正文「对白（中文普通话，口型同步）：」行，再把 dialogue 清空
 *   （正本「第一集写法」：dialogue 留空，台词只在正文对白行，画布原样提交）
 * - 删掉正文里点名背景音乐 / 配乐的句子（队列 defaults.noBackgroundMusic 已经管了）
 */
import type { ShotQueueShot } from "./shot-queue.ts";
import { parseDialogueRow, writeDialogueRow, type DialogueEntry } from "./dialogue-row.ts";
import { isOfficialFormat } from "./official-format.ts";
import { OFFICIAL_LINES_EDIT } from "./dialogue-row.ts";

export { parseDialogueLine } from "./dialogue-row.ts";

/** One clause naming music. A leading comma means it ends a longer sentence: keep that sentence and its full stop. Same words h3q check flags. */
export const MUSIC_SENTENCE = /([，,；;]\s*)?[^。！？.!?\n；;，,：:]*?(?:no background music|without (?:any )?music|background music|soundtrack|musical score|non-diegetic music|\bany music\b|\bBGM\b|没有背景音乐|无背景音乐|不要背景音乐|禁止背景音乐|没有配乐|无配乐|不要配乐|不要音乐)[^。！？.!?\n，,]*([。！？.!?；;]?)/gi;

export function removeMusicSentences(prompt: string) {
  return prompt.replace(MUSIC_SENTENCE, (_match, lead: string | undefined, end: string) => lead ? end : "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Move an old queue's `dialogue` field into the 对白 row of the prompt, then empty the field.
 * Lines already in the row (same speaker, same words) are not written twice. Guest lines use their speaker name.
 */
export function dialogueFieldToRow(shot: ShotQueueShot, nameOf: (roleId: string) => string | undefined): { shot: ShotQueueShot } | { error: string } {
  const field = shot.dialogue ?? [];
  if (!field.length) return { error: "这一镜的 dialogue 字段已经是空的" };
  if (isOfficialFormat(shot.prompt)) return { error: OFFICIAL_LINES_EDIT };
  const row = parseDialogueRow(shot.prompt);
  if (row.unparsed.length) return { error: `正文对白行里这句看不出是谁说的：${row.unparsed[0]}。先在「编辑这一镜」里把它改成「名字：“台词”」` };
  const entries: DialogueEntry[] = [...row.entries];
  for (const line of field) {
    const speaker = line.roleId ? nameOf(line.roleId) : line.speaker?.trim();
    if (!speaker) return { error: `这句台词找不到是谁说的：${line.text}` };
    const text = line.text.trim();
    if (!text || entries.some((entry) => entry.speaker === speaker && entry.text === text)) continue;
    entries.push({ speaker, text });
  }
  const next: ShotQueueShot = { ...shot, prompt: writeDialogueRow(shot.prompt, entries) };
  delete next.dialogue;
  delete next.autoVoiceAssigned;
  return { shot: next };
}
