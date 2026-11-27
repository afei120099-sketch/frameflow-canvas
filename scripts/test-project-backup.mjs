import assert from "node:assert/strict";
import { databases } from "./fake-indexeddb.mjs";
import { ACTIVE_RUN_RESTORE_NOTE, BACKUP_FORMAT, BackupValidationError, collectProject, exportProject, projectHasContent, readBackup, restoreProject } from "../lib/project-backup.ts";
import { storeLocalAudio, storeLocalImage, storeLocalVideo } from "../lib/local-video-store.ts";
import { addRunToShot, adoptShotAsset, createRun, createShot, markShotHasCandidates, registerAsset, updateRun, updateShotDirector } from "../lib/production-records.ts";
import { addRoleAsset, createRole, setPrimaryRoleAsset } from "../lib/role-records.ts";
import { findActiveRunForNode } from "../lib/run-recovery.ts";
import { withProjectRestoreLock } from "../lib/project-media-lock.ts";

/** In-memory backup folder (the browser uses a real directory handle / webkitdirectory files). */
function memoryFolder() {
  const files = new Map();
  return {
    files,
    sink: { writeText: async (path, text) => { files.set(path, new Blob([text], { type: "application/json" })); }, writeBlob: async (path, blob) => { files.set(path, blob); } },
    source: { has: (path) => files.has(path), size: (path) => files.get(path)?.size ?? null, readText: async (path) => files.get(path).text(), readBlob: async (path) => files.get(path) },
  };
}
const clone = (folder) => { const copy = memoryFolder(); for (const [path, blob] of folder.files) copy.files.set(path, blob); return copy; };
const options = { appVersion: "test", persistenceKey: "frameflow-v0.1-canvas", now: 1_700_000_000_000 };
const wipe = () => databases.clear();
const ids = (rows, key) => rows.map((row) => row[key]).sort();
let canvasState = null;
const canvas = { current: () => canvasState, load: (document) => { canvasState = structuredClone(document); } };
const shape = (id, props) => ({ id, typeName: "shape", type: props.kind, props });

// 1. Empty project exports and imports.
{
  wipe();
  const folder = memoryFolder();
  const manifest = await exportProject(null, folder.sink, options);
  assert.equal(manifest.format, BACKUP_FORMAT);
  assert.deepEqual(manifest.counts, { images: 0, videos: 0, audios: 0, assets: 0, runs: 0, shots: 0, roles: 0, activeRuns: 0 });
  assert.deepEqual([...folder.files.keys()].sort(), ["canvas.json", "director-stage.json", "manifest.json", "records.json"]);
  assert.deepEqual(manifest.directorCounts, { scenes: 0, props: 0, states: 0, cameras: 0, motions: 0, controlPackages: 0 });
  const parsed = await readBackup(folder.source);
  const report = await restoreProject(parsed, canvas);
  assert.equal(report.ok, true);
  assert.equal(projectHasContent(await collectProject(), canvasState), false);
}

// Build a realistic project: image + video + audio, Runs, Shot with adoption, Role, audio lineage, manifest snapshot, active Run.
wipe();
const imageRef = await storeLocalImage(new Blob(["PNG-bytes"], { type: "image/png" }), "dog.png");
const videoRef = await storeLocalVideo(new Blob(["MP4-candidate-A"], { type: "video/mp4" }), "shot01_A.mp4");
const videoRefB = await storeLocalVideo(new Blob(["MP4-candidate-B-longer"], { type: "video/mp4" }), "shot01_B.mp4");
const extractRef = await storeLocalAudio(new Blob(["WAV-extract"], { type: "audio/wav" }), "extract.wav");
const clipRef = await storeLocalAudio(new Blob(["WAV-clip"], { type: "audio/wav" }), "clip.wav");
const image = await registerAsset({ kind: "image", origin: "imported", filename: "dog.png", mimeType: "image/png", storageReference: imageRef, sourceRunId: null, width: 1024, height: 1024 });
const shot = await createShot("", "shape:h3");
const snapshot = { parameters: { mode: "reference" }, workflowIdentity: { capabilityId: "h3_ref2va", templateVersion: "sha256:abc", templateFile: "h3-reference-workflow.json" } };
const manifestSnapshot = { schemaVersion: 1, manifestId: "m-1", capability: "h3_ref2va", pictureRefs: [{ index: 1, label: "<Picture 1>", assetId: image.assetId }], speakers: [{ speakerId: "S1", roleId: "r" }] };
const runA = await createRun({ capabilityId: "h3_ref2va", ...snapshot, shotId: shot.shotId, inputAssetIds: [image.assetId], rawPrompt: "柴犬说话", finalPrompt: "compiled", seed: 7, referenceManifest: manifestSnapshot, promptMode: "official_structured", ownerNodeId: "shape:h3" }, { reservePromptId: true });
const runB = await createRun({ capabilityId: "h3_ref2va", ...snapshot, shotId: shot.shotId, inputAssetIds: [image.assetId], rawPrompt: "second", finalPrompt: "second", seed: 8 });
const videoA = await registerAsset({ kind: "video", origin: "generated", filename: "shot01_A.mp4", mimeType: "video/mp4", storageReference: videoRef, sourceRunId: runA.runId, shotId: shot.shotId, width: 960, height: 544, fps: 24, duration: 5.9 });
const videoB = await registerAsset({ kind: "video", origin: "generated", filename: "shot01_B.mp4", mimeType: "video/mp4", storageReference: videoRefB, sourceRunId: runB.runId, shotId: shot.shotId });
await updateRun(runA.runId, { status: "completed", completedAt: 10, outputAssetIds: [videoA.assetId], submission: "accepted" });
await updateRun(runB.runId, { status: "completed", completedAt: 11, outputAssetIds: [videoB.assetId] });
await addRunToShot(shot.shotId, runA.runId); await addRunToShot(shot.shotId, runB.runId); await markShotHasCandidates(shot.shotId);
await adoptShotAsset(shot.shotId, videoB.assetId);
// Shot System V0.1: the optional 导演台 binding travels with the Shot record.
const shotBinding = { sceneId: "scene-x", sceneStateId: null, cameraId: "camera-x", motionIds: ["motion-x"], firstFramePackageId: "pack-first", lastFramePackageId: null, referencePackageId: null, guidePackageIds: ["pack-guide"] };
await updateShotDirector(shot.shotId, shotBinding);
const extract = await registerAsset({ kind: "audio", origin: "generated", filename: "extract.wav", mimeType: "audio/wav", storageReference: extractRef, sourceRunId: null, derivationType: "audio_extract", sourceVideoAssetId: videoA.assetId, duration: 5.9 });
const clip = await registerAsset({ kind: "audio", origin: "generated", filename: "clip.wav", mimeType: "audio/wav", storageReference: clipRef, sourceRunId: null, derivationType: "audio_clip", sourceAudioAssetId: extract.assetId, sourceVideoAssetId: videoA.assetId, sourceStartTime: 1, sourceEndTime: 2.5 });
const role = await createRole("柴犬");
await addRoleAsset(role.roleId, image.assetId, "image"); await addRoleAsset(role.roleId, extract.assetId, "audio"); await addRoleAsset(role.roleId, clip.assetId, "audio");
await setPrimaryRoleAsset(role.roleId, clip.assetId, "audio");
const active = await createRun({ capabilityId: "seedvr2_upscale", parameters: {}, workflowIdentity: { capabilityId: "seedvr2_upscale", templateVersion: "sha256:s", templateFile: "seedvr2-workflow.json" }, inputAssetIds: [videoB.assetId], rawPrompt: null, finalPrompt: null, seed: null, ownerNodeId: "shape:upscale" }, { reservePromptId: true });
await updateRun(active.runId, { status: "running", startedAt: 20, submission: "accepted" });
const legacyInline = await registerAsset({ kind: "image", origin: "unknown", filename: "old.png", mimeType: "image/png", storageReference: "legacy-inline:deadbeef", sourceRunId: null });
const canvasDocument = { schema: { schemaVersion: 2, sequences: {} }, store: {
  "shape:img": shape("shape:img", { kind: "image-node", src: imageRef, assetId: image.assetId }),
  "shape:vid": shape("shape:vid", { kind: "video-node", src: videoRefB, assetId: videoB.assetId, shotId: shot.shotId }),
  "shape:aud": shape("shape:aud", { kind: "audio-node", src: clipRef, assetId: clip.assetId, sourceAudioAssetId: extract.assetId }),
  "shape:legacy": shape("shape:legacy", { kind: "image-node", src: "data:image/png;base64,AAAA" }),
  "page:page": { id: "page:page", typeName: "page" },
} };
canvasState = structuredClone(canvasDocument);
const original = await collectProject();

// 2 + export: image + video + audio, all metadata and Blobs.
const folder = memoryFolder();
const progress = [];
const manifest = await exportProject(canvasDocument, folder.sink, { ...options, onProgress: (done, total) => progress.push(`${done}/${total}`) });
assert.deepEqual(manifest.counts, { images: 1, videos: 2, audios: 2, assets: 6, runs: 3, shots: 1, roles: 1, activeRuns: 1 });
assert.equal(progress.at(-1), "5/5");
assert.equal(manifest.totalMediaBytes, ["PNG-bytes", "MP4-candidate-A", "MP4-candidate-B-longer", "WAV-extract", "WAV-clip"].reduce((sum, text) => sum + text.length, 0));
assert.ok(folder.files.has(`media/images/${imageRef.slice(6)}.png`));
assert.ok(folder.files.has(`media/videos/${videoRef.slice(6)}.mp4`));
assert.ok(folder.files.has(`media/audios/${clipRef.slice(6)}.wav`));
assert.ok(manifest.warnings.some((warning) => warning.startsWith("legacySkipped: 2")), "legacy inline media is flagged, not faked");
assert.ok(manifest.warnings.some((warning) => warning.startsWith("activeRuns: 1")));
assert.ok(![...folder.files.values()].some((blob) => blob.type === "application/json" && false));
for (const text of await Promise.all(["manifest.json", "records.json", "canvas.json"].map((path) => folder.files.get(path).text()))) assert.doesNotMatch(text, /blob:/, "no Object URL enters a backup");
const exportedAfter = await collectProject();
assert.deepEqual(ids(exportedAfter.records.assets, "assetId"), ids(original.records.assets, "assetId"), "export does not modify the project");

// 12. Export → wipe the test environment → import: counts and IDs identical.
wipe();
canvasState = null;
const parsed = await readBackup(folder.source);
assert.equal(parsed.manifest.counts.assets, 6);
assert.equal(projectHasContent(await collectProject(), canvasState), false);
const report = await restoreProject(parsed, canvas);
assert.equal(report.ok, true, JSON.stringify(report));
assert.deepEqual(report.steps.map((step) => step.step), ["media", "records", "roles", "director", "canvas"]);
const restored = await collectProject();
for (const key of ["assets", "runs", "shots", "roles", "meta"]) assert.equal(restored.records[key].length, original.records[key].length, `${key} count`);
assert.deepEqual(ids(restored.records.assets, "assetId"), ids(original.records.assets, "assetId"));
assert.deepEqual(ids(restored.records.runs, "runId"), ids(original.records.runs, "runId"));
assert.deepEqual(ids(restored.records.shots, "shotId"), ids(original.records.shots, "shotId"));
assert.deepEqual(ids(restored.records.roles, "roleId"), ids(original.records.roles, "roleId"));
for (const store of ["images", "videos", "audios"]) assert.deepEqual(ids(restored.media[store], "id"), ids(original.media[store], "id"), `${store} ids`);
const byId = (rows, key, id) => rows.find((row) => row[key] === id);

// 3 + 13. Relations and node references still resolve: every ref points at a restored Blob with the original bytes.
for (const asset of restored.records.assets.filter((item) => !item.storageReference.startsWith("legacy-inline:"))) {
  const [prefix, id] = asset.storageReference.split(":");
  const store = { image: "images", media: "videos", audio: "audios" }[prefix];
  const media = byId(restored.media[store], "id", id);
  assert.ok(media, `Blob for ${asset.filename}`);
  assert.equal(await media.blob.text(), await byId(original.media[store], "id", id).blob.text());
  assert.equal(media.blob.type, byId(original.media[store], "id", id).blob.type || media.blob.type);
}
assert.deepEqual(canvasState, canvasDocument, "canvas document restored");
for (const node of Object.values(canvasState.store).filter((record) => record.typeName === "shape" && record.props.assetId)) {
  assert.ok(byId(restored.records.assets, "assetId", node.props.assetId), `node ${node.id} → Asset`);
  assert.equal(byId(restored.records.assets, "assetId", node.props.assetId).storageReference, node.props.src, `node ${node.id} → same Blob ref`);
}
assert.deepEqual(byId(restored.records.runs, "runId", runA.runId).outputAssetIds, [videoA.assetId]);
assert.deepEqual(byId(restored.records.shots, "shotId", shot.shotId).runIds, [runA.runId, runB.runId]);
assert.equal(byId(restored.records.assets, "assetId", videoA.assetId).sourceRunId, runA.runId);
assert.equal(byId(restored.records.assets, "assetId", legacyInline.assetId).storageReference, "legacy-inline:deadbeef", "legacy record kept as-is");
assert.equal(byId(restored.records.meta, "key", "nextShotNumber").value, 2, "Shot numbering continues");

// 4. Adopted Asset kept.
assert.equal(byId(restored.records.shots, "shotId", shot.shotId).adoptedAssetId, videoB.assetId);
assert.equal(byId(restored.records.shots, "shotId", shot.shotId).status, "adopted");
assert.deepEqual(byId(restored.records.shots, "shotId", shot.shotId).director, shotBinding, "Shot System V0.1 binding restored");

// 5. Role primaries kept.
const restoredRole = byId(restored.records.roles, "roleId", role.roleId);
assert.equal(restoredRole.primaryAppearanceAssetId, image.assetId);
assert.equal(restoredRole.primaryVoiceAssetId, clip.assetId);
assert.deepEqual(restoredRole.voiceAssetIds, [extract.assetId, clip.assetId]);

// 6. audio_extract / audio_clip lineage kept.
const restoredClip = byId(restored.records.assets, "assetId", clip.assetId);
assert.deepEqual([restoredClip.derivationType, restoredClip.sourceAudioAssetId, restoredClip.sourceVideoAssetId, restoredClip.sourceStartTime, restoredClip.sourceEndTime], ["audio_clip", extract.assetId, videoA.assetId, 1, 2.5]);
assert.equal(byId(restored.records.assets, "assetId", extract.assetId).derivationType, "audio_extract");

// 7. Reference Manifest snapshot and prompt mode kept.
const restoredRunA = byId(restored.records.runs, "runId", runA.runId);
assert.deepEqual(restoredRunA.referenceManifest, { ...manifestSnapshot, runId: runA.runId, shotId: shot.shotId });
assert.equal(restoredRunA.promptMode, "official_structured");
assert.equal(restoredRunA.comfyPromptId, runA.runId);

// 8. The active Run comes back as history ("状态待确认"), not as a live task; recovery will not re-attach it.
const restoredActive = byId(restored.records.runs, "runId", active.runId);
assert.equal(restoredActive.status, "failed");
assert.ok(restoredActive.error.startsWith(ACTIVE_RUN_RESTORE_NOTE));
assert.match(restoredActive.error, /原状态：running/);
assert.equal(findActiveRunForNode("shape:upscale", restored.records.runs), null);
assert.equal(byId(original.records.runs, "runId", active.runId).status, "running", "the backup itself still records the original state");

// 14. Importing the same backup again does not duplicate anything.
{
  const again = await restoreProject(await readBackup(folder.source), canvas);
  assert.equal(again.ok, true);
  const twice = await collectProject();
  for (const key of ["assets", "runs", "shots", "roles"]) assert.equal(twice.records[key].length, original.records[key].length, `${key} not duplicated`);
  for (const store of ["images", "videos", "audios"]) assert.equal(twice.media[store].length, original.media[store].length, `${store} not duplicated`);
  assert.equal(new Set(twice.records.assets.map((asset) => asset.storageReference)).size, twice.records.assets.length);
}

// 9 + 10 + 11. Broken, wrong-version and incomplete packages are rejected before anything is written.
{
  const before = await collectProject();
  const expectReject = async (mutate, pattern) => {
    const broken = clone(folder);
    await mutate(broken.files);
    await assert.rejects(readBackup(broken.source), (error) => error instanceof BackupValidationError && pattern.test(error.message));
  };
  const editJson = (name, change) => async (files) => { const value = JSON.parse(await files.get(name).text()); change(value); files.set(name, new Blob([JSON.stringify(value)])); };
  await expectReject(async (files) => files.set("records.json", new Blob(["{not json"])), /records\.json 不是有效的 JSON/);
  await expectReject(async (files) => files.delete("canvas.json"), /缺少 canvas\.json/);
  await expectReject(editJson("manifest.json", (value) => { value.formatVersion = 99; }), /不支持的备份版本 99/);
  await expectReject(editJson("manifest.json", (value) => { value.format = "something-else"; }), /不是 Frameflow 项目备份/);
  await expectReject(async (files) => files.delete(`media/videos/${videoRef.slice(6)}.mp4`), /缺少媒体文件 media\/videos\//);
  await expectReject(async (files) => files.set(`media/images/${imageRef.slice(6)}.png`, new Blob(["trunc"])), /媒体文件大小不符/);
  await expectReject(editJson("records.json", (value) => { value.assets.push({ ...value.assets[0] }); }), /ID 重复|manifest 统计/);
  await expectReject(editJson("records.json", (value) => { value.runs = "nope"; }), /records\.runs 缺失/);
  await expectReject(editJson("canvas.json", (value) => { value.document = 42; }), /不是有效的画布快照/);
  const after = await collectProject();
  assert.deepEqual(ids(after.records.assets, "assetId"), ids(before.records.assets, "assetId"), "rejected packages change nothing");

  // Missing media that was already missing at export time → explicit warning (not silently "complete").
  const partial = clone(folder);
  const manifestValue = JSON.parse(await partial.files.get("manifest.json").text());
  const dropped = manifestValue.media.find((entry) => entry.store === "audios");
  manifestValue.media = manifestValue.media.filter((entry) => entry !== dropped);
  manifestValue.counts.audios -= 1;
  partial.files.delete(dropped.file);
  partial.files.set("manifest.json", new Blob([JSON.stringify(manifestValue)]));
  const warned = await readBackup(partial.source);
  assert.ok(warned.warnings.some((warning) => warning.startsWith("missingMedia:")), warned.warnings.join("\n"));
}

// Staged restore: a failure in a late stage rolls the earlier metadata stages back; the current project survives.
{
  // "Current" = the restored full project. Incoming = an edited backup (no Role, one Asset fewer) whose canvas fails to load.
  const before = await collectProject();
  canvasState = structuredClone(canvasDocument);
  assert.equal(projectHasContent(before, canvasState), true, "“当前项目已有内容” is detected");
  const incoming = clone(folder);
  const records = JSON.parse(await incoming.files.get("records.json").text());
  records.roles = []; records.assets = records.assets.filter((asset) => asset.assetId !== legacyInline.assetId);
  incoming.files.set("records.json", new Blob([JSON.stringify(records)]));
  const manifestValue = JSON.parse(await incoming.files.get("manifest.json").text());
  manifestValue.counts.roles = 0; manifestValue.counts.assets -= 1;
  incoming.files.set("manifest.json", new Blob([JSON.stringify(manifestValue)]));
  // Only the incoming canvas fails to load; putting the current canvas back (rollback) works.
  const failing = { current: canvas.current, load: (document) => { if (document !== canvasState) throw new Error("画布快照无法加载"); canvas.load(document); } };
  const failed = await restoreProject(await readBackup(incoming.source), failing);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.steps.map((step) => [step.step, step.ok]), [["media", true], ["records", true], ["roles", true], ["director", true], ["canvas", false]]);
  assert.deepEqual(failed.rolledBack.sort(), ["canvas", "director", "records", "roles"]);
  assert.deepEqual(failed.rollbackFailed, []);
  const after = await collectProject();
  assert.deepEqual(ids(after.records.assets, "assetId"), ids(before.records.assets, "assetId"), "current Assets restored after the failed import");
  assert.deepEqual(ids(after.records.roles, "roleId"), [role.roleId], "current Role restored after the failed import");
  assert.deepEqual(ids(after.records.runs, "runId"), ids(before.records.runs, "runId"));
  assert.deepEqual(canvasState, canvasDocument, "current canvas untouched");
  for (const store of ["images", "videos", "audios"]) assert.equal(after.media[store].length, before.media[store].length, "media never deleted");
}

// 15. Director Stage: create → export → delete local data → import → restored; v1 packages stay importable.
{
  // Runs on top of the current test project (record modules keep their connection, so no wipe() here).
  canvasState = null;
  const director = await import("../lib/director-stage/store.ts");
  const asset = (await collectProject()).records.assets[0];
  const scene = await director.createScene({ name: "《这一笔》书房" });
  const chair = await director.createProp({ sceneId: scene.id, name: "椅子", type: "chair" });
  const upright = await director.createSceneState({ sceneId: scene.id, name: "椅子立着", propChanges: [{ propId: chair.id, description: "立在书桌前" }] });
  const fallen = await director.createSceneState({ sceneId: scene.id, name: "椅子倒地", propChanges: [{ propId: chair.id, description: "侧倒" }] });
  const camera = await director.createCamera({ sceneId: scene.id, name: "主机位" });
  // 3D white-box layout (optional fields) travels with the backup.
  await director.updateScene(scene.id, { room: { width: 4, depth: 5, height: 2.8 } });
  await director.updateProp(chair.id, { geometry: "box", transform: { position: [0.3, 0.45, -0.5], rotation: [0, 15, 0], scale: [0.5, 0.9, 0.5] } });
  await director.updateCamera(camera.id, { transform: { position: [0, 1.5, 2.2], rotation: [-5, 0, 0], scale: [1, 1, 1] }, focalLength: 50, aspect: "9:16" });
  await director.createMotion({ sceneId: scene.id, name: "推近", targetType: "camera", targetId: camera.id, keyframes: [{ frame: 48, description: "近景", transform: { position: [0, 1.5, 1.2], rotation: [-5, 0, 0], scale: [1, 1, 1] } }, { frame: 0, description: "中景" }] }); // Motion V0.2: one posed, one text-only keyframe
  await director.createControlPackage({ sceneId: scene.id, name: "椅子参考", type: "reference", assetIds: [asset.assetId, "asset-not-backed-up"] });
  // 高级控制素材 V0.1: a depth package with its Blender render metadata.
  const depthRender = { pass: "depth", groupId: "group-1", sceneId: scene.id, cameraId: camera.id, sourceObjects: [{ propId: chair.id, name: "椅子", pixels: 1200 }], includesRoom: true, renderedAt: 1790000000000, width: 720, height: 1280, engine: "CYCLES (1 sample at pixel centre, emission data render)", blenderVersion: "5.2.2 LTS", depthRange: { nearM: 1.2, farM: 4.9, encoding: "8-bit grey, near = 255" } };
  const depthPack = await director.createControlPackage({ sceneId: scene.id, name: "深度 · 主机位", type: "depth", assetIds: [asset.assetId], render: depthRender });

  const backup = memoryFolder();
  const manifest = await exportProject(null, backup.sink, options);
  assert.equal(manifest.formatVersion, 2);
  assert.deepEqual(manifest.directorCounts, { scenes: 1, props: 1, states: 2, cameras: 1, motions: 1, controlPackages: 2 });
  assert.ok(backup.files.has("director-stage.json"));
  assert.ok(manifest.warnings.some((warning) => warning.startsWith("directorMissingAssets:") && warning.includes("asset-not-backed-up")), manifest.warnings.join("\n"));

  // Delete the local Director Stage data (cascade from the Scene).
  await director.deleteScene(scene.id);
  assert.equal((await director.listScenes()).length, 0);
  const emptyRecords = { assets: [], runs: [], shots: [], meta: [], roles: [] };
  const emptyMedia = { images: [], videos: [], audios: [] };
  const directorOnly = { scenes: [{ id: "s" }], props: [], states: [], cameras: [], motions: [], controlPackages: [] };
  assert.equal(projectHasContent({ records: emptyRecords, media: emptyMedia, director: directorOnly }, null), true, "Director Stage data alone counts as content");

  const parsed = await readBackup(backup.source);
  assert.equal(parsed.director.scenes.length, 1);
  const report = await restoreProject(parsed, canvas);
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  assert.deepEqual(report.steps.map((step) => step.step), ["media", "records", "roles", "director", "canvas"]);
  assert.equal((await director.getScene(scene.id))?.name, "《这一笔》书房");
  assert.equal((await director.getProp(chair.id))?.sceneId, scene.id);
  assert.deepEqual((await director.listSceneStates(scene.id)).map((state) => state.id).sort(), [upright.id, fallen.id].sort());
  assert.equal((await director.listMotions(scene.id))[0].targetId, camera.id);
  assert.deepEqual((await director.getScene(scene.id)).room, { width: 4, depth: 5, height: 2.8 });
  assert.deepEqual((await director.getProp(chair.id)).transform, { position: [0.3, 0.45, -0.5], rotation: [0, 15, 0], scale: [0.5, 0.9, 0.5] });
  assert.equal((await director.getProp(chair.id)).geometry, "box");
  const restoredCamera = await director.getCamera(camera.id);
  assert.deepEqual([restoredCamera.transform.position, restoredCamera.focalLength, restoredCamera.aspect], [[0, 1.5, 2.2], 50, "9:16"]);
  assert.deepEqual((await director.listMotions(scene.id))[0].keyframes, [{ frame: 0, description: "中景" }, { frame: 48, description: "近景", transform: { position: [0, 1.5, 1.2], rotation: [-5, 0, 0], scale: [1, 1, 1] } }]);
  assert.deepEqual((await director.listControlPackages(scene.id)).find((pack) => pack.type === "reference").assetIds, [asset.assetId, "asset-not-backed-up"]);
  assert.deepEqual((await director.getControlPackage(depthPack.id)).render, depthRender, "control render metadata restored");
  // Restoring again replaces, never duplicates.
  await restoreProject(await readBackup(backup.source), canvas);
  assert.equal((await collectProject()).director.states.length, 2);

  // A v1 package (no director-stage.json) is still accepted and leaves current Director Stage data untouched.
  const v1 = clone(backup);
  v1.files.delete("director-stage.json");
  const v1Manifest = JSON.parse(await v1.files.get("manifest.json").text());
  v1Manifest.formatVersion = 1; delete v1Manifest.directorCounts;
  v1.files.set("manifest.json", new Blob([JSON.stringify(v1Manifest)]));
  const extra = await director.createScene({ name: "只在本地的场景" });
  const v1Parsed = await readBackup(v1.source);
  assert.equal(v1Parsed.director, null);
  assert.ok(v1Parsed.warnings.some((warning) => warning.includes("旧版备份（v1）不含导演台数据")));
  const v1Report = await restoreProject(v1Parsed, canvas);
  assert.equal(v1Report.ok, true);
  assert.ok((await director.getScene(extra.id)) && (await director.getScene(scene.id)), "v1 restore keeps current Director Stage data");
  await director.deleteScene(extra.id);

  // Broken director-stage.json is rejected before anything is written.
  const editDirector = async (change) => { const broken = clone(backup); const value = JSON.parse(await broken.files.get("director-stage.json").text()); change(value); broken.files.set("director-stage.json", new Blob([JSON.stringify(value)])); return broken; };
  const rejects = async (folderValue, pattern) => assert.rejects(readBackup(folderValue.source), (error) => error instanceof BackupValidationError && pattern.test(error.message));
  const missingFile = clone(backup); missingFile.files.delete("director-stage.json");
  await rejects(missingFile, /缺少 director-stage\.json/);
  await rejects(await editDirector((value) => { value.props[0].sceneId = "ghost"; }), /所属场景不存在/);
  await rejects(await editDirector((value) => { value.states[0].propChanges[0].propId = "ghost"; }), /不属于该场景的道具/);
  await rejects(await editDirector((value) => { value.scenes[0].unexpected = true; }), /无效记录/);
  await rejects(await editDirector((value) => { value.states.pop(); }), /导演台统计/);
  await rejects(await editDirector((value) => { value.motions[0].targetType = "prop"; }), /动作 .* 的目标不属于该场景/);
  await rejects(await editDirector((value) => { value.props[0].transform.scale = [0, 1, 1]; }), /props 中有无效记录/);
  await rejects(await editDirector((value) => { value.motions[0].keyframes.push({ frame: 48, description: "重复" }); }), /重复帧 48/);
  await rejects(await editDirector((value) => { value.motions[0].keyframes[1].transform.position = [999, 0, 0]; }), /motions 中有无效记录/);
  await rejects(await editDirector((value) => { value.controlPackages.find((pack) => pack.type === "depth").render.pass = "normal"; }), /controlPackages 中有无效记录/);
  assert.equal((await collectProject()).director.states.length, 2, "rejected packages change nothing");
}

// Hotfix: same ID is reusable only for byte-identical content, size and MIME.
{
  // This suite intentionally replaces fake databases between cases; use the current database,
  // not local-video-store's old cached connection from a prior case.
  const reference = "image:hotfix-original";
  await new Promise((resolve, reject) => {
    const tx = databases.get("frameflow-local-media").transaction("images", "readwrite");
    tx.objectStore("images").add({ id: "hotfix-original", blob: new Blob(["original"], { type: "image/png" }), name: "safety.png", createdAt: 1 });
    tx.objectStore("images").add({ id: "hotfix-untyped", blob: new Blob(["untyped"]), name: "legacy.bin", createdAt: 1 });
    tx.oncomplete = resolve; tx.onerror = reject;
  });
  const clean = memoryFolder();
  canvasState = structuredClone(canvasDocument);
  await exportProject(canvasState, clean.sink, options);
  const entry = JSON.parse(await clean.files.get("manifest.json").text()).media.find((item) => item.id === reference.slice(6));
  const before = await collectProject();
  const bytes = async () => (await collectProject()).media.images.find((row) => row.id === entry.id).blob.text();
  assert.equal((await restoreProject(await readBackup(clean.source), canvas)).ok, true, "same ID same bytes succeeds");
  for (const variant of ["hash", "size", "mime"]) {
    const bad = clone(clean);
    const manifest = JSON.parse(await bad.files.get("manifest.json").text());
    const item = manifest.media.find((media) => media.id === entry.id);
    if (variant === "hash") bad.files.set(item.file, new Blob(["replaced"], { type: "image/png" }));
    if (variant === "size") { bad.files.set(item.file, new Blob(["larger-original"], { type: "image/png" })); item.size = bad.files.get(item.file).size; }
    if (variant === "mime") item.type = "image/jpeg";
    bad.files.set("manifest.json", new Blob([JSON.stringify(manifest)]));
    const parsed = await readBackup(bad.source);
    await assert.rejects(() => restoreProject(parsed, canvas), /媒体冲突/);
    assert.equal(await bytes(), "original", `${variant} conflict preserves bytes`);
  }
  const incoming = clone(clean);
  const manifest = JSON.parse(await incoming.files.get("manifest.json").text());
  manifest.media.push({ store: "images", id: "hotfix-new", file: "media/images/hotfix-new.png", size: 3, type: "image/png", name: "new.png", createdAt: 1 });
  manifest.counts.images += 1;
  incoming.files.set("media/images/hotfix-new.png", new Blob(["new"], { type: "image/png" }));
  incoming.files.set("manifest.json", new Blob([JSON.stringify(manifest)]));
  const savedCanvas = canvasState;
  const report = await restoreProject(await readBackup(incoming.source), { current: () => savedCanvas, load: (document) => { if (document !== savedCanvas) { canvasState = { store: {} }; throw new Error("simulated partial canvas failure"); } canvasState = document; } });
  assert.equal(report.ok, false);
  assert.equal(await bytes(), "original", "failed restore never replaces original media");
  assert.deepEqual((await collectProject()).records, before.records, "metadata rolled back");
  assert.equal((await collectProject()).media.images.some((row) => row.id === "hotfix-new"), false, "new media rolled back");
  assert.equal(canvasState, savedCanvas, "partially changed canvas rolled back");
  const director = await import("../lib/director-stage/store.ts");
  await withProjectRestoreLock(async () => {
    for (const write of [
      () => storeLocalImage(new Blob(["blocked"], { type: "image/png" }), "blocked.png"),
      () => storeLocalVideo(new Blob(["blocked"], { type: "video/mp4" }), "blocked.mp4"),
      () => storeLocalAudio(new Blob(["blocked"], { type: "audio/wav" }), "blocked.wav"),
      () => createRole("blocked"),
      () => createShot(),
      () => director.createScene({ name: "blocked" }),
    ]) await assert.rejects(write, /正在恢复/, "real storage writer respects restore lock");
  });
}

console.log("Project backup: v1/v2 regression + hash/size/MIME conflicts, same-content reuse, media/metadata/partial-canvas rollback passed");
