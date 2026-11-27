export interface MentionItem { label: string; name: string; src: string; kind: "image" | "video" | "audio"; nodeId?: string }
export function mentionQuery(text: string, cursor: number) {
  const match = /(?:^|[^A-Za-z0-9_@])@([^\s@<>]*)$/.exec(text.slice(0, cursor));
  return match ? { start: cursor - match[1].length - 1, end: cursor, query: match[1] } : null;
}
export function insertMention(text: string, start: number, end: number, label: string) {
  const suffix = text.slice(end);
  const inserted = `${label}${suffix.startsWith(" ") ? "" : " "}`;
  return { text: text.slice(0, start) + inserted + suffix, cursor: start + inserted.length };
}
export function referencedLabels(text: string) {
  return [...new Set(text.match(/<(?:Picture|Video|Audio|Subject)\s+\d+>/gi) ?? [])];
}
