/**
 * 镜头卡片的 Ctrl+Z / Ctrl+Y（用户 2026-11-11）：按键怎么分流、撤销后那句轻提示写什么。纯函数，测试在 scripts/test-shot-card-undo.mjs。
 * 修改历史本身仍是 lib/shot-queue-history.ts（顶栏「撤销 / 恢复」同一套）。
 */
import type { ShotQueue, ShotQueueShot } from "./shot-queue.ts";

export type UndoIntent = "undo" | "redo";

/** Ctrl+Z → 撤销；Ctrl+Y、Ctrl+Shift+Z → 恢复（Mac 的 ⌘ 同样）。带 Alt 的不算。 */
export function undoKeyIntent(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): UndoIntent | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}

/**
 * 焦点在文本框里时，这一下交给谁：文本框自己还有能撤销 / 恢复的字就交给它（"field"），撤到底了（或这个框是保存后新出来的）就走卡片历史（"card"）。
 * `typed` = 这个框里打字的次数减去已经撤销的次数，`undone` = 撤销了还没恢复的次数（由 input 事件的 inputType 数出来）。
 */
export function fieldOrCard(intent: UndoIntent, field: { typed: number; undone: number }): "field" | "card" {
  return intent === "undo" ? (field.typed > 0 ? "field" : "card") : (field.undone > 0 ? "field" : "card");
}

/** 用 input 事件的 inputType 更新上面的计数。 */
export function countFieldInput(field: { typed: number; undone: number }, inputType: string) {
  if (inputType === "historyUndo") return { typed: Math.max(0, field.typed - 1), undone: field.undone + 1 };
  if (inputType === "historyRedo") return { typed: field.typed + 1, undone: Math.max(0, field.undone - 1) };
  return { typed: field.typed + 1, undone: 0 };
}

/** 「EP02-std-L03｜抬头等她过来」→「L03」。 */
export function shotCode(title: string) {
  const head = title.split(/[｜|]/)[0].trim();
  return /([A-Za-z]*\d+[A-Za-z]?)$/.exec(head)?.[1] ?? head;
}

const DIALOGUE_LINE = /^\s*(?:对白|台词)[^\n]*$/gm;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function shotChange(before: ShotQueueShot, after: ShotQueueShot) {
  const parts: string[] = [];
  if (before.prompt !== after.prompt) {
    const dialogueOnly = before.prompt.replace(DIALOGUE_LINE, "") === after.prompt.replace(DIALOGUE_LINE, "");
    parts.push(dialogueOnly ? "台词" : "正文");
  }
  if (!same(before.dialogue, after.dialogue) && !parts.includes("台词")) parts.push("台词");
  if (!same(before.roleIds, after.roleIds) || !same(before.offscreenRoleIds, after.offscreenRoleIds)) parts.push("角色");
  if (!same(before.sceneAssetIds, after.sceneAssetIds)) parts.push("参考图");
  if (!same(before.keyframe, after.keyframe)) parts.push("关键帧设置");
  const known = new Set(["prompt", "dialogue", "roleIds", "offscreenRoleIds", "sceneAssetIds", "keyframe", "title", "promptTemplate"]);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => !known.has(key)));
  if ([...keys].some((key) => !same((before as unknown as Record<string, unknown>)[key], (after as unknown as Record<string, unknown>)[key]))) parts.push("参数");
  return parts;
}

/** 撤销 / 恢复前后两版队列差在哪：「L03 正文」「L03、L04 台词」「删了 L05」「镜头顺序」「队列设置」。 */
export function describeQueueChange(before: ShotQueue, after: ShotQueue): string {
  const flat = (queue: ShotQueue) => queue.chapters.flatMap((chapter) => chapter.shots);
  const a = flat(before), b = flat(after);
  const aTitles = a.map((shot) => shot.title), bTitles = b.map((shot) => shot.title);
  const removed = aTitles.filter((title) => !bTitles.includes(title)), added = bTitles.filter((title) => !aTitles.includes(title));
  const list = (titles: string[]) => `${titles.slice(0, 3).map(shotCode).join("、")}${titles.length > 3 ? ` 等 ${titles.length} 镜` : ""}`;
  const out: string[] = [];
  if (added.length) out.push(`加了 ${list(added)}`);
  if (removed.length) out.push(`删了 ${list(removed)}`);
  const common = aTitles.filter((title) => bTitles.includes(title));
  if (!added.length && !removed.length && common.join("\n") !== bTitles.join("\n")) out.push("镜头顺序");
  else if (!added.length && !removed.length && !same(before.chapters.map((chapter) => chapter.title), after.chapters.map((chapter) => chapter.title))) out.push("章节");
  const byKind = new Map<string, string[]>();
  for (const title of common) {
    const shotA = a.find((shot) => shot.title === title)!, shotB = b.find((shot) => shot.title === title)!;
    for (const part of shotChange(shotA, shotB)) byKind.set(part, [...(byKind.get(part) ?? []), title]);
  }
  for (const [part, titles] of byKind) out.push(`${list(titles)} ${part}`);
  if (!same(before.episode, after.episode)) out.unshift("本集设定");
  if (before.title !== after.title || !same(before.defaults, after.defaults)) out.push("队列设置");
  return out.slice(0, 3).join("；") || "队列";
}
