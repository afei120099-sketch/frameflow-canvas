/** Display name stored on Asset.filename. The asset id and media bytes stay the same. */
export function normalizeAssetFilename(input: string): string {
  const name = input.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("名称不能为空");
  if (/[\\/\u0000-\u001f]/.test(name)) throw new Error("名称不能包含斜杠或换行");
  if ([...name].length > 80) throw new Error("名称最多 80 个字");
  return name;
}

export const ASSET_RENAMED_EVENT = "frameflow-asset-renamed";

export function announceAssetRenamed(assetId: string, filename: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ASSET_RENAMED_EVENT, { detail: { assetId, filename } }));
}
