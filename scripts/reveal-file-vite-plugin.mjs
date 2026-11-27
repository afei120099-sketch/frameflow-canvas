import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 右键「打开所在文件夹」：浏览器开不了资源管理器，开发服务器替它开，并选中这个文件。
 * 只认本机同源画布；只接受白名单目录里真实存在的普通文件；只启动 explorer.exe（execFile + 参数数组，不走 shell）。
 * 不读文件内容、不写任何文件、不碰收件箱和 ComfyUI。
 *
 * POST /__file/reveal
 *   body {path:"C:\\…\\a.mp4"}                                   已知完整路径
 *   body {files:[{filename, subfolder?, type?}], fileSize?}       ComfyUI 素材记录：按顺序试，subfolder 不知道时在 output / input 里按文件名找
 *  → 200 {ok:true, path}
 *  → 4xx {ok:false, error}   error 是给用户看的中文
 *
 * POST /__file/locate（右键「复制视频清单」用）：只查本机路径，绝不打开资源管理器。
 *   body {items:[RevealRequest | null, …]}   一次最多 500 条，每条和 /__file/reveal 的请求体一样
 *  → 200 {ok:true, paths:[string | null, …]}   和 items 一一对应，找不到 / 不在白名单 / 线索不对的是 null
 */
export const REVEAL_FILE_ROUTE = '/__file/reveal';
export const LOCATE_FILE_ROUTE = '/__file/locate';
export const LOCATE_MAX_ITEMS = 500;

/** ComfyUI 根目录：和 audio-extract / media-trash 用的是同一套便携版；换了位置设 FRAMEFLOW_COMFYUI_ROOT。 */
export const DEFAULT_COMFYUI_ROOT = 'C:\\ComfyUI_windows_portable\\ComfyUI';
export function comfyRoot(env = process.env) {
  return path.win32.normalize(env.FRAMEFLOW_COMFYUI_ROOT || DEFAULT_COMFYUI_ROOT);
}

/** 允许打开的目录。键是给用户看的名字。 */
export function allowedRoots(env = process.env) {
  const root = comfyRoot(env);
  return [
    { name: 'ComfyUI output', dir: path.win32.join(root, 'output') },
    { name: 'ComfyUI input', dir: path.win32.join(root, 'input') },
    // 画布数据目录（inbox-server.mjs 的收件箱默认在它下面的 inbox）
    { name: '画布数据目录', dir: path.win32.resolve(env.FRAMEFLOW_DESKTOP_CANVAS_ROOT || env.FRAMEFLOW_DATA_ROOT || 'data') },
    // 可选：额外允许打开的目录，分号分隔
    ...String(env.FRAMEFLOW_EXTRA_REVEAL_ROOTS || '').split(';').map((item) => item.trim()).filter(Boolean).map((dir) => ({ name: dir, dir: path.win32.normalize(dir) })),
  ];
}

const lower = (value) => value.toLowerCase().replace(/[\\]+$/, '');
/** file 在 dir 里面（不分大小写，不能等于 dir 本身）。 */
export const isInside = (file, dir) => lower(file).startsWith(lower(dir) + '\\');

const QUOTES = /^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g;
export function normalizeLocalPath(raw) {
  if (typeof raw !== 'string') return { error: '没收到路径' };
  let value = raw.replace(/^\uFEFF/, '').trim().replace(QUOTES, '').trim();
  if (/^file:\/\/\//i.test(value)) { try { value = decodeURIComponent(value.replace(/^file:\/\/\//i, '')); } catch { /* keep */ } }
  if (!value) return { error: '没收到路径' };
  if (/[\r\n"\x00]/.test(value)) return { error: `路径里有不该出现的字符：${value}` };
  value = value.replace(/\//g, '\\');
  if (/^\\\\/.test(value)) return { error: `这不是本机路径（网络共享）：${value}` };
  if (/^(blob:|data:|https?:|media:|audio:|video:|image:|idb:)/i.test(value) || !/^[A-Za-z]:\\/.test(value)) return { error: `这不是本机路径：${value}` };
  return { path: path.win32.normalize(value) };
}

const SAFE_NAME = /^[^\\/:*?"<>|\x00-\x1f]+$/;
const safeName = (name) => typeof name === 'string' && SAFE_NAME.test(name) && name !== '.' && name !== '..';
const safeSubfolder = (sub) => sub === '' || (typeof sub === 'string' && sub.split(/[\\/]/).every(safeName));

/** ComfyUI 的 {filename, subfolder, type} → 本机完整路径；subfolder 不知道（undefined）时返回 null，要靠搜索。 */
export function comfyFilePath(file, env = process.env) {
  if (!file || !safeName(file.filename)) return { error: `文件名不对：${file?.filename ?? '（空）'}` };
  const type = file.type ?? 'output';
  if (type !== 'output' && type !== 'input') return { error: `ComfyUI 的「${type}」目录不在允许打开的范围（只开 output / input）` };
  if (file.subfolder === undefined) return { path: null, type };
  if (!safeSubfolder(file.subfolder)) return { error: `子目录不对：${file.subfolder}` };
  return { path: path.win32.join(comfyRoot(env), type, ...String(file.subfolder).split(/[\\/]/).filter(Boolean), file.filename), type };
}

/** 白名单检查：先按字面，再按真实路径（防链接跳出去）。返回 {path} 或 {status,error}。 */
export async function checkAllowedFile(file, { env = process.env, stat = fs.stat, realpath = fs.realpath } = {}) {
  const roots = allowedRoots(env);
  const why = () => `这个文件不在允许打开的目录里：${file}\n只能打开这些目录里的文件：${roots.map((r) => r.dir).join('、')}`;
  if (!roots.some((r) => isInside(file, r.dir))) return { status: 403, error: why() };
  let info;
  try { info = await stat(file); } catch (cause) {
    if (cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR') return { status: 404, error: `文件不存在：${file}\n可能被移走、改名或删掉了。` };
    return { status: 403, error: `读不到这个文件（${cause?.code ?? cause?.message}）：${file}` };
  }
  if (!info.isFile()) return { status: 400, error: `这不是一个文件：${file}` };
  let real = file;
  try { real = path.win32.normalize(await realpath(file)); } catch { /* 拿不到真实路径就用字面路径 */ }
  if (!roots.some((r) => isInside(real, r.dir))) return { status: 403, error: why() };
  return { path: file, size: info.size };
}

/** 在 dir 下（最多 depth 层）找叫 filename 的文件；有 fileSize 时优先同大小的。跳过链接目录。 */
export async function findByName(dir, filename, { depth = 3, fileSize, readdir = fs.readdir, stat = fs.stat } = {}) {
  const hits = [];
  const want = filename.toLowerCase();
  const walk = async (current, level) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink?.()) continue;
      const full = path.win32.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === want) hits.push(full);
      else if (entry.isDirectory() && level < depth) await walk(full, level + 1);
    }
  };
  await walk(dir, 1);
  if (hits.length > 1 && fileSize) {
    for (const hit of hits) { try { if ((await stat(hit)).size === fileSize) return hit; } catch { /* next */ } }
  }
  return hits[0] ?? null;
}

/** 请求体 → 要选中的本机文件。返回 {ok:true,path} 或 {ok:false,status,error}。 */
export async function resolveRevealTarget(body, deps = {}) {
  const env = deps.env ?? process.env;
  if (body && typeof body.path === 'string') {
    const normalized = normalizeLocalPath(body.path);
    if (normalized.error) return { ok: false, status: 400, error: normalized.error };
    const checked = await checkAllowedFile(normalized.path, { ...deps, env });
    return checked.error ? { ok: false, status: checked.status, error: checked.error } : { ok: true, path: checked.path };
  }
  const files = Array.isArray(body?.files) ? body.files.slice(0, 8) : [];
  if (!files.length) return { ok: false, status: 400, error: '这个文件只存在画布里，没有本机路径' };
  let lastError = null; const tried = [];
  for (const file of files) {
    const target = comfyFilePath(file, env);
    if (target.error) { lastError = { status: 400, error: target.error }; continue; }
    if (target.path) {
      tried.push(target.path);
      const checked = await checkAllowedFile(target.path, { ...deps, env });
      if (!checked.error) return { ok: true, path: checked.path };
      lastError = checked;
      continue;
    }
    // 不知道子目录：output（或 input）里按文件名找
    const order = target.type === 'input' ? ['input'] : ['output', 'input'];
    for (const type of order) {
      const dir = path.win32.join(comfyRoot(env), type);
      tried.push(`${dir}\\…\\${file.filename}`);
      const hit = await findByName(dir, file.filename, { fileSize: body?.fileSize, readdir: deps.readdir, stat: deps.stat });
      if (!hit) continue;
      const checked = await checkAllowedFile(hit, { ...deps, env });
      if (!checked.error) return { ok: true, path: checked.path };
      lastError = checked;
    }
  }
  if (lastError && lastError.status !== 404) return { ok: false, status: lastError.status, error: lastError.error };
  return { ok: false, status: 404, error: `本机找不到这个文件（可能被移走、改名或删掉了；也可能它只存在画布里）。\n找过：${tried.join('；')}` };
}

/**
 * 启动 explorer.exe 并选中文件。execFile + 参数数组，不经过 shell。
 * explorer 的 /select 要求「/select,"完整路径"」写在同一个参数里，所以用 windowsVerbatimArguments 原样传；
 * 路径已经检查过：存在、在白名单里、不含引号和换行。explorer 正常也会返回退出码 1，只把「没启动起来」当失败。
 */
export function launchExplorer(file, run = execFile) {
  return new Promise((resolve) => {
    run('explorer.exe', [`/select,"${file}"`], { windowsHide: false, windowsVerbatimArguments: true, timeout: 15000 }, (error) => {
      if (error && typeof error.code === 'string') resolve({ ok: false, error: `打不开资源管理器（${error.code}）` });
      else resolve({ ok: true });
    });
  });
}

export async function revealFile(body, deps = {}) {
  const target = await resolveRevealTarget(body, deps);
  if (!target.ok) return target;
  const launched = await (deps.launch ?? launchExplorer)(target.path);
  if (!launched.ok) return { ok: false, status: 500, error: launched.error };
  return { ok: true, path: target.path };
}

/**
 * 一次查多条，只返回路径，不启动任何程序（不调用 launchExplorer / deps.launch）。
 * 同一批里按文件名搜目录时，读过的目录记下来不再读（几十个视频都在 output\video 里）。
 */
export async function locateFiles(body, deps = {}) {
  const items = body?.items;
  if (!Array.isArray(items)) return { ok: false, status: 400, error: '没收到要查的文件（items）' };
  if (items.length > LOCATE_MAX_ITEMS) return { ok: false, status: 413, error: `一次最多查 ${LOCATE_MAX_ITEMS} 个文件` };
  const baseReaddir = deps.readdir ?? fs.readdir;
  const listed = new Map();
  const readdir = (dir, options) => {
    const key = lower(dir);
    if (!listed.has(key)) listed.set(key, baseReaddir(dir, options));
    return listed.get(key);
  };
  // 只挑查路径要用的依赖传下去，deps.launch 不往下传
  const lookupDeps = { env: deps.env, stat: deps.stat, realpath: deps.realpath, readdir };
  const paths = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') { paths.push(null); continue; }
    let target = null;
    try { target = await resolveRevealTarget(item, lookupDeps); } catch { target = null; }
    paths.push(target?.ok ? target.path : null);
  }
  return { ok: true, paths };
}

export function revealFilePlugin(deps = {}) {
  return {
    name: 'frameflow-reveal-file',
    configureServer(server) { server.middlewares.use(revealFileMiddleware(deps)); },
  };
}

export function revealFileMiddleware(deps = {}) {
  return async (req, res, next) => {
    const route = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (route !== REVEAL_FILE_ROUTE && route !== LOCATE_FILE_ROUTE) return next();
    const locate = route === LOCATE_FILE_ROUTE;
    // 查路径一次最多 500 条，请求体比打开单个文件大
    const maxBytes = locate ? 512 * 1024 : 16384;
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) || req.headers.origin !== `http://${host}`) return json(403, { ok: false, error: '仅限本机画布' });
    if (req.method !== 'POST') return json(405, { ok: false, error: '仅支持 POST' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > maxBytes) return json(413, { ok: false, error: '请求太长' }); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { ok: false, error: '请求不是 JSON' }); }
      const result = locate ? await locateFiles(body, deps) : await revealFile(body, deps);
      if (!result.ok) return json(result.status ?? 400, { ok: false, error: result.error });
      return json(200, result);
    } catch (cause) { return json(500, { ok: false, error: `${locate ? '查找' : '打开'}失败：${cause?.message ?? cause}` }); }
  };
}
