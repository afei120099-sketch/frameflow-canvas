import type { DirectorTransportRecord, DirectorUsage } from "./director-providers.ts";

/**
 * Helpers every real director provider shares, so no provider gets its own wording or error rules.
 */

/** Error text safe for ledgers, logs and reports: no URLs, bearer tokens, API keys or long bodies. */
export function sanitizeProviderError(text: string) {
  return text
    .replace(/sk-ant-[\w-]+/gi, "[redacted-key]")
    .replace(/(x-api-key|authorization)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s"')]+/gi, "[url]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

/** The single repair message (second and last call). Same text for every provider. */
export function repairInstruction(problems: string[]) {
  return `程序检查没有通过，请只修正以下问题，其余内容保持不变，返回完整 JSON（仍然只填语义字段，不要写任何提示词语法）：\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
}

/**
 * A failed provider call. `fatal` stops planning at once (no second call): authentication, permission,
 * billing, bad request, refusal, a timed-out call whose billing is unknown. `usage` / `transport` keep
 * whatever the provider reported so the ledger still accounts for it.
 */
export class DirectorCallError extends Error {
  readonly code: string;
  readonly fatal: boolean;
  readonly billingUncertain: boolean;
  readonly usage: DirectorUsage | null;
  readonly transport: DirectorTransportRecord[];
  constructor(message: string, options: { code: string; fatal?: boolean; billingUncertain?: boolean; usage?: DirectorUsage | null; transport?: DirectorTransportRecord[] }) {
    super(sanitizeProviderError(message));
    this.name = "DirectorCallError";
    this.code = options.code;
    this.fatal = options.fatal ?? false;
    this.billingUncertain = options.billingUncertain ?? false;
    this.usage = options.usage ?? null;
    this.transport = options.transport ?? [];
  }
}

export const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException("已取消", "AbortError")); return; }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(new DOMException("已取消", "AbortError")); };
  signal?.addEventListener("abort", stop, { once: true });
});
