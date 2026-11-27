import type { H3GenerationSettings } from "./ai-adapter.ts";
import type { EngineInfo } from "./comfyui/engine-info.ts";
import type { PlanSource } from "./autopilot-package.ts";
import type { CompiledDirectorShot, DirectorConstraints, DirectorPlan, M2Aspect, M2PresetId, M2PromptMode, PlanCheck, SubjectAnchor } from "./autopilot-director.ts";
import { H3_FPS, H3_LORA_STRENGTH, H3_MEGAPIXELS, H3_MIN_LENGTH, H3_RESOLUTION_STEPS, H3_STEPS, H3_TURBO, H3_UPSCALE_METHOD } from "./comfyui/h3-parameters.ts";

/**
 * Autopilot M1: one fixed, unattended three-shot test. The job ledger lives on disk and is owned by
 * the local worker inside the dev server (scripts/autopilot-worker.ts); the browser only starts a
 * job, reads its state and shows the result. Shared by the worker, its HTTP routes and the panel.
 */

export const AUTOPILOT_SCHEMA_VERSION = 1 as const;
export const AUTOPILOT_M1_KIND = "m1_three_shot_test" as const;
export const AUTOPILOT_M2_KIND = "m2_director_draft" as const;
export type AutopilotKind = typeof AUTOPILOT_M1_KIND | typeof AUTOPILOT_M2_KIND;

/** M2 adds "planning" (director model at work, no GPU) and "awaiting_confirmation" (plan shown, nothing submitted). */
export type AutopilotJobStatus = "planning" | "awaiting_confirmation" | "planning_failed" | "preflight_failed" | "queued" | "running" | "reconnecting" | "paused" | "completed" | "failed" | "cancelled";
/** Unfinished jobs. Only one may exist at a time (a paused job still blocks a new one). */
export const ACTIVE_AUTOPILOT_STATUSES: readonly AutopilotJobStatus[] = ["planning", "awaiting_confirmation", "queued", "running", "reconnecting", "paused"];
/** The worker keeps these moving on its own; "paused" waits for the user. */
export const RUNNING_AUTOPILOT_STATUSES: readonly AutopilotJobStatus[] = ["planning", "queued", "running", "reconnecting"];
export const isActiveAutopilotJob = (job: Pick<AutopilotJob, "status">) => ACTIVE_AUTOPILOT_STATUSES.includes(job.status);

export type AutopilotStage = "planning" | "awaiting_confirmation" | "queued" | "shots" | "rough_cut" | "finished";
export type ShotTaskStatus = "pending" | "submitting" | "queued" | "running" | "fetching" | "completed" | "failed" | "needs_confirmation" | "cancelled";
export type RoughCutTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** One /prompt attempt. Its runId doubles as the reserved ComfyUI prompt_id (same rule as canvas Runs). */
export interface ShotAttempt {
  runId: string;
  comfyPromptId: string;
  reservedAt: string;
  acceptedAt: string | null;
  /** "not_sent": the connection was refused before the request existed (provably never reached ComfyUI). */
  outcome: "reserved" | "accepted" | "completed" | "failed" | "lost" | "not_sent" | "cancelled";
  error: string | null;
}

/** Run record kept in the ledger (same field names as the canvas RunRecord; not written to IndexedDB in M1). */
export interface AutopilotRun {
  runId: string;
  capabilityId: "h3_fl2va";
  taskMode: "t2va";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  comfyPromptId: string;
  submission: "reserved" | "accepted";
  rawPrompt: string;
  finalPrompt: string;
  seed: number;
  parameters: Record<string, unknown>;
  workflowIdentity: { capabilityId: "h3_fl2va"; templateVersion: string; templateFile: string };
  engine?: EngineInfo;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface ShotMedia { width: number; height: number; fps: number; duration: number; hasAudio: boolean }

export interface ShotTask {
  shotId: string;
  index: number;
  title: string;
  prompt: string;
  seed: number;
  status: ShotTaskStatus;
  /** Automatic retries used (M1 allows one per Shot, only for retryable failures). */
  retryCount: number;
  runId: string | null;
  comfyPromptId: string | null;
  attempts: ShotAttempt[];
  run: AutopilotRun | null;
  /** Relative to the job folder, e.g. "shots/shot_01.mp4". */
  outputFile: string | null;
  outputBytes: number | null;
  comfyOutput: { filename: string; subfolder: string; type: string } | null;
  media: ShotMedia | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  /** M2: this Shot's own H3 settings (length / aspect / sound mode); M1 Shots use the job's settings. */
  settings?: H3GenerationSettings;
  /** M2: the director-layer text of this Shot (Chinese shot card), kept apart from the submitted prompt. */
  rawPrompt?: string;
  promptMode?: M2PromptMode;
  plannedSeconds?: number;
}

/**
 * Why a job ended (or, when retryable, why 【开始制作】 was refused while the plan is kept). Shown to the
 * user as plain Chinese via AUTOPILOT_FAILURE_LABELS instead of one generic "失败".
 */
export type AutopilotFailureKind =
  | "planning_failed" | "preflight_failed" | "local_director_resource_conflict" | "director_release_failed"
  | "comfyui_unavailable" | "gpu_busy" | "disk_low" | "lmstudio_occupying_gpu" | "generation_failed" | "rough_cut_failed" | "cancelled";
export interface AutopilotFailure { kind: AutopilotFailureKind; message: string; at: string; retryable: boolean }
export const AUTOPILOT_FAILURE_LABELS: Record<AutopilotFailureKind, string> = {
  planning_failed: "导演计划未通过，未开始视频生成",
  preflight_failed: "开始前检查未通过，未开始视频生成",
  local_director_resource_conflict: "本地导演模型正被其他任务使用，未开始视频生成（计划已保留，可稍后再点开始制作）",
  director_release_failed: "本地导演模型没能释放显存，未开始视频生成（计划已保留）",
  comfyui_unavailable: "ComfyUI 未连接，未开始视频生成（计划已保留，启动 ComfyUI 后再点开始制作）",
  gpu_busy: "ComfyUI 正在执行其他任务，未开始视频生成（计划已保留，等它结束后再点开始制作）",
  disk_low: "磁盘空间不足，未开始视频生成（计划已保留）",
  lmstudio_occupying_gpu: "LM Studio正在占用显存，未开始视频生成（本任务不会替你卸载；请在 LM Studio 中卸载模型后再点开始夜班制作）",
  generation_failed: "视频生成失败",
  rough_cut_failed: "镜头已生成，但自动粗剪失败",
  cancelled: "已取消",
};

/** One line of the 【开始制作】 gate (re-checked right before any H3 submission). */
export interface ProductionGateCheck { id: "plan_schema" | "constraints" | "approved_facts" | "compiler" | "preflight" | "disk" | "comfyui" | "gpu" | "lmstudio" | "local_director"; label: string; state: "pass" | "fail" | "skipped"; detail: string }
export interface ProductionGateReport { at: string; ok: boolean; checks: ProductionGateCheck[] }

export interface AutopilotErrorEntry { at: string; stage: string; shot: number | null; message: string; code?: string }

export interface AutopilotJob {
  schemaVersion: typeof AUTOPILOT_SCHEMA_VERSION;
  jobId: string;
  kind: AutopilotKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  status: AutopilotJobStatus;
  currentStage: AutopilotStage;
  /** 1-based; null before the first Shot and after the last. */
  currentShotIndex: number | null;
  /** Human-readable stage for the panel (never a made-up percentage). */
  stageText: string;
  pauseReason: string | null;
  cancelRequested: boolean;
  settings: H3GenerationSettings;
  shots: ShotTask[];
  roughCutStatus: RoughCutTaskStatus;
  roughCutOutput: { width: number; height: number; fps: number; duration: number; frames: number; bytes: number; clipOrder: string[]; scriptVersion: string } | null;
  roughCutError: string | null;
  /** Absolute path of the final MP4 on this computer. */
  finalOutputPath: string | null;
  /** Relative to the job folder, e.g. "output/Autopilot_M1_test_20260926_221500.mp4". */
  finalOutputFile: string | null;
  finalFilename: string | null;
  finalDuration: number | null;
  lastHeartbeat: string;
  errorLog: AutopilotErrorEntry[];
  /** Which dev-server process owns (or last owned) the job. */
  worker: { pid: number; instance: string } | null;
  /** M2 only: the user's sentence and the frozen plan. */
  m2?: AutopilotM2Record;
  /** Typed reason of the last failure / refusal; null while things are fine. */
  failure?: AutopilotFailure | null;
  /** M2: production report written at every end state, relative to the job folder. */
  reportFile?: string | null;
}

export interface DirectorUsageRecord { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; costUsd?: number; costBasis?: string; durationMs?: number; stopReason?: string | null }
export interface DirectorTransportEntry { at: string; status: number | null; error: string | null; durationMs: number; requestId: string | null; retryAfterSeconds: number | null; retried: boolean }
export interface DirectorBudgetRecord { maxInputTokens: number | null; maxOutputTokens: number; maxCostUsd: number | null; costBasis: string }
export interface DirectorAttempt {
  at: string; kind: "plan" | "repair"; model: string | null; providerVersion: string | null; durationMs: number; ok: boolean; errors: string[]; warnings: string[];
  usage: DirectorUsageRecord | null; file: string | null;
  /** Worst case recorded before the call. */
  budget?: DirectorBudgetRecord | null;
  /** Every HTTP exchange of this call (network retries included). */
  transport?: DirectorTransportEntry[];
  errorCode?: string | null;
  /** The call may have been billed although no usable reply came back (timeout etc.). */
  billingUncertain?: boolean;
  /** Director Runtime Skill injected into this call. */
  runtimeSkill?: { version: string; hash: string } | null;
}

export interface AutopilotM2Record {
  /** 原始中文需求, verbatim. */
  intent: string;
  targetSeconds: number;
  aspect: M2Aspect;
  /** "official" = MiniMax three-field structure (default); "plain" = internal A/B / diagnosis. */
  promptMode: M2PromptMode;
  /** 2 = semantic DirectorPlan + deterministic compiler (older ledgers have none). */
  schemaVersion?: number;
  /** Product / brand facts the plan may state; forbidden claims. */
  approvedFacts?: string[];
  forbiddenClaims?: string[];
  /** Hard constraints enforced by the validator (older ledgers: defaults). */
  constraints?: DirectorConstraints;
  /** Content preset the user chose (it filled the constraints) and the keyword suggestion shown next to it. */
  preset?: M2PresetId;
  suggestedPreset?: { preset: M2PresetId; reason: string } | null;
  /** Where the plan came from (a user / system label; the program cannot prove which model wrote an imported package). */
  planSource?: PlanSource;
  /** external_ai only: what was imported (original text + parsed package are files in the job's director folder). */
  importInfo?: { providerLabel: string; importedAt: string; packageVersion: string; packageHash: string; originalFile: string; packageFile: string; expectedMatched: boolean } | null;
  /** Banned words from the package / request (enforced together with forbiddenClaims). */
  forbiddenTerms?: string[];
  /** Snapshot of the user's Subject Anchor (null / absent: none — older ledgers). */
  subjectAnchor?: SubjectAnchor | null;
  /** ✅ / ❌ list of the latest plan check. */
  checks?: PlanCheck[] | null;
  /** Latest 【开始制作】 gate. */
  gate?: ProductionGateReport | null;
  director: { providerId: string; label: string; kind: "mock" | "local" | "cloud" | "external"; usesLocalGpu: boolean; maxCalls: number; releasedAt: string | null; releaseError?: { code: string; message: string; at: string } | null; version?: string | null; release?: { unloaded: string[]; gpuUsedBeforeMiB: number | null; gpuUsedAfterMiB: number | null; gpuTotalMiB: number | null; freeAfterMiB: number | null } | null; ceiling?: { maxCalls: number; maxCostUsd: number | null; costBasis: string } | null; runtimeSkill?: { version: string; hash: string } | null };
  attempts: DirectorAttempt[];
  /** Validated semantic DirectorPlan exactly as the director model returned it (no prompt syntax). */
  plan: DirectorPlan | null;
  /** Per Shot: card, pre-compile fields, official / plain prompts, the submitted prompt, legal length. */
  compiled: CompiledDirectorShot[] | null;
  compilerVersion: string | null;
  totalSeconds: number | null;
  warnings: string[];
  plannedAt: string | null;
  confirmedAt: string | null;
}

/** Compact list view for the panel. */
export interface AutopilotJobSummary {
  jobId: string; kind: AutopilotKind; title: string; status: AutopilotJobStatus; currentStage: AutopilotStage; currentShotIndex: number | null;
  stageText: string; createdAt: string; updatedAt: string; completedAt: string | null; finalFilename: string | null;
}
export const summarizeAutopilotJob = (job: AutopilotJob): AutopilotJobSummary => ({
  jobId: job.jobId, kind: job.kind ?? AUTOPILOT_M1_KIND, title: job.title, status: job.status, currentStage: job.currentStage, currentShotIndex: job.currentShotIndex,
  stageText: job.stageText, createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt, finalFilename: job.finalFilename,
});

/**
 * Fixed M1 settings: T2VA with the frozen fast baseline (0.50 MP, 24 FPS, Turbo, 6 steps, LoRA 1.0,
 * Lanczos, 32-px steps) and the shortest legal length (124 frames ≈ 5.17 s). 16:9, ambient sound
 * only (no speech / music), so each Shot keeps a real audio track for the rough cut.
 */
export const AUTOPILOT_M1_SETTINGS: H3GenerationSettings = {
  length: H3_MIN_LENGTH,
  aspect: "16:9",
  megapixels: H3_MEGAPIXELS,
  turbo: H3_TURBO,
  steps: H3_STEPS,
  fps: H3_FPS,
  loraStrength: H3_LORA_STRENGTH,
  upscaleMethod: H3_UPSCALE_METHOD,
  resolutionSteps: H3_RESOLUTION_STEPS,
  soundMode: "ambient",
};

const FIXED_CAMERA = "摄影机：固定机位，单一连续镜头；取景范围、背景透视和主体的基本位置在整段中保持一致。";
const ROOM = "现代客厅，浅灰色墙面，柔和的午后自然光从左侧窗户照进来。";

/** ≈5 s each: one main action and one result (SKILL §20), fixed camera (§19), distinct subjects so 01 / 02 / 03 are easy to tell apart. */
export const AUTOPILOT_M1_SHOTS: readonly { title: string; prompt: string; seed: number }[] = [
  { title: "Shot 01 · 柴犬", seed: 260_926_01, prompt: `${ROOM}一只柴犬端坐在浅灰色布艺沙发上，面向镜头。它先直视镜头，然后轻轻向右转头，耳朵微微抖动。${FIXED_CAMERA}` },
  { title: "Shot 02 · 橘猫", seed: 260_926_02, prompt: `${ROOM}一只橘猫坐在木质茶几旁的米色地毯上，面向镜头。它抬起一只前爪停在半空，歪头露出疑惑的表情。${FIXED_CAMERA}` },
  { title: "Shot 03 · 柴犬与橘猫", seed: 260_926_03, prompt: `${ROOM}一只柴犬和一只橘猫同在客厅地毯上，左右相隔约一米。两者慢慢转头看向彼此，短暂对视。${FIXED_CAMERA}` },
];

export const AUTOPILOT_STATUS_LABELS: Record<AutopilotJobStatus, string> = {
  planning: "导演规划中", awaiting_confirmation: "等待确认计划", planning_failed: "导演计划未通过", preflight_failed: "开始前检查未通过", queued: "排队中", running: "运行中", reconnecting: "等待 ComfyUI 重新连接", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消",
};
export const SHOT_STATUS_LABELS: Record<ShotTaskStatus, string> = {
  pending: "等待", submitting: "提交中", queued: "ComfyUI 排队中", running: "生成中", fetching: "取回结果", completed: "完成",
  failed: "失败", needs_confirmation: "状态待确认", cancelled: "已取消",
};
export const ROUGH_CUT_STATUS_LABELS: Record<RoughCutTaskStatus, string> = { pending: "等待", running: "粗剪中", completed: "完成", failed: "失败", cancelled: "已取消" };

export const ACTIVE_JOB_MESSAGE = "当前已有夜班任务正在运行";
/** 2026-11-11: the night shift only knew the retired stable H3 workflow, so it is taken offline. Old jobs stay readable. */
export const AUTOPILOT_RETIRED_MESSAGE = "夜班已下线：它只会用已停用的稳定版 H3。批量出片请用顶栏「卡片」（在「JSON / 进度」里入队）。以前的夜班记录和成片仍保留在 runtime/autopilot 里。";
export const COMFY_OFFLINE_MESSAGE = "ComfyUI未连接";

const pad = (value: number) => String(value).padStart(2, "0");
/** Local wall-clock stamp YYYYMMDD_HHmmss. */
export function autopilotStamp(date: Date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
export const autopilotOutputName = (date: Date, kind: AutopilotKind = AUTOPILOT_M1_KIND) => kind === AUTOPILOT_M2_KIND ? `Autopilot_M2_draft_${autopilotStamp(date)}.mp4` : `Autopilot_M1_test_${autopilotStamp(date)}.mp4`;
export const shotFileName = (index: number) => `shot_${pad(index)}.mp4`;
export const shotIdFor = (index: number) => `shot_${pad(index)}`;
