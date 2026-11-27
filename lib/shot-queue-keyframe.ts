/**
 * 「先出关键帧再出视频」（原生产线的做法），合进画布队列：shot-queue-v1 每镜可选的 keyframe 块。
 *
 *   "keyframe": { "prompt": "英文外观/构图描述", "faceRoleId": "角色ID", "faceWeight": 0.85,
 *                 "storyboardAssetId": "分镜图 AssetID（可选，锁构图）", "depthStrength": 1, "count": 3 }
 *   defaults.keyframe: { "look": "全集共用画风（英文）", "count": 3, "depthStrength": 1 }
 *
 * 关键帧在画布里用 Flux Dev（+ PuLID 锁脸，+ 分镜深度图）出；你在镜头卡片里点「通过」后，
 * 那张图写进这一镜的 firstFrameAssetId，generationMode 改为 first-last，视频从它开始。
 * 用 firstFrameFrom 接上一镜尾帧的镜头不能再出关键帧（首帧已经由接帧决定）。
 */

export interface ShotKeyframe {
  prompt: string;
  faceRoleId?: string;
  faceWeight?: number;
  storyboardAssetId?: string;
  depthStrength?: number;
  count?: number;
}
export interface KeyframeDefaults { look?: string; count?: number; depthStrength?: number }

export const KEYFRAME_COUNT_MAX = 6;
const KEYS = ["prompt", "faceRoleId", "faceWeight", "storyboardAssetId", "depthStrength", "count"];
const DEFAULT_KEYS = ["look", "count", "depthStrength"];
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const inRange = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function parseShotKeyframe(value: unknown, where: string, context: { roleIds: readonly string[]; chained: boolean }): ShotKeyframe {
  if (!isObject(value)) throw new Error(`${where}.keyframe 必须是对象`);
  const errors: string[] = [];
  const unknown = Object.keys(value).filter((key) => !KEYS.includes(key));
  if (unknown.length) errors.push(`${where}.keyframe 只支持 ${KEYS.join(" / ")}，多出：${unknown.join("、")}`);
  if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 800) errors.push(`${where}.keyframe.prompt 需要 1–800 字（建议英文，Flux 读不懂中文）`);
  if (value.faceRoleId !== undefined && (typeof value.faceRoleId !== "string" || !context.roleIds.includes(value.faceRoleId))) errors.push(`${where}.keyframe.faceRoleId 必须是本镜 roleIds 里的角色`);
  if (value.faceWeight !== undefined && !inRange(value.faceWeight, 0, 1.5)) errors.push(`${where}.keyframe.faceWeight 必须在 0–1.5`);
  if (value.storyboardAssetId !== undefined && (typeof value.storyboardAssetId !== "string" || !value.storyboardAssetId.trim())) errors.push(`${where}.keyframe.storyboardAssetId 需要分镜图的 Asset ID`);
  if (value.depthStrength !== undefined && !inRange(value.depthStrength, 0.3, 1.5)) errors.push(`${where}.keyframe.depthStrength 必须在 0.3–1.5`);
  if (value.count !== undefined && !(Number.isInteger(value.count) && inRange(value.count, 1, KEYFRAME_COUNT_MAX))) errors.push(`${where}.keyframe.count 必须是 1–${KEYFRAME_COUNT_MAX} 的整数`);
  if (context.chained) errors.push(`${where} 用 firstFrameFrom 接帧，首帧由上一镜决定，不能再写 keyframe`);
  if (errors.length) throw new Error(errors.join("\n"));
  return {
    prompt: (value.prompt as string).trim(),
    ...(value.faceRoleId !== undefined ? { faceRoleId: value.faceRoleId as string } : {}),
    ...(value.faceWeight !== undefined ? { faceWeight: value.faceWeight as number } : {}),
    ...(value.storyboardAssetId !== undefined ? { storyboardAssetId: (value.storyboardAssetId as string).trim() } : {}),
    ...(value.depthStrength !== undefined ? { depthStrength: value.depthStrength as number } : {}),
    ...(value.count !== undefined ? { count: value.count as number } : {}),
  };
}

export function parseKeyframeDefaults(value: unknown): KeyframeDefaults {
  if (!isObject(value)) throw new Error("defaults.keyframe 必须是对象");
  const errors: string[] = [];
  const unknown = Object.keys(value).filter((key) => !DEFAULT_KEYS.includes(key));
  if (unknown.length) errors.push(`defaults.keyframe 只支持 ${DEFAULT_KEYS.join(" / ")}，多出：${unknown.join("、")}`);
  if (value.look !== undefined && (typeof value.look !== "string" || value.look.length > 600)) errors.push("defaults.keyframe.look 最多 600 字");
  if (value.count !== undefined && !(Number.isInteger(value.count) && inRange(value.count, 1, KEYFRAME_COUNT_MAX))) errors.push(`defaults.keyframe.count 必须是 1–${KEYFRAME_COUNT_MAX} 的整数`);
  if (value.depthStrength !== undefined && !inRange(value.depthStrength, 0.3, 1.5)) errors.push("defaults.keyframe.depthStrength 必须在 0.3–1.5");
  if (errors.length) throw new Error(errors.join("\n"));
  return {
    ...(typeof value.look === "string" && value.look.trim() ? { look: value.look.trim() } : {}),
    ...(value.count !== undefined ? { count: value.count as number } : {}),
    ...(value.depthStrength !== undefined ? { depthStrength: value.depthStrength as number } : {}),
  };
}

/** The Flux prompt actually sent: the shot's own description, then the episode look. */
export function keyframeFluxPrompt(keyframe: ShotKeyframe, defaults?: KeyframeDefaults) {
  return [keyframe.prompt, defaults?.look].filter(Boolean).join(", ");
}

export const keyframeCount = (keyframe: ShotKeyframe, defaults?: KeyframeDefaults) => keyframe.count ?? defaults?.count ?? 3;
export const keyframeDepth = (keyframe: ShotKeyframe, defaults?: KeyframeDefaults) => keyframe.depthStrength ?? defaults?.depthStrength ?? 1;

/**
 * A first frame takes Picture 1 and pushes every scene / role one number up (verified with planShotReferences).
 * When a keyframe is approved on a shot that had no first frame, its <Picture N> tags must move up by one.
 */
export function shiftPictureTags(prompt: string, by = 1) {
  return prompt.replace(/<\s*Picture\s*(\d+)\s*>/g, (_, n: string) => `<Picture ${Number(n) + by}>`);
}
