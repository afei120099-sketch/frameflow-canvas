// Loopback file drop for page packs. Does not touch the canvas, inbox, or recycle helper.
import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";

export const TRANSFER_PORT = 5198;
const ROOT = process.env.FRAMEFLOW_PAGE_TRANSFER_ROOT || path.join(path.resolve(process.env.FRAMEFLOW_DATA_ROOT || "data"), "page-transfer");
const SERVICE = "frameflow-page-transfer-v1";
const ALLOWED_CANVAS_PORTS = [5173, 5174, 5175, 5176, 5177];
const ALLOWED_CANVAS_ORIGINS = new Set(ALLOWED_CANVAS_PORTS.flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]));

function scopeDir(scope) {
  if (scope === "backup") return path.join(ROOT, "backup");
  if (!/^[a-z0-9_-]{1,40}$/.test(scope || "")) throw new Error("scope 不合法");
  return path.join(ROOT, "transfer", scope);
}

function safeFile(scope, file) {
  if (typeof file !== "string" || !file || file.length > 300 || file.includes("\0")) throw new Error("file 不合法");
  const rel = file.replace(/\\/g, "/");
  if (rel.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("file 不合法");
  const full = path.resolve(scopeDir(scope), rel);
  const root = path.resolve(scopeDir(scope));
  if (!full.startsWith(root + path.sep) && full !== root) throw new Error("file 越界");
  return full;
}

async function listFiles(dir, prefix = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) {
      const stat = await fs.stat(path.join(dir, entry.name));
      files.push({ name: rel.replace(/\\/g, "/"), size: stat.size });
    }
  }
  return files;
}

export async function startPageTransferServer({ port = TRANSFER_PORT } = {}) {
  try {
    const existing = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    if ((await existing.json()).service !== SERVICE) throw new Error(`${port}端口被其他程序占用`);
    return;
  } catch (error) { if (String(error.message).includes("端口被其他程序占用")) throw error; }
  await fs.mkdir(path.join(ROOT, "backup"), { recursive: true });
  await fs.mkdir(path.join(ROOT, "transfer"), { recursive: true });
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin) {
      if (!ALLOWED_CANVAS_ORIGINS.has(origin)) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "禁止跨站请求" }));
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-transfer-gen");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && url.pathname === "/") return json(200, { service: SERVICE, root: ROOT });
      if (req.method === "POST" && (url.pathname === "/write" || url.pathname === "/link") && req.headers["x-transfer-gen"] !== "2") return json(409, { error: "旧的导出页已停用" });
      const scope = url.searchParams.get("scope") || "";
      if (req.method === "GET" && url.pathname === "/list") return json(200, { files: await listFiles(scopeDir(scope)) });
      if (req.method === "GET" && url.pathname === "/file") {
        const full = safeFile(scope, url.searchParams.get("file") || "");
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
        createReadStream(full).pipe(res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/link") {
        const from = safeFile(url.searchParams.get("from") || "", url.searchParams.get("fromFile") || "");
        const full = safeFile(scope, url.searchParams.get("file") || "");
        await fs.mkdir(path.dirname(full), { recursive: true });
        try { await fs.link(from, full); }
        catch (error) {
          if (error.code !== "EEXIST") await fs.copyFile(from, full);
        }
        const stat = await fs.stat(full);
        return json(200, { ok: true, bytes: stat.size });
      }
      if (req.method === "POST" && url.pathname === "/write") {
        const full = safeFile(scope, url.searchParams.get("file") || "");
        await fs.mkdir(path.dirname(full), { recursive: true });
        const tmp = `${full}.${process.pid}.part`;
        await pipeline(req, createWriteStream(tmp));
        await fs.rename(tmp, full);
        const stat = await fs.stat(full);
        console.log(`wrote ${scope}/${url.searchParams.get("file")} ${stat.size}`);
        return json(200, { ok: true, bytes: stat.size });
      }
      if (req.method === "POST" && url.pathname === "/report") {
        const full = path.join(scopeDir(scope), "_import_report.json");
        await fs.mkdir(path.dirname(full), { recursive: true });
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        JSON.parse(body.toString("utf8"));
        await fs.writeFile(full, body);
        return json(200, { ok: true });
      }
      return json(404, { error: "未知操作" });
    } catch (error) { json(400, { error: error.message || "失败" }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  server.unref();
  console.log(`page transfer on 127.0.0.1:${port}, root ${ROOT}`);
  return server;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/page-transfer-server.mjs")) {
  const server = await startPageTransferServer();
  server?.ref();
}
