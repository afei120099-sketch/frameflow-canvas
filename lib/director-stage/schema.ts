import { z } from "zod";

/**
 * Director Stage data layer V0.1 — deliberately minimal, not the final model.
 *
 * Every record lives in the Director Stage's own IndexedDB (see store.ts) and refers to other
 * records only by ID: child records by `sceneId`, media only by Asset ID (`assetIds`). No media
 * bytes and no H3 / Run / Shot data are stored here. `schemaVersion` and the timestamps exist so a
 * later version can migrate and the backup can order records; they are filled in by the store.
 */

export const DIRECTOR_STAGE_SCHEMA_VERSION = 1;

const id = z.string().min(1).max(100);
const name = z.string().trim().min(1).max(80);
const note = z.string().trim().max(500);
const base = { schemaVersion: z.literal(DIRECTOR_STAGE_SCHEMA_VERSION), id, createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative() };

/**
 * 3D white-box (V0.1-A) — all optional, so records written before it stay valid.
 * Units: metres, Y up, rotations as XYZ Euler angles in degrees. A Prop's size is its scale
 * (unit box 1×1×1 m / unit plane 1×1 m); a Camera looks down its local −Z.
 */
const finite = (min: number, max: number) => z.number().finite().min(min).max(max);
export const WHITEBOX_LIMITS = { position: 200, rotation: 360, scaleMin: 0.01, scaleMax: 200, roomMin: 0.5, roomMax: 200, focalMin: 8, focalMax: 300 } as const;
const vec3 = (min: number, max: number) => z.tuple([finite(min, max), finite(min, max), finite(min, max)]);
export const TransformSchema = z.object({ position: vec3(-WHITEBOX_LIMITS.position, WHITEBOX_LIMITS.position), rotation: vec3(-WHITEBOX_LIMITS.rotation, WHITEBOX_LIMITS.rotation), scale: vec3(WHITEBOX_LIMITS.scaleMin, WHITEBOX_LIMITS.scaleMax) }).strict();
export const RoomSchema = z.object({ width: finite(WHITEBOX_LIMITS.roomMin, WHITEBOX_LIMITS.roomMax), depth: finite(WHITEBOX_LIMITS.roomMin, WHITEBOX_LIMITS.roomMax), height: finite(WHITEBOX_LIMITS.roomMin, WHITEBOX_LIMITS.roomMax) }).strict();
export const PROP_GEOMETRIES = ["box", "plane"] as const;
export const CAMERA_ASPECTS = ["16:9", "9:16"] as const;
export type Transform = z.infer<typeof TransformSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type PropGeometry = (typeof PROP_GEOMETRIES)[number];
export type CameraAspect = (typeof CAMERA_ASPECTS)[number];

export const SceneSchema = z.object({ ...base, name, room: RoomSchema.optional() }).strict();

/** `type` is free text in V0.1 (e.g. "chair", "door"); no fixed catalogue yet. */
export const PropSchema = z.object({ ...base, sceneId: id, name, type: z.string().trim().min(1).max(40), geometry: z.enum(PROP_GEOMETRIES).optional(), transform: TransformSchema.optional() }).strict();

/** One change of one Prop in this state, described in words for now. */
export const PropChangeSchema = z.object({ propId: id, description: note }).strict();
export const SceneStateSchema = z.object({ ...base, sceneId: id, name, propChanges: z.array(PropChangeSchema).max(200) }).strict();

/** `note` is optional so Camera records written before it existed stay valid. */
export const CameraSchema = z.object({ ...base, sceneId: id, name, note: note.optional(), transform: TransformSchema.optional(), focalLength: finite(WHITEBOX_LIMITS.focalMin, WHITEBOX_LIMITS.focalMax).optional(), aspect: z.enum(CAMERA_ASPECTS).optional() }).strict();

/**
 * Motion = director intent only (planning), not an instruction H3 can execute frame-exactly.
 * `frame` counts at 24 FPS from the start of the shot. Keyframes are stored strictly increasing by
 * frame (the store sorts; duplicates are refused). `targetType` says whether `targetId` is a Prop or a
 * Camera of the same Scene.
 */
export const MOTION_TARGET_TYPES = ["prop", "camera"] as const;
export const MOTION_FRAME_RANGE = { min: 0, max: 14400 } as const;
export const MOTION_NOTE = "Motion 当前是导演动作规划，不代表 H3 能精确按帧执行。";
/**
 * Motion V0.2: a keyframe may also carry a white-box pose (`transform`, same shape and limits as
 * Prop / Camera transforms, three.js space). Keyframes without it stay text-only planning; a Motion
 * plays in the 3D stage only through its keyframes that have one (see lib/director-stage/motion-anim.ts).
 */
export const MotionKeyframeSchema = z.object({ frame: z.number().int().min(MOTION_FRAME_RANGE.min).max(MOTION_FRAME_RANGE.max), description: note, transform: TransformSchema.optional() }).strict();
const keyframeList = z.array(MotionKeyframeSchema).max(200).superRefine((keyframes, ctx) => {
  for (let index = 1; index < keyframes.length; index += 1) {
    const previous = keyframes[index - 1].frame, current = keyframes[index].frame;
    if (current === previous) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "frame"], message: `同一动作中出现重复帧 ${current}` });
    else if (current < previous) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "frame"], message: "关键帧必须按帧号从小到大排列" });
  }
});
export const MotionSchema = z.object({ ...base, sceneId: id, name, targetType: z.enum(MOTION_TARGET_TYPES), targetId: id, keyframes: keyframeList }).strict();
/** Sorts keyframes by frame (stable) so callers may pass them in any order; validation still refuses duplicates. */
export function sortKeyframes<T>(keyframes: T): T {
  return Array.isArray(keyframes) ? [...keyframes].sort((a, b) => Number(a?.frame) - Number(b?.frame)) as T : keyframes;
}

/**
 * first_frame / last_frame / reference / guide: what H3 can take today.
 * depth / mask / object_id (高级控制素材 V0.1): Blender control images, generated, registered and managed
 * only; nothing sends them to H3 (no ControlNet / control route yet), so the H3 hand-off never offers them.
 */
export const CONTROL_PACKAGE_TYPES = ["first_frame", "last_frame", "reference", "guide", "depth", "mask", "object_id"] as const;
/** Package types the Director Stage → H3 hand-off can use. */
export const H3_CONTROL_PACKAGE_TYPES = ["first_frame", "last_frame", "reference", "guide"] as const;
export const CONTROL_RENDER_PASSES = ["rgb", "depth", "mask", "object_id", "sdxl_first_frame"] as const;
const byte = z.number().int().min(0).max(255);
/**
 * Where a Blender control image came from (高级控制素材 V0.1): one render batch (`groupId`) of one Scene + Camera
 * gives rgb / depth / mask / object_id from the same camera and pixels. `sourceObjects` are the Props in the
 * image (object_id: with their flat colour; mask: the Props it covers; pixels = visible pixels).
 */
export const ControlRenderSchema = z.object({
  pass: z.enum(CONTROL_RENDER_PASSES),
  groupId: id,
  sceneId: id,
  cameraId: id,
  /** Motion 写实锚点 V0.1: immutable pose-source and batch, optional for old packages. */
  motion: z.object({ motionId: id, frame: z.number().int().min(1).max(361), generationLength: z.number().int().min(124).max(362), batchId: id }).strict().optional(),
  sourceObjects: z.array(z.object({ propId: id, name: z.string().max(80), index: z.number().int().min(1).max(10000).optional(), color: z.tuple([byte, byte, byte]).optional(), pixels: z.number().int().min(0).optional() }).strict()).max(500),
  includesRoom: z.boolean(),
  renderedAt: z.number().int().positive(),
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  engine: z.string().max(120),
  blenderVersion: z.string().max(40),
  depthRange: z.object({ nearM: finite(0, 1000), farM: finite(0, 1000), encoding: z.string().max(300) }).strict().optional(),
  /** Depth 写实首帧 V0.1 (pass "sdxl_first_frame"): how the realistic still was made from the depth image. */
  generator: z.object({
    template: z.string().max(80), templateFile: z.string().max(200), templateSha: z.string().max(80),
    checkpoint: z.string().max(200), controlNet: z.string().max(200), controlType: z.string().max(40),
    controlStrength: finite(0, 10), endPercent: finite(0, 1), steps: z.number().int().min(1).max(200), cfg: finite(0, 30), sampler: z.string().max(80),
    seed: z.number().int().min(0).max(2 ** 31 - 1), prompt: z.string().max(2000), comfyPromptId: z.string().max(100),
    sourceDepthPackageId: id.optional(), sourceDepthAssetId: id.optional(),
  }).strict().optional(),
}).strict();
export type ControlRender = z.infer<typeof ControlRenderSchema>;
/** `assetIds` point at existing Asset records (production-records); the media itself stays there. */
/** H3 frame grid: 17k+5 frames, at most 362 → anchors live on frames 1…361 (checked against the real length when sending). */
export const ANCHOR_FRAME_RANGE = { min: 1, max: 361 } as const;
/** `anchorFrame` is only meaningful for 🧪 guide packages; optional so older records stay valid. */
export const ControlPackageSchema = z.object({ ...base, sceneId: id, name, type: z.enum(CONTROL_PACKAGE_TYPES), assetIds: z.array(id).max(1000), anchorFrame: z.number().int().min(ANCHOR_FRAME_RANGE.min).max(ANCHOR_FRAME_RANGE.max).optional(), render: ControlRenderSchema.optional() }).strict();

/** Which Asset kinds each package type may reference, and how many. Kinds are those of production-records. */
export const CONTROL_PACKAGE_ASSET_RULES: Record<(typeof CONTROL_PACKAGE_TYPES)[number], { label: string; kinds: readonly ("image" | "video" | "audio")[]; max: number }> = {
  first_frame: { label: "首帧", kinds: ["image"], max: 1 },
  last_frame: { label: "尾帧", kinds: ["image"], max: 1 },
  reference: { label: "参考", kinds: ["image", "video", "audio"], max: 9 },
  guide: { label: "🧪 引导锚点", kinds: ["image", "video"], max: 9 },
  depth: { label: "深度图", kinds: ["image"], max: 1 },
  mask: { label: "物体遮罩", kinds: ["image"], max: 1 },
  object_id: { label: "物体 ID", kinds: ["image"], max: 1 },
};

/**
 * Checks a package's Asset list against its type: every Asset must exist (kind known) and be of an
 * allowed kind, no duplicates, at most `max`. Returns a readable problem, or null when valid.
 */
export function controlPackageAssetProblem(type: (typeof CONTROL_PACKAGE_TYPES)[number], assets: { assetId: string; kind: string | null }[]): string | null {
  const rule = CONTROL_PACKAGE_ASSET_RULES[type];
  if (assets.length > rule.max) return `${rule.label}控制素材包最多引用 ${rule.max} 个素材`;
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length) return "同一素材不能重复加入一个控制素材包";
  const missing = assets.find((asset) => asset.kind === null);
  if (missing) return `素材记录不存在：${missing.assetId}`;
  const wrong = assets.find((asset) => !(rule.kinds as readonly string[]).includes(asset.kind!));
  if (wrong) return `${rule.label}控制素材包只能引用${rule.kinds.map((kind) => ({ image: "图片", video: "视频", audio: "声音" })[kind]).join(" / ")}素材`;
  return null;
}

export type Scene = z.infer<typeof SceneSchema>;
export type Prop = z.infer<typeof PropSchema>;
export type PropChange = z.infer<typeof PropChangeSchema>;
export type SceneState = z.infer<typeof SceneStateSchema>;
export type Camera = z.infer<typeof CameraSchema>;
export type MotionKeyframe = z.infer<typeof MotionKeyframeSchema>;
export type MotionTargetType = (typeof MOTION_TARGET_TYPES)[number];
export type Motion = z.infer<typeof MotionSchema>;
export type ControlPackageType = (typeof CONTROL_PACKAGE_TYPES)[number];
export type ControlPackage = z.infer<typeof ControlPackageSchema>;

/** Create inputs: what the caller supplies. `sceneId` is fixed at creation and cannot be patched. */
export const SceneInputSchema = SceneSchema.pick({ name: true });
export const PropInputSchema = PropSchema.pick({ sceneId: true, name: true, type: true, geometry: true, transform: true });
export const SceneStateInputSchema = SceneStateSchema.pick({ sceneId: true, name: true, propChanges: true });
export const CameraInputSchema = CameraSchema.pick({ sceneId: true, name: true, note: true, transform: true, focalLength: true, aspect: true });
export const MotionInputSchema = MotionSchema.pick({ sceneId: true, name: true, targetType: true, targetId: true, keyframes: true });
export const ControlPackageInputSchema = ControlPackageSchema.pick({ sceneId: true, name: true, type: true, assetIds: true, anchorFrame: true, render: true });

export const ScenePatchSchema = SceneSchema.pick({ name: true, room: true }).partial();
export const PropPatchSchema = PropSchema.pick({ name: true, type: true, geometry: true, transform: true }).partial();
export const SceneStatePatchSchema = SceneStateSchema.pick({ name: true, propChanges: true }).partial();
export const CameraPatchSchema = CameraSchema.pick({ name: true, note: true, transform: true, focalLength: true, aspect: true }).partial();
export const MotionPatchSchema = MotionSchema.pick({ name: true, targetType: true, targetId: true, keyframes: true }).partial();
export const ControlPackagePatchSchema = ControlPackageSchema.pick({ name: true, type: true, assetIds: true, anchorFrame: true }).partial();

export type SceneInput = z.input<typeof SceneInputSchema>;
export type PropInput = z.input<typeof PropInputSchema>;
export type SceneStateInput = z.input<typeof SceneStateInputSchema>;
export type CameraInput = z.input<typeof CameraInputSchema>;
export type MotionInput = z.input<typeof MotionInputSchema>;
export type ControlPackageInput = z.input<typeof ControlPackageInputSchema>;
