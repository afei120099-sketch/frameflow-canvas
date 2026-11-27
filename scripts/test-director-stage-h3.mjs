import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import "./fake-indexeddb.mjs";
import { planH3Handoff, runDirectorContext } from "../lib/director-stage/h3-handoff.ts";
import { planH3Submission } from "../lib/comfyui/h3-adapter.ts";
import { resolveH3TaskMode } from "../lib/h3-task-mode.ts";
import { createRun, getRun } from "../lib/production-records.ts";

// Director Stage → H3 V0.1: package validation, the mode the H3 node will resolve to, the unchanged
// H3 workflow it produces, and Run.directorContext. No canvas, no ComfyUI, no GPU.

const assets = {
  first: { assetId: "img-first", kind: "image", storageReference: "image:first", filename: "chair-first.png", width: 1088, height: 1920 },
  last: { assetId: "img-last", kind: "image", storageReference: "image:last", filename: "chair-fallen.png", width: 1088, height: 1920 },
  ref: { assetId: "img-ref", kind: "image", storageReference: "image:ref", filename: "chair-detail.png" },
  clip: { assetId: "vid-ref", kind: "video", storageReference: "media:clip", filename: "room.mp4" },
  voice: { assetId: "aud-ref", kind: "audio", storageReference: "audio:voice", filename: "voice.wav" },
};
const lookup = (assetId) => Object.values(assets).find((asset) => asset.assetId === assetId) ?? null;
const pack = (id, type, assetIds, sceneId = "scene-1") => ({ schemaVersion: 1, id, sceneId, name: id, type, assetIds, createdAt: 1, updatedAt: 1 });
const states = [{ schemaVersion: 1, id: "state-fallen", sceneId: "scene-1", name: "椅子倒地", propChanges: [], createdAt: 1, updatedAt: 1 }];
const request = (overrides) => ({ sceneId: "scene-1", sceneStateId: null, firstFramePackage: null, lastFramePackage: null, referencePackage: null, ...overrides });
const firstPack = pack("pk-first", "first_frame", ["img-first"]);
const lastPack = pack("pk-last", "last_frame", ["img-last"]);
const refPack = pack("pk-ref", "reference", ["img-ref", "vid-ref", "aud-ref"]);

// 1. first_frame → I2VA, with the scene state recorded.
const i2va = planH3Handoff(request({ firstFramePackage: firstPack, sceneStateId: "state-fallen" }), states, lookup);
assert.equal(i2va.expectedMode, "i2va");
assert.equal(i2va.firstFrame.assetId, "img-first");
assert.deepEqual(i2va.context, { sceneId: "scene-1", sceneStateId: "state-fallen", controlPackageIds: ["pk-first"], assetIds: ["img-first"] });

// 2. first + last → FL2VA.
const fl2va = planH3Handoff(request({ firstFramePackage: firstPack, lastFramePackage: lastPack }), states, lookup);
assert.equal(fl2va.expectedMode, "fl2va");
assert.equal(fl2va.lastFrame.assetId, "img-last");
assert.equal("sceneStateId" in fl2va.context, false);

// 3. reference (+ optional first) → Ref2VA with images / videos / audios split as the H3 node expects.
const ref2va = planH3Handoff(request({ firstFramePackage: firstPack, referencePackage: refPack }), states, lookup);
assert.equal(ref2va.expectedMode, "ref2va");
assert.deepEqual([ref2va.referenceImages, ref2va.referenceVideos, ref2va.referenceAudios].map((list) => list.map((asset) => asset.assetId)), [["img-ref"], ["vid-ref"], ["aud-ref"]]);
assert.deepEqual(ref2va.context.controlPackageIds, ["pk-first", "pk-ref"]);

// The planner agrees with the H3 node's own mode resolution for every accepted combination.
for (const plan of [i2va, fl2va, ref2va]) assert.equal(resolveH3TaskMode({ hasFirstFrame: Boolean(plan.firstFrame), hasLastFrame: Boolean(plan.lastFrame), hasReferences: plan.referenceImages.length + plan.referenceVideos.length + plan.referenceAudios.length > 0 }).mode, plan.expectedMode);

// 4. Refusals (same rules the H3 node enforces; nothing reaches the canvas).
const refuse = (overrides, pattern) => assert.throws(() => planH3Handoff(request(overrides), states, lookup), pattern);
refuse({}, /至少选择一个首帧包或参考包/);
refuse({ lastFramePackage: lastPack }, /需要同时选择首帧包/);
refuse({ firstFramePackage: firstPack, lastFramePackage: lastPack, referencePackage: refPack }, /多参考模式暂不支持同时锁定尾帧/);
refuse({ firstFramePackage: pack("pk-empty", "first_frame", []) }, /需要绑定 1 张图片/);
refuse({ firstFramePackage: pack("pk-video", "first_frame", ["vid-ref"]) }, /只能引用图片/);
refuse({ firstFramePackage: pack("pk-gone", "first_frame", ["deleted-asset"]) }, /素材记录不存在/);
refuse({ firstFramePackage: lastPack }, /不是首帧类型/);
refuse({ firstFramePackage: pack("pk-other", "first_frame", ["img-first"], "scene-2") }, /不属于当前场景/);
refuse({ referencePackage: pack("pk-ref-empty", "reference", []) }, /还没有绑定素材/);
refuse({ firstFramePackage: firstPack, sceneStateId: "state-elsewhere" }, /所选状态不属于当前场景/);

// 5. The H3 workflow is the unchanged frozen I2VA template: the first-frame image is the only input.
const settings = { length: 141, aspect: "follow", megapixels: 0.5, turbo: true, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32, soundMode: "av" };
const templateBefore = createHash("sha256").update(await readFile(new URL("../lib/comfyui/h3-workflow.json", import.meta.url))).digest("hex");
// Retired 2026-11-10: the old stable I2VA path is blocked; Director Stage hand-offs go to ultimate/fast H3 nodes.
assert.throws(() => planH3Submission({ taskMode: "i2va", prompt: "A chair stands at the desk.", seed: 7, settings }, { imageName: "uploaded-chair-first.png", references: { images: [], videos: [], audios: [] } }), /已停用/);
assert.equal(templateBefore, "53131f30550f78d686762033432606bee5a7a0ecc0b7820d99e3b82d1f8dc195", "frozen FL2VA/I2VA template untouched");

// 6. Run.directorContext: IDs only, plus whether the node's inputs still match the hand-off.
const context = runDirectorContext(i2va.context, ["img-first"]);
assert.deepEqual(context, { sceneId: "scene-1", sceneStateId: "state-fallen", controlPackageIds: ["pk-first"], handoffAssetIds: ["img-first"], inputsMatchHandoff: true });
assert.equal(runDirectorContext(i2va.context, ["img-other"]).inputsMatchHandoff, false, "inputs changed after the hand-off are flagged");
assert.equal(runDirectorContext(fl2va.context, ["img-first", "img-last"]).sceneStateId, null);
const run = await createRun({ capabilityId: "h3_fl2va", parameters: {}, workflowIdentity: { capabilityId: "h3_fl2va", templateVersion: "sha256:53131f30", templateFile: "h3-workflow.json" }, inputAssetIds: ["img-first"], rawPrompt: "x", finalPrompt: "x", seed: 7, taskMode: "i2va", directorContext: context }, { reservePromptId: true });
assert.deepEqual((await getRun(run.runId)).directorContext, context);
const plain = await createRun({ capabilityId: "h3_fl2va", parameters: {}, workflowIdentity: { capabilityId: "h3_fl2va", templateVersion: "sha256:53131f30", templateFile: "h3-workflow.json" }, inputAssetIds: [], rawPrompt: "x", finalPrompt: "x", seed: 7, taskMode: "t2va" });
assert.equal("directorContext" in (await getRun(plain.runId)), false, "Runs not from the Director Stage carry no directorContext");

// 7. 🧪 Guide packages (AddGuide experimental): sorted by anchorFrame, I2VA only, recorded in the Run context.
const moved = { assetId: "img-moved", kind: "image", storageReference: "image:moved", filename: "chair-moved.png" };
const lookupWithMoved = (assetId) => assetId === "img-moved" ? moved : lookup(assetId);
const guide = (id, assetIds, anchorFrame) => ({ ...pack(id, "guide", assetIds), ...(anchorFrame === undefined ? {} : { anchorFrame }) });
const guideLate = guide("pk-guide-late", ["img-moved"], 117);
const guideMid = guide("pk-guide-mid", ["img-last"], 47);
const guided = planH3Handoff(request({ firstFramePackage: firstPack, guidePackages: [guideLate, guideMid], sceneStateId: "state-fallen" }), states, lookupWithMoved);
assert.equal(guided.expectedMode, "i2va_guide");
assert.deepEqual(guided.guides.map((item) => [item.packageId, item.anchorFrame, item.assetId]), [["pk-guide-mid", 47, "img-last"], ["pk-guide-late", 117, "img-moved"]]);
assert.deepEqual(guided.context.controlPackageIds, ["pk-first", "pk-guide-mid", "pk-guide-late"]);
assert.deepEqual(guided.context.assetIds, ["img-first", "img-last", "img-moved"]);
const guidedRun = runDirectorContext(guided.context, ["img-first", "img-last", "img-moved"]);
assert.deepEqual(guidedRun.guidePackageIds, ["pk-guide-mid", "pk-guide-late"]);
assert.deepEqual(guidedRun.anchorFrames, [47, 117]);
assert.equal(guidedRun.inputsMatchHandoff, true);
assert.equal(runDirectorContext({ ...guided.context, guides: [] }, ["img-first"]).inputsMatchHandoff, false, "removing guides on the node is visible in the Run");
assert.equal("guidePackageIds" in runDirectorContext(i2va.context, ["img-first"]), false, "no guide fields without guides");
const refuseGuide = (overrides, pattern) => assert.throws(() => planH3Handoff(request(overrides), states, lookupWithMoved), pattern);
refuseGuide({ guidePackages: [guideMid] }, /引导锚点需要同时选择首帧包/);
refuseGuide({ firstFramePackage: firstPack, lastFramePackage: lastPack, guidePackages: [guideMid] }, /只支持“首帧 \+ 引导锚点”/);
refuseGuide({ firstFramePackage: firstPack, referencePackage: refPack, guidePackages: [guideMid] }, /只支持“首帧 \+ 引导锚点”/);
refuseGuide({ firstFramePackage: firstPack, guidePackages: [guide("pk-no-anchor", ["img-last"])] }, /还没有设置锚点帧/);
refuseGuide({ firstFramePackage: firstPack, guidePackages: [guide("pk-video", ["vid-ref"], 60)] }, /需要绑定 1 张图片/);
refuseGuide({ firstFramePackage: firstPack, guidePackages: [guide("pk-two", ["img-last", "img-moved"], 60)] }, /需要绑定 1 张图片/);
refuseGuide({ firstFramePackage: firstPack, guidePackages: [guideMid, guide("pk-same", ["img-moved"], 47)] }, /同一帧 47/);
refuseGuide({ firstFramePackage: firstPack, guidePackages: [1, 2, 3, 4, 5].map((n) => guide(`pk-g${n}`, ["img-last"], n * 20)) }, /最多 4 个/);
refuseGuide({ firstFramePackage: firstPack, guidePackages: [{ ...guideMid, type: "reference" }] }, /不是引导锚点类型/);

console.log("Director Stage → H3: first/last/reference mapping, mode agreement with the H3 node, refusals, unchanged frozen workflow, Run.directorContext, 🧪 guide anchors passed");
