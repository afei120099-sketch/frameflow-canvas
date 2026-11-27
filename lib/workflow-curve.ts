export type CurvePoint = { x: number; y: number };

/** A screen-independent S curve. Geometry and painting share the same samples. */
export function workflowCurve(start: CurvePoint, end: CurvePoint) {
  const reach = Math.max(40, Math.min(240, Math.abs(end.x - start.x) * 0.5));
  const a = { x: start.x + reach, y: start.y };
  const b = { x: end.x - reach, y: end.y };
  const points = Array.from({ length: 49 }, (_, i) => {
    const t = i / 48; const s = 1 - t;
    return { x: s ** 3 * start.x + 3 * s ** 2 * t * a.x + 3 * s * t ** 2 * b.x + t ** 3 * end.x, y: s ** 3 * start.y + 3 * s ** 2 * t * a.y + 3 * s * t ** 2 * b.y + t ** 3 * end.y };
  });
  return { path: `M${start.x},${start.y} C${a.x},${a.y} ${b.x},${b.y} ${end.x},${end.y}`, points };
}
