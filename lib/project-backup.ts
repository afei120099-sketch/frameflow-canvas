/**
 * Project Backup V1 (Phase 8): local export / import of one whole project as a folder.
 *
 *   <folder>/manifest.json   format, version, counts, media index, warnings (written last = completeness marker)
 *   <folder>/canvas.json     tldraw document snapshot (same persistenceKey, loaded via loadSnapshot)
 *   <folder>/records.json    Asset / Run / Shot / meta / Role records, IDs unchanged
 *   <folder>/media/<store>/<id>.<ext>   raw Blobs from the image / video / audio stores
 *   <folder>/director-stage.json   Director Stage records (format v2+; absent in v1 packages)
 *
 * Media keeps its store id, so every `image:` / `media:` / `audio:` storageReference stays valid.
 * Object URLs never enter a backup. Import validates everything before writing anything.
 * v1 packages stay importable: they carry no Director Stage data, and restoring one leaves the
 * current Director Stage data untouched (with a warning) instead of clearing it.
 */
import type { z } from "zod";
import { CameraSchema, ControlPackageSchema, MotionSchema, PropSchema, SceneSchema, SceneStateSchema } from "./director-stage/schema.ts";
import { DIRECTOR_STAGE_DATABASE } from "./director-stage/store.ts";
import { withProjectRestoreLock } from "./project-media-lock.ts";

export const BACKUP_FORMAT = "frameflow-project-v1";
export const BACKUP_FORMAT_VERSION = 2;
export const SUPPORTED_BACKUP_VERSIONS = [1, 2] as const;
export const DIRECTOR_STAGE_FILE = "director-stage.json";
export const DIRECTOR_STAGE_V1_NOTE = "旧版备份（v1）不含导演台数据：恢复时当前导演台数据保持不变";
export const NIGHT_BACKUP_NOTE = "当前备份不包含夜班任务/计划/夜班磁盘账本；请另行归档 runtime/autopilot（见 docs/DATA_SAFETY_BACKUP.md）";

type Row = Record<string, unknown>;
type MediaStore = "images" | "videos" | "audios";
const MEDIA_PREFIX: Record<MediaStore, string> = { images: "image:", videos: "media:", audios: "audio:" };

/** Same names, versions and upgrade shapes as lib/local-video-store.ts, production-records.ts, role-records.ts and director-stage/store.ts. */
const DATABASES = {
  media: { name: "frameflow-local-media", version: 2, stores: [["videos", "id"], ["images", "id"]] },
  audio: { name: "frameflow-local-audio", version: 1, stores: [["audios", "id"]] },
  records: { name: "frameflow-production-records", version: 2, stores: [["assets", "assetId"], ["runs", "runId"], ["shots", "shotId"], ["meta", "key"]] },
  roles: { name: "frameflow-role-records", version: 1, stores: [["roles", "roleId"]] },
  director: DIRECTOR_STAGE_DATABASE,
} as const;

/** Director Stage stores in backup order; every row is checked against its V0.1 schema on import. */
const DIRECTOR_SCHEMAS = { scenes: SceneSchema, props: PropSchema, states: SceneStateSchema, cameras: CameraSchema, motions: MotionSchema, controlPackages: ControlPackageSchema } as const;
type DirectorStore = (typeof DIRECTOR_STAGE_DATABASE.stores)[number][0];
const DIRECTOR_STORES = DIRECTOR_STAGE_DATABASE.stores.map(([store]) => store) as DirectorStore[];
export type DirectorStageData = Record<DirectorStore, Row[]>;
export type DirectorCounts = Record<DirectorStore, number>;
const directorCounts = (data: DirectorStageData) => Object.fromEntries(DIRECTOR_STORES.map((store) => [store, data[store].length])) as DirectorCounts;
type DatabaseKey = keyof typeof DATABASES;

function openDb(key: DatabaseKey) {
  const spec = DATABASES[key];
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(spec.name, spec.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [store, keyPath] of spec.stores) {
        if (db.objectStoreNames.contains(store)) continue;
        const created = db.createObjectStore(store, { keyPath });
        if (store === "assets") created.createIndex("storageReference", "storageReference", { unique: true });
      }
    };
    request.onblocked = () => reject(new Error(`${spec.name} 被其他页面占用`));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`无法打开 ${spec.name}`));
  });
}

function getAll(db: IDBDatabase, store: string) {
  return new Promise<Row[]>((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result as Row[]);
    request.onerror = () => reject(request.error ?? new Error(`${store} 读取失败`));
  });
}

function getAllKeys(db: IDBDatabase, store: string) {
  return new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`${store} 键读取失败`));
  });
}

function getOne(db: IDBDatabase, store: string, key: IDBValidKey) {
  return new Promise<Row | undefined>((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as Row | undefined);
    request.onerror = () => reject(request.error ?? new Error(`${store} 读取失败`));
  });
}

/** One transaction per database: every listed store is cleared and rewritten, or nothing changes. */
function replaceStores(db: IDBDatabase, content: Record<string, Row[]>) {
  const stores = Object.keys(content);
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, "readwrite");
    for (const store of stores) { const target = tx.objectStore(store); target.clear(); for (const row of content[store]) target.put(row); }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("写入已中止"));
  });
}

/** New IDs only; never overwrite an existing media record, even on an unexpected race. */
function putAll(db: IDBDatabase, store: string, rows: Row[]) {
  if (!rows.length) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const target = tx.objectStore(store);
    for (const row of rows) target.add(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("媒体写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("媒体写入已中止"));
  });
}

export interface ProjectRecords { assets: Row[]; runs: Row[]; shots: Row[]; meta: Row[]; roles: Row[] }
export interface MediaEntry { store: MediaStore; id: string; file: string; size: number; type: string; name: string; createdAt: number | null }
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  exportedAt: number;
  appVersion: string;
  persistenceKey: string;
  counts: { images: number; videos: number; audios: number; assets: number; runs: number; shots: number; roles: number; activeRuns: number };
  /** Format v2+: record counts of director-stage.json. Absent in v1 packages. */
  directorCounts?: DirectorCounts;
  totalMediaBytes: number;
  media: MediaEntry[];
  warnings: string[];
  /** Daily light backup: canvas + records only, no media files (they stay in the browser). */
  lightweight?: boolean;
}
export interface BackupSink { writeText(path: string, text: string): Promise<void>; writeBlob(path: string, blob: Blob): Promise<void> }
export interface BackupSource { has(path: string): boolean; readText(path: string): Promise<string>; readBlob(path: string): Promise<Blob>; size(path: string): number | null }

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/ogg": "ogg" };
const extensionFor = (type: string) => EXTENSIONS[type.split(";")[0].trim().toLowerCase()] ?? "bin";
const isActive = (run: Row) => run.status === "queued" || run.status === "running";

/** Media refs used by records and canvas that are not resolvable from stored Blobs (legacy inline, missing). */
function referenceWarnings(records: ProjectRecords, mediaIds: Set<string>, canvasDocument: unknown) {
  const warnings: string[] = [NIGHT_BACKUP_NOTE];
  let legacy = 0; const missing: string[] = [];
  const check = (ref: unknown, owner: string) => {
    if (typeof ref !== "string" || !ref) return;
    if (ref.startsWith("legacy-inline:") || ref.startsWith("data:")) { legacy += 1; return; }
    const store = (Object.keys(MEDIA_PREFIX) as MediaStore[]).find((key) => ref.startsWith(MEDIA_PREFIX[key]));
    if (store && !mediaIds.has(`${store}/${ref.slice(MEDIA_PREFIX[store].length)}`)) missing.push(`${owner}：${ref}`);
  };
  for (const asset of records.assets) if (!asset.recycled) check(asset.storageReference, `Asset ${String(asset.filename ?? asset.assetId)}`);
  const recycled = records.assets.filter(asset => asset.recycled).length;
  if (recycled) warnings.push(`recycledMedia: ${recycled} 份素材已由用户移入 Windows 回收站；本备份仅保留回收凭据和历史记录，不包含已回收文件`);
  for (const node of canvasShapes(canvasDocument)) check(node.props?.src, `画布节点 ${node.id}`);
  if (legacy) warnings.push(`legacySkipped: ${legacy} 个旧版内联媒体（data: / legacy-inline:）没有独立 Blob；画布内联内容随 canvas.json 保存，但无法作为独立媒体完整备份`);
  if (missing.length) warnings.push(`missingMedia: ${missing.length} 个媒体引用在本地库中找不到 Blob：${missing.slice(0, 5).join("；")}${missing.length > 5 ? "…" : ""}`);
  return { warnings, missing: missing.length, legacy };
}

type CanvasShape = { id: string; typeName?: string; type?: string; props?: { src?: unknown; assetId?: unknown } };
function canvasShapes(document: unknown): CanvasShape[] {
  const store = (document as { store?: Record<string, CanvasShape> } | null)?.store;
  return store && typeof store === "object" ? Object.values(store).filter((record) => record && record.typeName === "shape") : [];
}

/** Read the whole local project (metadata + media Blobs + Director Stage records). Read-only. */
export async function collectProject() {
  const [media, audio, records, roles, director] = await Promise.all([openDb("media"), openDb("audio"), openDb("records"), openDb("roles"), openDb("director")]);
  const [videos, images, audios, assets, runs, shots, meta, roleRows, directorRows] = await Promise.all([getAll(media, "videos"), getAll(media, "images"), getAll(audio, "audios"), getAll(records, "assets"), getAll(records, "runs"), getAll(records, "shots"), getAll(records, "meta"), getAll(roles, "roles"), Promise.all(DIRECTOR_STORES.map((store) => getAll(director, store)))]);
  return {
    media: { images, videos, audios } as Record<MediaStore, Row[]>,
    records: { assets, runs, shots, meta, roles: roleRows } as ProjectRecords,
    director: Object.fromEntries(DIRECTOR_STORES.map((store, index) => [store, directorRows[index]])) as DirectorStageData,
  };
}

/** ControlPackage Asset IDs that are not in the (backed-up / restored) Asset records. Warning only. */
function directorAssetWarnings(director: DirectorStageData, records: ProjectRecords) {
  const known = new Set(records.assets.map((asset) => asset.assetId));
  const missing = director.controlPackages.flatMap((pack) => (Array.isArray(pack.assetIds) ? pack.assetIds : []).filter((id) => !known.has(id)));
  return missing.length ? [`directorMissingAssets: 导演台控制素材包引用了 ${missing.length} 个不在 Asset 记录中的素材：${missing.slice(0, 5).join("、")}${missing.length > 5 ? "…" : ""}`] : [];
}

/** Schema, unique IDs, Scene binding and same-Scene references of a director-stage.json payload. */
function validateDirector(value: unknown, problems: string[]): DirectorStageData | null {
  if (!value || typeof value !== "object") { problems.push(`${DIRECTOR_STAGE_FILE} 不是有效的导演台数据`); return null; }
  const source = value as Record<string, unknown>;
  const data = {} as DirectorStageData;
  for (const store of DIRECTOR_STORES) {
    const rows = source[store];
    if (!Array.isArray(rows)) { problems.push(`${DIRECTOR_STAGE_FILE}.${store} 缺失`); return null; }
    const schema: z.ZodTypeAny = DIRECTOR_SCHEMAS[store];
    const seen = new Set<string>();
    for (const row of rows) {
      const parsed = schema.safeParse(row);
      if (!parsed.success) { problems.push(`${DIRECTOR_STAGE_FILE}.${store} 中有无效记录：${parsed.error.issues[0]?.path.join(".") || "(根)"} ${parsed.error.issues[0]?.message ?? ""}`.trim()); return null; }
      const id = (row as Row).id as string;
      if (seen.has(id)) { problems.push(`${DIRECTOR_STAGE_FILE}.${store} 中 ID 重复：${id}`); return null; }
      seen.add(id);
    }
    data[store] = rows as Row[];
  }
  const scenes = new Set(data.scenes.map((row) => row.id));
  const sceneOf = (rows: Row[]) => new Map(rows.map((row) => [row.id, row.sceneId]));
  const props = sceneOf(data.props);
  const cameras = sceneOf(data.cameras);
  for (const store of DIRECTOR_STORES.filter((name) => name !== "scenes")) {
    const orphan = data[store].find((row) => !scenes.has(row.sceneId));
    if (orphan) problems.push(`${DIRECTOR_STAGE_FILE}.${store} 中记录 ${String(orphan.id)} 所属场景不存在`);
  }
  for (const state of data.states) for (const change of state.propChanges as { propId: string }[]) if (props.get(change.propId) !== state.sceneId) { problems.push(`${DIRECTOR_STAGE_FILE}.states 中状态 ${String(state.id)} 引用了不属于该场景的道具`); break; }
  for (const motion of data.motions) if ((motion.targetType === "camera" ? cameras : props).get(motion.targetId as string) !== motion.sceneId) problems.push(`${DIRECTOR_STAGE_FILE}.motions 中动作 ${String(motion.id)} 的目标不属于该场景`);
  return data;
}

async function writeBackup(project: Awaited<ReturnType<typeof collectProject>>, canvasDocument: unknown, sink: BackupSink, options: { appVersion: string; persistenceKey: string; now?: number; onProgress?: (done: number, total: number, bytes: number) => void }, extraWarnings: string[] = []) {
  const entries: { entry: MediaEntry; blob: Blob }[] = [];
  const warnings: string[] = [];
  for (const store of ["images", "videos", "audios"] as MediaStore[]) {
    for (const row of project.media[store]) {
      const blob = row.blob;
      if (!(blob instanceof Blob)) { warnings.push(`媒体 ${store}/${String(row.id)} 没有可读取的 Blob，已跳过`); continue; }
      const type = typeof row.type === "string" && row.type ? row.type : blob.type;
      entries.push({ blob, entry: { store, id: String(row.id), file: `media/${store}/${String(row.id)}.${extensionFor(type || blob.type)}`, size: blob.size, type: type || blob.type || "application/octet-stream", name: typeof row.name === "string" ? row.name : "", createdAt: typeof row.createdAt === "number" ? row.createdAt : null } });
    }
  }
  const mediaIds = new Set(entries.map(({ entry }) => `${entry.store}/${entry.id}`));
  warnings.push(...extraWarnings, ...referenceWarnings(project.records, mediaIds, canvasDocument).warnings, ...directorAssetWarnings(project.director, project.records));
  const activeRuns = project.records.runs.filter(isActive).length;
  if (activeRuns) warnings.push(`activeRuns: ${activeRuns} 个任务导出时仍在排队/生成中；恢复后会标记为“状态待确认”，不会重新提交`);
  const totalMediaBytes = entries.reduce((sum, item) => sum + item.entry.size, 0);
  let done = 0; let bytes = 0;
  options.onProgress?.(0, entries.length, 0);
  for (const { entry, blob } of entries) { await sink.writeBlob(entry.file, blob); done += 1; bytes += entry.size; options.onProgress?.(done, entries.length, bytes); }
  await sink.writeText("records.json", JSON.stringify(project.records));
  await sink.writeText(DIRECTOR_STAGE_FILE, JSON.stringify({ databaseVersion: DIRECTOR_STAGE_DATABASE.version, ...project.director }));
  await sink.writeText("canvas.json", JSON.stringify({ document: canvasDocument ?? null }));
  const count = (store: MediaStore) => entries.filter(({ entry }) => entry.store === store).length;
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, exportedAt: options.now ?? Date.now(), appVersion: options.appVersion, persistenceKey: options.persistenceKey,
    counts: { images: count("images"), videos: count("videos"), audios: count("audios"), assets: project.records.assets.length, runs: project.records.runs.length, shots: project.records.shots.length, roles: project.records.roles.length, activeRuns },
    directorCounts: directorCounts(project.director),
    totalMediaBytes, media: entries.map(({ entry }) => entry), warnings,
  };
  await sink.writeText("manifest.json", JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function exportProject(canvasDocument: unknown, sink: BackupSink, options: { appVersion: string; persistenceKey: string; now?: number; onProgress?: (done: number, total: number, bytes: number) => void }) {
  return writeBackup(await collectProject(), canvasDocument, sink, options);
}

function mediaEntry(store: MediaStore, row: Row, blob: Blob | null): MediaEntry {
  const type = typeof row.type === "string" && row.type ? row.type : blob?.type || "application/octet-stream";
  const id = String(row.id);
  return { store, id, file: `media/${store}/${id}.${extensionFor(type)}`, size: blob?.size ?? (typeof row.size === "number" ? row.size : 0), type, name: typeof row.name === "string" ? row.name : "", createdAt: typeof row.createdAt === "number" ? row.createdAt : null };
}

async function finalizeBackup(project: Awaited<ReturnType<typeof collectProject>>, canvasDocument: unknown, sink: BackupSink, options: { appVersion: string; persistenceKey: string; now?: number }, entries: MediaEntry[], warnings: string[], lightweight = false) {
  const mediaIds = new Set(entries.map((entry) => `${entry.store}/${entry.id}`));
  const refWarnings = referenceWarnings(project.records, mediaIds, canvasDocument).warnings.filter((warning) => !(lightweight && warning.startsWith("missingMedia:")));
  const allWarnings = [...warnings, ...refWarnings, ...directorAssetWarnings(project.director, project.records)];
  const activeRuns = project.records.runs.filter(isActive).length;
  if (activeRuns) allWarnings.push(`activeRuns: ${activeRuns} 个任务导出时仍在排队/生成中；恢复后会标记为“状态待确认”，不会重新提交`);
  await sink.writeText("records.json", JSON.stringify(project.records));
  await sink.writeText(DIRECTOR_STAGE_FILE, JSON.stringify({ databaseVersion: DIRECTOR_STAGE_DATABASE.version, ...project.director }));
  await sink.writeText("canvas.json", JSON.stringify({ document: canvasDocument ?? null }));
  const count = (store: MediaStore) => entries.filter((entry) => entry.store === store).length;
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, exportedAt: options.now ?? Date.now(), appVersion: options.appVersion, persistenceKey: options.persistenceKey,
    counts: { images: count("images"), videos: count("videos"), audios: count("audios"), assets: project.records.assets.length, runs: project.records.runs.length, shots: project.records.shots.length, roles: project.records.roles.length, activeRuns },
    directorCounts: directorCounts(project.director),
    totalMediaBytes: entries.reduce((sum, entry) => sum + entry.size, 0), media: entries, warnings: allWarnings,
    ...(lightweight ? { lightweight: true } : {}),
  };
  await sink.writeText("manifest.json", JSON.stringify(manifest, null, 2));
  return manifest;
}

export const LIGHT_BACKUP_NOTE = "轻量备份：只含画布和 Asset / Run / Shot / 角色 / 导演台记录，不含图片、视频、声音文件；恢复时浏览器里现有的媒体文件保持不变";

/** Same package format without media: reads only the record / role / Director Stage databases (no Blobs). */
export async function exportLightProject(canvasDocument: unknown, sink: BackupSink, options: { appVersion: string; persistenceKey: string; now?: number }) {
  const [recordsDb, rolesDb, directorDb] = await Promise.all([openDb("records"), openDb("roles"), openDb("director")]);
  try {
    const [assets, runs, shots, meta, roleRows, directorRows] = await Promise.all([getAll(recordsDb, "assets"), getAll(recordsDb, "runs"), getAll(recordsDb, "shots"), getAll(recordsDb, "meta"), getAll(rolesDb, "roles"), Promise.all(DIRECTOR_STORES.map((store) => getAll(directorDb, store)))]);
    const project = {
      media: { images: [] as Row[], videos: [] as Row[], audios: [] as Row[] },
      records: { assets, runs, shots, meta, roles: roleRows } as ProjectRecords,
      director: Object.fromEntries(DIRECTOR_STORES.map((store, index) => [store, directorRows[index]])) as DirectorStageData,
    };
    const manifest = await finalizeBackup(project, canvasDocument, sink, options, [], [LIGHT_BACKUP_NOTE], true);
    return { manifest, project };
  } finally {
    recordsDb.close(); rolesDb.close(); directorDb.close();
  }
}

/** Writes one Blob at a time so an 8GB library is not held in memory. Media rows on the returned project have no Blob. */
export async function exportProjectStreaming(canvasDocument: unknown, sink: BackupSink, options: { appVersion: string; persistenceKey: string; now?: number; onProgress?: (done: number, total: number, bytes: number) => void }) {
  const [mediaDb, audioDb, recordsDb, rolesDb, directorDb] = await Promise.all([openDb("media"), openDb("audio"), openDb("records"), openDb("roles"), openDb("director")]);
  try {
    const [assets, runs, shots, meta, roleRows, directorRows] = await Promise.all([getAll(recordsDb, "assets"), getAll(recordsDb, "runs"), getAll(recordsDb, "shots"), getAll(recordsDb, "meta"), getAll(rolesDb, "roles"), Promise.all(DIRECTOR_STORES.map((store) => getAll(directorDb, store)))]);
    const project = {
      media: { images: [] as Row[], videos: [] as Row[], audios: [] as Row[] },
      records: { assets, runs, shots, meta, roles: roleRows } as ProjectRecords,
      director: Object.fromEntries(DIRECTOR_STORES.map((store, index) => [store, directorRows[index]])) as DirectorStageData,
    };
    const plan: { store: MediaStore; db: IDBDatabase }[] = [{ store: "images", db: mediaDb }, { store: "videos", db: mediaDb }, { store: "audios", db: audioDb }];
    const keys: { store: MediaStore; db: IDBDatabase; id: IDBValidKey }[] = [];
    for (const item of plan) for (const id of await getAllKeys(item.db, item.store)) keys.push({ ...item, id });
    const entries: MediaEntry[] = [];
    const warnings: string[] = [];
    let done = 0; let bytes = 0;
    options.onProgress?.(0, keys.length, 0);
    for (const item of keys) {
      const row = await getOne(item.db, item.store, item.id);
      done += 1;
      const blob = row?.blob instanceof Blob ? row.blob : null;
      if (!row || !blob) { warnings.push(`媒体 ${item.store}/${String(item.id)} 没有可读取的 Blob，已跳过`); options.onProgress?.(done, keys.length, bytes); continue; }
      const entry = mediaEntry(item.store, row, blob);
      await sink.writeBlob(entry.file, blob);
      bytes += entry.size;
      entries.push(entry);
      project.media[item.store].push({ id: row.id, type: entry.type, name: entry.name, size: entry.size, createdAt: row.createdAt, file: entry.file });
      options.onProgress?.(done, keys.length, bytes);
    }
    const manifest = await finalizeBackup(project, canvasDocument, sink, options, entries, warnings);
    return { manifest, project };
  } finally {
    mediaDb.close(); audioDb.close(); recordsDb.close(); rolesDb.close(); directorDb.close();
  }
}

export class BackupValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) { super(`备份无法导入：${problems.slice(0, 3).join("；")}${problems.length > 3 ? `（共 ${problems.length} 项）` : ""}`); this.name = "BackupValidationError"; this.problems = problems; }
}

/** `director` is null for a v1 package: restoring it leaves the current Director Stage data untouched. */
export interface ParsedBackup { manifest: BackupManifest; canvasDocument: unknown; records: ProjectRecords; director: DirectorStageData | null; media: { entry: MediaEntry; source: BackupSource }[]; warnings: string[] }

const ID_FIELDS: Record<keyof ProjectRecords, string> = { assets: "assetId", runs: "runId", shots: "shotId", meta: "key", roles: "roleId" };
const parseJson = (text: string, name: string, problems: string[]) => { try { return JSON.parse(text) as unknown; } catch { problems.push(`${name} 不是有效的 JSON`); return null; } };

/** Full validation in memory. Nothing is written; any problem rejects the whole package. */
export async function readBackup(source: BackupSource): Promise<ParsedBackup> {
  const problems: string[] = [];
  for (const file of ["manifest.json", "records.json", "canvas.json"]) if (!source.has(file)) problems.push(`缺少 ${file}`);
  if (problems.length) throw new BackupValidationError(problems);
  const manifest = parseJson(await source.readText("manifest.json"), "manifest.json", problems) as BackupManifest | null;
  const records = parseJson(await source.readText("records.json"), "records.json", problems) as ProjectRecords | null;
  const canvas = parseJson(await source.readText("canvas.json"), "canvas.json", problems) as { document?: unknown } | null;
  if (problems.length || !manifest || !records || !canvas) throw new BackupValidationError(problems.length ? problems : ["备份内容为空"]);
  if (manifest.format !== BACKUP_FORMAT) throw new BackupValidationError([`不是 Frameflow 项目备份（format=${String(manifest.format)}）`]);
  if (!(SUPPORTED_BACKUP_VERSIONS as readonly number[]).includes(manifest.formatVersion)) throw new BackupValidationError([`不支持的备份版本 ${String(manifest.formatVersion)}（当前支持 ${SUPPORTED_BACKUP_VERSIONS.join(" / ")}）`]);
  let director: DirectorStageData | null = null;
  if (manifest.formatVersion >= 2) {
    if (!source.has(DIRECTOR_STAGE_FILE)) problems.push(`缺少 ${DIRECTOR_STAGE_FILE}`);
    else {
      const value = parseJson(await source.readText(DIRECTOR_STAGE_FILE), DIRECTOR_STAGE_FILE, problems);
      if (value !== null) director = validateDirector(value, problems);
      if (director && manifest.directorCounts && DIRECTOR_STORES.some((store) => manifest.directorCounts?.[store] !== director?.[store].length)) problems.push(`manifest 导演台统计与 ${DIRECTOR_STAGE_FILE} 不一致（备份可能不完整）`);
    }
  }
  if (!Array.isArray(manifest.media)) problems.push("manifest.media 缺失");
  for (const key of Object.keys(ID_FIELDS) as (keyof ProjectRecords)[]) {
    const rows = records[key];
    if (!Array.isArray(rows)) { problems.push(`records.${key} 缺失`); continue; }
    const seen = new Set<unknown>();
    for (const row of rows) {
      const id = row?.[ID_FIELDS[key]];
      if (typeof id !== "string" || !id) { problems.push(`records.${key} 中有记录缺少 ${ID_FIELDS[key]}`); break; }
      if (seen.has(id)) { problems.push(`records.${key} 中 ID 重复：${id}`); break; }
      seen.add(id);
    }
  }
  for (const asset of Array.isArray(records.assets) ? records.assets : []) if (typeof asset.storageReference !== "string" || !["image", "video", "audio"].includes(String(asset.kind))) { problems.push(`Asset ${String(asset.assetId)} 缺少 kind 或 storageReference`); break; }
  if (canvas.document !== null && (typeof canvas.document !== "object" || !(canvas.document as { store?: unknown }).store)) problems.push("canvas.json 不是有效的画布快照");
  const media: ParsedBackup["media"] = [];
  const seenMedia = new Set<string>();
  for (const entry of Array.isArray(manifest.media) ? manifest.media : []) {
    if (!["images", "videos", "audios"].includes(entry?.store) || typeof entry.id !== "string" || typeof entry.file !== "string") { problems.push("manifest.media 中有无效条目"); break; }
    const key = `${entry.store}/${entry.id}`;
    if (seenMedia.has(key)) { problems.push(`媒体重复：${key}`); continue; }
    seenMedia.add(key);
    if (!source.has(entry.file)) { problems.push(`缺少媒体文件 ${entry.file}`); continue; }
    const size = source.size(entry.file);
    if (size !== null && size !== entry.size) problems.push(`媒体文件大小不符 ${entry.file}（应为 ${entry.size}，实际 ${size}）`);
    media.push({ entry, source });
  }
  const counted = { images: media.filter((item) => item.entry.store === "images").length, videos: media.filter((item) => item.entry.store === "videos").length, audios: media.filter((item) => item.entry.store === "audios").length };
  if (manifest.counts && (manifest.counts.assets !== records.assets?.length || manifest.counts.runs !== records.runs?.length || manifest.counts.shots !== records.shots?.length || manifest.counts.roles !== records.roles?.length || manifest.counts.images !== counted.images || manifest.counts.videos !== counted.videos || manifest.counts.audios !== counted.audios)) problems.push("manifest 统计与备份内容不一致（备份可能不完整）");
  if (problems.length) throw new BackupValidationError(problems);
  const refs = referenceWarnings(records, seenMedia, canvas.document);
  const refWarnings = manifest.lightweight ? refs.warnings.filter((warning) => !warning.startsWith("missingMedia:")) : refs.warnings;
  const directorWarnings = director ? directorAssetWarnings(director, records) : [DIRECTOR_STAGE_V1_NOTE];
  return { manifest, canvasDocument: canvas.document ?? null, records, director, media, warnings: [...new Set([...(manifest.warnings ?? []), ...refWarnings, ...directorWarnings])] };
}

export const ACTIVE_RUN_RESTORE_NOTE = "状态待确认（备份恢复）：导出时任务仍在排队/生成中，恢复后不会继续执行，也不会重新提交";
/** Queued/running Runs are restored as history, never as live tasks (so Phase 6 recovery will not pick them up). */
export function prepareRestoredRecords(records: ProjectRecords): ProjectRecords {
  const copy = structuredClone(records);
  copy.runs = copy.runs.map((run) => isActive(run) ? { ...run, status: "failed", completedAt: run.completedAt ?? null, error: `${ACTIVE_RUN_RESTORE_NOTE}（原状态：${String(run.status)}）` } : run);
  return copy;
}

export function projectHasContent(current: { records: ProjectRecords; media: Record<MediaStore, Row[]>; director?: DirectorStageData }, canvasDocument: unknown) {
  const directorRows = current.director ? DIRECTOR_STORES.reduce((sum, store) => sum + current.director![store].length, 0) : 0;
  return current.records.assets.length + current.records.runs.length + current.records.shots.length + current.records.roles.length + current.media.images.length + current.media.videos.length + current.media.audios.length + directorRows + canvasShapes(canvasDocument).length > 0;
}

export interface RestoreStep { step: "media" | "records" | "roles" | "director" | "canvas"; ok: boolean; detail: string }
export interface RestoreReport { ok: boolean; steps: RestoreStep[]; rolledBack: string[]; rollbackFailed: string[] }

const mime = (value: unknown) => typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";
async function mediaHash(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Load and compare EVERY media file before making ANY change. Existing IDs are reused, not put. */
async function prepareRestoreMedia(parsed: ParsedBackup, before: Awaited<ReturnType<typeof collectProject>>) {
  const additions: Record<MediaStore, Row[]> = { images: [], videos: [], audios: [] };
  for (const { entry, source } of parsed.media) {
    const blob = await source.readBlob(entry.file);
    if (blob.size !== entry.size) throw new BackupValidationError([`媒体文件大小不符：${entry.file}`]);
    const existing = before.media[entry.store].find((row) => row.id === entry.id);
    if (existing) {
      const original = existing.blob;
      if (!(original instanceof Blob) || original.size !== blob.size || mime(original.type || existing.type || "application/octet-stream") !== mime(entry.type) || await mediaHash(original) !== await mediaHash(blob)) {
        throw new BackupValidationError([`媒体冲突：${entry.store}/${entry.id}（${entry.name}）同 ID 的 hash / size / MIME 不一致；已拒绝恢复，原媒体未修改`]);
      }
      continue;
    }
    additions[entry.store].push({ id: entry.id, blob: blob.type === entry.type ? blob : blob.slice(0, blob.size, entry.type), name: entry.name, type: entry.type, size: blob.size, createdAt: entry.createdAt ?? Date.now() });
  }
  return additions;
}

async function removeAddedMedia(db: IDBDatabase, store: string, rows: Row[]) {
  if (!rows.length) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    for (const row of rows) tx.objectStore(store).delete(row.id as string);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("新增媒体回滚失败"));
    tx.onabort = () => reject(tx.error ?? new Error("新增媒体回滚中止"));
  });
}

/**
 * Overwrite-restore in stages, only after readBackup() succeeded:
 *   1. media  (add new IDs only; identical existing Blobs are reused, conflicts rejected)
 *   2. records (assets/runs/shots/meta in ONE transaction: all or nothing)
 *   3. roles  (one transaction)
 *   4. director (all Director Stage stores in one transaction; skipped for a v1 package)
 *   5. canvas (loadSnapshot)
 * The current records, roles, Director Stage data and canvas are held in memory first; if a later
 * stage fails, earlier metadata stages and the canvas are rolled back, and newly added media
 * is removed. Existing media is never overwritten. Rollback failures are explicitly reported.
 */
export async function restoreProject(parsed: ParsedBackup, canvas: { current: () => unknown; load: (document: unknown) => void }): Promise<RestoreReport> {
  return withProjectRestoreLock(async () => {
  const steps: RestoreStep[] = []; const rolledBack: string[] = []; const rollbackFailed: string[] = [];
  const before = await collectProject();
  const beforeCanvas = canvas.current();
  const additions = await prepareRestoreMedia(parsed, before);
  const restored = prepareRestoredRecords(parsed.records);
  const [mediaDb, audioDb, recordsDb, rolesDb, directorDb] = await Promise.all([openDb("media"), openDb("audio"), openDb("records"), openDb("roles"), openDb("director")]);
  const rollback = async () => {
    const done = new Set(steps.filter((item) => item.ok).map((item) => item.step));
    if (steps.some((step) => step.step === "canvas")) { try { canvas.load(beforeCanvas); rolledBack.push("canvas"); } catch { rollbackFailed.push("canvas"); } }
    if (done.has("director") && parsed.director) { try { await replaceStores(directorDb, before.director); rolledBack.push("director"); } catch { rollbackFailed.push("director"); } }
    if (done.has("roles")) { try { await replaceStores(rolesDb, { roles: before.records.roles }); rolledBack.push("roles"); } catch { rollbackFailed.push("roles"); } }
    if (done.has("records")) { try { await replaceStores(recordsDb, { assets: before.records.assets, runs: before.records.runs, shots: before.records.shots, meta: before.records.meta }); rolledBack.push("records"); } catch { rollbackFailed.push("records"); } }
    if (Object.values(additions).some((rows) => rows.length)) {
      try { await removeAddedMedia(mediaDb, "images", additions.images); await removeAddedMedia(mediaDb, "videos", additions.videos); await removeAddedMedia(audioDb, "audios", additions.audios); rolledBack.push("media"); }
      catch { rollbackFailed.push("media"); }
    }
  };
  const run = async (step: RestoreStep["step"], detail: string, action: () => Promise<void> | void) => {
    try { await action(); steps.push({ step, ok: true, detail }); return true; }
    catch (cause) { steps.push({ step, ok: false, detail: cause instanceof Error ? cause.message : String(cause) }); await rollback(); return false; }
  };
  const ok = await run("media", `${parsed.media.length} 个媒体文件`, async () => {
    await putAll(mediaDb, "images", additions.images);
    await putAll(mediaDb, "videos", additions.videos);
    await putAll(audioDb, "audios", additions.audios);
  })
    && await run("records", `${restored.assets.length} Asset · ${restored.runs.length} Run · ${restored.shots.length} Shot`, () => replaceStores(recordsDb, { assets: restored.assets, runs: restored.runs, shots: restored.shots, meta: restored.meta }))
    && await run("roles", `${restored.roles.length} 个角色`, () => replaceStores(rolesDb, { roles: restored.roles }))
    && await run("director", parsed.director ? `${parsed.director.scenes.length} 场景 · ${parsed.director.props.length} 道具 · ${parsed.director.states.length} 状态 · ${parsed.director.cameras.length} 摄影机 · ${parsed.director.motions.length} 动作 · ${parsed.director.controlPackages.length} 控制素材包` : DIRECTOR_STAGE_V1_NOTE, async () => { if (parsed.director) await replaceStores(directorDb, parsed.director); })
    && await run("canvas", `${canvasShapes(parsed.canvasDocument).length} 个画布节点`, () => { if (parsed.canvasDocument) canvas.load(parsed.canvasDocument); });
  return { ok, steps, rolledBack, rollbackFailed };
  });
}

/** Folder sink for the File System Access API (Chromium). */
export function directorySink(root: FileSystemDirectoryHandle): BackupSink {
  const fileHandle = async (path: string) => {
    const parts = path.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
    return directory.getFileHandle(parts.at(-1)!, { create: true });
  };
  const write = async (path: string, data: Blob | string) => { const writable = await (await fileHandle(path)).createWritable(); await writable.write(data); await writable.close(); };
  return { writeText: write, writeBlob: write };
}

/** Folder source from <input webkitdirectory>: paths are relative to the chosen backup folder. */
export function fileListSource(files: Iterable<File & { webkitRelativePath?: string }>): BackupSource {
  const all = [...files];
  const withPath = all.map((file) => ({ file, path: (file.webkitRelativePath || file.name).replace(/\\/g, "/") }));
  const manifest = withPath.find((item) => item.path.endsWith("manifest.json") && item.path.split("/").length <= 2);
  const prefix = manifest ? manifest.path.slice(0, -"manifest.json".length) : "";
  const map = new Map(withPath.filter((item) => item.path.startsWith(prefix)).map((item) => [item.path.slice(prefix.length), item.file]));
  return {
    has: (path) => map.has(path),
    size: (path) => map.get(path)?.size ?? null,
    readText: async (path) => { const file = map.get(path); if (!file) throw new Error(`缺少 ${path}`); return file.text(); },
    readBlob: async (path) => { const file = map.get(path); if (!file) throw new Error(`缺少 ${path}`); return file; },
  };
}

type CollectedProject = Awaited<ReturnType<typeof collectProject>>;

function walkStrings(value: unknown, out: Set<string>) {
  if (typeof value === "string") { if (value) out.add(value); }
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) walkStrings(item, out);
}

function pageClosure(store: Record<string, Row>, pageId: string) {
  const kept = new Set<string>();
  if (store[pageId]) kept.add(pageId);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, record] of Object.entries(store)) {
      if (kept.has(id)) continue;
      const parent = typeof record.parentId === "string" ? record.parentId : "";
      if (parent && kept.has(parent)) { kept.add(id); grew = true; }
    }
  }
  for (const [id, record] of Object.entries(store)) {
    if (record.typeName !== "binding") continue;
    const from = typeof record.fromId === "string" ? record.fromId : "";
    const to = typeof record.toId === "string" ? record.toId : "";
    if ((from && kept.has(from)) || (to && kept.has(to))) kept.add(id);
  }
  for (const [id, record] of Object.entries(store)) {
    const typeName = record.typeName;
    if (typeName === "document" || typeName === "instance" || typeName === "pointer") kept.add(id);
    if ((typeName === "camera" || typeName === "instance_page_state") && (id.includes(pageId) || record.pageId === pageId)) kept.add(id);
  }
  return kept;
}

export function summarizeCanvasPages(document: unknown) {
  const store = (document as { store?: Record<string, Row> } | null)?.store ?? {};
  return Object.values(store).filter((record) => record.typeName === "page").map((page) => {
    const id = String(page.id);
    const kept = pageClosure(store, id);
    return { id, name: typeof page.name === "string" ? page.name : "", shapes: [...kept].filter((key) => store[key]?.typeName === "shape").length };
  });
}

function referencedRow(row: Row, strings: Set<string>) {
  return (typeof row.id === "string" && strings.has(row.id)) || (typeof row.sceneId === "string" && strings.has(row.sceneId));
}

/** 审片标记（meta 里的一行 review-tags-v1，按视频素材记）：按页导出时只带这一页素材的那几条。 */
const REVIEW_TAGS_KEY = "review-tags-v1";
function pageMeta(meta: Row[], pageId: string, assetIds: ReadonlySet<string>): Row[] {
  const rows = meta.filter((row) => typeof row.key === "string" && row.key.includes(pageId));
  const tags = meta.find((row) => row.key === REVIEW_TAGS_KEY);
  const book = tags?.value;
  if (!book || typeof book !== "object" || Array.isArray(book)) return rows;
  const mine = Object.fromEntries(Object.entries(book as Record<string, { assetId?: unknown }>).filter(([, entry]) => entry && assetIds.has(String(entry.assetId))));
  return Object.keys(mine).length ? [...rows, { ...tags, value: mine }] : rows;
}

/** One page, the records it cites, and the media blobs those records point at. Same backup format as a whole project. */
export function scopeProjectToPage(project: CollectedProject, canvasDocument: unknown, pageId: string) {
  const source = (canvasDocument as { store?: Record<string, Row> } | null) ?? {};
  const store = source.store ?? {};
  const page = store[pageId];
  if (!page || page.typeName !== "page") throw new Error(`页面不存在：${pageId}`);
  const kept = pageClosure(store, pageId);
  const nextStore: Record<string, Row> = {};
  for (const id of kept) nextStore[id] = structuredClone(store[id]);
  for (const record of Object.values(nextStore)) if (record.typeName === "instance") record.currentPageId = pageId;
  const strings = new Set<string>();
  for (const record of Object.values(nextStore)) walkStrings(record, strings);
  const shapeIds = new Set([...kept].filter((id) => store[id]?.typeName === "shape"));
  const assetIds = new Set(project.records.assets.filter((asset) => strings.has(String(asset.assetId)) || strings.has(String(asset.storageReference)) || (Array.isArray(asset.canvasPageIds) && (asset.canvasPageIds as string[]).includes(pageId))).map((asset) => String(asset.assetId)));
  const roles = project.records.roles.filter((role) => strings.has(String(role.roleId)) || (Array.isArray(role.canvasPageIds) && (role.canvasPageIds as string[]).includes(pageId)) || [...(Array.isArray(role.appearanceAssetIds) ? role.appearanceAssetIds : []), ...(Array.isArray(role.voiceAssetIds) ? role.voiceAssetIds : [])].some((id) => assetIds.has(String(id))));
  for (const role of roles) for (const id of [...(Array.isArray(role.appearanceAssetIds) ? role.appearanceAssetIds : []), ...(Array.isArray(role.voiceAssetIds) ? role.voiceAssetIds : [])]) assetIds.add(String(id));
  const assets = project.records.assets.filter((asset) => assetIds.has(String(asset.assetId)));
  const runs = project.records.runs.filter((run) => strings.has(String(run.runId)) || shapeIds.has(String(run.ownerNodeId ?? "")) || run.canvasPageId === pageId || assets.some((asset) => asset.sourceRunId === run.runId) || (Array.isArray(run.outputAssetIds) && (run.outputAssetIds as string[]).some((id) => assetIds.has(id))) || (Array.isArray(run.inputAssetIds) && (run.inputAssetIds as string[]).some((id) => assetIds.has(id))));
  const shots = project.records.shots.filter((shot) => strings.has(String(shot.shotId)) || runs.some((run) => run.shotId === shot.shotId) || assets.some((asset) => asset.shotId === shot.shotId));
  for (const shot of shots) walkStrings(shot, strings);
  const mediaIds = new Set<string>();
  for (const asset of assets) if (typeof asset.storageReference === "string") mediaIds.add(asset.storageReference);
  for (const value of strings) if (value.startsWith("image:") || value.startsWith("media:") || value.startsWith("audio:")) mediaIds.add(value);
  const take = (rows: Row[], prefix: string) => rows.filter((row) => mediaIds.has(`${prefix}${String(row.id)}`));
  const director = Object.fromEntries(DIRECTOR_STORES.map((storeName) => [storeName, project.director[storeName].filter((row) => referencedRow(row, strings))])) as DirectorStageData;
  const pageName = typeof page.name === "string" ? page.name : pageId;
  return {
    project: { media: { images: take(project.media.images, "image:"), videos: take(project.media.videos, "media:"), audios: take(project.media.audios, "audio:") }, records: { assets, runs, shots, meta: pageMeta(project.records.meta, pageId, assetIds), roles }, director },
    document: { ...structuredClone(source), store: nextStore },
    pageName,
    counts: { shapes: shapeIds.size, assets: assets.length, images: take(project.media.images, "image:").length, videos: take(project.media.videos, "media:").length, audios: take(project.media.audios, "audio:").length, roles: roles.length, runs: runs.length },
  };
}

export async function exportPageProject(canvasDocument: unknown, sink: BackupSink, options: { appVersion: string; persistenceKey: string; pageId: string; now?: number; onProgress?: (done: number, total: number, bytes: number) => void; project?: CollectedProject; linkMedia?: (file: string) => Promise<void> }) {
  const scoped = scopeProjectToPage(options.project ?? await collectProject(), canvasDocument, options.pageId);
  if (options.linkMedia) {
    const entries: MediaEntry[] = [];
    let done = 0;
    const rows = (["images", "videos", "audios"] as MediaStore[]).flatMap((store) => scoped.project.media[store].map((row) => ({ store, row })));
    options.onProgress?.(0, rows.length, 0);
    for (const { store, row } of rows) {
      const file = typeof row.file === "string" ? row.file : mediaEntry(store, row, null).file;
      const entry = mediaEntry(store, row, null);
      entry.file = file;
      if (typeof row.size === "number") entry.size = row.size;
      await options.linkMedia(entry.file);
      entries.push(entry);
      done += 1;
      options.onProgress?.(done, rows.length, entries.reduce((sum, item) => sum + item.size, 0));
    }
    const manifest = await finalizeBackup(scoped.project, scoped.document, sink, options, entries, [`page:${scoped.pageName} (${options.pageId})`, `pageShapes:${scoped.counts.shapes}`]);
    await sink.writeText("_counts.json", JSON.stringify({ pageId: options.pageId, pageName: scoped.pageName, ...scoped.counts }));
    return { manifest, counts: scoped.counts, pageName: scoped.pageName };
  }
  const manifest = await writeBackup(scoped.project, scoped.document, sink, options, [`page:${scoped.pageName} (${options.pageId})`, `pageShapes:${scoped.counts.shapes}`]);
  await sink.writeText("_counts.json", JSON.stringify({ pageId: options.pageId, pageName: scoped.pageName, ...scoped.counts }));
  return { manifest, counts: scoped.counts, pageName: scoped.pageName };
}

function addMissing(db: IDBDatabase, store: string, rows: Row[], idField: string) {
  if (!rows.length) return Promise.resolve(0);
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const target = tx.objectStore(store);
    let added = 0;
    let index = 0;
    const step = () => {
      if (index >= rows.length) return;
      const row = rows[index++];
      const request = target.get(String(row[idField]));
      request.onsuccess = () => { if (!request.result) { added += 1; target.add(row); } step(); };
      request.onerror = () => reject(request.error ?? new Error("读取失败"));
    };
    step();
    tx.oncomplete = () => resolve(added);
    tx.onerror = () => reject(tx.error ?? new Error("写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("写入已中止"));
  });
}

/** 合并页面包：本机已有审片标记时，只补上没有的那几条视频，已有的不动。 */
function mergeReviewTags(db: IDBDatabase, incoming: Row | undefined) {
  const book = incoming?.value;
  if (!book || typeof book !== "object" || Array.isArray(book)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    const target = tx.objectStore("meta");
    const request = target.get(REVIEW_TAGS_KEY);
    request.onsuccess = () => {
      const current = request.result?.value;
      const base = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {};
      const added = Object.entries(book as Record<string, unknown>).filter(([key]) => !(key in base));
      if (added.length) target.put({ key: REVIEW_TAGS_KEY, value: { ...base, ...Object.fromEntries(added) } });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("写入已中止"));
  });
}

function mergeCanvasDocuments(current: unknown, incoming: unknown) {
  const left = current as { store?: Record<string, Row> } | null;
  const right = incoming as { store?: Record<string, Row> } | null;
  if (!right?.store) return current;
  if (!left?.store) return incoming;
  const store = { ...left.store };
  for (const [id, record] of Object.entries(right.store)) if (!store[id]) store[id] = record;
  return { ...left, store };
}

/** Add a page pack. Existing ids are kept as they are. Nothing is deleted. */
export async function mergePagePack(parsed: ParsedBackup, canvas: { current: () => unknown; load: (document: unknown) => void }) {
  return withProjectRestoreLock(async () => {
    const before = await collectProject();
    const additions = await prepareRestoreMedia(parsed, before);
    const restored = prepareRestoredRecords(parsed.records);
    const missing = {
      assets: restored.assets.filter((row) => !before.records.assets.some((item) => item.assetId === row.assetId)),
      runs: restored.runs.filter((row) => !before.records.runs.some((item) => item.runId === row.runId)),
      shots: restored.shots.filter((row) => !before.records.shots.some((item) => item.shotId === row.shotId)),
      meta: restored.meta.filter((row) => !before.records.meta.some((item) => item.key === row.key)),
      roles: restored.roles.filter((row) => !before.records.roles.some((item) => item.roleId === row.roleId)),
    };
    const [mediaDb, audioDb, recordsDb, rolesDb, directorDb] = await Promise.all([openDb("media"), openDb("audio"), openDb("records"), openDb("roles"), openDb("director")]);
    try {
      await putAll(mediaDb, "images", additions.images);
      await putAll(mediaDb, "videos", additions.videos);
      await putAll(audioDb, "audios", additions.audios);
      await addMissing(recordsDb, "assets", missing.assets, "assetId");
      await addMissing(recordsDb, "runs", missing.runs, "runId");
      await addMissing(recordsDb, "shots", missing.shots, "shotId");
      await addMissing(recordsDb, "meta", missing.meta, "key");
      await mergeReviewTags(recordsDb, restored.meta.find((row) => row.key === REVIEW_TAGS_KEY));
      await addMissing(rolesDb, "roles", missing.roles, "roleId");
      if (parsed.director) for (const storeName of DIRECTOR_STORES) {
        const existing = new Set(before.director[storeName].map((row) => String(row.id)));
        await addMissing(directorDb, storeName, parsed.director[storeName].filter((row) => !existing.has(String(row.id))), "id");
      }
      const current = canvas.current();
      const empty = canvasShapes(current).length === 0 && before.records.assets.length === 0 && before.records.roles.length === 0;
      if (parsed.canvasDocument) canvas.load(empty ? parsed.canvasDocument : mergeCanvasDocuments(current, parsed.canvasDocument));
      return { ok: true as const, empty, addedAssets: missing.assets.length, addedRoles: missing.roles.length, media: additions.images.length + additions.videos.length + additions.audios.length };
    } finally {
      mediaDb.close(); audioDb.close(); recordsDb.close(); rolesDb.close(); directorDb.close();
    }
  });
}
