/**
 * 右键「复制视频清单」：把选中的视频按画布上的位置排好，拼成给剪辑助手看的纯文本。
 * 这里只有纯逻辑（排序、拼文本）；取素材和查本机路径在 components/canvas/copy-video-list.tsx。
 * 以画布上当前的节点和当前显示的那一版为准，不读队列状态文件。测试 scripts/test-canvas-video-list.mjs。
 */

export const COPY_VIDEO_LIST_EVENT = "frameflow-copy-video-list";
export const NOT_LOCAL = "（只在画布里，没有本机文件）";
export const UNNAMED = "未命名";

export type PageBox = { x: number; y: number; w: number; h: number };

/**
 * 阅读顺序：先按行（从上到下），同一行再从左到右。
 * 「同一行」：两个节点的 y 中心相差小于较矮节点高度的一半。按 y 中心从上往下扫，
 * 每个节点和当前行的第一个节点比（不和最后一个比，免得错落摆放时一行越拖越斜）。
 * 坐标用页面坐标（editor.getShapePageBounds）。拿不到位置的放最后，保持原顺序。
 */
export function readingOrder<T>(items: readonly T[], boxOf: (item: T) => PageBox | null | undefined): T[] {
  const placed: { item: T; box: PageBox; cy: number; i: number }[] = [];
  const unplaced: T[] = [];
  items.forEach((item, i) => {
    const box = boxOf(item);
    if (box && [box.x, box.y, box.w, box.h].every(Number.isFinite)) placed.push({ item, box, cy: box.y + box.h / 2, i });
    else unplaced.push(item);
  });
  placed.sort((a, b) => a.cy - b.cy || a.box.x - b.box.x || a.i - b.i);
  const rows: (typeof placed)[] = [];
  for (const entry of placed) {
    const row = rows.at(-1);
    const anchor = row?.[0];
    if (row && anchor && Math.abs(entry.cy - anchor.cy) < Math.min(entry.box.h, anchor.box.h) / 2) row.push(entry);
    else rows.push([entry]);
  }
  return [...rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x || a.cy - b.cy || a.i - b.i).map((entry) => entry.item)), ...unplaced];
}

/** 标题里的换行、制表符压成一个空格；空的写「未命名」。 */
export function cleanTitle(title: string | null | undefined) {
  const value = (title ?? "").replace(/\s+/g, " ").trim();
  return value || UNNAMED;
}

export type VideoListRow = { title: string; path: string | null };

/**
 * 拼成纯文本：
 *   共 54 个视频（按画布从左到右、从上到下排序）
 *   01｜EP10-v1-10-1｜新名牌｜D:\…\Frameflow_H3_ultimate_01732-audio.mp4
 *   …
 *   其中 2 个没找到本机文件：序号 03、17
 * 序号至少两位补零，超过 99 个就三位（以此类推）。
 */
export function formatVideoList(rows: readonly VideoListRow[]) {
  const width = Math.max(2, String(rows.length).length);
  const no = (i: number) => String(i + 1).padStart(width, "0");
  const lines = [`共 ${rows.length} 个视频（按画布从左到右、从上到下排序）`];
  const missing: string[] = [];
  rows.forEach((row, i) => {
    if (!row.path) missing.push(no(i));
    lines.push(`${no(i)}｜${cleanTitle(row.title)}｜${row.path ?? NOT_LOCAL}`);
  });
  if (missing.length) lines.push(`其中 ${missing.length} 个没找到本机文件：序号 ${missing.join("、")}`);
  return lines.join("\n");
}
