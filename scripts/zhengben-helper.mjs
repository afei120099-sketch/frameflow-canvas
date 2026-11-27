// 正本接口（给镜头卡片用）：读正本版本号、读用户词库 vocab.json、运行正本 h3q check。
// 挂在收件箱助手（scripts/inbox-server.mjs）上，画布通过 /api/inbox?op=zhengben-… 访问。
// 正本、h3q.py、vocab.json 只读：这里只读文件、把队列写进系统临时目录再交给 h3q，用完就删。
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Bundled prompt-rules toolkit; FRAMEFLOW_H3_TOOLS may select another installation.
// 源文件/vocab.json is an optional user vocabulary.
export const H3_TOOLS = process.env.FRAMEFLOW_H3_TOOLS || path.resolve('h3-tools');
const SKILL = () => path.join(H3_TOOLS, 'SKILL_h3-video.md');
const H3Q = () => path.join(H3_TOOLS, 'h3q.py');
const VOCAB = () => path.join(H3_TOOLS, '源文件', 'vocab.json');
const PYTHON = process.env.FRAMEFLOW_PYTHON || 'python';
const safe = (name) => typeof name === 'string' && name.length > 0 && name.length < 200 && !/[\\/:*?"<>|]/.test(name) && name !== '.' && name !== '..';

/** 正本开头那句「> **正本 v2026-11-09.6**｜…」里的版本号；读不到就是「未知」。 */
export async function readZhengbenVersion(file = SKILL()) {
  try {
    const head = (await fs.readFile(file, 'utf8')).slice(0, 4000);
    const m = /正本\s*(v\d{4}-\d{2}-\d{2}(?:\.\d+)?)/.exec(head);
    return m ? { version: m[1], file } : { version: '未知', file, error: '正本开头没找到「正本 v…」那句' };
  } catch (error) { return { version: '未知', file, error: error.code === 'ENOENT' ? `正本不在 ${file}` : `正本读不了：${error.message}` }; }
}

/** 用户词库，原样返回（每类是 [名称, 中文提示词, …] 的数组）。每次现读，用户改了马上看得到。 */
export async function readVocab(file = VOCAB()) {
  try {
    const [text, st] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { ok: true, file, mtime: st.mtimeMs, vocab: JSON.parse(text) };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, file, mtime: 0, vocab: {} };
    return { ok: false, file, error: `词库读不了：${error.message}` };
  }
}

function run(cmd, args, { timeout = 30000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }); }
    catch (error) { resolve({ error: error.code === 'ENOENT' ? `没找到 ${cmd}（没装 Python，或不在 PATH 里）` : error.message }); return; }
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); resolve({ error: `h3q 运行超过 ${timeout / 1000} 秒，已停止` }); } }, timeout);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { if (done) return; done = true; clearTimeout(timer); resolve({ error: error.code === 'ENOENT' ? `没找到 ${cmd}（没装 Python，或不在 PATH 里）` : error.message }); });
    child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/**
 * 跑正本 h3q check。body = { queue, tableFile?, project?, file? }。
 * 对照表（h3q 要求队列旁有 <队列名>_对照表.md）：
 *   - tableFile：用户给的真实路径（必须叫 …_对照表.md），复制到临时目录、和临时队列同名，交给 h3q 一起查；
 *   - 或 project + file 且收件箱里该队列旁边有 <队列名>_对照表.md，同样处理；
 *   - 都没有：加 --skip-table，结果里 table=false（卡片写「未核对对照表」）。
 * 原文件只读，临时目录用完就删。
 */
export async function runH3qCheck(body, { inboxRoot } = {}) {
  const version = await readZhengbenVersion();
  const script = H3Q();
  try { await fs.access(script); } catch { return { ok: false, version: version.version, error: `h3q.py 不在 ${script}` }; }
  if (!body || typeof body.queue !== 'object' || !body.queue) return { ok: false, version: version.version, error: '没收到队列' };
  const given = typeof body.tableFile === 'string' && body.tableFile.trim() ? path.resolve(body.tableFile.trim()) : '';
  if (given && !/_对照表\.md$/i.test(given)) return { ok: false, version: version.version, error: `对照表文件名要以「_对照表.md」结尾：${given}` };
  if (given) { try { await fs.access(given); } catch { return { ok: false, version: version.version, error: `对照表不在 ${given}` }; } }
  const fromTable = given ? path.basename(given).replace(/_对照表\.md$/i, '') : '';
  const base = safe(fromTable) && !/^_compiled_/i.test(fromTable) ? fromTable : safe(body.file) && /\.json$/i.test(body.file) && !/^_compiled_/i.test(body.file) ? body.file.replace(/\.json$/i, '') : 'card_queue';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frameflow-h3q-'));
  try {
    const queueFile = path.join(dir, `${base}.json`);
    await fs.writeFile(queueFile, JSON.stringify(body.queue, null, 2), 'utf8');
    let table = false, tableFile = '';
    if (given) { await fs.copyFile(given, path.join(dir, `${base}_对照表.md`)); table = true; tableFile = given; }
    else if (inboxRoot && safe(body.project) && base !== 'card_queue') {
      const source = path.join(inboxRoot, body.project, `${base}_对照表.md`);
      try { await fs.copyFile(source, path.join(dir, `${base}_对照表.md`)); table = true; tableFile = source; } catch { /* no table next to the queue */ }
    }
    const args = ['-I', script, 'check', queueFile, '--all', ...(table ? [] : ['--skip-table'])];
    const result = await run(PYTHON, args, { cwd: dir });
    if (result.error) return { ok: false, version: version.version, error: result.error };
    if (!/结果:\s*ERROR/.test(result.out)) return { ok: false, version: version.version, error: `h3q 没给出结果（退出码 ${result.code}）${result.err ? '：' + result.err.trim().slice(-400) : ''}` };
    return { ok: true, version: version.version, table, tableFile, exitCode: result.code, output: result.out, command: `python -I "${script}" check <临时文件> --all${table ? '' : ' --skip-table'}` };
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** Ops on the inbox helper. Returns true when handled. */
export async function handleZhengbenOp(op, req, json, { inboxRoot } = {}) {
  if (op === 'zhengben-version' && req.method === 'GET') { json(200, await readZhengbenVersion()); return true; }
  if (op === 'zhengben-vocab' && req.method === 'GET') { const vocab = await readVocab(); json(vocab.ok ? 200 : 404, vocab); return true; }
  if (op === 'zhengben-check' && req.method === 'POST') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks); if (raw.length > 5_000_000) { json(413, { ok: false, error: '队列太大' }); return true; }
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch { json(400, { ok: false, error: '不是合法 JSON' }); return true; }
    json(200, await runH3qCheck(body, { inboxRoot }));
    return true;
  }
  return false;
}
