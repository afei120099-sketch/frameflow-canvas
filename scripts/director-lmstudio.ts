import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DIRECTOR_PLAN_JSON_SCHEMA } from "../lib/autopilot-director.ts";
import type { DirectorCallBudget, DirectorCallResult, DirectorProvider, DirectorReleaseReport, DirectorRequest } from "./director-providers.ts";
import { repairInstruction, sanitizeProviderError } from "./director-shared.ts";

export { sanitizeProviderError };

const RESOURCE_CONFLICT = "local_director_resource_conflict";

/**
 * Autopilot M2 director on the local LM Studio server (probed 2026-09-27: http://127.0.0.1:1234,
 * model openai/gpt-oss-20b, no API token). Uses only documented endpoints:
 *
 *   GET  /api/v1/models            which instances are loaded
 *   POST /api/v1/models/load       load when nothing is loaded (planning runs before any H3 job)
 *   POST /v1/chat/completions      response_format json_schema (grammar-constrained) → DirectorPlan JSON
 *   POST /api/v1/models/unload     after the plan is frozen; then GPU memory is re-measured
 *   lms ps --json                  (official CLI) per-instance status / queue: never unload a model another task is using
 *
 * The provider owns no job state. The worker decides limits, ordering and whether H3 may start.
 */

export const LMSTUDIO_PROVIDER_VERSION = "lmstudio-director-v1";

export interface GpuMemory { usedMiB: number; totalMiB: number }
export interface LmInstanceUsage { identifier: string; modelKey: string; status: string; queued: number }

export interface LmStudioOptions {
  baseUrl?: string;
  model?: string;
  /** Only if the server has authentication enabled; never logged or returned. */
  apiToken?: string;
  /** Used when the provider has to load the model itself. */
  loadConfig?: { context_length?: number; flash_attention?: boolean; num_experts?: number; offload_kv_cache_to_gpu?: boolean };
  maxTokens?: number;
  temperature?: number;
  requestTimeoutMs?: number;
  /** After unload, at least this much GPU memory must be free before H3 may start. */
  minFreeMiB?: number;
  /** …or GPU usage must drop at least this much after the unload (the model is ~11 GB). */
  minDropMiB?: number;
  /** Waits for the driver to report the freed memory. */
  releaseSettleMs?: number;
  gpuMemory?: () => Promise<GpuMemory | null>;
  /** Loaded instances with their status; null when it cannot be determined. */
  instanceUsage?: () => Promise<LmInstanceUsage[] | null>;
  fetchImpl?: typeof fetch;
}

/** nvidia-smi totals (per-process usage is not available under WDDM). Null when unavailable. */
export function readGpuMemory(): Promise<GpuMemory | null> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      const [used, total] = String(stdout).split(/\r?\n/)[0].split(",").map((value) => Number(value.trim()));
      resolve(Number.isFinite(used) && Number.isFinite(total) ? { usedMiB: used, totalMiB: total } : null);
    });
  });
}

/** `lms ps --json` (LM Studio's own CLI): status "idle" / "generating" and queue length per loaded instance. */
export function readLmStudioUsage(lmsPath = process.env.FRAMEFLOW_LMS_CLI || join(homedir(), ".lmstudio", "bin", process.platform === "win32" ? "lms.exe" : "lms")): Promise<LmInstanceUsage[] | null> {
  return new Promise((resolve) => {
    execFile(lmsPath, ["ps", "--json"], { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try {
        const rows = JSON.parse(String(stdout)) as { identifier?: string; modelKey?: string; status?: string; queued?: number }[];
        resolve(Array.isArray(rows) ? rows.map((row) => ({ identifier: String(row.identifier ?? ""), modelKey: String(row.modelKey ?? ""), status: String(row.status ?? "unknown"), queued: Number(row.queued ?? 0) })) : null);
      } catch { resolve(null); }
    });
  });
}

const conflict = (message: string) => Object.assign(new Error(message), { code: RESOURCE_CONFLICT });

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class LocalLmStudioDirectorProvider implements DirectorProvider {
  readonly id = "local-lmstudio";
  readonly kind = "local" as const;
  readonly usesLocalGpu = true;
  readonly version = LMSTUDIO_PROVIDER_VERSION;
  readonly label: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiToken: string | undefined;
  private readonly options: Required<Pick<LmStudioOptions, "maxTokens" | "temperature" | "requestTimeoutMs" | "minFreeMiB" | "minDropMiB" | "releaseSettleMs">> & Pick<LmStudioOptions, "loadConfig">;
  private readonly gpuMemory: () => Promise<GpuMemory | null>;
  private readonly instanceUsage: () => Promise<LmInstanceUsage[] | null>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LmStudioOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:1234").replace(/\/+$/, "");
    this.model = options.model ?? "openai/gpt-oss-20b";
    this.apiToken = options.apiToken;
    this.label = `本地 LM Studio · ${this.model}`;
    this.options = {
      maxTokens: options.maxTokens ?? 6_000, temperature: options.temperature ?? 0.4, requestTimeoutMs: options.requestTimeoutMs ?? 5 * 60_000,
      minFreeMiB: options.minFreeMiB ?? 10_240, minDropMiB: options.minDropMiB ?? 8_192, releaseSettleMs: options.releaseSettleMs ?? 2_000,
      loadConfig: options.loadConfig ?? { context_length: 8192, flash_attention: true, num_experts: 4, offload_kv_cache_to_gpu: true },
    };
    this.gpuMemory = options.gpuMemory ?? readGpuMemory;
    this.instanceUsage = options.instanceUsage ?? (() => readLmStudioUsage());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  available() { return { ok: true }; }

  /** Read-only: which instances of this model LM Studio holds in memory; null when LM Studio cannot be reached. */
  async loadedModels(): Promise<string[] | null> {
    try { return await this.loadedInstances(); } catch { return null; }
  }

  /** Local model: output is capped by max_tokens; no money is spent. */
  callBudget(): DirectorCallBudget { return { maxInputTokens: null, maxOutputTokens: this.options.maxTokens, maxCostUsd: 0, costBasis: "local" }; }

  private async request(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiToken) headers.Authorization = `Bearer ${this.apiToken}`;
    const signal = init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 60_000);
    let response: Response;
    try { response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal }); }
    catch (cause) {
      if (signal.aborted) throw new Error("LM Studio 请求超时或已取消");
      throw new Error(`LM Studio 不可达（本地服务未启动或端口不对）：${sanitizeProviderError(cause instanceof Error ? cause.message : String(cause))}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let detail = "";
      try { const parsed = JSON.parse(body) as { error?: { message?: string } | string }; detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? ""; } catch { /* not JSON */ }
      throw new Error(`LM Studio 请求失败（HTTP ${response.status}）${detail ? `：${sanitizeProviderError(detail)}` : ""}`);
    }
    return response.json() as Promise<unknown>;
  }

  private async loadedInstances(): Promise<string[]> {
    const listing = await this.request("/api/v1/models") as { models?: { key?: string; loaded_instances?: { id?: string }[] }[] };
    const entry = (listing.models ?? []).find((model) => model.key === this.model);
    if (!entry) throw new Error(`LM Studio 中没有模型 ${this.model}`);
    return (entry.loaded_instances ?? []).map((instance) => instance.id ?? this.model);
  }

  private async ensureLoaded(signal: AbortSignal) {
    if ((await this.loadedInstances()).length) return;
    await this.request("/api/v1/models/load", { method: "POST", body: JSON.stringify({ model: this.model, ...this.options.loadConfig }), signal, timeoutMs: 5 * 60_000 });
  }

  private async chat(messages: { role: string; content: string }[], signal: AbortSignal): Promise<DirectorCallResult> {
    const started = Date.now();
    await this.ensureLoaded(signal);
    const reply = await this.request("/v1/chat/completions", {
      method: "POST", signal,
      body: JSON.stringify({
        model: this.model, messages, temperature: this.options.temperature, max_tokens: this.options.maxTokens, stream: false,
        response_format: { type: "json_schema", json_schema: { name: "director_plan", strict: true, schema: DIRECTOR_PLAN_JSON_SCHEMA } },
      }),
    }) as { model?: string; choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } };
    const choice = reply.choices?.[0];
    if (choice?.finish_reason === "length") throw new Error("导演模型输出被截断（达到 max_tokens 或上下文上限）");
    const text = choice?.message?.content ?? "";
    if (!text.trim()) throw new Error("导演模型返回了空内容");
    return {
      text, model: reply.model ?? this.model,
      usage: { inputTokens: reply.usage?.prompt_tokens, outputTokens: reply.usage?.completion_tokens, ...(reply.usage?.completion_tokens_details?.reasoning_tokens !== undefined ? { reasoningTokens: reply.usage.completion_tokens_details.reasoning_tokens } : {}), durationMs: Date.now() - started },
    };
  }

  plan(request: DirectorRequest, options: { signal: AbortSignal }) {
    return this.chat([{ role: "system", content: request.brief.system }, { role: "user", content: request.brief.user }], options.signal);
  }

  repair(request: DirectorRequest, previous: string, problems: string[], options: { signal: AbortSignal }) {
    return this.chat([
      { role: "system", content: request.brief.system },
      { role: "user", content: request.brief.user },
      { role: "assistant", content: previous },
      { role: "user", content: repairInstruction(problems) },
    ], options.signal);
  }

  /**
   * Unload every instance of the model, confirm LM Studio lists none, then require enough free GPU memory.
   * Refuses (resource conflict, nothing unloaded) when any instance is busy / queued or its state is unknown:
   * another conversation or task must not be interrupted.
   */
  async release(): Promise<DirectorReleaseReport> {
    const instances = await this.loadedInstances();
    if (instances.length) {
      const usage = await this.instanceUsage();
      if (!usage) throw conflict("无法可靠判断 LM Studio 模型是否正被其他任务使用（lms ps 不可用），为避免打断它，没有卸载");
      const busy = usage.filter((row) => (row.modelKey === this.model || instances.includes(row.identifier)) && (row.status !== "idle" || row.queued > 0));
      if (busy.length) throw conflict(`LM Studio 模型正被其他任务使用（${busy.map((row) => `${row.identifier}: ${row.status}${row.queued ? `，排队 ${row.queued}` : ""}`).join("；")}），没有卸载`);
    }
    const before = await this.gpuMemory();
    for (const instance of instances) await this.request("/api/v1/models/unload", { method: "POST", body: JSON.stringify({ instance_id: instance }), timeoutMs: 60_000 });
    if ((await this.loadedInstances()).length) throw new Error("卸载后 LM Studio 仍显示模型已加载");
    await delay(this.options.releaseSettleMs);
    const after = await this.gpuMemory();
    const report: DirectorReleaseReport = { unloaded: instances, gpuUsedBeforeMiB: before?.usedMiB ?? null, gpuUsedAfterMiB: after?.usedMiB ?? null, gpuTotalMiB: after?.totalMiB ?? before?.totalMiB ?? null, freeAfterMiB: after ? after.totalMiB - after.usedMiB : null };
    if (!instances.length) return report; // nothing of ours was in GPU memory
    if (!after) throw new Error("无法读取显存占用（nvidia-smi 不可用），不能确认已释放");
    // Freed = enough free memory, or usage clearly dropped by the model's size (ComfyUI's own cache may keep "free" low).
    const dropped = before ? before.usedMiB - after.usedMiB : 0;
    if (report.freeAfterMiB! < this.options.minFreeMiB && dropped < this.options.minDropMiB) throw new Error(`卸载后空闲显存只有 ${report.freeAfterMiB} MiB（下降 ${dropped} MiB），不能确认模型已释放显存`);
    return report;
  }
}
