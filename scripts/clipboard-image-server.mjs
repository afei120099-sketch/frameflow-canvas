import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const PORT = 5193;
const MAX_BYTES = 40 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const directory = join(tmpdir(), "frameflow-clipboard");

function allowedOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(Error("图片过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function clearOldFiles() {
  const names = await readdir(directory).catch(() => []);
  const cutoff = Date.now() - 10 * 60 * 1000;
  await Promise.all(names.map(async (name) => {
    const file = join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && info.mtimeMs < cutoff) await unlink(file).catch(() => {});
  }));
}

/** Writes CF_DIB, PNG and a real PNG file. Browser image/png alone is invisible to other chat apps. */
export async function setWindowsClipboardPng(png) {
  if (process.platform !== "win32") throw Error("只有 Windows 能写入系统图片剪贴板");
  if (png.length < PNG.length || !PNG.equals(png.subarray(0, PNG.length))) throw Error("不是 PNG 图片");
  await mkdir(directory, { recursive: true });
  await clearOldFiles();
  const file = join(directory, `${randomUUID()}.png`);
  await writeFile(file, png);
  const literal = `'${file.replaceAll("'", "''")}'`;
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$path = ${literal}
$image = [System.Drawing.Image]::FromFile($path)
$png = New-Object System.IO.MemoryStream
$image.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$png.Position = 0
$bmp = New-Object System.IO.MemoryStream
$image.Save($bmp, [System.Drawing.Imaging.ImageFormat]::Bmp)
$all = $bmp.ToArray()
if ($all.Length -le 14) { throw 'BMP 无效' }
$dib = New-Object System.IO.MemoryStream
$dib.Write($all, 14, $all.Length - 14)
$dib.Position = 0
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add($path)
$data = New-Object System.Windows.Forms.DataObject
$data.SetData([System.Windows.Forms.DataFormats]::Dib, $dib)
$data.SetData('PNG', $png)
$data.SetData([System.Windows.Forms.DataFormats]::Bitmap, $image)
$data.SetFileDropList($files)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
$image.Dispose()
`;
  try {
    await run("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-STA", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20000 });
  } catch (cause) {
    const stderr = cause?.stderr ? String(cause.stderr).trim().split(/\r?\n/).at(-1) : "";
    throw Error(stderr || cause?.message || "系统剪贴板写入失败");
  }
}

function headers(origin) {
  return {
    "cache-control": "no-store",
    "access-control-allow-origin": origin || "http://127.0.0.1:5173",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    vary: "Origin",
  };
}

export async function startClipboardImageServer() {
  if (process.platform !== "win32") return;
  try {
    const existing = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(800) });
    const body = await existing.json();
    if (body.service !== "frameflow-clipboard-image-v1") throw Error(`${PORT}端口被其他服务占用`);
    return;
  } catch (error) {
    if (error.message === `${PORT}端口被其他服务占用`) throw error;
  }
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin ?? "";
    const send = (status, text, type = "text/plain; charset=utf-8") => {
      response.writeHead(status, { ...headers(origin), "content-type": type });
      response.end(text);
    };
    if (!allowedOrigin(origin)) return send(403, "仅限本机画布复制图片");
    if (request.method === "OPTIONS") return send(204, "");
    if (request.method === "GET" && (request.url === "/" || request.url === "")) return send(200, JSON.stringify({ service: "frameflow-clipboard-image-v1" }), "application/json; charset=utf-8");
    if (request.method !== "POST" || request.url !== "/image") return send(404, "未知复制接口");
    try {
      await setWindowsClipboardPng(await readBody(request));
      send(204, "");
    } catch (cause) {
      send(400, cause instanceof Error ? cause.message : "系统剪贴板写入失败");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
  server.unref();
  return server;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/clipboard-image-server.mjs")) {
  const server = await startClipboardImageServer();
  server?.ref();
}
