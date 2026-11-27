/**
 * 镜头卡片「换队列 JSON」页的「载入路径 JSON 队列」：把路径交给开发服务器读（scripts/queue-path-vite-plugin.mjs，只读），
 * 拿回文件原文，卡片再照「载入 JSON 文件」那样填进文本框、照常检查。这里不入队、不跳过确认。
 */
export const QUEUE_PATH_ROUTE = "/__queue/read-path";
export const RECENT_QUEUE_PATHS_KEY = "frameflow.shotCard.recentQueuePaths.v1";
export const RECENT_QUEUE_PATHS_MAX = 5;
/** 卡片按队列标题记的对照表路径（shot-card-board.tsx 的 H3qBar 用同一个键）。 */
export const h3qTableKey = (title: string) => `frameflow.shotCard.h3qTable.v1|${title}`;

export type QueuePathResult = { ok: true; path: string; size: number; text: string; tableFile?: string } | { ok: false; error: string };

/** 粘贴进来的东西像不像一个 .json 路径（用来决定粘贴后要不要直接载入）。 */
export function looksLikeJsonPath(value: string): boolean {
  const v = value.trim().replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "").trim();
  return !/[\r\n]/.test(v) && /^[A-Za-z]:[\\/]/.test(v) && /\.json$/i.test(v);
}

export async function readQueuePath(path: string, request: typeof fetch = fetch): Promise<QueuePathResult> {
  try {
    const response = await request(QUEUE_PATH_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }), cache: "no-store", signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (response.ok && body.ok === true && typeof body.text === "string" && typeof body.path === "string") return { ok: true, path: body.path, size: Number(body.size ?? 0), text: body.text, ...(typeof body.tableFile === "string" ? { tableFile: body.tableFile } : {}) };
    if (typeof body.error === "string") return { ok: false, error: body.error };
    if (response.status === 404) return { ok: false, error: "开发服务器还没有「按路径载入」接口：请重启画布（关掉后双击桌面「AI视频创作无限画布」）" };
    return { ok: false, error: `按路径载入失败（${response.status}）` };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error && cause.name === "TimeoutError" ? "读文件超时（网盘文件可能还没下载完），等一下再试" : "连不上开发服务器，按路径载入用不了" };
  }
}

type Store = Pick<Storage, "getItem" | "setItem">;
const local = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };

export function loadRecentQueuePaths(store: Store | null = local()): string[] {
  try {
    const value = JSON.parse(store?.getItem(RECENT_QUEUE_PATHS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, RECENT_QUEUE_PATHS_MAX) : [];
  } catch { return []; }
}

/** 最新的放最前，同一路径（不分大小写）只留一条，最多 5 条。 */
export function rememberQueuePath(path: string, store: Store | null = local()): string[] {
  const next = [path, ...loadRecentQueuePaths(store).filter((item) => item.toLowerCase() !== path.toLowerCase())].slice(0, RECENT_QUEUE_PATHS_MAX);
  try { store?.setItem(RECENT_QUEUE_PATHS_KEY, JSON.stringify(next)); } catch { /* 只是本机便利，存不了就算了 */ }
  return next;
}

/**
 * 按路径载入时，把队列旁的 _对照表.md 记成这份队列（按标题）的 h3q 对照表；旁边没有就清掉旧的，
 * 免得 v4 沿用 v3 的对照表。读不出标题（JSON 不是队列）就不动。
 * 返回撤销函数：载入没成功（检查报错 / 用户取消换队列）时调用，恢复原来的设置。
 */
type TableStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function rememberTableForQueue(text: string, tableFile: string | undefined, store: TableStore | null = local() as TableStore | null): () => void {
  let title: unknown;
  try { title = (JSON.parse(text) as { title?: unknown })?.title; } catch { return () => {}; }
  if (typeof title !== "string" || !title || !store) return () => {};
  const key = h3qTableKey(title);
  const put = (value: string | null) => { try { if (value) store.setItem(key, value); else store.removeItem(key); } catch { /* 存不了：卡片顶部「对照表」里可以手填 */ } };
  let before: string | null = null;
  try { before = store.getItem(key); } catch { /* ignore */ }
  put(tableFile ?? null);
  return () => put(before);
}
