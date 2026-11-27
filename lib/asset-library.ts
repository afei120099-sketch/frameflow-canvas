import { isH3Capability, type AssetKind, type AssetRecord, type CapabilityId, type RunRecord, type ShotRecord } from "./production-records.ts";
import type { RoleRecord } from "./role-records.ts";

/**
 * Asset Library V1 (Phase 7): browse / search / filter / preview / reuse.
 * Metadata only: nothing here reads Blobs, and no Asset is ever created, copied or deleted.
 */

export type LibraryKind = "all" | AssetKind;
export type LibrarySort = "newest" | "oldest" | "name";
export const LIBRARY_PAGE_SIZE = 60;

/** Filter by the stored Asset.kind (never by extension), search the filename, then sort. */
export function filterAssets(assets: readonly AssetRecord[], query: { kind: LibraryKind; search: string; sort: LibrarySort }) {
  const needle = query.search.trim().toLocaleLowerCase();
  const result = assets.filter((asset) => (query.kind === "all" || asset.kind === query.kind) && (!needle || (asset.filename ?? "").toLocaleLowerCase().includes(needle)));
  const byName = (a: AssetRecord, b: AssetRecord) => (a.filename ?? "").localeCompare(b.filename ?? "", "zh-CN", { numeric: true });
  return result.sort(query.sort === "name" ? byName : query.sort === "oldest" ? (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) : (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

const CAPABILITY_SOURCE: Record<CapabilityId, string> = { cover_generation:"AI短剧封面", h3_fl2va: "H3生成", h3_ref2va: "H3生成（多参考）", h3_addguide_experimental: "H3生成（🧪引导锚点）", h3_ultimate_guide: "H3生成（🧪时间锚点）", seedvr2_upscale: "SeedVR2", film_interpolation: "FILM", final_cut_rough: "粗剪成片", music_removal: "去配乐（CDX23）" };

/** Source label from real records only: derivation, then the source Run's capability, then Asset.origin. */
export function assetSourceLabel(asset: AssetRecord, runs: ReadonlyMap<string, Pick<RunRecord, "capabilityId">>) {
  if (asset.derivationType === "audio_extract") return "视频提取声音";
  if (asset.derivationType === "audio_clip") return "声音裁剪";
  if (asset.derivationType === "final_cut_rough") return "粗剪成片";
  if (asset.sourceRunId) {
    const run = runs.get(asset.sourceRunId);
    return run ? CAPABILITY_SOURCE[run.capabilityId] ?? run.capabilityId : "生成（Run 记录缺失）";
  }
  if (asset.origin === "imported") return "导入";
  if (asset.origin === "generated") return "生成（无 Run 记录）";
  return "旧版素材（来源未记录）";
}

export function formatAssetMeta(asset: AssetRecord) {
  const parts: string[] = [];
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  if (typeof asset.duration === "number" && Number.isFinite(asset.duration)) parts.push(`${asset.duration.toFixed(1)} 秒`);
  if (typeof asset.fps === "number" && Number.isFinite(asset.fps)) parts.push(`${Number.isInteger(asset.fps) ? asset.fps : asset.fps.toFixed(2)} FPS`);
  return parts.join(" · ");
}

/** Shot status for one Asset: adopted version, H3 candidate, or a derived version in a Shot. */
export function assetShotStatus(asset: AssetRecord, shot: ShotRecord | null | undefined, runs: ReadonlyMap<string, Pick<RunRecord, "capabilityId">>) {
  if (!asset.shotId || !shot) return null;
  if (shot.adoptedAssetId === asset.assetId) return { label: "★ 已采用", adopted: true };
  const capability = asset.sourceRunId ? runs.get(asset.sourceRunId)?.capabilityId : undefined;
  return { label: isH3Capability(capability) ? "候选" : "镜头衍生版本", adopted: false };
}

export function rolesUsingAsset(assetId: string, roles: readonly RoleRecord[]) {
  return roles.flatMap((role) => {
    const uses: string[] = [];
    if (role.appearanceAssetIds.includes(assetId)) uses.push(role.primaryAppearanceAssetId === assetId ? "主外观" : "外观");
    if (role.voiceAssetIds.includes(assetId)) uses.push(role.primaryVoiceAssetId === assetId ? "主声音" : "声音");
    return uses.length ? [{ roleId: role.roleId, displayName: role.displayName, uses }] : [];
  });
}

/** Role reuse maps Asset.kind to the Role list it may join; video cannot join a Role. */
export function roleKindForAsset(asset: AssetRecord): "image" | "audio" | null {
  return asset.kind === "image" ? "image" : asset.kind === "audio" ? "audio" : null;
}

/** Legacy inline media (data: in the canvas document) has no Blob the library can point to. */
export const isLibraryAsset = (asset: AssetRecord) => asset.origin === "imported" && !asset.sourceRunId && !asset.derivationType && !asset.storageReference.startsWith("legacy-inline:");

/**
 * Node props that point at the existing Asset and its stored Blob. Placing the same Asset twice
 * yields two nodes with the same src/assetId; no new Asset or Blob is created.
 */
export function assetNodeProps(asset: AssetRecord) {
  if (asset.kind === "image") return { type: "image-node" as const, props: { src: asset.storageReference, name: asset.filename, originalPath: asset.filename, assetId: asset.assetId, ...(asset.width && asset.height ? { naturalWidth: asset.width, naturalHeight: asset.height } : {}) } };
  if (asset.kind === "video") return { type: "video-node" as const, props: { src: asset.storageReference, name: asset.filename, originalPath: asset.filename, size: asset.fileSize ? formatBytes(asset.fileSize) : "—", duration: typeof asset.duration === "number" ? `${asset.duration.toFixed(1)} 秒` : "—", assetId: asset.assetId, ...(asset.fps ? { fps: asset.fps } : {}), ...(asset.sourceRunId ? { runId: asset.sourceRunId } : {}), ...(asset.shotId ? { shotId: asset.shotId } : {}) } };
  // The Audio node plays audio: refs (PyAV / library imports). Older media:-stored voices cannot be placed.
  if (!asset.storageReference.startsWith("audio:")) throw new Error("该声音以旧方式保存（media:），暂不能放到画布；仍可在角色中使用");
  return { type: "audio-node" as const, props: { src: asset.storageReference, name: asset.filename, duration: typeof asset.duration === "number" ? asset.duration : 0, assetId: asset.assetId, ...(asset.sourceVideoAssetId ? { sourceVideoAssetId: asset.sourceVideoAssetId } : {}), ...(asset.sourceAudioAssetId ? { sourceAudioAssetId: asset.sourceAudioAssetId } : {}), trimOpen: false } };
}

export const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Object URLs created by the library itself; all revoked when the drawer or a card unmounts. */
export class OwnedObjectUrls {
  private readonly urls = new Set<string>();
  private readonly api: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
  constructor(api: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void } = URL) { this.api = api; }
  create(blob: Blob) { const url = this.api.createObjectURL(blob); this.urls.add(url); return url; }
  adopt(url: string) { this.urls.add(url); return url; }
  release(url: string) { if (this.urls.delete(url)) this.api.revokeObjectURL(url); }
  revokeAll() { for (const url of this.urls) this.api.revokeObjectURL(url); this.urls.clear(); }
  get size() { return this.urls.size; }
}
