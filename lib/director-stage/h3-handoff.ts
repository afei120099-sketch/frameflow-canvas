import type { DirectorRunContext, ShotDirectorBinding } from "../production-records.ts";
import { controlPackageAssetProblem, type Camera, type ControlPackage, type Motion, type SceneState } from "./schema.ts";

/**
 * Director Stage → H3 hand-off V0.1 (pure, no canvas / network).
 *
 * Control Packages are turned into the inputs the existing H3 node already understands:
 *   first_frame → first-frame image, last_frame → last-frame image,
 *   reference   → reference images (connected) / videos / audios,
 *   guide       → 🧪 AddGuide anchors (experimental; I2VA only, sorted by anchorFrame).
 * The H3 node, workflow templates, adapter and Prompt Compiler are used unchanged; this module only
 * validates the combination up front (same rules the H3 node enforces) and carries the IDs that
 * end up in Run.directorContext.
 */

export interface HandoffAsset { assetId: string; kind: "image" | "video" | "audio"; storageReference: string; filename: string; width?: number; height?: number }

export interface H3HandoffRequest {
  sceneId: string;
  sceneStateId: string | null;
  firstFramePackage: ControlPackage | null;
  lastFramePackage: ControlPackage | null;
  referencePackage: ControlPackage | null;
  /** 🧪 AddGuide anchors; any order (sorted here by anchorFrame). */
  guidePackages?: ControlPackage[];
  /** Shot System V0.1: recorded on the node / Run only (H3 does not use them). */
  cameraId?: string | null;
  motionIds?: string[];
}

/** One 🧪 AddGuide anchor as stored on the H3 node. */
export interface DirectorGuide { packageId: string; assetId: string; storageReference: string; filename: string; anchorFrame: number }

/** Stored on the H3 node (tldraw props), then copied into every Run that node submits. */
export interface DirectorNodeContext { sceneId: string; sceneStateId?: string; controlPackageIds: string[]; assetIds: string[]; guides?: DirectorGuide[]; cameraId?: string; motionIds?: string[] }

export interface H3HandoffPlan {
  firstFrame: HandoffAsset | null;
  lastFrame: HandoffAsset | null;
  referenceImages: HandoffAsset[];
  referenceVideos: HandoffAsset[];
  referenceAudios: HandoffAsset[];
  /** 🧪 AddGuide anchors in frame order (empty when none). */
  guides: DirectorGuide[];
  /** What the H3 node will resolve to with exactly these inputs ("i2va_guide" = 🧪 I2VA + AddGuide). */
  expectedMode: "i2va" | "fl2va" | "ref2va" | "i2va_guide";
  context: DirectorNodeContext;
  /** Only Motion-generated guides specify a length; old hand-offs stay unchanged. */
  generationLength?: number;
}

/** Same ceilings as the Reference Manifest (H3_REF_LIMITS); the first frame counts as a Picture in Ref2VA. */
const LIMITS = { pictures: 9, videos: 3, audios: 3, guides: 4 } as const;

export function planH3Handoff(request: H3HandoffRequest, states: SceneState[], lookupAsset: (assetId: string) => HandoffAsset | null): H3HandoffPlan {
  const { firstFramePackage: first, lastFramePackage: last, referencePackage: reference } = request;
  const guidePackages = request.guidePackages ?? [];
  const slots: [ControlPackage | null, ControlPackage["type"], string][] = [[first, "first_frame", "首帧"], [last, "last_frame", "尾帧"], [reference, "reference", "参考"], ...guidePackages.map((pack) => [pack, "guide", "引导锚点"] as [ControlPackage, ControlPackage["type"], string])];
  for (const [pack, type, label] of slots) {
    if (!pack) continue;
    if (pack.sceneId !== request.sceneId) throw new Error(`${label}包“${pack.name}”不属于当前场景`);
    if (pack.type !== type) throw new Error(`“${pack.name}”不是${label}类型的控制素材包`);
  }
  if (last && !first) throw new Error("选择尾帧包时需要同时选择首帧包（仅尾帧生成尚未接入）");
  if (!first && !reference) throw new Error(guidePackages.length ? "🧪 引导锚点需要同时选择首帧包" : "请至少选择一个首帧包或参考包");
  if (last && reference) throw new Error("多参考模式暂不支持同时锁定尾帧（🧪 Hybrid 未启用），请去掉尾帧包或参考包");
  if (guidePackages.length && (last || reference)) throw new Error("🧪 引导锚点目前只支持“首帧 + 引导锚点”（I2VA）：请去掉尾帧包和参考包");
  if (request.sceneStateId && !states.some((state) => state.id === request.sceneStateId && state.sceneId === request.sceneId)) throw new Error("所选状态不属于当前场景");

  const resolve = (pack: ControlPackage) => {
    const assets = pack.assetIds.map((assetId) => ({ assetId, asset: lookupAsset(assetId) }));
    const problem = controlPackageAssetProblem(pack.type, assets.map(({ assetId, asset }) => ({ assetId, kind: asset?.kind ?? null })));
    if (problem) throw new Error(`“${pack.name}”：${problem}`);
    return assets.map(({ asset }) => asset!);
  };
  const frame = (pack: ControlPackage | null, label: string) => {
    if (!pack) return null;
    if (pack.assetIds.length !== 1) throw new Error(`${label}包“${pack.name}”需要绑定 1 张图片`);
    return resolve(pack)[0];
  };
  const firstFrame = frame(first, "首帧");
  const lastFrame = frame(last, "尾帧");
  const references = reference ? resolve(reference) : [];
  if (reference && !references.length) throw new Error(`参考包“${reference.name}”还没有绑定素材`);
  const referenceImages = references.filter((asset) => asset.kind === "image");
  const referenceVideos = references.filter((asset) => asset.kind === "video");
  const referenceAudios = references.filter((asset) => asset.kind === "audio");
  const pictures = referenceImages.length + (firstFrame && reference ? 1 : 0);
  if (pictures > LIMITS.pictures) throw new Error(`参考图（含首帧）共 ${pictures} 张，超过 H3 上限 ${LIMITS.pictures} 张`);
  if (referenceVideos.length > LIMITS.videos) throw new Error(`参考视频超过 H3 上限 ${LIMITS.videos} 个`);
  if (referenceAudios.length > LIMITS.audios) throw new Error(`参考声音超过 H3 上限 ${LIMITS.audios} 条`);

  if (guidePackages.length > LIMITS.guides) throw new Error(`🧪 引导锚点最多 ${LIMITS.guides} 个`);
  const guides: DirectorGuide[] = guidePackages.map((pack) => {
    if (pack.anchorFrame === undefined) throw new Error(`引导锚点包“${pack.name}”还没有设置锚点帧`);
    if (pack.assetIds.length !== 1) throw new Error(`引导锚点包“${pack.name}”需要绑定 1 张图片（实验接入 V0.1 暂不支持视频片段锚点）`);
    const asset = resolve(pack)[0];
    if (asset.kind !== "image") throw new Error(`引导锚点包“${pack.name}”需要绑定 1 张图片（实验接入 V0.1 暂不支持视频片段锚点）`);
    return { packageId: pack.id, assetId: asset.assetId, storageReference: asset.storageReference, filename: asset.filename, anchorFrame: pack.anchorFrame };
  }).sort((a, b) => a.anchorFrame - b.anchorFrame);
  for (let index = 1; index < guides.length; index += 1) if (guides[index].anchorFrame === guides[index - 1].anchorFrame) throw new Error(`两个引导锚点包使用了同一帧 ${guides[index].anchorFrame}`);

  const packages = [first, last, reference].filter((pack): pack is ControlPackage => Boolean(pack));
  const lengths = [...new Set(guidePackages.flatMap((pack) => pack.render?.motion ? [pack.render.motion.generationLength] : []))];
  if (lengths.length > 1) throw new Error("Motion 锚点的生成长度不一致，请使用同一长度的锚点包");
  const generationLength = lengths[0];
  if (generationLength && guides.some((guide) => guide.anchorFrame < 1 || guide.anchorFrame >= generationLength)) throw new Error("引导锚点超出当前生成长度");
  const motionIds = [...new Set([...(request.motionIds ?? []), ...guidePackages.flatMap((pack) => pack.render?.motion ? [pack.render.motion.motionId] : [])])];
  const assetIds = [...new Set([firstFrame, lastFrame, ...references].filter((asset): asset is HandoffAsset => Boolean(asset)).map((asset) => asset.assetId).concat(guides.map((guide) => guide.assetId)))];
  return {
    firstFrame, lastFrame, referenceImages, referenceVideos, referenceAudios, guides,
    ...(generationLength ? { generationLength } : {}),
    expectedMode: guides.length ? "i2va_guide" : reference ? "ref2va" : lastFrame ? "fl2va" : "i2va",
    context: {
      sceneId: request.sceneId, ...(request.sceneStateId ? { sceneStateId: request.sceneStateId } : {}),
      controlPackageIds: [...packages.map((pack) => pack.id), ...guides.map((guide) => guide.packageId)], assetIds,
      ...(guides.length ? { guides } : {}),
      ...(request.cameraId ? { cameraId: request.cameraId } : {}),
      ...(motionIds.length ? { motionIds } : {}),
    },
  };
}

/**
 * Shot System V0.1: the hand-off request of a Director Shot, from its saved binding and the Scene's
 * current records. A bound record that no longer exists (or moved Scene) is refused here, before H3.
 */
export function shotHandoffRequest(binding: ShotDirectorBinding, scene: { packages: ControlPackage[]; cameras: Camera[]; motions: Motion[] }): H3HandoffRequest {
  const pack = (id: string | null, label: string) => {
    if (!id) return null;
    const found = scene.packages.find((item) => item.id === id);
    if (!found) throw new Error(`镜头绑定的${label}包已被删除，请重新选择`);
    return found;
  };
  if (binding.cameraId && !scene.cameras.some((camera) => camera.id === binding.cameraId)) throw new Error("镜头绑定的摄影机已被删除，请重新选择");
  if (binding.motionIds.some((id) => !scene.motions.some((motion) => motion.id === id))) throw new Error("镜头绑定的动作已被删除，请重新选择");
  return {
    sceneId: binding.sceneId, sceneStateId: binding.sceneStateId,
    firstFramePackage: pack(binding.firstFramePackageId, "首帧"), lastFramePackage: pack(binding.lastFramePackageId, "尾帧"), referencePackage: pack(binding.referencePackageId, "参考"),
    guidePackages: binding.guidePackageIds.map((id) => pack(id, "引导锚点")!),
    cameraId: binding.cameraId, motionIds: binding.motionIds,
  };
}

/** The Run's copy of the node context; `inputsMatchHandoff` is false if the node's inputs were edited after the hand-off. */
export function runDirectorContext(context: DirectorNodeContext, runInputAssetIds: string[]): DirectorRunContext {
  const inputs = new Set(runInputAssetIds);
  const guides = context.guides ?? [];
  return {
    sceneId: context.sceneId,
    sceneStateId: context.sceneStateId ?? null,
    controlPackageIds: [...context.controlPackageIds],
    handoffAssetIds: [...context.assetIds],
    inputsMatchHandoff: context.assetIds.length === inputs.size && context.assetIds.every((assetId) => inputs.has(assetId)),
    ...(guides.length ? { guidePackageIds: guides.map((guide) => guide.packageId), anchorFrames: guides.map((guide) => guide.anchorFrame) } : {}),
    ...(context.cameraId ? { cameraId: context.cameraId } : {}),
    ...(context.motionIds?.length ? { motionIds: [...context.motionIds] } : {}),
  };
}
