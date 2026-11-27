import type { Editor } from 'tldraw';
import { assignAssetToCanvases, getMeta, listAllAssets, listRuns, listShots, putMeta, type AssetRecord } from './production-records.ts';
import { assignRoleToCanvases, listAllRoles, type RoleRecord } from './role-records.ts';
import { collectLibraryReferences, configureCanvasLibraryScope } from './canvas-library-scope.ts';

type DocumentRecord = { id: string; parentId?: string; props?: unknown };
type Page = { id: string };
/** All pages, including shapes nested in groups. No changes to node bindings or frozen runs. */
export function planLibraryOwnership(pages: readonly Page[], records: readonly DocumentRecord[], assets: readonly AssetRecord[], roles: readonly RoleRecord[], histories: readonly { ownerNodeId?: string | null; sourceH3NodeId?: string; runId?: string; shotId?: string; inputAssetIds?: string[]; outputAssetIds?: string[]; assetIds?: string[] }[] = [], queues: Record<string, unknown> = {}) {
  const refs = new Map(pages.map(page => [page.id, collectLibraryReferences(queues[page.id])]));
  const byId = new Map(records.map(record => [record.id, record]));
  const nodePages = new Map<string, string>();
  for (const record of records) {
    let parent = record.parentId;
    const seen = new Set<string>();
    while (parent && !refs.has(parent) && !seen.has(parent)) { seen.add(parent); parent = byId.get(parent)?.parentId; }
    if (parent && refs.has(parent)) { nodePages.set(record.id, parent); collectLibraryReferences(record.props, refs.get(parent)); }
  }
  for (const history of histories) {
    const owner = nodePages.get(history.ownerNodeId ?? history.sourceH3NodeId ?? '');
    for (const [id, values] of refs) if (id === owner || (!!history.runId && values.has(history.runId)) || (!!history.shotId && values.has(history.shotId))) collectLibraryReferences(history, values);
  }
  const defaultPage = pages[0]?.id;
  const rolePages = new Map<string, string[]>();
  for (const asset of assets) for (const values of refs.values()) if (values.has(asset.storageReference)) values.add(asset.assetId);
  for (const role of roles) {
    const found = [...refs].filter(([, values]) => values.has(role.roleId) || role.appearanceAssetIds.some(id => values.has(id))).map(([id]) => id);
    const owners = role.canvasPageIds ?? (found.length ? found : defaultPage ? [defaultPage] : []);
    rolePages.set(role.roleId, owners);
    for (const page of owners) for (const id of [...role.appearanceAssetIds, ...role.voiceAssetIds]) refs.get(page)?.add(id);
  }
  const assetPages = new Map<string, string[]>();
  // Follow derived media ancestry, so hidden originals remain available in their page's library.
  for (let pass = 0; pass < assets.length; pass++) {
    let changed = false;
    for (const asset of assets) for (const values of refs.values()) if (values.has(asset.assetId) || values.has(asset.storageReference)) {
      for (const id of [asset.sourceVideoAssetId, asset.sourceAudioAssetId, ...(asset.sourceAssetIds ?? [])]) if (id && !values.has(id)) { values.add(id); changed = true; }
    }
    if (!changed) break;
  }
  for (const asset of assets) {
    const found = [...refs].filter(([, values]) => values.has(asset.assetId) || values.has(asset.storageReference)).map(([id]) => id);
    assetPages.set(asset.assetId, asset.canvasPageIds ?? (found.length ? found : defaultPage ? [defaultPage] : []));
  }
  return { rolePages, assetPages };
}

/** Legacy ownership is based only on shape properties on each page. */
export function shapeAssetPages(pages: readonly Page[], records: readonly DocumentRecord[], assets: readonly AssetRecord[]) {
  const refs = new Map(pages.map(page => [page.id, new Set<string>()]));
  const byId = new Map(records.map(record => [record.id, record]));
  for (const record of records) {
    if (!record.id.startsWith('shape:')) continue;
    let parent = record.parentId;
    const seen = new Set<string>();
    while (parent && !refs.has(parent) && !seen.has(parent)) { seen.add(parent); parent = byId.get(parent)?.parentId; }
    if (parent && refs.has(parent)) collectLibraryReferences(record.props, refs.get(parent));
  }
  return new Map(assets.map(asset => [asset.assetId, [...refs].filter(([, values]) => values.has(asset.assetId) || values.has(asset.storageReference)).map(([id]) => id)]));
}

export async function migrateCanvasLibraries(editor: Editor) {
  const [assets, roles, runs, shots] = await Promise.all([listAllAssets(), listAllRoles(), listRuns(), listShots()]);
  const pages = editor.getPages(), queues: Record<string, unknown> = {};
  for (const page of pages) { try { queues[page.id] = JSON.parse(localStorage.getItem(`shot-queue-session-v1:${page.id}`) ?? 'null'); } catch { /* Invalid queue does not modify or prevent recovery of the document. */ } }
  const records = editor.store.allRecords() as unknown as DocumentRecord[];
  const plan = planLibraryOwnership(pages, records, assets, roles, [...shots, ...runs], queues);
  const shapePages = shapeAssetPages(pages, records, assets);
  // Kept inside the normal project backup's metadata; rollback remains possible, no media copies.
  const backupKey = 'canvas-library-isolation-v1-original-catalogues';
  if (!await getMeta(backupKey)) await putMeta(backupKey, { createdAt: Date.now(), assets, roles, pages });
  for (const role of roles) if (!role.canvasPageIds) await assignRoleToCanvases(role.roleId, plan.rolePages.get(role.roleId) ?? []);
  for (const asset of assets) if (!asset.canvasPageIds) await assignAssetToCanvases(asset.assetId, shapePages.get(asset.assetId) ?? []);
  await repairLegacyLibraryOwnership(editor);
  await repairShapeAssetOwnership(editor);
}

type Catalogues = { assets: AssetRecord[]; roles: RoleRecord[] };
/** Repair only old unscoped rows with multi-page migration ownership. New imports and single-page rows stay intact. */
export function planLegacyLibraryRepair(pages: readonly Page[], records: readonly DocumentRecord[], assets: readonly AssetRecord[], roles: readonly RoleRecord[], histories: Parameters<typeof planLibraryOwnership>[4], queues: Record<string, unknown>, original: Catalogues) {
  const oldAssets = new Set(original.assets.filter(row => !row.canvasPageIds).map(row => row.assetId));
  const oldRoles = new Set(original.roles.filter(row => !row.canvasPageIds).map(row => row.roleId));
  const repairAssets = assets.filter(row => oldAssets.has(row.assetId) && (row.canvasPageIds?.length ?? 0) > 1);
  const repairRoles = roles.filter(row => oldRoles.has(row.roleId) && (row.canvasPageIds?.length ?? 0) > 1);
  const assetIds = new Set(repairAssets.map(row => row.assetId)), roleIds = new Set(repairRoles.map(row => row.roleId));
  const plan = planLibraryOwnership(pages, records, assets.map(row => assetIds.has(row.assetId) ? { ...row, canvasPageIds: undefined } : row), roles.map(row => roleIds.has(row.roleId) ? { ...row, canvasPageIds: undefined } : row), histories, queues);
  const changed = (before: string[] | undefined, after: string[]) => JSON.stringify([...(before ?? [])].sort()) !== JSON.stringify([...after].sort());
  // Preserve explicit per-page edits made after migration, even without a remaining node.
  const roleChanges = repairRoles.map(row => ({ id: row.roleId, pages: [...new Set([...(plan.rolePages.get(row.roleId) ?? []), ...Object.keys(row.canvasVersions ?? {})])] })).filter(row => changed(roles.find(r => r.roleId === row.id)?.canvasPageIds, row.pages));
  const assetChanges = repairAssets.map(row => ({ id: row.assetId, pages: [...new Set([...(plan.assetPages.get(row.assetId) ?? []), ...Object.keys(row.canvasFilenames ?? {})])] })).filter(row => changed(assets.find(a => a.assetId === row.id)?.canvasPageIds, row.pages));
  return { roleChanges, assetChanges };
}

export async function repairLegacyLibraryOwnership(editor: Editor) {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('frameflow-library-ownership-repair-v2', () => repairLegacyLibraryOwnershipUnlocked(editor));
  return repairLegacyLibraryOwnershipUnlocked(editor);
}

async function repairLegacyLibraryOwnershipUnlocked(editor: Editor) {
  const key = 'canvas-library-isolation-v2-empty-history-repair';
  if (await getMeta<{ completed?: boolean }>(key).then(value => value?.completed)) return;
  const original = await getMeta<Catalogues>('canvas-library-isolation-v1-original-catalogues');
  if (!original) return;
  const [assets, roles, runs, shots] = await Promise.all([listAllAssets(), listAllRoles(), listRuns(), listShots()]);
  const pages = editor.getPages(), queues: Record<string, unknown> = {};
  for (const page of pages) { try { queues[page.id] = JSON.parse(localStorage.getItem(`shot-queue-session-v1:${page.id}`) ?? 'null'); } catch { /* Keep invalid queue unchanged. */ } }
  const changes = planLegacyLibraryRepair(pages, editor.store.allRecords() as unknown as DocumentRecord[], assets, roles, [...shots, ...runs], queues, original);
  // Separate immutable pre-repair snapshot survives interruption and is included in project backups.
  if (!await getMeta(`${key}-backup`)) await putMeta(`${key}-backup`, { createdAt: Date.now(), assets, roles, changes, pages });
  for (const role of changes.roleChanges) await assignRoleToCanvases(role.id, role.pages, true);
  for (const asset of changes.assetChanges) await assignAssetToCanvases(asset.id, asset.pages, true);
  await putMeta(key, { completed: true, completedAt: Date.now(), ...changes });
}

/** Snapshot the original rows and resumable plan before changing visibility. */
export async function repairShapeAssetOwnership(editor: Editor) {
  const run = async () => {
    const key = 'canvas-library-isolation-v3-shape-assets';
    if ((await getMeta<{ completed?: boolean }>(key))?.completed) return;
    const original = await getMeta<Catalogues>('canvas-library-isolation-v1-original-catalogues');
    if (!original) return;
    let backup = await getMeta<{ assets: AssetRecord[]; changes: { id: string; pages: string[] }[] }>(`${key}-backup`);
    if (!backup) {
      const assets = await listAllAssets();
      const legacy = new Set(original.assets.filter(row => !row.canvasPageIds).map(row => row.assetId));
      const v2 = await getMeta<{ assets: AssetRecord[] }>('canvas-library-isolation-v2-empty-history-repair-backup');
      const v2Multi = new Set((v2?.assets ?? []).filter(row => (row.canvasPageIds?.length ?? 0) > 1).map(row => row.assetId));
      const candidates = assets.filter(row => legacy.has(row.assetId) && ((row.canvasPageIds?.length ?? 0) > 1 || v2Multi.has(row.assetId)));
      const shapePages = shapeAssetPages(editor.getPages(), editor.store.allRecords() as unknown as DocumentRecord[], candidates);
      const changes = candidates.map(row => ({ id: row.assetId, pages: [...new Set([...(shapePages.get(row.assetId) ?? []), ...Object.keys(row.canvasFilenames ?? {})])] }))
        .filter(change => JSON.stringify([...change.pages].sort()) !== JSON.stringify([...(candidates.find(row => row.assetId === change.id)?.canvasPageIds ?? [])].sort()));
      backup = { assets: candidates.filter(row => changes.some(change => change.id === row.assetId)), changes };
      await putMeta(`${key}-backup`, { createdAt: Date.now(), ...backup });
    }
    for (const change of backup.changes) await assignAssetToCanvases(change.id, change.pages, true);
    await putMeta(key, { completed: true, completedAt: Date.now(), changes: backup.changes });
  };
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('frameflow-library-ownership-repair-v3', run);
  return run();
}

export function installCanvasLibraryScope(editor: Editor) {
  const initialization = migrateCanvasLibraries(editor);
  configureCanvasLibraryScope(() => {
    let references: Set<string> | undefined;
    return { pageId: editor.getCurrentPageId(), pageName: editor.getCurrentPage?.()?.name, get references() { return references ??= collectLibraryReferences(editor.getCurrentPageShapes().map(shape => shape.props)); } };
  }, initialization);
  return initialization;
}
