/**
 * Minimal ComfyUI client for the production worker (Node, absolute ComfyUI URL). Every prompt carries
 * extra_data.frameflowInstance = "production" so canvas instances ignore it and this client ignores
 * theirs. Submission uses a reserved prompt_id: the id is on disk before /prompt is sent.
 */

export const PRODUCTION_INSTANCE = "production";

export interface ComfyOutputFile { filename: string; subfolder: string; type: string }
export type ProductionProbe =
  | { state: "queued" | "running" }
  | { state: "completed"; outputs: Record<string, ComfyOutputFile[]> }
  | { state: "failed"; error: string }
  | { state: "not_found" };

export class SubmissionNotSent extends Error { readonly code = "SUBMIT_NOT_SENT"; }
export class SubmissionUncertain extends Error { readonly code = "SUBMIT_UNCERTAIN"; }

type FetchLike = typeof fetch;

function refusedBeforeSend(cause: unknown, depth = 0): boolean {
  if (!cause || depth > 4) return false;
  const code = (cause as { code?: unknown }).code;
  if (code === "ECONNREFUSED") return true;
  return refusedBeforeSend((cause as { cause?: unknown }).cause, depth + 1);
}

function outputFiles(value: unknown): ComfyOutputFile[] {
  if (!value || typeof value !== "object") return [];
  const files: ComfyOutputFile[] = [];
  for (const key of ["images", "gifs", "videos"]) {
    const list = (value as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const file = item as Partial<ComfyOutputFile>;
      if (typeof file?.filename === "string" && file.filename) files.push({ filename: file.filename, subfolder: typeof file.subfolder === "string" ? file.subfolder : "", type: typeof file.type === "string" ? file.type : "output" });
    }
  }
  return files;
}

/** The /prompt body: production instance tag; video graphs also drop VideoHelperSuite's silent intermediate MP4. */
export function productionPromptBody(graph: unknown, promptId: string) {
  const savesVideo = Object.values((graph ?? {}) as Record<string, { class_type?: string }>).some((node) => node?.class_type === "VHS_VideoCombine");
  return {
    prompt: graph, prompt_id: promptId, client_id: `frameflow-production-${promptId}`,
    extra_data: { frameflowInstance: PRODUCTION_INSTANCE, ...(savesVideo ? { extra_pnginfo: { workflow: { extra: { VHS_KeepIntermediate: false } } } } : {}) },
  };
}

export function belongsToProduction(prompt: unknown) {
  const extra = Array.isArray(prompt) ? prompt[3] : undefined;
  return !!extra && typeof extra === "object" && (extra as { frameflowInstance?: unknown }).frameflowInstance === PRODUCTION_INSTANCE;
}

export class ProductionComfyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  constructor(baseUrl: string, fetchImpl: FetchLike = fetch, timeoutMs = 60_000) { this.baseUrl = baseUrl; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; }

  private async request(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}：${(await response.text()).slice(0, 600)}`);
    return response;
  }

  async online() {
    try { await this.request("/system_stats", { cache: "no-store" }, 5000); return true; } catch { return false; }
  }

  /** Every prompt ComfyUI holds (running + pending), whoever submitted it. */
  async queue() {
    const body = await (await this.request("/queue", { cache: "no-store" }, 8000)).json() as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    const rows = [...(body.queue_running ?? []).map((row) => ({ row, running: true })), ...(body.queue_pending ?? []).map((row) => ({ row, running: false }))];
    return rows.map(({ row, running }) => ({ promptId: String(row[1]), running, production: belongsToProduction(row) }));
  }

  async objectInfo(nodeClass: string) {
    return (await (await this.request(`/object_info/${encodeURIComponent(nodeClass)}`, { cache: "no-store" }, 15000)).json()) as Record<string, { input?: { required?: Record<string, unknown[]> } }>;
  }

  /** Uploads into ComfyUI's input folder under a unique name; returns the name a LoadImage node uses. */
  async uploadImage(data: Uint8Array, name: string) {
    const form = new FormData();
    form.append("image", new Blob([data as unknown as BlobPart]), name);
    form.append("type", "input");
    form.append("overwrite", "false");
    const file = await (await this.request("/upload/image", { method: "POST", body: form }, 60_000)).json() as { name?: string; subfolder?: string };
    if (!file.name) throw new Error("ComfyUI 没有返回上传后的文件名");
    return [file.subfolder, file.name].filter(Boolean).join("/");
  }

  async submit(graph: unknown, promptId: string) {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/prompt`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify(productionPromptBody(graph, promptId)),
      });
    } catch (cause) {
      // Refused before a connection existed → provably never reached ComfyUI. Anything else might have.
      if (refusedBeforeSend(cause)) throw new SubmissionNotSent(`ComfyUI 拒绝连接：${cause instanceof Error ? cause.message : String(cause)}`);
      throw new SubmissionUncertain(`提交时连接中断，无法确定 ComfyUI 是否收到：${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`ComfyUI 拒绝了任务（HTTP ${response.status}）：${text.slice(0, 800)}`);
    const body = JSON.parse(text) as { prompt_id?: string; node_errors?: Record<string, unknown> };
    if (body.node_errors && Object.keys(body.node_errors).length) throw new Error(`ComfyUI 节点校验未通过：${JSON.stringify(body.node_errors).slice(0, 800)}`);
    if (body.prompt_id !== promptId) throw new Error(`ComfyUI 返回的任务 ID 与预留的不一致（${body.prompt_id ?? "无"}）`);
    return promptId;
  }

  /** History, then queue, then history again (closes the finished-between-reads race). Read-only. */
  async probe(promptId: string): Promise<ProductionProbe> {
    const fromHistory = async (): Promise<ProductionProbe | null> => {
      const history = await (await this.request(`/history/${encodeURIComponent(promptId)}`, { cache: "no-store" }, 15000)).json() as Record<string, Record<string, unknown>>;
      const entry = history[promptId];
      if (!entry) return null;
      const status = entry.status as { completed?: boolean; status_str?: string; messages?: [string, Record<string, unknown>][] } | undefined;
      const failure = status?.messages?.find(([kind]) => kind === "execution_error")?.[1];
      if (failure) return { state: "failed", error: `${String(failure.node_type ?? "")} ${String(failure.exception_message ?? "执行出错")}`.trim().slice(0, 600) };
      if (status && status.completed === false && status.status_str !== "success") return { state: "failed", error: "ComfyUI 任务未完成即结束（可能被中断）" };
      const outputs: Record<string, ComfyOutputFile[]> = {};
      for (const [node, value] of Object.entries((entry.outputs as Record<string, unknown>) ?? {})) { const files = outputFiles(value); if (files.length) outputs[node] = files; }
      return { state: "completed", outputs };
    };
    const first = await fromHistory();
    if (first) return first;
    const queue = await this.queue();
    const hit = queue.find((item) => item.promptId === promptId);
    if (hit) return { state: hit.running ? "running" : "queued" };
    return (await fromHistory()) ?? { state: "not_found" };
  }

  async download(file: ComfyOutputFile) {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const data = new Uint8Array(await (await this.request(`/view?${query}`, { cache: "no-store" }, 300_000)).arrayBuffer());
    if (!data.byteLength) throw new Error(`ComfyUI 返回的文件是空的：${file.filename}`);
    return data;
  }

  /** Only removes a pending prompt that belongs to production. Never /interrupt, never other prompts. */
  async deletePending(promptId: string) {
    const queue = await this.queue();
    const item = queue.find((row) => row.promptId === promptId);
    if (!item || item.running || !item.production) return false;
    await this.request("/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) });
    return true;
  }
}
