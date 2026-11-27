export type MagnetRect = { x: number; y: number; w: number; h: number };
export type MagnetGuide = { x: number; y: number }[];
export const MEDIA_MAGNET_GAP = 12;

/** Compare visible media, never the expanded parameter dock. Threshold is in screen pixels. */
export function snapMediaRect(moving: MagnetRect, targets: MagnetRect[], zoom: number) {
  const tolerance = 8 / Math.max(0.05, zoom);
  let bestX: { delta: number; guide: MagnetGuide } | undefined;
  let bestY: { delta: number; guide: MagnetGuide } | undefined;
  const consider = (axis: "x" | "y", delta: number, guide: MagnetGuide) => {
    if (Math.abs(delta) > tolerance) return;
    const best = axis === "x" ? bestX : bestY;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) {
      if (axis === "x") bestX = { delta, guide }; else bestY = { delta, guide };
    }
  };
  for (const t of targets) {
    const xDistance = Math.max(t.x - moving.x - moving.w, moving.x - t.x - t.w, 0);
    const yDistance = Math.max(t.y - moving.y - moving.h, moving.y - t.y - t.h, 0);
    // Only nearby neighbours attract; a remote row must not pull the node.
    if (xDistance > 160 / zoom || yDistance > 160 / zoom) continue;
    if (yDistance === 0) {
      for (const x of [t.x - MEDIA_MAGNET_GAP - moving.w, t.x + t.w + MEDIA_MAGNET_GAP]) {
        const y = (Math.max(moving.y, t.y) + Math.min(moving.y + moving.h, t.y + t.h)) / 2;
        consider("x", x - moving.x, [{ x: x < t.x ? x + moving.w : t.x + t.w, y }, { x: x < t.x ? t.x : x, y }]);
      }
    }
    if (xDistance === 0) {
      for (const y of [t.y - MEDIA_MAGNET_GAP - moving.h, t.y + t.h + MEDIA_MAGNET_GAP]) {
        const x = (Math.max(moving.x, t.x) + Math.min(moving.x + moving.w, t.x + t.w)) / 2;
        consider("y", y - moving.y, [{ x, y: y < t.y ? y + moving.h : t.y + t.h }, { x, y: y < t.y ? t.y : y }]);
      }
    }
    // Match like edges and centres, not arbitrary crossed edges.
    for (const fraction of [0, 0.5, 1]) {
      const x = t.x + t.w * fraction;
      consider("x", x - moving.x - moving.w * fraction, [{ x, y: Math.min(moving.y, t.y) }, { x, y: Math.max(moving.y + moving.h, t.y + t.h) }]);
      const y = t.y + t.h * fraction;
      consider("y", y - moving.y - moving.h * fraction, [{ x: Math.min(moving.x, t.x), y }, { x: Math.max(moving.x + moving.w, t.x + t.w), y }]);
    }
  }
  return { dx: bestX?.delta ?? 0, dy: bestY?.delta ?? 0, guides: [bestX?.guide, bestY?.guide].filter((g): g is MagnetGuide => !!g) };
}

export function visibleMediaRect(shape: { type: string; x: number; y: number; props: object }): MagnetRect | undefined {
  const { w, h, previewWidth, previewHeight } = shape.props as Record<string, unknown>;
  if (typeof w !== "number" || typeof h !== "number") return;
  if (shape.type === "h3-node") {
    if (typeof previewWidth !== "number" || typeof previewHeight !== "number") return;
    return { x: shape.x + (w - previewWidth) / 2, y: shape.y + 32, w: previewWidth, h: previewHeight };
  }
  if (shape.type === "image-node" || shape.type === "video-node") return { x: shape.x, y: shape.y + 32, w, h: Math.max(1, h - 32) };
}
