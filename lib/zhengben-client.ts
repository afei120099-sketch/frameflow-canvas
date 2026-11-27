/**
 * 画布读「正本」那边的东西：都走开发服务器的收件箱助手（scripts/zhengben-helper.mjs），画布只读不写，也不复制一份进画布。
 */

async function getJson(op: string, init?: RequestInit) {
  const response = await fetch(`/api/inbox?op=${op}`, { cache: "no-store", ...init });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (response.status === 404 && body.error === "未知操作") throw new Error("开发服务器的收件箱助手是旧版本，没有正本接口；请重启画布开发服务器（npm run dev）");
  if (response.status === 503) throw new Error(typeof body.error === "string" ? body.error : "收件箱助手没启动（npm run dev 会带起它）");
  return { status: response.status, body };
}

export type VocabResult = { ok: true; vocab: Record<string, unknown>; file: string; mtime: number } | { ok: false; error: string };

/** 用户词库 %FRAMEFLOW_H3_TOOLS%\源文件\vocab.json，每次现读。 */
export async function fetchVocab(): Promise<VocabResult> {
  try {
    const { body } = await getJson("zhengben-vocab");
    if (body.ok && body.vocab && typeof body.vocab === "object") return { ok: true, vocab: body.vocab as Record<string, unknown>, file: String(body.file ?? ""), mtime: Number(body.mtime ?? 0) };
    return { ok: false, error: typeof body.error === "string" ? body.error : "词库读不到" };
  } catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : "词库读不到" }; }
}

export type H3qResult =
  | { ok: true; version: string; table: boolean; tableFile: string; output: string; command: string }
  | { ok: false; version: string; error: string };

/**
 * 跑正本 h3q check：开发服务器把队列写进临时文件，运行 `python -I h3q.py check <临时文件> --all`，
 * 没有对照表时加 `--skip-table`。tableFile = 用户指定的 <队列名>_对照表.md 真实路径（可不填）。
 * 失败一律返回 ok:false 和原因，卡片要明说「没跑成」，不能当作通过。
 */
export async function runH3qCheck(queue: unknown, options: { tableFile?: string } = {}): Promise<H3qResult> {
  try {
    const { body } = await getJson("zhengben-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queue, tableFile: options.tableFile || undefined }) });
    const version = typeof body.version === "string" ? body.version : "未知";
    if (body.ok && typeof body.output === "string") return { ok: true, version, table: Boolean(body.table), tableFile: String(body.tableFile ?? ""), output: body.output, command: String(body.command ?? "") };
    return { ok: false, version, error: typeof body.error === "string" ? body.error : "h3q 没给出结果" };
  } catch (cause) { return { ok: false, version: "未知", error: cause instanceof Error ? cause.message : "连不上开发服务器" }; }
}

/** 正本开头那句「正本 v…」的版本号；读不到就是「未知」。 */
export async function fetchZhengbenVersion(): Promise<string> {
  try {
    const { body } = await getJson("zhengben-version");
    return typeof body.version === "string" && body.version ? body.version : "未知";
  } catch { return "未知"; }
}
