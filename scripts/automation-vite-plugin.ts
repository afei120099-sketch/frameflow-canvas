import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Canvas automation V0.1 (dev server only, loopback only), used by window.frameflow (lib/canvas-automation.ts):
 *
 *   GET /__automation/ping             → { ok, roots }   the page installs window.frameflow only when this answers
 *   GET /__automation/file?path=<abs>  → the file bytes   image / video / audio inside an allowed root only
 *
 * Allowed roots: FRAMEFLOW_AUTOMATION_ROOTS (";"-separated) or, by default, ./data/automation.
 * Read-only: nothing is written, listed or executed. Production builds do not have this endpoint,
 * so window.frameflow is never installed there.
 */

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_ADDRESS = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const MAX_BYTES = 200 * 1024 * 1024;
const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
};

export function automationRoots() {
  const configured = process.env.FRAMEFLOW_AUTOMATION_ROOTS?.split(";").map((item) => item.trim()).filter(Boolean);
  return (configured?.length ? configured : [resolve(process.env.FRAMEFLOW_DATA_ROOT || "data", "automation")]).map((root) => resolve(root));
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function isLoopback(request: IncomingMessage) {
  const origin = request.headers.origin;
  return LOOPBACK_HOST.test(request.headers.host ?? "") && LOOPBACK_ADDRESS.test(request.socket.remoteAddress ?? "") && (!origin || LOOPBACK_ORIGIN.test(origin));
}

const inside = (root: string, target: string) => { const rel = relative(root, target); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };

export async function resolveAllowedFile(raw: string, roots = automationRoots()) {
  if (!raw || !isAbsolute(raw)) throw Object.assign(new Error("需要绝对路径"), { status: 400 });
  const type = TYPES[extname(raw).toLowerCase()];
  if (!type) throw Object.assign(new Error("只支持 PNG / JPG / WEBP / MP4 / WAV / MP3 / M4A"), { status: 400 });
  let real: string;
  try { real = await realpath(resolve(raw)); } catch { throw Object.assign(new Error("文件不存在"), { status: 404 }); }
  const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
  if (!realRoots.some((root) => inside(root, real))) throw Object.assign(new Error("路径不在允许的目录内"), { status: 403 });
  const info = await stat(real);
  if (!info.isFile()) throw Object.assign(new Error("不是文件"), { status: 400 });
  if (info.size > MAX_BYTES) throw Object.assign(new Error("文件超过 200MB"), { status: 413 });
  return { path: real, type, size: info.size };
}

export function automationPlugin(): Plugin {
  return {
    name: "frameflow-automation",
    configureServer(server) {
      server.middlewares.use("/__automation", (request, response) => {
        if (!isLoopback(request)) return send(response, 403, { ok: false, message: "仅限本机访问" });
        if (request.method !== "GET") return send(response, 405, { ok: false, message: "只支持 GET" });
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/ping") return send(response, 200, { ok: true, roots: automationRoots() });
        if (url.pathname !== "/file") return send(response, 404, { ok: false, message: "未知接口" });
        void resolveAllowedFile(url.searchParams.get("path") ?? "").then((file) => {
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Type", file.type);
          response.setHeader("Content-Length", String(file.size));
          createReadStream(file.path).on("error", () => response.destroy()).pipe(response);
        }).catch((cause: Error & { status?: number }) => send(response, cause.status ?? 500, { ok: false, message: cause.message }));
      });
    },
  };
}
