/** Place a batch in input order, top-aligned with a fixed edge-to-edge gap. */
export function createMediaImportRow(anchor: { x: number; y: number }, gap = 100) {
  let nextX: number | undefined;
  let top: number | undefined;
  return (width: number, height: number) => {
    if (!(width > 0 && height > 0)) throw new Error("素材节点尺寸无效");
    if (nextX === undefined) { nextX = anchor.x - width / 2; top = anchor.y - height / 2; }
    const point = { x: nextX, y: top! };
    nextX += width + gap;
    return point;
  };
}
