import { readFileSync } from "node:fs";
import { DIRECTOR_PLAN_JSON_SCHEMA } from "../lib/autopilot-director.ts";
import type { DirectorCallBudget, DirectorCallResult, DirectorProvider, DirectorRequest, DirectorTransportRecord, DirectorUsage } from "./director-providers.ts";
import { delay, DirectorCallError, repairInstruction, sanitizeProviderError } from "./director-shared.ts";

/**
 * Autopilot M2 director on the Anthropic Messages API (checked against platform.claude.com on 2026-09-27):
 *
 *   POST /v1/messages   x-api-key + anthropic-version: 2023-06-01
 *                       output_config.format {type:"json_schema"} (GA structured outputs) → DirectorPlan JSON
 *                       output_config.effort from config; thinking left at the model default (adaptive)
 *   usage               input / output / cache tokens (no cost field; cost = list-price estimate when priced)
 *   429                 obey retry-after (seconds); a 429 without it (monthly spend cap) is not retried
 *
 * Text only: the request carries the brief (rules, the sentence, duration, aspect, facts, forbidden claims,
 * constraints) and on repair the previous reply + the checker's errors. No images, audio, video, local
 * paths or other project data. The key comes only from ANTHROPIC_API_KEY, is read at call time, and is
 * never stored on the object, logged, returned or written anywhere.
 *
 * Network-layer retries (connection refused / DNS, 429 with retry-after, 500 / 502 / 503 / 529) never add a
 * semantic call. A timed-out request may have been billed: it is not re-sent and is marked billingUncertain.
 */

export const CLAUDE_PROVIDER_VERSION = "claude-director-v1";
export const ANTHROPIC_VERSION = "2023-06-01";

export interface ClaudePrice { input: number; output: number; cacheWrite5m: number; cacheRead: number }
export interface ClaudeDirectorConfig {
  model: string;
  /** output_config.effort; null to omit (models without effort support). */
  effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  maxTokens: number;
  requestTimeoutMs: number;
  maxNetworkRetries: number;
  maxRetryAfterSeconds: number;
  baseUrl: string;
  pricingVerifiedAt: string | null;
  pricingUsdPerMTok: Record<string, ClaudePrice>;
}
export interface DirectorSettingsFile { defaultDirector: string; claude: ClaudeDirectorConfig }

const FALLBACK_CONFIG: ClaudeDirectorConfig = { model: "", effort: null, maxTokens: 16_000, requestTimeoutMs: 180_000, maxNetworkRetries: 2, maxRetryAfterSeconds: 60, baseUrl: "https://api.anthropic.com", pricingVerifiedAt: null, pricingUsdPerMTok: {} };

/** config/director-providers.json (+ FRAMEFLOW_CLAUDE_MODEL / FRAMEFLOW_DEFAULT_DIRECTOR overrides). Missing file → provider unavailable. */
export function loadDirectorSettings(path: string | URL = new URL("../config/director-providers.json", import.meta.url)): DirectorSettingsFile {
  let file: Partial<DirectorSettingsFile> = {};
  try { file = JSON.parse(readFileSync(path, "utf8")) as Partial<DirectorSettingsFile>; } catch { /* no config: claude has no model and reports unavailable */ }
  const claude = { ...FALLBACK_CONFIG, ...(file.claude ?? {}) };
  if (process.env.FRAMEFLOW_CLAUDE_MODEL?.trim()) claude.model = process.env.FRAMEFLOW_CLAUDE_MODEL.trim();
  return { defaultDirector: process.env.FRAMEFLOW_DEFAULT_DIRECTOR?.trim() || file.defaultDirector || "mock", claude };
}

/** Structured outputs reject numeric / length / item-count bounds; the same zod validator enforces them afterwards. */
export function claudeOutputSchema(schema: unknown = DIRECTOR_PLAN_JSON_SCHEMA): unknown {
  if (Array.isArray(schema)) return schema.map((item) => claudeOutputSchema(item));
  if (!schema || typeof schema !== "object") return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength"].includes(key)) continue;
    if (key === "minItems" && typeof value === "number" && value > 1) continue;
    result[key] = claudeOutputSchema(value);
  }
  return result;
}

const CONNECT_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
/** Only failures before anything reached the server are safe to resend. */
const connectFailure = (cause: unknown) => { const code = (cause as { cause?: { code?: string }; code?: string })?.cause?.code ?? (cause as { code?: string })?.code; return code && CONNECT_ERRORS.has(code) ? code : null; };
const retryAfterSeconds = (header: string | null) => {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : null;
};

interface ClaudeMessage { model?: string; stop_reason?: string | null; stop_details?: { category?: string | null } | null; content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } }

export interface ClaudeDirectorOptions extends Partial<ClaudeDirectorConfig> {
  /** Reads the key at call time (default: ANTHROPIC_API_KEY only; never Claude Code's own login). */
  apiKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
  /** Scales retry waits (tests). */
  waitScale?: number;
}

export class ClaudeDirectorProvider implements DirectorProvider {
  readonly id = "claude";
  readonly kind = "cloud" as const;
  readonly usesLocalGpu = false;
  readonly version = CLAUDE_PROVIDER_VERSION;
  readonly label: string;
  readonly config: ClaudeDirectorConfig;
  readonly #readKey: () => string | undefined;
  readonly #fetch: typeof fetch;
  readonly #waitScale: number;

  constructor(options: ClaudeDirectorOptions = {}) {
    const { apiKey, fetchImpl, waitScale, ...overrides } = options;
    const defined = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) as Partial<ClaudeDirectorConfig>;
    this.config = { ...loadDirectorSettings().claude, ...defined };
    this.label = `Claude API · ${this.config.model || "未配置模型"}`;
    this.#readKey = apiKey ?? (() => process.env.ANTHROPIC_API_KEY?.trim() || undefined);
    this.#fetch = fetchImpl ?? fetch;
    this.#waitScale = waitScale ?? 1;
  }

  available() {
    if (!this.config.model) return { ok: false, reason: "没有配置 Claude 模型 ID（config/director-providers.json）" };
    if (!this.#readKey()) return { ok: false, reason: "需要用户配置 Anthropic API Key（环境变量 ANTHROPIC_API_KEY）" };
    return { ok: true };
  }

  private price() { return this.config.pricingUsdPerMTok[this.config.model] ?? null; }

  /** Upper bound before the call: input tokens bounded from the text length (≤ 1.5 tokens per character), output by max_tokens. */
  callBudget(request: DirectorRequest, kind: "plan" | "repair", previous?: string): DirectorCallBudget {
    const chars = request.brief.system.length + request.brief.user.length + (kind === "repair" ? (previous?.length ?? 0) + 4_000 : 0);
    const maxInputTokens = Math.ceil(chars * 1.5) + 1_000;
    const price = this.price();
    return {
      maxInputTokens, maxOutputTokens: this.config.maxTokens,
      maxCostUsd: price ? Number(((maxInputTokens * price.input + this.config.maxTokens * price.output) / 1e6).toFixed(4)) : null,
      costBasis: price ? `list price ${this.config.model} (verified ${this.config.pricingVerifiedAt ?? "?"})` : "unpriced model: usage only",
    };
  }

  plan(request: DirectorRequest, options: { signal: AbortSignal }) {
    return this.send(request, [{ role: "user", content: request.brief.user }], options.signal);
  }

  repair(request: DirectorRequest, previous: string, problems: string[], options: { signal: AbortSignal }) {
    return this.send(request, [
      { role: "user", content: request.brief.user },
      { role: "assistant", content: previous },
      { role: "user", content: repairInstruction(problems) },
    ], options.signal);
  }

  private usageOf(message: ClaudeMessage, durationMs: number): DirectorUsage {
    const usage = message.usage ?? {};
    const result: DirectorUsage = {
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0, cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      durationMs, stopReason: message.stop_reason ?? null,
    };
    const price = this.price();
    if (price && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number") {
      result.costUsd = Number(((usage.input_tokens * price.input + (result.cacheCreationInputTokens ?? 0) * price.cacheWrite5m + (result.cacheReadInputTokens ?? 0) * price.cacheRead + usage.output_tokens * price.output) / 1e6).toFixed(6));
      result.costBasis = `list-price estimate (${this.config.model}, prices verified ${this.config.pricingVerifiedAt ?? "?"}); billed amount is in the Claude Console`;
    } else result.costBasis = "usage only (no verified price for this model)";
    return result;
  }

  private async send(request: DirectorRequest, messages: { role: "user" | "assistant"; content: string }[], signal: AbortSignal): Promise<DirectorCallResult> {
    const key = this.#readKey();
    if (!key) throw new DirectorCallError("需要用户配置 Anthropic API Key（环境变量 ANTHROPIC_API_KEY）", { code: "DIRECTOR_NO_API_KEY", fatal: true });
    if (!this.config.model) throw new DirectorCallError("没有配置 Claude 模型 ID", { code: "DIRECTOR_BAD_REQUEST", fatal: true });
    const body = JSON.stringify({
      model: this.config.model, max_tokens: this.config.maxTokens, system: request.brief.system, messages,
      output_config: { ...(this.config.effort ? { effort: this.config.effort } : {}), format: { type: "json_schema", schema: claudeOutputSchema() } },
    });
    const transport: DirectorTransportRecord[] = [];
    const started = Date.now();
    for (let attempt = 0; ; attempt += 1) {
      const sent = Date.now();
      const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
      const record = (status: number | null, error: string | null, requestId: string | null = null, retryAfter: number | null = null, retried = false) =>
        transport.push({ at: new Date(sent).toISOString(), status, error, durationMs: Date.now() - sent, requestId, retryAfterSeconds: retryAfter, retried });
      let response: Response;
      try {
        response = await this.#fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
          method: "POST", body, signal: AbortSignal.any([signal, timeout]),
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
        });
      } catch (cause) {
        if (signal.aborted || timeout.aborted) {
          record(null, signal.aborted ? "aborted" : "timeout");
          throw new DirectorCallError(signal.aborted ? "Claude 调用被中止；这次请求是否已计费无法确定" : `Claude 请求超过 ${Math.round(this.config.requestTimeoutMs / 1000)} 秒没有返回；是否已计费无法确定，不自动重发`, { code: "DIRECTOR_TIMEOUT", fatal: true, billingUncertain: true, transport });
        }
        const code = connectFailure(cause);
        const reason = sanitizeProviderError(cause instanceof Error ? `${cause.message}${code ? ` (${code})` : ""}` : String(cause));
        if (code && attempt < this.config.maxNetworkRetries) { record(null, reason, null, null, true); await delay(1_000 * 2 ** attempt * this.#waitScale, signal); continue; }
        record(null, reason);
        throw new DirectorCallError(`Claude API 不可达：${reason}`, { code: "DIRECTOR_NETWORK", fatal: true, billingUncertain: !code, transport });
      }
      const requestId = response.headers.get("request-id");
      if (response.ok) {
        let message: ClaudeMessage;
        try { message = await response.json() as ClaudeMessage; }
        catch (cause) {
          record(response.status, "unreadable body", requestId);
          throw new DirectorCallError(`Claude 响应无法读取：${cause instanceof Error ? cause.message : String(cause)}；是否已计费无法确定`, { code: "DIRECTOR_TIMEOUT", fatal: true, billingUncertain: true, transport });
        }
        record(response.status, null, requestId);
        const usage = this.usageOf(message, Date.now() - started);
        if (message.stop_reason === "refusal") throw new DirectorCallError(`Claude 拒绝了这次请求（refusal${message.stop_details?.category ? `：${message.stop_details.category}` : ""}）`, { code: "DIRECTOR_REFUSED", fatal: true, usage, transport });
        if (message.stop_reason === "max_tokens") throw new DirectorCallError("导演模型输出被截断（达到 max_tokens）", { code: "DIRECTOR_TRUNCATED", usage, transport });
        const text = (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
        if (!text.trim()) throw new DirectorCallError("导演模型返回了空内容", { code: "DIRECTOR_EMPTY", usage, transport });
        return { text, model: message.model ?? this.config.model, usage, transport };
      }
      const raw = await response.text().catch(() => "");
      let detail = ""; let errorCode: string | null = null;
      try { const parsed = JSON.parse(raw) as { error?: { type?: string; message?: string; details?: { error_code?: string } } }; detail = parsed.error?.message ?? parsed.error?.type ?? ""; errorCode = parsed.error?.details?.error_code ?? null; } catch { /* not JSON */ }
      const status = response.status;
      const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
      const summary = `HTTP ${status}${detail ? `：${sanitizeProviderError(detail)}` : ""}`;
      const fail = (code: string, message: string, billingUncertain = false) => { record(status, summary, requestId, retryAfter); return new DirectorCallError(message, { code, fatal: true, billingUncertain, transport }); };
      if (status === 401 || status === 403) throw fail("DIRECTOR_AUTH", `Claude API 认证 / 权限失败（${summary}），请检查 ANTHROPIC_API_KEY 与账户权限；不重试`);
      if (status === 402) throw fail("DIRECTOR_BILLING", `Claude API 账单问题（${summary}）；不重试`);
      if (status === 429) {
        if (errorCode === "enforced_spend_limit_reached" || retryAfter === null) throw fail("DIRECTOR_RATE_LIMIT", `Claude API 限流 / 额度用尽且没有 retry-after（${summary}）；不重试`);
        if (retryAfter > this.config.maxRetryAfterSeconds || attempt >= this.config.maxNetworkRetries) throw fail("DIRECTOR_RATE_LIMIT", `Claude API 限流（${summary}，retry-after ${retryAfter} 秒）；已达重试上限或等待过长`);
        record(status, summary, requestId, retryAfter, true);
        await delay(retryAfter * 1000 * this.#waitScale, signal);
        continue;
      }
      if (status === 504) throw fail("DIRECTOR_TIMEOUT", `Claude API 处理超时（${summary}）；是否已计费无法确定，不自动重发`, true);
      if ([500, 502, 503, 529].includes(status)) {
        if (attempt >= this.config.maxNetworkRetries) throw fail("DIRECTOR_UPSTREAM", `Claude API 服务端错误（${summary}）；已达重试上限`);
        record(status, summary, requestId, retryAfter, true);
        await delay((retryAfter ?? 2 ** attempt) * 1000 * this.#waitScale, signal);
        continue;
      }
      throw fail("DIRECTOR_BAD_REQUEST", `Claude API 拒绝了请求（${summary}）；不重试`);
    }
  }
}
