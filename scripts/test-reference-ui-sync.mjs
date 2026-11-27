import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const canvas = readFileSync(new URL("../app/canvas-workspace.tsx", import.meta.url), "utf8");
const component = readFileSync(new URL("../components/canvas/storyboard-guide-editor.tsx", import.meta.url), "utf8");
const start = canvas.indexOf("function selectedReferenceImages(");
const end = canvas.indexOf("async function runPortAction(", start);
assert(start >= 0 && end > start);
const js = ts.transpileModule(canvas.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const collect = runInNewContext(js + "; selectedReferenceImages;");
const shapes = {
  group: { id: "group", type: "group" }, nested: { id: "nested", type: "group" },
  a: { id: "a", type: "image-node", x: 500, y: 0 },
  b: { id: "b", type: "image-node", x: 0, y: 0 },
  video: { id: "video", type: "video-node" },
};
const editor = {
  getSelectedShapeIds: () => ["group", "b", "video", "missing"],
  getShape: id => shapes[id],
  getSortedChildIdsForParent: id => id === "group" ? ["a", "nested"] : ["b"],
  getShapePageBounds: shape => ({ x: shape.id === "a" ? 10 : 100, y: 0 }),
};
assert.equal(collect(editor).map(shape => shape.id).join(","), "a,b", "expand groups, dedupe, ignore videos, order by page position");
editor.getSelectedShapeIds = () => ["b"];
assert.equal(collect(editor).map(shape => shape.id).join(","), "b");
editor.getSelectedShapeIds = () => [];
assert.equal(collect(editor).length, 0);
for (const [index, id] of ["c", "d"].entries()) shapes[id] = { id, type: "image-node", x: index * 100, y: 200 };
editor.getSelectedShapeIds = () => ["a", "b", "c", "d"];
assert.equal(collect(editor).length, 4, "all four selected images are collected");
assert.match(canvas, /<BatchReferenceAction editor=\{editor\}/);
assert.match(canvas, /data-testid="batch-reference-action"/);
assert.match(canvas, /captured\.current = \[\.\.\.selection\.ids\]/);
assert.match(canvas, /await runPortAction\(editor, source, undefined, undefined, ids\)/);
assert.match(canvas, /selection\.ids\.length\}图生成视频/);
assert.match(canvas, /StoryboardGuideEditor referenceSlots=\{allReferenceImages\.map/);
assert.match(canvas, /runPortAction\(editor, shape, undefined, undefined, state\.referenceIds\)/);
assert.match(canvas, /referenceIds: state\.referenceIds/);
assert.match(canvas, /connectionMenu\.page, undefined, connectionMenu\.referenceIds/);
assert.match(canvas, /state\.referenceIds\.length > 1/);
assert.match(component, /referenceSlots\.length && !guide && slot !== freeSlot/);
console.log("PASS: grouped/multiple selections, dedupe and page ordering; sequence reference view and batch click/drop wiring (no browser/GPU)");
