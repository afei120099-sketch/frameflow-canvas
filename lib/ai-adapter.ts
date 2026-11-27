export type AiCapability = "comfyui-h3" | "first-last-frame-video" | "image-generation" | "video-upscale" | "rife-interpolation" | "prompt-assistant" | "cloud-video-api";

export interface AiJobRequest { capability: AiCapability; inputs: Record<string, unknown>; signal?: AbortSignal; submissionSessionId?:string; submissionControl?:'submit'|'automatic'|'chain'; }
export interface AiJobResult { jobId: string; status: "queued" | "running" | "completed" | "failed" | "unconfirmed"; outputs?: Record<string, unknown>; error?: string; }
export interface AiCapabilityAdapter {
  readonly id: string;
  readonly capabilities: readonly AiCapability[];
  isAvailable(): Promise<boolean>;
  submit(request: AiJobRequest): Promise<AiJobResult>;
  getStatus(jobId: string): Promise<AiJobResult>;
  cancel(jobId: string): Promise<void>;
}

export class DisconnectedAiAdapter implements AiCapabilityAdapter {
  readonly id = "disconnected";
  readonly capabilities = [] as const;
  async isAvailable() { return false; }
  async submit(): Promise<AiJobResult> { throw new Error("尚未连接 ComfyUI"); }
  async getStatus(): Promise<AiJobResult> { throw new Error("尚未连接 ComfyUI"); }
  async cancel(): Promise<void> { throw new Error("尚未连接 ComfyUI"); }
}

export type AiGenerationStatus = "disconnected" | "connected" | "preparing" | "uploading" | "queued" | "loading" | "running" | "decoding" | "fetching" | "completed" | "cancelled" | "failed";

export interface H3GenerationSettings {
  communityParameters?: string;
  length: number;
  aspect: "follow" | "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  megapixels: number;
  turbo: boolean;
  steps: number;
  fps: number;
  loraStrength: number;
  upscaleMethod: "nearest-exact" | "bilinear" | "area" | "bicubic" | "lanczos";
  resolutionSteps: number;
  soundMode?: "av" | "ambient" | "silent";
  noBackgroundMusic?: boolean;
  /** 🧪 voiceRoleIds：每条参考声音只送前这么多秒（ComfyUI TrimAudioDuration）。不写 = 整条送（旧行为）。 */
  referenceAudioTrimSeconds?: number;
}

export interface H3ReferenceFile { blob: Blob; name: string; withAudio?: boolean }

export interface H3GenerationUpdate {
  status: AiGenerationStatus;
  percent?: number;
  stage?: string;
  /** 采样器第几步 / 共几步（ComfyUI progress value / max） */
  step?: number;
  steps?: number;
  /** ComfyUI execution_start 自带的时间戳（毫秒） */
  startedAt?: number;
}

export interface H3GenerationOptions {
  /** Optional exact output size for newly created 1080P enhancement nodes; legacy nodes remain 2x. */
  upscaleProfile?: "safe" | "quality";
  /** Runtime stage times (not a GPU benchmark). */
  onPrepared?: (snapshot:import("./locked-generation.ts").SubmittedWorkflow)=>Promise<void>;
  onTiming?: (timing: import("./execution-timing.ts").ExecutionTiming) => void;
  upscaleDimensions?: { width: number; height: number };
  signal?: AbortSignal;
  submissionControl?:'submit'|'automatic'|'chain';
  submissionSessionId?:string;
  onJobId?: (jobId: string) => void;
  onUpdate?: (update: H3GenerationUpdate) => void;
  /** Client-reserved ComfyUI prompt_id (the Run ID), written to the Run before /prompt is sent. */
  promptId?: string;
}

/** The local ComfyUI could not be reached (network level, not an execution error). */
export class ComfyConnectionError extends Error { constructor(message = "无法连接本地 ComfyUI，请确认 127.0.0.1:8188 已启动", options?: { cause?: unknown }) { super(message, options); this.name = "ComfyConnectionError"; } }
/** /prompt was sent but no answer arrived: ComfyUI may or may not have accepted the job. Never resubmit. */
export class SubmissionUncertainError extends Error { constructor(message = "提交后与 ComfyUI 的连接中断，任务是否已被接收暂时无法确认") { super(message); this.name = "SubmissionUncertainError"; } }
/**
 * /prompt provably never reached ComfyUI: the TCP connection itself was refused (ECONNREFUSED), so no
 * request bytes were sent. Only reported where the runtime exposes the socket error (the Node worker);
 * a browser fetch failure stays SubmissionUncertainError.
 */
export class SubmissionNotSentError extends Error { constructor(message = "提交时 ComfyUI 拒绝了连接，请求没有发出") { super(message); this.name = "SubmissionNotSentError"; } }

export interface H3GenerationInput {
  /** Experimental ultimate route; 1-based Picture indices, keyframes before references. */
  communityKeyframes?: { first?: number; last?: number };
  workflowOptionId?: string;
  /** Retired video extension (2026-11-10). Old H3 nodes may still pass it; the adapter refuses the workflow before any upload and never reads it. */
  extensionVideo?: H3ReferenceFile;
  /** Dimensions of Picture 1 for the community workflow's follow-image aspect. */
  sourceWidth?: number;
  sourceHeight?: number;
  image?: Blob;
  imageName?: string;
  lastImage?: Blob;
  lastImageName?: string;
  prompt: string;
  seed: number;
  settings: H3GenerationSettings;
  referenceImages?: H3ReferenceFile[];
  referenceVideos?: H3ReferenceFile[];
  referenceAudios?: H3ReferenceFile[];
  referenceMode?: boolean;
  /** Ref2VA: prompt already compiled from the frozen Reference Manifest; submitted verbatim. */
  compiledPrompt?: string;
  /**
   * Resolved by the canvas (lib/h3-task-mode). T2VA must be explicit: a missing first frame on an
   * I2VA request stays an error instead of silently turning into text-to-video. "hybrid" is refused.
   */
  taskMode?: "t2va" | "i2va" | "fl2va" | "ref2va" | "hybrid";
  /**
   * 🧪 AddGuide image anchors. Retired stable I2VA: Director Stage guides. Community ultimate / fast
   * (h3_ultimate_guide): node time anchors and Director Stage guides, centre-cropped to the generation size.
   */
  guideImages?: { blob: Blob; name: string; frameIdx: number }[];
}

export interface H3GenerationOutput {
  promptId: string;
  video: Blob;
  filename: string;
}

export interface H3CapabilityAdapter extends AiCapabilityAdapter {
  generate(input: H3GenerationInput, options?: H3GenerationOptions): Promise<H3GenerationOutput>;
}
