import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AiJobRequest, AiJobResult } from "../lib/ai-adapter.ts";
import {
  ACTIVE_JOB_MESSAGE, AUTOPILOT_FAILURE_LABELS, AUTOPILOT_RETIRED_MESSAGE, AUTOPILOT_M1_KIND, AUTOPILOT_M2_KIND, AUTOPILOT_M1_SETTINGS, AUTOPILOT_M1_SHOTS, AUTOPILOT_SCHEMA_VERSION, COMFY_OFFLINE_MESSAGE, RUNNING_AUTOPILOT_STATUSES,
  autopilotOutputName, autopilotStamp, isActiveAutopilotJob, shotFileName, shotIdFor, summarizeAutopilotJob,
  type AutopilotFailure, type AutopilotFailureKind, type AutopilotJob, type AutopilotRun, type ProductionGateCheck, type ProductionGateReport, type ShotAttempt, type ShotMedia, type ShotTask,
} from "../lib/autopilot.ts";
import type { EngineInfo } from "../lib/comfyui/engine-info.ts";
import { planH3Submission, type ComfyFile, type ComfyJobProbe } from "../lib/comfyui/h3-adapter.ts";
import { compileH3Prompt } from "../lib/comfyui/h3-prompt.ts";
import { t2vaDimensions } from "../lib/comfyui/h3-t2va.ts";
import { formatPreflight, frameModeCounts, runH3Preflight } from "../lib/h3-preflight.ts";
import { h3ClassTypesFor, snapshotH3 } from "../lib/production-snapshots.ts";
import { watchRun, type RecoveryPhase } from "../lib/run-recovery.ts";
import { RoughCutJobs, type RoughCutError } from "./rough-cut-jobs.ts";
import {
  compileDirectorPlan, DIRECTOR_CONSTRAINT_KEYS, DirectorPlanSchema, extractPlanJson, isPresetId, m2Settings, M2_ASPECTS, M2_COMPILER_VERSION, M2_DEFAULT_ASPECT, M2_DEFAULT_PRESET, M2_DEFAULT_SECONDS,
  M2_DIRECTOR_SCHEMA_VERSION, M2_INTENT_MAX, M2_PRESETS, M2_SECONDS_RANGE, normalizeConstraints, normalizeSubjectAnchor, planChecks, PRODUCT_FACTS_REQUIRED_MESSAGE, suggestPreset,
  type CompiledDirectorShot, type DirectorConstraints, type M2Aspect, type M2PresetId, type M2PromptMode, type PlanCheck, type PlanCheckCategory, type SubjectAnchor,
} from "../lib/autopilot-director.ts";
import { H3_MIN_LENGTH } from "../lib/comfyui/h3-parameters.ts";
import { EXTERNAL_PROVIDER_LABELS, packageRequestDifferences, packageToDraft, parseDirectorPlanPackage, type DirectorPackageRequest, type ExternalProviderLabel } from "../lib/autopilot-package.ts";
import { buildDirectorBrief, buildExternalDirectorTask, defaultDirectorProviders, describeProvider, RESOURCE_CONFLICT, type DirectorCallBudget, type DirectorCallResult, type DirectorProvider, type DirectorRequest, type DirectorTransportRecord, type DirectorUsage } from "./director-providers.ts";
import { AutopilotStore, type AutopilotLogEntry, type LockInfo } from "./autopilot-ledger.ts";
import { DIRECTOR_RUNTIME_SKILL_FILE, loadDirectorRuntimeSkill, type DirectorRuntimeSkill } from "./director-runtime-skill.ts";

/**
 * Autopilot M1 worker: runs inside the local dev server process (never in the page), so closing the
 * canvas tab changes nothing. One job at a time, Shots strictly one after another:
 *
 *   reserve Run ID = prompt_id → write ledger → POST /prompt → watch queue/history → fetch MP4 →
 *   save shots/shot_NN.mp4 → next Shot … → Phase 19 rough cut (same RoughCutJobs + rough-cut.py)
 *
 * The H3 workflow comes from the canvas's own planH3Submission (T2VA branch), submission / probing /
 * fetching / cancelling from the same ComfyUIH3Adapter class (pointed at ComfyUI directly), waiting
 * from the Phase 6 watchRun. Nothing is ever resubmitted because its state is uncertain.
 */

export interface AutopilotComfy {
  isAvailable(): Promise<boolean>;
  probeJob(jobId: string, saveNodeId: string): Promise<ComfyJobProbe>;
  submit(request: AiJobRequest): Promise<AiJobResult>;
  fetchOutputFile(file: ComfyFile): Promise<{ video: Blob; filename: string }>;
  cancel(jobId: string): Promise<void>;
  describeEngine(classTypes: readonly string[]): Promise<EngineInfo>;
  /** Prompts ComfyUI is running / holding (the 【开始制作】 gate refuses to start while it is busy). */
  queueSize?(): Promise<{ running: number; pending: number }>;
}

export interface AutopilotWorkerOptions {
  thermalStatus?: () => { latched: boolean; blocked: boolean; reason: string } | undefined;
  root: string;
  comfy: AutopilotComfy;
  /** Phase 19 PyAV runtime (same interpreter and script as the rough-cut dialog). */
  python: string;
  script: string;
  pollMs?: number;
  reconnectMs?: number;
  /** ComfyUI unreachable for longer than this → the job pauses (it never resubmits). */
  reconnectLimitMs?: number;
  /** A Shot still queued / running this long after acceptance → the job pauses. */
  shotTimeoutMs?: number;
  heartbeatMs?: number;
  lockStaleMs?: number;
  roughCutPollMs?: number;
  now?: () => Date;
  report?: (line: string) => void;
  /** Resolves when a previous worker of this process (a Vite restart) has fully stopped; start() waits for it. */
  handover?: Promise<unknown>;
  /** M2 director providers (default: mock + not-yet-wired slots) and the one used when a request names none. */
  directors?: DirectorProvider[];
  defaultDirector?: string;
  /** Upper bound for one director call. */
  directorTimeoutMs?: number;
  /** Hard cap on director calls per job (first plan + repairs). */
  directorMaxCalls?: number;
  /** 【开始制作】 gate: minimum free disk space in the Autopilot folder (default 2 GiB), and how to read it. */
  minFreeDiskBytes?: number;
  freeDiskBytes?: (path: string) => Promise<number | null>;
  /** Director Runtime Skill file (default config/director-runtime-skill.md), read at each planning start. */
  runtimeSkillPath?: string | URL;
}

export interface M2DraftInput { intent: string; targetSeconds?: number; aspect?: string; promptMode?: string; director?: string; preset?: string; approvedFacts?: string[]; forbiddenClaims?: string[]; constraints?: Partial<Record<keyof DirectorConstraints, unknown>>; subjectAnchor?: unknown }

/** The preset fills the constraints; explicit booleans from the request (the user's own ticks) win. */
function presetConstraints(preset: M2PresetId, overrides?: Partial<Record<keyof DirectorConstraints, unknown>>): DirectorConstraints {
  const result = { ...M2_PRESETS[preset].constraints };
  for (const key of DIRECTOR_CONSTRAINT_KEYS) if (typeof overrides?.[key] === "boolean") result[key] = overrides[key] as boolean;
  return result;
}

/** Statfs of the Autopilot folder; null when it cannot be read. */
async function readFreeDisk(path: string) {
  try { const info = await statfs(path); return Number(info.bavail) * Number(info.bsize); } catch { return null; }
}
const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/** What a provider error may carry (DirectorCallError); plain errors have none of it. */
type ProviderFailure = { code?: string; fatal?: boolean; billingUncertain?: boolean; usage?: DirectorUsage | null; transport?: DirectorTransportRecord[] };

export class AutopilotError extends Error {
  readonly code: string;
  readonly status: number;
  /** Structured detail for the panel (e.g. every package error and the ✅ / ❌ list). */
  readonly details?: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) { super(message); this.name = "AutopilotError"; this.code = code; this.status = status; this.details = details; }
}

type Outcome = "done" | "paused" | "failed" | "cancelled" | "stopped";
const SAVE_NODE = "15"; // T2VA keeps the FL2VA SaveVideo node id
const MAX_AUTO_RETRIES = 1;
/** ComfyUI execution errors worth one automatic retry (GPU memory pressure). Everything else fails. */
const RETRYABLE_EXECUTION = /(out of memory|outofmemory|allocation on device|CUBLAS_STATUS_ALLOC_FAILED)/i;
const PROBE_CLIP_SECONDS = 0.04;
const pad2 = (value: number) => String(value).padStart(2, "0");
const label = (shot: ShotTask) => `Shot ${pad2(shot.index)}`;
const messageOf = (cause: unknown) => (cause as { roughCut?: RoughCutError }).roughCut?.message ?? (cause instanceof Error ? cause.message : String(cause));
const isUncertain = (cause: unknown) => cause instanceof Error && cause.name === "SubmissionUncertainError";
const isNotSent = (cause: unknown) => cause instanceof Error && cause.name === "SubmissionNotSentError";
const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const cleanList = (value: unknown) => Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20) : [];
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

export class AutopilotWorker {
  /** 夜班已下线（A 批第 4 项收尾）：不再开工、不再继续；创建草稿和查看旧任务仍可以。 */
  private refuseRetired(): void { throw new AutopilotError("RETIRED", AUTOPILOT_RETIRED_MESSAGE, 410); }
  readonly instance = randomUUID();
  readonly store: AutopilotStore;
  private readonly comfy: AutopilotComfy;
  private readonly thermalStatus: AutopilotWorkerOptions["thermalStatus"];
  private readonly roughCut: RoughCutJobs;
  private readonly timing: { pollMs: number; reconnectMs: number; reconnectLimitMs: number; shotTimeoutMs: number; heartbeatMs: number; lockStaleMs: number; roughCutPollMs: number };
  private readonly now: () => Date;
  private readonly report: (line: string) => void;
  private readonly handover: Promise<unknown> | undefined;
  private readonly directors: Map<string, DirectorProvider>;
  private readonly defaultDirector: string;
  private readonly directorTimeoutMs: number;
  private readonly directorMaxCalls: number;
  private readonly minFreeDiskBytes: number;
  private readonly freeDiskBytes: (path: string) => Promise<number | null>;
  private readonly runtimeSkillPath: string | URL;
  private readonly jobs = new Map<string, AutopilotJob>();
  private damaged: { file: string; error: string }[] = [];
  private owner = false;
  private ownerInfo: LockInfo | null = null;
  private started: Promise<void> | null = null;
  private stopped: Promise<void> | null = null;
  private stopping = false;
  /** After stop() gave up waiting, a late step of the old loop must not write over a newer owner. */
  private frozen = false;
  private creating = false;
  private gating = false;
  private runner: Promise<void> | null = null;
  private readonly controllers = new Set<AbortController>();
  /** Attempts the user explicitly allowed to be replaced after "状态待确认". */
  private readonly resubmitApproved = new Set<string>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(options: AutopilotWorkerOptions) {
    this.store = new AutopilotStore(options.root);
    this.comfy = options.comfy;
    this.thermalStatus = options.thermalStatus;
    this.roughCut = new RoughCutJobs({ python: options.python, script: options.script, tempRoot: join(options.root, "work") });
    this.timing = {
      pollMs: options.pollMs ?? 1_500, reconnectMs: options.reconnectMs ?? 5_000, reconnectLimitMs: options.reconnectLimitMs ?? 15 * 60_000,
      shotTimeoutMs: options.shotTimeoutMs ?? 60 * 60_000, heartbeatMs: options.heartbeatMs ?? 15_000, lockStaleMs: options.lockStaleMs ?? 10 * 60_000,
      roughCutPollMs: options.roughCutPollMs ?? 1_000,
    };
    this.now = options.now ?? (() => new Date());
    this.report = options.report ?? (() => {});
    this.handover = options.handover;
    this.directors = new Map((options.directors ?? defaultDirectorProviders()).map((provider) => [provider.id, provider]));
    this.defaultDirector = options.defaultDirector ?? "mock";
    this.directorTimeoutMs = options.directorTimeoutMs ?? 5 * 60_000;
    this.directorMaxCalls = options.directorMaxCalls ?? 2;
    this.minFreeDiskBytes = options.minFreeDiskBytes ?? 2 * 1024 ** 3;
    this.freeDiskBytes = options.freeDiskBytes ?? readFreeDisk;
    this.runtimeSkillPath = options.runtimeSkillPath ?? DIRECTOR_RUNTIME_SKILL_FILE;
  }

  // ——— lifecycle ———

  start() { return (this.started ??= this.boot()); }

  private async boot() {
    await this.handover?.catch(() => {});
    await this.store.init();
    await this.reload();
    await this.tryOwn();
    const heartbeat = setInterval(() => { void this.beat(); }, this.timing.heartbeatMs);
    heartbeat.unref?.();
    this.timers.push(heartbeat);
  }

  /** Stops the loop at a safe point (a /prompt already in flight is allowed to finish and be recorded). Never cancels a job. */
  stop() {
    if (this.stopped) return this.stopped;
    this.stopping = true;
    this.stopped = (async () => {
      await this.started?.catch(() => {});
      for (const timer of this.timers) clearInterval(timer);
      this.wakeAll();
      const runner = this.runner;
      if (runner) await Promise.race([runner.catch(() => {}), delay(30_000)]);
      this.frozen = true;
      await this.roughCut.disposeAll().catch(() => {});
      await this.store.flush();
      if (this.owner) await this.store.releaseLock(this.instance).catch(() => {});
      this.owner = false;
    })();
    return this.stopped;
  }

  private async reload() {
    const { jobs, damaged } = await this.store.readAll();
    this.jobs.clear();
    for (const job of jobs) this.jobs.set(job.jobId, job);
    this.damaged = damaged;
  }

  private async tryOwn() {
    if (this.owner || this.stopping) return;
    const lock = await this.store.acquireLock(this.instance, this.timing.lockStaleMs);
    if (!lock.ok) { this.ownerInfo = lock.owner; return; }
    if (this.stopping) { await this.store.releaseLock(this.instance); return; }
    this.owner = true; this.ownerInfo = null;
    await this.reload();
    await this.recover();
    this.kick();
  }

  private async beat() {
    if (this.stopping) return;
    if (!this.owner) { await this.tryOwn().catch(() => {}); return; }
    if (!(await this.store.refreshLock(this.instance).catch(() => false))) {
      this.owner = false;
      this.report("[autopilot] 运行目录已被另一个进程接管，本进程停止执行夜班任务");
      this.wakeAll();
      return;
    }
    const job = this.activeJob();
    if (job && RUNNING_AUTOPILOT_STATUSES.includes(job.status)) await this.persist(job);
  }

  /** Service start: reattach to unfinished jobs from their ledger state; nothing is resubmitted here. */
  private async recover() {
    const active = [...this.jobs.values()].filter((job) => RUNNING_AUTOPILOT_STATUSES.includes(job.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const [position, job] of active.entries()) {
      if (position > 0) { await this.pauseJob(job, "发现多个进行中的夜班任务：只继续最早的一个，其余已暂停"); continue; }
      await this.log(job, { stage: "recovery", action: "service_restart", detail: { status: job.status, shots: job.shots.map((shot) => `${shot.shotId}:${shot.status}`), roughCut: job.roughCutStatus } });
      if (job.roughCutStatus === "running") { job.roughCutStatus = "pending"; await this.log(job, { stage: "recovery", action: "rough_cut_restart", detail: "粗剪在服务重启时中断，将从头重新执行（本地 CPU，不涉及 GPU 提交）" }); }
      job.stageText = "服务重启后恢复任务状态";
      await this.persist(job);
    }
  }

  // ——— public API (used by the dev-server routes) ———

  async ready() { await this.start(); }

  overview() {
    const jobs = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const active = jobs.find(isActiveAutopilotJob) ?? null;
    return {
      owner: this.owner, pid: process.pid, ownerPid: this.owner ? process.pid : this.ownerInfo?.pid ?? null, damaged: this.damaged,
      active: active ? structuredClone(active) : null, latest: jobs[0] ? structuredClone(jobs[0]) : null, jobs: jobs.map(summarizeAutopilotJob),
    };
  }

  /** Read view; a non-owner (another dev server holds the folder) re-reads the ledgers from disk. */
  async list() { await this.ready(); if (!this.owner) await this.reload(); return this.overview(); }

  async get(jobId: string) {
    await this.ready();
    if (!this.owner) await this.reload();
    return structuredClone(this.require(jobId));
  }

  async create(): Promise<AutopilotJob> {
    await this.ready();
    this.requireOwner();
    this.refuseRetired();
    if (this.creating || this.activeJob()) throw new AutopilotError("ACTIVE_JOB", ACTIVE_JOB_MESSAGE, 409);
    this.creating = true;
    try {
      if (!(await this.comfy.isAvailable())) throw new AutopilotError("COMFY_OFFLINE", COMFY_OFFLINE_MESSAGE, 503);
      const settings = structuredClone(AUTOPILOT_M1_SETTINGS);
      for (const shot of AUTOPILOT_M1_SHOTS) {
        const preflight = runH3Preflight({ mode: "t2va", prompt: compileH3Prompt(shot.prompt, settings.soundMode), rawPrompt: shot.prompt, counts: frameModeCounts("t2va"), length: settings.length, megapixels: settings.megapixels, dimensions: t2vaDimensions(settings) });
        if (!preflight.ok) throw new AutopilotError("PREFLIGHT", `${shot.title}：${formatPreflight(preflight)}`, 422);
      }
      const now = this.now();
      const jobId = `ap-${autopilotStamp(now).replace("_", "-")}-${randomBytes(2).toString("hex")}`;
      const at = now.toISOString();
      const job: AutopilotJob = {
        schemaVersion: AUTOPILOT_SCHEMA_VERSION, jobId, kind: AUTOPILOT_M1_KIND, title: "Autopilot M1 · 三镜头无人值守测试",
        createdAt: at, updatedAt: at, completedAt: null, status: "queued", currentStage: "queued", currentShotIndex: null, stageText: "已创建，等待开始",
        pauseReason: null, cancelRequested: false, settings,
        shots: AUTOPILOT_M1_SHOTS.map((plan, position): ShotTask => ({
          shotId: shotIdFor(position + 1), index: position + 1, title: plan.title, prompt: plan.prompt, seed: plan.seed, status: "pending", retryCount: 0,
          runId: null, comfyPromptId: null, attempts: [], run: null, outputFile: null, outputBytes: null, comfyOutput: null, media: null, startedAt: null, completedAt: null, error: null,
        })),
        roughCutStatus: "pending", roughCutOutput: null, roughCutError: null,
        finalOutputPath: null, finalOutputFile: null, finalFilename: autopilotOutputName(now), finalDuration: null,
        lastHeartbeat: at, errorLog: [], worker: { pid: process.pid, instance: this.instance },
      };
      this.jobs.set(jobId, job);
      await this.persist(job);
      await this.log(job, { stage: "job", action: "created", detail: { shots: job.shots.map((shot) => shot.title), mode: "t2va", length: settings.length, fps: settings.fps, megapixels: settings.megapixels, turbo: settings.turbo, soundMode: settings.soundMode } });
      this.kick();
      return structuredClone(job);
    } finally { this.creating = false; }
  }

  async cancel(jobId: string) {
    await this.ready();
    this.requireOwner();
    const job = this.require(jobId);
    if (!isActiveAutopilotJob(job)) throw new AutopilotError("JOB_STATE", "夜班任务已经结束，无需取消", 409);
    if (job.cancelRequested) return structuredClone(job);
    job.cancelRequested = true;
    await this.log(job, { stage: "job", action: "cancel_requested" });
    if (job.status === "paused" || job.status === "awaiting_confirmation" || !this.runner) { await this.cancelNow(job, null); return structuredClone(job); }
    job.stageText = "正在停止";
    await this.persist(job);
    this.wakeAll();
    return structuredClone(job);
  }

  /**
   * Continues a paused job. A Shot in "状态待确认" is re-checked by prompt_id first; only with
   * `resubmit` (the user's explicit confirmation) may it get a new attempt when ComfyUI still has no trace of it.
   */
  async resume(jobId: string, options: { resubmit?: boolean } = {}) {
    await this.ready();
    this.requireOwner();
    this.refuseRetired();
    const job = this.require(jobId);
    if (job.status !== "paused") throw new AutopilotError("JOB_STATE", "只有已暂停的夜班任务可以继续", 409);
    const shot = job.shots.find((item) => item.status === "needs_confirmation");
    if (shot) {
      const attempt = shot.attempts.at(-1);
      shot.status = attempt ? "submitting" : "pending";
      shot.error = null;
      if (attempt && options.resubmit) this.resubmitApproved.add(attempt.runId);
      await this.log(job, { stage: "shot", action: options.resubmit ? "user_confirmed_resubmit" : "user_recheck", shot: shot.index, runId: attempt?.runId ?? null, promptId: attempt?.comfyPromptId ?? null, detail: options.resubmit ? "用户确认：若 ComfyUI 仍找不到原任务，则重新提交（不计入自动重试）" : "用户要求重新检查原任务" });
    } else await this.log(job, { stage: "job", action: "resumed" });
    job.status = "running"; job.pauseReason = null; job.stageText = "继续执行";
    await this.persist(job);
    this.kick();
    return structuredClone(job);
  }

  // ——— M2: one sentence → director plan → confirmation → N Shots ———

  directorsInfo() { return { defaultDirector: this.defaultDirector, providers: [...this.directors.values()].map(describeProvider) }; }

  /** Starts planning only (text, no GPU, no ComfyUI): the plan is shown and waits for 【开始制作】. */
  async createDraft(input: M2DraftInput): Promise<AutopilotJob> {
    await this.ready();
    this.requireOwner();
    const intent = typeof input.intent === "string" ? input.intent.trim() : "";
    if (!intent) throw new AutopilotError("INVALID_INPUT", "请先用一句话说明想做什么视频", 422);
    if (intent.length > M2_INTENT_MAX) throw new AutopilotError("INVALID_INPUT", `需求最多 ${M2_INTENT_MAX} 字`, 422);
    const targetSeconds = input.targetSeconds === undefined ? M2_DEFAULT_SECONDS : Number(input.targetSeconds);
    if (!Number.isFinite(targetSeconds) || targetSeconds < M2_SECONDS_RANGE.min || targetSeconds > M2_SECONDS_RANGE.max) throw new AutopilotError("INVALID_INPUT", `目标时长需在 ${M2_SECONDS_RANGE.min}–${M2_SECONDS_RANGE.max} 秒之间`, 422);
    const aspect = (input.aspect ?? M2_DEFAULT_ASPECT) as M2Aspect;
    if (!M2_ASPECTS.includes(aspect)) throw new AutopilotError("INVALID_INPUT", `不支持的画面比例：${String(input.aspect)}`, 422);
    const promptMode = (input.promptMode ?? "official") as M2PromptMode;
    if (promptMode !== "official" && promptMode !== "plain") throw new AutopilotError("INVALID_INPUT", "未知的 Prompt 模式", 422);
    const preset = input.preset === undefined || input.preset === "" ? M2_DEFAULT_PRESET : input.preset;
    if (!isPresetId(preset)) throw new AutopilotError("INVALID_INPUT", `未知的题材预设：${String(input.preset)}`, 422);
    const approvedFacts = cleanList(input.approvedFacts);
    // Product / brand: no approved facts, no plan (the model would have to invent features or data).
    if (M2_PRESETS[preset].requiresApprovedFacts && !approvedFacts.length) throw new AutopilotError("FACTS_REQUIRED", PRODUCT_FACTS_REQUIRED_MESSAGE, 422);
    let subjectAnchor: SubjectAnchor | null;
    try { subjectAnchor = normalizeSubjectAnchor(input.subjectAnchor); } catch (cause) { throw new AutopilotError("INVALID_INPUT", messageOf(cause), 422); }
    const provider = this.directors.get(input.director ?? this.defaultDirector);
    if (!provider) throw new AutopilotError("DIRECTOR_UNAVAILABLE", `没有名为 ${String(input.director)} 的导演模型`, 422);
    const state = provider.available();
    if (!state.ok) throw new AutopilotError("DIRECTOR_UNAVAILABLE", `${provider.label}：${state.reason ?? "不可用"}`, 422);
    if (this.creating || this.activeJob()) throw new AutopilotError("ACTIVE_JOB", ACTIVE_JOB_MESSAGE, 409);
    this.creating = true;
    try {
      const now = this.now();
      const jobId = `ap-${autopilotStamp(now).replace("_", "-")}-${randomBytes(2).toString("hex")}`;
      const at = now.toISOString();
      const job: AutopilotJob = {
        schemaVersion: AUTOPILOT_SCHEMA_VERSION, jobId, kind: AUTOPILOT_M2_KIND, title: `M2 草稿 · ${intent.slice(0, 24)}`,
        createdAt: at, updatedAt: at, completedAt: null, status: "planning", currentStage: "planning", currentShotIndex: null, stageText: "等待导演规划",
        pauseReason: null, cancelRequested: false, settings: m2Settings(aspect, H3_MIN_LENGTH, promptMode), shots: [],
        roughCutStatus: "pending", roughCutOutput: null, roughCutError: null,
        finalOutputPath: null, finalOutputFile: null, finalFilename: autopilotOutputName(now, AUTOPILOT_M2_KIND), finalDuration: null,
        lastHeartbeat: at, errorLog: [], worker: { pid: process.pid, instance: this.instance }, failure: null, reportFile: null,
        m2: {
          intent, targetSeconds, aspect, promptMode, schemaVersion: M2_DIRECTOR_SCHEMA_VERSION, approvedFacts, forbiddenClaims: cleanList(input.forbiddenClaims),
          preset, suggestedPreset: suggestPreset(intent), constraints: presetConstraints(preset, input.constraints), subjectAnchor, checks: null, gate: null,
          planSource: provider.kind === "local" ? "local_lmstudio" : provider.kind === "cloud" ? "cloud_api" : "mock",
          director: { providerId: provider.id, label: provider.label, kind: provider.kind, usesLocalGpu: provider.usesLocalGpu, maxCalls: this.directorMaxCalls, releasedAt: null, version: provider.version ?? null, release: null },
          attempts: [], plan: null, compiled: null, compilerVersion: null, totalSeconds: null, warnings: [], plannedAt: null, confirmedAt: null,
        },
      };
      this.jobs.set(jobId, job);
      await this.persist(job);
      await this.log(job, { stage: "job", action: "created", detail: { kind: AUTOPILOT_M2_KIND, targetSeconds, aspect, promptMode, director: provider.id, preset, constraints: job.m2!.constraints, approvedFacts: approvedFacts.length, subjectAnchor } });
      this.kick();
      return structuredClone(job);
    } finally { this.creating = false; }
  }

  // ——— M2 external director: task text out, Director Plan Package in ———

  /** Checks a request coming from the panel (the one copied to GPT / Claude, or the one a package must match). */
  private packageRequest(input: unknown): DirectorPackageRequest {
    const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const brief = typeof raw.brief === "string" ? raw.brief.trim() : "";
    if (!brief) throw new AutopilotError("INVALID_INPUT", "请先用一句话说明想做什么视频", 422);
    if (brief.length > M2_INTENT_MAX) throw new AutopilotError("INVALID_INPUT", `需求最多 ${M2_INTENT_MAX} 字`, 422);
    const targetDurationSeconds = Number(raw.targetDurationSeconds ?? M2_DEFAULT_SECONDS);
    if (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds < M2_SECONDS_RANGE.min || targetDurationSeconds > M2_SECONDS_RANGE.max) throw new AutopilotError("INVALID_INPUT", `目标时长需在 ${M2_SECONDS_RANGE.min}–${M2_SECONDS_RANGE.max} 秒之间`, 422);
    const aspectRatio = (raw.aspectRatio ?? M2_DEFAULT_ASPECT) as M2Aspect;
    if (!M2_ASPECTS.includes(aspectRatio)) throw new AutopilotError("INVALID_INPUT", `不支持的画面比例：${String(raw.aspectRatio)}`, 422);
    const preset = raw.preset === undefined || raw.preset === "" ? M2_DEFAULT_PRESET : raw.preset;
    if (!isPresetId(preset)) throw new AutopilotError("INVALID_INPUT", `未知的题材预设：${String(raw.preset)}`, 422);
    const switches = (raw.constraints && typeof raw.constraints === "object" ? raw.constraints : {}) as Record<string, unknown>;
    const approvedFacts = cleanList(raw.approvedFacts);
    if (M2_PRESETS[preset].requiresApprovedFacts && !approvedFacts.length) throw new AutopilotError("FACTS_REQUIRED", PRODUCT_FACTS_REQUIRED_MESSAGE, 422);
    let subjectAnchor: SubjectAnchor | null;
    try { subjectAnchor = normalizeSubjectAnchor(raw.subjectAnchor); } catch (cause) { throw new AutopilotError("INVALID_INPUT", messageOf(cause), 422); }
    return {
      brief, targetDurationSeconds, aspectRatio, preset, approvedFacts, forbiddenClaims: cleanList(raw.forbiddenClaims), subjectAnchor,
      constraints: { ...presetConstraints(preset, switches), forbiddenTerms: cleanList(switches.forbiddenTerms) },
    };
  }

  /** 【复制给GPT / Claude】: the task text for a chat-window director (no job, no model call). */
  async directorTask(input: unknown) {
    await this.ready();
    const request = this.packageRequest(input);
    let skill: DirectorRuntimeSkill;
    try { skill = loadDirectorRuntimeSkill(this.runtimeSkillPath); } catch (cause) { throw new AutopilotError("RUNTIME_SKILL_INVALID", `导演运行规则无法加载：${messageOf(cause)}`, 500); }
    return { ...buildExternalDirectorTask(request, skill), request };
  }

  /**
   * 【导入并检查】 a Director Plan Package from GPT / Claude / an API. It is never trusted: parse (JSON or one
   * ```json block only), schema, the request it answers (must equal what the canvas asked for), preset facts, then
   * the full plan validation + deterministic compilation + preflight. Anything wrong → 422 with the reasons and the
   * ✅ / ❌ list, and no job. A clean package becomes a plan waiting for 【开始夜班制作】 (same gate, same Shot loop).
   */
  async createImportedDraft(input: { packageText: unknown; providerLabel?: unknown; expected?: unknown }): Promise<AutopilotJob> {
    await this.ready();
    this.requireOwner();
    const reject = (errors: string[], checks: PlanCheck[] | null) => new AutopilotError("PACKAGE_INVALID", `导演计划没有通过检查：${errors.slice(0, 3).map((error) => error.replace(/\[[a-z_]+\]\s*/, "")).join("；")}${errors.length > 3 ? `（共 ${errors.length} 项）` : ""}`, 422, { errors, checks });
    const parsed = parseDirectorPlanPackage(typeof input.packageText === "string" ? input.packageText : "");
    if (!parsed.ok) throw reject(parsed.errors, null);
    let draft: ReturnType<typeof packageToDraft>;
    try { draft = packageToDraft(parsed.pkg); } catch (cause) { throw reject([`subjectAnchor：${messageOf(cause)}`], null); }
    const problems: string[] = [];
    if (input.expected !== undefined && input.expected !== null) problems.push(...packageRequestDifferences(parsed.pkg, this.packageRequest(input.expected)).map((difference) => `计划包与画布中的需求不一致：${difference}`));
    if (M2_PRESETS[draft.preset].requiresApprovedFacts && !draft.approvedFacts.length) problems.push(PRODUCT_FACTS_REQUIRED_MESSAGE);
    const forbiddenClaims = [...new Set([...draft.forbiddenClaims, ...draft.forbiddenTerms])];
    const compiled = compileDirectorPlan(draft.plan, { targetSeconds: draft.targetSeconds, aspect: draft.aspect, promptMode: "official", intent: draft.intent, approvedFacts: draft.approvedFacts, forbiddenClaims, constraints: draft.constraints, subjectAnchor: draft.subjectAnchor });
    const checks = planChecks(compiled, draft.targetSeconds);
    if (problems.length || !compiled.ok || !compiled.plan) throw reject([...problems, ...compiled.errors], checks);
    if (this.creating || this.activeJob()) throw new AutopilotError("ACTIVE_JOB", ACTIVE_JOB_MESSAGE, 409);
    this.creating = true;
    try {
      const now = this.now();
      const jobId = `ap-${autopilotStamp(now).replace("_", "-")}-${randomBytes(2).toString("hex")}`;
      const at = now.toISOString();
      const providerLabel: ExternalProviderLabel = (EXTERNAL_PROVIDER_LABELS as readonly string[]).includes(String(input.providerLabel)) ? input.providerLabel as ExternalProviderLabel : "other";
      const label = `外部AI计划（${providerLabel === "other" ? "其他" : providerLabel}）`;
      const job: AutopilotJob = {
        schemaVersion: AUTOPILOT_SCHEMA_VERSION, jobId, kind: AUTOPILOT_M2_KIND, title: `M2 草稿 · ${compiled.plan.title}`,
        createdAt: at, updatedAt: at, completedAt: null, status: "awaiting_confirmation", currentStage: "awaiting_confirmation", currentShotIndex: null,
        stageText: `导演计划已导入：${compiled.shots.length} 个镜头，约 ${compiled.totalSeconds.toFixed(1)} 秒。确认后点【开始夜班制作】`,
        pauseReason: null, cancelRequested: false, settings: m2Settings(draft.aspect, H3_MIN_LENGTH, "official"), shots: this.shotTasks(compiled.shots, "official"),
        roughCutStatus: "pending", roughCutOutput: null, roughCutError: null,
        finalOutputPath: null, finalOutputFile: null, finalFilename: autopilotOutputName(now, AUTOPILOT_M2_KIND), finalDuration: null,
        lastHeartbeat: at, errorLog: [], worker: { pid: process.pid, instance: this.instance }, failure: null, reportFile: null,
        m2: {
          intent: draft.intent, targetSeconds: draft.targetSeconds, aspect: draft.aspect, promptMode: "official", schemaVersion: M2_DIRECTOR_SCHEMA_VERSION,
          approvedFacts: draft.approvedFacts, forbiddenClaims, forbiddenTerms: draft.forbiddenTerms, preset: draft.preset, suggestedPreset: suggestPreset(draft.intent),
          constraints: draft.constraints, subjectAnchor: draft.subjectAnchor, checks, gate: null,
          planSource: "external_ai",
          importInfo: { providerLabel, importedAt: at, packageVersion: parsed.pkg.packageVersion, packageHash: createHash("sha256").update(parsed.canonical).digest("hex"), originalFile: "director/imported_package.txt", packageFile: "director/imported_package.json", expectedMatched: input.expected !== undefined && input.expected !== null },
          director: { providerId: "external", label, kind: "external", usesLocalGpu: false, maxCalls: 0, releasedAt: null, version: null, release: null },
          attempts: [], plan: compiled.plan, compiled: compiled.shots, compilerVersion: M2_COMPILER_VERSION, totalSeconds: compiled.totalSeconds, warnings: compiled.warnings, plannedAt: at, confirmedAt: null,
        },
      };
      const dir = join(this.store.jobDir(jobId), "director");
      await mkdir(dir, { recursive: true });
      // What the user pasted, byte for byte, and the parsed package it was read as (its hash is recorded).
      await this.store.atomicWrite(join(dir, "imported_package.txt"), typeof input.packageText === "string" ? input.packageText : "");
      await this.store.atomicWrite(join(dir, "imported_package.json"), JSON.stringify(JSON.parse(parsed.canonical), null, 2));
      this.jobs.set(jobId, job);
      await this.persist(job);
      await this.log(job, { stage: "job", action: "plan_imported", detail: { source: "external_ai", providerLabel, packageVersion: parsed.pkg.packageVersion, packageHash: job.m2!.importInfo!.packageHash, shots: compiled.shots.length, totalSeconds: compiled.totalSeconds, preset: draft.preset, expectedMatched: job.m2!.importInfo!.expectedMatched } });
      return structuredClone(job);
    } finally { this.creating = false; }
  }

  private shotTasks(compiled: CompiledDirectorShot[], promptMode: M2PromptMode): ShotTask[] {
    return compiled.map((shot): ShotTask => ({
      shotId: shotIdFor(shot.index), index: shot.index, title: `Shot ${String(shot.index).padStart(2, "0")} · ${shot.title}`, prompt: shot.submitPrompt, seed: randomInt(1, 2_147_483_647),
      status: "pending", retryCount: 0, runId: null, comfyPromptId: null, attempts: [], run: null, outputFile: null, outputBytes: null, comfyOutput: null, media: null,
      startedAt: null, completedAt: null, error: null, settings: shot.settings, rawPrompt: shot.plainPrompt, promptMode, plannedSeconds: shot.plannedSeconds,
    }));
  }

  /**
   * 【开始制作】 = the production gate, run again right before the first H3 submission:
   *
   *   1–5  plan schema, hard constraints, approved facts, compiler output, H3 preflight — the frozen plan is
   *        re-validated from scratch; a fault here ends the job (preflight_failed)
   *   9 → 7 → 8  disk space, ComfyUI connection, other GPU work in ComfyUI
   *   6    last: the local director model is unloaded and the GPU re-measured (another task using it → conflict)
   *
   * Environment faults keep the plan (the user can press again later). Any failure → zero H3 submissions.
   */
  async confirm(jobId: string) {
    await this.ready();
    this.requireOwner();
    this.refuseRetired();
    const job = this.require(jobId);
    if (job.status !== "awaiting_confirmation" || !job.m2) throw new AutopilotError("JOB_STATE", "只有等待确认的导演计划可以开始制作", 409);
    if (this.gating) throw new AutopilotError("GATE_RUNNING", "正在做开始前检查，请稍候", 409);
    this.gating = true;
    try {
      await this.log(job, { stage: "job", action: "gate_started" });
      const { report, failure } = await this.productionGate(job);
      if (job.cancelRequested || job.status !== "awaiting_confirmation") throw new AutopilotError("JOB_STATE", "计划已被放弃，没有开始制作", 409);
      job.m2.gate = report;
      if (failure) {
        const at = this.iso();
        job.failure = { ...failure, at };
        this.noteError(job, "gate", null, failure.message, failure.kind);
        if (failure.retryable) job.stageText = `未开始视频生成：${failure.message}（计划已保留，可以稍后再点【开始制作】）`;
        else { job.status = "preflight_failed"; job.completedAt = at; job.stageText = `开始前检查未通过，未开始视频生成：${failure.message}`; }
        if (!failure.retryable) await this.writeReport(job);
        await this.persist(job);
        await this.log(job, { stage: "job", action: "gate_failed", error: failure.message, detail: { kind: failure.kind, checks: report.checks } });
        throw new AutopilotError(failure.kind.toUpperCase(), `${AUTOPILOT_FAILURE_LABELS[failure.kind]}：${failure.message}`, failure.kind === "comfyui_unavailable" ? 503 : 409);
      }
      job.failure = null;
      job.m2.confirmedAt = this.iso();
      job.status = "queued"; job.currentStage = "queued"; job.stageText = "开始前检查通过，开始制作";
      await this.persist(job);
      await this.log(job, { stage: "job", action: "plan_confirmed", detail: { shots: job.shots.length, totalSeconds: job.m2.totalSeconds, gate: report.checks.map((check) => `${check.id}:${check.state}`) } });
      this.kick();
      return structuredClone(job);
    } finally { this.gating = false; }
  }

  private async productionGate(job: AutopilotJob): Promise<{ report: ProductionGateReport; failure: Omit<AutopilotFailure, "at"> | null }> {
    const m2 = job.m2!;
    const checks: ProductionGateCheck[] = [];
    let failure: Omit<AutopilotFailure, "at"> | null = null;
    const push = (id: ProductionGateCheck["id"], label: string, ok: boolean | null, detail: string) => { checks.push({ id, label, state: ok === null ? "skipped" : ok ? "pass" : "fail", detail }); };
    const fail = (kind: AutopilotFailureKind, message: string, retryable: boolean) => { failure ??= { kind, message, retryable }; };
    const summary = (items: string[] | null, pass: string) => items === null ? "计划结构不合法，未检查" : items.length ? items.slice(0, 3).join("；") : pass;

    // 1–5: the frozen plan, validated again exactly as if a model had just returned it.
    const parsed = DirectorPlanSchema.safeParse(m2.plan);
    push("plan_schema", "导演计划结构", parsed.success, parsed.success ? "通过" : parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "计划"}：${issue.message}`).join("；"));
    const compiled = parsed.success ? compileDirectorPlan(parsed.data, { targetSeconds: m2.targetSeconds, aspect: m2.aspect, promptMode: m2.promptMode, intent: m2.intent, approvedFacts: m2.approvedFacts ?? [], forbiddenClaims: m2.forbiddenClaims ?? [], constraints: normalizeConstraints(m2.constraints), subjectAnchor: m2.subjectAnchor ?? null }) : null;
    const issuesIn = (categories: PlanCheckCategory[]) => compiled ? compiled.issues.filter((issue) => categories.includes(issue.category)).map((issue) => issue.message) : null;
    const semantic = issuesIn(["structure", "shots", "duration", "readable_text", "generated_ui", "dialogue", "camera", "language"]);
    push("constraints", "硬约束（对白 / 可读文字 / 界面 / 时长 / 运镜）", semantic && !semantic.length, summary(semantic, "通过"));
    const product = issuesIn(["product"]);
    const missingFacts = M2_PRESETS[m2.preset ?? M2_DEFAULT_PRESET].requiresApprovedFacts && !(m2.approvedFacts ?? []).length;
    push("approved_facts", "产品事实", missingFacts ? false : product && !product.length, missingFacts ? PRODUCT_FACTS_REQUIRED_MESSAGE : summary(product, (m2.approvedFacts ?? []).length ? `只使用了 ${(m2.approvedFacts ?? []).length} 条已批准事实` : "没有产品说法"));
    const compileProblems = compiled ? [
      ...(issuesIn(["compile"]) ?? []),
      ...(compiled.shots.length !== job.shots.length ? ["镜头数量与待提交的任务不一致"] : []),
      ...job.shots.filter((shot, position) => compiled.shots[position]?.submitPrompt !== shot.prompt).map((shot) => `${shot.title}：待提交的 Prompt 与重新编译的结果不一致`),
    ] : null;
    push("compiler", "H3 Prompt 编译", compileProblems && !compileProblems.length, summary(compileProblems, `${M2_COMPILER_VERSION}，与待提交的 Prompt 逐字一致`));
    const preflightProblems = job.shots.length ? job.shots.flatMap((shot) => {
      const settings = shot.settings ?? job.settings;
      const result = runH3Preflight({ mode: "t2va", prompt: compileH3Prompt(shot.prompt, settings.soundMode), rawPrompt: shot.prompt, counts: frameModeCounts("t2va"), length: settings.length, megapixels: settings.megapixels, dimensions: t2vaDimensions(settings) });
      return result.ok ? [] : [`${shot.title}：${formatPreflight(result)}`];
    }) : ["计划里没有镜头"];
    push("preflight", "H3 预检", !preflightProblems.length, summary(preflightProblems, `${job.shots.length} 个镜头通过`));
    const planFault = checks.find((check) => check.state === "fail");
    if (planFault) fail("preflight_failed", `${planFault.label}：${planFault.detail}`, false);

    // 9, 7, 8: the machine. Each runs only while everything before it passed.
    if (failure) push("disk", "磁盘空间", null, "未检查");
    else {
      const free = await this.freeDiskBytes(this.store.root);
      const ok = free !== null && free >= this.minFreeDiskBytes;
      const detail = free === null ? "无法读取磁盘剩余空间" : `剩余 ${gib(free)} GB（至少需要 ${gib(this.minFreeDiskBytes)} GB）`;
      push("disk", "磁盘空间", ok, detail);
      if (!ok) fail("disk_low", detail, true);
    }
    if (failure) push("comfyui", "ComfyUI 连接", null, "未检查");
    else {
      const online = await this.comfy.isAvailable();
      push("comfyui", "ComfyUI 连接", online, online ? "已连接" : COMFY_OFFLINE_MESSAGE);
      if (!online) fail("comfyui_unavailable", COMFY_OFFLINE_MESSAGE, true);
    }
    if (failure) push("gpu", "GPU 空闲（ComfyUI 队列）", null, "未检查");
    else if (!this.comfy.queueSize) push("gpu", "GPU 空闲（ComfyUI 队列）", null, "无法读取 ComfyUI 队列（适配器不支持）");
    else {
      try {
        const queue = await this.comfy.queueSize();
        const idle = queue.running + queue.pending === 0;
        const detail = idle ? "ComfyUI 队列为空" : `ComfyUI 正在执行 ${queue.running} 个、排队 ${queue.pending} 个其他任务`;
        push("gpu", "GPU 空闲（ComfyUI 队列）", idle, detail);
        if (!idle) fail("gpu_busy", detail, true);
      } catch (cause) {
        push("gpu", "GPU 空闲（ComfyUI 队列）", false, `读取 ComfyUI 队列失败：${messageOf(cause)}`);
        fail("comfyui_unavailable", "读取 ComfyUI 队列失败", true);
      }
    }

    // A plan from outside never loaded LM Studio: if a model is still in memory, say so and let the user unload it (never unloaded for them).
    if (m2.director.usesLocalGpu) push("lmstudio", "LM Studio 显存", null, "本地导演模型在下一步由本任务释放");
    else if (failure) push("lmstudio", "LM Studio 显存", null, "未检查");
    else {
      const probe = [...this.directors.values()].find((provider) => typeof (provider as { loadedModels?: unknown }).loadedModels === "function") as { loadedModels(): Promise<string[] | null> } | undefined;
      const loaded = probe ? await probe.loadedModels().catch(() => null) : null;
      if (!probe) push("lmstudio", "LM Studio 显存", null, "没有配置本地 LM Studio");
      else if (loaded === null) push("lmstudio", "LM Studio 显存", true, "LM Studio 未运行或无法连接（视为没有占用显存）");
      else if (!loaded.length) push("lmstudio", "LM Studio 显存", true, "LM Studio 没有加载模型");
      else {
        const detail = `LM Studio正在占用显存（已加载 ${loaded.join("、")}）。本任务不使用本地导演，不会替你卸载；请在 LM Studio 中卸载模型后再点【开始夜班制作】`;
        push("lmstudio", "LM Studio 显存", false, detail);
        fail("lmstudio_occupying_gpu", detail, true);
      }
    }

    // 6, last: only now does the local director model leave the GPU.
    if (!m2.director.usesLocalGpu) push("local_director", "本地导演模型", null, "导演不使用本机 GPU，无需释放");
    else if (failure) push("local_director", "本地导演模型", null, "未检查（前面的检查未通过，模型保持加载）");
    else {
      const provider = this.directors.get(m2.director.providerId);
      const released = provider ? await this.releaseLocalDirector(job, provider) : { ok: false as const, code: "DIRECTOR_RELEASE_FAILED", message: "找不到本地导演 Provider，无法确认显存已释放" };
      if (released.ok) {
        const release = m2.director.release;
        push("local_director", "本地导演模型", true, release?.unloaded.length ? `已卸载 ${release.unloaded.join("、")}${release.freeAfterMiB !== null ? `，空闲显存 ${release.freeAfterMiB} MiB` : ""}` : "没有已加载的导演模型");
      } else {
        push("local_director", "本地导演模型", false, released.message);
        fail(released.code === RESOURCE_CONFLICT ? "local_director_resource_conflict" : "director_release_failed", released.message, true);
      }
    }
    return { report: { at: this.iso(), ok: !failure, checks }, failure };
  }

  /**
   * M2 production report (report.json next to the ledger), written at every end state BEFORE that state is
   * persisted (callers persist right after), so a ledger showing an end state always has its report: the brief, preset,
   * constraints, facts, every director call (raw reply files), the plan, compiler version, each Shot's final
   * prompt / Run / video, the final sequence and MP4, timings and retries.
   */
  private async writeReport(job: AutopilotJob) {
    if (job.kind !== AUTOPILOT_M2_KIND || !job.m2 || this.frozen) return;
    const m2 = job.m2;
    const span = (from: string | null, to: string | null) => from && to ? Date.parse(to) - Date.parse(from) : null;
    const report = {
      reportVersion: 1, jobId: job.jobId, status: job.status, failure: job.failure ?? null, createdAt: job.createdAt, plannedAt: m2.plannedAt, confirmedAt: m2.confirmedAt, completedAt: job.completedAt,
      source: { planSource: m2.planSource ?? (m2.director.kind === "local" ? "local_lmstudio" : m2.director.kind === "cloud" ? "cloud_api" : "mock"), importInfo: m2.importInfo ?? null },
      brief: { intent: m2.intent, targetSeconds: m2.targetSeconds, aspect: m2.aspect, promptMode: m2.promptMode, preset: m2.preset ?? M2_DEFAULT_PRESET, suggestedPreset: m2.suggestedPreset ?? null, constraints: m2.constraints ?? null, approvedFacts: m2.approvedFacts ?? [], forbiddenClaims: m2.forbiddenClaims ?? [], subjectAnchor: m2.subjectAnchor ?? null },
      director: {
        provider: m2.director.providerId, label: m2.director.label, version: m2.director.version ?? null, runtimeSkill: m2.director.runtimeSkill ?? null, repaired: m2.attempts.length > 1, release: m2.director.release ?? null, releaseError: m2.director.releaseError ?? null,
        calls: m2.attempts.map((attempt) => ({ kind: attempt.kind, ok: attempt.ok, model: attempt.model, durationMs: attempt.durationMs, usage: attempt.usage, rawResponse: attempt.file, errors: attempt.errors })),
      },
      plan: m2.plan, checks: m2.checks ?? null, gate: m2.gate ?? null, compilerVersion: m2.compilerVersion, plannedSeconds: m2.totalSeconds,
      shots: job.shots.map((shot) => ({
        index: shot.index, title: shot.title, plannedSeconds: shot.plannedSeconds ?? null, length: shot.settings?.length ?? null, seed: shot.seed, status: shot.status,
        finalPrompt: shot.prompt, runUsed: shot.status === "completed" ? shot.runId : null, h3Retries: shot.retryCount,
        runs: shot.attempts.map((attempt) => ({ runId: attempt.runId, outcome: attempt.outcome, error: attempt.error })),
        video: shot.outputFile, media: shot.media, startedAt: shot.startedAt, completedAt: shot.completedAt, error: shot.error,
      })),
      finalSequence: job.roughCutOutput?.clipOrder ?? null, roughCut: job.roughCutOutput, roughCutError: job.roughCutError,
      output: job.status === "completed" ? { file: job.finalOutputFile, path: job.finalOutputPath, filename: job.finalFilename, duration: job.finalDuration } : null,
      timing: { planningMs: span(job.createdAt, m2.plannedAt), generationMs: span(m2.confirmedAt, job.status === "completed" ? job.completedAt : null) },
      errors: job.errorLog,
    };
    try {
      await this.store.atomicWrite(join(this.store.jobDir(job.jobId), "report.json"), JSON.stringify(report, null, 2));
      job.reportFile = "report.json";
    } catch (cause) { await this.log(job, { stage: "job", action: "report_failed", error: messageOf(cause) }); }
  }

  async outputFile(jobId: string) {
    const job = await this.get(jobId);
    if (job.status !== "completed" || !job.finalOutputFile || !job.finalFilename) throw new AutopilotError("NO_OUTPUT", "夜班任务还没有成片", 404);
    const path = join(this.store.jobDir(jobId), job.finalOutputFile);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new AutopilotError("NO_OUTPUT", "成片文件不存在（可能已被移动或删除）", 404);
    return { path, size: info.size, filename: job.finalFilename };
  }

  // ——— the job loop ———

  private activeJob() { return [...this.jobs.values()].find(isActiveAutopilotJob) ?? null; }

  private require(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new AutopilotError("NOT_FOUND", "夜班任务不存在", 404);
    return job;
  }

  private requireOwner() {
    if (!this.owner) throw new AutopilotError("NOT_OWNER", `夜班任务由另一个开发服务器进程负责${this.ownerInfo ? `（PID ${this.ownerInfo.pid}）` : ""}，请在那个页面操作`, 409);
  }

  private kick() {
    if (!this.owner || this.stopping || this.runner) return;
    const job = [...this.jobs.values()].filter((item) => RUNNING_AUTOPILOT_STATUSES.includes(item.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return;
    this.runner = this.drive(job)
      .catch(async (cause) => { if (!this.stopping) await this.failJob(job, "job", job.currentShotIndex, `夜班服务内部错误：${messageOf(cause)}`, "INTERNAL"); })
      .finally(() => { this.runner = null; if (!this.stopping) this.kick(); });
  }

  private async drive(job: AutopilotJob) {
    if (job.status === "planning") { await this.runPlanning(job); return; }
    if (job.status === "queued") {
      job.status = "running"; job.stageText = "夜班任务开始";
      await this.persist(job);
      await this.log(job, { stage: "job", action: "started" });
    }
    for (const shot of job.shots) {
      if (shot.status === "completed") continue;
      job.currentStage = "shots"; job.currentShotIndex = shot.index;
      const outcome = await this.runShot(job, shot);
      if (outcome !== "done") return this.settle(job, outcome);
    }
    await this.settle(job, await this.runRoughCut(job));
  }

  /**
   * Director stage. Text only — nothing is sent to ComfyUI here. At most `maxCalls` model calls (first plan
   * + repairs); every reply is saved verbatim, then validated and compiled deterministically. The local model
   * stays loaded here: it is unloaded by the 【开始制作】 gate, right before the first H3 submission.
   */
  private async runPlanning(job: AutopilotJob) {
    const m2 = job.m2!;
    const provider = this.directors.get(m2.director.providerId);
    const approvedFacts = m2.approvedFacts ?? []; const forbiddenClaims = m2.forbiddenClaims ?? [];
    const constraints = normalizeConstraints(m2.constraints);
    const subjectAnchor = m2.subjectAnchor ?? null;
    // The same planning rules for every provider; version + hash go into the ledger so rule changes stay traceable.
    let skill: DirectorRuntimeSkill;
    try { skill = loadDirectorRuntimeSkill(this.runtimeSkillPath); }
    catch (cause) { await this.failPlanning(job, `导演运行规则无法加载：${messageOf(cause)}`, "RUNTIME_SKILL_INVALID"); return; }
    const runtimeSkill = { version: skill.version, hash: skill.hash };
    if (m2.director.runtimeSkill?.hash !== skill.hash) { m2.director.runtimeSkill = runtimeSkill; await this.persist(job); await this.log(job, { stage: "job", action: "director_runtime_skill", detail: runtimeSkill }); }
    const request: DirectorRequest = { intent: m2.intent, targetSeconds: m2.targetSeconds, aspect: m2.aspect, approvedFacts, forbiddenClaims, constraints, subjectAnchor, runtimeSkill, brief: buildDirectorBrief({ intent: m2.intent, targetSeconds: m2.targetSeconds, aspect: m2.aspect, approvedFacts, forbiddenClaims, constraints, subjectAnchor, runtimeSkill: skill }) };
    let previous: { text: string; problems: string[] } | null = null;
    let lastProblems: string[] = [];
    if (provider?.callBudget && !m2.director.ceiling) {
      // Worst case of the whole planning stage, written down before the first call.
      const first = provider.callBudget(request, "plan");
      const repair = provider.callBudget(request, "repair", "x".repeat(first.maxOutputTokens * 4));
      const cost = first.maxCostUsd === null || repair.maxCostUsd === null ? null : Number((first.maxCostUsd + (m2.director.maxCalls - 1) * repair.maxCostUsd).toFixed(4));
      m2.director.ceiling = { maxCalls: m2.director.maxCalls, maxCostUsd: cost, costBasis: first.costBasis };
      await this.persist(job);
      await this.log(job, { stage: "job", action: "director_ceiling", detail: m2.director.ceiling });
    }
    while (m2.attempts.length < m2.director.maxCalls) {
      if (this.stopping || !this.owner) return;
      if (job.cancelRequested) { await this.cancelNow(job, null); return; }
      const state = provider?.available();
      if (!provider || !state?.ok) { await this.failPlanning(job, `导演模型不可用：${state?.reason ?? m2.director.providerId}`, "DIRECTOR_UNAVAILABLE"); return; }
      const kind = previous ? "repair" : "plan";
      job.stageText = kind === "plan" ? `导演规划中（${provider.label}）` : `导演计划修正中（第 ${m2.attempts.length + 1} 次调用）`;
      const budget: DirectorCallBudget | null = provider.callBudget?.(request, kind, previous?.text) ?? null;
      await this.persist(job);
      await this.log(job, { stage: "job", action: `director_${kind}`, detail: { provider: provider.id, call: m2.attempts.length + 1, maxCalls: m2.director.maxCalls, budget } });
      const controller = this.controller();
      const timer = setTimeout(() => controller.abort(), this.directorTimeoutMs);
      let result: DirectorCallResult | null = null; let callError: string | null = null; let failure: ProviderFailure = {};
      const callStarted = Date.now();
      try { result = previous ? await provider.repair(request, previous.text, previous.problems, { signal: controller.signal }) : await provider.plan(request, { signal: controller.signal }); }
      catch (cause) { callError = messageOf(cause); failure = (cause && typeof cause === "object" ? cause : {}) as ProviderFailure; }
      finally { clearTimeout(timer); this.release(controller); }
      if (result && typeof result.text !== "string") { callError = "导演模型返回的内容不是文本"; result = null; }
      if (job.cancelRequested) { await this.cancelNow(job, null); return; }
      if ((this.stopping || !this.owner) && !result) return; // interrupted by a stop, not a model failure: the restart plans again
      const call = m2.attempts.length + 1;
      let file: string | null = null;
      if (result) {
        file = `director/attempt_${String(call).padStart(2, "0")}.txt`;
        await mkdir(join(this.store.jobDir(job.jobId), "director"), { recursive: true });
        await this.store.atomicWrite(join(this.store.jobDir(job.jobId), file), result.text);
      }
      let compiled: ReturnType<typeof compileDirectorPlan> | null = null;
      if (result) {
        try { compiled = compileDirectorPlan(extractPlanJson(result.text), { targetSeconds: m2.targetSeconds, aspect: m2.aspect, promptMode: m2.promptMode, intent: m2.intent, approvedFacts, forbiddenClaims, constraints, subjectAnchor }); lastProblems = compiled.errors; }
        catch (cause) { lastProblems = [messageOf(cause)]; }
      } else lastProblems = [`导演模型调用失败：${callError ?? (controller.signal.aborted ? "超时" : "未知错误")}`];
      // ✅ / ❌ list for the plan screen (a reply that is not even JSON only fails the structure line).
      m2.checks = planChecks(compiled ?? { issues: lastProblems.map((message) => ({ category: "structure" as PlanCheckCategory, message })), plan: null }, m2.targetSeconds);
      const usage = result?.usage ?? failure.usage ?? null;
      m2.attempts.push({
        at: this.iso(), kind, model: result?.model ?? null, providerVersion: provider.version ?? null, durationMs: Date.now() - callStarted, ok: Boolean(compiled?.ok), errors: lastProblems, warnings: compiled?.warnings ?? [], usage, file,
        budget, transport: result?.transport ?? failure.transport ?? [], errorCode: result ? null : failure.code ?? null, billingUncertain: Boolean(failure.billingUncertain), runtimeSkill,
      });
      await this.log(job, { stage: "job", action: compiled?.ok ? "director_plan_valid" : "director_plan_invalid", file, error: compiled?.ok ? null : lastProblems.slice(0, 5).join("；"), detail: { call, model: result?.model ?? null, usage, errorCode: failure.code ?? null, billingUncertain: Boolean(failure.billingUncertain) } });
      if (!result && failure.fatal) {
        // Authentication, billing, refusal, a timed-out paid call…: sending again cannot help (or may double-bill).
        await this.failPlanning(job, `导演模型调用失败，已停止规划（不再调用）：${callError ?? "未知错误"}`, failure.code ?? "DIRECTOR_CALL_FAILED");
        return;
      }
      if (compiled?.ok && compiled.plan) {
        m2.plan = compiled.plan; m2.compiled = compiled.shots; m2.compilerVersion = M2_COMPILER_VERSION; m2.totalSeconds = compiled.totalSeconds; m2.warnings = compiled.warnings; m2.plannedAt = this.iso();
        job.title = `M2 草稿 · ${compiled.plan.title}`;
        job.shots = this.shotTasks(compiled.shots, m2.promptMode);
        job.status = "awaiting_confirmation"; job.currentStage = "awaiting_confirmation";
        job.stageText = `导演计划已生成：${job.shots.length} 个镜头，约 ${compiled.totalSeconds.toFixed(1)} 秒。确认后点【开始制作】`;
        await this.persist(job);
        await this.log(job, { stage: "job", action: "plan_ready", detail: { shots: job.shots.length, totalSeconds: compiled.totalSeconds, warnings: compiled.warnings } });
        return;
      }
      previous = result ? { text: result.text, problems: lastProblems } : null;
      await this.persist(job);
    }
    // No plan → no H3 will follow, so the local model is left as it is (ready for another try).
    await this.failPlanning(job, `导演计划没有通过检查（已调用 ${m2.attempts.length} 次，上限 ${m2.director.maxCalls} 次）：${lastProblems.slice(0, 5).join("；") || "没有可用计划"}`, "PLAN_INVALID");
  }

  /** Runs the provider's release; a busy / unknown LM Studio state is a resource conflict (nothing is unloaded). */
  private async releaseLocalDirector(job: AutopilotJob, provider: DirectorProvider): Promise<{ ok: true } | { ok: false; message: string; code: string }> {
    const m2 = job.m2!;
    try {
      if (!provider.release) throw new Error("该本地导演模型没有提供释放显存的方法");
      const report = await provider.release();
      m2.director.release = report ?? null;
      m2.director.releasedAt = this.iso(); m2.director.releaseError = null;
      await this.log(job, { stage: "job", action: "director_released", detail: report ?? null });
      return { ok: true };
    } catch (cause) {
      const code = (cause as { code?: string }).code === RESOURCE_CONFLICT ? RESOURCE_CONFLICT : "DIRECTOR_RELEASE_FAILED";
      const message = messageOf(cause);
      m2.director.releaseError = { code, message, at: this.iso() };
      this.noteError(job, "gate", null, message, code);
      await this.persist(job);
      await this.log(job, { stage: "job", action: code === RESOURCE_CONFLICT ? "director_resource_conflict" : "director_release_failed", error: message, detail: { code } });
      return { ok: false, message, code };
    }
  }

  /** Planning ended without a usable plan (or the local model could not leave the GPU): nothing was or will be submitted. */
  private async failPlanning(job: AutopilotJob, message: string, code: string) {
    job.status = "planning_failed"; job.stageText = message; job.completedAt = this.iso();
    job.failure = { kind: "planning_failed", message, at: job.completedAt, retryable: false };
    this.noteError(job, "planning", null, message, code);
    await this.writeReport(job);
    await this.persist(job);
    await this.log(job, { stage: "job", action: "planning_failed", error: message, detail: { code } });
  }

  private async settle(job: AutopilotJob, outcome: Outcome) {
    if (outcome === "stopped" || !RUNNING_AUTOPILOT_STATUSES.includes(job.status)) return;
    await this.pauseJob(job, "任务停在了运行状态，已暂停等待确认");
  }

  /** One Shot, driven purely by its recorded status, so a restart resumes exactly where it stopped. */
  private async runShot(job: AutopilotJob, shot: ShotTask): Promise<Outcome> {
    for (;;) {
      if (this.stopping || !this.owner) return "stopped";
      if (job.cancelRequested) return this.cancelNow(job, shot);
      const thermal = this.thermalStatus?.();
      if (thermal && ((shot.status === "pending" && thermal.blocked) || (thermal.latched && ["queued", "running", "submitting"].includes(shot.status)))) {
        await this.pauseJob(job, thermal.reason); return "paused";
      }
      let outcome: Outcome | null = null;
      switch (shot.status) {
        case "completed": return "done";
        case "pending": outcome = await this.submitShot(job, shot); break;
        case "submitting": outcome = await this.confirmSubmission(job, shot); break;
        case "queued": case "running": outcome = await this.watchShot(job, shot); break;
        case "fetching": outcome = await this.fetchShot(job, shot); break;
        case "needs_confirmation": await this.pauseJob(job, shot.error ?? `${label(shot)} 状态待确认`); return "paused";
        case "failed": await this.failJob(job, "shot", shot.index, shot.error ?? `${label(shot)} 生成失败`); return "failed";
        case "cancelled": return this.cancelNow(job, shot);
      }
      if (outcome) return outcome;
    }
  }

  private async submitShot(job: AutopilotJob, shot: ShotTask): Promise<Outcome | null> {
    // No reservation while ComfyUI is down: wait first, so an offline start never costs the retry.
    const waited = await this.waitForComfy(job, shot);
    if (waited) return waited;
    const settings = shot.settings ?? job.settings;
    const finalPrompt = compileH3Prompt(shot.prompt, settings.soundMode);
    // Same planner the canvas adapter uses (T2VA branch → buildH3T2vaWorkflow on the frozen-derived template).
    const plan = planH3Submission({ taskMode: "t2va", prompt: shot.prompt, seed: shot.seed, settings }, { references: { images: [], videos: [], audios: [] } });
    const snapshot = await snapshotH3({ referenceMode: false, taskMode: "t2va", prompt: finalPrompt, seed: shot.seed, settings, sourceWidth: 0, sourceHeight: 0, hasLastFrame: false, referenceCounts: { images: 0, videos: 0, audios: 0, videoAudioFlags: [] } });
    const engine = await this.comfy.describeEngine(h3ClassTypesFor("t2va")).catch(() => undefined);
    const runId = randomUUID();
    const at = this.iso();
    const attempt: ShotAttempt = { runId, comfyPromptId: runId, reservedAt: at, acceptedAt: null, outcome: "reserved", error: null };
    shot.attempts.push(attempt);
    shot.runId = runId; shot.comfyPromptId = runId; shot.status = "submitting"; shot.startedAt ??= at; shot.error = null;
    shot.run = {
      runId, capabilityId: "h3_fl2va", taskMode: "t2va", status: "queued", comfyPromptId: runId, submission: "reserved", rawPrompt: shot.rawPrompt ?? shot.prompt, finalPrompt, seed: shot.seed,
      parameters: snapshot.parameters, workflowIdentity: snapshot.workflowIdentity as AutopilotRun["workflowIdentity"], ...(engine ? { engine } : {}),
      createdAt: at, startedAt: null, completedAt: null, error: null,
    };
    job.stageText = `${label(shot)}：提交到 ComfyUI`;
    // The reservation is on disk before /prompt: after any interruption the job is found again by this prompt_id.
    await this.persist(job);
    await this.log(job, { stage: "shot", action: "reserved", shot: shot.index, runId, promptId: runId, retry: shot.retryCount });
    try {
      await this.comfy.submit({ capability: "comfyui-h3", inputs: { workflow: plan.workflow, promptId: runId } });
    } catch (cause) {
      const text = messageOf(cause);
      attempt.error = text;
      if ((cause as { code?: string }).code === "GPU_THERMAL_BLOCKED") {
        attempt.outcome = "not_sent"; shot.status = "pending";
        if (shot.run) { shot.run.status = "failed"; shot.run.error = text; shot.run.completedAt = this.iso(); }
        await this.pauseJob(job, text); return "paused";
      }
      if (isNotSent(cause)) {
        // The connection was refused before any request existed: provably not in ComfyUI → the normal retry rule applies.
        attempt.outcome = "not_sent";
        this.noteError(job, "shot", shot.index, text, "SUBMIT_NOT_SENT");
        if (shot.retryCount < MAX_AUTO_RETRIES) {
          shot.retryCount += 1; shot.status = "pending";
          await this.persist(job);
          await this.log(job, { stage: "shot", action: "retry", shot: shot.index, runId, promptId: runId, retry: shot.retryCount, error: `${text}（连接建立前被拒绝，确认未送达）` });
          return null;
        }
        this.failShot(shot, `${label(shot)} 两次提交时 ComfyUI 都拒绝了连接`);
        await this.persist(job);
        await this.log(job, { stage: "shot", action: "failed", shot: shot.index, runId, promptId: runId, retry: shot.retryCount, error: text });
        return null;
      }
      if (isUncertain(cause)) {
        job.stageText = `${label(shot)}：提交时连接中断，正在向 ComfyUI 确认（不会直接重提）`;
        this.noteError(job, "shot", shot.index, text, "SUBMIT_UNCERTAIN");
        await this.persist(job);
        await this.log(job, { stage: "shot", action: "submit_uncertain", shot: shot.index, runId, promptId: runId, retry: shot.retryCount, error: text });
        return null;
      }
      attempt.outcome = "failed";
      this.failShot(shot, `ComfyUI 拒绝了任务：${text}`);
      await this.persist(job);
      await this.log(job, { stage: "shot", action: "submit_rejected", shot: shot.index, runId, promptId: runId, retry: shot.retryCount, error: text });
      return null;
    }
    attempt.outcome = "accepted"; attempt.acceptedAt = this.iso();
    shot.status = "queued"; shot.run.submission = "accepted";
    job.stageText = `${label(shot)}：ComfyUI 排队中`;
    await this.persist(job);
    await this.log(job, { stage: "shot", action: "accepted", shot: shot.index, runId, promptId: runId, retry: shot.retryCount });
    return null;
  }

  /** "submitting" = reserved, acceptance unknown. Look the prompt_id up; never resubmit on doubt. */
  private async confirmSubmission(job: AutopilotJob, shot: ShotTask): Promise<Outcome | null> {
    const attempt = shot.attempts.at(-1);
    if (!attempt) { shot.status = "pending"; return null; }
    job.stageText = `${label(shot)}：向 ComfyUI 确认提交状态`;
    let probe = await this.probe(job, shot, attempt.comfyPromptId);
    if (typeof probe === "string") return probe;
    if (probe.state === "not_found") {
      await this.sleep(this.timing.pollMs);
      probe = await this.probe(job, shot, attempt.comfyPromptId);
      if (typeof probe === "string") return probe;
    }
    const approved = this.resubmitApproved.delete(attempt.runId);
    if (probe.state !== "not_found") {
      attempt.outcome = "accepted"; attempt.acceptedAt ??= this.iso();
      shot.status = probe.state === "queued" ? "queued" : "running";
      if (shot.run) shot.run.submission = "accepted";
      await this.persist(job);
      await this.log(job, { stage: "shot", action: "submission_confirmed", shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId, detail: `ComfyUI 中找到原任务（${probe.state}），继续等待，不重新提交` });
      return null;
    }
    attempt.outcome = "lost";
    if (approved) {
      attempt.error = "用户确认后重新提交（ComfyUI 中找不到原任务）";
      shot.status = "pending";
      await this.persist(job);
      await this.log(job, { stage: "shot", action: "resubmit_after_confirmation", shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId });
      return null;
    }
    // RISK-01: "not in queue / history" never proves the request did not arrive (response lost, history cleared,
    // ComfyUI restarted). Live or after a restart, the same rule: pause until the user confirms.
    shot.status = "needs_confirmation";
    shot.error = `无法确认 ${label(shot)} 是否已提交：ComfyUI 队列和历史中都没有 prompt_id ${attempt.comfyPromptId}（服务可能在提交途中中断，或 ComfyUI 已重启）。为避免重复生成，任务已暂停，需要你确认后才会重新提交。`;
    await this.persist(job);
    await this.log(job, { stage: "shot", action: "unconfirmed", shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId, error: shot.error });
    return null;
  }

  /** Accepted job: Phase 6 watchRun (queue / history only, never resubmits), with a reconnect limit and a time limit. */
  private async watchShot(job: AutopilotJob, shot: ShotTask): Promise<Outcome | null> {
    const attempt = shot.attempts.at(-1);
    if (!attempt) { shot.status = "pending"; return null; }
    const controller = this.controller();
    const stop: { reason: "limit" | "timeout" | null } = { reason: null };
    let offlineSince: number | null = null;
    const acceptedAt = Date.parse(attempt.acceptedAt ?? attempt.reservedAt);
    const onPhase = (phase: RecoveryPhase) => {
      if (this.thermalStatus?.()?.latched) { controller.abort(); return; }
      if (phase === "waiting_connection") {
        offlineSince ??= Date.now();
        void this.markReconnecting(job, shot);
        if (Date.now() - offlineSince > this.timing.reconnectLimitMs) { stop.reason = "limit"; controller.abort(); }
        return;
      }
      offlineSince = null;
      void this.markOnline(job);
      if (phase !== "queued" && phase !== "running") return;
      if (this.now().getTime() - acceptedAt > this.timing.shotTimeoutMs) { stop.reason = "timeout"; controller.abort(); return; }
      if (shot.status === phase) return;
      shot.status = phase;
      if (phase === "running" && shot.run && !shot.run.startedAt) { shot.run.startedAt = this.iso(); shot.run.status = "running"; }
      job.stageText = `${label(shot)}：${phase === "queued" ? "ComfyUI 排队中" : "H3 生成中"}`;
      void this.persist(job);
      void this.log(job, { stage: "shot", action: phase, shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId });
    };
    let outcome: Awaited<ReturnType<typeof watchRun>>;
    try {
      outcome = await watchRun({ runId: attempt.runId, capabilityId: "h3_fl2va", comfyPromptId: attempt.comfyPromptId, submission: "accepted" }, this.comfy, { signal: controller.signal, onPhase, pollMs: this.timing.pollMs, reconnectMs: this.timing.reconnectMs });
    } finally { this.release(controller); }
    const thermal = this.thermalStatus?.();
    if (outcome.phase !== "completed" && thermal?.latched) {
      await this.pauseJob(job, thermal.reason); return "paused";
    }
    if (outcome.phase === "detached") {
      if (this.stopping || !this.owner) return "stopped";
      if (job.cancelRequested) return this.cancelNow(job, shot);
      if (stop.reason === "limit") { await this.pauseJob(job, `ComfyUI 连接中断超过 ${minutes(this.timing.reconnectLimitMs)} 分钟，任务已暂停（不会重新提交）`); return "paused"; }
      if (stop.reason === "timeout") { await this.pauseJob(job, `${label(shot)} 超过 ${minutes(this.timing.shotTimeoutMs)} 分钟仍未完成，任务已暂停（ComfyUI 中的任务没有被取消，也不会重新提交）`); return "paused"; }
      return null;
    }
    if (outcome.phase === "completed") {
      shot.comfyOutput = { filename: outcome.file.filename, subfolder: outcome.file.subfolder ?? "", type: outcome.file.type ?? "output" };
      shot.status = "fetching";
      job.stageText = `${label(shot)}：取回结果`;
      await this.markOnline(job);
      await this.persist(job);
      await this.log(job, { stage: "shot", action: "comfy_completed", shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId, file: outcome.file.filename });
      return null;
    }
    if (outcome.phase === "failed") {
      attempt.outcome = "failed"; attempt.error = outcome.error;
      this.noteError(job, "shot", shot.index, outcome.error, "EXECUTION_ERROR");
      if (RETRYABLE_EXECUTION.test(outcome.error) && shot.retryCount < MAX_AUTO_RETRIES) {
        shot.retryCount += 1; shot.status = "pending";
        await this.persist(job);
        await this.log(job, { stage: "shot", action: "retry", shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId, retry: shot.retryCount, error: outcome.error });
        return null;
      }
      this.failShot(shot, `${label(shot)} 生成失败：${outcome.error}`);
      await this.persist(job);
      await this.log(job, { stage: "shot", action: "failed", shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId, retry: shot.retryCount, error: outcome.error });
      return null;
    }
    // Accepted earlier, now in neither the queue nor the history (e.g. ComfyUI restarted).
    attempt.outcome = "lost";
    shot.status = "needs_confirmation";
    shot.error = `${label(shot)} 在 ComfyUI 中找不到了（prompt_id ${attempt.comfyPromptId}），ComfyUI 可能已重启。为避免重复生成，任务已暂停，需要你确认后才会重新提交。`;
    await this.persist(job);
    await this.log(job, { stage: "shot", action: "unconfirmed", shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId, error: shot.error });
    return null;
  }

  /** Download the finished MP4 into the job folder and read its real facts; a failed fetch is re-fetched, never resubmitted. */
  private async fetchShot(job: AutopilotJob, shot: ShotTask): Promise<Outcome | null> {
    const attempt = shot.attempts.at(-1);
    if (!shot.comfyOutput || !attempt) { shot.status = "queued"; return null; }
    const waited = await this.waitForComfy(job, shot);
    if (waited) return waited;
    const name = shotFileName(shot.index);
    const target = join(this.store.jobDir(job.jobId), "shots", name);
    let media: ShotMedia; let bytes: number;
    try {
      const { video } = await this.comfy.fetchOutputFile({ filename: shot.comfyOutput.filename, subfolder: shot.comfyOutput.subfolder, type: shot.comfyOutput.type });
      const data = new Uint8Array(await video.arrayBuffer());
      if (!data.length) throw new Error("ComfyUI 返回的视频文件为空");
      await mkdir(dirname(target), { recursive: true });
      await this.store.atomicWrite(target, data);
      bytes = data.length;
      media = await this.probeMedia(target, shot);
    } catch (cause) {
      const text = messageOf(cause);
      this.noteError(job, "shot", shot.index, `结果文件取回失败：${text}`, "FETCH_FAILED");
      if (!(await this.comfy.isAvailable())) {
        await this.log(job, { stage: "shot", action: "fetch_waiting_connection", shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId, error: text });
        return null; // next pass waits for ComfyUI first; not counted as a retry
      }
      if (shot.retryCount < MAX_AUTO_RETRIES) {
        shot.retryCount += 1;
        await this.persist(job);
        await this.log(job, { stage: "shot", action: "refetch", shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId, retry: shot.retryCount, error: text });
        return null;
      }
      this.failShot(shot, `${label(shot)} 结果文件取回失败：${text}`);
      await this.persist(job);
      await this.log(job, { stage: "shot", action: "failed", shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId, retry: shot.retryCount, error: text });
      return null;
    }
    const at = this.iso();
    shot.outputFile = `shots/${name}`; shot.outputBytes = bytes; shot.media = media;
    shot.status = "completed"; shot.completedAt = at; attempt.outcome = "completed";
    if (shot.run) { shot.run.status = "completed"; shot.run.startedAt ??= attempt.acceptedAt; shot.run.completedAt = at; }
    job.stageText = `${label(shot)}：已保存`;
    await this.persist(job);
    await this.log(job, { stage: "shot", action: "saved", shot: shot.index, runId: attempt.runId, promptId: attempt.comfyPromptId, retry: shot.retryCount, file: shot.outputFile, detail: media });
    return null;
  }

  /** Real duration / size / FPS via the rough cut's own probe (also proves the file decodes). */
  private async probeMedia(path: string, shot: ShotTask): Promise<ShotMedia> {
    const key = "probe";
    const { id } = await this.roughCut.create([{ key, inPoint: 0, outPoint: PROBE_CLIP_SECONDS, title: shot.title, filename: shotFileName(shot.index) }]);
    try {
      await this.roughCut.writeSource(id, key, createReadStream(path));
      const plan = await this.roughCut.plan(id, "first") as { clips?: { width: number; height: number; fps: number; duration: number; hasAudio: boolean }[] };
      const clip = plan.clips?.[0];
      if (!clip) throw new Error("无法读取视频信息");
      return { width: clip.width, height: clip.height, fps: clip.fps, duration: clip.duration, hasAudio: clip.hasAudio };
    } finally { await this.roughCut.dispose(id); }
  }

  /** Phase 19 core, unchanged: RoughCutJobs + rough-cut.py, Shots 01 → 02 → 03 complete (in 0, out = real duration). */
  private async runRoughCut(job: AutopilotJob): Promise<Outcome> {
    if (this.stopping || !this.owner) return "stopped";
    if (job.cancelRequested) return this.cancelNow(job, null);
    job.currentStage = "rough_cut"; job.currentShotIndex = null; job.roughCutStatus = "running"; job.roughCutError = null;
    job.stageText = "粗剪：准备素材（01 → 02 → 03）";
    await this.persist(job);
    await this.log(job, { stage: "rough_cut", action: "started", detail: job.shots.map((shot) => shot.outputFile) });
    const clips = job.shots.map((shot) => ({ key: shot.shotId, inPoint: 0, outPoint: shot.media?.duration ?? 0, title: shot.title, filename: shotFileName(shot.index) }));
    let id: string | null = null;
    try {
      ({ id } = await this.roughCut.create(clips));
      for (const shot of job.shots) await this.roughCut.writeSource(id, shot.shotId, createReadStream(join(this.store.jobDir(job.jobId), shot.outputFile ?? "")));
      await this.roughCut.start(id, "first");
      let lastText = "";
      for (;;) {
        if (this.stopping || !this.owner) { await this.roughCut.cancel(id); return "stopped"; }
        if (job.cancelRequested) { await this.roughCut.cancel(id); id = null; return this.cancelNow(job, null); }
        const status = this.roughCut.status(id);
        if (status.state === "done") break;
        if (status.state === "failed" || status.state === "cancelled") throw Object.assign(new Error(status.error?.message ?? "粗剪失败"), { roughCut: status.error ?? undefined });
        const stage = status.stage;
        const text = !stage ? "处理中" : stage.stage === "clip" ? `裁切并统一格式 ${stage.index}/${stage.total}${stage.title ? ` · ${stage.title}` : ""}（按顺序硬切拼接）` : stage.stage === "finalize" ? "写入文件" : "读取素材信息";
        if (text !== lastText) { lastText = text; job.stageText = `粗剪：${text}`; await this.persist(job); }
        await this.sleep(this.timing.roughCutPollMs);
      }
      const status = this.roughCut.status(id);
      const result = (status.result ?? {}) as { width?: number; height?: number; fpsValue?: number; duration?: number; frames?: number; bytes?: number };
      const file = await this.roughCut.resultFile(id);
      const name = job.finalFilename ?? autopilotOutputName(new Date(job.createdAt), job.kind);
      const target = join(this.store.jobDir(job.jobId), "output", name);
      await mkdir(dirname(target), { recursive: true });
      // Copy next to the target, then rename: the output name never points at a half-copied file.
      const temp = `${target}.tmp`;
      await copyFile(file.path, temp);
      await rename(temp, target);
      await this.roughCut.dispose(id); id = null;
      const at = this.iso();
      job.roughCutStatus = "completed";
      job.roughCutOutput = { width: result.width ?? 0, height: result.height ?? 0, fps: result.fpsValue ?? 0, duration: result.duration ?? 0, frames: result.frames ?? 0, bytes: result.bytes ?? file.size, clipOrder: job.shots.map((shot) => shot.shotId), scriptVersion: status.scriptVersion };
      job.finalOutputPath = resolve(target); job.finalOutputFile = `output/${name}`; job.finalFilename = name; job.finalDuration = result.duration ?? null;
      job.status = "completed"; job.currentStage = "finished"; job.completedAt = at; job.stageText = job.kind === AUTOPILOT_M2_KIND ? "草稿已完成" : "夜班任务完成"; job.failure = null;
      await this.writeReport(job);
      await this.persist(job);
      await this.log(job, { stage: "rough_cut", action: "completed", file: job.finalOutputFile, detail: job.roughCutOutput });
      await this.log(job, { stage: "job", action: "completed", file: job.finalOutputPath });
      return "done";
    } catch (cause) {
      if (id) await this.roughCut.dispose(id).catch(() => {});
      const info = (cause as { roughCut?: RoughCutError }).roughCut;
      const where = info?.clip ? `（第 ${info.clip} 段${info.stage ? ` · ${info.stage}` : ""}）` : "";
      const text = `${info?.message ?? messageOf(cause)}${where}${info?.detail ? `｜${info.detail}` : ""}`;
      job.roughCutStatus = "failed"; job.roughCutError = text;
      await this.failJob(job, "rough_cut", null, `粗剪失败：${text}`, info?.code);
      return "failed";
    }
  }

  // ——— helpers ———

  /** Polls ComfyUI until reachable. Returns an outcome only when the job must stop waiting. */
  private async waitForComfy(job: AutopilotJob, shot: ShotTask): Promise<Outcome | null> {
    const since = Date.now();
    for (;;) {
      if (this.stopping || !this.owner) return "stopped";
      if (job.cancelRequested) return this.cancelNow(job, shot);
      if (await this.comfy.isAvailable()) { await this.markOnline(job); return null; }
      await this.markReconnecting(job, shot);
      if (Date.now() - since > this.timing.reconnectLimitMs) { await this.pauseJob(job, `ComfyUI 连接中断超过 ${minutes(this.timing.reconnectLimitMs)} 分钟，任务已暂停（不会重新提交）`); return "paused"; }
      await this.sleep(this.timing.reconnectMs);
    }
  }

  /** Read-only lookup by prompt_id, waiting through a disconnection (bounded). */
  private async probe(job: AutopilotJob, shot: ShotTask, promptId: string): Promise<ComfyJobProbe | Outcome> {
    const since = Date.now();
    for (;;) {
      if (this.stopping || !this.owner) return "stopped";
      if (job.cancelRequested) return this.cancelNow(job, shot);
      try {
        if (!(await this.comfy.isAvailable())) throw new Error("offline");
        const result = await this.comfy.probeJob(promptId, SAVE_NODE);
        await this.markOnline(job);
        return result;
      } catch {
        await this.markReconnecting(job, shot);
        if (Date.now() - since > this.timing.reconnectLimitMs) { await this.pauseJob(job, `ComfyUI 连接中断超过 ${minutes(this.timing.reconnectLimitMs)} 分钟，任务已暂停（不会重新提交）`); return "paused"; }
        await this.sleep(this.timing.reconnectMs);
      }
    }
  }

  private async markReconnecting(job: AutopilotJob, shot: ShotTask) {
    if (job.status === "reconnecting" || job.cancelRequested) return;
    job.status = "reconnecting";
    job.stageText = `${label(shot)}：ComfyUI 连接中断，等待重新连接（不会重新提交）`;
    this.noteError(job, "shot", shot.index, "ComfyUI 连接中断", "COMFY_DISCONNECTED");
    await this.persist(job);
    await this.log(job, { stage: "shot", action: "comfy_disconnected", shot: shot.index, runId: shot.runId, promptId: shot.comfyPromptId });
  }

  private async markOnline(job: AutopilotJob) {
    if (job.status !== "reconnecting") return;
    job.status = "running";
    await this.persist(job);
    await this.log(job, { stage: "job", action: "comfy_reconnected" });
  }

  private async cancelNow(job: AutopilotJob, shot: ShotTask | null): Promise<"cancelled"> {
    const current = shot ?? job.shots.find((item) => ["submitting", "queued", "running"].includes(item.status)) ?? null;
    if (current?.comfyPromptId && ["submitting", "queued", "running"].includes(current.status)) {
      try {
        await this.comfy.cancel(current.comfyPromptId);
        await this.log(job, { stage: "shot", action: "comfy_cancelled", shot: current.index, runId: current.runId, promptId: current.comfyPromptId });
      } catch (cause) {
        await this.log(job, { stage: "shot", action: "comfy_cancel_failed", shot: current.index, runId: current.runId, promptId: current.comfyPromptId, error: messageOf(cause) });
      }
    }
    const at = this.iso();
    for (const item of job.shots) {
      if (item.status === "completed") continue;
      item.status = "cancelled";
      if (item.run && item.run.status !== "completed") { item.run.status = "cancelled"; item.run.completedAt ??= at; }
      const attempt = item.attempts.at(-1);
      if (attempt && (attempt.outcome === "reserved" || attempt.outcome === "accepted")) attempt.outcome = "cancelled";
    }
    if (job.roughCutStatus === "pending" || job.roughCutStatus === "running") job.roughCutStatus = "cancelled";
    job.status = "cancelled"; job.stageText = "已取消"; job.completedAt = at; job.currentShotIndex = null; job.pauseReason = null;
    job.failure = { kind: "cancelled", message: "用户取消", at, retryable: false };
    await this.writeReport(job);
    await this.persist(job);
    await this.log(job, { stage: "job", action: "cancelled" });
    return "cancelled";
  }

  private async pauseJob(job: AutopilotJob, reason: string) {
    job.status = "paused"; job.pauseReason = reason; job.stageText = `已暂停：${reason}`;
    this.noteError(job, job.currentStage, job.currentShotIndex, reason, "PAUSED");
    await this.persist(job);
    await this.log(job, { stage: "job", action: "paused", shot: job.currentShotIndex, error: reason });
  }

  private async failJob(job: AutopilotJob, stage: string, shot: number | null, message: string, code?: string) {
    job.status = "failed"; job.stageText = message; job.completedAt = this.iso();
    job.failure = { kind: stage === "rough_cut" ? "rough_cut_failed" : "generation_failed", message, at: job.completedAt, retryable: false };
    this.noteError(job, stage, shot, message, code);
    await this.writeReport(job);
    await this.persist(job);
    await this.log(job, { stage: "job", action: "failed", shot, error: message });
  }

  private failShot(shot: ShotTask, message: string) {
    shot.status = "failed"; shot.error = message;
    if (shot.run) { shot.run.status = "failed"; shot.run.error = message; shot.run.completedAt = this.iso(); }
  }

  private noteError(job: AutopilotJob, stage: string, shot: number | null, message: string, code?: string) {
    job.errorLog.push({ at: this.iso(), stage, shot, message, ...(code ? { code } : {}) });
    if (job.errorLog.length > 50) job.errorLog.splice(0, job.errorLog.length - 50);
  }

  private async persist(job: AutopilotJob) {
    if (this.frozen) return;
    const at = this.iso();
    job.updatedAt = at; job.lastHeartbeat = at; job.worker = { pid: process.pid, instance: this.instance };
    await this.store.writeJob(job);
  }

  private async log(job: AutopilotJob, entry: AutopilotLogEntry) {
    if (this.frozen) return;
    this.report(`[autopilot] ${job.jobId} ${entry.stage}/${entry.action}${entry.shot ? ` shot ${pad2(entry.shot)}` : ""}${entry.error ? ` · ${entry.error}` : ""}`);
    await this.store.appendLog(job.jobId, entry, this.now());
  }

  private iso() { return this.now().toISOString(); }

  private controller() { const controller = new AbortController(); this.controllers.add(controller); return controller; }
  private release(controller: AbortController) { this.controllers.delete(controller); }
  private wakeAll() { for (const controller of [...this.controllers]) controller.abort(); }

  /** Interruptible sleep: cancel / stop wake it immediately. */
  private sleep(ms: number) {
    const controller = this.controller();
    return new Promise<void>((resolveSleep) => {
      const done = () => { clearTimeout(timer); resolveSleep(); };
      const timer = setTimeout(done, ms);
      controller.signal.addEventListener("abort", done, { once: true });
    }).finally(() => this.release(controller));
  }
}
