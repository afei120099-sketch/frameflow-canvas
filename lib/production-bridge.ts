import { getAsset } from "./production-records.ts";
import { getLocalAudioBlob, getLocalImageBlob } from "./local-video-store.ts";
import { listRoles } from "./role-records.ts";
import { currentLibraryScope } from "./canvas-library-scope.ts";

/**
 * Read-only bridge for the 生产线 page (opened from the canvas with window.open, same origin): it can
 * call window.opener.frameflowProduction to copy roles out of the canvas — face crop, primary
 * appearance, primary voice — using the canvas's own page-scoped role and media readers.
 * Nothing here writes to the canvas.
 */

export interface BridgeMedia { blob: Blob; filename: string }
export interface BridgeRole { roleId: string; displayName: string; description: string; face: BridgeMedia | null; appearance: BridgeMedia | null; voice: BridgeMedia | null }

async function media(assetId: string | null | undefined, kind: "image" | "audio"): Promise<BridgeMedia | null> {
  if (!assetId) return null;
  const asset = await getAsset(assetId).catch(() => null);
  if (!asset?.storageReference) return null;
  const blob = kind === "image" ? await getLocalImageBlob(asset.storageReference) : await getLocalAudioBlob(asset.storageReference);
  return blob.size ? { blob, filename: asset.filename || `${assetId}.${kind === "image" ? "png" : "wav"}` } : null;
}

export function installProductionBridge() {
  const api = {
    version: 1,
    /** The canvas page the user is looking at, so the 生产线 matches that page's roles first. */
    currentPageId: () => currentLibraryScope()?.pageId ?? "",
    async listRoles() {
      return (await listRoles()).map((role) => ({
        roleId: role.roleId, displayName: role.displayName, description: role.description,
        hasFace: Boolean(role.faceReferenceAssetId), hasAppearance: Boolean(role.primaryAppearanceAssetId), hasVoice: Boolean(role.primaryVoiceAssetId),
      }));
    },
    async exportRole(roleId: string): Promise<BridgeRole> {
      const role = (await listRoles()).find((item) => item.roleId === roleId);
      if (!role) throw new Error("当前画布页没有这个角色");
      const [face, appearance, voice] = await Promise.all([
        media(role.faceReferenceAssetId ?? null, "image"),
        media(role.primaryAppearanceAssetId, "image"),
        media(role.primaryVoiceAssetId, "audio"),
      ]);
      // Without a dedicated face crop, the primary appearance is the best available face reference.
      return { roleId: role.roleId, displayName: role.displayName, description: [role.description, role.defaultClothing, role.hair].filter(Boolean).join("；"), face: face ?? appearance, appearance, voice };
    },
  };
  const target = window as unknown as { frameflowProduction?: typeof api };
  target.frameflowProduction = api;
  return () => { if (target.frameflowProduction === api) delete target.frameflowProduction; };
}
