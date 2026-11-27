import type { ReferenceManifest } from "./reference-manifest.ts";
import { withProjectMediaWrite } from "./project-media-lock.ts";
import { openLocalDatabase } from "./local-database-open.ts";
import {idbDeadline,armIdbRead} from './operation-scope.ts';
import type { H3PromptMode } from "./h3-prompt-compiler.ts";
import type { H3TaskMode } from "./h3-task-mode.ts";
import type { EngineInfo } from "./comfyui/engine-info.ts";
import { normalizeAssetFilename } from "./asset-name.ts";
import { belongsToCanvas, canvasLibraryReady, currentLibraryScope } from "./canvas-library-scope.ts";

/** Metadata only. Media bytes remain in frameflow-local-media. */
const DATABASE_NAME = "frameflow-production-records";
const ASSETS = "assets";
const RUNS = "runs";
const SHOTS = "shots";
const META = "meta";

export type AssetKind = "image" | "video" | "audio";
export type AssetOrigin = "imported" | "generated" | "unknown";
export type CapabilityId = "h3_fl2va" | "h3_ref2va" | "h3_addguide_experimental" | "h3_ultimate_guide" | "seedvr2_upscale" | "film_interpolation" | "final_cut_rough" | "cover_generation" | "music_removal";
/** H3 generation capabilities (Shot candidates, adoption, lineage). `h3_addguide_experimental` = 🧪 I2VA + AddGuide anchors. */
export const H3_CAPABILITY_IDS: readonly CapabilityId[] = ["h3_fl2va", "h3_ref2va", "h3_addguide_experimental", "h3_ultimate_guide"];
export const isH3Capability = (capabilityId: string | null | undefined): boolean => (H3_CAPABILITY_IDS as readonly string[]).includes(capabilityId ?? "");
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AssetRecord {
  recycled?: { at: number; receiptId: string; mode: string };
  canvasPageIds?: string[];
  canvasFilenames?: Record<string, string>;
  schemaVersion: 1;
  assetId: string;
  kind: AssetKind;
  origin: AssetOrigin;
  filename: string;
  mimeType: string;
  createdAt: number;
  storageReference: string;
  sourceRunId: string | null;
  shotId?: string;
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  fileSize?: number;
  imageIntegrity?: import("./image-integrity.ts").ImageProof;
  enhancementPromptId?: string;
  /** Optional derivation metadata; older Asset V1 records remain valid. */
  derivationType?: "audio_extract" | "audio_clip" | "final_cut_rough" | "music_removal";
  /** Phase 19 rough cut: the Final Cut List it was rendered from, its items and their source Assets (in cut order). */
  sourceSequenceId?: string;
  sourceItemIds?: string[];
  sourceAssetIds?: string[];
  sourceVideoAssetId?: string;
  /** 去配乐 versions: how many CDX23 passes the file went through since the original (absent = 1). */
  musicRemovalPasses?: number;
  sourceAudioAssetId?: string;
  sourceStartTime?: number;
  sourceEndTime?: number;
}

export interface RunRecord {
  /** Local time when a positive acceptance receipt was first observed, not the reservation time. */
  acceptedAt?:number;
  /** Evidence only; immutable generation parameters and submitted graphs are never rewritten. */
  preparationNotSent?: {checkedAt:string;promptId:string;workflowCaptureAbsent:true;historyState?:"not_found"};
  canvasPageId?: string;
  submissionSnapshot?: import("./locked-generation.ts").SubmittedWorkflow;
  executionTiming?: import("./execution-timing.ts").ExecutionTiming;
  schemaVersion: 1;
  runId: string;
  shotId?: string;
  capabilityId: CapabilityId;
  status: RunStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  comfyPromptId: string | null;
  inputAssetIds: string[];
  outputAssetIds: string[];
  rawPrompt: string | null;
  finalPrompt: string | null;
  seed: number | null;
  parameters: Record<string, unknown>;
  workflowIdentity: { capabilityId: CapabilityId; templateVersion: string; templateFile: string };
  error: string | null;
  /** Submission order, not a Role / Speaker manifest. */
  referenceInputs?: { assetId: string; kind: AssetKind; role: string; order: number; withAudio?: boolean }[];
  /** Ref2VA runs from Phase 5 on: frozen Reference Manifest (actual Picture/Video/Audio order, Subject and Speaker bindings). Older runs have none. */
  referenceManifest?: ReferenceManifest;
  promptMode?: H3PromptMode;
  promptCompile?: { compilerVersion: string; notes: string[] };
  /** Phase 6: canvas node that submitted this Run, so a refreshed page can re-attach to it. */
  ownerNodeId?: string;
  /** Phase 6: "reserved" = comfyPromptId was written before /prompt; "accepted" = ComfyUI confirmed it. Absent on older Runs. */
  submission?: "reserved" | "accepted";
  /** H3 task mode as resolved at submission (T2VA shares capability h3_fl2va and its model). Absent on older Runs. */
  taskMode?: H3TaskMode;
  /** ComfyUI / node versions read right before submission. Absent on older Runs or when ComfyUI was unreachable. */
  engine?: EngineInfo;
  /** Director Stage hand-off this Run came from (H3 node created by 导演台 → 发送到 H3). Absent otherwise. */
  directorContext?: DirectorRunContext;
  /** 正本 %FRAMEFLOW_H3_TOOLS%\SKILL_h3-video.md 开头「正本 v…」的版本号：入队时读（队列节点），没有就在提交时读；读不到记「未知」。旧 Run 没有。 */
  zhengbenVersion?: string;
  /** 去配乐 Runs only: what the Frameflow-Demix node reported (device actually used, seconds, done / skipped). */
  musicRemoval?: MusicRemovalRunResult;
}

export interface MusicRemovalRunResult {
  /** running = passes still going (written before each pass is sent, so a refresh can look it up). */
  status: "done" | "skipped" | "running";
  /** As the node reported it, e.g. "cuda（可用 14.8 GB）" or "cpu". */
  device?: string;
  seconds?: number;
  /** ComfyUI output file (output/video/...). */
  output?: string;
  reason?: string;
  /** The CDX23 pass this Run did (one per Run; 「再去一次」 = pass 2 with the 1-pass version as input). Absent on older Runs. */
  passes?: MusicRemovalPass[];
  /** Passes since the original after this Run (1, or 2 after 「再去一次」). */
  totalPasses?: number;
}
export interface MusicRemovalPass {
  /** 1 = from the original; 2 = 「再去一次」 on a 1-pass version. */
  pass: number;
  promptId: string;
  /** Input file name and asset (pass 1: the original; pass 2: the 1-pass 去配乐版). */
  input: string;
  inputAssetId?: string;
  /** ComfyUI output file (output/video/...). */
  output?: string;
  outputFile?: { filename: string; subfolder?: string; type?: string };
  device?: string;
  seconds?: number;
  startedAt?: number;
  completedAt?: number;
}

/** IDs only (Director Stage records live in their own database); no media or Shot data. */
export interface DirectorRunContext {
  sceneId: string;
  sceneStateId: string | null;
  controlPackageIds: string[];
  /** Asset IDs the hand-off connected to the H3 node. */
  handoffAssetIds: string[];
  /** False when the node's inputs were changed after the hand-off (the Run still records where it started). */
  inputsMatchHandoff: boolean;
  /** 🧪 AddGuide: guide Control Packages and their anchor frames, in submission (frame) order. Empty / absent otherwise. */
  guidePackageIds?: string[];
  anchorFrames?: number[];
  /** Shot System V0.1: the Camera / Motions bound to the Director Shot this Run was generated for (planning record only; H3 does not use them). */
  cameraId?: string | null;
  motionIds?: string[];
}

/**
 * Shot System V0.1 — the Director Stage side of a Shot (optional; Shots created on the canvas have none).
 * IDs only: Scene / State / Camera / Motion / Control Packages live in the Director Stage database.
 * The H3 Runs and candidate videos stay on the Shot exactly as before (runIds / adoptedAssetId).
 */
export interface ShotDirectorBinding {
  sceneId: string;
  sceneStateId: string | null;
  cameraId: string | null;
  motionIds: string[];
  firstFramePackageId: string | null;
  lastFramePackageId: string | null;
  referencePackageId: string | null;
  /** 🧪 AddGuide anchor packages. */
  guidePackageIds: string[];
}

export interface ShotRecord {
  /** Recoverable candidate deletion. Media and immutable Run history remain intact. */
  deletedCandidateAssetIds?: string[];
  schemaVersion: 1;
  shotId: string;
  shotNumber: number;
  title: string;
  /** Canvas owner hint only; Shot identity and lifetime do not depend on this node. */
  sourceH3NodeId?: string;
  createdAt: number;
  updatedAt: number;
  runIds: string[];
  adoptedRunId: string | null;
  adoptedAssetId: string | null;
  /** When the adoption was last chosen (ms). Lets the shot cards follow the most recent choice across nodes. Absent on older records. */
  adoptedAt?: number;
  status: "draft" | "has_candidates" | "adopted";
  /** Shot System V0.1: set for Shots planned in 导演台 (absent for canvas-created Shots). */
  director?: ShotDirectorBinding;
}

let databasePromise: Promise<IDBDatabase> | null = null;
function openDatabase() {
  if (!databasePromise) {
    const pending = openLocalDatabase(DATABASE_NAME, 2, (request) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ASSETS)) {
        const store = db.createObjectStore(ASSETS, { keyPath: "assetId" });
        store.createIndex("storageReference", "storageReference", { unique: true });
      }
      if (!db.objectStoreNames.contains(RUNS)) db.createObjectStore(RUNS, { keyPath: "runId" });
      if (!db.objectStoreNames.contains(SHOTS)) db.createObjectStore(SHOTS, { keyPath: "shotId" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
    }, () => { if (databasePromise === pending) databasePromise = null; }, "无法打开生成记录存储");
    databasePromise = pending;
  }
  return databasePromise;
}

async function read<T>(storeName: string, key: IDBValidKey, index?: string): Promise<T | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const store = db.transaction(storeName, "readonly").objectStore(storeName);
    const request = index ? store.index(index).get(key) : store.get(key);
    armIdbRead(request,reject);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("生成记录读取失败"));
  });
}

async function write(storeName: string, value: AssetRecord | RunRecord | ShotRecord,signal?:AbortSignal) {
  signal?.throwIfAborted();
  const db = await openDatabase();
  await withProjectMediaWrite(() => {
    signal?.throwIfAborted();
    const tx = db.transaction(storeName, "readwrite");
    return idbDeadline<void>(tx,(resolve,reject)=>{
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("生成记录保存失败"));
    tx.onabort = () => reject(tx.error ?? new Error("生成记录保存已中止"));
    },15000,signal);
  });
}

function canvasAsset(asset: AssetRecord, pageId = currentLibraryScope()?.pageId): AssetRecord {
  return pageId && asset.canvasFilenames?.[pageId] ? { ...asset, filename: asset.canvasFilenames[pageId] } : asset;
}
export const getAsset = async (assetId: string) => { const asset = await read<AssetRecord>(ASSETS, assetId); return asset && !asset.recycled ? canvasAsset(asset) : null; };

/** Change the display name only. Identity, storage, and media bytes stay put. */
export async function renameAsset(assetId: string, filename: string): Promise<AssetRecord> {
  const scope = currentLibraryScope();
  await canvasLibraryReady();
  const asset = await read<AssetRecord>(ASSETS, assetId);
  if (!asset) throw new Error("素材不存在");
  if (!belongsToCanvas(asset, scope, asset.assetId, asset.storageReference)) throw Error('该素材不属于当前画布');
  const name = normalizeAssetFilename(filename);
  const next: AssetRecord = scope ? { ...asset, canvasFilenames: { ...asset.canvasFilenames, [scope.pageId]: name } } : { ...asset, filename: name };
  await write(ASSETS, next);
  return canvasAsset(next, scope?.pageId);
}
export const getAssetBySource = (source: string) => read<AssetRecord>(ASSETS, source, "storageReference");
export const getRun = (runId: string) => read<RunRecord>(RUNS, runId);
export const getShot = (shotId: string) => read<ShotRecord>(SHOTS, shotId);

/**
 * Keyed project state kept in the existing "meta" store (same database, same version, no schema
 * change): Shot Board, H3 presets, error log. Included in Phase 8 backups automatically.
 */
export async function getMeta<T>(key: string): Promise<T | null> {
  const row = await read<{ key: string; value: T }>(META, key);
  return row ? row.value : null;
}
export async function putMeta<T>(key: string, value: T,signal?:AbortSignal) {
  if (key === "nextShotNumber") throw new Error("nextShotNumber 由镜头编号逻辑维护，不能直接写入");
  await write(META, { key, value: structuredClone(value) } as unknown as ShotRecord,signal);
}

/** Both page-slot and file-session rows commit together; no whole stale snapshot write. */
export async function mutateSessionRows<T>(pageKey:string,fileKey:string,mutate:(current:T|null,file:T|null)=>{page?:T;file:T},signal?:AbortSignal):Promise<T>{
  return withProjectMediaWrite(async()=>{
    signal?.throwIfAborted();const db=await openDatabase();signal?.throwIfAborted();
    const tx=db.transaction(META,'readwrite');
    return idbDeadline<T>(tx,(resolve,reject)=>{
      const store=tx.objectStore(META),pageRead=store.get(pageKey),fileRead=store.get(fileKey);let remaining=2,value:T;
      const ready=()=>{if(--remaining)return;try{signal?.throwIfAborted();const next=mutate(pageRead.result?.value??null,fileRead.result?.value??null);value=next.file;if(next.page!==undefined)store.put({key:pageKey,value:next.page});store.put({key:fileKey,value:next.file});}catch(error){tx.abort();reject(error);}};
      pageRead.onsuccess=fileRead.onsuccess=ready;
      tx.oncomplete=()=>resolve(value);tx.onerror=tx.onabort=()=>reject(tx.error??Error('会话事务已中止'));
    },15000,signal);
  });
}

/** Patch the latest row in one transaction; background stop flags must not overwrite fresh receipts. */
export async function patchMeta<T>(key:string,patch:(value:T|null)=>T|null,signal?:AbortSignal):Promise<T|null>{
  if(key==='nextShotNumber')throw Error('不能通过patchMeta修改镜头编号');
  return withProjectMediaWrite(async()=>{
    signal?.throwIfAborted();
    const db=await openDatabase();
    signal?.throwIfAborted();
    const transaction=db.transaction(META,'readwrite'),store=transaction.objectStore(META);
    return idbDeadline<T|null>(transaction,(resolve,reject)=>{
      let value:T|null=null;
      const request=store.get(key);
      request.onsuccess=()=>{try{const prior=request.result as {key:string;value:T}|undefined;signal?.throwIfAborted();value=patch(prior?.value??null);if(value!==null)store.put({key,value:structuredClone(value)});}catch(error){transaction.abort();reject(error);}};
      transaction.oncomplete=()=>resolve(value);transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error??Error('元数据更新已中止'));
    },15000,signal);
  });
}

export const RUN_CHANGE_CHANNEL = "frameflow-run-changes";
let runChannel: BroadcastChannel | null | undefined;
/** Tells every tab (including this one's other listeners) that a Run changed. Best effort only. */
function announceRunChange(runId: string) {
  try {
    if (runChannel === undefined) {
      runChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(RUN_CHANGE_CHANNEL);
      (runChannel as unknown as { unref?: () => void } | null)?.unref?.();
    }
    runChannel?.postMessage({ runId });
  } catch { /* notification only */ }
}

/** Read-only Run listing for refresh recovery; does not change the stored schema. */
export async function listRuns(): Promise<RunRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(RUNS, "readonly").objectStore(RUNS).getAll();
    armIdbRead(request,reject);
    request.onsuccess = () => resolve(request.result as RunRecord[]);
    request.onerror = () => reject(request.error ?? new Error("生成记录读取失败"));
  });
}

/** Read-only Shot listing (Asset Library adopted/candidate labels, project backup). */
export async function listShots(): Promise<ShotRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(SHOTS, "readonly").objectStore(SHOTS).getAll();
    armIdbRead(request,reject);
    request.onsuccess = () => resolve(request.result as ShotRecord[]);
    request.onerror = () => reject(request.error ?? new Error("镜头记录读取失败"));
  });
}

/** Read-only project asset catalogue; does not change the frozen record schema. */
export async function listAllAssets(kind?: AssetKind): Promise<AssetRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(ASSETS, "readonly").objectStore(ASSETS).getAll();
    armIdbRead(request,reject);
    request.onsuccess = () => resolve((request.result as AssetRecord[]).filter((asset) => !kind || asset.kind === kind).sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error ?? new Error("素材列表读取失败"));
  });
}

export async function listAssets(kind?: AssetKind): Promise<AssetRecord[]> {
  const scope = currentLibraryScope();
  await canvasLibraryReady();
  return (await listAllAssets(kind)).filter(asset => !asset.recycled && belongsToCanvas(asset, scope, asset.assetId, asset.storageReference)).map(asset => canvasAsset(asset, scope?.pageId));
}

/** IndexedDB getAll can surface a null hole. It has no key and is not a session. Skip it; do not delete the row. */
export function readableMetaRows(rows: readonly unknown[] | null | undefined): {key: string; value: unknown}[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is {key: string; value: unknown} => !!row && typeof row === "object" && typeof (row as {key?: unknown}).key === "string");
}

/** Metadata-only cleanup audit; includes all pages, not just the visible library. */
export async function listCleanupMetadata(): Promise<{key: string; value: unknown}[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(META, 'readonly').objectStore(META).getAll();
    armIdbRead(request,reject);
    request.onsuccess = () => resolve(readableMetaRows(request.result));
    request.onerror = () => reject(request.error ?? Error('无法读取引用，禁止清理'));
  });
}
/** Caller must hold the exclusive project restore lock, after a real recycle receipt. */
export async function markAssetRecycled(asset: AssetRecord, receipt: {receiptId: string; mode: string}) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([ASSETS, SHOTS], 'readwrite');
    tx.objectStore(ASSETS).put({...asset, recycled:{...receipt, at:Date.now()}});
    const request = tx.objectStore(SHOTS).getAll();
    armIdbRead(request,reject);
    request.onsuccess = () => {
      for (const shot of request.result as ShotRecord[]) {
        if (shot.shotId !== asset.shotId) continue;
        // Preserve Run/Shot provenance; removed bytes cannot be adopted as a live candidate.
        tx.objectStore(SHOTS).put({...shot, deletedCandidateAssetIds:[...new Set([...(shot.deletedCandidateAssetIds ?? []), asset.assetId])]});
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? Error('回收记录保存失败，请保留回收站文件'));
    tx.onabort = () => reject(tx.error ?? Error('回收记录保存中止'));
  });
}

/** Adds catalogue ownership without changing identity, media or generation history. */
export async function assignAssetToCanvases(assetId: string, pageIds: string[], replace = false) {
  const db = await openDatabase();
  await withProjectMediaWrite(() => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ASSETS, 'readwrite'), store = tx.objectStore(ASSETS), request = store.get(assetId);
    request.onsuccess = () => { if (request.result) { const asset = request.result as AssetRecord; store.put({ ...asset, canvasPageIds: [...new Set([...(replace ? [] : asset.canvasPageIds ?? []), ...pageIds])] }); } };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? Error('素材画布归属保存失败'));
  }));
}

export async function createShot(title = "", sourceH3NodeId?: string, director?: ShotDirectorBinding,signal?:AbortSignal) {
  const db = await openDatabase();
  return withProjectMediaWrite(() => {
    signal?.throwIfAborted();
    const tx = db.transaction([SHOTS, META], "readwrite");
    return idbDeadline<ShotRecord>(tx,(resolve, reject) => {
    // The counter and record must commit together, including across open tabs.
    const request = tx.objectStore(META).get("nextShotNumber");
    armIdbRead(request,reject);
    let shot: ShotRecord;
    request.onsuccess = () => {
      signal?.throwIfAborted();const number = Number(request.result?.value ?? 1);
      const now = Date.now();
      shot = { schemaVersion: 1, shotId: crypto.randomUUID(), shotNumber: number, title: title || `镜头 ${String(number).padStart(2, "0")}`, sourceH3NodeId, createdAt: now, updatedAt: now, runIds: [], adoptedRunId: null, adoptedAssetId: null, status: "draft", ...(director ? { director: structuredClone(director) } : {}) };
      tx.objectStore(META).put({ key: "nextShotNumber", value: number + 1 });
      tx.objectStore(SHOTS).put(shot);
    };
    tx.oncomplete = () => resolve(shot);
    tx.onerror = () => reject(tx.error ?? new Error("镜头保存失败"));
    tx.onabort = () => reject(tx.error ?? new Error("镜头保存已中止"));
  },15000,signal);});
}

async function updateShot(shotId: string, change: (shot: ShotRecord) => ShotRecord) {
  const db = await openDatabase();
  return withProjectMediaWrite(() => new Promise<ShotRecord>((resolve, reject) => {
    const tx = db.transaction(SHOTS, "readwrite");
    const store = tx.objectStore(SHOTS);
    const request = store.get(shotId);
    armIdbRead(request,reject);
    let next: ShotRecord;
    request.onsuccess = () => {
      if (!request.result) { tx.abort(); return; }
      next = change(request.result as ShotRecord);
      next.updatedAt = Date.now();
      store.put(next);
    };
    tx.oncomplete = () => resolve(next);
    tx.onerror = () => reject(tx.error ?? new Error("镜头更新失败"));
    tx.onabort = () => reject(tx.error ?? new Error("镜头记录不存在或更新已中止"));
  }));
}

/** Shot System V0.1: change the 导演台 binding (and optionally the title) of a Shot; Runs / candidates are untouched. */
export function updateShotDirector(shotId: string, director: ShotDirectorBinding, title?: string) {
  return updateShot(shotId, (shot) => ({ ...shot, ...(title?.trim() ? { title: title.trim() } : {}), director: structuredClone(director) }));
}

/** Shot System V0.1: the H3 node that now generates this Shot (its Runs then attach here through the normal H3 flow). */
export function linkShotToH3Node(shotId: string, nodeId: string) {
  return updateShot(shotId, (shot) => ({ ...shot, sourceH3NodeId: nodeId }));
}

export function addRunToShot(shotId: string, runId: string) {
  return updateShot(shotId, (shot) => ({ ...shot, runIds: shot.runIds.includes(runId) ? shot.runIds : [...shot.runIds, runId] }));
}

export function markShotHasCandidates(shotId: string) {
  return updateShot(shotId, (shot) => ({ ...shot, status: shot.adoptedAssetId ? "adopted" : "has_candidates" }));
}

export async function adoptShotAsset(shotId: string, assetId: string) {
  const asset = await getAsset(assetId);
  if (!asset || asset.kind !== "video" || asset.shotId !== shotId || !asset.sourceRunId) throw new Error("该视频不属于此镜头，无法采用");
  const run = await getRun(asset.sourceRunId);
  if (!run || run.status !== "completed" || !run.outputAssetIds.includes(assetId)) throw new Error("视频尚未成功生成，无法采用");
  return updateShot(shotId, (shot) => {
    if (shot.deletedCandidateAssetIds?.includes(assetId)) throw new Error("请先恢复已删除候选，再采用");
    return { ...shot, adoptedRunId: run.runId, adoptedAssetId: assetId, adoptedAt: Date.now(), status: "adopted" };
  });
}

export async function deleteShotCandidate(shotId: string, assetId: string) {
  const asset = await getAsset(assetId);
  if (!asset || asset.kind !== 'video' || asset.shotId !== shotId || !asset.sourceRunId) throw new Error('该视频不属于此镜头');
  const run = await getRun(asset.sourceRunId);
  if (!run || run.status !== 'completed' || !run.outputAssetIds.includes(assetId)) throw new Error('只能删除已完成的视频候选');
  return updateShot(shotId, shot => {
    if (shot.adoptedAssetId === assetId) throw new Error('这是已采用的视频，请先采用其他候选再删除');
    if (!shot.runIds.includes(run.runId)) throw new Error('该生成任务不属于此镜头');
    return {...shot, deletedCandidateAssetIds: [...new Set([...(shot.deletedCandidateAssetIds ?? []), assetId])]};
  });
}

export function restoreShotCandidate(shotId: string, assetId: string) {
  return updateShot(shotId, shot => ({...shot, deletedCandidateAssetIds: (shot.deletedCandidateAssetIds ?? []).filter(id => id !== assetId)}));
}

export interface ShotCandidate { label: string; run: RunRecord; asset: AssetRecord }
function candidateLabel(index: number) {
  let value = index + 1;
  let label = "";
  while (value > 0) { value--; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26); }
  return label;
}
export async function getShotCandidates(shotId: string, includeDeleted = false): Promise<ShotCandidate[]> {
  const shot = await getShot(shotId);
  if (!shot) return [];
  const runs = await Promise.all(shot.runIds.map(getRun));
  const successful = runs.filter((run): run is RunRecord => Boolean(run && run.status === "completed" && isH3Capability(run.capabilityId) && run.outputAssetIds.length));
  const assets = await Promise.all(successful.map((run) => getAsset(run.outputAssetIds[0])));
  return successful.flatMap((run, index) => assets[index] && (includeDeleted || !shot.deletedCandidateAssetIds?.includes(assets[index]!.assetId)) ? [{ label: candidateLabel(index), run, asset: assets[index]! }] : []);
}

export async function getShotAssetVersions(shotId: string, includeDeleted = false) {
  const shot = await getShot(shotId);
  if (!shot) return [];
  const runs = await Promise.all(shot.runIds.map(getRun));
  const completed = runs.filter((run): run is RunRecord => Boolean(run && run.status === "completed"));
  const assets = await Promise.all(completed.flatMap((run) => run.outputAssetIds.map(getAsset)));
  return assets.filter((asset): asset is AssetRecord => Boolean(asset && asset.kind === "video" && asset.shotId === shotId && (includeDeleted || !shot.deletedCandidateAssetIds?.includes(asset.assetId))));
}

export async function getRootCandidateLabel(shotId: string, assetId: string): Promise<string | null> {
  const candidates = await getShotCandidates(shotId, true);
  let current = await getAsset(assetId);
  const seen = new Set<string>();
  while (current && !seen.has(current.assetId)) {
    seen.add(current.assetId);
    const candidate = candidates.find((item) => item.asset.assetId === current?.assetId);
    if (candidate) return candidate.label;
    const run = current.sourceRunId ? await getRun(current.sourceRunId) : null;
    current = run?.inputAssetIds[0] ? await getAsset(run.inputAssetIds[0]) : null;
  }
  return null;
}

export async function getShotAssetLineage(shotId: string, assetId: string): Promise<string | null> {
  const label = await getRootCandidateLabel(shotId, assetId);
  if (!label) return null;
  const stages: string[] = [];
  let asset = await getAsset(assetId);
  const seen = new Set<string>();
  while (asset && !seen.has(asset.assetId)) {
    seen.add(asset.assetId);
    const run = asset.sourceRunId ? await getRun(asset.sourceRunId) : null;
    if (!run || isH3Capability(run.capabilityId)) break;
    if (run.capabilityId === "music_removal") {
      // 去配乐 then 「再去一次」 read as one stage: 去配乐 ×2.
      const passes = 1;
      const match = /^去配乐(?: ×(\d+))?$/.exec(stages[0] ?? "");
      const total = passes + (match ? Number(match[1] ?? 1) : 0);
      if (match) stages.shift();
      stages.unshift(total > 1 ? `去配乐 ×${total}` : "去配乐");
    } else stages.unshift(run.capabilityId === "seedvr2_upscale" ? "高清增强" : "流畅增强");
    asset = run.inputAssetIds[0] ? await getAsset(run.inputAssetIds[0]) : null;
  }
  return [`候选${label}`, ...stages].join(" → ");
}

/** One-time association for reliable Phase 1 H3 output; media bytes are untouched. */
export async function attachCompletedRunToShot(shotId: string, runId: string) {
  const attached = await withProjectMediaWrite(async () => {
    const db = await openDatabase();
    const tx = db.transaction([RUNS, ASSETS, SHOTS], "readwrite");
    return idbDeadline<boolean>(tx, (resolve, reject) => {
      const runStore = tx.objectStore(RUNS);
      const assetStore = tx.objectStore(ASSETS);
      const shotStore = tx.objectStore(SHOTS);
      let committed = false;
      const runReq = runStore.get(runId);
      const shotReq = shotStore.get(shotId);
      armIdbRead(runReq, reject);
      armIdbRead(shotReq, reject);
      let loaded = 0;
      const onPair = () => {
        if (++loaded < 2) return;
        const run = runReq.result as RunRecord | undefined;
        const shot = shotReq.result as ShotRecord | undefined;
        if (!run || run.status !== "completed" || !isH3Capability(run.capabilityId) || (run.shotId && run.shotId !== shotId)) return;
        if (!run.outputAssetIds.length) return;
        if (!shot) { tx.abort(); return; }
        const assets: (AssetRecord | undefined)[] = new Array(run.outputAssetIds.length);
        let remaining = run.outputAssetIds.length;
        run.outputAssetIds.forEach((assetId, idx) => {
          const req = assetStore.get(assetId);
          armIdbRead(req, reject);
          req.onsuccess = () => {
            assets[idx] = req.result as AssetRecord | undefined;
            if (--remaining > 0) return;
            if (assets.some((asset) => !asset || (asset.shotId && asset.shotId !== shotId))) return;
            runStore.put({ ...run, shotId });
            for (const asset of assets) assetStore.put({ ...asset!, shotId });
            const nextRunIds = shot.runIds.includes(runId) ? shot.runIds : [...shot.runIds, runId];
            shotStore.put({
              ...shot,
              runIds: nextRunIds,
              status: shot.adoptedAssetId ? "adopted" : "has_candidates",
              updatedAt: Date.now(),
            });
            committed = true;
          };
        });
      };
      runReq.onsuccess = shotReq.onsuccess = onPair;
      tx.oncomplete = () => resolve(committed);
      tx.onerror = () => reject(tx.error ?? new Error("镜头关联保存失败"));
      tx.onabort = () => reject(tx.error ?? new Error("镜头记录不存在或关联保存已中止"));
    }, 15000);
  });
  if (attached) announceRunChange(runId);
  return attached;
}

export async function registerAsset(input: Omit<AssetRecord, "schemaVersion" | "assetId" | "createdAt">,signal?:AbortSignal): Promise<AssetRecord> {
  signal?.throwIfAborted();
  let scope = currentLibraryScope();
  await canvasLibraryReady();
  if (scope && !scope.pageId) throw Error('画布尚未加载完成，请稍后再导入素材');
  // Completed jobs belong to the submitting page, not whichever page is now visible.
  const run = input.sourceRunId ? await getRun(input.sourceRunId) : null;
  if (run?.canvasPageId) scope = { pageId: run.canvasPageId, references: new Set() };
  const existing = await getAssetBySource(input.storageReference);
  if (existing) {
    if (scope && !existing.canvasPageIds?.includes(scope.pageId)) await assignAssetToCanvases(existing.assetId, [scope.pageId]);
    return canvasAsset({ ...existing, ...(scope ? { canvasPageIds: [...new Set([...(existing.canvasPageIds ?? []), scope.pageId])] } : {}) }, scope?.pageId);
  }
  const asset: AssetRecord = { ...structuredClone(input), ...(scope ? { canvasPageIds: input.canvasPageIds ?? [scope.pageId] } : {}), schemaVersion: 1, assetId: crypto.randomUUID(), createdAt: Date.now() };
  signal?.throwIfAborted();
  try { await write(ASSETS, asset,signal); return asset; }
  catch (cause) {
    signal?.throwIfAborted();
    // Concurrent reads of the same legacy media must converge on one identity.
    const raced = await getAssetBySource(input.storageReference);
    if (raced) { if (scope) await assignAssetToCanvases(raced.assetId, [scope.pageId]); return raced; }
    throw cause;
  }
}

export async function ensureLegacyAsset(source: string, kind: AssetKind, filename: string, details: Partial<Pick<AssetRecord, "width" | "height" | "duration" | "fps" | "fileSize">> = {}, mimeType?: string,signal?:AbortSignal) {
  if (!source) throw new Error("素材没有可读取的媒体引用");
  // Inline legacy data is not duplicated into the metadata store.
  const storageReference = source.startsWith("data:") ? `legacy-inline:${await digest(source)}` : source;
  return registerAsset({ kind, origin: "unknown", filename, mimeType: mimeType || (kind === "image" ? "image/*" : kind === "audio" ? "audio/*" : "video/mp4"), storageReference, sourceRunId: null, ...details },signal);
}

async function digest(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createRun(input: Pick<RunRecord, "capabilityId" | "inputAssetIds" | "rawPrompt" | "finalPrompt" | "seed" | "parameters" | "workflowIdentity" | "referenceInputs" | "shotId" | "referenceManifest" | "promptMode" | "promptCompile" | "ownerNodeId" | "taskMode" | "engine" | "directorContext" | "zhengbenVersion">, options: { reservePromptId?: boolean;signal?:AbortSignal } = {}) {
  const runId = crypto.randomUUID();
  const pageId = currentLibraryScope()?.pageId;
  const run: RunRecord = { ...structuredClone(input), ...(pageId ? { canvasPageId: pageId } : {}), schemaVersion: 1, runId, status: "queued", createdAt: Date.now(), startedAt: null, completedAt: null, comfyPromptId: null, outputAssetIds: [], error: null };
  // The Run ID doubles as the ComfyUI prompt_id and is persisted before /prompt is sent.
  if (options.reservePromptId) { run.comfyPromptId = runId; run.submission = "reserved"; }
  // The manifest was frozen before submission; the stored copy only gains its Run / Shot identity.
  if (run.referenceManifest) run.referenceManifest = { ...run.referenceManifest, runId: run.runId, shotId: input.shotId ?? null };
  options.signal?.throwIfAborted();await write(RUNS, run,options.signal);
  announceRunChange(run.runId);
  return run;
}

type MutableRunFields = Pick<RunRecord, "status" | "startedAt" | "completedAt" | "comfyPromptId" | "outputAssetIds" | "error" | "submission" | "executionTiming" | "submissionSnapshot" | "preparationNotSent" | "musicRemoval">;
const pendingUpdates = new Map<string, Promise<RunRecord>>();
export function updateRun(runId: string, changes: Partial<MutableRunFields>,signal?:AbortSignal) {
  const update = async () => {
    const current = await getRun(runId);
    if (!current) throw new Error("生成记录不存在");
    if (["completed", "failed", "cancelled"].includes(current.status) && changes.status && changes.status !== current.status) return current;
    signal?.throwIfAborted();
    const next = { ...current, ...structuredClone(changes),...(changes.submission==='accepted'&&current.acceptedAt===undefined?{acceptedAt:Date.now()}:{}) };
    await write(RUNS, next,signal);
    announceRunChange(runId);
    return next;
  };
  const next = (pendingUpdates.get(runId) ?? Promise.resolve(null)).then(update, update);
  pendingUpdates.set(runId, next);
  void next.finally(() => { if (pendingUpdates.get(runId) === next) pendingUpdates.delete(runId); }).catch(() => {});
  return next;
}
