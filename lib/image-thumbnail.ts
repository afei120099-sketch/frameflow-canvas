/**
 * Display-size image bytes for canvas nodes.
 * Headers give pixel size without a decode. Thumbnails are small JPEGs so a node
 * never keeps a multi-megapixel bitmap. IndexedDB and the original blob are unchanged.
 */

import { getLocalImageBlob } from "@/lib/local-video-store";

const SMALL_BLOB = 96 * 1024;

export async function imagePixelSize(source: string): Promise<{ width: number; height: number }> {
  const blob = await getLocalImageBlob(source);
  const sniffed = await sniffImageSize(blob);
  if (sniffed) return sniffed;
  if (typeof createImageBitmap !== "function") return { width: 0, height: 0 };
  const bitmap = await createImageBitmap(blob);
  try { return { width: bitmap.width, height: bitmap.height }; }
  finally { bitmap.close(); }
}

export async function thumbnailBlob(source: string, maxEdge: number): Promise<Blob> {
  const blob = await getLocalImageBlob(source);
  if (blob.size <= SMALL_BLOB || typeof document === "undefined" || typeof createImageBitmap !== "function") return blob;
  const size = await sniffImageSize(blob);
  const target = size ? fitEdge(size.width, size.height, maxEdge) : null;
  if (size && !target) return blob;
  if (target) {
    const bitmap = await createImageBitmap(blob, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: "low" });
    try { return (await canvasJpeg(bitmap)) ?? blob; }
    finally { bitmap.close(); }
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const fitted = fitEdge(bitmap.width, bitmap.height, maxEdge);
    if (!fitted) return blob;
    const canvas = document.createElement("canvas");
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    const context = canvas.getContext("2d");
    if (!context) return blob;
    context.drawImage(bitmap, 0, 0, fitted.width, fitted.height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.74));
    return out ?? blob;
  } finally { bitmap.close(); }
}

function fitEdge(width: number, height: number, maxEdge: number) {
  const long = Math.max(width, height);
  if (!(long > maxEdge) || !width || !height) return null;
  const scale = maxEdge / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function canvasJpeg(bitmap: ImageBitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.74));
}

async function sniffImageSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  const bytes = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer());
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  const jpeg = jpegSize(bytes);
  if (jpeg) return jpeg;
  return webpSize(bytes);
}

function jpegSize(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    offset += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array) {
  if (bytes.length < 30) return null;
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") return null;
  const tag = String.fromCharCode(...bytes.slice(12, 16));
  if (tag === "VP8X" && bytes.length >= 30) {
    return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
  }
  if (tag === "VP8 " && bytes.length >= 30) {
    return { width: bytes[26] + (bytes[27] << 8) & 0x3fff, height: bytes[28] + (bytes[29] << 8) & 0x3fff };
  }
  if (tag === "VP8L" && bytes.length >= 25) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}
