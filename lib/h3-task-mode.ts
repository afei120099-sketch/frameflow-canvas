/**
 * H3 task mode, decided automatically from what is connected to the H3 node — the user never picks
 * a workflow. Only T2VA / I2VA / FL2VA / Ref2VA run on the current backend; Hybrid (exact first/last
 * frame together with reference media) is an interface-only experiment and can never be submitted
 * until an experimental backend exists.
 */

export type H3TaskMode = "t2va" | "i2va" | "fl2va" | "ref2va" | "hybrid";

export interface H3TaskInputs {
  /** A first frame is connected (image node or previous video's tail frame). */
  hasFirstFrame: boolean;
  hasLastFrame: boolean;
  /** Reference images / videos / audios / roles (the first frame itself is not counted here). */
  hasReferences: boolean;
  /** User asked to lock the first frame exactly while also using references (🧪 Hybrid). */
  hybridLock?: boolean;
}

export interface H3TaskResolution {
  mode: H3TaskMode | null;
  /** Why no mode could be resolved (only "last frame without first frame" today). */
  problem: string | null;
}

export function resolveH3TaskMode(input: H3TaskInputs): H3TaskResolution {
  if (input.hasReferences) {
    if (input.hasLastFrame || (input.hybridLock && input.hasFirstFrame)) return { mode: "hybrid", problem: null };
    return { mode: "ref2va", problem: null };
  }
  if (input.hasFirstFrame) return { mode: input.hasLastFrame ? "fl2va" : "i2va", problem: null };
  if (input.hasLastFrame) return { mode: null, problem: "只连接了尾帧：请同时连接首帧（仅尾帧生成尚未接入）" };
  return { mode: "t2va", problem: null };
}

export const H3_TASK_LABELS: Record<H3TaskMode, string> = {
  t2va: "文生视频",
  i2va: "首帧图生视频",
  fl2va: "首尾帧生成",
  ref2va: "多参考生成",
  hybrid: "🧪 Hybrid｜首尾帧 + 角色参考",
};

/** Human-verified status per mode (SKILL §4); T2VA uses the verified FL2VA model but is itself unverified. */
export const H3_TASK_STATUS: Record<H3TaskMode, { enabled: boolean; verified: boolean; note: string }> = {
  t2va: { enabled: true, verified: false, note: "🧪 待真人 GPU 验收：沿用已验证 FL2VA 模型与参数，只是不接首帧" },
  i2va: { enabled: true, verified: true, note: "🔒 真人已验证" },
  fl2va: { enabled: true, verified: true, note: "🔒 真人已验证" },
  ref2va: { enabled: true, verified: true, note: "🔒 真人已验证" },
  hybrid: { enabled: false, verified: false, note: "🧪 实验能力｜当前后端尚未启用" },
};

export class H3ModeNotEnabledError extends Error {
  constructor(mode: H3TaskMode) {
    super(`${H3_TASK_LABELS[mode]}：${H3_TASK_STATUS[mode].note}，不能提交生成`);
    this.name = "H3ModeNotEnabledError";
  }
}

/** The single guard used by both the canvas and the adapter before anything is uploaded or queued. */
export function assertH3ModeSubmittable(mode: H3TaskMode | null | undefined): asserts mode is Exclude<H3TaskMode, "hybrid"> {
  if (!mode) throw new Error("无法判断生成模式，请检查首帧 / 尾帧 / 参考素材连接");
  if (!H3_TASK_STATUS[mode].enabled) throw new H3ModeNotEnabledError(mode);
}
