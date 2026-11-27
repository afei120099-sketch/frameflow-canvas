"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { HTMLContainer, useValue, type Editor, type TLShape } from "tldraw";
import { pinnedDockShapeId } from "@/lib/dock-pin";
import { getGeneratingSnapshot, subscribeGenerating } from "@/lib/link-highlight";
import { FAR_ZOOM, isNearViewport } from "@/lib/media-activation";

/**
 * tldraw still mounts every current-page shape. getCulledShapes() only hides the DOM node
 * and, if called per shape, copies the whole culled set. This hook reads the cached viewport
 * once per shape and swaps the custom component for a lightweight title card.
 * Selected, editing, pending, generating and dock-pinned nodes stay mounted so batch actions and
 * open panels keep working through zoom and pan.
 */
function keepMounted(editor: Editor, shapeId: TLShape["id"], generating: boolean) {
  if (generating || editor.getEditingShapeId() === shapeId || editor.getSelectedShapeIds().includes(shapeId) || pinnedDockShapeId.get() === shapeId) return true;
  const props = editor.getShape(shapeId)?.props as { pendingId?: string; pendingDesignId?: string } | undefined;
  return Boolean(props?.pendingId || props?.pendingDesignId);
}

function shapeIsFull(editor: Editor, shapeId: TLShape["id"], generating: boolean) {
  if (keepMounted(editor, shapeId, generating)) return true;
  const bounds = editor.getShapePageBounds(shapeId);
  if (!bounds || !isNearViewport(bounds, editor.getViewportPageBounds(), 0.15)) return false;
  return editor.getZoomLevel() >= FAR_ZOOM;
}

function useDeferredFull(want: boolean, immediate: boolean) {
  const [shown, setShown] = useState(want);
  useEffect(() => {
    if (!want) { if (shown) setShown(false); return; }
    if (immediate) { if (!shown) setShown(true); return; }
    if (shown) return;
    const timer = window.setTimeout(() => setShown(true), 160);
    return () => window.clearTimeout(timer);
  }, [want, immediate, shown]);
  return shown;
}

const KINDS: Record<string, { label: string; accent: string }> = {
  "h3-node": { label: "H3 视频", accent: "#858585" },
  "video-node": { label: "视频", accent: "#858585" },
  "image-node": { label: "图片", accent: "#858585" },
  "flux-image-node": { label: "Flux 图片", accent: "#858585" },
  "audio-node": { label: "声音", accent: "#858585" },
  "upscale-node": { label: "高清 / 插帧", accent: "#858585" },
  "smooth-node": { label: "插帧", accent: "#858585" },
};

/** What the far-zoom card shows: kind, a readable title, whether work is in flight. Strings only. */
export function cardInfo(shape: TLShape | undefined) {
  const props = (shape?.props ?? {}) as { w?: number; shotTitle?: string; name?: string; filename?: string; prompt?: string; pendingId?: string; pendingDesignId?: string };
  const kind = KINDS[shape?.type ?? ""] ?? { label: "节点", accent: "#858585" };
  const prompt = typeof props.prompt === "string" ? props.prompt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
  const title = (props.shotTitle || props.name || props.filename || (prompt ? prompt.slice(0, 40) + (prompt.length > 40 ? "…" : "") : "") || kind.label).trim();
  return { kind: kind.label, accent: kind.accent, title, busy: Boolean(props.pendingId || props.pendingDesignId), w: Number(props.w) || 400 };
}

const SEP = "\u0000";

export function CulledShape({ editor, shapeId, children }: { editor: Editor; shapeId: TLShape["id"]; children: ReactNode }) {
  const generating = useSyncExternalStore(subscribeGenerating, () => getGeneratingSnapshot().split(",").includes(shapeId), () => false);
  const wantFull = useValue("frameflow shape body", () => shapeIsFull(editor, shapeId, generating), [editor, shapeId, generating]);
  const immediate = useValue("frameflow shape keep", () => keepMounted(editor, shapeId, generating), [editor, shapeId, generating]);
  const show = useDeferredFull(wantFull, immediate);
  // Far-zoom card: no text, only the kind's colour bar (re-renders only if kind or width changes).
  const info = useValue("frameflow far card", () => { const i = cardInfo(editor.getShape(shapeId)); return [i.accent, String(i.w)].join(SEP); }, [editor, shapeId]);
  if (show) return children;
  const [accent, w] = info.split(SEP);
  const bar = Math.max(4, Math.min(14, Number(w) * 0.012));
  return <HTMLContainer className="node-container node-culled" style={{ background: "var(--ff-control)", borderRadius: 16, border: "1px solid var(--ff-border-strong)", borderTop: `${bar}px solid ${accent}`, boxSizing: "border-box", width: "100%", height: "100%", pointerEvents: "none" }} />;
}
