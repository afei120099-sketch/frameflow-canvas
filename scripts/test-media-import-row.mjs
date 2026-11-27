import assert from "node:assert/strict";
import { createMediaImportRow } from "../lib/media-import-row.ts";
import { selectedImageCatalog, formatImageCatalog } from "../lib/selected-image-catalog.ts";

const place = createMediaImportRow({ x: 500, y: 400 });
const first = place(320, 220), second = place(220, 450), third = place(600, 300);
assert.deepEqual(first, { x: 340, y: 290 });
assert.equal(second.x - (first.x + 320), 100);
assert.equal(third.x - (second.x + 220), 100);
assert.equal(second.y, first.y); assert.equal(third.y, first.y);
assert.throws(() => place(0, 20), /尺寸/);
const shapes = [
  { id: "b", type: "image-node", x: 600, y: 10, props: { name: "场景B.jpg", assetId: "asset-b" } },
  { id: "a", type: "image-node", x: 0, y: 10, props: { name: "场景A.jpg", assetId: "asset-a" } },
  { id: "c", type: "flux-image-node", x: 1000, y: 10, props: { filename: "生成图.png", assetId: "asset-c", src: "image:test" } },
  { id: "d", type: "flux-image-node", x: 0, y: 0, props: {} },
  { id: "e", type: "video-node", x: 0, y: 0, props: { name: "视频.mp4" } },
];
const before = structuredClone(shapes);
assert.deepEqual(selectedImageCatalog(shapes), [
  { name: "场景A.jpg", assetId: "asset-a" }, { name: "场景B.jpg", assetId: "asset-b" }, { name: "生成图.png", assetId: "asset-c" },
]);
assert.equal(formatImageCatalog(selectedImageCatalog(shapes)), "场景A.jpg\tasset-a\n场景B.jpg\tasset-b\n生成图.png\tasset-c");
assert.deepEqual(shapes, before);
console.log("PASS: variable-width horizontal placement, 100-unit gap, top alignment, names + asset IDs, generated images, excludes empty/video, preserves original selection");
