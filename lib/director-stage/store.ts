import type { z } from "zod";
import { withProjectMediaWrite } from "../project-media-lock.ts";
import {
  CameraInputSchema, CameraPatchSchema, CameraSchema, ControlPackageInputSchema, ControlPackagePatchSchema, ControlPackageSchema, DIRECTOR_STAGE_SCHEMA_VERSION,
  MotionInputSchema, MotionPatchSchema, MotionSchema, PropInputSchema, PropPatchSchema, PropSchema, SceneInputSchema, ScenePatchSchema, SceneSchema,
  SceneStateInputSchema, SceneStatePatchSchema, SceneStateSchema, sortKeyframes,
  type Camera, type CameraInput, type ControlPackage, type ControlPackageInput, type Motion, type MotionInput, type Prop, type PropInput,
  type Scene, type SceneInput, type SceneState, type SceneStateInput,
} from "./schema.ts";
import type { SceneBundle } from "./import-format.ts";

/**
 * Director Stage store V0.1: its own IndexedDB, plain CRUD. It never opens production-records,
 * role-records or the media stores, and never touches H3 / ComfyUI.
 *
 * Integrity kept inside one transaction per call: children need an existing Scene; State
 * propChanges and Motion targets must belong to the same Scene; deleting a Scene deletes its
 * children (never any Asset); a Prop or Camera that is still referenced cannot be deleted.
 */

/** Database spec in one place, for a later backup integration (lib/project-backup.ts is not changed here). */
export const DIRECTOR_STAGE_DATABASE = {
  name: "frameflow-director-stage",
  version: 1,
  stores: [["scenes", "id"], ["props", "id"], ["states", "id"], ["cameras", "id"], ["motions", "id"], ["controlPackages", "id"]],
} as const;

type StoreName = (typeof DIRECTOR_STAGE_DATABASE.stores)[number][0];
const CHILD_STORES: StoreName[] = ["props", "states", "cameras", "motions", "controlPackages"];
type Child = { id: string; sceneId: string; createdAt: number };
type Refs = { propIds: Set<string>; cameraIds: Set<string> };

let databasePromise: Promise<IDBDatabase> | null = null;
function openDatabase() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DIRECTOR_STAGE_DATABASE.name, DIRECTOR_STAGE_DATABASE.version);
    request.onupgradeneeded = () => {
      for (const [store, keyPath] of DIRECTOR_STAGE_DATABASE.stores) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { databasePromise = null; reject(request.error ?? new Error("导演台数据库无法打开")); };
  });
  return databasePromise;
}

const asError = (cause: unknown) => cause instanceof Error ? cause : new Error(String(cause));

/** One transaction; `body` chains requests with callbacks (no await inside, so IDB cannot auto-commit early). */
async function transact<R>(stores: StoreName[], mode: IDBTransactionMode, body: (tx: IDBTransaction, done: (value: R) => void, fail: (error: Error) => void) => void): Promise<R> {
  const db = await openDatabase();
  const action = () => new Promise<R>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: R | undefined;
    let failure: Error | null = null;
    const fail = (error: Error) => { if (failure) return; failure = error; try { tx.abort(); } catch { /* transaction already finished */ } };
    tx.oncomplete = () => failure ? reject(failure) : resolve(result as R);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("导演台数据写入已中止"));
    tx.onerror = () => { failure ??= tx.error ?? new Error("导演台数据写入失败"); };
    try { body(tx, (value) => { result = value; }, fail); } catch (cause) { fail(asError(cause)); }
  });
  return mode === "readwrite" ? withProjectMediaWrite(action) : action();
}

function on<T>(request: IDBRequest, fail: (error: Error) => void, then: (value: T) => void) {
  request.onsuccess = () => { try { then(request.result as T); } catch (cause) { fail(asError(cause)); } };
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${what}数据不合法：${result.error.issues.map((issue) => `${issue.path.join(".") || "(根)"} ${issue.message}`).join("；")}`);
  return result.data;
}

/** Reads the Scene (must exist) and, when needed, the IDs of its Props and Cameras. */
function withScene(tx: IDBTransaction, sceneId: string, needRefs: boolean, fail: (error: Error) => void, then: (refs: Refs) => void) {
  on<Scene | undefined>(tx.objectStore("scenes").get(sceneId), fail, (scene) => {
    if (!scene) throw new Error(`场景不存在：${sceneId}`);
    if (!needRefs) { then({ propIds: new Set(), cameraIds: new Set() }); return; }
    on<Prop[]>(tx.objectStore("props").getAll(), fail, (props) => {
      on<Camera[]>(tx.objectStore("cameras").getAll(), fail, (cameras) => {
        then({ propIds: new Set(props.filter((item) => item.sceneId === sceneId).map((item) => item.id)), cameraIds: new Set(cameras.filter((item) => item.sceneId === sceneId).map((item) => item.id)) });
      });
    });
  });
}

const checkState = (state: SceneState, refs: Refs) => {
  const seen = new Set<string>();
  for (const change of state.propChanges) {
    if (!refs.propIds.has(change.propId)) throw new Error(`状态“${state.name}”引用的道具不属于该场景：${change.propId}`);
    if (seen.has(change.propId)) throw new Error(`状态“${state.name}”中同一道具出现多次：${change.propId}`);
    seen.add(change.propId);
  }
};
const checkMotion = (motion: Motion, refs: Refs) => {
  const ids = motion.targetType === "camera" ? refs.cameraIds : refs.propIds;
  if (!ids.has(motion.targetId)) throw new Error(`动作目标不是该场景的${motion.targetType === "camera" ? "摄影机" : "道具"}：${motion.targetId}`);
};

function stamp(now = Date.now()) { return { schemaVersion: DIRECTOR_STAGE_SCHEMA_VERSION, id: crypto.randomUUID(), createdAt: now, updatedAt: now } as const; }

function insertChild<T extends Child>(store: StoreName, record: T, needRefs: boolean, check?: (record: T, refs: Refs) => void) {
  const stores: StoreName[] = needRefs ? ["scenes", "props", "cameras", store] : ["scenes", store];
  return transact<T>([...new Set(stores)], "readwrite", (tx, done, fail) => withScene(tx, record.sceneId, needRefs, fail, (refs) => {
    check?.(record, refs);
    on(tx.objectStore(store).add(record), fail, () => done(record));
  }));
}

function patchChild<T extends Child>(store: StoreName, id: string, merge: (current: T) => T, needRefs: boolean, check?: (record: T, refs: Refs) => void) {
  const stores: StoreName[] = needRefs ? ["scenes", "props", "cameras", store] : ["scenes", store];
  return transact<T>([...new Set(stores)], "readwrite", (tx, done, fail) => on<T | undefined>(tx.objectStore(store).get(id), fail, (current) => {
    if (!current) throw new Error(`记录不存在：${id}`);
    const next = { ...merge(current), id: current.id, sceneId: current.sceneId, createdAt: current.createdAt, updatedAt: Date.now() };
    withScene(tx, next.sceneId, needRefs, fail, (refs) => { check?.(next, refs); on(tx.objectStore(store).put(next), fail, () => done(next)); });
  }));
}

function getOne<T>(store: StoreName, id: string) {
  return transact<T | null>([store], "readonly", (tx, done, fail) => on<T | undefined>(tx.objectStore(store).get(id), fail, (value) => done(value ?? null)));
}

function listChildren<T extends Child>(store: StoreName, sceneId: string) {
  return transact<T[]>([store], "readonly", (tx, done, fail) => on<T[]>(tx.objectStore(store).getAll(), fail, (rows) => done(rows.filter((row) => row.sceneId === sceneId).sort((a, b) => a.createdAt - b.createdAt))));
}

function deleteOne(store: StoreName, id: string) {
  return transact<void>([store], "readwrite", (tx, done, fail) => on<unknown>(tx.objectStore(store).get(id), fail, (value) => {
    if (!value) throw new Error(`记录不存在：${id}`);
    on(tx.objectStore(store).delete(id), fail, () => done(undefined));
  }));
}

/* ── Scene ─────────────────────────────────────────────────────────────── */

export async function createScene(input: SceneInput): Promise<Scene> {
  const record = parse(SceneSchema, { ...stamp(), ...parse(SceneInputSchema, input, "场景") }, "场景");
  return transact<Scene>(["scenes"], "readwrite", (tx, done, fail) => on(tx.objectStore("scenes").add(record), fail, () => done(record)));
}
export const getScene = (id: string) => getOne<Scene>("scenes", id);
export function listScenes() {
  return transact<Scene[]>(["scenes"], "readonly", (tx, done, fail) => on<Scene[]>(tx.objectStore("scenes").getAll(), fail, (rows) => done(rows.sort((a, b) => b.updatedAt - a.updatedAt))));
}
export async function updateScene(id: string, patch: z.input<typeof ScenePatchSchema>): Promise<Scene> {
  const change = parse(ScenePatchSchema, patch, "场景");
  return transact<Scene>(["scenes"], "readwrite", (tx, done, fail) => on<Scene | undefined>(tx.objectStore("scenes").get(id), fail, (current) => {
    if (!current) throw new Error(`场景不存在：${id}`);
    const next = parse(SceneSchema, { ...current, ...change, updatedAt: Date.now() }, "场景");
    on(tx.objectStore("scenes").put(next), fail, () => done(next));
  }));
}
/** Deletes the Scene and all its Props / States / Cameras / Motions / ControlPackages. Assets are untouched. */
export function deleteScene(id: string) {
  return transact<{ deletedChildren: number }>(["scenes", ...CHILD_STORES], "readwrite", (tx, done, fail) => on<Scene | undefined>(tx.objectStore("scenes").get(id), fail, (scene) => {
    if (!scene) throw new Error(`场景不存在：${id}`);
    let deleted = 0;
    let pending = CHILD_STORES.length;
    const finish = () => { if (--pending === 0) on(tx.objectStore("scenes").delete(id), fail, () => done({ deletedChildren: deleted })); };
    for (const store of CHILD_STORES) on<Child[]>(tx.objectStore(store).getAll(), fail, (rows) => {
      for (const row of rows) if (row.sceneId === id) { tx.objectStore(store).delete(row.id); deleted += 1; }
      finish();
    });
  }));
}

/* ── Prop ──────────────────────────────────────────────────────────────── */

export function createProp(input: PropInput): Promise<Prop> {
  try { return insertChild("props", parse(PropSchema, { ...stamp(), ...parse(PropInputSchema, input, "道具") }, "道具"), false); } catch (cause) { return Promise.reject(asError(cause)); }
}
export const getProp = (id: string) => getOne<Prop>("props", id);
export const listProps = (sceneId: string) => listChildren<Prop>("props", sceneId);
export function updateProp(id: string, patch: z.input<typeof PropPatchSchema>): Promise<Prop> {
  try { const change = parse(PropPatchSchema, patch, "道具"); return patchChild<Prop>("props", id, (current) => parse(PropSchema, { ...current, ...change }, "道具"), false); } catch (cause) { return Promise.reject(asError(cause)); }
}
/** Refused while a State or Motion of the Scene still refers to this Prop. */
export function deleteProp(id: string) {
  return transact<void>(["props", "states", "motions"], "readwrite", (tx, done, fail) => on<Prop | undefined>(tx.objectStore("props").get(id), fail, (prop) => {
    if (!prop) throw new Error(`道具不存在：${id}`);
    on<SceneState[]>(tx.objectStore("states").getAll(), fail, (states) => on<Motion[]>(tx.objectStore("motions").getAll(), fail, (motions) => {
      const users = [...states.filter((state) => state.propChanges.some((change) => change.propId === id)).map((state) => `状态“${state.name}”`), ...motions.filter((motion) => motion.targetId === id).map(() => "动作")];
      if (users.length) throw new Error(`道具“${prop.name}”仍被引用（${users.join("、")}），请先移除引用`);
      on(tx.objectStore("props").delete(id), fail, () => done(undefined));
    }));
  }));
}

/* ── SceneState ────────────────────────────────────────────────────────── */

export function createSceneState(input: SceneStateInput): Promise<SceneState> {
  try { return insertChild("states", parse(SceneStateSchema, { ...stamp(), ...parse(SceneStateInputSchema, input, "场景状态") }, "场景状态"), true, checkState); } catch (cause) { return Promise.reject(asError(cause)); }
}
export const getSceneState = (id: string) => getOne<SceneState>("states", id);
export const listSceneStates = (sceneId: string) => listChildren<SceneState>("states", sceneId);
export function updateSceneState(id: string, patch: z.input<typeof SceneStatePatchSchema>): Promise<SceneState> {
  try { const change = parse(SceneStatePatchSchema, patch, "场景状态"); return patchChild<SceneState>("states", id, (current) => parse(SceneStateSchema, { ...current, ...change }, "场景状态"), true, checkState); } catch (cause) { return Promise.reject(asError(cause)); }
}
export const deleteSceneState = (id: string) => deleteOne("states", id);

/* ── Camera ────────────────────────────────────────────────────────────── */

export function createCamera(input: CameraInput): Promise<Camera> {
  try { return insertChild("cameras", parse(CameraSchema, { ...stamp(), ...parse(CameraInputSchema, input, "摄影机") }, "摄影机"), false); } catch (cause) { return Promise.reject(asError(cause)); }
}
export const getCamera = (id: string) => getOne<Camera>("cameras", id);
export const listCameras = (sceneId: string) => listChildren<Camera>("cameras", sceneId);
export function updateCamera(id: string, patch: z.input<typeof CameraPatchSchema>): Promise<Camera> {
  try { const change = parse(CameraPatchSchema, patch, "摄影机"); return patchChild<Camera>("cameras", id, (current) => parse(CameraSchema, { ...current, ...change }, "摄影机"), false); } catch (cause) { return Promise.reject(asError(cause)); }
}
/** Refused while a Motion still targets this Camera. */
export function deleteCamera(id: string) {
  return transact<void>(["cameras", "motions"], "readwrite", (tx, done, fail) => on<Camera | undefined>(tx.objectStore("cameras").get(id), fail, (camera) => {
    if (!camera) throw new Error(`摄影机不存在：${id}`);
    on<Motion[]>(tx.objectStore("motions").getAll(), fail, (motions) => {
      if (motions.some((motion) => motion.targetId === id)) throw new Error(`摄影机“${camera.name}”仍被动作引用，请先移除引用`);
      on(tx.objectStore("cameras").delete(id), fail, () => done(undefined));
    });
  }));
}

/* ── Motion ────────────────────────────────────────────────────────────── */

/** Keyframes may be passed in any order; they are stored sorted by frame (duplicate frames are refused). */
export function createMotion(input: MotionInput): Promise<Motion> {
  try { return insertChild("motions", parse(MotionSchema, { ...stamp(), ...parse(MotionInputSchema, { ...input, keyframes: sortKeyframes(input.keyframes) }, "动作") }, "动作"), true, checkMotion); } catch (cause) { return Promise.reject(asError(cause)); }
}
export const getMotion = (id: string) => getOne<Motion>("motions", id);
export const listMotions = (sceneId: string) => listChildren<Motion>("motions", sceneId);
export function updateMotion(id: string, patch: z.input<typeof MotionPatchSchema>): Promise<Motion> {
  try { const change = parse(MotionPatchSchema, patch.keyframes ? { ...patch, keyframes: sortKeyframes(patch.keyframes) } : patch, "动作"); return patchChild<Motion>("motions", id, (current) => parse(MotionSchema, { ...current, ...change }, "动作"), true, checkMotion); } catch (cause) { return Promise.reject(asError(cause)); }
}
export const deleteMotion = (id: string) => deleteOne("motions", id);

/* ── ControlPackage ────────────────────────────────────────────────────── */

/** `assetIds` are stored as given; V0.1 does not check them against production-records. */
export function createControlPackage(input: ControlPackageInput): Promise<ControlPackage> {
  try { return insertChild("controlPackages", parse(ControlPackageSchema, { ...stamp(), ...parse(ControlPackageInputSchema, input, "控制素材包") }, "控制素材包"), false); } catch (cause) { return Promise.reject(asError(cause)); }
}
export const getControlPackage = (id: string) => getOne<ControlPackage>("controlPackages", id);
export const listControlPackages = (sceneId: string) => listChildren<ControlPackage>("controlPackages", sceneId);
export function updateControlPackage(id: string, patch: z.input<typeof ControlPackagePatchSchema>): Promise<ControlPackage> {
  try { const change = parse(ControlPackagePatchSchema, patch, "控制素材包"); return patchChild<ControlPackage>("controlPackages", id, (current) => parse(ControlPackageSchema, { ...current, ...change }, "控制素材包"), false); } catch (cause) { return Promise.reject(asError(cause)); }
}
/** Deletes only the package record; the Assets it lists are kept. */
export const deleteControlPackage = (id: string) => deleteOne("controlPackages", id);

/* ── JSON 导入：整场景一次写入 / 撤销 ──────────────────────────────── */


/** Validates one bundle completely (schemas + every reference stays inside the bundle) before anything is written. */
function checkBundle(bundle: SceneBundle) {
  const scene = parse(SceneSchema, bundle.scene, "场景");
  const sceneId = scene.id;
  const owned = <T extends { sceneId: string; name: string }>(rows: T[], what: string) => { for (const row of rows) if (row.sceneId !== sceneId) throw new Error(`${what}“${row.name}”不属于场景“${scene.name}”`); return rows; };
  const props = owned(bundle.props.map((row) => parse(PropSchema, row, "道具")), "道具");
  const cameras = owned(bundle.cameras.map((row) => parse(CameraSchema, row, "摄影机")), "摄影机");
  const states = owned(bundle.states.map((row) => parse(SceneStateSchema, row, "场景状态")), "状态");
  const motions = owned(bundle.motions.map((row) => parse(MotionSchema, row, "动作")), "动作");
  const controlPackages = owned(bundle.controlPackages.map((row) => parse(ControlPackageSchema, row, "控制素材包")), "控制素材包");
  const refs: Refs = { propIds: new Set(props.map((row) => row.id)), cameraIds: new Set(cameras.map((row) => row.id)) };
  for (const state of states) checkState(state, refs);
  for (const motion of motions) checkMotion(motion, refs);
  const ids = [sceneId, ...props, ...cameras, ...states, ...motions, ...controlPackages].map((row) => typeof row === "string" ? row : row.id);
  if (new Set(ids).size !== ids.length) throw new Error(`场景“${scene.name}”里有重复的记录 ID`);
  return { scene, props, cameras, states, motions, controlPackages };
}

/**
 * Writes whole Scenes in ONE transaction (all or nothing): each bundle's Scene and children are put as given, and
 * any existing child of that Scene that is not in the bundle is deleted, so no orphan is left. `removeSceneIds`
 * cascade-deletes whole Scenes (used to undo an import that created them). Record IDs must not belong to another Scene.
 * Assets are never touched.
 */
export function writeSceneBundles(bundles: SceneBundle[], removeSceneIds: string[] = []) {
  let checked: ReturnType<typeof checkBundle>[];
  try { checked = bundles.map(checkBundle); } catch (cause) { return Promise.reject(asError(cause)); }
  const sceneIds = new Set(checked.map((bundle) => bundle.scene.id));
  if (sceneIds.size !== checked.length) return Promise.reject(new Error("同一次写入里有两个相同的场景"));
  const stores: StoreName[] = ["scenes", ...CHILD_STORES];
  return transact<{ written: number; deleted: number }>(stores, "readwrite", (tx, done, fail) => {
    let written = 0, deleted = 0;
    let pending = CHILD_STORES.length;
    const finished = () => {
      if (--pending) return;
      for (const id of removeSceneIds) if (!sceneIds.has(id)) tx.objectStore("scenes").delete(id);
      for (const bundle of checked) { tx.objectStore("scenes").put(bundle.scene); written += 1; }
      done({ written, deleted });
    };
    const keyOf: Record<string, keyof ReturnType<typeof checkBundle>> = { props: "props", states: "states", cameras: "cameras", motions: "motions", controlPackages: "controlPackages" };
    for (const store of CHILD_STORES) on<Child[]>(tx.objectStore(store).getAll(), fail, (rows) => {
      const incoming = checked.flatMap((bundle) => bundle[keyOf[store]] as unknown as Child[]);
      const incomingIds = new Set(incoming.map((row) => row.id));
      for (const row of rows) {
        if (incomingIds.has(row.id) && !sceneIds.has(row.sceneId)) throw new Error(`记录 ID ${row.id} 已属于另一个场景，不能写进来`);
        if ((sceneIds.has(row.sceneId) && !incomingIds.has(row.id)) || removeSceneIds.includes(row.sceneId)) { tx.objectStore(store).delete(row.id); deleted += 1; }
      }
      for (const row of incoming) { tx.objectStore(store).put(row); written += 1; }
      finished();
    });
  });
}
