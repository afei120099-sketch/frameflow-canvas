/**
 * 镜头卡片「台词」: each role's lines in one shot, written into the prompt's 对白 row
 *   对白（中文普通话，口型同步）：张三：“……” 李四：“……”
 * Rule source: 正本 %FRAMEFLOW_H3_TOOLS%\SKILL_h3-video.md「第一集写法」. The queue `dialogue` field stays empty:
 * when it has lines the canvas appends Chinese role names and voice recordings, and characters shout
 * their names or say made-up words. The prompt is submitted as written; nothing is appended for roles without lines.
 * Lives in the queue JSON (the prompt), so undo / redo, 导出 JSON and 另存 carry it.
 */
import type { ShotQueue, ShotQueueShot } from "./shot-queue.ts";
import { parseDialogueRow, rowLinesOf, setRowLines } from "./dialogue-row.ts";

type RoleName = { roleId: string; displayName: string };

/** One role's lines, read from the 对白 row by its name. */
export const roleLines = (shot: Pick<ShotQueueShot, "prompt">, roleName: string) => rowLinesOf(shot.prompt, roleName);

/** One line per non-empty row of the editor. */
export const linesFromText = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

/** Replace this role's lines in the 对白 row where they were, keeping everyone else's order. Other prompt text is untouched. */
export function setRoleLines<T extends Pick<ShotQueueShot, "prompt">>(shot: T, roleName: string, lines: readonly string[]): { shot: T } | { error: string } {
  const result = setRowLines(shot.prompt, roleName, lines);
  return "error" in result ? result : { shot: { ...shot, prompt: result.prompt } };
}

export type LineChange = { chapter: number; index: number; shotTitle: string; roleId: string; roleName: string; lines: string[]; replaced: number };
export type DialogueImport = { changes: LineChange[]; unmatched: string[]; needsAv: string[] };

const asLines = (value: unknown): string[] | null => typeof value === "string" ? linesFromText(value) : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => item.trim()).filter(Boolean) : null;

/**
 * 「从 JSON 导入台词」. Accepts a whole shot-queue JSON (shots matched by title; lines from each shot's 对白 row,
 * or from an old `dialogue` field by roleId / speaker name), a list of shots, or a map
 * { "镜头标题": { "角色名": ["句1", "句2"] | "句" } }. Nothing is written here: the caller previews, asks, then applies.
 * Unmatched items are listed.
 */
export function planDialogueImport(text: string, queue: ShotQueue, roles: readonly RoleName[]): DialogueImport | { error: string } {
  let data: unknown;
  try { data = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (cause) { return { error: `不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}` }; }
  const where = new Map<string, { chapter: number; index: number; shot: ShotQueueShot }>();
  queue.chapters.forEach((chapter, c) => chapter.shots.forEach((shot, s) => where.set(shot.title, { chapter: c, index: s, shot })));
  const nameOf = (roleId: string) => roles.find((role) => role.roleId === roleId)?.displayName ?? roleId;
  const wanted: { title: string; speaker: string; byId: boolean; lines: string[] }[] = [];
  const unmatched: string[] = [];
  const fromShot = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const shot = raw as { title?: unknown; dialogue?: unknown; prompt?: unknown };
    if (typeof shot.title !== "string") return;
    const grouped = new Map<string, { byId: boolean; lines: string[] }>();
    const add = (speaker: string, byId: boolean, line: string) => { const entry = grouped.get(speaker) ?? { byId, lines: [] }; entry.lines.push(line); grouped.set(speaker, entry); };
    for (const line of Array.isArray(shot.dialogue) ? shot.dialogue as { roleId?: unknown; speaker?: unknown; text?: unknown }[] : []) {
      if (!line || typeof line.text !== "string" || !line.text.trim()) continue;
      const byId = typeof line.roleId === "string" && line.roleId.trim() !== "";
      const speaker = byId ? String(line.roleId).trim() : typeof line.speaker === "string" ? line.speaker.trim() : "";
      if (!speaker) { unmatched.push(`「${shot.title}」有一句没写是谁说的：${line.text.trim()}`); continue; }
      add(speaker, byId, line.text.trim());
    }
    // A queue written the 正本 way carries its lines in the prompt's 对白 row.
    if (!grouped.size && typeof shot.prompt === "string") {
      const row = parseDialogueRow(shot.prompt);
      for (const entry of row.entries) add(entry.speaker, false, entry.text);
      for (const piece of row.unparsed) unmatched.push(`「${shot.title}」对白行里这句看不出是谁说的：${piece}`);
    }
    for (const [speaker, entry] of grouped) wanted.push({ title: shot.title, speaker, ...entry });
  };
  if (Array.isArray(data)) data.forEach(fromShot);
  else if (data && typeof data === "object" && Array.isArray((data as { chapters?: unknown }).chapters)) for (const chapter of (data as { chapters: { shots?: unknown[] }[] }).chapters) (chapter?.shots ?? []).forEach(fromShot);
  else if (data && typeof data === "object" && Array.isArray((data as { shots?: unknown }).shots)) (data as { shots: unknown[] }).shots.forEach(fromShot);
  else if (data && typeof data === "object") {
    for (const [title, byRole] of Object.entries(data as Record<string, unknown>)) {
      if (!byRole || typeof byRole !== "object" || Array.isArray(byRole)) { unmatched.push(`「${title}」后面要写 { "角色名": ["台词"] }`); continue; }
      for (const [speaker, value] of Object.entries(byRole as Record<string, unknown>)) {
        const lines = asLines(value);
        if (!lines) { unmatched.push(`「${title}」的「${speaker}」台词要写成文字或文字数组`); continue; }
        wanted.push({ title, speaker: speaker.trim(), byId: false, lines });
      }
    }
  } else return { error: "看不懂这段 JSON：要整份队列、镜头数组，或 { \"镜头标题\": { \"角色名\": [\"台词\"] } }" };
  const changes: LineChange[] = [];
  for (const item of wanted) {
    const target = where.get(item.title);
    if (!target) { unmatched.push(`队列里没有镜头「${item.title}」`); continue; }
    const roleId = item.byId ? (target.shot.roleIds.includes(item.speaker) ? item.speaker : null)
      : target.shot.roleIds.find((id) => nameOf(id) === item.speaker) ?? null;
    if (!roleId) { unmatched.push(`「${item.title}」里没有角色「${item.byId ? nameOf(item.speaker) : item.speaker}」`); continue; }
    const prior = changes.find((change) => change.shotTitle === item.title && change.roleId === roleId);
    if (prior) { prior.lines.push(...item.lines); continue; }
    const roleName = nameOf(roleId);
    changes.push({ chapter: target.chapter, index: target.index, shotTitle: item.title, roleId, roleName, lines: [...item.lines], replaced: roleLines(target.shot, roleName).length });
  }
  const needsAv = [...new Set(changes.filter((change) => change.lines.length && queue.chapters[change.chapter].shots[change.index].soundMode !== "av").map((change) => change.shotTitle))];
  return { changes, unmatched, needsAv };
}

/** Write the planned lines into each shot's 对白 row. Shots that get lines and are not 有声 become av; 背景乐禁用 is untouched. */
export function applyDialogueImport(queue: ShotQueue, plan: DialogueImport): ShotQueue | { error: string } {
  const chapters = queue.chapters.map((chapter) => ({ ...chapter, shots: [...chapter.shots] }));
  for (const change of plan.changes) {
    const shots = chapters[change.chapter].shots;
    const result = setRoleLines(shots[change.index], change.roleName, change.lines);
    if ("error" in result) return { error: `「${change.shotTitle}」：${result.error}` };
    let shot = result.shot;
    if (change.lines.length && shot.soundMode !== "av") shot = { ...shot, soundMode: "av" };
    shots[change.index] = shot;
  }
  return { ...queue, chapters };
}

/** Plain-words preview for the confirm dialog. */
export function importSummary(plan: DialogueImport) {
  const shots = new Set(plan.changes.map((change) => change.shotTitle)).size;
  const replaced = plan.changes.reduce((sum, change) => sum + change.replaced, 0);
  const rows = plan.changes.map((change) => `· 「${change.shotTitle}」${change.roleName}：${change.lines.length} 句${change.replaced ? `（覆盖原有 ${change.replaced} 句）` : ""}`);
  return [
    `会改 ${shots} 镜、${plan.changes.length} 个角色的台词，写进正文「对白」那一行${replaced ? `，覆盖已有台词 ${replaced} 句` : ""}：`,
    ...rows.slice(0, 20), ...(rows.length > 20 ? [`…另外 ${rows.length - 20} 处`] : []),
    ...(plan.needsAv.length ? [``, `这 ${plan.needsAv.length} 镜现在不是「有声」，台词要有声才说得出来，会改成「有声 av」（背景乐禁用不变）：${plan.needsAv.join("、")}`] : []),
    ...(plan.unmatched.length ? [``, `对不上、不会导入的 ${plan.unmatched.length} 处：`, ...plan.unmatched.slice(0, 12).map((item) => `· ${item}`), ...(plan.unmatched.length > 12 ? [`…另外 ${plan.unmatched.length - 12} 处`] : [])] : []),
  ].join("\n");
}
