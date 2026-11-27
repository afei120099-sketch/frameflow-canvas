export type ClipboardImage = { src: string; name: string };
type Shape = { type: string; props: object };

/** Only an image-only selection is changed; text, cut, video and mixed selections stay native. */
export function clipboardImages(shapes: readonly Shape[]): ClipboardImage[] | null {
  if (!shapes.length) return null;
  const images: ClipboardImage[] = [];
  for (const shape of shapes) {
    const p = shape.props as { src?: string; name?: string; filename?: string };
    if (!['image-node', 'flux-image-node'].includes(shape.type) || !p.src) return null;
    images.push({ src: p.src, name: p.name || p.filename || '图片' });
  }
  return images;
}

function encode(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
  return btoa(binary);
}

function decodeStoredContent(encoded: string): unknown | null {
  if (!encoded || encoded.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(encoded)) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || !Array.isArray(value.shapes) || !Array.isArray(value.rootShapeIds) || !value.rootShapeIds.length || !value.schema || !clipboardImages(value.shapes)) return null;
    return value;
  } catch { return null; }
}

/** Legacy clipboard HTML. New copies do not write this; chat apps paste the text instead of the picture. */
export function canvasImageClipboardHtml(content: unknown, pngDataUrl: string) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(pngDataUrl)) throw Error('剪贴板图片格式无效');
  return `<div data-frameflow-image-content="${encode(content)}"><img src="${pngDataUrl}" alt=""></div>`;
}

export function readCanvasImageClipboardHtml(html: string): unknown | null {
  const encoded = html.match(/data-frameflow-image-content=["']([A-Za-z0-9+/=]+)["']/)?.[1];
  return encoded ? decodeStoredContent(encoded) : null;
}

const PNG_KEYWORD = 'FrameflowContent';

function withoutEmbeddedBytes(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith('data:') && value.length > 512 ? '' : value;
  if (Array.isArray(value)) return value.map(withoutEmbeddedBytes);
  if (!value || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = withoutEmbeddedBytes(item);
  return copy;
}

function pngCrc(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc ^= data[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, pngCrc(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function isPng(bytes: Uint8Array) {
  return bytes.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
}

/** Node JSON rides inside the PNG. Chat windows only see the picture, because the clipboard has no text. */
export function pngWithCanvasContent(png: Uint8Array, content: unknown): Uint8Array<ArrayBuffer> {
  if (!isPng(png)) throw Error('剪贴板图片不是 PNG');
  const payload = `${PNG_KEYWORD}\0${encode(withoutEmbeddedBytes(content))}`;
  if (payload.length > 1024 * 1024) throw Error('节点数据过大');
  const text = Uint8Array.from(payload, char => char.charCodeAt(0));
  const chunk = pngChunk('tEXt', text);
  let offset = 8;
  while (offset + 12 <= png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset, 8);
    const length = view.getUint32(0);
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    if (type === 'IEND') {
      const out = new Uint8Array(png.length + chunk.length);
      out.set(png.subarray(0, offset), 0);
      out.set(chunk, offset);
      out.set(png.subarray(offset), offset + chunk.length);
      return out;
    }
    if (length > png.length) break;
    offset += 12 + length;
  }
  throw Error('PNG 结构无效');
}

export function readCanvasImagePng(png: Uint8Array): unknown | null {
  if (!isPng(png)) return null;
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0);
    if (length > png.length - offset - 12) return null;
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'tEXt') {
      const split = data.indexOf(0);
      const keyword = split > 0 ? new TextDecoder('latin1').decode(data.subarray(0, split)) : '';
      if (keyword === PNG_KEYWORD) return decodeStoredContent(new TextDecoder('latin1').decode(data.subarray(split + 1)));
    }
    if (type === 'IEND') return null;
    offset += 12 + length;
  }
  return null;
}

export async function readCanvasImageBlob(blob: Blob): Promise<unknown | null> {
  try { return readCanvasImagePng(new Uint8Array(await blob.arrayBuffer())); }
  catch { return null; }
}

/** tldraw normally prioritizes PNG files over node HTML. Restore our nodes before that flattening. */
export function canvasImagePasteOverride(content: { type: string; sources?: readonly unknown[]; point?: unknown }) {
  if (content.type !== 'files') return;
  for (const source of content.sources ?? []) {
    const item = source as { type?: string; subtype?: string; data?: unknown };
    if (item.type !== 'text' || item.subtype !== 'html' || typeof item.data !== 'string') continue;
    const original = readCanvasImageClipboardHtml(item.data);
    if (original) return { type: 'tldraw' as const, content: original, point: content.point };
  }
}
