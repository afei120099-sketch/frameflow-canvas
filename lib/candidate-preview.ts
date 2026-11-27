import type { AssetRecord } from './production-records.ts';
/** Only live versions are passed here. Stale/deleted IDs cannot hide valid results. */
export function resolveCandidatePreview(versions: AssetRecord[], ids: (string | null | undefined)[]) {
  for (const id of ids) {
    const asset = versions.find(asset => asset.assetId === id);
    if (asset) return asset;
  }
  return versions.at(-1);
}
