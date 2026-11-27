import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { RoughCutJobs, type RoughCutError, type RoughCutSizePolicy } from "./rough-cut-jobs";
import { PYAV_PYTHON as python, ROUGH_CUT_SCRIPT as script } from "./pyav-runtime";
import { mediaAuditRoute } from "./media-audit-route";

/**
 * Phase 19: local rough-cut jobs on the dev server (same model as /__audio_extract: loopback only,
 * the existing ComfyUI embedded Python + PyAV, temporary files removed afterwards).
 *
 *   POST   /__rough_cut/jobs                    {clips}           → {id, sources, scriptVersion}
 *   PUT    /__rough_cut/jobs/:id/sources/:key   (video bytes)
 *   POST   /__rough_cut/jobs/:id/plan           {sizePolicy}      → real media info + output spec
 *   POST   /__rough_cut/jobs/:id/start          {sizePolicy}      → status
 *   GET    /__rough_cut/jobs/:id                                  → status (stage / error / result)
 *   GET    /__rough_cut/jobs/:id/result                           → output.mp4
 *   POST   /__rough_cut/jobs/:id/cancel                           → stops PyAV, removes files
 *   DELETE /__rough_cut/jobs/:id                                  → removes files
 */

function localRequest(request: IncomingMessage) {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(request.headers.host ?? "") && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(request.socket.remoteAddress ?? "");
}

async function readJson(request: IncomingMessage, limit = 2 * 1024 * 1024) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw Object.assign(new Error("请求过大"), { roughCut: { code: "TOO_LARGE", message: "请求过大", clip: null, stage: null } }); chunks.push(chunk as Buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, body?: unknown) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  if (body === undefined) { response.end(); return; }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function failure(cause: unknown): { status: number; body: RoughCutError } {
  const info = (cause as { roughCut?: RoughCutError }).roughCut;
  if (info) return { status: ["JOB_NOT_FOUND"].includes(info.code) ? 404 : ["PYAV_UNAVAILABLE"].includes(info.code) ? 500 : 422, body: info };
  return { status: 500, body: { code: "ROUGH_CUT_FAILED", message: cause instanceof Error ? cause.message : "粗剪处理失败", clip: null, stage: null } };
}

export function roughCutPlugin(): Plugin {
  return {
    name: "frameflow-local-rough-cut",
    configureServer(server) {
      const audit = mediaAuditRoute();
      server.middlewares.use("/__media_audit", (req, res) => { void audit.handle(req, res); });
      server.httpServer?.once("close", () => audit.close());
      // Vite configuration reloads replace the HTTP server, not the Node process.
      // Retain job ownership across that reload; never kill CPU exports on HTTP close.
      const key=Symbol.for("frameflow.rough-cut-jobs.v1");
      const registry=globalThis as unknown as Record<symbol,RoughCutJobs|undefined>;
      const jobs=registry[key]??(registry[key]=new RoughCutJobs({python,script}));
      server.middlewares.use("/__rough_cut/jobs", async (request, response) => {
        if (!localRequest(request)) { send(response, 403); return; }
        const parts = (request.url ?? "/").split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
        const [id, action, key] = parts;
        try {
          if (!id && request.method === "POST") { const body = await readJson(request); send(response, 200, await jobs.create(body.clips as never)); return; }
          if (!id) { send(response, 405); return; }
          if (action === "sources" && key && request.method === "PUT") { send(response, 200, await jobs.writeSource(id, key, request)); return; }
          if (action === "plan" && request.method === "POST") { const body = await readJson(request); send(response, 200, await jobs.plan(id, body.sizePolicy as RoughCutSizePolicy)); return; }
          if (action === "start" && request.method === "POST") { const body = await readJson(request); send(response, 200, await jobs.start(id, body.sizePolicy as RoughCutSizePolicy)); return; }
          if (action === "cancel" && request.method === "POST") { await jobs.cancel(id); send(response, 204); return; }
          if (action === "result" && request.method === "GET") {
            const file = await jobs.resultFile(id);
            response.statusCode = 200;
            response.setHeader("Content-Type", "video/mp4");
            response.setHeader("Content-Length", String(file.size));
            response.setHeader("Cache-Control", "no-store");
            createReadStream(file.path).pipe(response);
            return;
          }
          if (!action && request.method === "GET") { send(response, 200, jobs.status(id)); return; }
          if (!action && request.method === "DELETE") { await jobs.dispose(id); send(response, 204); return; }
          send(response, 405);
        } catch (cause) {
          const { status, body } = failure(cause);
          if (!response.headersSent) send(response, status, body);
          else response.destroy();
        }
      });
    },
  };
}
