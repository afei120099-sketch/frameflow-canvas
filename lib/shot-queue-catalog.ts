import type { AssetRecord } from "./production-records.ts";
import type { RoleRecord } from "./role-records.ts";

export interface QueueCatalogShape { type: string; props: object }

/** Only media on this page or embedded in its nodes; never expand project-wide history. */
export function queueCatalogScope(shapes: readonly QueueCatalogShape[]) {
  const assetIds = new Set<string>(), sources = new Set<string>(), roleIds = new Set<string>();
  const add = (set: Set<string>, value: unknown) => { if (typeof value === "string" && value) set.add(value); };
  for (const { type, props: shapeProps } of shapes) {
    const props = shapeProps as Record<string, unknown>;
    if (type === "image-node" || type === "flux-image-node") {
      add(assetIds, props.assetId); add(sources, props.src);
      if (type === "flux-image-node" && Array.isArray(props.candidates)) {
        const adopted = props.candidates.find((item) => item?.assetId === props.adoptedAssetId);
        if (adopted) { add(assetIds, adopted.assetId); add(sources, adopted.src); }
      }
    }
    if (type === "h3-node" || type === "flux-image-node") {
      if (Array.isArray(props.roleIds)) props.roleIds.forEach((id) => add(roleIds, id));
      add(sources, props.sourceFrameSrc); add(sources, props.inputSrc);
      add(assetIds, props.previewAssetId);
      if (Array.isArray(props.referenceImages)) for (const image of props.referenceImages) add(sources, image?.src);
      if (Array.isArray(props.storyboardGuides)) for (const guide of props.storyboardGuides) {
        add(assetIds, guide?.assetId); add(sources, guide?.storageReference);
      }
    }
  }
  return { assetIds: [...assetIds].sort(), sources: [...sources].sort(), roleIds: [...roleIds].sort() };
}

export function buildQueueCatalog(scope: ReturnType<typeof queueCatalogScope>, roles: readonly RoleRecord[], images: readonly AssetRecord[]) {
  const ids = new Set(scope.assetIds), sources = new Set(scope.sources), selectedRoles = new Set(scope.roleIds);
  const pageImages = images.filter((image) => ids.has(image.assetId) || sources.has(image.storageReference));
  const pageImageIds = new Set(pageImages.map((image) => image.assetId));
  const pageRoles = roles.filter((role) => selectedRoles.has(role.roleId) || role.appearanceAssetIds.some((id) => pageImageIds.has(id)));
  // A bound role's main appearance is a real input on this page, even without a separate image node.
  for (const role of pageRoles) if (selectedRoles.has(role.roleId) && role.primaryAppearanceAssetId) pageImageIds.add(role.primaryAppearanceAssetId);
  return {
    roles: pageRoles.map((role) => ({ id: role.roleId, name: role.displayName, ready: Boolean(role.primaryAppearanceAssetId) })),
    images: images.filter((image) => pageImageIds.has(image.assetId)).map((image) => ({ id: image.assetId, name: image.filename })),
  };
}
