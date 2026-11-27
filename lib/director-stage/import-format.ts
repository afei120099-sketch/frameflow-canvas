import {
  ANCHOR_FRAME_RANGE, CAMERA_ASPECTS, CONTROL_PACKAGE_ASSET_RULES, CONTROL_PACKAGE_TYPES, controlPackageAssetProblem, DIRECTOR_STAGE_SCHEMA_VERSION, MOTION_FRAME_RANGE, PROP_GEOMETRIES, WHITEBOX_LIMITS,
  type Camera, type CameraAspect, type ControlPackage, type ControlPackageType, type Motion, type MotionKeyframe, type Prop, type PropGeometry, type Room, type Scene, type SceneState, type Transform,
} from "./schema.ts";

/**
 * 导演台 JSON 导入 / 导出（director-stage-v1）。纯函数：只做解析、校验、生成写入计划，不碰数据库。
 * 写入由 store.ts 的 writeSceneBundles 一次事务完成；说明正文在 import-guide.ts，改这里的字段时同步改说明。
 *
 * 坐标：米，Y 朝上，房间地面中心是原点；X 向右（宽），Z 向“前墙”（深，+Z 是新摄影机默认所在的一侧）。
 * 旋转是 XYZ 欧拉角（度，three.js 默认顺序）；摄影机看向自己的 −Z。摄影机可以写 lookAt（看向的点），导入时换算成旋转。
 */

export const DIRECTOR_STAGE_FORMAT = "director-stage-v1";

/* ── 文件里的样子（AI 写的） ─────────────────────────────────────────── */

export type Vec3 = [number, number, number];
export interface ImportPose { position: Vec3; rotation?: Vec3; lookAt?: Vec3; size?: Vec3 }
export interface ImportProp { id?: string; name: string; type: string; geometry?: PropGeometry; position?: Vec3; rotation?: Vec3; size?: Vec3 }
export interface ImportState { id?: string; name: string; changes: { prop: string; description: string }[] }
export interface ImportCamera { id?: string; name: string; note?: string; position?: Vec3; rotation?: Vec3; lookAt?: Vec3; focalLength?: number; aspect?: CameraAspect }
export interface ImportMotion { id?: string; name: string; target: { prop: string } | { camera: string }; keyframes: { frame: number; description: string; pose?: ImportPose }[] }
export interface ImportPackage { id?: string; name: string; type: ControlPackageType; assetIds: string[]; anchorFrame?: number }
export interface ImportScene { id?: string; name: string; room?: Room; props: ImportProp[]; states: ImportState[]; cameras: ImportCamera[]; motions: ImportMotion[]; controlPackages: ImportPackage[] }
export interface DirectorStageDocument { version: typeof DIRECTOR_STAGE_FORMAT; scenes: ImportScene[] }

/* ── 数据库里的样子 ────────────────────────────────────────────────── */

/** One Scene with every child record — the unit written (and restored on undo) in one transaction. */
export interface SceneBundle { scene: Scene; props: Prop[]; states: SceneState[]; cameras: Camera[]; motions: Motion[]; controlPackages: ControlPackage[] }
export type ExistingScene = { scene: Scene; props: Prop[]; states: SceneState[]; cameras: Camera[]; motions: Motion[]; packages: ControlPackage[] };

/* ── 默认值（和白模导演台新建时一样） ─────────────────────────────── */

export const IMPORT_DEFAULTS = {
  boxSize: [0.5, 0.9, 0.5] as Vec3,
  planeSize: [1, 1, 1] as Vec3,
  focalLength: 35,
  aspect: "9:16" as CameraAspect,
};

/* ── 摄影机 lookAt → 旋转 ─────────────────────────────────────────── */

const round = (value: number, digits: number) => { const result = Math.round(value * 10 ** digits) / 10 ** digits; return Object.is(result, -0) ? 0 : result; };
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Euler XYZ (degrees, three.js order) of an object at `eye` whose −Z points at `target`, world Y up, no roll —
 * the same as three.js `camera.lookAt(target)` followed by reading `camera.rotation`. Null when eye = target or straight up / down.
 */
export function lookAtRotation(eye: Vec3, target: Vec3): Vec3 | null {
  const sub = [eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]];
  const length = Math.hypot(sub[0], sub[1], sub[2]);
  if (length < 1e-6) return null;
  const z = sub.map((value) => value / length);
  // x = up × z, up = (0,1,0)
  let x = [z[2], 0, -z[0]];
  const xLength = Math.hypot(x[0], x[1], x[2]);
  if (xLength < 1e-6) return null;
  x = x.map((value) => value / xLength);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  // Matrix columns x, y, z → m11=x0 m12=y0 m13=z0, m22=y1 m23=z1, m32=y2 m33=z2, m21=x1.
  const m13 = Math.max(-1, Math.min(1, z[0]));
  const ry = Math.asin(m13);
  let rx: number, rz: number;
  if (Math.abs(m13) < 0.9999999) { rx = Math.atan2(-z[1], z[2]); rz = Math.atan2(-y[0], x[0]); }
  else { rx = Math.atan2(y[2], y[1]); rz = 0; }
  return [round(toDeg(rx), 1), round(toDeg(ry), 1), round(toDeg(rz), 1)];
}

/* ── 校验 ─────────────────────────────────────────────────────────── */

export type ValidationResult = { ok: true; document: DirectorStageDocument } | { ok: false; errors: string[] };
/** Asset kind by Asset ID ("image" / "video" / "audio"); used to check control packages. */
export type AssetKinds = Map<string, string>;

const MAX_ERRORS = 40;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const show = (value: unknown) => { const text = JSON.stringify(value); return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}…` : text; };

/** Common misspellings → the right key, so the error says what to write instead. */
const KEY_HINTS: Record<string, string> = {
  scale: "size", dimensions: "size", pos: "position", location: "position", rot: "rotation", orientation: "rotation", target: "lookAt", look_at: "lookAt", lookat: "lookAt",
  focal: "focalLength", focal_length: "focalLength", lens: "focalLength", fov: "focalLength", ratio: "aspect", aspectRatio: "aspect", title: "name", label: "name",
  packages: "controlPackages", control_packages: "controlPackages", assets: "assetIds", asset_ids: "assetIds", anchor: "anchorFrame", anchor_frame: "anchorFrame",
  propChanges: "changes", objects: "props", camera: "cameras", prop: "props", state: "states", motion: "motions", shots: "（导入格式没有镜头，镜头请在导演台里用这些场景建）",
};

class Checker {
  errors: string[] = [];
  add(where: string, message: string) { if (this.errors.length < MAX_ERRORS) this.errors.push(`${where}：${message}`); }
  keys(where: string, value: Record<string, unknown>, allowed: string[]) {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) {
      const hint = KEY_HINTS[key];
      this.add(where, `不认识的字段 "${key}"${hint ? (hint.startsWith("（") ? hint : `，应写成 "${hint}"`) : `，这里只能写：${allowed.join("、")}`}`);
    }
  }
  name(where: string, value: unknown, max = 80): string | null {
    if (typeof value !== "string" || !value.trim()) { this.add(where, `name 必填，写一个不为空的名字（现在是 ${show(value)}）`); return null; }
    if (value.trim().length > max) { this.add(where, `name 太长，最多 ${max} 个字`); return null; }
    return value.trim();
  }
  text(where: string, field: string, value: unknown, max: number, required: boolean): string | undefined | null {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || (required && !value.trim())) { this.add(where, `${field} 必须是${required ? "不为空的" : ""}文字（现在是 ${show(value)}）`); return null; }
    if (value.trim().length > max) { this.add(where, `${field} 太长，最多 ${max} 个字`); return null; }
    return value.trim();
  }
  id(where: string, value: unknown): string | undefined | null {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > 100) { this.add(where, `id 必须是不为空的文字（新建的东西不用写 id，导出的 JSON 里的 id 原样保留即可）`); return null; }
    return value;
  }
  vec3(where: string, field: string, value: unknown, min: number, max: number, unit: string): Vec3 | undefined | null {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length !== 3 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      this.add(where, `${field} 应为 3 个数字 [x, y, z]（${unit}），现在是 ${show(value)}`); return null;
    }
    const bad = value.findIndex((item: number) => item < min || item > max);
    if (bad >= 0) { this.add(where, `${field} 的第 ${bad + 1} 个数 ${value[bad]} 超出范围，应在 ${min} 到 ${max} 之间（${unit}）`); return null; }
    return [value[0], value[1], value[2]];
  }
  number(where: string, field: string, value: unknown, min: number, max: number, integer: boolean, unit: string): number | undefined | null {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) { this.add(where, `${field} 应为${integer ? "整数" : "数字"}（${unit}），现在是 ${show(value)}`); return null; }
    if (value < min || value > max) { this.add(where, `${field} = ${value} 超出范围，应在 ${min} 到 ${max} 之间（${unit}）`); return null; }
    return value;
  }
  list(where: string, field: string, value: unknown, required: boolean): unknown[] | null {
    if (value === undefined && !required) return [];
    if (!Array.isArray(value)) { this.add(where, `${field} 应为数组 [...]${required ? "（必填）" : ""}，现在是 ${show(value)}`); return null; }
    return value;
  }
  unique(where: string, what: string, names: (string | null)[]) {
    const seen = new Set<string>();
    for (const name of names) if (name !== null) { if (seen.has(name)) this.add(where, `有两个${what}都叫“${name}”，同一场景里${what}名字不能重复（引用靠名字）`); seen.add(name); }
  }
}

const L = WHITEBOX_LIMITS;
const POSITION_UNIT = "米";
const ROTATION_UNIT = "度";

/** Parses pasted text; strips a ```json fence an AI may wrap around it. */
export function parseDirectorStageText(text: string): ValidationResult | { ok: false; errors: string[] } {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed) return { ok: false, errors: ["内容是空的：请粘贴 AI 写好的 JSON，或选择一个 .json 文件"] };
  let raw: unknown;
  try { raw = JSON.parse(trimmed); }
  catch (cause) { return { ok: false, errors: [`不是合法的 JSON：${cause instanceof Error ? cause.message : String(cause)}。常见原因：多了或少了逗号、用了中文引号“”、带了注释`] }; }
  return { ok: true, document: raw as DirectorStageDocument };
}

/**
 * Checks a parsed document field by field. `assets` (optional) are the project's Assets for checking
 * control-package assetIds; without it assetIds are not checked against the library.
 */
export function validateDirectorStageDocument(raw: unknown, assets?: AssetKinds): ValidationResult {
  const check = new Checker();
  if (!isObject(raw)) return { ok: false, errors: ["最外层应该是一个对象 { \"version\": \"director-stage-v1\", \"scenes\": [...] }"] };
  check.keys("最外层", raw, ["version", "scenes"]);
  if (raw.version !== DIRECTOR_STAGE_FORMAT) check.add("最外层", `version 必须写 "${DIRECTOR_STAGE_FORMAT}"（现在是 ${show(raw.version)}）`);
  const sceneList = check.list("最外层", "scenes", raw.scenes, true);
  if (sceneList && !sceneList.length) check.add("最外层", "scenes 是空的，至少写一个场景");
  const scenes: ImportScene[] = [];
  const sceneNames: (string | null)[] = [];
  const allIds = new Map<string, string>();
  const claimId = (where: string, id: string | null | undefined) => {
    if (!id) return;
    const previous = allIds.get(id);
    if (previous) check.add(where, `id "${id}" 和 ${previous} 重复，每个 id 只能出现一次`);
    else allIds.set(id, where);
  };
  (sceneList ?? []).forEach((rawScene, sceneIndex) => {
    let where = `第 ${sceneIndex + 1} 个场景`;
    if (!isObject(rawScene)) { check.add(where, "应为对象 { \"name\": ..., \"props\": [...] }"); return; }
    const name = check.name(where, rawScene.name);
    if (name) where = `场景“${name}”`;
    sceneNames.push(name);
    check.keys(where, rawScene, ["id", "name", "room", "props", "states", "cameras", "motions", "controlPackages"]);
    const sceneId = check.id(where, rawScene.id);
    claimId(where, sceneId);
    let room: Room | undefined;
    if (rawScene.room !== undefined) {
      if (!isObject(rawScene.room)) check.add(where, "room 应为 { \"width\": 宽, \"depth\": 深, \"height\": 高 }（米）");
      else {
        check.keys(`${where} → room`, rawScene.room, ["width", "depth", "height"]);
        const parts = (["width", "depth", "height"] as const).map((key) => {
          const value = check.number(`${where} → room`, key, rawScene.room && (rawScene.room as Record<string, unknown>)[key], L.roomMin, L.roomMax, false, "米");
          if (value === undefined) check.add(`${where} → room`, `${key} 必填（米）`);
          return value;
        });
        if (parts.every((part) => typeof part === "number")) room = { width: parts[0]!, depth: parts[1]!, height: parts[2]! };
      }
    }

    /* Props */
    const props: ImportProp[] = [];
    const rawProps = check.list(where, "props", rawScene.props, false) ?? [];
    rawProps.forEach((rawProp, index) => {
      let at = `${where} → 第 ${index + 1} 个道具`;
      if (!isObject(rawProp)) { check.add(at, "应为对象"); return; }
      const propName = check.name(at, rawProp.name);
      if (propName) at = `${where} → 道具“${propName}”`;
      check.keys(at, rawProp, ["id", "name", "type", "geometry", "position", "rotation", "size"]);
      const id = check.id(at, rawProp.id); claimId(at, id);
      const type = check.text(at, "type", rawProp.type, 40, true);
      let geometry: PropGeometry | undefined;
      if (rawProp.geometry !== undefined) {
        if (!(PROP_GEOMETRIES as readonly unknown[]).includes(rawProp.geometry)) check.add(at, `geometry 只能是 "box"（方盒）或 "plane"（平面），现在是 ${show(rawProp.geometry)}`);
        else geometry = rawProp.geometry as PropGeometry;
      }
      const position = check.vec3(at, "position", rawProp.position, -L.position, L.position, POSITION_UNIT);
      const rotation = check.vec3(at, "rotation", rawProp.rotation, -L.rotation, L.rotation, ROTATION_UNIT);
      const size = check.vec3(at, "size", rawProp.size, L.scaleMin, L.scaleMax, "米");
      if ((rotation || size) && rawProp.position === undefined) check.add(at, "写了 rotation 或 size 就要同时写 position（放在哪），否则道具不会放进白模");
      const away = position ? outsideRoom(room, position, 0.05) : null;
      if (away) check.add(at, `position 的 ${away}`);
      if (propName && type && position !== null && rotation !== null && size !== null && id !== null)
        props.push({ ...(id ? { id } : {}), name: propName, type, ...(geometry ? { geometry } : {}), ...(position ? { position } : {}), ...(rotation ? { rotation } : {}), ...(size ? { size } : {}) });
    });
    check.unique(where, "道具", rawProps.map((item) => isObject(item) && typeof item.name === "string" ? item.name.trim() : null));
    const propByName = new Map(props.map((prop) => [prop.name, prop]));
    const propNames = new Set(rawProps.map((item) => isObject(item) && typeof item.name === "string" ? item.name.trim() : "").filter(Boolean));

    /* Cameras */
    const cameras: ImportCamera[] = [];
    const rawCameras = check.list(where, "cameras", rawScene.cameras, false) ?? [];
    rawCameras.forEach((rawCamera, index) => {
      let at = `${where} → 第 ${index + 1} 台摄影机`;
      if (!isObject(rawCamera)) { check.add(at, "应为对象"); return; }
      const cameraName = check.name(at, rawCamera.name);
      if (cameraName) at = `${where} → 摄影机“${cameraName}”`;
      check.keys(at, rawCamera, ["id", "name", "note", "position", "rotation", "lookAt", "focalLength", "aspect"]);
      const id = check.id(at, rawCamera.id); claimId(at, id);
      const note = check.text(at, "note", rawCamera.note, 500, false);
      const position = check.vec3(at, "position", rawCamera.position, -L.position, L.position, POSITION_UNIT);
      const rotation = check.vec3(at, "rotation", rawCamera.rotation, -L.rotation, L.rotation, ROTATION_UNIT);
      const lookAt = check.vec3(at, "lookAt", rawCamera.lookAt, -L.position, L.position, POSITION_UNIT);
      if (rawCamera.rotation !== undefined && rawCamera.lookAt !== undefined) check.add(at, "rotation 和 lookAt 只写一个（推荐 lookAt：写摄影机看向的那个点）");
      if ((rawCamera.rotation !== undefined || rawCamera.lookAt !== undefined) && rawCamera.position === undefined) check.add(at, "写了朝向（rotation / lookAt）就要同时写 position");
      if (position && lookAt && !lookAtRotation(position, lookAt)) check.add(at, "lookAt 不能和 position 是同一个点，也不能在正上方或正下方（换一个稍有前后距离的点）");
      const away = position ? outsideRoom(room, position, -0.05) : null;
      if (away) check.add(at, `position 的 ${away.replace("放到房间外面了", "摄影机要在房间里面、离墙至少 5 厘米，不然拍到的是墙")}`);
      const focalLength = check.number(at, "focalLength", rawCamera.focalLength, L.focalMin, L.focalMax, false, "毫米，全画幅等效");
      let aspect: CameraAspect | undefined;
      if (rawCamera.aspect !== undefined) {
        if (!(CAMERA_ASPECTS as readonly unknown[]).includes(rawCamera.aspect)) check.add(at, `aspect 只能是 "9:16"（竖屏）或 "16:9"（横屏），现在是 ${show(rawCamera.aspect)}`);
        else aspect = rawCamera.aspect as CameraAspect;
      }
      if (cameraName && id !== null && note !== null && position !== null && rotation !== null && lookAt !== null && focalLength !== null)
        cameras.push({ ...(id ? { id } : {}), name: cameraName, ...(note !== undefined ? { note } : {}), ...(position ? { position } : {}), ...(rotation ? { rotation } : {}), ...(lookAt ? { lookAt } : {}), ...(focalLength !== undefined ? { focalLength } : {}), ...(aspect ? { aspect } : {}) });
    });
    check.unique(where, "摄影机", rawCameras.map((item) => isObject(item) && typeof item.name === "string" ? item.name.trim() : null));
    const cameraByName = new Map(cameras.map((camera) => [camera.name, camera]));
    const cameraNames = new Set(rawCameras.map((item) => isObject(item) && typeof item.name === "string" ? item.name.trim() : "").filter(Boolean));

    /* States */
    const states: ImportState[] = [];
    const rawStates = check.list(where, "states", rawScene.states, false) ?? [];
    rawStates.forEach((rawState, index) => {
      let at = `${where} → 第 ${index + 1} 个状态`;
      if (!isObject(rawState)) { check.add(at, "应为对象"); return; }
      const stateName = check.name(at, rawState.name);
      if (stateName) at = `${where} → 状态“${stateName}”`;
      check.keys(at, rawState, ["id", "name", "changes"]);
      const id = check.id(at, rawState.id); claimId(at, id);
      const changes: ImportState["changes"] = [];
      const seen = new Set<string>();
      let ok = true;
      (check.list(at, "changes", rawState.changes, false) ?? []).forEach((rawChange, changeIndex) => {
        const cat = `${at} → changes 第 ${changeIndex + 1} 项`;
        if (!isObject(rawChange)) { check.add(cat, "应为 { \"prop\": \"道具名\", \"description\": \"怎么变\" }"); ok = false; return; }
        check.keys(cat, rawChange, ["prop", "description"]);
        const prop = check.text(cat, "prop", rawChange.prop, 80, true);
        const description = rawChange.description === undefined ? "" : check.text(cat, "description", rawChange.description, 500, false);
        if (prop && !propNames.has(prop)) { check.add(cat, `prop 写的是“${prop}”，但这个场景的 props 里没有叫这个名字的道具${props.length ? `（现有：${props.map((item) => item.name).join("、")}）` : ""}`); ok = false; return; }
        if (prop && seen.has(prop)) { check.add(cat, `道具“${prop}”在同一状态里出现了两次，合成一条描述`); ok = false; return; }
        if (!prop || description === null) { ok = false; return; }
        seen.add(prop);
        changes.push({ prop, description: description ?? "" });
      });
      if (stateName && ok && id !== null) states.push({ ...(id ? { id } : {}), name: stateName, changes });
    });
    check.unique(where, "状态", rawStates.map((item) => isObject(item) && typeof item.name === "string" ? item.name.trim() : null));

    /* Motions */
    const motions: ImportMotion[] = [];
    const rawMotions = check.list(where, "motions", rawScene.motions, false) ?? [];
    rawMotions.forEach((rawMotion, index) => {
      let at = `${where} → 第 ${index + 1} 个动作`;
      if (!isObject(rawMotion)) { check.add(at, "应为对象"); return; }
      const motionName = check.name(at, rawMotion.name);
      if (motionName) at = `${where} → 动作“${motionName}”`;
      check.keys(at, rawMotion, ["id", "name", "target", "keyframes"]);
      const id = check.id(at, rawMotion.id); claimId(at, id);
      let target: ImportMotion["target"] | null = null;
      let targetSize: Vec3 | null = null;
      let targetPlaced = false;
      const rawTarget = rawMotion.target;
      if (!isObject(rawTarget) || Object.keys(rawTarget).length !== 1 || !("prop" in rawTarget || "camera" in rawTarget)) check.add(at, `target 必填，写 {"prop": "道具名"} 或 {"camera": "摄影机名"}（只写一个），现在是 ${show(rawTarget)}`);
      else if ("prop" in rawTarget) {
        const prop = String(rawTarget.prop ?? "").trim();
        if (!propNames.has(prop)) check.add(at, `target.prop 写的是“${prop}”，这个场景没有叫这个名字的道具`);
        else { target = { prop }; const found = propByName.get(prop); targetPlaced = Boolean(found?.position); targetSize = found ? propSize(found) : null; }
      } else {
        const camera = String(rawTarget.camera ?? "").trim();
        if (!cameraNames.has(camera)) check.add(at, `target.camera 写的是“${camera}”，这个场景没有叫这个名字的摄影机`);
        else { target = { camera }; targetPlaced = Boolean(cameraByName.get(camera)?.position); targetSize = [1, 1, 1]; }
      }
      const keyframes: ImportMotion["keyframes"] = [];
      let ok = true;
      const frames = new Set<number>();
      (check.list(at, "keyframes", rawMotion.keyframes, false) ?? []).forEach((rawKeyframe, keyIndex) => {
        const kat = `${at} → 第 ${keyIndex + 1} 个关键帧`;
        if (!isObject(rawKeyframe)) { check.add(kat, "应为 { \"frame\": 帧号, \"description\": \"这一帧的样子\" }"); ok = false; return; }
        check.keys(kat, rawKeyframe, ["frame", "description", "pose"]);
        const frame = check.number(kat, "frame", rawKeyframe.frame, MOTION_FRAME_RANGE.min, MOTION_FRAME_RANGE.max, true, "帧，24 帧 = 1 秒");
        if (frame === undefined) check.add(kat, "frame 必填（整数帧号，24 帧 = 1 秒）");
        const description = rawKeyframe.description === undefined ? "" : check.text(kat, "description", rawKeyframe.description, 500, false);
        if (typeof frame === "number") { if (frames.has(frame)) { check.add(kat, `frame ${frame} 在这个动作里出现了两次，同一动作帧号不能重复`); ok = false; } frames.add(frame); }
        let pose: ImportPose | undefined;
        if (rawKeyframe.pose !== undefined) {
          const pat = `${kat} → pose`;
          if (!isObject(rawKeyframe.pose)) { check.add(pat, "应为 { \"position\": [...], \"rotation\" 或 \"lookAt\": [...] }"); ok = false; }
          else {
            check.keys(pat, rawKeyframe.pose, ["position", "rotation", "lookAt", "size"]);
            const position = check.vec3(pat, "position", rawKeyframe.pose.position, -L.position, L.position, POSITION_UNIT);
            if (position === undefined) check.add(pat, "position 必填");
            const rotation = check.vec3(pat, "rotation", rawKeyframe.pose.rotation, -L.rotation, L.rotation, ROTATION_UNIT);
            const lookAt = check.vec3(pat, "lookAt", rawKeyframe.pose.lookAt, -L.position, L.position, POSITION_UNIT);
            const size = check.vec3(pat, "size", rawKeyframe.pose.size, L.scaleMin, L.scaleMax, "米");
            if (rawKeyframe.pose.rotation !== undefined && rawKeyframe.pose.lookAt !== undefined) check.add(pat, "rotation 和 lookAt 只写一个");
            if (position && lookAt && !lookAtRotation(position, lookAt)) check.add(pat, "lookAt 不能和 position 是同一个点，也不能在正上方或正下方");
            if (target && !targetPlaced) check.add(pat, "动作目标没有写 position（没放进白模），关键帧就不能带 pose；先给目标写 position，或去掉 pose");
            if (target && "camera" in target && rawKeyframe.pose.size !== undefined) check.add(pat, "摄影机的关键帧不写 size");
            if (position && rotation !== null && lookAt !== null && size !== null) pose = { position, ...(rotation ? { rotation } : {}), ...(lookAt ? { lookAt } : {}), ...(size ? { size } : (targetSize ? { size: targetSize } : {})) };
            else ok = false;
          }
        }
        if (typeof frame !== "number" || description === null) { ok = false; return; }
        keyframes.push({ frame, description: description ?? "", ...(pose ? { pose } : {}) });
      });
      if (motionName && target && ok && id !== null) motions.push({ ...(id ? { id } : {}), name: motionName, target, keyframes: [...keyframes].sort((a, b) => a.frame - b.frame) });
    });
    check.unique(where, "动作", rawMotions.map((item) => isObject(item) && typeof item.name === "string" ? item.name.trim() : null));

    /* Control packages */
    const controlPackages: ImportPackage[] = [];
    const rawPackages = check.list(where, "controlPackages", rawScene.controlPackages, false) ?? [];
    rawPackages.forEach((rawPackage, index) => {
      let at = `${where} → 第 ${index + 1} 个控制素材包`;
      if (!isObject(rawPackage)) { check.add(at, "应为对象"); return; }
      const packageName = check.name(at, rawPackage.name);
      if (packageName) at = `${where} → 控制素材包“${packageName}”`;
      check.keys(at, rawPackage, ["id", "name", "type", "assetIds", "anchorFrame"]);
      const id = check.id(at, rawPackage.id); claimId(at, id);
      if (!(CONTROL_PACKAGE_TYPES as readonly unknown[]).includes(rawPackage.type)) { check.add(at, `type 只能是 ${CONTROL_PACKAGE_TYPES.map((type) => `"${type}"（${CONTROL_PACKAGE_ASSET_RULES[type].label}）`).join("、")}，现在是 ${show(rawPackage.type)}`); return; }
      const type = rawPackage.type as ControlPackageType;
      const list = check.list(at, "assetIds", rawPackage.assetIds, false);
      if (list === null) return;
      if (list.some((item) => typeof item !== "string" || !item)) { check.add(at, "assetIds 里每一项都要是素材 ID（文字）"); return; }
      const assetIds = list as string[];
      if (assets) {
        const problem = controlPackageAssetProblem(type, assetIds.map((assetId) => ({ assetId, kind: assets.get(assetId) ?? null })));
        if (problem) { check.add(at, `${problem}（素材 ID 只能用画布素材库里已有的，AI 不能凭空编；不知道就写 []，导入后在导演台里绑定）`); return; }
      } else if (assetIds.length > CONTROL_PACKAGE_ASSET_RULES[type].max) { check.add(at, `${CONTROL_PACKAGE_ASSET_RULES[type].label}最多 ${CONTROL_PACKAGE_ASSET_RULES[type].max} 个素材`); return; }
      const anchorFrame = check.number(at, "anchorFrame", rawPackage.anchorFrame, ANCHOR_FRAME_RANGE.min, ANCHOR_FRAME_RANGE.max, true, "帧");
      if (anchorFrame === null) return;
      if (type === "guide" && anchorFrame === undefined) { check.add(at, `🧪 引导锚点（guide）必须写 anchorFrame（${ANCHOR_FRAME_RANGE.min}–${ANCHOR_FRAME_RANGE.max} 的整数帧号）`); return; }
      if (type !== "guide" && anchorFrame !== undefined) { check.add(at, "只有 type 为 \"guide\" 的包才写 anchorFrame，其他类型删掉它"); return; }
      if (packageName && id !== null) controlPackages.push({ ...(id ? { id } : {}), name: packageName, type, assetIds, ...(anchorFrame !== undefined ? { anchorFrame } : {}) });
    });
    check.unique(where, "控制素材包", rawPackages.map((item) => isObject(item) && typeof item.name === "string" ? item.name.trim() : null));

    if (name && sceneId !== null) scenes.push({ ...(sceneId ? { id: sceneId } : {}), name, ...(room ? { room } : {}), props, states, cameras, motions, controlPackages });
  });
  const seenScenes = new Set<string>();
  for (const name of sceneNames) if (name) { if (seenScenes.has(name)) check.add("最外层", `有两个场景都叫“${name}”，一份文件里场景名不能重复`); seenScenes.add(name); }
  if (check.errors.length) {
    if (check.errors.length >= MAX_ERRORS) check.errors.push(`……错误太多，只列出前 ${MAX_ERRORS} 条`);
    return { ok: false, errors: check.errors };
  }
  return { ok: true, document: { version: DIRECTOR_STAGE_FORMAT, scenes } };
}

/** Room bounds check (only when the scene has a room): catches centimetres and cameras outside the walls. */
function outsideRoom(room: Room | undefined, point: Vec3, margin: number): string | null {
  if (!room) return null;
  const halfW = room.width / 2 + margin, halfD = room.depth / 2 + margin;
  const axis = Math.abs(point[0]) > halfW ? `x = ${point[0]} 超出左右墙（±${room.width / 2}）` : Math.abs(point[2]) > halfD ? `z = ${point[2]} 超出前后墙（±${room.depth / 2}）` : point[1] < -margin || point[1] > room.height + margin ? `y = ${point[1]} 不在地面 0 到天花板 ${room.height} 之间` : null;
  return axis ? `${axis}，放到房间外面了（单位是米，是不是写成了厘米？）` : null;
}

function propSize(prop: ImportProp): Vec3 { return prop.size ?? ((prop.geometry ?? "box") === "plane" ? IMPORT_DEFAULTS.planeSize : IMPORT_DEFAULTS.boxSize); }

/* ── 写入计划 ─────────────────────────────────────────────────────── */

export type ConflictChoice = "overwrite" | "copy";
export interface ImportPlanItem {
  sourceName: string;
  action: "create" | "overwrite" | "copy";
  finalName: string;
  /** For overwrite: the Scene that will be replaced. */
  targetSceneId?: string;
  counts: { props: number; states: number; cameras: number; motions: number; controlPackages: number };
  /** Overwrite only: names of records that exist now but are not in the JSON (they will be deleted). */
  removed: string[];
  /** Overwrite only: auto-generated (Blender / SDXL) packages that are kept untouched. */
  keptGenerated: number;
  bundle: SceneBundle;
  previous?: SceneBundle;
}
export interface ImportPlan { items: ImportPlanItem[]; warnings: string[] }
/** Shot bindings, to warn when an overwrite would remove a record a Shot still uses. */
export type ShotBindingRef = { label: string; sceneId: string; ids: string[] };

/** Existing scenes the document would collide with (by id first, then by name). */
export function findConflicts(document: DirectorStageDocument, existing: ExistingScene[]) {
  return document.scenes.map((scene) => ({ name: scene.name, target: matchScene(scene, existing) })).filter((item): item is { name: string; target: ExistingScene } => Boolean(item.target));
}
function matchScene(scene: ImportScene, existing: ExistingScene[]) {
  return (scene.id ? existing.find((item) => item.scene.id === scene.id) : undefined) ?? [...existing].sort((a, b) => b.scene.updatedAt - a.scene.updatedAt).find((item) => item.scene.name === scene.name);
}
const bundleOf = (item: ExistingScene): SceneBundle => ({ scene: item.scene, props: item.props, states: item.states, cameras: item.cameras, motions: item.motions, controlPackages: item.packages });

function copyName(name: string, taken: Set<string>) {
  for (let index = 2; ; index += 1) { const candidate = `${name.slice(0, 70)}（导入 ${index}）`; if (!taken.has(candidate)) return candidate; }
}

/**
 * Turns a validated document into full Scene bundles. Records keep their ID (and createdAt) when the
 * JSON's `id` (or else the name) matches a record of the scene being overwritten; everything else gets
 * a new ID. IDs from the JSON are never used for a new or copied scene (they could belong to another scene).
 */
export function planDirectorStageImport(document: DirectorStageDocument, existing: ExistingScene[], choices: Record<string, ConflictChoice>, options: { now?: number; newId?: () => string; shots?: ShotBindingRef[] } = {}): ImportPlan {
  const now = options.now ?? Date.now();
  const newId = options.newId ?? (() => crypto.randomUUID());
  const takenNames = new Set(existing.map((item) => item.scene.name));
  const items: ImportPlanItem[] = [];
  const warnings: string[] = [];
  const stamp = (id: string, createdAt = now) => ({ schemaVersion: DIRECTOR_STAGE_SCHEMA_VERSION as typeof DIRECTOR_STAGE_SCHEMA_VERSION, id, createdAt, updatedAt: now });
  for (const source of document.scenes) {
    const target = matchScene(source, existing);
    const action: ImportPlanItem["action"] = target ? (choices[source.name] ?? "copy") === "overwrite" ? "overwrite" : "copy" : "create";
    const keep = action === "overwrite" ? target! : null;
    const finalName = action === "copy" ? copyName(source.name, takenNames) : source.name;
    takenNames.add(finalName);
    const reuse = <T extends { id: string; name: string; createdAt: number }>(rows: T[], wanted: { id?: string; name: string }) => keep ? (wanted.id ? rows.find((row) => row.id === wanted.id) : undefined) ?? rows.find((row) => row.name === wanted.name) : undefined;
    const used = new Set<string>();
    const pick = <T extends { id: string; name: string; createdAt: number }>(rows: T[], wanted: { id?: string; name: string }) => { const found = reuse(rows.filter((row) => !used.has(row.id)), wanted); if (found) used.add(found.id); return found ? stamp(found.id, found.createdAt) : stamp(newId()); };
    const sceneId = keep ? keep.scene.id : newId();
    const scene: Scene = { ...stamp(sceneId, keep?.scene.createdAt), name: finalName, ...(source.room ? { room: source.room } : {}) };

    const props: Prop[] = source.props.map((prop) => {
      const placed = Boolean(prop.position);
      const geometry = placed ? prop.geometry ?? "box" : prop.geometry;
      const transform: Transform | undefined = placed ? { position: prop.position!, rotation: prop.rotation ?? (geometry === "plane" ? [-90, 0, 0] : [0, 0, 0]), scale: propSize({ ...prop, geometry }) } : undefined;
      return { ...pick(keep?.props ?? [], prop), sceneId, name: prop.name, type: prop.type, ...(geometry ? { geometry } : {}), ...(transform ? { transform } : {}) };
    });
    const propId = new Map(props.map((prop) => [prop.name, prop.id]));
    const cameras: Camera[] = source.cameras.map((camera) => {
      const transform: Transform | undefined = camera.position ? { position: camera.position, rotation: camera.lookAt ? lookAtRotation(camera.position, camera.lookAt)! : camera.rotation ?? [0, 0, 0], scale: [1, 1, 1] } : undefined;
      return { ...pick(keep?.cameras ?? [], camera), sceneId, name: camera.name, ...(camera.note !== undefined ? { note: camera.note } : {}), ...(transform ? { transform } : {}),
        ...(camera.focalLength !== undefined ? { focalLength: camera.focalLength } : transform ? { focalLength: IMPORT_DEFAULTS.focalLength } : {}),
        ...(camera.aspect ? { aspect: camera.aspect } : transform ? { aspect: IMPORT_DEFAULTS.aspect } : {}) };
    });
    const cameraId = new Map(cameras.map((camera) => [camera.name, camera.id]));
    const states: SceneState[] = source.states.map((state) => ({ ...pick(keep?.states ?? [], state), sceneId, name: state.name, propChanges: state.changes.map((change) => ({ propId: propId.get(change.prop)!, description: change.description })) }));
    const motions: Motion[] = source.motions.map((motion) => {
      const isCamera = "camera" in motion.target;
      const keyframes: MotionKeyframe[] = motion.keyframes.map((keyframe) => {
        if (!keyframe.pose) return { frame: keyframe.frame, description: keyframe.description };
        const pose = keyframe.pose;
        return { frame: keyframe.frame, description: keyframe.description, transform: { position: pose.position, rotation: pose.lookAt ? lookAtRotation(pose.position, pose.lookAt)! : pose.rotation ?? [0, 0, 0], scale: isCamera ? [1, 1, 1] : pose.size ?? [1, 1, 1] } };
      });
      return { ...pick(keep?.motions ?? [], motion), sceneId, name: motion.name, targetType: isCamera ? "camera" : "prop", targetId: isCamera ? cameraId.get((motion.target as { camera: string }).camera)! : propId.get((motion.target as { prop: string }).prop)!, keyframes };
    });
    const generated = keep ? keep.packages.filter((pack) => pack.render) : [];
    const generatedNames = new Set(generated.map((pack) => pack.name));
    const clash = source.controlPackages.find((pack) => generatedNames.has(pack.name));
    if (clash) warnings.push(`场景“${finalName}”：控制素材包“${clash.name}”和自动生成的同名包重名，导入的那个会另外新建一个，自动生成的原样保留`);
    const controlPackages: ControlPackage[] = [
      ...source.controlPackages.map((pack) => ({ ...pick(keep?.packages.filter((row) => !row.render) ?? [], pack), sceneId, name: pack.name, type: pack.type, assetIds: pack.assetIds, ...(pack.anchorFrame !== undefined ? { anchorFrame: pack.anchorFrame } : {}) })),
      ...generated,
    ];
    const bundle: SceneBundle = { scene, props, states, cameras, motions, controlPackages };
    const removed: string[] = [];
    if (keep) {
      const kept = new Set([...props, ...states, ...cameras, ...motions, ...controlPackages].map((row) => row.id));
      const label: [keyof ExistingScene, string][] = [["props", "道具"], ["states", "状态"], ["cameras", "摄影机"], ["motions", "动作"], ["packages", "控制素材包"]];
      for (const [key, what] of label) for (const row of keep[key] as { id: string; name: string }[]) if (!kept.has(row.id)) removed.push(`${what}“${row.name}”`);
      const removedIds = new Set(label.flatMap(([key]) => (keep[key] as { id: string }[]).map((row) => row.id)).filter((id) => !kept.has(id)));
      for (const shot of options.shots ?? []) if (shot.sceneId === keep.scene.id && shot.ids.some((id) => removedIds.has(id))) warnings.push(`${shot.label} 绑定的机位 / 状态 / 动作 / 素材包有的会被删掉，覆盖后请在导演台里重新绑定这个镜头`);
    }
    items.push({ sourceName: source.name, action, finalName, ...(keep ? { targetSceneId: keep.scene.id } : {}), counts: { props: props.length, states: states.length, cameras: cameras.length, motions: motions.length, controlPackages: source.controlPackages.length }, removed, keptGenerated: generated.length, bundle, ...(keep ? { previous: bundleOf(keep) } : {}) });
  }
  return { items, warnings };
}

/** Human summary of a plan for the confirm dialog. */
export function describeImportPlan(plan: ImportPlan): string[] {
  const lines = plan.items.map((item) => {
    const { props, states, cameras, motions, controlPackages } = item.counts;
    const what = `${props} 个道具、${states} 个状态、${cameras} 台摄影机、${motions} 个动作、${controlPackages} 个控制素材包`;
    if (item.action === "create") return `新建场景“${item.finalName}”：${what}`;
    if (item.action === "copy") return `另存为新场景“${item.finalName}”（原“${item.sourceName}”不动）：${what}`;
    return `覆盖场景“${item.finalName}”：改成 ${what}${item.removed.length ? `；会删掉 JSON 里没有的 ${item.removed.join("、")}` : ""}${item.keptGenerated ? `；${item.keptGenerated} 个自动生成的素材包保留不动` : ""}`;
  });
  return [...lines, ...plan.warnings.map((warning) => `⚠ ${warning}`)];
}

/* ── 导出 ─────────────────────────────────────────────────────────── */

/**
 * Existing scenes → director-stage-v1. Records keep their `id`, so importing the export back (overwrite)
 * updates the same records. Auto-generated packages (with render metadata) are left out: they can only be made by
 * rendering, and overwriting keeps them anyway. Duplicate names inside a scene get a 「（2）」 suffix so the file is valid.
 */
export function exportDirectorStage(scenes: ExistingScene[]): { document: DirectorStageDocument; notes: string[] } {
  const notes: string[] = [];
  const sceneNames = new Set<string>();
  const out: ImportScene[] = scenes.map((item) => {
    let sceneName = item.scene.name;
    if (sceneNames.has(sceneName)) { sceneName = uniqueName(sceneName, sceneNames); notes.push(`有同名场景，“${item.scene.name}”导出时改叫“${sceneName}”`); }
    sceneNames.add(sceneName);
    const nameOf = <T extends { id: string; name: string }>(rows: T[], what: string) => {
      const used = new Set<string>(); const map = new Map<string, string>();
      for (const row of rows) { let name = row.name; if (used.has(name)) { name = uniqueName(name, used); notes.push(`场景“${sceneName}”有两个${what}都叫“${row.name}”，导出时第二个改叫“${name}”`); } used.add(name); map.set(row.id, name); }
      return map;
    };
    const propNames = nameOf(item.props, "道具"), cameraNames = nameOf(item.cameras, "摄影机"), stateNames = nameOf(item.states, "状态"), motionNames = nameOf(item.motions, "动作");
    const manual = item.packages.filter((pack) => !pack.render);
    const packageNames = nameOf(manual, "控制素材包");
    const skipped = item.packages.length - manual.length;
    if (skipped) notes.push(`场景“${sceneName}”有 ${skipped} 个自动生成的控制素材包（白模首帧 / 控制组 / 写实首帧）没有导出，覆盖导入时它们原样保留`);
    const motions: ImportMotion[] = [];
    for (const motion of item.motions) {
      const targetName = motion.targetType === "camera" ? cameraNames.get(motion.targetId) : propNames.get(motion.targetId);
      if (!targetName) { notes.push(`场景“${sceneName}”的动作“${motion.name}”的目标已经不存在，没有导出`); continue; }
      const prop = motion.targetType === "prop" ? item.props.find((row) => row.id === motion.targetId) : undefined;
      if (motion.keyframes.some((keyframe) => keyframe.transform) && (motion.targetType === "camera" ? !item.cameras.find((row) => row.id === motion.targetId)?.transform : !prop?.transform)) {
        notes.push(`场景“${sceneName}”的动作“${motion.name}”的目标没放进白模，关键帧的位置没有导出`);
      }
      const targetPlaced = motion.targetType === "camera" ? Boolean(item.cameras.find((row) => row.id === motion.targetId)?.transform) : Boolean(prop?.transform);
      motions.push({ id: motion.id, name: motionNames.get(motion.id)!, target: motion.targetType === "camera" ? { camera: targetName } : { prop: targetName },
        keyframes: motion.keyframes.map((keyframe) => ({ frame: keyframe.frame, description: keyframe.description, ...(keyframe.transform && targetPlaced ? { pose: { position: keyframe.transform.position, rotation: keyframe.transform.rotation, ...(motion.targetType === "prop" ? { size: keyframe.transform.scale } : {}) } } : {}) })) });
    }
    return {
      id: item.scene.id, name: sceneName, ...(item.scene.room ? { room: item.scene.room } : {}),
      props: item.props.map((prop) => ({ id: prop.id, name: propNames.get(prop.id)!, type: prop.type, ...(prop.geometry ? { geometry: prop.geometry } : {}), ...(prop.transform && prop.geometry ? { position: prop.transform.position, rotation: prop.transform.rotation, size: prop.transform.scale } : {}) })),
      states: item.states.map((state) => ({ id: state.id, name: stateNames.get(state.id)!, changes: state.propChanges.filter((change) => propNames.has(change.propId)).map((change) => ({ prop: propNames.get(change.propId)!, description: change.description })) })),
      cameras: item.cameras.map((camera) => ({ id: camera.id, name: cameraNames.get(camera.id)!, ...(camera.note !== undefined ? { note: camera.note } : {}), ...(camera.transform ? { position: camera.transform.position, rotation: camera.transform.rotation } : {}), ...(camera.focalLength !== undefined ? { focalLength: camera.focalLength } : {}), ...(camera.aspect ? { aspect: camera.aspect } : {}) })),
      motions,
      controlPackages: manual.map((pack) => ({ id: pack.id, name: packageNames.get(pack.id)!, type: pack.type, assetIds: pack.assetIds, ...(pack.anchorFrame !== undefined ? { anchorFrame: pack.anchorFrame } : {}) })),
    };
  });
  return { document: { version: DIRECTOR_STAGE_FORMAT, scenes: out }, notes };
}
function uniqueName(name: string, taken: Set<string>) { for (let index = 2; ; index += 1) { const candidate = `${name.slice(0, 74)}（${index}）`; if (!taken.has(candidate)) return candidate; } }
