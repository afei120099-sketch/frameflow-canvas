export type MediaNodeSize = { w: number; h: number };

/** Same centered preview/header layout as the canvas CSS, independent of DOM mounting. */
export function h3PreviewTerminal(nodeWidth: number, preview: MediaNodeSize, side: "left" | "right") {
  return { x: (nodeWidth - preview.w) / 2 + (side === "right" ? preview.w : 0), y: 32 + preview.h / 2 };
}

export function h3PreviewSize(width: number, height: number, availableWidth = 560): MediaNodeSize {
  const ratio = width > 0 && height > 0 ? width / height : 16 / 9;
  const w = Math.min(availableWidth, 520 * ratio);
  return { w, h: w / ratio };
}

// Keep the media stage at its source aspect ratio. The extra space is only
// the existing card header, footer and padding, never letterboxing inside it.
export function imageNodeSize(width: number, height: number): MediaNodeSize {
  if (!(width > 0 && height > 0)) return { w: 340, h: 290 };
  const ratio = width / height;
  const stageWidth = Math.max(220, Math.min(320, ratio * 400));
  return { w: Math.ceil(stageWidth), h: Math.ceil(stageWidth / ratio + 32) };
}

export function videoNodeSize(width: number, height: number, maxStageHeight = Number.POSITIVE_INFINITY): MediaNodeSize {
  if (!(width > 0 && height > 0)) return { w: 390, h: 300 };
  const ratio = width / height;
  const preferredWidth = ratio < 1 ? 340 : 370;
  const stageWidth = Math.max(240, Math.min(preferredWidth, ratio * maxStageHeight));
  return { w: stageWidth, h: Math.ceil(stageWidth / ratio + 32) };
}

// V0.3 created image cards with this sizing. Only those untouched cards are
// migrated; an existing manually resized card keeps the user's dimensions.
export function legacyImageNodeSize(width: number, height: number): MediaNodeSize {
  const scale = Math.min(1, 320 / width, 220 / height);
  return { w: Math.max(260, width * scale + 24), h: Math.max(220, height * scale + 78) };
}
