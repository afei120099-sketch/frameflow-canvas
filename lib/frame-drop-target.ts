/** Screen-space hit testing: connection tolerance stays usable at any canvas zoom. */
export function nearestFrameDropTarget<T extends { bounds: { left: number; right: number; top: number; bottom: number } }>(
  point: { x: number; y: number }, targets: readonly T[], radius = 42,
): T | null {
  let nearest: T | null = null;
  let best = Infinity;
  for (const target of targets) {
    const { left, right, top, bottom } = target.bounds;
    if (right <= left || bottom <= top) continue;
    const distance = Math.hypot(Math.max(left - point.x, 0, point.x - right), Math.max(top - point.y, 0, point.y - bottom));
    // Inside a target beats its neighbour's tolerance; do not pick the first DOM match.
    if (distance <= radius && distance < best) { nearest = target; best = distance; }
  }
  return nearest;
}
