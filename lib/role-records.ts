import { getAsset, type AssetKind } from "./production-records.ts";
import { withProjectMediaWrite } from "./project-media-lock.ts";
import { openLocalDatabase } from "./local-database-open.ts";
import { belongsToCanvas, canvasLibraryReady, currentLibraryScope, type LibraryScope } from "./canvas-library-scope.ts";

/** Role metadata has its own database; no media Blob or frozen record store is migrated. */
const DATABASE = "frameflow-role-records";
const STORE = "roles";

export interface RoleRecord {
  canvasPageIds?: string[];
  excludedCanvasPageIds?: string[];
  /** Existing roleIds stay stable; edits to a shared legacy card are page-local. */
  canvasVersions?: Record<string, Omit<RoleRecord, 'canvasVersions'>>;
  schemaVersion: 1;
  roleId: string;
  displayName: string;
  appearanceAssetIds: string[];
  voiceAssetIds: string[];
  primaryAppearanceAssetId: string | null;
  primaryVoiceAssetId: string | null;
  description: string;
  createdAt: number;
  updatedAt: number;
  defaultClothing?: string;
  hair?: string;
  faceReferenceAssetId?: string | null;
  bodyReferenceAssetId?: string | null;
  notes?: string;
  licenseSource?: string;
}

let databasePromise: Promise<IDBDatabase> | null = null;
function openDatabase() {
  if (!databasePromise) {
    const pending = openLocalDatabase(DATABASE, 1, (request) => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "roleId" }); }, () => { if (databasePromise === pending) databasePromise = null; }, "角色资产库无法打开");
    databasePromise = pending;
  }
  return databasePromise;
}

export async function listAllRoles(): Promise<RoleRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve((request.result as RoleRecord[]).sort((a, b) => b.updatedAt - a.updatedAt));
    request.onerror = () => reject(request.error ?? new Error("角色列表读取失败"));
  });
}

function pageRole(role: RoleRecord, scope: LibraryScope | undefined): RoleRecord {
  return scope && role.canvasVersions?.[scope.pageId] ? { ...role.canvasVersions[scope.pageId], canvasPageIds: role.canvasPageIds } : role;
}
export async function listRoles(): Promise<RoleRecord[]> {
  const scope = currentLibraryScope();
  await canvasLibraryReady();
  return (await listAllRoles()).filter(role => belongsToCanvas(role, scope, role.roleId)).map(role => pageRole(role, scope));
}

export async function getRole(roleId: string): Promise<RoleRecord | null> {
  const scope = currentLibraryScope();
  await canvasLibraryReady();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(roleId);
    request.onsuccess = () => { const role = request.result as RoleRecord | undefined; resolve(role && belongsToCanvas(role, scope, roleId) ? pageRole(role, scope) : null); };
    request.onerror = () => reject(request.error ?? new Error("角色读取失败"));
  });
}

async function mutateRole(roleId: string, change: (role: RoleRecord) => RoleRecord): Promise<RoleRecord> {
  const scope = currentLibraryScope();
  await canvasLibraryReady();
  return withProjectMediaWrite(() => openDatabase().then((db) => new Promise<RoleRecord>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(roleId);
    let next: RoleRecord | null = null;
    request.onsuccess = () => {
      if (!request.result) { tx.abort(); return; }
      try {
        const stored = request.result as RoleRecord;
        if (!belongsToCanvas(stored, scope, roleId)) throw Error('该角色不属于当前画布');
        const current = { ...pageRole(stored, scope) }; delete current.canvasVersions;
        next = { ...change(current), updatedAt: Date.now() };
        store.put(scope ? { ...stored, canvasPageIds: [...new Set([...(stored.canvasPageIds ?? []), scope.pageId])], canvasVersions: { ...stored.canvasVersions, [scope.pageId]: next } } : next);
      }
      catch (cause) { reject(cause); tx.abort(); }
    };
    tx.oncomplete = () => resolve(next!);
    tx.onerror = () => reject(tx.error ?? new Error("角色保存失败"));
    tx.onabort = () => reject(tx.error ?? new Error("角色不存在或保存已中止"));
  })));
}

export async function createRole(displayName: string, requestedId?: string): Promise<RoleRecord> {
  const scope = currentLibraryScope();
  await canvasLibraryReady();
  if (scope && !scope.pageId) throw Error('画布尚未加载完成，请稍后再创建角色');
  const name = displayName.trim();
  if (!name) throw new Error("请填写角色名称");
  const roleId = requestedId?.trim() || crypto.randomUUID();
  if (requestedId?.trim()) {
    const existing = await getRole(roleId);
    if (existing) return existing;
  }
  const now = Date.now();
  const role: RoleRecord = { ...(scope ? { canvasPageIds: [scope.pageId] } : {}), schemaVersion: 1, roleId, displayName: name, appearanceAssetIds: [], voiceAssetIds: [], primaryAppearanceAssetId: null, primaryVoiceAssetId: null, description: "", createdAt: now, updatedAt: now };
  const db = await openDatabase();
  try {
    await withProjectMediaWrite(() => new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add(role);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("角色创建失败"));
      tx.onabort = () => reject(tx.error ?? new Error("角色创建已中止"));
    }));
  } catch (cause) {
    const existing = requestedId?.trim() ? await getRole(roleId).catch(() => null) : null;
    if (existing) return existing;
    throw cause;
  }
  return role;
}

export function updateRoleDetails(roleId: string, details: { displayName?: string; description?: string }) {
  if (details.displayName !== undefined && !details.displayName.trim()) throw new Error("角色名称不能为空");
  return mutateRole(roleId, (role) => ({ ...role, ...(details.displayName !== undefined ? { displayName: details.displayName.trim() } : {}), ...(details.description !== undefined ? { description: details.description } : {}) }));
}

function fields(kind: "image" | "audio") {
  return kind === "image" ? { ids: "appearanceAssetIds" as const, primary: "primaryAppearanceAssetId" as const } : { ids: "voiceAssetIds" as const, primary: "primaryVoiceAssetId" as const };
}

export async function addRoleAsset(roleId: string, assetId: string, kind: "image" | "audio"): Promise<{ role: RoleRecord; added: boolean }> {
  const asset = await getAsset(assetId);
  if (!asset || asset.kind !== kind) throw new Error("素材不存在或类型不匹配");
  const key = fields(kind);
  let added = false;
  const role = await mutateRole(roleId, (current) => {
    if (current[key.ids].includes(assetId)) return current;
    added = true;
    return { ...current, [key.ids]: [...current[key.ids], assetId], [key.primary]: current[key.primary] ?? assetId };
  });
  return { role, added };
}

export function removeRoleAsset(roleId: string, assetId: string, kind: "image" | "audio") {
  const key = fields(kind);
  return mutateRole(roleId, (role) => ({ ...role, [key.ids]: role[key.ids].filter((id) => id !== assetId), [key.primary]: role[key.primary] === assetId ? null : role[key.primary] }));
}

export function setRoleStillReferences(roleId: string, refs: { faceAssetId: string; bodyAssetId: string; clothing: string; hair: string; description: string }) {
  if (refs.faceAssetId === refs.bodyAssetId) throw new Error("脸部参考和全身参考要是两张图");
  return mutateRole(roleId, (role) => {
    const appearance = [...role.appearanceAssetIds];
    for (const assetId of [refs.faceAssetId, refs.bodyAssetId]) if (!appearance.includes(assetId)) appearance.push(assetId);
    return { ...role, appearanceAssetIds: appearance, faceReferenceAssetId: refs.faceAssetId, bodyReferenceAssetId: refs.bodyAssetId, defaultClothing: refs.clothing, hair: refs.hair, description: refs.description || role.description };
  });
}

export function setPrimaryRoleAsset(roleId: string, assetId: string, kind: "image" | "audio") {
  const key = fields(kind);
  return mutateRole(roleId, (role) => {
    if (!role[key.ids].includes(assetId)) throw new Error("请先将素材加入角色");
    return { ...role, [key.primary]: assetId };
  });
}

export async function deleteRole(roleId: string) {
  const scope = currentLibraryScope();
  await canvasLibraryReady();
  const db = await openDatabase();
  await withProjectMediaWrite(() => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (!scope) store.delete(roleId);
    else {
      const request = store.get(roleId);
      request.onsuccess = () => {
        const role = request.result as RoleRecord | undefined;
        if (role && belongsToCanvas(role, scope, roleId)) store.put({ ...role, canvasPageIds: role.canvasPageIds?.filter(id => id !== scope.pageId) ?? [], excludedCanvasPageIds: [...new Set([...(role.excludedCanvasPageIds ?? []), scope.pageId])] });
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("角色删除失败"));
    tx.onabort = () => reject(tx.error ?? new Error("角色删除已中止"));
  }));
}

export type RoleAssetKind = Extract<AssetKind, "image" | "audio">;

/** Migration changes only membership, never roleIds, user fields or media. */
export async function assignRoleToCanvases(roleId: string, pageIds: string[], replace = false) {
  const db = await openDatabase();
  await withProjectMediaWrite(() => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE), request = store.get(roleId);
    request.onsuccess = () => { if (request.result) { const role = request.result as RoleRecord; store.put({ ...role, canvasPageIds: [...new Set([...(replace ? [] : role.canvasPageIds ?? []), ...pageIds])] }); } };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? Error('角色画布归属保存失败'));
  }));
}
