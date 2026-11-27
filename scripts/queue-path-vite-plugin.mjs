import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 「载入路径 JSON 队列」：镜头卡片「换队列 JSON」页底部的路径输入框走这里。
 * 浏览器读不了本机任意路径，所以开发服务器替它读一个文件——只读、只读 .json、只认本机同源画布。
 * 不写任何文件，不入队，不碰收件箱。
 *
 * POST /__queue/read-path  body {"path":"D:\\…\\xxx_queue.json"}
 *  → 200 {ok:true, path, size, text, tableFile?}   text 是文件原文（去掉 BOM），卡片照「载入 JSON 文件」那样填进文本框再检查
 *  → 4xx {ok:false, error}                          error 是给用户看的中文
 */
export const QUEUE_PATH_ROUTE = '/__queue/read-path';
export const QUEUE_PATH_MAX_BYTES = 20 * 1024 * 1024;

const QUOTES = /^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g;

/** 用户粘贴的路径 → 规范的 Windows 绝对路径；不合格时返回 {error}。 */
export function normalizeQueuePath(raw) {
  if (typeof raw !== 'string') return { error: '没收到路径' };
  let value = raw.replace(/^\uFEFF/, '').trim().replace(QUOTES, '').trim();
  if (/^file:\/\/\//i.test(value)) { try { value = decodeURIComponent(value.replace(/^file:\/\/\//i, '')); } catch { /* keep as typed */ } }
  if (!value) return { error: '先粘贴一个 JSON 文件路径' };
  if (/[\r\n]/.test(value)) return { error: '只能放一个路径（一行）' };
  value = value.replace(/\//g, '\\');
  if (/^\\\\/.test(value)) return { error: '不支持网络共享路径（\\\\电脑名\\…），请用盘符开头的本机路径，比如 D:\\…\\xxx_queue.json' };
  if (!/^[A-Za-z]:\\/.test(value)) return { error: `要完整路径（盘符开头，比如 D:\\…\\xxx_queue.json）：${value}` };
  const normalized = path.win32.normalize(value);
  if (!/\.json$/i.test(normalized)) return { error: `只能载入 .json 文件：${normalized}` };
  return { path: normalized };
}

/** 队列旁同名对照表：xxx_queue.json → xxx_queue_对照表.md（和正本 h3q 找的名字一样）。 */
export const siblingTablePath = (file) => file.replace(/\.json$/i, '_对照表.md');

const SAY = {
  ENOENT: (file) => `文件不存在：${file}\n检查一下路径有没有打错，或者文件是不是被移走 / 改名了。`,
  ENOTDIR: (file) => `路径里有一段不是文件夹：${file}`,
  EACCES: (file) => `没有权限读这个文件：${file}`,
  EPERM: (file) => `没有权限读这个文件：${file}`,
  EBUSY: (file) => `文件正被别的程序占着（比如网盘正在同步），等一下再试：${file}`,
  EISDIR: (file) => `这是一个文件夹，不是 .json 文件：${file}`,
};
const fsError = (cause, file) => (SAY[cause?.code]?.(file)) ?? `读不了这个文件（${cause?.code ?? cause?.message ?? '未知原因'}）：${file}`;

/** 只读一个队列文件。返回 {ok:true,…} 或 {ok:false,status,error}。 */
export async function readQueueFromPath(raw, { maxBytes = QUEUE_PATH_MAX_BYTES } = {}) {
  const normalized = normalizeQueuePath(raw);
  if (normalized.error) return { ok: false, status: 400, error: normalized.error };
  const file = normalized.path;
  let info;
  try { info = await fs.stat(file); } catch (cause) { return { ok: false, status: cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR' ? 404 : 403, error: fsError(cause, file) }; }
  if (info.isDirectory()) return { ok: false, status: 400, error: SAY.EISDIR(file) };
  if (!info.isFile()) return { ok: false, status: 400, error: `这不是普通文件：${file}` };
  if (info.size > maxBytes) return { ok: false, status: 413, error: `文件太大（${(info.size / 1024 / 1024).toFixed(1)} MB，上限 ${Math.round(maxBytes / 1024 / 1024)} MB），不像镜头表：${file}` };
  let text;
  try { text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''); } catch (cause) { return { ok: false, status: 403, error: fsError(cause, file) }; }
  if (!text.trim()) return { ok: false, status: 422, error: `文件是空的：${file}` };
  try { JSON.parse(text); } catch (cause) { return { ok: false, status: 422, error: `不是合法的 JSON（${cause.message}）：${file}\n文件可能没写完、少了括号或逗号。` }; }
  const table = siblingTablePath(file);
  const tableFile = await fs.stat(table).then((t) => (t.isFile() ? table : undefined)).catch(() => undefined);
  return { ok: true, path: file, size: info.size, text, ...(tableFile ? { tableFile } : {}) };
}

/** 开发服务器插件：只接本机同源画布的 POST。 */
export function queuePathPlugin({ read = readQueueFromPath } = {}) {
  return {
    name: 'frameflow-queue-path',
    configureServer(server) { server.middlewares.use(queuePathMiddleware(read)); },
  };
}

export function queuePathMiddleware(read = readQueueFromPath) {
  return async (req, res, next) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== QUEUE_PATH_ROUTE) return next();
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) || req.headers.origin !== `http://${host}`) return json(403, { ok: false, error: '仅限本机画布' });
    if (req.method !== 'POST') return json(405, { ok: false, error: '仅支持 POST' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 8192) return json(413, { ok: false, error: '路径太长' }); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { ok: false, error: '请求不是 JSON' }); }
      const result = await read(body?.path);
      if (!result.ok) return json(result.status ?? 400, { ok: false, error: result.error });
      return json(200, result);
    } catch (cause) { return json(500, { ok: false, error: `读取失败：${cause?.message ?? cause}` }); }
  };
}
