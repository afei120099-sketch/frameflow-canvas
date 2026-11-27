/**
 * Phase 9: which media nodes get a real player right now.
 * A <video>/<audio> source is attached only when the node is near the viewport and the canvas is not
 * zoomed out to the "far" LOD, or while the user is playing / trimming it. Everything else shows a
 * poster / placeholder, so hundreds of off-screen nodes do not each hold a decoder.
 */

export type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** Same zoom thresholds as NodeShell's data-detail (far < 0.48 ≤ mid < 0.72 ≤ near). */
export const FAR_ZOOM = 0.48;
/** Viewport is expanded by this fraction on each side so media is ready slightly before it scrolls in. */
export const VIEWPORT_MARGIN = 0.5;

export function expandBox(box: Box, fraction: number): Box {
  const dx = (box.maxX - box.minX) * fraction; const dy = (box.maxY - box.minY) * fraction;
  return { minX: box.minX - dx, minY: box.minY - dy, maxX: box.maxX + dx, maxY: box.maxY + dy };
}

export function intersects(a: Box, b: Box) { return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY; }

export function isNearViewport(shape: Box | null | undefined, viewport: Box, margin = VIEWPORT_MARGIN) {
  return Boolean(shape) && intersects(shape!, expandBox(viewport, margin));
}

export function shouldActivateMedia(state: { near: boolean; zoom: number; playing?: boolean; keepAlive?: boolean }) {
  if (state.playing || state.keepAlive) return true;
  return state.near && state.zoom >= FAR_ZOOM;
}

/**
 * Document changes that can alter what a node shows through its links (arrows, bindings, source props).
 * Pure moves (x / y / rotation / index / opacity / meta) are ignored, so dragging one shape no longer
 * re-renders every H3 / video / enhancement node on the canvas.
 */
type RecordLike = { typeName?: string; props?: unknown; parentId?: unknown };
export function affectsLinkedContent(changes: { added: Record<string, unknown>; removed: Record<string, unknown>; updated: Record<string, [unknown, unknown]> }) {
  if (Object.keys(changes.added).length || Object.keys(changes.removed).length) return true;
  for (const [from, to] of Object.values(changes.updated) as [RecordLike, RecordLike][]) {
    if (from?.typeName !== "shape" && from?.typeName !== undefined) return true;
    if (from?.props !== to?.props || from?.parentId !== to?.parentId) return true;
  }
  return false;
}
