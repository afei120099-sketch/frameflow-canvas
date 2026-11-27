"use client";
import { useEffect } from "react";
import type { Editor, TLShape } from "tldraw";
import { getRun, type AssetRecord } from "@/lib/production-records";
import { NO_LOCAL_PATH, EXPORT_HINT, OPEN_REVEAL_FILE_EVENT, revealLocalFile, revealRequestFor } from "@/lib/reveal-node-file";
import { showCanvasToast } from "./canvas-events";

/**
 * 右键「打开所在文件夹」的执行端：取节点当前显示的那一版素材 → 拼线索 → 开发服务器打开资源管理器并选中文件。
 * resolveAsset 和粗剪 / 去背景音用的是同一套「当前显示哪一版」规则（canvas-workspace.tsx）。
 */
export function RevealNodeFile({ editor, resolveAsset }: { editor: Editor; resolveAsset: (shape: TLShape) => Promise<AssetRecord | null> }) {
  useEffect(() => {
    let busy = false;
    const open = async (event: Event) => {
      const id = (event as CustomEvent<{ sourceId?: string }>).detail?.sourceId;
      const shape = id ? editor.getShape(id as TLShape["id"]) : undefined;
      if (!shape || busy) return;
      busy = true;
      try {
        const p = shape.props as { name?: string; originalPath?: string; src?: string };
        const asset = await resolveAsset(shape).catch(() => null);
        const run = asset?.sourceRunId ? await getRun(asset.sourceRunId).catch(() => null) : null;
        const request = revealRequestFor({ asset, run, name: p.name, originalPath: p.originalPath, src: p.src });
        if (!request) { showCanvasToast(`${NO_LOCAL_PATH}。${EXPORT_HINT}`); return; }
        showCanvasToast("正在找文件…");
        const result = await revealLocalFile(request, { imported: asset?.origin === "imported" });
        showCanvasToast(result.ok ? `已在资源管理器里打开并选中：${result.path}` : result.error);
      } finally { busy = false; }
    };
    window.addEventListener(OPEN_REVEAL_FILE_EVENT, open);
    return () => window.removeEventListener(OPEN_REVEAL_FILE_EVENT, open);
  }, [editor, resolveAsset]);
  return null;
}
