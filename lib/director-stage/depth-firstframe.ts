import { runSdxlDepthFirstFrame, sdxlDepthSettings, type SdxlDepthOptions } from "../comfyui/sdxl-depth-firstframe.ts";
import type { ControlPackage, ControlRender } from "./schema.ts";
import { createControlPackage } from "./store.ts";
import { clip, decodeBase64, loadJob, pad, requestRender, stamp, type BlenderCameraRecord, type ImportedImageAsset, type WhiteboxFirstFrameDeps } from "./whitebox-firstframe.ts";

/**
 * Depth 写实首帧 V0.1: Scene + Camera → Blender (RGB + depth, same run) → depth.png registered as an image Asset
 * with a depth ControlPackage → SDXL_DEPTH_FIRSTFRAME_V0.1 on the local ComfyUI → realistic still registered as
 * an image Asset with an ordinary first_frame ControlPackage (so 发送到 H3 / Shot use it unchanged).
 * Both packages carry their render metadata (same groupId); the first frame also records the SDXL generator.
 */

export type DepthFirstFrameDeps = WhiteboxFirstFrameDeps & {
  comfy?: SdxlDepthOptions; random?: () => number;
  /** Internal Motion entry: frozen in-memory job, never written into base placement records. */
  snapshot?: Awaited<ReturnType<typeof loadJob>>;
  guideSource?: NonNullable<ControlRender["motion"]>;
};
export type DepthFirstFrameResult = {
  groupId: string; seed: number; seconds: number;
  depth: { asset: ImportedImageAsset; controlPackage: ControlPackage; file: File };
  firstFrame: { asset: ImportedImageAsset; controlPackage: ControlPackage; file: File };
  record: BlenderCameraRecord;
};

export async function generateDepthFirstFrame(sceneId: string, cameraId: string, description: string, deps: DepthFirstFrameDeps): Promise<DepthFirstFrameResult> {
  const started = Date.now();
  const { scene, job } = deps.snapshot ?? await loadJob(sceneId, cameraId);
  const camera = job.director.cameras[0];
  deps.comfy?.onStage?.("Blender 渲染深度图");
  const body = await requestRender({ ...job, controls: ["depth"] }, deps);
  const depthRecord = body.camera.controls?.depth;
  if (!body.controls?.depth || !depthRecord) throw new Error("Blender 没有返回深度图");

  const date = (deps.now ?? (() => new Date()))();
  const groupId = crypto.randomUUID();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const base = `${clip(scene.name, 24)}_${clip(camera.name, 16)}_${stamp(date)}${deps.guideSource ? `_f${deps.guideSource.frame}` : ""}`;
  const visible = (body.camera.framing ?? []).filter((row) => row.visible).map((row) => ({ propId: row.propId, name: row.name ?? row.propId }));
  const common = { groupId, sceneId, cameraId, renderedAt: date.getTime(), width: body.camera.render.width, height: body.camera.render.height, blenderVersion: body.camera.render.blenderVersion ?? "", sourceObjects: visible, includesRoom: Boolean(scene.room), ...(deps.guideSource ? { motion: deps.guideSource } : {}) };

  // 1. The depth control image itself (traceable source of the first frame).
  const depthFile = new File([decodeBase64(body.controls.depth)], `白模控制_${base}_depth.png`, { type: "image/png", lastModified: date.getTime() });
  const depthAsset = await deps.importImage(depthFile);
  const depthRender: ControlRender = { ...common, pass: "depth", engine: body.camera.controls?.engine ?? "CYCLES", depthRange: { nearM: depthRecord.nearM, farM: depthRecord.farM, encoding: depthRecord.encoding } };
  const depthPackage = await createControlPackage({ sceneId, name: clip(`深度 · ${camera.name} · ${time}`, 80), type: "depth", assetIds: [depthAsset.assetId], render: depthRender });

  // 2. SDXL realistic still from that depth image (same pixels).
  const seed = Math.floor((deps.random ?? Math.random)() * (2 ** 31 - 1));
  let sdxl;
  try {
    sdxl = await runSdxlDepthFirstFrame(depthFile, { prompt: description, seed, width: common.width, height: common.height }, deps.comfy);
  } catch (cause) {
    throw new Error(`深度图已登记（深度包“${depthPackage.name}”），但 SDXL 写实首帧失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const settings = sdxlDepthSettings();
  const realisticFile = new File([sdxl.image], `写实首帧_${base}.png`, { type: "image/png", lastModified: Date.now() });
  const realisticAsset = await deps.importImage(realisticFile);
  let firstPackage: ControlPackage;
  try {
    firstPackage = await createControlPackage({
      sceneId, name: clip(deps.guideSource ? `写实锚点 · f${deps.guideSource.frame} · ${camera.name} · ${time}` : `写实首帧 · ${camera.name} · ${time}`, 80), type: deps.guideSource ? "guide" : "first_frame", ...(deps.guideSource ? { anchorFrame: deps.guideSource.frame } : {}), assetIds: [realisticAsset.assetId],
      render: { ...common, pass: "sdxl_first_frame", renderedAt: Date.now(), engine: `SDXL ${settings.checkpoint} + ${settings.controlNet} (${settings.controlType})`, depthRange: depthRender.depthRange, generator: { ...settings, templateSha: sdxl.templateSha, seed: sdxl.seed, prompt: sdxl.prompt, comfyPromptId: sdxl.promptId, sourceDepthPackageId: depthPackage.id, sourceDepthAssetId: depthAsset.assetId } },
    });
  } catch (cause) {
    throw new Error(`写实首帧已登记为素材“${realisticAsset.filename}”，但创建首帧包失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return {
    groupId, seed: sdxl.seed, seconds: Math.round((Date.now() - started) / 100) / 10, record: body.camera,
    depth: { asset: depthAsset, controlPackage: depthPackage, file: depthFile },
    firstFrame: { asset: realisticAsset, controlPackage: firstPackage, file: realisticFile },
  };
}
