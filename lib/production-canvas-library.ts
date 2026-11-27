import { listAllAssets, type AssetRecord } from "./production-records.ts";
import { listAllRoles, type RoleRecord } from "./role-records.ts";
import { getLocalAudioBlob, getLocalImageBlob } from "./local-video-store.ts";
import type { CanvasAssetLike, CanvasRoleLike } from "./production-canvas-match.ts";

/**
 * Read-only view of the canvas library for the 生产线 page, loaded through the dev server
 * (`import("/lib/production-canvas-library.ts")`), so it works on the same origin even when the page
 * was opened by typing its URL. Each origin (5173, 5174…) has its own IndexedDB, so this reads the
 * library of the canvas served on that port. Nothing here writes: no role, asset or canvas change.
 */

const CANVAS_DB = "TLDRAW_DOCUMENT_v2frameflow-v0.1-canvas";
const LIBRARY_DBS = ["frameflow-role-records", "frameflow-production-records"];

export interface CanvasPage { id: string; name: string }
export interface CanvasLibrary { pages: CanvasPage[]; roles: CanvasRoleLike[]; assets: CanvasAssetLike[]; empty: boolean }

async function existingDatabases(): Promise<Set<string> | null> {
  try { return new Set((await indexedDB.databases()).map((db) => db.name ?? "")); } catch { return null; }
}

/** tldraw page names, read without ever creating or upgrading the canvas database. */
async function readPages(): Promise<CanvasPage[]> {
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(CANVAS_DB);
    const timer = setTimeout(() => resolve(null), 8000);
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
    request.onerror = () => { clearTimeout(timer); resolve(null); };
    request.onblocked = () => { clearTimeout(timer); resolve(null); };
  });
  if (!db) return [];
  try {
    if (!db.objectStoreNames.contains("records")) return [];
    const rows = await new Promise<{ id: string; typeName?: string; name?: string; index?: string }[]>((resolve) => {
      const request = db.transaction("records", "readonly").objectStore("records").getAll(IDBKeyRange.bound("page:", "page:￿"));
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => resolve([]);
    });
    return rows.filter((row) => row.typeName === "page").sort((a, b) => String(a.index ?? "").localeCompare(String(b.index ?? ""))).map((row) => ({ id: row.id, name: row.name || row.id }));
  } finally { db.close(); }
}

/** One entry per role and canvas page, with that page's own edits (as the canvas shows it there). */
function roleEntries(role: RoleRecord): CanvasRoleLike[] {
  const pages = (role.canvasPageIds ?? []).filter((id) => !role.excludedCanvasPageIds?.includes(id));
  const view = (r: Omit<RoleRecord, "canvasVersions">, pageIds: string[]): CanvasRoleLike => ({
    roleId: role.roleId, displayName: r.displayName, description: [r.description, r.defaultClothing, r.hair, r.notes].filter(Boolean).join("；"), pageIds,
    faceAssetId: r.faceReferenceAssetId ?? null, appearanceAssetIds: r.appearanceAssetIds ?? [], primaryAppearanceAssetId: r.primaryAppearanceAssetId ?? null, voiceAssetId: r.primaryVoiceAssetId ?? null,
  });
  if (!role.canvasPageIds) return [view(role, [])];
  const plain = pages.filter((id) => !role.canvasVersions?.[id]);
  const out = plain.length ? [view(role, plain)] : [];
  for (const id of pages) if (role.canvasVersions?.[id]) out.push(view(role.canvasVersions[id], [id]));
  return out;
}

function assetEntry(asset: AssetRecord): CanvasAssetLike[] {
  const pages = asset.canvasPageIds ?? [];
  const named = pages.filter((id) => asset.canvasFilenames?.[id]);
  const plain = pages.filter((id) => !asset.canvasFilenames?.[id]);
  const base = { assetId: asset.assetId, kind: asset.kind, createdAt: asset.createdAt };
  const out: CanvasAssetLike[] = [];
  if (plain.length || !asset.canvasPageIds) out.push({ ...base, filename: asset.filename, pageIds: plain });
  for (const id of named) out.push({ ...base, filename: asset.canvasFilenames![id], pageIds: [id] });
  return out;
}

export async function readCanvasLibrary(): Promise<CanvasLibrary> {
  const existing = await existingDatabases();
  // Do not create empty canvas databases on an origin that never ran the canvas.
  if (existing && !LIBRARY_DBS.some((name) => existing.has(name))) return { pages: [], roles: [], assets: [], empty: true };
  const [pages, roles, assets] = await Promise.all([
    readPages(),
    !existing || existing.has(LIBRARY_DBS[0]) ? listAllRoles() : Promise.resolve([]),
    !existing || existing.has(LIBRARY_DBS[1]) ? listAllAssets() : Promise.resolve([]),
  ]);
  const usable = assets.filter((asset) => !asset.recycled && (asset.kind === "image" || asset.kind === "audio"));
  return { pages, roles: roles.flatMap(roleEntries), assets: usable.flatMap(assetEntry), empty: !roles.length && !usable.length };
}

const assetCache = new Map<string, AssetRecord>();
async function assetRecord(assetId: string) {
  if (!assetCache.size) for (const asset of await listAllAssets()) assetCache.set(asset.assetId, asset);
  return assetCache.get(assetId) ?? null;
}

/** The bytes of one canvas asset (image or sound). Throws when the canvas no longer has them. */
export async function readCanvasMedia(assetId: string): Promise<{ blob: Blob; filename: string; kind: "image" | "audio"; mimeType: string }> {
  const asset = await assetRecord(assetId);
  if (!asset || asset.recycled) throw new Error("画布里找不到这个素材（可能已删除）");
  if (asset.kind !== "image" && asset.kind !== "audio") throw new Error("这个素材不是图片或声音");
  const blob = asset.kind === "image" ? await getLocalImageBlob(asset.storageReference) : await getLocalAudioBlob(asset.storageReference);
  if (!blob.size) throw new Error("画布里这个素材是空文件");
  return { blob, filename: asset.filename, kind: asset.kind, mimeType: blob.type || asset.mimeType };
}
