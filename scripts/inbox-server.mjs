// Frameflow inbox helper: loopback-only file access for <FRAMEFLOW_INBOX_ROOT>\<project>\ (default ./data/inbox).
// The app runs in a worker without fs, so app/api/inbox/route.ts proxies here (same pattern as media-trash on 5189).
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {durableJson,parseJsonBytes,byteHash} from './durable-json.mjs';
import {handleZhengbenOp} from './zhengben-helper.mjs';

// Blue-green local upgrade: leave the legacy 5191 process untouched.
export const INBOX_PORT = Number(process.env.FRAMEFLOW_INBOX_PORT || 5193);
export const INBOX_REVISION = 'inbox-asset-ai-20261113';
const DATA_ROOT = path.resolve(process.env.FRAMEFLOW_DATA_ROOT || 'data');
export const INBOX_ROOT = process.env.FRAMEFLOW_INBOX_ROOT || path.join(DATA_ROOT, 'inbox');
export const SNAPSHOT_ROOT = process.env.FRAMEFLOW_SNAPSHOT_ROOT || path.join(DATA_ROOT, 'snapshots');
const SNAPSHOT_KEEP = 30;
const SNAPSHOT_MAX_BYTES = 50_000_000;
const CLAIM_PORT = Number(process.env.FRAMEFLOW_CLAIM_PORT || 8791);
const SERVICE = 'frameflow-inbox-v1';
const IMAGE = /\.(png|jpe?g|webp)$/i;
const WRITABLE = /^(assets_map\.json|_inbox_state\.json|.+_status\.json)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', json: 'application/json; charset=utf-8' };
const safe = (name) => typeof name === 'string' && name.length > 0 && name.length < 200 && !/[\\/:*?"<>|]/.test(name) && name !== '.' && name !== '..';

// Claim gate used by shot-queue-panel autoSubmit (http://127.0.0.1:8791/claim, one-shot "ok").
// If the existing frameflow-beacon owns 8791 we re-arm it with /reset; otherwise we serve the same protocol ourselves.
const ALLOWED_CANVAS_PORTS = [5173, 5174, 5175, 5176, 5177];
const ALLOWED_CANVAS_ORIGINS = new Set(ALLOWED_CANVAS_PORTS.flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]));


/** 主端口（5193）POST 防跨站写：拦截带非白名单 Origin 或跨站 Sec-Fetch-Site 的浏览器请求，放行无头本机工具与 Next 代理。 */
function isAllowedInboxPost(req) {
  const origin = req.headers.origin;
  const secFetchSite = req.headers['sec-fetch-site'];
  if (origin && !ALLOWED_CANVAS_ORIGINS.has(origin)) return false;
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'same-site') return false;
  return true;
}

let ownClaim = null; let claimed = true;
async function ensureClaimGate() {
  try { await fetch(`http://127.0.0.1:${CLAIM_PORT}/reset`, { signal: AbortSignal.timeout(800) }); return 'beacon'; } catch { /* not running */ }
  if (!ownClaim) {
    ownClaim = createServer((req, res) => {
      const origin = req.headers.origin;
      if (origin) {
        if (!ALLOWED_CANVAS_ORIGINS.has(origin)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden origin'); }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'content-type');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.url === '/reset') { claimed = false; res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('reset'); }
      if (req.url === '/claim') { const a = claimed ? 'no' : (claimed = true, 'ok'); res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(a); }
      req.resume(); res.writeHead(204); res.end();
    });
    await new Promise((resolve, reject) => { ownClaim.once('error', reject); ownClaim.listen(CLAIM_PORT, '127.0.0.1', resolve); }).catch((e) => { ownClaim = null; throw e; });
    ownClaim.unref();
  }
  claimed = false; return 'own';
}

function formatSnapshotTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function snapshotContentHash(parsed, rawBuffer) {
  if (parsed && typeof parsed.contentSha256 === 'string' && /^[a-f0-9]{64}$/i.test(parsed.contentSha256)) {
    return parsed.contentSha256.toLowerCase();
  }
  if (parsed && parsed.files && typeof parsed.files === 'object') {
    const h = createHash('sha256');
    for (const key of Object.keys(parsed.files).sort()) {
      if (key === 'manifest.json') continue;
      h.update(key);
      h.update('\0');
      h.update(String(parsed.files[key] ?? ''));
      h.update('\0');
    }
    return h.digest('hex');
  }
  return createHash('sha256').update(rawBuffer).digest('hex');
}

async function writeFileAtomicSync(target, buffer) {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  let fh;
  try {
    fh = await fs.open(tmp, 'w');
    await fh.writeFile(buffer);
    await fh.sync();
    await fh.close();
    fh = null;
    await fs.rename(tmp, target);
  } catch (error) {
    if (fh) await fh.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

async function saveDiskSnapshot(canvasPort, rawBuffer) {
  const portKey = /^\d{2,5}$/.test(String(canvasPort || '')) ? String(canvasPort) : '5173';
  const parsed = JSON.parse(rawBuffer.toString('utf8'));
  const incomingHash = snapshotContentHash(parsed, rawBuffer);
  const dir = path.join(SNAPSHOT_ROOT, portKey);
  await fs.mkdir(dir, { recursive: true });
  const existing = (await fs.readdir(dir).catch(() => []))
    .filter((n) => /^snapshot-\d{8}-\d{6}\.json$/i.test(n))
    .sort()
    .reverse();
  if (existing.length > 0) {
    const latestName = existing[0];
    try {
      const latestRaw = await fs.readFile(path.join(dir, latestName));
      const latestParsed = JSON.parse(latestRaw.toString('utf8'));
      if (snapshotContentHash(latestParsed, latestRaw) === incomingHash) {
        return { ok: true, unchanged: true, file: latestName, dir };
      }
    } catch {
      // 最新文件损坏时继续写入新快照
    }
  }
  const filename = `snapshot-${formatSnapshotTimestamp()}.json`;
  const target = path.join(dir, filename);
  await writeFileAtomicSync(target, rawBuffer);
  const all = (await fs.readdir(dir).catch(() => []))
    .filter((n) => /^snapshot-\d{8}-\d{6}\.json$/i.test(n))
    .sort()
    .reverse();
  const removed = [];
  for (const old of all.slice(SNAPSHOT_KEEP)) {
    await fs.unlink(path.join(dir, old)).catch(() => {});
    removed.push(old);
  }
  return { ok: true, unchanged: false, file: filename, dir, removed };
}


const SNAPSHOT_FILE_RE = /^snapshot-\d{8}-\d{6}\.json$/i;


async function listDiskSnapshots(canvasPort) {
  const portKey = /^\d{2,5}$/.test(String(canvasPort || '')) ? String(canvasPort) : '5173';
  const dir = path.resolve(SNAPSHOT_ROOT, portKey);
  const names = (await fs.readdir(dir).catch(() => []))
    .filter((n) => SNAPSHOT_FILE_RE.test(n))
    .sort()
    .reverse()
    .slice(0, SNAPSHOT_KEEP);
  const snapshots = [];
  for (const file of names) {
    const target = path.resolve(dir, file);
    if (!target.startsWith(dir + path.sep)) continue;
    const st = await fs.lstat(target).catch(() => null);
    if (!st || !st.isFile() || st.isSymbolicLink()) continue;
    snapshots.push({ file, mtime: st.mtimeMs, createdAt: new Date(st.mtimeMs).toISOString(), size: st.size });
  }
  return { ok: true, port: portKey, dir, snapshots };
}


async function readDiskSnapshot(canvasPort, file) {
  const portKey = /^\d{2,5}$/.test(String(canvasPort || '')) ? String(canvasPort) : '5173';
  if (typeof file !== 'string' || !SNAPSHOT_FILE_RE.test(file)) {
    const err = new Error('快照文件名不合法，仅允许读取 snapshot-YYYYMMDD-HHMMSS.json');
    err.statusCode = 400;
    throw err;
  }
  const dir = path.resolve(SNAPSHOT_ROOT, portKey);
  const target = path.resolve(dir, file);
  if (!target.startsWith(dir + path.sep)) {
    const err = new Error('禁止跨目录读取快照');
    err.statusCode = 400;
    throw err;
  }
  const st = await fs.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') {
      const notFound = new Error('找不到指定的硬盘快照');
      notFound.statusCode = 404;
      throw notFound;
    }
    throw error;
  });
  if (!st.isFile() || st.isSymbolicLink()) {
    const err = new Error('快照路径不安全');
    err.statusCode = 400;
    throw err;
  }
  const raw = await fs.readFile(target, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    const err = new Error('硬盘快照内容损坏（缺少 files 映射）');
    err.statusCode = 422;
    throw err;
  }
  return parsed;
}

async function listProject(project,root=INBOX_ROOT) {
  const dir = path.join(root, project);
  const names = await fs.readdir(dir).catch(() => []);
  const files = [];
  for (const name of names) {
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (!st?.isFile()) continue;
    // Generated reports retain their source suffix. Classify the reserved report
    // prefix first so a report can never become another validation/render input.
    // Keep it listed/readable, including legacy nested reports; never delete it.
    const kind = /^_compiled_.*\.json$/i.test(name) ? 'report' : IMAGE.test(name) ? 'image' : /_(queue|validate)\.json$/i.test(name) ? 'queue' : name === 'assets_map.json' ? 'map' : /_status\.json$/i.test(name) ? 'status' : name === '_inbox_state.json' ? 'state' : 'other';
    const sha256 = kind === 'image' || kind === 'queue' ? createHash('sha256').update(await fs.readFile(path.join(dir, name))).digest('hex') : undefined;
    files.push({ name, kind, size: st.size, mtime: st.mtimeMs, ...(sha256 ? { sha256 } : {}) });
  }
  return files;
}

export async function startInboxServer({port=INBOX_PORT,root=INBOX_ROOT}={}) {
  try {
    const existing = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    if ((await existing.json()).service !== SERVICE) throw Error(`${port}端口被其他程序占用`);
    return;
  } catch (error) { if (String(error.message).includes('端口被其他程序占用')) throw error; }
  await fs.mkdir(root, { recursive: true });
  const server = createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': MIME.json, 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'POST' && !isAllowedInboxPost(req)) {
        req.resume();
        return json(403, { error: '禁止跨站或非白名单来源写入收件箱' });
      }
      const url = new URL(req.url, 'http://localhost');
      const project = url.searchParams.get('project'); const name = url.searchParams.get('name');
      const op = url.searchParams.get('op') ?? '';
      if (req.method === 'GET' && !op) return json(200, { service: SERVICE, revision:INBOX_REVISION, root });
      if (req.method === 'GET' && op === 'projects') {
        const names = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        return json(200, { root, projects: names.filter((d) => d.isDirectory()).map((d) => d.name) });
      }
      // Dedicated export channel: only two manifests and UUID-named JPEGs.
      if (op === 'asset-ai-write') {
        if (req.method !== 'POST') return json(405, { error: '仅支持 POST' });
        const thumbnail = url.searchParams.get('thumbnail') === '1';
        if (thumbnail ? !/^[a-f0-9-]{36}\.jpg$/i.test(name ?? '') : !['素材清单.md', '素材清单.json'].includes(name)) return json(400, { error: '导出文件名不合法' });
        const base = path.join(root, '_素材库给AI');
        for (const dir of [base, ...(thumbnail ? [path.join(base, '缩略图')] : [])]) {
          await fs.mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error; });
          const st = await fs.lstat(dir);
          if (!st.isDirectory() || st.isSymbolicLink()) return json(400, { error: '导出路径不安全' });
        }
        const file = path.join(thumbnail ? path.join(base, '缩略图') : base, name);
        const existing = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (existing && (!existing.isFile() || existing.isSymbolicLink())) return json(400, { error: '导出路径不安全' });
        const chunks = []; let size = 0; const max = thumbnail ? 2_000_000 : 20_000_000;
        for await (const chunk of req) { size += chunk.length; if (size > max) return json(413, { error: '导出文件过大' }); chunks.push(chunk); }
        const body = Buffer.concat(chunks);
        if (thumbnail && (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8)) return json(400, { error: '缩略图不是 JPEG' });
        if (!thumbnail && name.endsWith('.json')) JSON.parse(body.toString('utf8'));
        if (thumbnail && existing && (await fs.readFile(file)).equals(body)) return json(200, { ok: true, unchanged: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        let fh;
        try {
          fh = await fs.open(tmp, 'w');
          await fh.writeFile(body);
          await fh.sync();
          await fh.close();
          fh = null;
          await fs.rename(tmp, file);
        } catch (writeErr) {
          if (fh) await fh.close().catch(() => {});
          await fs.unlink(tmp).catch(() => {});
          throw writeErr;
        }
        return json(200, { ok: true });
      }
      // Root role channel: `_roles.json` / `_roles_status.json` next to `_control.json`.
      if (op === 'root-file' || op === 'root-write') {
        if (!safe(name) || (name !== '_roles.json' && name !== '_roles_status.json')) return json(400, { error: '根目录角色通道只允许 _roles.json / _roles_status.json' });
        if (op === 'root-write') {
          if (req.method !== 'POST') return json(405, { error: 'root-write 仅支持 POST' });
          if (name !== '_roles_status.json') return json(400, { error: '根目录角色通道只允许写 _roles_status.json' });
          const chunks = []; for await (const c of req) chunks.push(c);
          const body = Buffer.concat(chunks); if (body.length > 5_000_000) return json(413, { error: '太大' });
          JSON.parse(body.toString('utf8'));
          const file = path.join(root, name);
          await durableJson(file,body);
          return json(200, { ok: true });
        }
        if (req.method !== 'GET') return json(405, { error: 'root-file 仅支持 GET' });
        const data = await fs.readFile(path.join(root, name)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!data) return json(404, { error: '没有该文件' });
        res.writeHead(200, { 'Content-Type': MIME.json, 'Cache-Control': 'no-store' });
        return res.end(data);
      }
      // 正本接口：版本号、词库、h3q check（只读正本，见 zhengben-helper.mjs）。
      if (op.startsWith('zhengben-') && await handleZhengbenOp(op, req, json, { inboxRoot: root })) return;
      // 硬盘定时快照列表：列出最近 30 份（文件名、时间、大小）。
      if (url.pathname === '/snapshots' || op === 'snapshots') {
        if (req.method !== 'GET') return json(405, { error: 'snapshots 仅支持 GET' });
        const canvasPort = url.searchParams.get('port') || '5173';
        return json(200, await listDiskSnapshots(canvasPort));
      }
      // 硬盘定时快照：GET 读单份（防路径穿越）；POST 写 .tmp -> fsync -> rename，仅保留最新 30 份。
      if (url.pathname === '/snapshot' || op === 'snapshot') {
        const canvasPort = url.searchParams.get('port') || '5173';
        if (req.method === 'GET') {
          try {
            const file = url.searchParams.get('file') ?? '';
            return json(200, await readDiskSnapshot(canvasPort, file));
          } catch (error) {
            return json(error?.statusCode || 400, { error: error?.message || '读取快照失败' });
          }
        }
        if (req.method !== 'POST') return json(405, { error: 'snapshot 仅支持 GET / POST' });
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > SNAPSHOT_MAX_BYTES) return json(413, { error: '快照过大' }); chunks.push(c); }
        const body = Buffer.concat(chunks);
        return json(200, await saveDiskSnapshot(canvasPort, body));
      }
      if (!safe(project)) return json(400, { error: 'project 不合法' });
      if(req.method==='POST'&&op==='restore-state'){
        const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);if(body.length>4096)return json(413,{error:'恢复命令过大'});
        const command=parseJsonBytes(body),backupName=command.backupName;
        if(!safe(backupName)||!backupName.startsWith('_inbox_state.json.bak_'))return json(400,{error:'只接受本项目已有的状态备份文件名'});
        const dir=path.join(root,project),file=path.join(dir,'_inbox_state.json'),current=await fs.readFile(file),backup=await fs.readFile(path.join(dir,backupName));
        if(byteHash(backup)!==command.expectedBackupSha256||byteHash(current)!==command.expectedCorruptSha256)return json(409,{error:'原文件或备份哈希变化，未恢复'});
        let corrupt=false;try{parseJsonBytes(current);}catch{corrupt=true;}if(!corrupt)return json(409,{error:'原状态仍有效，不使用旧备份覆盖'});
        const restored=parseJsonBytes(backup);if(!restored||typeof restored.images!=='object'||!restored.images||typeof restored.queues!=='object'||!restored.queues||Array.isArray(restored.queues)||Array.isArray(restored.images))return json(400,{error:'备份不是合法收件箱状态'});
        const controlFile=path.join(dir,'_inbox_control.json'),oldControl=await fs.readFile(controlFile).then(parseJsonBytes).catch(error=>{if(error.code==='ENOENT')return {};throw error;});
        const files=await listProject(project,root),hashes=files.filter(f=>f.kind==='queue').map(f=>f.sha256);
        // Historical receipts are snapshots, never authority to restart old versions.
        await durableJson(controlFile,{...oldControl,paused:true,reason:'状态备份恢复保护：旧文件不自动重放，现有指定会话通过原记录恢复',heldQueueHashes:[...new Set([...(oldControl.heldQueueHashes??[]),...hashes])]}, {backup:true});
        const result=await durableJson(file,backup,{backup:true,requireValidCurrent:true,allowCorruptReplace:true,expectedCurrentSha256:command.expectedCorruptSha256});
        const receipt={state:'restored_held',project,backupName,originalSha256:command.expectedCorruptSha256,...result,restoredAt:new Date().toISOString(),protectedQueueHashes:hashes,previousControl:oldControl,note:'原损坏字节已保留；恢复不提交GPU，不重放旧队列。'};
        await durableJson(path.join(dir,'_state_recovery_status.json'),receipt,{backup:true});return json(200,receipt);
      }
      if (req.method === 'GET' && op === 'list') return json(200, { project, files: await listProject(project,root) });
      if (req.method === 'GET' && op === 'file') {
        if (!safe(name)) return json(400, { error: 'name 不合法' });
        const data = await fs.readFile(path.join(root, project, name));
        res.writeHead(200, { 'Content-Type': MIME[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        return res.end(data);
      }
      if (req.method === 'POST' && op === 'write') {
        if (!safe(name) || !WRITABLE.test(name)) return json(400, { error: '只允许写 assets_map.json / *_status.json / _inbox_state.json' });
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks); if (body.length > 5_000_000) return json(413, { error: '太大' });
        const value=JSON.parse(body.toString('utf8'));
        if(name.endsWith('_status.json')&&typeof value?.queue==='string'&&typeof value?.contentHash==='string'){
          if(!safe(value.queue)||name!==value.queue.replace(/\.json$/i,'_status.json'))return json(400,{error:'状态与源队列文件名不匹配'});
          const current=await fs.readFile(path.join(root,project,value.queue)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
          if(current&&createHash('sha256').update(current).digest('hex')!==value.contentHash)return json(409,{error:'源文件已覆盖，拒绝旧内容写回状态'});
        }
        const file = path.join(root, project, name);
        if(name.endsWith('_status.json')&&value?.contentHash&&value?.updatedAt){
          const previous=await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>null);
          if(previous?.contentHash===value.contentHash&&Date.parse(previous.updatedAt)>Date.parse(value.updatedAt))return json(409,{error:'拒绝过期状态回写'});
        }
        if(name==='_inbox_state.json'&&(!value||!value.images||!value.queues||Array.isArray(value.images)||Array.isArray(value.queues)||typeof value.images!=='object'||typeof value.queues!=='object'))return json(400,{error:'收件箱状态必须保留images和queues映射'});
        const saved=await durableJson(file,body,{backup:name==='_inbox_state.json',requireValidCurrent:name==='_inbox_state.json'});
        return json(200, { ok: true, ...saved });
      }
      if (req.method === 'POST' && op === 'arm-claim') return json(200, { ok: true, gate: await ensureClaimGate() });
      return json(404, { error: '未知操作' });
    } catch (error) { json(409, { error: error.message || '操作失败' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  server.unref();
  return server;
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/inbox-server.mjs')) {
  const server = await startInboxServer();
  server?.ref();
  console.log(`inbox helper on 127.0.0.1:${INBOX_PORT}, root ${INBOX_ROOT}`);
}
