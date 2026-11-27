/**
 * Phase 15: Command Palette (Ctrl/Cmd+K). Ranking is pure so it can be tested; the canvas supplies
 * the actual command callbacks. Ctrl/Cmd+K is not bound by tldraw 5.4.2, so no native shortcut is
 * overridden; plain letter keys (tldraw tools) are never intercepted.
 */

export interface PaletteCommand { id: string; label: string; group: string; hint?: string; keywords?: string[]; disabled?: boolean }

const normalize = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, "");

/** 0 = no match; higher is better. Label prefix > label substring > keyword prefix > keyword substring > subsequence. */
export function scoreText(query: string, label: string, keywords: readonly string[] = []) {
  const q = normalize(query);
  if (!q) return 1;
  const l = normalize(label);
  if (l.startsWith(q)) return 100 - Math.min(40, l.length - q.length);
  if (l.includes(q)) return 70 - Math.min(30, l.indexOf(q));
  for (const keyword of keywords) { const k = normalize(keyword); if (k.startsWith(q)) return 60; }
  for (const keyword of keywords) { const k = normalize(keyword); if (k.includes(q)) return 45; }
  let at = 0;
  for (const char of l) if (char === q[at]) at += 1;
  return at === q.length ? 20 : 0;
}

export function rankCommands<T extends PaletteCommand>(commands: readonly T[], query: string) {
  return commands
    .map((command, index) => ({ command, index, score: scoreText(query, command.label, command.keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
}

/** True for the palette shortcut only (Ctrl+K on Windows/Linux, Cmd+K on macOS). */
export const isPaletteShortcut = (event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">) => (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
