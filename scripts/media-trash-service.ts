import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, mkdir, writeFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
/** ComfyUI output folder; set FRAMEFLOW_COMFYUI_ROOT to your ComfyUI directory. */
export const COMFY_OUTPUT_DIR = path.join(process.env.FRAMEFLOW_COMFYUI_ROOT || 'C:/ComfyUI_windows_portable/ComfyUI', 'output');
const OUTPUT = COMFY_OUTPUT_DIR;
const STAGING = path.resolve(process.cwd(), 'runtime/media-recycle');
const MAX_BYTES = 256 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
/** Dev canvas may run on 5173/5177/etc. Any http(s) localhost origin on this machine is allowed. */
export function isLocalDevOrigin(origin: string | null) {
  if (!origin) return true;
  try {
    const from = new URL(origin);
    return (from.protocol === 'http:' || from.protocol === 'https:') && LOCAL_HOSTS.has(from.hostname);
  } catch {
    return false;
  }
}
export function assertLocalTrashRequest(request: Request) {
  const url = new URL(request.url);
  if (!LOCAL_HOSTS.has(url.hostname)) throw Error('仅限本机调用');
  if (request.method === 'POST' && (request.headers.get('x-frameflow-action') !== 'recycle' || !isLocalDevOrigin(request.headers.get('origin')))) throw Error('禁止跨站清理请求');
}
export async function assertTrashQueueIdle() {
  const response = await fetch('http://127.0.0.1:8188/queue', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('无法确认 ComfyUI 状态，未清理');
  const queue = await response.json() as {queue_running?: unknown[]; queue_pending?: unknown[]};
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw Error('队列状态无效，未清理');
  if (queue.queue_running.length || queue.queue_pending.length) throw Error('仍有渲染或排队任务，请全部结束后再清理文件');
}
export async function checkedMediaPath(root: string, relative: string) {
  if (!relative || path.isAbsolute(relative) || /(^|[\\/])\.\.([\\/]|$)|[:\x00]/.test(relative)) throw Error('文件路径不安全');
  const target = path.resolve(root, relative);
  const resolvedRoot = await realpath(root);
  if (!target.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)) throw Error('文件越界');
  let cursor = path.resolve(root);
  if ((await lstat(cursor)).isSymbolicLink()) throw Error('不处理链接目录');
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw Error('不处理链接文件或目录');
  }
  const canonical = await realpath(target);
  if (!canonical.toLowerCase().startsWith(resolvedRoot.toLowerCase() + path.sep) || !(await lstat(target)).isFile()) throw Error('文件不是安全的普通文件');
  if (!/\.(png|jpe?g|webp|mp4|webm|wav|mp3|m4a|flac|ogg)$/i.test(target)) throw Error('只允许媒体文件');
  return canonical;
}
export async function recycleWindowsFile(target: string) {
  if (process.platform !== 'win32') throw Error('此功能仅支持 Windows 回收站');
  // Silent SHFileOperation (FO_DELETE + ALLOWUNDO). Avoids VB FileIO UI hooks that more often freeze Explorer.
  // Path is base64-only; never interpolated into executable PowerShell.
  const encodedPath = Buffer.from(target, 'utf8').toString('base64');
  const script = `
$ErrorActionPreference='Stop'
$targetPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
if (-not (Test-Path -LiteralPath $targetPath)) { throw 'file missing' }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct SHFILEOPSTRUCT {
  public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo;
  public ushort fFlags; public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
}
public static class FrameflowRecycle {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern int SHFileOperation(ref SHFILEOPSTRUCT fileOp);
}
"@
$op = New-Object SHFILEOPSTRUCT
$op.wFunc = 3
$op.pFrom = $targetPath + [char]0 + [char]0
$op.fFlags = 0x454
$code = [FrameflowRecycle]::SHFileOperation([ref]$op)
if ($code -ne 0 -or $op.fAnyOperationsAborted) { throw ("recycle failed code=" + $code) }
`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 180000 });
  try { await access(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw Error('文件仍在原处，回收站操作未完成');
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fileDigest(filePath: string, expectedBytes: number) {
  // Stream hash so large Comfy outputs are not fully loaded into RAM (which stalls Explorer on the same folder).
  const hash = createHash('sha256');
  let total = 0;
  for await (const chunk of createReadStream(filePath)) {
    total += chunk.byteLength;
    if (total > MAX_BYTES) throw Error('单次清理上限256MB');
    hash.update(chunk);
  }
  if (total !== expectedBytes) throw Error('文件大小已变化，未清理');
  return hash.digest('hex');
}
let busy = false;
const MEDIA_FILE = /\.(png|jpe?g|webp|mp4|webm|wav|mp3|m4a|flac|ogg)$/i;
/**
 * A file under `root` (3 levels deep) with exactly `size` bytes and this SHA-256, or ''. Sizes are compared
 * first, so only same-size candidates are hashed. Symlinks are skipped; the result is re-checked to stay in root.
 */
export async function findOutputByContent(size: number, hash: string, root = OUTPUT, depth = 3): Promise<string> {
  if (!size || size > MAX_BYTES) return '';
  const walk = async (dir: string, level: number): Promise<string> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return ''; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (level < depth) { const hit = await walk(full, level + 1); if (hit) return hit; } continue; }
      if (!entry.isFile() || !MEDIA_FILE.test(entry.name)) continue;
      let stats;
      try { stats = await lstat(full); } catch { continue; }
      if (stats.size !== size) continue;
      if (await fileDigest(full, size) === hash) return checkedMediaPath(root, path.relative(root, full));
    }
    return '';
  };
  return walk(root, 1);
}

export async function recycleMediaRequest(request: Request) {
  assertLocalTrashRequest(request);
  if (busy) throw Error('已有清理操作，请稍后');
  if (process.platform !== 'win32') throw Error('此功能仅支持 Windows 回收站');
  busy = true;
  try {
    await assertTrashQueueIdle();
    const url = new URL(request.url);
    const assetId = url.searchParams.get('assetId') ?? '';
    const promptId = url.searchParams.get('promptId');
    const filename = url.searchParams.get('filename') ?? '';
    if (!/^[a-f0-9-]{36}$/i.test(assetId) || (promptId && !/^[a-f0-9-]{36}$/i.test(promptId))) throw Error('素材或任务 ID 无效');
    if (!filename || path.basename(filename) !== filename || /[\\/:]/.test(filename) || !/\.(png|jpe?g|webp|mp4|webm|wav|mp3|m4a|flac|ogg)$/i.test(filename)) throw Error('文件名称无效');
    const chunks: Uint8Array[] = []; let size = 0;
    if (!request.body) throw Error('素材为空');
    const reader = request.body.getReader();
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > MAX_BYTES) throw Error('单次清理上限256MB'); chunks.push(next.value); } }
    finally { reader.releaseLock(); }
    if (!size) throw Error('素材为空');
    const bytes = Buffer.concat(chunks); const hash = digest(bytes);
    let target = ''; let mode = 'browser-copy';
    if (promptId) {
      // Only move Comfy OUTPUT when history is confirmed success + content hash matches.
      // Cancelled / failed / pruned jobs fall back to recycling the canvas browser copy so the node can still be removed.
      const response = await fetch(`http://127.0.0.1:8188/history/${promptId}`, {signal: AbortSignal.timeout(5000)});
      if (response.ok) {
        const entry = (await response.json() as Record<string, {status?: {status_str?: string}; outputs?: unknown}>)[promptId];
        if (entry?.status?.status_str === 'success') {
          const files: {filename: string; subfolder?: string; type?: string}[] = [];
          const walk = (value: unknown) => { if (!value || typeof value !== 'object') return; if ('filename' in value && typeof value.filename === 'string') files.push(value as typeof files[number]); else for (const item of Object.values(value)) walk(item); };
          walk(entry.outputs);
          // Hash, not a user-editable display name, proves this is the same generated file.
          for (const file of files.slice(0, 32)) {
            if (file.type !== 'output' || !/\.(png|jpe?g|webp|mp4|webm|wav|mp3|m4a|flac|ogg)$/i.test(file.filename)) continue;
            const candidate = await checkedMediaPath(OUTPUT, path.join(file.subfolder ?? '', file.filename));
            const stats = await lstat(candidate);
            if (stats.size !== size || stats.size > MAX_BYTES) continue;
            if (await fileDigest(candidate, size) === hash) { target = candidate; mode = 'generated-original'; break; }
          }
        }
      }
    }
    // ComfyUI keeps history in memory only: after a restart (or for files whose history entry differs) look
    // through OUTPUT for the byte-identical file. Same size + same SHA-256 is the proof; names are never used.
    if (!target) {
      const found = await findOutputByContent(size, hash);
      if (found) { target = found; mode = 'generated-original'; }
    }
    const receiptId = randomUUID(); const folder = path.join(STAGING, receiptId);
    await mkdir(folder, { recursive: true });
    if (!target) { target = path.join(folder, filename); await writeFile(target, bytes, {flag: 'wx'}); }
    target = await checkedMediaPath(mode === 'generated-original' ? OUTPUT : STAGING, path.relative(mode === 'generated-original' ? OUTPUT : STAGING, target));
    const receipt = {receiptId, assetId, filename, mode, sha256: hash, bytes: size, originalPath: target, at: new Date().toISOString(), status: 'prepared'};
    await writeFile(path.join(folder, 'receipt.json'), JSON.stringify(receipt, null, 2));
    await assertTrashQueueIdle();
    await recycleWindowsFile(target); // No permanent-delete fallback, even on failure.
    await writeFile(path.join(folder, 'receipt.json'), JSON.stringify({...receipt, status: 'recycled'}, null, 2));
    return {receiptId, mode, bytes: size, recycled: true};
  } finally { busy = false; }
}
