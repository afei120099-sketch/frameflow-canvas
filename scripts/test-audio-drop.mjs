import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../app/canvas-workspace.tsx", import.meta.url), "utf8");
const line = source.split("\n").find(line => line.includes('registerExternalContentHandler("files"'));
let handler;
const placed = [], videos = [], errors = [];
const editor = { registerExternalContentHandler: (_type, fn) => handler = fn, getViewportPageBounds: () => ({ center: { x: 0, y: 0 } }) };
runInNewContext(ts.transpileModule(line, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
  mountedEditor: editor, importAssetOnly: async (kind, file) => ({ kind, filename: file.name }),
  placeAssetOnCanvas: async (_editor, asset, point) => placed.push({ asset, point }),
  addVideoFile: async (_editor, file) => videos.push(file.name), addImageFile: async () => {}, showToast: text => errors.push(text),
});
await handler({ files: [{ name: "录音.M4A", type: "video/mp4" }, { name: "空类型.m4a", type: "" }, { name: "声音.mp3", type: "audio/mpeg" }, { name: "片段.mp4", type: "video/mp4" }], point: { x: 10, y: 20 } });
assert.equal(placed.length, 3);
assert.equal(placed.every(item => item.asset.kind === "audio"), true);
assert.equal(placed[0].point.x, 10);
assert.equal(placed[1].point.x, 38);
assert.deepEqual(videos, ["片段.mp4"]);
assert.equal(errors.length, 0);
console.log("PASS: M4A MIME fallback, audio drop placement and MP4 routing (not actual playback)");
