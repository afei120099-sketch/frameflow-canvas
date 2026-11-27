import {imageProof,verifyUploadedImage} from '../image-integrity.ts';
import {captureWorkflow} from "../locked-generation.ts";
import {ensurePreparationConnection} from "./preparation-connection.ts";
import { createStatusReadCache } from '../status-read-cache.ts';
import {scheduledPromptFetch} from "./submission-scheduler.ts";
import {InboxRootProxyHeldError} from '../inbox-root-control.ts';
import {createExecutionClock,historyExecutionTiming} from "../execution-timing.ts";
import {historyBelongsToThisInstance, loadFrameflowInstance} from "../frameflow-instance.ts";
import { formatComfyNodeErrors } from "./node-errors.ts";
import { buildUpscale60Workflow,assertWholeUpscale60Budget } from "./upscale-60-workflow.ts";
import { readMp4VideoTiming, readMp4VideoFps } from "../video-fps.ts";
import { COMFYUI_PROXY_PATH } from "./config.ts";
import { ComfyConnectionError, SubmissionNotSentError, SubmissionUncertainError, type AiJobRequest, type AiJobResult, type H3CapabilityAdapter, type H3GenerationInput, type H3GenerationOptions, type H3GenerationOutput, type H3GenerationSettings, type H3GenerationUpdate } from "../ai-adapter.ts";
import workflowTemplate from "./h3-workflow.json" with { type: "json" };
import { buildReferenceWorkflow, buildSeedVR2Workflow, type Workflow as ExtraWorkflow } from "./extra-workflows.ts";
import { buildFilmWorkflow, film60Plan, FILM_INTERPOLATE_NODE_ID, FILM_SAVE_NODE_ID } from "./film-workflow.ts";
import { compileH3Prompt } from "./h3-prompt.ts";
import { buildH3T2vaWorkflow } from "./h3-t2va.ts";
import { buildH3AddGuideWorkflow } from "./experimental/h3-addguide.ts";
import { assertH3ModeSubmittable } from "../h3-task-mode.ts";
import { communityInputProblem, communityInputMode, isCommunityWorkflow, workflowBlockedReason } from "../h3-workflow-options.ts";
import { buildCommunityWorkflow, communityDimensions, communityTemplate, COMMUNITY_SAVE_NODE_ID, COMMUNITY_SAMPLER_NODE_ID } from "./experimental/h3-community.ts";
import { cropTimeAnchorImage } from "../time-anchor-image.ts";
import { describeEngine, type EngineInfo } from "./engine-info.ts";
import { H3_ASPECT_DIMENSIONS, H3_ASPECTS, H3_FPS, H3_LORA_STRENGTH, H3_MAX_LENGTH, H3_MAX_MEGAPIXELS, H3_MEGAPIXELS, H3_MIN_LENGTH, H3_MIN_MEGAPIXELS, H3_RESOLUTION_STEPS, H3_STEPS, H3_TURBO, H3_UPSCALE_METHOD, H3_UPSCALE_METHODS } from "./h3-parameters.ts";

type WorkflowNode = { inputs: Record<string, unknown>; class_type: string; _meta?: { title?: string } };
type Workflow = Record<string, WorkflowNode>;
export type ComfyFile = { filename: string; subfolder?: string; type?: string };
/** Read-only view of one ComfyUI job, used by refresh recovery. "not_found" means neither queue nor history knows it. */
export type ComfyJobProbe = { state: "queued" | "running" | "completed" | "failed" | "not_found"; file?: ComfyFile; error?: string; startedAt?:number; completedAt?:number };
type ProgressMessage = { type?: string; data?: Record<string, unknown> };
type ProgressListener = (update: H3GenerationUpdate) => void;

const REQUIRED_NODES = ["5", "6", "10", "14", "15", "20", "21", "25", "27", "28"] as const;
const SAVE_VIDEO_NODE_ID = "15";
const POLL_INTERVAL_MS = 1_000;
const JOB_TIMEOUT_MS = 60 * 60 * 1_000;

function cloneWorkflow() {
  const workflow = structuredClone(workflowTemplate) as Workflow;
  for (const id of REQUIRED_NODES) if (!workflow[id]) throw new Error(`H3 API Workflow 缺少节点 ${id}`);
  return workflow;
}

export function buildH3Workflow(imageName: string, prompt: string, seed: number, settings: H3GenerationSettings = {
  length: 141,
  aspect: "follow",
  megapixels: H3_MEGAPIXELS,
  turbo: H3_TURBO,
  steps: H3_STEPS,
  fps: H3_FPS,
  loraStrength: H3_LORA_STRENGTH,
  upscaleMethod: H3_UPSCALE_METHOD,
  resolutionSteps: H3_RESOLUTION_STEPS,
}, lastImageName?: string) {
  if (settings.length < H3_MIN_LENGTH || settings.length > H3_MAX_LENGTH || (settings.length - 5) % 17 !== 0) throw new Error("H3 时长不是合法的 17k+5 帧数");
  if (!(H3_ASPECTS as readonly string[]).includes(settings.aspect)) throw new Error("H3 比例不受支持");
  if (settings.megapixels < H3_MIN_MEGAPIXELS || settings.megapixels > H3_MAX_MEGAPIXELS) throw new Error("像素预算必须在 0.30MP 到 1.00MP 之间");
  if (!Number.isInteger(settings.steps) || settings.steps < 1 || settings.steps > 10_000) throw new Error("Steps 必须是 1 到 10000 的整数");
  if (settings.fps < 1 || settings.fps > 120) throw new Error("FPS 必须在 1 到 120 之间");
  if (settings.loraStrength < -10 || settings.loraStrength > 10) throw new Error("Turbo LoRA 强度必须在 -10 到 10 之间");
  if (!(H3_UPSCALE_METHODS as readonly string[]).includes(settings.upscaleMethod)) throw new Error("图片缩放算法不受支持");
  if (!Number.isInteger(settings.resolutionSteps) || settings.resolutionSteps < 1 || settings.resolutionSteps > 256) throw new Error("分辨率步进必须是 1 到 256 的整数");

  const workflow = cloneWorkflow();
  workflow["20"].inputs.image = imageName;
  workflow["6"].inputs.prompt = prompt;
  workflow["6"].inputs.length = settings.length;
  workflow["10"].inputs.noise_seed = seed;
  workflow["21"].inputs.megapixels = settings.megapixels;
  workflow["21"].inputs.upscale_method = settings.upscaleMethod;
  workflow["21"].inputs.resolution_steps = settings.resolutionSteps;
  workflow["5"].inputs.strength = settings.loraStrength;
  workflow["25"].inputs.value = settings.turbo;
  workflow["27"].inputs.value = H3_STEPS;
  workflow["28"].inputs.value = 20;
  workflow["14"].inputs.fps = settings.fps;
  if (settings.soundMode === "silent") delete workflow["14"].inputs.audio;
  const dimensions = H3_ASPECT_DIMENSIONS[settings.aspect];
  if (dimensions) {
    workflow["32"] = { inputs: { image: ["20", 0], upscale_method: "lanczos", width: dimensions[0], height: dimensions[1], crop: "center" }, class_type: "ImageScale", _meta: { title: `Frameflow center crop ${settings.aspect}` } };
    workflow["21"].inputs.image = ["32", 0];
  }
  if (lastImageName) {
    workflow["33"] = { inputs: { image: lastImageName }, class_type: "LoadImage", _meta: { title: "Frameflow last frame" } };
    workflow["34"] = { inputs: { image: ["33", 0], upscale_method: settings.upscaleMethod, width: ["22", 0], height: ["22", 1], crop: "center" }, class_type: "ImageScale", _meta: { title: "Frameflow match last frame to first frame" } };
    workflow["6"].inputs.last_frame = ["34", 0];
  } else delete workflow["6"].inputs.last_frame;
  return workflow;
}

/**
 * Which workflow a request becomes, from already-uploaded file names. Pure (no network) so the
 * FL2VA / Ref2VA selection can be tested against the frozen builders. The I2VA / FL2VA / Ref2VA
 * branches are the previous inline logic, unchanged; T2VA must be requested explicitly.
 */
export function planH3Submission(input: H3GenerationInput, uploaded: { imageName?: string; lastImageName?: string; references: { images: string[]; videos: string[]; audios: string[] }; guides?: { imageName: string; frameIdx: number }[] }) {
  const blocked = workflowBlockedReason(input.workflowOptionId);
  if (blocked) throw new Error(blocked);
  if (isCommunityWorkflow(input.workflowOptionId)) {
    const images = [...(uploaded.imageName ? [uploaded.imageName] : []), ...uploaded.references.images];
    const problem = communityInputProblem({ pictures: images.length, videos: uploaded.references.videos.length, audios: uploaded.references.audios.length, keyframeCount: Object.keys(input.communityKeyframes ?? {}).length, hasLastFrame: Boolean(uploaded.lastImageName), guides: uploaded.guides?.length });
    if (problem) throw new Error(problem);
    const taskMode = communityInputMode({pictures:images.length,videos:uploaded.references.videos.length,audios:uploaded.references.audios.length},Boolean(input.communityKeyframes));
    if (input.taskMode && input.taskMode !== "ref2va" && !(input.taskMode === 't2va' && taskMode === 't2va')) throw new Error("所选模式与实际素材不符：文生模式不能带参考素材，首尾帧请使用明确的关键帧输入");
    return { taskMode, saveNodeId: COMMUNITY_SAVE_NODE_ID, workflow: buildCommunityWorkflow(input.workflowOptionId, images, input.compiledPrompt ?? compileH3Prompt(input.prompt, input.settings.soundMode, input.settings.noBackgroundMusic), input.seed, input.settings, input.sourceWidth, input.sourceHeight, input.communityKeyframes, uploaded.references.audios, uploaded.guides ?? []) };
  }
  if (input.taskMode) assertH3ModeSubmittable(input.taskMode);
  const { imageName, lastImageName, references } = uploaded;
  // 🧪 AddGuide (experimental): only plain I2VA (first frame, no last frame, no references) gets anchors.
  if (uploaded.guides?.length) {
    if (input.taskMode !== "i2va" || !imageName || lastImageName || input.referenceMode || references.images.length + references.videos.length + references.audios.length > 0) throw new Error("🧪 引导锚点只支持首帧图生视频（I2VA）：请保留首帧、去掉尾帧和参考素材，或移除引导锚点");
    return { taskMode: "i2va" as const, saveNodeId: SAVE_VIDEO_NODE_ID, workflow: buildH3AddGuideWorkflow(imageName, compileH3Prompt(input.prompt, input.settings.soundMode, input.settings.noBackgroundMusic), input.seed, input.settings, uploaded.guides) };
  }
  if (input.taskMode === "t2va") {
    if (imageName || lastImageName || references.images.length + references.videos.length + references.audios.length > 0) throw new Error("文生视频不能包含图片或参考素材");
    return { taskMode: "t2va" as const, saveNodeId: SAVE_VIDEO_NODE_ID, workflow: buildH3T2vaWorkflow(compileH3Prompt(input.prompt, input.settings.soundMode, input.settings.noBackgroundMusic), input.seed, input.settings) };
  }
  const isReference = input.referenceMode || references.images.length + references.videos.length + references.audios.length > 0;
  if (isReference && lastImageName) throw new Error("多参考模式暂不支持同时锁定尾帧；请移除尾帧连接后重试");
  if (!isReference && !imageName) throw new Error("首帧图片不能为空");
  const compiledPrompt = isReference && input.compiledPrompt !== undefined ? input.compiledPrompt : compileH3Prompt(input.prompt, input.settings.soundMode, input.settings.noBackgroundMusic);
  const workflow = isReference
    ? buildReferenceWorkflow({ ...references, images: imageName ? [imageName, ...references.images] : references.images, videoAudioFlags: input.referenceVideos?.map((item) => Boolean(item.withAudio)) }, compiledPrompt, input.seed, input.settings)
    : buildH3Workflow(imageName!, compiledPrompt, input.seed, input.settings, lastImageName);
  return { taskMode: isReference ? "ref2va" as const : lastImageName ? "fl2va" as const : "i2va" as const, saveNodeId: isReference ? "92" : SAVE_VIDEO_NODE_ID, workflow };
}

/** 采样器的第几步：只在 value / max 都是整数时给，不编。 */
const stepOf = (value: number, max: number) => Number.isInteger(value) && Number.isInteger(max) && value >= 0 && value <= max ? { step: value, steps: max } : {};

export function parseComfyProgressMessage(message: ProgressMessage, promptId: string, samplerNodeId = "11", saveNodeId = "15", samplerStage = "H3 采样"): H3GenerationUpdate | null {
  const data = message.data ?? {};
  if (data.prompt_id !== promptId) return null;
  if (message.type === "progress" && String(data.node) === samplerNodeId) {
    const value = Number(data.value); const max = Number(data.max);
    return Number.isFinite(value) && Number.isFinite(max) && max > 0 ? { status: "running", percent: Math.min(100, Math.max(0, value / max * 100)), stage: samplerStage, ...stepOf(value, max) } : null;
  }
  if (message.type === "progress_state" && data.nodes && typeof data.nodes === "object") {
    const sampler = (data.nodes as Record<string, { value?: number; max?: number }>)[samplerNodeId];
    const value = Number(sampler?.value); const max = Number(sampler?.max);
    return sampler && Number.isFinite(value) && Number.isFinite(max) && max > 0 ? { status: "running", percent: Math.min(100, Math.max(0, value / max * 100)), stage: samplerStage, ...stepOf(value, max) } : null;
  }
  // ComfyUI 的 add_message 给每条消息带 timestamp（毫秒）：这就是它真正开始执行这一条的时间。
  if (message.type === "execution_start") { const at = Number(data.timestamp); return { status: "loading", stage: "开始执行工作流", ...(Number.isFinite(at) && at > 1_577_836_800_000 ? { startedAt: at } : {}) }; }
  if (message.type === "executing") {
    const node = String(data.node ?? "");
    if (node === saveNodeId) return { status: "decoding", stage: "保存视频" };
    if (["12", "13", "14", "121", "122", "130", "66:55", "66:59", "66:75"].includes(node)) return { status: "decoding", stage: "解码视频" };
    if (node === samplerNodeId) return { status: "running", stage: samplerNodeId === "66:54" ? "高清采样" : samplerStage };
    if (node) return { status: "loading", stage: "加载模型与准备工作流" };
  }
  if (message.type === "execution_error") return { status: "failed", stage: "ComfyUI 执行失败" };
  if (message.type === "execution_interrupted") return { status: "cancelled", stage: "ComfyUI 已中断任务" };
  if (message.type === "execution_success") return { status: "decoding", stage: "整理生成结果" };
  return null;
}

class ComfyProgressSocket {
  private socket: EventSource | null = null;
  private connecting: Promise<boolean> | null = null;
  private readonly listeners = new Map<string, Set<{ listener: ProgressListener; samplerNodeId: string; saveNodeId: string; samplerStage: string }>>();
  readonly clientId = crypto.randomUUID();

  async connect() {
    if (this.socket?.readyState === EventSource.OPEN) return true;
    if (this.socket?.readyState === EventSource.CONNECTING) return false;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<boolean>((resolve) => {
      // Server-side WS -> same-origin SSE relay; browser Origin guards remain enabled.
      const socket = new EventSource(`/__comfy_progress?clientId=${encodeURIComponent(this.clientId)}`);
      const timer = window.setTimeout(() => { socket.close(); resolve(false); }, 2_500);
      socket.onopen = () => { this.socket = socket; };
      socket.onerror = () => { window.clearTimeout(timer); resolve(false); };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as ProgressMessage;
          if(message.type==="status"){window.clearTimeout(timer);resolve(true);return;}
          const promptId = typeof message.data?.prompt_id === "string" ? message.data.prompt_id : "";
          if (!promptId) return;
          for (const entry of this.listeners.get(promptId) ?? []) {
            const update = parseComfyProgressMessage(message, promptId, entry.samplerNodeId, entry.saveNodeId, entry.samplerStage);
            if (update) entry.listener(update);
          }
        } catch { /* Binary previews and malformed messages are ignored. */ }
      };
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  subscribe(promptId: string, listener: ProgressListener, samplerNodeId: string, saveNodeId: string, samplerStage: string) {
    const set = this.listeners.get(promptId) ?? new Set<{ listener: ProgressListener; samplerNodeId: string; saveNodeId: string; samplerStage: string }>();
    const entry = { listener, samplerNodeId, saveNodeId, samplerStage };
    set.add(entry); this.listeners.set(promptId, set);
    return () => { set.delete(entry); if (!set.size) this.listeners.delete(promptId); };
  }
}

const progressSocket = new ComfyProgressSocket();

async function parseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: { message?: string } | string; node_errors?: Record<string, unknown> };
    const error = typeof body.error === "string" ? body.error : body.error?.message;
    const nodes = formatComfyNodeErrors(body.node_errors);
    return `${error || fallback}${nodes ? `\n${nodes}` : ""}`;
  } catch { return fallback; }
}

async function comfyFetch(baseUrl: string, path: string, init?: RequestInit, timeoutMs?: number) {
  let response: Response;
  try { response = await fetch(`${baseUrl}${path}`, timeoutMs && !init?.signal ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init); }
  catch (cause) { throw new ComfyConnectionError(undefined, { cause }); }
  if(response.status===423&&response.headers.get('x-frameflow-submission-held')==='1')throw new InboxRootProxyHeldError();
  if (!response.ok) throw new Error(await parseError(response, `ComfyUI 请求失败（HTTP ${response.status}）`));
  return response;
}

/** True only for a socket-level ECONNREFUSED (every address refused), found in the fetch error's cause chain. */
export function connectionRefused(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const record = error as { code?: unknown; errors?: unknown; cause?: unknown };
  if (Array.isArray(record.errors) && record.errors.length) return record.errors.every((item) => connectionRefused(item, depth + 1));
  if (record.code === "ECONNREFUSED") return true;
  return connectionRefused(record.cause, depth + 1);
}

function findVideoFile(value: unknown): ComfyFile | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) { for (const entry of value) { const found = findVideoFile(entry); if (found) return found; } return null; }
  const record = value as Record<string, unknown>;
  if (typeof record.filename === "string" && record.filename.toLowerCase().endsWith(".mp4")) return { filename: record.filename, subfolder: typeof record.subfolder === "string" ? record.subfolder : "", type: typeof record.type === "string" ? record.type : "output" };
  for (const child of Object.values(record)) { const found = findVideoFile(child); if (found) return found; }
  return null;
}

function getExecutionError(history: Record<string, unknown>) {
  const status = history.status as { status_str?: string; messages?: unknown[] } | undefined;
  if (status?.status_str !== "error") return "";
  const executionError = status.messages?.find((message) => Array.isArray(message) && message[0] === "execution_error") as [string, { exception_message?: string }] | undefined;
  return executionError?.[1]?.exception_message || "ComfyUI 生成失败";
}

function delay(ms: number) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }

export class ComfyUIH3Adapter implements H3CapabilityAdapter {
  private statusReads=createStatusReadCache();
  readonly id = "comfyui-local-h3";
  readonly capabilities = ["comfyui-h3"] as const;
  /**
   * Where ComfyUI is reached: the dev server's "/comfyui" proxy in the browser (default), or the
   * absolute local ComfyUI URL for the Autopilot worker that runs inside the dev server itself.
   * Same submit / probe / fetch / cancel code either way; only the address differs.
   */
  private readonly baseUrl: string;
  /** Optional per-request timeout (the worker has no page to reload when a request hangs). */
  private readonly timeoutMs: number | undefined;
  constructor(baseUrl: string = COMFYUI_PROXY_PATH, options: { timeoutMs?: number } = {}) { this.baseUrl = baseUrl; this.timeoutMs = options.timeoutMs; }
  private request(path: string, init?: RequestInit) { return comfyFetch(this.baseUrl, path, init, this.timeoutMs??15000); }

  async isAvailable() { try { await this.systemStats(); return true; } catch { return false; } }

  /** GET /system_stats through the shared short-lived cache, so node probes and the status bar share one request. */
  systemStats<T = unknown>() { return this.statusReads.read('/system_stats',async()=>(await this.request("/system_stats", { cache: "no-store", signal:AbortSignal.timeout(7000) })).json()) as Promise<T>; }

  /** GET /queue through the same cache key the job probe uses. Throws when unreachable. */
  queueSnapshot() { return this.statusReads.read('/queue',async()=>(await this.request('/queue', { cache: "no-store", signal:AbortSignal.timeout(7000) })).json()) as Promise<{ queue_running?: unknown[][]; queue_pending?: unknown[][] }>; }
  /**
   * 只听 ComfyUI 进度消息（第几步、execution_start 时间戳），不发任何请求；镜头卡片用。
   * 进度只发给提交时的 clientId：同一个画布页面提交的才收得到，刷新以后收不到（卡片就不显示第几步）。
   */
  watchProgress(promptId: string, saveNodeId: string | undefined, listener: (update: H3GenerationUpdate) => void) {
    const save = saveNodeId ?? SAVE_VIDEO_NODE_ID;
    const sampler = save === COMMUNITY_SAVE_NODE_ID ? COMMUNITY_SAMPLER_NODE_ID : save === "92" ? "125" : save === "76" ? "66:54" : "11";
    void progressSocket.connect().catch(() => false);
    return progressSocket.subscribe(promptId, listener, sampler, save, "H3 采样");
  }

  /** How many prompts ComfyUI is running / holding (read-only GET /queue). Throws when unreachable. */
  async queueSize() {
    const queue = await (await this.request("/queue", { cache: "no-store" })).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
    return { running: queue.queue_running?.length ?? 0, pending: queue.queue_pending?.length ?? 0 };
  }

  async queueJobs(){
    const queue=await(await this.request('/queue',{cache:'no-store'})).json() as {queue_running?:unknown[][];queue_pending?:unknown[][]};
    return [...(queue.queue_running??[]),...(queue.queue_pending??[])].map(row=>String(row[1]));
  }
  private engineCache: { key: string; at: number; value: EngineInfo } | null = null;
  /** ComfyUI / node versions for the Run record (read-only GETs, cached for a minute). Never throws. */
  async describeEngine(classTypes: readonly string[]): Promise<EngineInfo> {
    const key = [...new Set(classTypes)].sort().join("|");
    if (this.engineCache && this.engineCache.key === key && Date.now() - this.engineCache.at < 60_000) return this.engineCache.value;
    const value = await describeEngine(async (path) => (await this.request(path, { cache: "no-store" })).json(), classTypes);
    if (value.comfyuiVersion) this.engineCache = { key, at: Date.now(), value };
    return value;
  }

  async submit(request: AiJobRequest): Promise<AiJobResult> {
    if (request.capability !== "comfyui-h3") throw new Error("当前适配器只支持 ComfyUI H3");
    const promptId = typeof request.inputs.promptId === "string" ? request.inputs.promptId : undefined;
    let response: Response;
    try { response = await scheduledPromptFetch(`${this.baseUrl}/prompt`, { method: "POST", signal:request.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: request.inputs.workflow, client_id: request.inputs.clientId, ...(promptId ? { prompt_id: promptId } : {}) }) },async (url,init)=>comfyFetch("",String(url),init,this.timeoutMs),request.submissionControl??'submit',undefined,request.submissionSessionId); }
    catch (cause) {
      if (!(cause instanceof ComfyConnectionError)) throw cause;
      // Refused before a connection existed → nothing was sent. Anything else (reset, timeout, no detail) may have been accepted.
      throw connectionRefused(cause.cause) ? new SubmissionNotSentError() : new SubmissionUncertainError();
    }
    const result = await response.json() as { prompt_id?: string; node_errors?: Record<string, unknown> };
    if (result.node_errors && Object.keys(result.node_errors).length) throw new Error(`ComfyUI 节点校验未通过\n${formatComfyNodeErrors(result.node_errors)}\n不能把部分执行当作视频生成成功`);
    if (!result.prompt_id) throw new Error(`ComfyUI 未返回任务 ID${result.node_errors ? `（节点：${Object.keys(result.node_errors).join("、")}）` : ""}`);
    return { jobId: result.prompt_id, status: "queued" };
  }

  async getStatus(jobId: string, saveNodeId = SAVE_VIDEO_NODE_ID): Promise<AiJobResult> {
    const probe=await this.probeJob(jobId,saveNodeId);
    if(probe.state==='not_found') return {jobId,status:'unconfirmed',error:'队列与历史均找不到该任务，请确认原任务，不会重提'};
    return {jobId,status:probe.state,...(probe.file?{outputs:{file:probe.file,startedAt:probe.startedAt,completedAt:probe.completedAt}}:{}),...(probe.error?{error:probe.error}:{})};
  }

  /** Queue/history lookup without submitting anything. History is checked again after the queue to close the finish-between-requests race. */
  async probeJob(jobId: string, saveNodeId: string): Promise<ComfyJobProbe> {
    if (typeof window !== "undefined") await loadFrameflowInstance();
    // A status read must not pin the file-service tick. Rendering itself is untouched.
    const timed = () => ({ cache: "no-store" as const, signal: AbortSignal.timeout(12_000) });
    const fromHistory = async (): Promise<ComfyJobProbe | null> => {
      // History stays fresh: the second read below closes the finish-between-requests race.
      const history = await (await this.request(`/history/${encodeURIComponent(jobId)}`, timed())).json() as Record<string, Record<string, unknown>>;
      const entry = history[jobId];
      if (!entry || !historyBelongsToThisInstance(entry)) return null;
      const error = getExecutionError(entry);
      if (error) return { state: "failed", error };
      const status = entry.status as { completed?: boolean; status_str?: string } | undefined;
      if (status && status.completed === false && status.status_str !== "success") return { state: "failed", error: "ComfyUI 任务未完成即结束（可能已被中断）" };
      const file = findVideoFile((entry.outputs as Record<string, unknown> | undefined)?.[saveNodeId]);
      return file ? { state: "completed", file, ...(() => {const {startedAt,completedAt}=historyExecutionTiming(entry);return {...(startedAt?{startedAt}:{}),...(completedAt?{completedAt}:{})};})() } : { state: "failed", error: "ComfyUI 已结束，但没有找到保存节点的 MP4 输出" };
    };
    const first = await fromHistory();
    if (first) return first;
    const queue = await this.statusReads.read('/queue',async()=>(await this.request('/queue',timed())).json()) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    const contains = (items: unknown[][] | undefined) => items?.some((item) => Array.isArray(item) && item[1] === jobId && historyBelongsToThisInstance({ prompt: item })) ?? false;
    if (contains(queue.queue_running)) return { state: "running" };
    if (contains(queue.queue_pending)) return { state: "queued" };
    return (await fromHistory()) ?? { state: "not_found" };
  }

  async fetchOutputFile(file: ComfyFile,signal?:AbortSignal) {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
    const video = await (await this.request(`/view?${query.toString()}`, { cache: "no-store",signal })).blob();
    if (!video.size) throw new Error("ComfyUI 返回的视频文件为空");
    return { video: video.slice(0, video.size, "video/mp4"), filename: file.filename };
  }

  /** Delete only explicitly named waiting jobs. Never calls /interrupt or clears another batch. */
  async cancelPendingJobs(jobIds: string[]): Promise<string[]> {
    const queue = await (await this.request("/queue", { cache: "no-store" })).json() as { queue_pending?: unknown[][] };
    const requested = new Set(jobIds);
    const ids = (queue.queue_pending ?? []).map(item => item[1]).filter((id): id is string => typeof id === "string" && requested.has(id));
    if (ids.length) await this.request("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: ids }) });
    return ids;
  }

  async cancel(jobId: string): Promise<void> {
    try {
      const response = await this.request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
      const result = await response.json() as { cancelled?: boolean };
      if (!result.cancelled) throw new Error("任务已经结束或当前无法取消");
    } catch (cause) {
      if (cause instanceof Error && cause.message === "任务已经结束或当前无法取消") throw cause;
      await this.request("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [jobId] }) });
      await this.request("/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt_id: jobId }) });
    }
  }

  private async uploadFile(blob: Blob, originalName: string,signal?:AbortSignal) {
    signal?.throwIfAborted();
    const extension = originalName.split(".").pop()?.toLowerCase() || (blob.type === "image/png" ? "png" : "jpg");
    const filename = `frameflow_${crypto.randomUUID()}.${extension}`;
    const form = new FormData(); form.append("image", new File([blob], filename, { type: blob.type || "application/octet-stream" })); form.append("type", "input"); form.append("overwrite", "true");
    const response = await this.request("/upload/image", { method: "POST", body: form,signal:signal??AbortSignal.timeout(15000) });
    const result = await response.json() as { name?: string; subfolder?: string };
    if (!result.name) throw new Error("文件上传成功，但 ComfyUI 未返回文件名");
    return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
  }

  private async uploadImage(blob: Blob, originalName: string,signal?:AbortSignal) {
    const proof=await imageProof(blob,signal);signal?.throwIfAborted();
    const name=await this.uploadFile(blob,originalName.replace(/\.[^.]*$/, '')+(proof.mime==='image/png'?'.png':proof.mime==='image/jpeg'?'.jpg':'.webp'),signal);
    const parts=name.split('/');const file={name:parts.pop()!,subfolder:parts.join('/')};
    await verifyUploadedImage(blob,file,(input,init)=>this.request(String(input),init), '',signal);
    signal?.throwIfAborted();return name;
  }

  private async assertCommunityReady(id: "community-ultimate" | "community-dialogue", keyframes = false, audioReferences = false, timeAnchors = false, trimAudio = false) {
    const workflow = communityTemplate(id).template as Workflow;
    type NodeInfo = { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } };
    const info = await (await this.request("/object_info", { cache: "no-store" })).json() as Record<string, NodeInfo>;
    const missing = [...new Set(Object.values(workflow).map((node) => node.class_type))].filter((name) => !info[name]);
    const conditioningClass = keyframes ? "MiniMaxH3AudioConditioningT8" : workflow["136"].class_type;
    if (audioReferences && (!info.LoadAudio || !info[conditioningClass]?.input?.optional?.ref_audios || (!keyframes && !info[conditioningClass]?.input?.optional?.audio_vae))) throw new Error("音色参考实验需要 LoadAudio、ref_audios 及 Audio VAE 接口；不会忽略声音或换用其他工作流");
    if (trimAudio && !info.TrimAudioDuration) throw new Error("voiceRoleIds 要把声音样本截短，需要 ComfyUI 自带的 TrimAudioDuration 节点；当前 ComfyUI 没有，不会整条送");
    if (keyframes && (!info.MiniMaxH3AudioConditioningT8?.input?.optional?.first_frame || !info.MiniMaxH3AudioConditioningT8?.input?.optional?.last_frame || !info.MiniMaxH3AudioConditioningT8?.input?.optional?.ref_images)) throw new Error("首尾帧实验需要本机 MiniMaxH3AudioConditioningT8 节点及 first_frame / last_frame / ref_images 接口；不会退回普通参考");
    if (missing.length) throw new Error(`当前 ComfyUI 缺少工作流节点：${missing.join("、")}；不会自动换用稳定版`);
    if (timeAnchors) {
      const guide = info.MiniMaxH3AddGuide?.input;
      if (!guide?.required?.positive || !guide.required.latent || !guide.required.frame_idx || !guide.optional?.vae || !guide.optional.audio_vae || !guide.optional.image) throw new Error("🧪 时间锚点需要本机 MiniMaxH3AddGuide 节点（positive / latent / frame_idx / vae / audio_vae / image）；不会忽略锚点提交");
    }
    for (const [nodeId, key] of [["127", "unet_name"], ["128", "clip_name"], ["145", "lora_name"], ["119", "vae_name"], ["120", "vae_name"], ["150", "tiny_vae"]]) {
      const node = workflow[nodeId], value = node.inputs[key];
      const schema = info[node.class_type].input?.required?.[key] ?? info[node.class_type].input?.optional?.[key];
      const choices = Array.isArray(schema?.[0]) ? schema[0] : (schema?.[1] as { options?: unknown[] } | undefined)?.options;
      if (!Array.isArray(choices) || !choices.includes(value)) throw new Error(`当前 ComfyUI 没有识别到模型：${String(value)}；请检查模型搜索路径，不会替换模型`);
    }
  }

  private async prepareGeneration(input: H3GenerationInput, options: H3GenerationOptions) {
    const update = (value: H3GenerationUpdate) => options.onUpdate?.(value);
    const throwIfAborted = () => { if (options.signal?.aborted) throw new DOMException("生成已取消", "AbortError"); };
    const blocked = workflowBlockedReason(input.workflowOptionId);
    if (blocked) throw new Error(blocked);
    if (isCommunityWorkflow(input.workflowOptionId)) {
      const problem = communityInputProblem({ pictures: (input.image ? 1 : 0) + (input.referenceImages?.length ?? 0), videos: input.referenceVideos?.length, audios: input.referenceAudios?.length, keyframeCount: Object.keys(input.communityKeyframes ?? {}).length, hasLastFrame: Boolean(input.lastImage), guides: input.guideImages?.length });
      if (problem) throw new Error(problem);
      // Validate parameters before any upload, including task mode, source dimensions and time-anchor frames.
      planH3Submission(input, { imageName: input.image ? "first.png" : undefined, references: { images: (input.referenceImages ?? []).map((_, i) => `ref-${i}.png`), videos: [], audios: (input.referenceAudios ?? []).map((_, i) => `ref-${i}.wav`) }, guides: input.guideImages?.map((guide, i) => ({ imageName: `anchor-${i}.png`, frameIdx: guide.frameIdx })) });
    }
    // Refuse disabled modes (🧪 Hybrid) before any network call: nothing is uploaded or queued.
    if (input.taskMode) assertH3ModeSubmittable(input.taskMode);
    update({ status: "preparing", stage: "准备任务" }); throwIfAborted();
    await ensurePreparationConnection(()=>this.isAvailable(),options.signal);
    if (isCommunityWorkflow(input.workflowOptionId)) await this.assertCommunityReady(input.workflowOptionId, Boolean(input.communityKeyframes) || (!input.image && !input.referenceImages?.length), Boolean(input.referenceAudios?.length), Boolean(input.guideImages?.length), Boolean(input.settings.referenceAudioTrimSeconds && input.referenceAudios?.length));
    update({ status: "connected", stage: "ComfyUI 已连接" }); update({ status: "uploading", stage: "上传素材" }); throwIfAborted();
    const imageName = input.image ? await this.uploadImage(input.image, input.imageName || "first-frame.png",options.signal) : undefined; throwIfAborted();
    let lastImageName: string | undefined;
    if (input.lastImage) {
      update({ status: "uploading", stage: "上传尾帧" });
      lastImageName = await this.uploadImage(input.lastImage, input.lastImageName || "last-frame.png",options.signal);
      throwIfAborted();
    }
    const references = {
      images: await Promise.all((input.referenceImages ?? []).map((item) => this.uploadImage(item.blob, item.name,options.signal))),
      videos: await Promise.all((input.referenceVideos ?? []).map((item) => this.uploadFile(item.blob, item.name))),
      audios: await Promise.all((input.referenceAudios ?? []).map((item) => this.uploadFile(item.blob, item.name))),
    };
    // Community time anchors: centre-crop to the generation size first, so AddGuide's own centre crop is a no-op.
    const anchorSize = input.guideImages?.length && isCommunityWorkflow(input.workflowOptionId) ? communityDimensions(input.settings, input.sourceWidth, input.sourceHeight) : null;
    const guides = input.guideImages?.length ? await Promise.all(input.guideImages.map(async (guide) => ({ imageName: await this.uploadImage(anchorSize ? await cropTimeAnchorImage(guide.blob, anchorSize.width, anchorSize.height) : guide.blob, anchorSize ? guide.name.replace(/\.[^.]+$/, "") + "-anchor.png" : guide.name,options.signal), frameIdx: guide.frameIdx }))) : undefined;
    throwIfAborted();
    const plan = planH3Submission(input, { imageName, lastImageName, references, guides });
    return plan;
  }

  async generate(input: H3GenerationInput, options: H3GenerationOptions = {}): Promise<H3GenerationOutput> {
    const plan = await this.prepareGeneration(input, options);
    return this.runWorkflow(plan.workflow, plan.saveNodeId, options, plan.saveNodeId === COMMUNITY_SAVE_NODE_ID ? { samplerNodeId: COMMUNITY_SAMPLER_NODE_ID, samplerStage: "H3 社区工作流采样" } : undefined);
  }

  /** Submit once and return on acceptance. Existing Run recovery handles outputs after refresh. */
  async enqueue(input: H3GenerationInput, options: H3GenerationOptions = {}) {
    const plan = await this.prepareGeneration(input, options);
    await options.onPrepared?.(await captureWorkflow(plan.workflow,plan.saveNodeId));
    options.signal?.throwIfAborted();
    const job = await this.submit({ capability: "comfyui-h3", signal:options.signal, submissionControl:options.submissionControl,submissionSessionId:options.submissionSessionId, inputs: { workflow: plan.workflow, clientId: progressSocket.clientId, promptId: options.promptId } });
    options.onJobId?.(job.jobId);
    options.onUpdate?.({ status: "queued", stage: "已进入 ComfyUI 队列" });
    return { promptId: job.jobId };
  }

  async replay(snapshot: import("../locked-generation.ts").SubmittedWorkflow, options:H3GenerationOptions={}) {
    return this.runWorkflow(structuredClone(snapshot.graph),snapshot.saveNodeId,options);
  }

  async upscale(video: Blob, name: string, clip: { start: number; duration: number } | undefined, options: H3GenerationOptions = {}) {
    const update = (value: H3GenerationUpdate) => options.onUpdate?.(value);
    update({ status: "preparing", stage: "准备高清增强" });
    if (!await this.isAvailable()) throw new Error("ComfyUI 未启动或无法连接（127.0.0.1:8188）");
    update({ status: "uploading", stage: "上传视频" });
    const filename = await this.uploadFile(video, name);
    const workflow = buildSeedVR2Workflow(filename, { clip, dimensions: options.upscaleDimensions, profile:options.upscaleProfile });
    return this.runWorkflow(workflow, "76", options);
  }

  async upscale60(video: Blob, name: string, clip: {start:number;duration:number}|undefined, options:H3GenerationOptions = {}) {
    options.signal?.throwIfAborted();
    if (!video.size || !options.upscaleDimensions) throw new Error("高清插帧缺少视频或目标尺寸");
    const fps = await readMp4VideoFps(video);
    if (fps === null) throw new Error("无法识别原帧率，不能保证60 FPS的播放速度");
    const timing=await readMp4VideoTiming(video);
    if(!timing)throw new Error('整段高清插帧无法核实输入帧数，请选择分段高清');
    assertWholeUpscale60Budget(timing.frames,fps,options.upscaleDimensions,clip);
    // Validate before upload/submission, including unsupported fractional frame rates.
    buildUpscale60Workflow("input.mp4",fps,options.upscaleDimensions,clip,options.upscaleProfile);
    if (!await this.isAvailable()) throw new Error("ComfyUI 未连接");
    options.onUpdate?.({status:"uploading",stage:"准备1080P＋60 FPS任务"});
    const filename=await this.uploadFile(video,name);
    options.signal?.throwIfAborted();
    return this.runWorkflow(buildUpscale60Workflow(filename,fps,options.upscaleDimensions,clip,options.upscaleProfile),"76",options,{samplerNodeId:"16:2",samplerStage:"1080P已处理，正在插帧至60 FPS"});
  }

  async interpolate(video: Blob, name: string, options: H3GenerationOptions = {}) {
    const update = (value: H3GenerationUpdate) => options.onUpdate?.(value);
    if (!video.size) throw new Error("输入视频不可用或文件为空");
    update({ status: "preparing", stage: "准备流畅增强" });
    if (!await this.isAvailable()) throw new Error("ComfyUI 未连接，请确认 127.0.0.1:8188 已启动");
    if (options.signal?.aborted) throw new DOMException("任务已取消", "AbortError");
    update({ status: "uploading", stage: "上传视频" });
    const timing=await readMp4VideoTiming(video);
    if(!timing || !timing.width || !timing.height)throw new Error("无法核实插帧内存预算，请用画布分段流程");
    const multiplier=film60Plan(timing.fps).multiplier;
    if((timing.frames*multiplier+1)*timing.width*timing.height*3*4>6*1024**3)throw new Error("整段插帧超出6GiB输出张量预算，请用画布自动分段，不会偷偷降低分辨率");
    const filename = await this.uploadFile(video, name);
    if (options.signal?.aborted) throw new DOMException("任务已取消", "AbortError");
    const sourceFps = await readMp4VideoFps(video);
    if (sourceFps === null) throw new Error("无法识别输入帧率，不能保证60 FPS插帧时长不变");
    return this.runWorkflow(buildFilmWorkflow(filename, sourceFps), FILM_SAVE_NODE_ID, options, { samplerNodeId: FILM_INTERPOLATE_NODE_ID, samplerStage: "插帧处理中" });
  }

  private async runWorkflow(workflow: Workflow | ExtraWorkflow, saveNodeId: string, options: H3GenerationOptions, progress?: { samplerNodeId: string; samplerStage: string }): Promise<H3GenerationOutput> {
    const clock=createExecutionClock();
    // execution_start 的时间戳只来一次：之后每条进度都带上，节点 / 卡片随时读得到。
    let comfyStartedAt: number | undefined;
    const update = (value: H3GenerationUpdate) => {if(value.stage!=="ComfyUI 正在执行")clock.observe(value.status);if(value.startedAt)comfyStartedAt??=value.startedAt;options.onUpdate?.(comfyStartedAt&&!["queued","completed","failed","cancelled"].includes(value.status)?{...value,startedAt:comfyStartedAt}:value);};
    const throwIfAborted = () => { if (options.signal?.aborted) throw new DOMException("生成已取消", "AbortError"); };
    throwIfAborted();
    await options.onPrepared?.(await captureWorkflow(workflow,saveNodeId));
    throwIfAborted();
    await progressSocket.connect();
    const job = await this.submit({ capability: "comfyui-h3", signal:options.signal, submissionControl:options.submissionControl,submissionSessionId:options.submissionSessionId, inputs: { workflow, clientId: progressSocket.clientId, promptId: options.promptId } });
    options.onJobId?.(job.jobId);
    // Cancellation can arrive while /prompt is in flight, before the UI knows the job id.
    // Once ComfyUI returns that id, cancel the real queued/running job before exiting.
    if (options.signal?.aborted) {
      await this.cancel(job.jobId);
      throw new DOMException("任务已取消", "AbortError");
    }
    let highestPercent = 0;
    const samplerNodeId = progress?.samplerNodeId ?? (saveNodeId === "92" ? "125" : saveNodeId === "76" ? "66:54" : "11");
    const samplerStage = progress?.samplerStage ?? "H3 采样";
    const unsubscribe = progressSocket.subscribe(job.jobId, (next) => {
      if (next.percent === undefined) update(next);
      else { highestPercent = Math.max(highestPercent, next.percent); update({ ...next, percent: highestPercent }); }
    }, samplerNodeId, saveNodeId, samplerStage);
    update({ status: "queued", stage: "等待 ComfyUI 队列" });
    let executionStart:number|undefined; let missing=0; let lastStatus: "queued" | "running" = "queued";
    try {
      while (true) {
        await delay(POLL_INTERVAL_MS); throwIfAborted();
        const current = await this.getStatus(job.jobId, saveNodeId);
        if(current.status==="unconfirmed") {if(++missing>=2) throw new SubmissionUncertainError(current.error);continue;} else missing=0;
        if(current.status==="running") executionStart??=Date.now();
        if(executionStart && Date.now()-executionStart>JOB_TIMEOUT_MS) throw new SubmissionUncertainError("执行已超过一小时，暂停本地等待；原任务未取消，请查询状态，不会重提");
        if (current.status === "failed") { update({ status: "failed", stage: "生成失败" }); throw new Error(current.error || "ComfyUI 生成失败"); }
        if (current.status === "completed") {
          const file = current.outputs?.file as ComfyFile;
          const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
          update({ status: "fetching", stage: "获取生成视频" });
          const response = await this.request(`/view?${query.toString()}`, { cache: "no-store",signal:options.signal });
          const video = await response.blob();
          if (!video.size) throw new Error("ComfyUI 返回的视频文件为空");
          options.onTiming?.(clock.finish({...(typeof current.outputs?.startedAt==="number"?{startedAt:current.outputs.startedAt}:{}),...(typeof current.outputs?.completedAt==="number"?{completedAt:current.outputs.completedAt}:{})}));
          update({ status: "completed", percent: 100, stage: "生成完成" });
          return { promptId: job.jobId, video: video.slice(0, video.size, "video/mp4"), filename: file.filename };
        }
        if ((current.status === "queued" || current.status === "running") && current.status !== lastStatus) { lastStatus = current.status; update({ status: current.status, stage: current.status === "queued" ? "等待 ComfyUI 队列" : "ComfyUI 正在执行" }); }
      }

    } finally { unsubscribe(); }
  }
}

export const comfyUIH3Adapter = new ComfyUIH3Adapter();
