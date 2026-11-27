/**
 * 硬盘定时轻量快照：复用 exportLightProject() 生成仅含画布布局、角色、素材登记与队列记录的 JSON，
 * 通过同源 /api/inbox?op=snapshot 发往本机 inbox-server 原子落盘（写 .tmp -> fsync -> rename）。
 */
import { exportLightProject, projectHasContent, readBackup, type BackupSink, type BackupSource, type ParsedBackup } from "./project-backup";
import { withProjectMediaWrite } from "./project-media-lock";

export const DISK_SNAPSHOT_INTERVAL_MS = 10 * 60_000;

let lastUploadedHash: string | null = null;
let inflight = false;

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function stableContentString(files: Record<string, string>): string {
  return Object.keys(files)
    .filter((k) => k !== "manifest.json")
    .sort()
    .map((k) => `${k}\0${files[k] ?? ""}`)
    .join("\0");
}

export type DiskSnapshotResult =
  | { status: "saved"; file?: string }
  | { status: "unchanged" }
  | { status: "empty" }
  | { status: "busy" };

export async function runDiskSnapshot(
  canvasDocument: unknown,
  options: { appVersion: string; persistenceKey: string; keepalive?: boolean }
): Promise<DiskSnapshotResult> {
  if (inflight) return { status: "busy" };
  inflight = true;
  try {
    const now = Date.now();
    const collected = await withProjectMediaWrite(async () => {
      const files: Record<string, string> = {};
      const sink: BackupSink = {
        writeText: async (filePath, text) => { files[filePath] = text; },
        writeBlob: async () => { throw new Error("轻量快照不写媒体文件"); },
      };
      const { project } = await exportLightProject(canvasDocument, sink, { ...options, now });
      if (!projectHasContent(project, canvasDocument)) return null;
      return files;
    });
    if (!collected) return { status: "empty" };
    const contentSha256 = await sha256Hex(stableContentString(collected));
    if (contentSha256 === lastUploadedHash) return { status: "unchanged" };
    const port = typeof window !== "undefined" ? (window.location.port || "5173") : "5173";
    const payload = JSON.stringify({
      version: 1,
      port,
      createdAt: new Date(now).toISOString(),
      contentSha256,
      files: collected,
    });
    const useKeepalive = Boolean(options.keepalive) && payload.length < 60_000;
    const response = await fetch(`/api/inbox?op=snapshot&port=${encodeURIComponent(port)}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: payload,
      ...(useKeepalive ? { keepalive: true } : { signal: AbortSignal.timeout(15_000) }),
    });
    if (!response.ok) throw new Error(`硬盘快照写入失败：HTTP ${response.status}`);
    const body = (await response.json().catch(() => ({}))) as { unchanged?: boolean; file?: string };
    lastUploadedHash = contentSha256;
    return body.unchanged ? { status: "unchanged" } : { status: "saved", file: body.file };
  } finally {
    inflight = false;
  }
}


export interface DiskSnapshotSummary {
  file: string;
  mtime: number;
  createdAt: string;
  size: number;
}


function currentCanvasPort(): string {
  return typeof window !== "undefined" ? (window.location.port || "5173") : "5173";
}


function snapshotMemorySource(files: Record<string, string>): BackupSource {
  return {
    has: (filePath) => Object.prototype.hasOwnProperty.call(files, filePath),
    size: (filePath) => (Object.prototype.hasOwnProperty.call(files, filePath) ? new TextEncoder().encode(files[filePath]).byteLength : null),
    readText: async (filePath) => {
      if (!Object.prototype.hasOwnProperty.call(files, filePath)) throw new Error(`硬盘快照缺少 ${filePath}`);
      return files[filePath];
    },
    readBlob: async (filePath) => {
      if (!Object.prototype.hasOwnProperty.call(files, filePath)) throw new Error(`硬盘快照缺少 ${filePath}`);
      return new Blob([files[filePath]], { type: "application/json" });
    },
  };
}


/** 列出当前画布端口最近 30 份硬盘快照（文件名、时间、大小）。 */
export async function listDiskSnapshots(): Promise<DiskSnapshotSummary[]> {
  const port = currentCanvasPort();
  const response = await fetch(`/api/inbox?op=snapshots&port=${encodeURIComponent(port)}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`读取硬盘快照列表失败：HTTP ${response.status}`);
  const data = (await response.json()) as { snapshots?: DiskSnapshotSummary[] };
  return Array.isArray(data.snapshots) ? data.snapshots : [];
}


/** 读取指定硬盘快照并复用现有轻量备份解析与校验逻辑返回 ParsedBackup。 */
export async function readDiskSnapshot(file: string): Promise<ParsedBackup> {
  const port = currentCanvasPort();
  const response = await fetch(`/api/inbox?op=snapshot&port=${encodeURIComponent(port)}&file=${encodeURIComponent(file)}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error || `读取硬盘快照失败：HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { files?: Record<string, string> };
  if (!payload?.files || typeof payload.files !== "object" || Array.isArray(payload.files)) {
    throw new Error("硬盘快照格式无效（缺少 files 字段）");
  }
  return readBackup(snapshotMemorySource(payload.files));
}
