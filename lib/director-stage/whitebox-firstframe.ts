import type { Camera, ControlPackage, ControlPackageType, ControlRender, Prop, Scene } from "./schema.ts";
import { createControlPackage, getScene, listCameras, listProps } from "./store.ts";

/**
 * 一键白模首帧 V0.2: current Scene + chosen Camera → background Blender render on the local dev server
 * (/__blender_render, tools/blender/whitebox_render.py) → rgb.png → registered as an image Asset through
 * the canvas' normal import → a first_frame ControlPackage referencing it. Scene / Prop / Camera records
 * are only read; the package is an ordinary one, so the existing 发送到 H3 flow uses it unchanged.
 */

export const BLENDER_RENDER_PATH = "/__blender_render";
/** 720×1280 (9:16) / 1280×720 (16:9): above H3's 0.5–1 MP budgets, exact aspect. */
export const WHITEBOX_FIRST_FRAME_LONG_SIDE = 1280;

export type ImportedImageAsset = { assetId: string; filename: string };
export type WhiteboxFirstFrameDeps = {
  /** Registers the PNG as an image Asset (the canvas passes its Asset Library import). */
  importImage: (file: File) => Promise<ImportedImageAsset>;
  fetch?: typeof fetch;
  /** Prefix for the render route (tests point it at their own server). */
  baseUrl?: string;
  now?: () => Date;
};
/** camera.json "controls" section (高级控制素材 V0.1), written by whitebox_render.py --controls. */
export type BlenderControlsRecord = {
  engine: string; renderedAt: string; width: number; height: number; seconds: number;
  depth?: { file: string; nearM: number; farM: number; encoding: string; sources: string[] };
  mask?: { file: string; encoding: string; propIds: string[]; pixels: number };
  objectId?: { file: string; background: number[]; objects: { propId: string; name: string; index: number; color: [number, number, number]; pixels: number }[] };
};
export type BlenderCameraRecord = { format: string; render: { width: number; height: number; seconds: number; blenderVersion?: string }; camera: { id: string; name?: string; focalLength: number; aspect: string }; controls?: BlenderControlsRecord | null; framing?: { propId: string; name?: string; visible?: boolean }[]; [key: string]: unknown };
export type WhiteboxFirstFrameResult = { asset: ImportedImageAsset; controlPackage: ControlPackage; file: File; record: BlenderCameraRecord };

/** Cameras the button can use: placed in the 3D white box. */
export const placedCameras = (cameras: Camera[]) => cameras.filter((camera) => camera.transform);

/** director-stage.json payload holding just this Scene (the Blender script reads the same shape as a backup). */
export function buildRenderJob(scene: Scene, props: Prop[], cameras: Camera[], cameraId: string) {
  const camera = cameras.find((row) => row.id === cameraId);
  if (!camera || camera.sceneId !== scene.id) throw new Error("请选择这个场景里的摄影机");
  if (!camera.transform) throw new Error(`摄影机“${camera.name}”还没有放入 3D 白模，请先在白模导演台里放置机位`);
  return {
    director: { databaseVersion: 1, scenes: [scene], props: props.filter((prop) => prop.sceneId === scene.id), states: [], cameras: [camera], motions: [], controlPackages: [] },
    sceneId: scene.id, cameraId, longSide: WHITEBOX_FIRST_FRAME_LONG_SIDE,
  };
}

export const pad = (value: number) => String(value).padStart(2, "0");
export const stamp = (date: Date) => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function decodeBase64(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function blenderStatus(deps: Pick<WhiteboxFirstFrameDeps, "fetch" | "baseUrl"> = {}): Promise<{ available: boolean; build: string | null; reachable: boolean }> {
  try {
    const response = await (deps.fetch ?? fetch)(`${deps.baseUrl ?? ""}${BLENDER_RENDER_PATH}/status`, { cache: "no-store" });
    if (!response.ok) return { available: false, build: null, reachable: false };
    const body = await response.json() as { available?: boolean; build?: string | null };
    return { available: Boolean(body.available), build: body.build ?? null, reachable: true };
  } catch { return { available: false, build: null, reachable: false }; }
}

type RenderBody = { png: string; camera: BlenderCameraRecord; controls?: { depth?: string; mask?: string; objectId?: string } };

/** POST one render job to the local bridge; the errors are the ones the panel shows. */
export async function requestRender(job: object, deps: Pick<WhiteboxFirstFrameDeps, "fetch" | "baseUrl">): Promise<RenderBody> {
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${deps.baseUrl ?? ""}${BLENDER_RENDER_PATH}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(job) });
  } catch { throw new Error("无法连接本地白模渲染服务（需要用本地开发服务器打开画布）"); }
  const body = await response.json().catch(() => null) as (Partial<RenderBody> & { message?: string }) | null;
  if (!response.ok || !body?.png || !body.camera) throw new Error(body?.message ?? (response.status === 404 ? "当前服务器没有白模渲染功能（需要本地开发服务器）" : `白模渲染失败（HTTP ${response.status}）`));
  return body as RenderBody;
}

export async function loadJob(sceneId: string, cameraId: string) {
  const scene = await getScene(sceneId);
  if (!scene) throw new Error("场景不存在");
  const [props, cameras] = await Promise.all([listProps(sceneId), listCameras(sceneId)]);
  return { scene, job: buildRenderJob(scene, props, cameras, cameraId) };
}

export async function generateWhiteboxFirstFrame(sceneId: string, cameraId: string, deps: WhiteboxFirstFrameDeps): Promise<WhiteboxFirstFrameResult> {
  const { scene, job } = await loadJob(sceneId, cameraId);
  const camera = job.director.cameras[0];
  const body = await requestRender(job, deps);

  const date = (deps.now ?? (() => new Date()))();
  const file = new File([decodeBase64(body.png)], `白模首帧_${clip(scene.name, 24)}_${clip(camera.name, 16)}_${stamp(date)}.png`, { type: "image/png", lastModified: date.getTime() });
  const asset = await deps.importImage(file);
  let controlPackage: ControlPackage;
  try {
    controlPackage = await createControlPackage({ sceneId, name: clip(`白模首帧 · ${camera.name} · ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`, 80), type: "first_frame", assetIds: [asset.assetId] });
  } catch (cause) {
    throw new Error(`白模图已登记为素材“${asset.filename}”，但创建首帧包失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return { asset, controlPackage, file, record: body.camera };
}

/* ── 高级控制素材 V0.1: RGB + Depth + Mask + Object ID from one render ─────────────── */

export const WHITEBOX_CONTROL_PASSES = ["rgb", "depth", "mask", "object_id"] as const;
export type WhiteboxControlPass = (typeof WHITEBOX_CONTROL_PASSES)[number];
const PASS_PACKAGE: Record<WhiteboxControlPass, { type: ControlPackageType; label: string; file: string }> = {
  rgb: { type: "first_frame", label: "白模首帧", file: "rgb" },
  depth: { type: "depth", label: "深度", file: "depth" },
  mask: { type: "mask", label: "遮罩", file: "mask" },
  object_id: { type: "object_id", label: "物体ID", file: "object-id" },
};
export type WhiteboxControlItem = { pass: WhiteboxControlPass; asset: ImportedImageAsset; controlPackage: ControlPackage; file: File };
export type WhiteboxControlsResult = { groupId: string; items: WhiteboxControlItem[]; record: BlenderCameraRecord };

/** Render metadata of each output (Scene / Camera / source Props / time) as stored on its ControlPackage. */
export function controlRenders(groupId: string, sceneId: string, cameraId: string, record: BlenderCameraRecord, renderedAt: number, hasRoom: boolean): Record<WhiteboxControlPass, ControlRender> {
  const controls = record.controls;
  if (!controls?.depth || !controls.mask || !controls.objectId) throw new Error("Blender 没有返回完整的控制图记录");
  const objects = controls.objectId.objects;
  const visible = objects.filter((object) => object.pixels > 0).map(({ propId, name, pixels }) => ({ propId, name, pixels }));
  const common = { groupId, sceneId, cameraId, renderedAt, width: controls.width, height: controls.height, blenderVersion: record.render.blenderVersion ?? "" };
  return {
    rgb: { ...common, pass: "rgb", sourceObjects: visible, includesRoom: hasRoom, engine: "BLENDER_WORKBENCH" },
    depth: { ...common, pass: "depth", sourceObjects: visible, includesRoom: hasRoom, engine: controls.engine, depthRange: { nearM: controls.depth.nearM, farM: controls.depth.farM, encoding: controls.depth.encoding } },
    mask: { ...common, pass: "mask", sourceObjects: visible.filter((object) => controls.mask!.propIds.includes(object.propId)), includesRoom: false, engine: controls.engine },
    object_id: { ...common, pass: "object_id", sourceObjects: objects.map(({ propId, name, index, color, pixels }) => ({ propId, name, index, color, pixels })), includesRoom: false, engine: controls.engine },
  };
}

/**
 * One Blender run → rgb / depth / mask / object-id of the same Scene + Camera → four image Assets (the canvas'
 * normal import) → four ControlPackages (first_frame + depth / mask / object_id) carrying their render metadata.
 * Only generation, registration and management: nothing here touches H3.
 */
export async function generateWhiteboxControls(sceneId: string, cameraId: string, deps: WhiteboxFirstFrameDeps): Promise<WhiteboxControlsResult> {
  const { scene, job } = await loadJob(sceneId, cameraId);
  const camera = job.director.cameras[0];
  const body = await requestRender({ ...job, controls: ["depth", "mask", "object-id"] }, deps);
  if (!body.controls?.depth || !body.controls.mask || !body.controls.objectId) throw new Error("Blender 没有返回全部控制图");
  const date = (deps.now ?? (() => new Date()))();
  const groupId = crypto.randomUUID();
  const renders = controlRenders(groupId, sceneId, cameraId, body.camera, date.getTime(), Boolean(scene.room));
  const data: Record<WhiteboxControlPass, string> = { rgb: body.png, depth: body.controls.depth, mask: body.controls.mask, object_id: body.controls.objectId };
  const base = `白模控制_${clip(scene.name, 24)}_${clip(camera.name, 16)}_${stamp(date)}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

  const imported: { pass: WhiteboxControlPass; asset: ImportedImageAsset; file: File }[] = [];
  for (const pass of WHITEBOX_CONTROL_PASSES) {
    const file = new File([decodeBase64(data[pass])], `${base}_${PASS_PACKAGE[pass].file}.png`, { type: "image/png", lastModified: date.getTime() });
    imported.push({ pass, asset: await deps.importImage(file), file });
  }
  const items: WhiteboxControlItem[] = [];
  try {
    for (const { pass, asset, file } of imported) {
      const controlPackage = await createControlPackage({ sceneId, name: clip(`${PASS_PACKAGE[pass].label} · ${camera.name} · ${time}`, 80), type: PASS_PACKAGE[pass].type, assetIds: [asset.assetId], render: renders[pass] });
      items.push({ pass, asset, controlPackage, file });
    }
  } catch (cause) {
    throw new Error(`4 张控制图已登记为素材，但创建控制素材包失败（已创建 ${items.length} 个）：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return { groupId, items, record: body.camera };
}
