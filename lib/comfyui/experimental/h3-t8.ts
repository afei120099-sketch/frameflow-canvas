// 当前无 app/components 入口；scripts/test-h3-modes.mjs 历史回归仍使用，不单独删除或修改阈值/路由。
import type { H3TaskMode } from "../../h3-task-mode.ts";
import type { H3MediaCounts } from "../../h3-preflight.ts";

/**
 * h3_t8_experimental — interface design only (docs/H3_T8_AUDIT_2026-09-25.md §12).
 *
 * Nothing here talks to a server or is reachable from a generate button. The production ComfyUI on
 * 8188 is never used for T8; a separate instance on 8189 is the planned home, to be installed only
 * after an explicit go-ahead. Until then every entry point throws T8ExperimentDisabledError.
 */

export const T8_EXPERIMENT = Object.freeze({
  enabled: false as const,
  /** Separate ComfyUI instance sharing the existing model folders; 8188 stays untouched. */
  serverUrl: "http://127.0.0.1:8189",
  proxyPath: "/comfyui-t8",
  capabilityIds: ["h3_t8_t2va", "h3_t8_i2va", "h3_t8_fl2va", "h3_t8_ref2va", "h3_t8_hybrid"] as const,
  /** Node classes the instance must expose before the experiment can be switched on. */
  requiredNodes: ["MiniMaxH3AudioConditioningT8", "MiniMaxH3DualClockSamplerT8", "MiniMaxH3AVDecodeT8", "PreviewAny"] as const,
});

export type T8CapabilityId = (typeof T8_EXPERIMENT.capabilityIds)[number];
export type T8TaskType = "T2VA" | "I2VA" | "FL2VA" | "Ref2VA" | "Hybrid";
export const T8_TASK_TYPES: Record<H3TaskMode, T8TaskType> = { t2va: "T2VA", i2va: "I2VA", fl2va: "FL2VA", ref2va: "Ref2VA", hybrid: "Hybrid" };

export class T8ExperimentDisabledError extends Error {
  constructor() { super("T8 实验环境（8189）尚未启用：本轮只有接口设计，不能提交"); this.name = "T8ExperimentDisabledError"; }
}
export function assertT8ExperimentEnabled(config: { enabled: boolean } = T8_EXPERIMENT): void {
  if (!config.enabled) throw new T8ExperimentDisabledError();
}

/**
 * What a T8 submission must look like when it exists. Our Reference Manifest / Prompt Compiler stay
 * the only numbering authority; T8 runs as a validator: explicit task_type (never "auto"),
 * strict tags on, primary-audio remapping off (it would rewrite our <Audio 1>), native audio mode.
 * Autogrow slots are filled strictly in Manifest order (T8 sorts them by slot number).
 */
export interface T8SubmissionPlan {
  capabilityId: T8CapabilityId;
  taskType: T8TaskType;
  prompt: string;
  width: number;
  height: number;
  length: number;
  seed: number;
  steps: number;
  fixed: { strict_prompt_tags: true; prompt_primary_audio_ordinal: 0; audio_mode: "native"; add_source_as_reference: false; reference_video_policy: "official_2_to_15s" };
  slots: { first_frame?: string; last_frame?: string; ref_images: string[]; ref_videos: { file: string; soundtrack: string | null }[]; ref_audios: string[] };
  expectedCounts: H3MediaCounts;
}

export function planT8Submission(input: Omit<T8SubmissionPlan, "capabilityId" | "taskType" | "fixed"> & { mode: H3TaskMode }): T8SubmissionPlan {
  const { mode, ...rest } = input;
  const needFirst = mode === "i2va" || mode === "fl2va";
  if (needFirst && !rest.slots.first_frame) throw new Error(`${T8_TASK_TYPES[mode]} 需要首帧`);
  if (mode === "fl2va" && !rest.slots.last_frame) throw new Error("FL2VA 需要尾帧");
  const hasRefs = rest.slots.ref_images.length + rest.slots.ref_videos.length + rest.slots.ref_audios.length > 0;
  if ((mode === "ref2va" || mode === "hybrid") !== hasRefs) throw new Error(`${T8_TASK_TYPES[mode]} 的参考素材连接不符`);
  if (mode === "t2va" && (rest.slots.first_frame || rest.slots.last_frame)) throw new Error("T2VA 不能接首帧 / 尾帧");
  return {
    ...rest,
    capabilityId: `h3_t8_${mode}` as T8CapabilityId,
    taskType: T8_TASK_TYPES[mode],
    fixed: { strict_prompt_tags: true, prompt_primary_audio_ordinal: 0, audio_mode: "native", add_source_as_reference: false, reference_video_policy: "official_2_to_15s" },
  };
}

/** T8's three STRING outputs, surfaced through core PreviewAny nodes into /history. */
export interface T8EngineEcho { conditionedPrompt: string; mediaMapJson: string; report: string }

/**
 * Layer-D check: what T8 actually used must equal what we compiled. Any difference means double
 * compilation or wiring drift, and the Run is flagged instead of silently accepted.
 */
export function compareT8Echo(expected: { prompt: string; counts: H3MediaCounts }, echo: T8EngineEcho) {
  const problems: string[] = [];
  if (echo.conditionedPrompt !== expected.prompt) problems.push("T8 改写了提交的 Prompt（conditioned_prompt 与最终提交 Prompt 不一致）");
  let map: { pictures?: Record<string, string>; videos?: Record<string, string>; audios?: Record<string, string> } = {};
  try { map = JSON.parse(echo.mediaMapJson); } catch { problems.push("media_map_json 无法解析"); }
  const count = (value?: Record<string, string>) => Object.keys(value ?? {}).length;
  if (count(map.pictures) !== expected.counts.pictures) problems.push(`Picture 数量不一致：Manifest ${expected.counts.pictures}，T8 ${count(map.pictures)}`);
  if (count(map.videos) !== expected.counts.videos) problems.push(`Video 数量不一致：Manifest ${expected.counts.videos}，T8 ${count(map.videos)}`);
  if (count(map.audios) !== expected.counts.audios) problems.push(`Audio 数量不一致：Manifest ${expected.counts.audios}，T8 ${count(map.audios)}`);
  return { ok: problems.length === 0, problems };
}
