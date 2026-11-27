/**
 * Daily light backup (A 批第 3 项): once per local calendar day the canvas + records are saved
 * into this browser (IndexedDB), without media files. The newest 7 days are kept.
 *
 * Built on the project backup package (lib/project-backup.ts → exportLightProject), so a daily
 * backup can be read back with readBackup() and restored with the same restoreProject() as a
 * folder backup. An empty project is never saved, so a wiped canvas cannot push out the good copies.
 */
import { exportLightProject, projectHasContent, readBackup, type BackupManifest, type BackupSink, type BackupSource, type ParsedBackup } from "./project-backup.ts";
import { withProjectMediaWrite } from "./project-media-lock.ts";

export const DAILY_BACKUP_DATABASE = { name: "frameflow-daily-backups", version: 1 } as const;
export const DAILY_BACKUP_KEEP = 7;

export interface DailyBackupSummary { day: string; createdAt: number; manifest: BackupManifest; bytes: number }
interface FilesRow { day: string; files: Record<string, string> }
export type DailyBackupResult =
  | { status: "saved"; summary: DailyBackupSummary; removed: string[] }
  | { status: "exists"; day: string }
  | { status: "empty"; day: string };

const pad = (n: number) => String(n).padStart(2, "0");
/** Local calendar day, e.g. 2026-11-10. */
export function localDay(time: number) { const d = new Date(time); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/** Days to delete so that only the newest `keep` remain. */
export function daysToPrune(days: string[], keep = DAILY_BACKUP_KEEP) { return [...days].sort().reverse().slice(keep); }

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DAILY_BACKUP_DATABASE.name, DAILY_BACKUP_DATABASE.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("summaries")) db.createObjectStore("summaries", { keyPath: "day" });
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "day" });
    };
    request.onblocked = () => reject(new Error("每日备份库被其他页面占用"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开每日备份库"));
  });
}

function read<T>(db: IDBDatabase, store: string, action: (target: IDBObjectStore) => IDBRequest) {
  return new Promise<T>((resolve, reject) => {
    const request = action(db.transaction(store, "readonly").objectStore(store));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error(`${store} 读取失败`));
  });
}

function write(db: IDBDatabase, action: (summaries: IDBObjectStore, files: IDBObjectStore) => void) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["summaries", "files"], "readwrite");
    action(tx.objectStore("summaries"), tx.objectStore("files"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("每日备份写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("每日备份写入已中止"));
  });
}

/** Newest first. */
export async function listDailyBackups(): Promise<DailyBackupSummary[]> {
  const db = await openDb();
  try { return (await read<DailyBackupSummary[]>(db, "summaries", (store) => store.getAll())).sort((a, b) => b.day.localeCompare(a.day)); }
  finally { db.close(); }
}

/** Save today's light backup unless one exists already (or the project is empty); then keep the newest 7. */
export async function runDailyBackup(canvasDocument: unknown, options: { appVersion: string; persistenceKey: string; now?: number }): Promise<DailyBackupResult> {
  const now = options.now ?? Date.now();
  const day = localDay(now);
  return withProjectMediaWrite(async () => {
    const db = await openDb();
    try {
      const existing = await read<DailyBackupSummary[]>(db, "summaries", (store) => store.getAll());
      if (existing.some((row) => row.day === day)) return { status: "exists", day } as const;
      const files: Record<string, string> = {};
      const sink: BackupSink = { writeText: async (path, text) => { files[path] = text; }, writeBlob: async () => { throw new Error("轻量备份不写媒体文件"); } };
      const { manifest, project } = await exportLightProject(canvasDocument, sink, { ...options, now });
      if (!projectHasContent(project, canvasDocument)) return { status: "empty", day } as const;
      const summary: DailyBackupSummary = { day, createdAt: now, manifest, bytes: Object.values(files).reduce((sum, text) => sum + text.length, 0) };
      const removed = daysToPrune([...existing.map((row) => row.day), day]);
      await write(db, (summaries, fileStore) => {
        summaries.put(summary);
        fileStore.put({ day, files } satisfies FilesRow);
        for (const old of removed) { summaries.delete(old); fileStore.delete(old); }
      });
      return { status: "saved", summary, removed } as const;
    } finally { db.close(); }
  });
}

function memorySource(files: Record<string, string>): BackupSource {
  return {
    has: (path) => path in files,
    size: (path) => (path in files ? new Blob([files[path]]).size : null),
    readText: async (path) => { if (!(path in files)) throw new Error(`缺少 ${path}`); return files[path]; },
    readBlob: async (path) => { if (!(path in files)) throw new Error(`缺少 ${path}`); return new Blob([files[path]]); },
  };
}

/** Parse one stored day with the same validation as a folder backup (nothing is written). */
export async function readDailyBackup(day: string): Promise<ParsedBackup> {
  const db = await openDb();
  let row: FilesRow | undefined;
  try { row = await read<FilesRow | undefined>(db, "files", (store) => store.get(day)); }
  finally { db.close(); }
  if (!row) throw new Error(`找不到 ${day} 的每日备份`);
  return readBackup(memorySource(row.files));
}

/** The stored files of one day, e.g. to save them into a folder. */
export async function dailyBackupFiles(day: string) {
  const db = await openDb();
  try { return (await read<FilesRow | undefined>(db, "files", (store) => store.get(day)))?.files ?? null; }
  finally { db.close(); }
}
