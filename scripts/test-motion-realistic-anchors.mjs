import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import "./fake-indexeddb.mjs";
import { findBlender, WHITEBOX_RENDER_SCRIPT } from "./blender-runtime.ts";
import { createBlenderRenderHandler } from "./blender-render-routes.ts";
import { startFakeComfy } from "./fake-comfyui.mjs";
import { motionPoseSnapshot, validateMotionGuideFrames, generateMotionRealisticAnchors } from "../lib/director-stage/motion-realistic-anchors.ts";
import { generateDepthFirstFrame } from "../lib/director-stage/depth-firstframe.ts";
import { planH3Handoff, runDirectorContext } from "../lib/director-stage/h3-handoff.ts";
import { registerAsset, getAsset } from "../lib/production-records.ts";
import { exportProject, readBackup } from "../lib/project-backup.ts";
import * as store from "../lib/director-stage/store.ts";

const pose = (position, rotation = [0, 0, 0], scale = [0.5, 1, 0.5]) => ({ position, rotation, scale });
const scene = await store.updateScene((await store.createScene({ name: "Motion anchor regression" })).id, { room: { width: 4, depth: 5, height: 2.8 } });
const prop = await store.createProp({ sceneId: scene.id, name: "chair", type: "chair", geometry: "box", transform: pose([0, 0, -0.8]) });
const camera = await store.createCamera({ sceneId: scene.id, name: "main", transform: pose([0, 1.4, 2], [-12, 0, 0], [1, 1, 1]), focalLength: 28, aspect: "9:16" });
const motion = await store.createMotion({ sceneId: scene.id, name: "fall", targetType: "prop", targetId: prop.id, keyframes: [
  { frame: 0, description: "standing", transform: prop.transform },
  { frame: 25, description: "text only" },
  { frame: 50, description: "tilted", transform: pose([-0.4, 0, -0.8], [-30, 0, 0]) },
  { frame: 100, description: "fallen", transform: pose([0.4, 0.1, -0.8], [-85, 0, 0]) },
] });
const before = structuredClone([scene, prop, camera, motion]);
const snapshot = (frame, tracks = [motion]) => motionPoseSnapshot(scene, [prop], [camera], tracks, motion.id, frame, camera.id);
for (const frame of [0, 50, 100]) assert.deepEqual(snapshot(frame).job.director.props[0].transform, motion.keyframes.find((key) => key.frame === frame).transform);
assert.deepEqual([scene, prop, camera, motion], before, "pure snapshots never mutate placements");
assert.notDeepEqual(snapshot(50).job, snapshot(100).job);
const cameraMotion = { ...motion, id: "camera-motion", targetType: "camera", targetId: camera.id, keyframes: [{ frame: 50, description: "", transform: pose([0.3, 1.6, 2], [-14, 5, 0], [2, 2, 2]) }] };
assert.deepEqual(snapshot(50, [motion, cameraMotion]).job.director.cameras[0].transform, { ...cameraMotion.keyframes[0].transform, scale: [1, 1, 1] });
assert.deepEqual(motionPoseSnapshot(scene, [prop], [camera], [cameraMotion], cameraMotion.id, 50, camera.id).job.director.cameras[0].transform.position, [0.3, 1.6, 2]);
assert.throws(() => motionPoseSnapshot(scene, [prop], [camera], [cameraMotion], cameraMotion.id, 50, 'other-camera'), /对应的渲染机位/);
assert.deepEqual(validateMotionGuideFrames(motion, [100, 50], 141), [50, 100]);
assert.throws(() => validateMotionGuideFrames(motion, [0], 141), /f0/);
assert.throws(() => validateMotionGuideFrames(motion, [25], 141), /文字/);
assert.throws(() => validateMotionGuideFrames(motion, [100], 90), /合法/);
assert.throws(() => validateMotionGuideFrames({ ...motion, keyframes: [...motion.keyframes, { frame: 141, description: "", transform: prop.transform }] }, [141], 141), /越界/);
assert.throws(() => validateMotionGuideFrames(motion, [50, 50], 141), /不重复/);
const frozen = new URL("../lib/comfyui/sdxl-depth-firstframe-workflow.json", import.meta.url);
assert.equal(createHash("sha256").update(readFileSync(frozen)).digest("hex"), "924a6bbbec6b395e96688c5495b89c341fef886531d694aad7268a1bf2e78b44");
assert.ok(findBlender(), "real portable Blender required for different-depth regression");
const work = mkdtempSync(path.join(tmpdir(), "frameflow-motion-anchors-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
writeFileSync(path.join(work, "fake.png"), png);
const fake = await startFakeComfy({ files: [{ seed: 0, path: path.join(work, "fake.png") }], runMs: 10 });
const handler = createBlenderRenderHandler({ blender: findBlender, script: WHITEBOX_RENDER_SCRIPT, timeoutMs: 90000 });
const server = createServer((req, res) => { req.url = req.url.slice("/__blender_render".length) || "/"; void handler(req, res); });
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const imported = [];
const importImage = async (file) => {
  const asset = await registerAsset({ kind: "image", origin: "imported", filename: file.name, mimeType: file.type, storageReference: `image:motion-${imported.length}`, sourceRunId: null });
  imported.push({ asset, file }); return asset;
};
const deps = { importImage, baseUrl, random: () => 0.25, comfy: { baseUrl: fake.url, pollMs: 10 } };
try {
  const results = await generateMotionRealisticAnchors({ sceneId: scene.id, cameraId: camera.id, motionId: motion.id, frames: [100, 50], length: 141, prompt: "wooden chair in study" }, deps);
  assert.equal(results.length, 2);
  assert.notDeepEqual(Buffer.from(await results[0].depth.file.arrayBuffer()), Buffer.from(await results[1].depth.file.arrayBuffer()), "real Blender depths differ between f50/f100");
  assert.deepEqual(results.map((row) => row.firstFrame.controlPackage.anchorFrame), [50, 100]);
  for (const row of results) {
    const guide = row.firstFrame.controlPackage;
    assert.equal(guide.type, "guide"); assert.equal(guide.render.motion.motionId, motion.id);
    assert.equal(guide.render.motion.frame, guide.anchorFrame); assert.equal(guide.render.motion.generationLength, 141);
    assert.equal(guide.render.generator.sourceDepthAssetId, row.depth.asset.assetId);
    assert.equal(guide.render.generator.sourceDepthPackageId, row.depth.controlPackage.id);
    assert.equal(guide.render.generator.template, "SDXL_DEPTH_FIRSTFRAME_V0.1");
    assert.ok(guide.render.generator.templateSha.startsWith("sha256:"));
    assert.equal(guide.render.cameraId, camera.id); assert.equal(guide.render.sceneId, scene.id);
  }
  assert.equal(results[0].firstFrame.controlPackage.render.motion.batchId, results[1].firstFrame.controlPackage.render.motion.batchId);
  assert.deepEqual(await store.getProp(prop.id), before[1]); assert.deepEqual(await store.getCamera(camera.id), before[2]);
  const first = await generateDepthFirstFrame(scene.id, camera.id, "wooden chair", deps);
  assert.equal(first.firstFrame.controlPackage.type, "first_frame"); assert.equal(first.firstFrame.controlPackage.render.motion, undefined);
  const assets = await Promise.all(imported.map((row) => getAsset(row.asset.assetId)));
  const request = { sceneId: scene.id, sceneStateId: null, firstFramePackage: first.firstFrame.controlPackage, lastFramePackage: null, referencePackage: null };
  const lookup = (id) => assets.find((asset) => asset.assetId === id) ?? null;
  const plan = planH3Handoff({ ...request, guidePackages: results.map((row) => row.firstFrame.controlPackage).reverse() }, [], lookup);
  assert.deepEqual(plan.guides.map((guide) => guide.anchorFrame), [50, 100]);
  assert.equal(plan.expectedMode, "i2va_guide"); assert.equal(plan.generationLength, 141);
  assert.deepEqual(plan.context.motionIds, [motion.id]);
  const run = runDirectorContext(plan.context, plan.context.assetIds);
  assert.deepEqual(run.anchorFrames, [50, 100]); assert.deepEqual(run.motionIds, [motion.id]); assert.equal(run.inputsMatchHandoff, true);
  assert.equal(planH3Handoff(request, [], lookup).expectedMode, "i2va");
  assert.throws(() => planH3Handoff({ ...request, guidePackages: [{ ...results[0].firstFrame.controlPackage, anchorFrame: 141 }] }, [], lookup), /超出当前生成长度/);
  assert.throws(() => planH3Handoff({ ...request, guidePackages: results.map((row,index) => ({ ...row.firstFrame.controlPackage, render: { ...row.firstFrame.controlPackage.render, motion: { ...row.firstFrame.controlPackage.render.motion, generationLength: index ? 158 : 141 } } })) }, [], lookup), /生成长度不一致/);
  // New optional provenance survives the existing backup / refresh contract without a DB migration.
  const files = new Map();
  await exportProject(null, { writeText: async (name, text) => files.set(name, new Blob([text])), writeBlob: async (name, blob) => files.set(name, blob) }, { appVersion: "motion-anchor-test", persistenceKey: "isolated" });
  const restored = await readBackup({ has: (name) => files.has(name), readText: async (name) => files.get(name).text(), readBlob: async (name) => files.get(name), size: (name) => files.get(name)?.size ?? null });
  assert.deepEqual(restored.director.controlPackages.filter((pack) => pack.type === "guide"), results.map((row) => row.firstFrame.controlPackage));
  fake.state.failures.push("SDXL failure");
  await assert.rejects(generateMotionRealisticAnchors({ sceneId: scene.id, cameraId: camera.id, motionId: motion.id, frames: [50], length: 141, prompt: "wooden chair" }, deps), /f50 失败.*深度图已登记/);
  console.log("Motion realistic anchors PASS: real Blender f50/f100 different depth; fake SDXL; provenance, sorting, range, f0/text refusal, unchanged placements/first-frame/Run hand-off; no AI GPU inference");
} finally {
  await new Promise((closed) => server.close(closed)); await fake.close?.(); rmSync(work, { recursive: true, force: true });
}
