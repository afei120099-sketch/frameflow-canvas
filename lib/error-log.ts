/**
 * Phase 12: error center / task log. Local only (meta key "errorLog", newest 300 entries kept).
 * Explicit call sites log with context (node / Shot / Run); error toasts are also captured so a
 * failure is never only a 3-second toast. Near-identical entries within a few seconds are merged.
 */

export type LogLevel = "error" | "warning" | "info";
export type LogCategory = "task" | "submit" | "recovery" | "asset" | "audio" | "backup" | "ui";
export interface LogEntry {
  id: string; time: number; level: LogLevel; category: LogCategory; title: string; detail: string;
  nodeId?: string; shotId?: string; runId?: string; read: boolean; repeat?: number;
  /** Same key → the one existing entry is kept as is (no new row, no repeat count). For per-Run states re-checked every few seconds. */
  onceKey?: string;
  /** Set when the user (or a final state) handled the problem; the entry stays as history. */
  resolvedAt?: number; resolution?: string;
}
export const ERROR_LOG_KEY = "errorLog";
export const MAX_ENTRIES = 300;
const MERGE_WINDOW_MS = 5_000;
export const CATEGORY_LABELS: Record<LogCategory, string> = { task: "任务失败", submit: "提交", recovery: "恢复", asset: "素材缺失", audio: "音频", backup: "备份 / 恢复", ui: "界面提示" };

type Storage = { load: () => Promise<LogEntry[] | null>; save: (entries: LogEntry[]) => Promise<void> };
let storage: Storage | null = null;
let entries: LogEntry[] = [];
let loaded: Promise<void> | null = null;
let writing: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
let version = 0;

export function configureErrorLog(next: Storage) { storage = next; loaded = null; entries = []; version += 1; }
function ensureLoaded() {
  if (!loaded) loaded = (storage ? storage.load() : Promise.resolve(null)).then((stored) => { entries = Array.isArray(stored) ? [...stored, ...entries.filter((entry) => !stored.some((old) => old.id === entry.id))].sort((a, b) => b.time - a.time).slice(0, MAX_ENTRIES) : entries; notify(); }, () => { /* keep in-memory log */ });
  return loaded;
}
function notify() { version += 1; for (const listener of listeners) listener(); }
function persist() {
  const snapshot = entries.slice(0, MAX_ENTRIES);
  writing = writing.then(() => storage?.save(snapshot)).catch(() => { /* the log must never break the app */ });
  return writing;
}

/** Message → category when the caller did not know better (e.g. a missing file surfaced during a task). */
export function categorize(message: string, fallback: LogCategory): LogCategory {
  if (/引用素材已失效|媒体文件|已丢失|本地视频数据不存在|本地图片已丢失|本地声音已丢失/.test(message)) return "asset";
  return fallback;
}

export async function logEvent(input: Omit<LogEntry, "id" | "time" | "read" | "repeat" | "resolvedAt" | "resolution"> & { time?: number }) {
  await ensureLoaded();
  const time = input.time ?? Date.now();
  if (input.onceKey) {
    // Older builds logged the same per-Run warning without a key: adopt that row instead of adding another.
    const existing = entries.find((entry) => entry.onceKey === input.onceKey || (!entry.onceKey && !!input.runId && entry.runId === input.runId && entry.title === input.title && entry.category === input.category));
    if (existing) { if (!existing.onceKey) { existing.onceKey = input.onceKey; notify(); await persist(); } return existing; }
  }
  const recent = entries.find((entry) => time - entry.time < MERGE_WINDOW_MS && entry.level === input.level && (entry.title === input.title && entry.detail === input.detail));
  if (recent) { recent.repeat = (recent.repeat ?? 1) + 1; recent.time = time; recent.read = false; notify(); await persist(); return recent; }
  const entry: LogEntry = { ...input, id: `${time.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, time, read: false };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  notify(); await persist();
  return entry;
}

/** Error toasts are captured unless the same message was just logged explicitly with context. */
export async function logToast(message: string, level: LogLevel) {
  await ensureLoaded();
  const now = Date.now();
  if (entries.some((entry) => now - entry.time < MERGE_WINDOW_MS && (entry.detail === message || entry.title === message))) return null;
  return logEvent({ level, category: categorize(message, "ui"), title: message.length > 60 ? `${message.slice(0, 60)}…` : message, detail: message, time: now });
}

/** Marks every unresolved entry of this Run (optionally only these titles) as handled. Returns how many changed. */
export async function resolveRunEntries(runId: string, resolution: string, titles?: string[]) {
  await ensureLoaded();
  const now = Date.now();
  let changed = 0;
  for (const entry of entries) {
    if (entry.runId !== runId || entry.resolvedAt || (titles && !titles.includes(entry.title))) continue;
    entry.resolvedAt = now; entry.resolution = resolution; entry.read = true; changed += 1;
  }
  if (changed) { notify(); await persist(); }
  return changed;
}

export async function listEntries() { await ensureLoaded(); return entries.map((entry) => ({ ...entry })); }
export async function markAllRead() { await ensureLoaded(); for (const entry of entries) entry.read = true; notify(); await persist(); }
export async function clearRead() { await ensureLoaded(); entries = entries.filter((entry) => !entry.read); notify(); await persist(); }
export const unreadCount = (levels: LogLevel[] = ["error", "warning"]) => entries.filter((entry) => !entry.read && levels.includes(entry.level)).length;
export const subscribeLog = (listener: () => void) => { listeners.add(listener); void ensureLoaded(); return () => { listeners.delete(listener); }; };
export const getLogVersion = () => version;
export const flushLog = () => writing;

/** "复制高级信息": everything recorded for one entry, as readable JSON. */
export const entryDetails = (entry: LogEntry) => JSON.stringify({ time: new Date(entry.time).toISOString(), level: entry.level, category: entry.category, title: entry.title, detail: entry.detail, nodeId: entry.nodeId ?? null, shotId: entry.shotId ?? null, runId: entry.runId ?? null, repeat: entry.repeat ?? 1, ...(entry.resolvedAt ? { resolvedAt: new Date(entry.resolvedAt).toISOString(), resolution: entry.resolution ?? "" } : {}) }, null, 2);
