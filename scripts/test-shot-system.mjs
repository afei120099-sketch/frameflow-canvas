import assert from "node:assert/strict";
import "./fake-indexeddb.mjs";
import { planH3Handoff, runDirectorContext, shotHandoffRequest } from "../lib/director-stage/h3-handoff.ts";
import * as director from "../lib/director-stage/store.ts";
import { addRunToShot, createRun, createShot, getRun, getShot, getShotCandidates, linkShotToH3Node, listShots, markShotHasCandidates, registerAsset, updateRun, updateShotDirector } from "../lib/production-records.ts";

// Shot System V0.1: a Shot (the existing record, no second database) gains an optional 导演台 binding;
// its H3 hand-off is planned from that binding, and Runs / candidates attach to it as before.

const t = (position, rotation) => ({ position, rotation, scale: [1, 1, 1] });

// Director Stage records: chair fall scene with a camera, a Motion, a first-frame and a 🧪 guide package.
const scene = await director.createScene({ name: "椅子倒下" });
const chair = await director.createProp({ sceneId: scene.id, name: "椅子", type: "chair" });
const fallen = await director.createSceneState({ sceneId: scene.id, name: "椅子倒地", propChanges: [{ propId: chair.id, description: "侧倒" }] });
const camera = await director.createCamera({ sceneId: scene.id, name: "主机位", transform: t([1.7, 1.3, 1.6], [-20, 32, 0]), focalLength: 28, aspect: "9:16" });
const motion = await director.createMotion({ sceneId: scene.id, name: "椅子倒下", targetType: "prop", targetId: chair.id, keyframes: [{ frame: 0, description: "站立" }, { frame: 100, description: "倒地" }] });
const firstImage = await registerAsset({ kind: "image", origin: "imported", filename: "白模首帧.png", mimeType: "image/png", storageReference: "image:first", sourceRunId: null, width: 720, height: 1280 });
const guideImage = await registerAsset({ kind: "image", origin: "imported", filename: "倒地.png", mimeType: "image/png", storageReference: "image:guide", sourceRunId: null, width: 720, height: 1280 });
const firstPack = await director.createControlPackage({ sceneId: scene.id, name: "白模首帧", type: "first_frame", assetIds: [firstImage.assetId] });
const guidePack = await director.createControlPackage({ sceneId: scene.id, name: "倒地锚点", type: "guide", assetIds: [guideImage.assetId], anchorFrame: 100 });
const lookup = (assetId) => [firstImage, guideImage].map((asset) => ({ assetId: asset.assetId, kind: asset.kind, storageReference: asset.storageReference, filename: asset.filename, width: asset.width, height: asset.height })).find((asset) => asset.assetId === assetId) ?? null;
const sceneRecords = async () => ({ packages: await director.listControlPackages(scene.id), cameras: await director.listCameras(scene.id), motions: await director.listMotions(scene.id) });

// 1. Create a Shot in 导演台 (same Shot store, same numbering as canvas Shots); canvas Shots stay unchanged.
const canvasShot = await createShot("", "shape:h3-canvas");
assert.equal("director" in canvasShot, false, "canvas Shots have no binding");
const binding = { sceneId: scene.id, sceneStateId: null, cameraId: camera.id, motionIds: [motion.id], firstFramePackageId: firstPack.id, lastFramePackageId: null, referencePackageId: null, guidePackageIds: [] };
const shot = await createShot("", undefined, binding);
assert.equal(shot.shotNumber, canvasShot.shotNumber + 1, "one numbering for all Shots");
assert.equal(shot.title, `镜头 ${String(shot.shotNumber).padStart(2, "0")}`);
assert.equal(shot.sourceH3NodeId, undefined, "not on the canvas yet");
assert.deepEqual((await getShot(shot.shotId)).director, binding);
assert.deepEqual((await listShots()).filter((row) => row.director).map((row) => row.shotId), [shot.shotId]);

// 2. Bind Scene + State + Camera + Motion + Control (first frame + 🧪 guide); title edit; runIds untouched.
const bound = { ...binding, sceneStateId: fallen.id, guidePackageIds: [guidePack.id] };
const edited = await updateShotDirector(shot.shotId, bound, "椅子倒下 · 主机位");
assert.equal(edited.title, "椅子倒下 · 主机位");
assert.deepEqual(edited.director, bound);
assert.deepEqual(edited.runIds, []);

// 3. One-click H3: the plan comes from the binding (I2VA + 🧪 guide), carrying Camera / Motion as records.
const plan = planH3Handoff(shotHandoffRequest(edited.director, await sceneRecords()), await director.listSceneStates(scene.id), lookup);
assert.equal(plan.expectedMode, "i2va_guide");
assert.equal(plan.firstFrame.assetId, firstImage.assetId);
assert.deepEqual(plan.guides.map((guide) => [guide.packageId, guide.anchorFrame]), [[guidePack.id, 100]]);
assert.deepEqual(plan.context, { sceneId: scene.id, sceneStateId: fallen.id, controlPackageIds: [firstPack.id, guidePack.id], assetIds: [firstImage.assetId, guideImage.assetId], guides: plan.guides, cameraId: camera.id, motionIds: [motion.id] });
// Dangling bindings are refused before H3.
assert.throws(() => shotHandoffRequest({ ...bound, firstFramePackageId: "gone" }, { packages: [], cameras: [camera], motions: [motion] }), /首帧包已被删除/);
assert.throws(() => shotHandoffRequest({ ...bound, cameraId: "gone" }, { packages: [firstPack, guidePack], cameras: [], motions: [motion] }), /摄影机已被删除/);
assert.throws(() => shotHandoffRequest({ ...bound, motionIds: ["gone"] }, { packages: [firstPack, guidePack], cameras: [camera], motions: [] }), /动作已被删除/);
const records = await sceneRecords();
assert.throws(() => planH3Handoff(shotHandoffRequest({ ...bound, firstFramePackageId: null }, records), [], lookup), /引导锚点需要同时选择首帧包/);

// The canvas links the new H3 node to this Shot (instead of creating another one).
const linked = await linkShotToH3Node(shot.shotId, "shape:h3-director");
assert.equal(linked.sourceH3NodeId, "shape:h3-director");
assert.equal(linked.shotNumber, shot.shotNumber);

// 4. The H3 node's Run attaches to the Shot (same calls as the H3 node), with the director context.
const runContext = runDirectorContext(plan.context, [firstImage.assetId, guideImage.assetId]);
assert.deepEqual([runContext.cameraId, runContext.motionIds, runContext.guidePackageIds, runContext.inputsMatchHandoff], [camera.id, [motion.id], [guidePack.id], true]);
const runRecord = await createRun({ capabilityId: "h3_addguide_experimental", parameters: {}, workflowIdentity: { capabilityId: "h3_addguide_experimental", templateVersion: "sha256:test", templateFile: "h3-i2va-addguide-workflow.json" }, shotId: shot.shotId, inputAssetIds: [firstImage.assetId, guideImage.assetId], rawPrompt: "椅子慢慢倒下", finalPrompt: "椅子慢慢倒下", seed: 7, ownerNodeId: "shape:h3-director", directorContext: runContext });
await addRunToShot(shot.shotId, runRecord.runId);
assert.equal((await getRun(runRecord.runId)).shotId, shot.shotId);
assert.deepEqual((await getRun(runRecord.runId)).directorContext.motionIds, [motion.id]);

// 5. The finished video becomes a candidate of the Shot; the binding survives every Shot update.
const video = await registerAsset({ kind: "video", origin: "generated", filename: "镜头_A.mp4", mimeType: "video/mp4", storageReference: "media:a", sourceRunId: runRecord.runId, shotId: shot.shotId, width: 544, height: 960, fps: 24, duration: 4.2 });
await updateRun(runRecord.runId, { status: "completed", completedAt: Date.now(), outputAssetIds: [video.assetId] });
const withCandidate = await markShotHasCandidates(shot.shotId);
assert.equal(withCandidate.status, "has_candidates");
assert.deepEqual(withCandidate.runIds, [runRecord.runId]);
assert.deepEqual(withCandidate.director, bound, "binding kept through Run / candidate updates");
const candidates = await getShotCandidates(shot.shotId);
assert.deepEqual(candidates.map((candidate) => [candidate.label, candidate.asset.assetId]), [["A", video.assetId]]);

// "Refresh": a new module instance reads the same Shot, Run and candidate.
const fresh = await import("../lib/production-records.ts?shot-system-refresh");
assert.deepEqual((await fresh.getShot(shot.shotId)).director, bound);
assert.equal((await fresh.getShotCandidates(shot.shotId)).length, 1);

console.log("Shot System V0.1: optional 导演台 binding on the existing Shot (one numbering, canvas Shots unchanged), title / binding edit, plan from binding (I2VA + guide, Camera / Motion recorded), dangling bindings refused, node link, Run → Shot with directorContext, candidate A, binding kept, refresh passed");
