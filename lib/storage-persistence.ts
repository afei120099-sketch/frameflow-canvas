/**
 * A 批第 3 项: ask the browser not to clear this site's data (canvas, records, media) when the disk
 * gets full. Checks persisted() first and only then calls persist(); the browser may say no.
 */
export type StoragePersistence = "persisted" | "granted" | "denied" | "unsupported" | "error";

type StorageLike = { persisted?: () => Promise<boolean>; persist?: () => Promise<boolean> };

export async function ensurePersistentStorage(storage: StorageLike | undefined = (globalThis.navigator as Navigator | undefined)?.storage): Promise<StoragePersistence> {
  if (!storage?.persisted || !storage.persist) return "unsupported";
  try {
    if (await storage.persisted()) return "persisted";
    return (await storage.persist()) ? "granted" : "denied";
  } catch { return "error"; }
}

export const isPersistent = (state: StoragePersistence | null) => state === "persisted" || state === "granted";

/** Plain words for the 备份 button and panel. */
export function persistenceLabel(state: StoragePersistence | null) {
  switch (state) {
    case null: return "正在检查浏览器是否会保留画布数据…";
    case "persisted":
    case "granted": return "已持久化：浏览器不会因为磁盘空间不足自动清掉画布和素材";
    case "denied": return "浏览器未允许持久保存：磁盘空间紧张时，浏览器可能自动清掉画布和素材。请定期点「导出项目备份」存到硬盘";
    case "unsupported": return "当前浏览器不支持持久保存设置：请定期点「导出项目备份」存到硬盘";
    case "error": return "检查持久保存时出错：请定期点「导出项目备份」存到硬盘";
  }
}
