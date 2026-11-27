import type { TldrawOptions } from 'tldraw';
import { getLocalImageBlob } from '../../lib/local-video-store';
import { clipboardImages, canvasImagePasteOverride, pngWithCanvasContent, readCanvasImageBlob } from '../../lib/canvas-image-clipboard';
import { showCanvasToast } from './canvas-events';

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('图片转为 PNG 失败')), 'image/png'));
}

async function publishWindowsClipboard(blob: Blob) {
  // The local server starts/reuses the native helper only when the browser cannot copy.
  return fetch('/__clipboard/image', { method: 'POST', headers: { 'content-type': 'image/png' }, body: blob, signal: AbortSignal.timeout(30000) }).then(async response => {
    if (response.ok) return '';
    return (await response.text().catch(() => '')) || `系统剪贴板接口返回 ${response.status}`;
  }, () => '无法连接本机复制服务，请确认画布服务正常运行');
}

export async function clipboardPng(sources: readonly string[]): Promise<Blob> {
  const blobs = await Promise.all(sources.map(getLocalImageBlob));
  // PNG can be copied without resizing, re-encoding or losing transparency.
  if (blobs.length === 1 && blobs[0].type === 'image/png') return blobs[0];
  const images: ImageBitmap[] = [];
  try {
    for (const blob of blobs) images.push(await createImageBitmap(blob));
    const width = images.reduce((sum, image) => sum + image.width, 0);
    const height = Math.max(...images.map(image => image.height));
    if (width > 16384 || height > 16384 || width * height > 32 * 1024 * 1024) throw Error('图片组合过大，请单张复制以保留原画质');
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('浏览器无法读取图片像素');
    let x = 0;
    for (const image of images) { ctx.drawImage(image, x, 0); x += image.width; }
    return await canvasPng(canvas);
  } finally { images.forEach(image => image.close()); }
}

export const canvasImageClipboardOptions: Pick<TldrawOptions, 'onBeforeCopyToClipboard' | 'onBeforePasteFromClipboard'> = {
  onBeforeCopyToClipboard({ content, operation }) {
    if (operation !== 'copy') return;
    const images = clipboardImages(content.shapes);
    if (!images) return;
    const png = clipboardPng(images.map(image => image.src)).then(async blob => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      try { return new Blob([pngWithCanvasContent(bytes, content)], { type: 'image/png' }); }
      catch { return new Blob([bytes], { type: 'image/png' }); }
    });
    png.catch(() => {});
    // Invoke write during the user gesture, before asynchronous image loading loses activation.
    const nativeCopy = typeof navigator !== 'undefined' && typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined'
      ? (() => { try { return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]); } catch (error) { return Promise.reject(error); } })()
      : Promise.reject(Error('浏览器不支持图片剪贴板'));
    return nativeCopy.then(() => {
      showCanvasToast(images.length === 1 ? '已复制图片，可以粘贴到其他聊天窗口' : `已复制${images.length}张图片。其他窗口会贴成一张横图`);
      return false as const;
    }, async () => {
      const blob = await png;
      const failure = await publishWindowsClipboard(blob);
      showCanvasToast(failure
        ? `图片复制失败：${failure}`
        : images.length === 1 ? '已复制图片，可以粘贴到其他聊天窗口' : `已复制${images.length}张图片。其他窗口会贴成一张横图`);
      // false keeps tldraw from also copying the node onto this canvas.
      return false as const;
    }).catch(error => {
      showCanvasToast(`图片复制失败：${error instanceof Error ? error.message : '图片未能写入系统剪贴板'}`);
      return false as const;
    });
  },
  async onBeforePasteFromClipboard({ content }) {
    // A picture copied from this canvas stays on the system clipboard. Pasting it here must not spawn another node.
    const files = 'files' in content && Array.isArray(content.files) ? content.files : [];
    if (files.length === 1 && await readCanvasImageBlob(files[0])) return false;
    if (canvasImagePasteOverride(content)) return false;
  },
};
