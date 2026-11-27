import { centerCropRect } from "./comfyui/experimental/h3-ultimate-guide.ts";

/**
 * 🧪 Centre-crop a time-anchor image to the generation aspect and scale it to the exact generation
 * size (browser only). AddGuide centre-crops internally too, so after this its crop is a no-op and
 * the anchor is never framed differently from what the review shows.
 */
export async function cropTimeAnchorImage(blob: Blob, width: number, height: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const rect = centerCropRect(bitmap.width, bitmap.height, width, height);
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error("无法裁切时间锚点图");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
    if (canvas instanceof HTMLCanvasElement) return await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("时间锚点图编码失败")), "image/png"));
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}
