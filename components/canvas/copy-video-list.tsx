"use client";
import { useEffect } from "react";
import type { Editor, TLShape } from "tldraw";
import { getRun, getShot, type AssetRecord } from "@/lib/production-records";
import { isCuttableVideo } from "@/lib/canvas-rough-cut";
import { COPY_VIDEO_LIST_EVENT, formatVideoList, readingOrder, UNNAMED, type VideoListRow } from "@/lib/canvas-video-list";
import { locateLocalFiles, revealRequestFor } from "@/lib/reveal-node-file";
import { copyPlainText } from "@/lib/copy-plain-text";
import { showCanvasToast } from "./canvas-events";

/**
 * 右键「复制视频清单」的执行端：选中的视频（和一键粗剪同一个判定 isCuttableVideo）按画布位置排好 →
 * 每个取当前显示的那一版素材（resolveAsset，和「打开所在文件夹」/粗剪同一套规则）→ 开发服务器只查本机路径（不开资源管理器）→
 * 拼成纯文本放进剪贴板。只读：不改素材、不导出、不碰队列和收件箱。
 */
export function CopyVideoList({ editor, resolveAsset }: { editor: Editor; resolveAsset: (shape: TLShape) => Promise<AssetRecord | null> }) {
  useEffect(() => {
    let busy = false;

    /** 节点上显示给用户的名字：H3 节点用镜头标题，视频节点用节点名。 */
    const titleOf = async (shape: TLShape) => {
      const p = shape.props as { name?: string; shotTitle?: string; shotId?: string };
      if (shape.type !== "h3-node") return p.name || UNNAMED;
      if (p.shotTitle) return p.shotTitle;
      const shot = p.shotId ? await getShot(p.shotId).catch(() => null) : null;
      return shot?.title || (shot ? `镜头${String(shot.shotNumber).padStart(2, "0")}` : UNNAMED);
    };

    const build = async (shapes: TLShape[]) => {
      const entries = await Promise.all(shapes.map(async (shape) => {
        const p = shape.props as { name?: string; originalPath?: string; src?: string };
        const [title, asset] = await Promise.all([titleOf(shape).catch(() => UNNAMED), resolveAsset(shape).catch(() => null)]);
        const run = asset?.sourceRunId ? await getRun(asset.sourceRunId).catch(() => null) : null;
        const request = revealRequestFor({ asset, run, name: p.name, originalPath: p.originalPath, src: p.src });
        return { title, request, imported: asset?.origin === "imported" };
      }));
      const located = await locateLocalFiles(entries.map((entry) => entry.request));
      const rows: VideoListRow[] = entries.map((entry, i) => ({
        title: entry.title,
        // 没核实时，导入的素材只有文件名，拼出来的 ComfyUI 路径是瞎猜，不写
        path: !located.verified && entry.imported && entry.request && !("path" in entry.request) ? null : located.paths[i],
      }));
      return { text: formatVideoList(rows), count: rows.length, verified: located.verified };
    };

    const open = (event: Event) => {
      const ids = (event as CustomEvent<{ ids?: string[] }>).detail?.ids ?? editor.getSelectedShapeIds();
      const shapes = ids.map((id) => editor.getShape(id as TLShape["id"])).filter((shape): shape is TLShape => !!shape && isCuttableVideo(shape));
      if (!shapes.length) { showCanvasToast("没有选中视频"); return; }
      if (busy) { showCanvasToast("视频清单还在整理，等一下"); return; }
      busy = true;
      const ordered = readingOrder(shapes, (shape) => editor.getShapePageBounds(shape));
      showCanvasToast(`正在整理 ${ordered.length} 个视频的清单…`);
      const result = build(ordered);
      const done = (ok: boolean, value?: Awaited<typeof result>) => {
        busy = false;
        if (!ok || !value) { showCanvasToast("复制视频清单失败，请重试"); return; }
        showCanvasToast(`已复制 ${value.count} 个视频的清单${value.verified ? "" : "（画布重启后路径会逐个核实）"}`);
      };
      const fallback = () => result.then((value) => copyPlainText(value.text, false).then((ok) => done(ok, value)), () => done(false));
      // 剪贴板要在点击的这一刻就开始写（整理要等素材库和开发服务器，等完再写浏览器可能不认这是用户操作）；
      // 不支持「先占位、内容稍后给」的浏览器，整理完再用普通复制。
      try {
        if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) { void fallback(); return; }
        const blob = result.then((value) => new Blob([value.text], { type: "text/plain" }));
        navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).then(
          () => result.then((value) => done(true, value), () => done(false)),
          () => { void fallback(); },
        );
      } catch { void fallback(); }
    };
    window.addEventListener(COPY_VIDEO_LIST_EVENT, open);
    return () => window.removeEventListener(COPY_VIDEO_LIST_EVENT, open);
  }, [editor, resolveAsset]);
  return null;
}
