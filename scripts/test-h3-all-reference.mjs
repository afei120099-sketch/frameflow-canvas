import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveH3TaskMode } from "../lib/h3-task-mode.ts";
import { planH3Submission } from "../lib/comfyui/h3-adapter.ts";

const source = await readFile(new URL("../app/canvas-workspace.tsx", import.meta.url), "utf8");
assert.match(source, /allReferenceMode: T\.optional\(T\.boolean\)/, "mode is persisted without requiring old shapes to migrate");
assert.match(source, /useState\(shape\.props\.allReferenceMode \? "多参考"/, "restores the selected tab");
assert.match(source, /shape\.props\.allReferenceMode === true \|\| communityWorkflow/, "explicit reference mode affects actual routing");
assert.match(source, /view === "多参考" \? "全能参考" : view/, "visible full-reference tab");
assert.match(source, /update\(\{ allReferenceMode: view === "多参考" \}\)/);
assert.match(source, /全能参考无需首帧，请先添加/);
for (const kind of ["Image", "Video", "Audio"]) assert.match(source, new RegExp(`reference${kind}Input\\.current\\?\\.click\\(\\)`));
assert.match(source, /当前工作流仅支持1–4张图片/);
assert.match(source, /referenceVideos\.map\(\(item, index\) => <ReferenceSlot key=\{`mini-video/);
assert.match(source, /referenceAudios\.map\(\(item, index\) => <ReferenceSlot key=\{`mini-audio/);

const settings = { length: 141, aspect: "9:16", megapixels: 0.5, turbo: true, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32, soundMode: "av" };
const input = { prompt: "人物在现场行走", compiledPrompt: "P", seed: 7, settings, referenceMode: true, taskMode: "ref2va" };
for (const references of [
  { images: ["scene.png", "person.png"], videos: [], audios: [] },
  { images: [], videos: ["motion.mp4"], audios: [] },
  { images: ["scene.png", "person.png"], videos: ["motion.mp4"], audios: ["voice.wav"] },
]) {
  assert.equal(resolveH3TaskMode({ hasFirstFrame: false, hasLastFrame: false, hasReferences: true }).mode, "ref2va");
  const result = planH3Submission(input, { references });
  assert.equal(result.taskMode, "ref2va");
  assert.equal(result.saveNodeId, "92");
  const nodes = Object.values(result.workflow);
  assert.ok(nodes.some((node) => node.class_type === "MiniMaxH3ReferenceToVideo"));
  for (const image of references.images) assert.ok(nodes.some((node) => node.class_type === "LoadImage" && node.inputs.image === image));
  if (references.videos.length) assert.ok(nodes.some((node) => node.class_type === "LoadVideo"));
  if (references.audios.length) assert.ok(nodes.some((node) => node.class_type === "LoadAudio"));
}
const firstAsReference = planH3Submission(input, { imageName: "scene.png", references: { images: [], videos: [], audios: [] } });
assert.equal(firstAsReference.taskMode, "ref2va", "connected image is a reference, not a mandatory locked first frame");
assert.throws(() => planH3Submission(input, { imageName: "scene.png", lastImageName: "tail.png", references: { images: [], videos: [], audios: [] } }), /尾帧/, "existing tail locks are never silently discarded");
console.log("PASS: full-reference UI wiring and image/video/audio graph routing (no GPU submission)");
