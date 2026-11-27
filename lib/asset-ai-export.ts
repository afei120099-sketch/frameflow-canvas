import { acquireMediaUrl, releaseMediaUrl } from './local-video-store.ts';
import { assetAiInstructions, assetAiMarkdown, buildAssetAiManifest } from './asset-ai-manifest.ts';
import type { AssetRecord } from './production-records.ts';
import type { RoleRecord } from './role-records.ts';

async function thumbnail(asset: AssetRecord): Promise<Blob> {
  const media = await acquireMediaUrl(asset.storageReference);
  let video: HTMLVideoElement | undefined;
  try {
    const element = asset.kind === 'video' ? (video = document.createElement('video')) : new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('读取画面超时')), 8000);
      const finish = (error?: Error) => { clearTimeout(timer); element.onerror = null; if (video) video.onloadeddata = null; else (element as HTMLImageElement).onload = null; error ? reject(error) : resolve(); };
      element.onerror = () => finish(new Error('无法读取画面'));
      if (video) { video.muted = true; video.preload = 'auto'; video.onloadeddata = () => finish(); } else (element as HTMLImageElement).onload = () => finish();
      element.src = media.url;
    });
    const width = video ? video.videoWidth : (element as HTMLImageElement).naturalWidth;
    const height = video ? video.videoHeight : (element as HTMLImageElement).naturalHeight;
    if (!width || !height) throw new Error('画面尺寸无效');
    const canvas = document.createElement('canvas'); const scale = Math.min(1, 512 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法制作缩略图');
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('缩略图生成失败')), 'image/jpeg', 0.7));
  } finally { if (video) { video.removeAttribute('src'); video.load(); } releaseMediaUrl(media.key); if (media.revoke) URL.revokeObjectURL(media.url); }
}
async function write(name: string, body: Blob | string, isThumbnail = false) {
  const query = new URLSearchParams({ op: 'asset-ai-write', name, ...(isThumbnail ? { thumbnail: '1' } : {}) });
  const response = await fetch(`/api/inbox?${query}`, { method: 'POST', body });
  if (!response.ok) { const result = await response.json().catch(() => ({})) as { error?: string }; throw new Error(result.error || '写入收件箱失败，请检查服务是否已更新并重启'); }
}
export async function exportAssetsForAi(assets: AssetRecord[], roles: RoleRecord[], progress: (done: number, total: number) => void, pageName = "当前画布", visibleIds?: ReadonlySet<string>) {
  const health = await fetch('/api/inbox', { cache: 'no-store' });
  if (!health.ok) throw new Error('收件箱服务未启动，请启动或重启后再试');
  const info = await health.json() as { root?: unknown }; if (typeof info.root !== 'string') throw new Error('无法读取收件箱目录，请重启收件箱服务');
  const thumbnails: Record<string, string> = {};
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    if (asset.kind !== 'audio') {
      let blob: Blob | null = null; try { blob = await thumbnail(asset); } catch { /* unavailable media is reported in the manifest */ }
      if (blob) { const name = `${asset.assetId}.jpg`; await write(name, blob, true); thumbnails[asset.assetId] = `缩略图/${name}`; }
    }
    progress(i + 1, assets.length); if (i % 5 === 4) await new Promise(resolve => setTimeout(resolve, 0));
  }
  const data = buildAssetAiManifest(assets, roles, thumbnails, new Date().toISOString(), pageName, visibleIds);
  await write('素材清单.json', JSON.stringify(data, null, 2)); await write('素材清单.md', assetAiMarkdown(data));
  return { instructions: assetAiInstructions(info.root, data), folder: `${info.root.replace(/[\\/]+$/, '')}\\_素材库给AI` };
}
