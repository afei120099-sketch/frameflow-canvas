/** Explicit opt-in for newly created nodes. Never infer an upgrade from old dimensions. */
export const H3_NEW_NODE_WIDTH = 717;
export const H3_NEW_NODE_HEIGHT = 824;
export const H3_NEW_LAYOUT_META = { h3LayoutVersion: 2 } as const;

export function hasNewH3Layout(meta: Record<string, unknown> | undefined): boolean {
  return meta?.h3LayoutVersion === 2;
}

export function usesWideH3Typography(meta: Record<string, unknown> | undefined, width: number): boolean {
  return hasNewH3Layout(meta) && width >= H3_NEW_NODE_WIDTH - 1;
}

/** Measured form changes may fit new cards, but must never rewrite a legacy card's height. */
export function h3AutoHeightPatch(meta: Record<string, unknown> | undefined, currentHeight: number, measuredHeight: number): { h?: number } {
  return hasNewH3Layout(meta) && Number.isFinite(measuredHeight) && measuredHeight > 0 && Math.abs(currentHeight - measuredHeight) > 2
    ? { h: measuredHeight } : {};
}
