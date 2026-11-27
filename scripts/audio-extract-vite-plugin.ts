import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const runFile = promisify(execFile);
const python = process.env.FRAMEFLOW_PYAV_PYTHON || "python";
const helper = fileURLToPath(new URL("./extract-audio.py", import.meta.url));
const MAX_INPUT = 512 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024 * 1024;

function localRequest(request: import("node:http").IncomingMessage) {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(request.headers.host ?? "") && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(request.socket.remoteAddress ?? "");
}

function errorPayload(cause: unknown) {
  const error = cause as Error & { stderr?: string; code?: string };
  try {
    const last = error.stderr?.trim().split(/\r?\n/).at(-1);
    if (last) {
      const parsed = JSON.parse(last) as { code?: string; message?: string };
      if (parsed.code && parsed.message) return parsed;
    }
  } catch { /* Fall through to a bounded human-readable error. */ }
  if (error.code === "ENOENT") return { code: "PYAV_UNAVAILABLE", message: "本地 PyAV 运行环境不存在，请检查 ComfyUI 内嵌 Python 路径" };
  return { code: "AUDIO_PROCESSING_FAILED", message: error.message || "声音提取失败" };
}

export function audioExtractPlugin(): Plugin {
  return {
    name: "frameflow-local-audio-extract",
    configureServer(server) {
      server.middlewares.use("/__audio_extract", async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        if (!localRequest(request)) { response.statusCode = 403; response.end(); return; }
        if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
        const url = new URL(request.url ?? "/", "http://localhost");
        const operation = url.searchParams.get("operation");
        if (operation !== "probe" && operation !== "extract" && operation !== "clip") { response.statusCode = 400; response.end(JSON.stringify({ code: "INVALID_OPERATION", message: "未知音频操作" })); return; }
        if (operation === "clip" && (url.searchParams.get("start") === null || url.searchParams.get("end") === null)) { response.statusCode = 422; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(JSON.stringify({ code: "INVALID_RANGE", message: "裁剪声音需要开始和结束时间" })); return; }
        const start = url.searchParams.get("start");
        const end = url.searchParams.get("end");
        const number = (value: string | null) => value === null ? null : Number(value);
        if ((start !== null && (!Number.isFinite(number(start)) || number(start)! < 0)) || (end !== null && !Number.isFinite(number(end)))) { response.statusCode = 400; response.end(JSON.stringify({ code: "INVALID_RANGE", message: "截取时间无效" })); return; }
        let directory = "";
        try {
          directory = await mkdtemp(join(tmpdir(), "frameflow-audio-"));
          const input = join(directory, operation === "clip" ? "input.wav" : "input.mp4");
          const output = join(directory, "output.wav");
          let received = 0;
          const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { received += chunk.length; callback(received <= MAX_INPUT ? null : new Error("媒体超过本地音频处理大小限制"), chunk); } });
          await pipeline(request, limiter, createWriteStream(input));
          if (!received) throw new Error("媒体文件为空");
          const args = [helper, operation, input];
          if (operation === "extract" || operation === "clip") {
            args.push(output);
            if (start !== null) args.push("--start", start);
            if (end !== null) args.push("--end", end);
          }
          const { stdout } = await runFile(python, args, { timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 });
          const result = JSON.parse(stdout) as Record<string, unknown>;
          if (operation === "probe") {
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify(result));
          } else {
            const size = (await stat(output)).size;
            if (size > MAX_OUTPUT) throw new Error("提取的 WAV 超过大小限制");
            response.setHeader("Content-Type", "audio/wav");
            response.setHeader("X-Audio-Duration", String(result.duration));
            response.setHeader("Content-Length", String(size));
            response.end(await readFile(output));
          }
        } catch (cause) {
          const payload = errorPayload(cause);
          if (!response.headersSent) { response.statusCode = ["NO_AUDIO_STREAM", "INVALID_RANGE", "CLIP_TOO_SHORT"].includes(payload.code ?? "") ? 422 : 500; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(JSON.stringify(payload)); }
        } finally {
          if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith("frameflow-audio-")) {
            await Promise.all([unlink(join(directory, "input.mp4")).catch(() => {}), unlink(join(directory, "input.wav")).catch(() => {}), unlink(join(directory, "output.wav")).catch(() => {})]);
            await rmdir(directory).catch(() => {});
          }
        }
      });
    },
  };
}
