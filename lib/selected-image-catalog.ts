type CatalogShape = { id: string; type: string; x: number; y: number; props: object };
export function selectedImageCatalog(shapes: CatalogShape[]) {
  return shapes.filter(shape => shape.type === "image-node" || (shape.type === "flux-image-node" && !!(shape.props as { src?: string }).src))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
    .map(shape => {
      const props = shape.props as { name?: string; filename?: string; assetId?: string };
      return { name: props.name || props.filename || "未命名图片", assetId: props.assetId || "" };
    });
}
export function formatImageCatalog(items: { name: string; assetId: string }[]) {
  return items.map(item => `${item.name.replace(/[\r\n\t]+/g, " ")}\t${item.assetId}`).join("\n");
}
