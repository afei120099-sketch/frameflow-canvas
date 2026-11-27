import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { JOB_ID_PATTERN } from "./autopilot-ledger.ts";
import { AutopilotError, type AutopilotWorker } from "./autopilot-worker.ts";

/**
 * Autopilot routes, M1 + M2 (mounted at /__autopilot on the local dev server; loopback only):
 *
 *   GET  /jobs                  → overview: active job, latest job, summaries
 *   POST /jobs                  → start the fixed three-shot night test (409 when one is active, 503 when ComfyUI is offline)
 *   GET  /jobs/:id              → full job ledger
 *   POST /jobs  {kind:"m2", intent, targetSeconds?, aspect?, promptMode?, director?, preset?, approvedFacts?, forbiddenClaims?, constraints?, subjectAnchor?} → M2 director plan (no GPU)
 *   POST /jobs/:id/start        → M2 【开始制作】: production gate (re-check, unload the local director) → Shots
 *   GET  /directors             → M2 director providers and availability
 *   POST /director-task {request} → 【复制给GPT / Claude】 task text (no job, no model call)
 *   POST /jobs  {kind:"m2-import", packageText, providerLabel?, expected?} → Director Plan Package → validated plan (422 + details when not)
 *   POST /jobs/:id/cancel       → 【取消夜班任务】 (also discards a plan waiting for confirmation)
 *   POST /jobs/:id/resume       → continue a paused job ({ resubmit: true } = user confirmed a new attempt)
 *   GET  /jobs/:id/output       → final MP4 (Range for playback, ?download=1 for a download)
 *   POST /jobs/:id/reveal       → show the final MP4 in Explorer
 *
 * The page only reads and requests; closing it does nothing to the worker.
 */

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_ADDRESS = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function localRequest(request: IncomingMessage) {
  return LOOPBACK_HOST.test(request.headers.host ?? "") && LOOPBACK_ADDRESS.test(request.socket.remoteAddress ?? "");
}

/** State-changing calls must come from a page on this machine (another site can't start GPU work through the browser). */
function trustedWrite(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) return false;
  return /^application\/json\b/i.test(request.headers["content-type"] ?? "");
}

async function readJson(request: IncomingMessage, limit = 16 * 1024) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { size += (chunk as Buffer).length; if (size > limit) throw new AutopilotError("TOO_LARGE", "请求过大", 413); chunks.push(chunk as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>; }
  catch { throw new AutopilotError("BAD_REQUEST", "请求内容不是 JSON", 400); }
}

function send(response: ServerResponse, status: number, body?: unknown) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  if (body === undefined) { response.end(); return; }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export function revealInExplorer(path: string) {
  if (process.platform !== "win32") return Promise.reject(new AutopilotError("UNSUPPORTED", "定位文件只支持 Windows", 501));
  return new Promise<void>((resolve, reject) => {
    const child = spawn("explorer.exe", [`/select,"${path}"`], { windowsVerbatimArguments: true, detached: true, stdio: "ignore" });
    child.once("error", (cause) => reject(new AutopilotError("REVEAL_FAILED", `无法打开资源管理器：${cause.message}`, 500)));
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function streamOutput(worker: AutopilotWorker, id: string, request: IncomingMessage, response: ServerResponse, download: boolean) {
  const file = await worker.outputFile(id);
  response.setHeader("Content-Type", "video/mp4");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "no-store");
  if (download) response.setHeader("Content-Disposition", `attachment; filename="${file.filename.replace(/[^\w.-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  let start = 0; let end = file.size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), file.size - 1); }
    else { start = Math.max(0, file.size - Number(range[2])); }
    if (start > end || start >= file.size) { response.statusCode = 416; response.setHeader("Content-Range", `bytes */${file.size}`); response.end(); return; }
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${file.size}`);
  } else response.statusCode = 200;
  response.setHeader("Content-Length", String(end - start + 1));
  if (request.method === "HEAD") { response.end(); return; }
  const stream = createReadStream(file.path, { start, end });
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}

export function createAutopilotHandler(worker: AutopilotWorker, options: { reveal?: (path: string) => Promise<void> } = {}) {
  const reveal = options.reveal ?? revealInExplorer;
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (!localRequest(request)) { send(response, 403, { code: "FORBIDDEN", message: "夜班服务只接受本机请求" }); return; }
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD" && !trustedWrite(request)) { send(response, 403, { code: "FORBIDDEN", message: "只接受本机画布页面发出的 JSON 请求" }); return; }
    const url = new URL(request.url ?? "/", "http://localhost");
    const [collection, id, action, ...rest] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    try {
      if (collection === "directors" && !id && method === "GET") { await worker.ready(); send(response, 200, worker.directorsInfo()); return; }
      if (collection === "director-task" && !id && method === "POST") { const body = await readJson(request); send(response, 200, await worker.directorTask(body.request)); return; }
      if (collection !== "jobs" || rest.length) { send(response, 404, { code: "NOT_FOUND", message: "未知的夜班服务地址" }); return; }
      if (!id) {
        if (method === "GET") { send(response, 200, await worker.list()); return; }
        if (method === "POST") {
          // A pasted Director Plan Package can be larger than the other requests.
          const body = await readJson(request, 512 * 1024);
          if (body.kind === "m2-import") { send(response, 201, await worker.createImportedDraft({ packageText: body.packageText, providerLabel: body.providerLabel, expected: body.expected })); return; }
          // No kind (or M1): the fixed three-shot test. kind "m2": one sentence → director plan (waits for /start).
          if (body.kind === "m2") { send(response, 201, await worker.createDraft({ intent: String(body.intent ?? ""), targetSeconds: body.targetSeconds as number | undefined, aspect: body.aspect as string | undefined, promptMode: body.promptMode as string | undefined, director: body.director as string | undefined, preset: typeof body.preset === "string" ? body.preset : undefined, approvedFacts: Array.isArray(body.approvedFacts) ? body.approvedFacts.map(String) : undefined, forbiddenClaims: Array.isArray(body.forbiddenClaims) ? body.forbiddenClaims.map(String) : undefined, constraints: body.constraints && typeof body.constraints === "object" ? body.constraints as Record<string, unknown> : undefined, subjectAnchor: body.subjectAnchor })); return; }
          send(response, 201, await worker.create());
          return;
        }
        send(response, 405); return;
      }
      if (!JOB_ID_PATTERN.test(id)) { send(response, 404, { code: "NOT_FOUND", message: "夜班任务不存在" }); return; }
      if (!action && method === "GET") { send(response, 200, await worker.get(id)); return; }
      if (action === "start" && method === "POST") { await readJson(request); send(response, 200, await worker.confirm(id)); return; }
      if (action === "cancel" && method === "POST") { await readJson(request); send(response, 200, await worker.cancel(id)); return; }
      if (action === "resume" && method === "POST") { const body = await readJson(request); send(response, 200, await worker.resume(id, { resubmit: body.resubmit === true })); return; }
      if (action === "output" && (method === "GET" || method === "HEAD")) { await streamOutput(worker, id, request, response, url.searchParams.get("download") === "1"); return; }
      if (action === "reveal" && method === "POST") { await readJson(request); const file = await worker.outputFile(id); await reveal(file.path); send(response, 200, { path: file.path }); return; }
      send(response, 405);
    } catch (cause) {
      if (response.headersSent) { response.destroy(); return; }
      if (cause instanceof AutopilotError) { send(response, cause.status, { code: cause.code, message: cause.message, ...(cause.details !== undefined ? { details: cause.details } : {}) }); return; }
      send(response, 500, { code: "AUTOPILOT_FAILED", message: cause instanceof Error ? cause.message : "夜班服务处理失败" });
    }
  };
}
