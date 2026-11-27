import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PYAV_PYTHON } from "./pyav-runtime.ts";

/** Same-origin loopback only, one CPU job; uploads are streamed, temp data always removed. */
export function mediaAuditRoute() {
  let busy = false, child: ChildProcess | null = null;
  const script = fileURLToPath(new URL("./media-audit.py", import.meta.url));
  const send = (res: ServerResponse, status: number, data: unknown) => { if (res.destroyed) return; res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
  return {
    close: () => child?.kill(),
    async handle(req: IncomingMessage, res: ServerResponse) {
      const host = req.headers.host ?? "";
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) || !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? "")) { send(res, 403, { error: "仅允许本机" }); return; }
      if (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) { send(res, 403, { error: "仅允许同源请求" }); return; }
      if (req.headers["sec-fetch-site"] === "cross-site") { send(res, 403, { error: "禁止跨站请求" }); return; }
      if (req.method !== "POST" || !req.headers["content-type"]?.startsWith("application/octet-stream")) { send(res, 405, { error: "需要上传视频字节" }); return; }
      if (busy) { send(res, 409, { error: "已有视频正在检查，请稍后" }); return; }
      busy = true;
      let dir: string | undefined;
      let disconnected = false;
      const abort = () => { disconnected = true; child?.kill(); req.destroy(); };
      const onClose = () => { if (!res.writableEnded) abort(); };
      res.once("close", onClose);
      const timer = setTimeout(abort, 5 * 60_000);
      try {
        dir = await mkdtemp(join(tmpdir(), "frameflow-audit-"));
        const path = join(dir, "source.bin");
        let bytes = 0; const hash = createHash("sha256");
        await pipeline(req, new Transform({ transform(chunk: Buffer, _enc, done) { bytes += chunk.length; hash.update(chunk); done(bytes > 1024 ** 3 ? new Error("文件超过 1GB 检查上限") : null, chunk); } }), createWriteStream(path));
        if (!bytes || disconnected) throw new Error("视频为空或检查已取消");
        const result = await new Promise<string>((resolve, reject) => {
          child = spawn(PYAV_PYTHON, [script, path], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
          let out = "", err = "";
          child.stdout!.on("data", (chunk) => { out += chunk; if (out.length > 5_000_000) { child?.kill(); reject(new Error("分析结果过大")); } });
          child.stderr!.on("data", (chunk) => { err = (err + chunk).slice(-3000); });
          child.once("error", reject);
          child.once("close", (code) => code === 0 ? resolve(out) : reject(new Error(err || "视频无法完整解码或检查超时")));
        });
        send(res, 200, { ...JSON.parse(result), sourceHash: hash.digest("hex") });
      } catch (error) { send(res, 422, { error: error instanceof Error ? error.message : "检查失败" }); }
      finally { clearTimeout(timer); res.off("close", onClose); child = null; try { if (dir) await rm(dir, { recursive: true, force: true }); } catch (error) { console.error("Media audit temporary cleanup failed", dir, error); } finally { busy = false; } }
    },
  };
}
