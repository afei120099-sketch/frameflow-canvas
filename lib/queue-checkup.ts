/**
 * Groups the flat warning strings from shotQueueWarnings() by shot so the queue panel can show
 * a scannable, collapsible list instead of one long block of text.
 *
 * Input lines look like `「镜头标题」消息`; prompt check-up hints carry a `体检：` prefix.
 * Pure: no React, no storage.
 */
export type CheckupLevel = "warn" | "hint";
export type CheckupItem = { level: CheckupLevel; message: string };
export type CheckupGroup = { title: string; items: CheckupItem[]; warn: number; hint: number };

const HINT_PREFIX = /^体检[:：]\s*/;

export function groupQueueWarnings(warnings: readonly string[]): CheckupGroup[] {
  const groups = new Map<string, CheckupGroup>();
  for (const raw of warnings) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^「(.+?)」([\s\S]*)$/.exec(line);
    const title = match ? match[1] : "整份队列";
    const body = (match ? match[2] : line).trim();
    const level: CheckupLevel = HINT_PREFIX.test(body) ? "hint" : "warn";
    const message = body.replace(HINT_PREFIX, "");
    let group = groups.get(title);
    if (!group) { group = { title, items: [], warn: 0, hint: 0 }; groups.set(title, group); }
    if (group.items.some((item) => item.message === message)) continue;
    group.items.push({ level, message });
    group[level] += 1;
  }
  // warnings first inside each shot; shots keep queue order
  for (const group of groups.values()) group.items.sort((a, b) => Number(a.level === "hint") - Number(b.level === "hint"));
  return [...groups.values()];
}

export function checkupTotals(groups: readonly CheckupGroup[]) {
  return groups.reduce((sum, group) => ({ warn: sum.warn + group.warn, hint: sum.hint + group.hint }), { warn: 0, hint: 0 });
}
