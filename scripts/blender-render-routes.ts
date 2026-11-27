import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Director Stage 一键白模首帧 V0.2 (mounted at /__blender_render on the local dev server; loopback only):
 *
 *   GET  /status  → { available, build }    is the portable Blender there?
 *   POST /        { director, sceneId, cameraId, longSide, controls? } → { png (base64), camera (camera.json), controls? }
 *
 * `controls` (高级控制素材 V0.1): any of "depth" / "mask" / "object-id" — rendered in the same Blender run from
 * the same camera (whitebox_render.py --controls) and returned as { depth?, mask?, objectId? } base64 PNGs.
 *
 * `director` is a director-stage.json payload holding just the Scene to render. It is written to a
 * temporary folder, rendered by tools/blender/whitebox_render.py in a background Blender (RGB only),
 * and the folder is removed afterwards. One render at a time. Nothing is stored on the server: the
 * page registers the PNG as an Asset and creates the first_frame ControlPackage itself.
 */

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_ADDRESS = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const ID = /^[\w-]{1,80}$/;
const MAX_BODY = 512 * 1024;
const TEMP_PREFIX = "frameflow-blender-";
const CONTROL_FILES = { depth: "depth.png", mask: "mask.png", "object-id": "object-id.png" } as const;
type ControlName = keyof typeof CONTROL_FILES;
const CONTROL_KEYS: Record<ControlName, string> = { depth: "depth", mask: "mask", "object-id": "objectId" };

export type BlenderRenderOptions = { blender: () => string | null; script: string; timeoutMs?: number; log?: (line: string) => void };
type Failure = { status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): Failure => ({ status, code, message });

function send(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { size += (chunk as Buffer).length; if (size > MAX_BODY) throw fail(413, "TOO_LARGE", "场景数据过大"); chunks.push(chunk as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { throw fail(400, "BAD_REQUEST", "请求内容不是 JSON"); }
}

function validate(body: Record<string, unknown>) {
  const director = body.director as Record<string, unknown> | undefined;
  if (!director || typeof director !== "object" || !["scenes", "props", "cameras"].every((store) => Array.isArray(director[store]))) throw fail(400, "BAD_REQUEST", "缺少导演台场景数据");
  const { sceneId, cameraId } = body;
  if (typeof sceneId !== "string" || !ID.test(sceneId) || typeof cameraId !== "string" || !ID.test(cameraId)) throw fail(400, "BAD_REQUEST", "场景或摄影机 ID 无效");
  const longSide = body.longSide ?? 1280;
  if (typeof longSide !== "number" || !Number.isInteger(longSide) || longSide < 256 || longSide > 4096 || longSide % 16) throw fail(400, "BAD_REQUEST", "输出尺寸无效");
  const controls = body.controls ?? [];
  if (!Array.isArray(controls) || controls.some((name) => typeof name !== "string" || !(name in CONTROL_FILES)) || new Set(controls).size !== controls.length) throw fail(400, "BAD_REQUEST", "控制图类型无效（可选：depth / mask / object-id）");
  return { director, sceneId, cameraId, longSide, controls: controls as ControlName[] };
}

function runBlender(blender: string, args: string[], timeoutMs: number) {
  return new Promise<void>((done, reject) => {
    execFile(blender, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" } }, (error, _stdout, stderr) => {
      if (!error) { done(); return; }
      const cause = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
      if (cause.code === "ENOENT") { reject(fail(503, "BLENDER_UNAVAILABLE", "找不到 Blender，请检查便携版安装路径")); return; }
      if (cause.killed) { reject(fail(504, "BLENDER_TIMEOUT", `Blender 渲染超过 ${Math.round(timeoutMs / 1000)} 秒，已停止`)); return; }
      // whitebox_render.py exits with 2 and a "[whitebox_render] 错误：…" line for scene problems (unplaced camera, …).
      const reason = /\[whitebox_render\] 错误：(.+)/.exec(String(stderr))?.[1]?.trim();
      reject(reason ? fail(422, "INVALID_SCENE", reason) : fail(500, "BLENDER_FAILED", `Blender 渲染失败：${String(stderr).trim().split(/\r?\n/).slice(-2).join(" ") || cause.message}`));
    });
  });
}

export function createBlenderRenderHandler(options: BlenderRenderOptions) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  let busy = false;
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (!LOOPBACK_HOST.test(request.headers.host ?? "") || !LOOPBACK_ADDRESS.test(request.socket.remoteAddress ?? "")) { send(response, 403, { code: "FORBIDDEN", message: "只接受本机请求" }); return; }
    const path = (request.url ?? "/").split("?")[0].replace(/\/+$/, "") || "/";
    if (request.method === "GET" && path === "/status") {
      const blender = options.blender();
      send(response, 200, { available: Boolean(blender), build: blender ? basename(dirname(blender)) : null });
      return;
    }
    if (request.method !== "POST" || path !== "/") { send(response, 404, { code: "NOT_FOUND", message: "未知的白模渲染请求" }); return; }
    // A render starts a local process: only pages on this machine, only JSON (no cross-site form posts).
    const origin = request.headers.origin;
    if ((origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) || !/^application\/json\b/i.test(request.headers["content-type"] ?? "")) { send(response, 403, { code: "FORBIDDEN", message: "只接受本机页面的 JSON 请求" }); return; }
    if (busy) { send(response, 409, { code: "BUSY", message: "已有一张白模首帧正在渲染，请稍候" }); return; }
    busy = true;
    let directory = "";
    try {
      const job = validate(await readJson(request));
      const blender = options.blender();
      if (!blender) throw fail(503, "BLENDER_UNAVAILABLE", "本机没有找到便携版 Blender（FRAMEFLOW_BLENDER 或 FRAMEFLOW_BLENDER_SEARCH_DIR）");
      directory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
      await writeFile(join(directory, "director-stage.json"), JSON.stringify(job.director), "utf8");
      const out = join(directory, "out");
      const started = Date.now();
      await runBlender(blender, ["-b", "--factory-startup", "--python-exit-code", "1", "-P", options.script, "--", "--input", directory, "--scene", job.sceneId, "--camera", job.cameraId, "--out", out, "--long-side", String(job.longSide), ...(job.controls.length ? ["--controls", job.controls.join(",")] : [])], timeoutMs);
      const [png, camera] = await Promise.all([readFile(join(out, "rgb.png")), readFile(join(out, "camera.json"), "utf8")]);
      const controls = Object.fromEntries(await Promise.all(job.controls.map(async (name) => [CONTROL_KEYS[name], (await readFile(join(out, CONTROL_FILES[name]))).toString("base64")] as const)));
      options.log?.(`[blender] 白模首帧 ${job.sceneId}/${job.cameraId} ${png.length} 字节，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
      send(response, 200, { png: png.toString("base64"), camera: JSON.parse(camera), ...(job.controls.length ? { controls } : {}) });
    } catch (cause) {
      const failure = (cause as Failure).code && (cause as Failure).status ? cause as Failure : fail(500, "BLENDER_FAILED", cause instanceof Error ? cause.message : String(cause));
      send(response, failure.status, { code: failure.code, message: failure.message });
    } finally {
      busy = false;
      if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith(TEMP_PREFIX)) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
