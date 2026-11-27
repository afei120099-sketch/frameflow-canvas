/** Quadrants of a 2×2 character sheet. The whole sheet is never the generation canvas. */

export interface NormalizedCrop { x: number; y: number; width: number; height: number }
export interface PixelCrop { x: number; y: number; width: number; height: number }

export const SHEET_FRONT_BODY: NormalizedCrop = { x: 0, y: 0, width: 0.5, height: 0.5 };
export const SHEET_FACE_CLOSEUP: NormalizedCrop = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };

export function pixelCrop(imageWidth: number, imageHeight: number, crop: NormalizedCrop): PixelCrop {
  if (![imageWidth, imageHeight].every(value => Number.isInteger(value) && value > 0)) throw new Error("原图尺寸无效");
  for (const value of [crop.x, crop.y, crop.width, crop.height]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("裁切范围要在画面之内");
  }
  const x = Math.round(crop.x * imageWidth);
  const y = Math.round(crop.y * imageHeight);
  const width = Math.round(crop.width * imageWidth);
  const height = Math.round(crop.height * imageHeight);
  if (width < 1 || height < 1 || x + width > imageWidth || y + height > imageHeight) throw new Error("裁切超出画面");
  return { x, y, width, height };
}
