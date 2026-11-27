import assert from "node:assert/strict";
import { snapshotFilm, snapshotH3, snapshotUpscale } from "../lib/production-snapshots.ts";
import { listRuns } from "../lib/production-records.ts";
import { findActiveRunForNode } from "../lib/run-recovery.ts";
import { deleteShotCandidate, restoreShotCandidate, addRunToShot, adoptShotAsset, attachCompletedRunToShot, createRun, createShot, ensureLegacyAsset, getAsset, getAssetBySource, getRootCandidateLabel, getRun, getShot, getShotAssetLineage, getShotAssetVersions, getShotCandidates, listAssets, markShotHasCandidates, registerAsset, updateRun } from "../lib/production-records.ts";
import { buildReferenceManifest, loadManifestRoles } from "../lib/reference-manifest.ts";
import { compileH3Ref2vaPrompt } from "../lib/h3-prompt-compiler.ts";
import { addRoleAsset, createRole, deleteRole, getRole, listRoles, removeRoleAsset, setPrimaryRoleAsset, updateRoleDetails } from "../lib/role-records.ts";

// Small IndexedDB transaction double: records are cloned just like browser IDB.
const databases = new Map();
globalThis.indexedDB = {
  open(name, version) {
    const request = {};
    queueMicrotask(() => {
      let db = databases.get(name);
      const fresh = !db;
      if (!db) {
        const stores = new Map();
        db = {
          version,
          objectStoreNames: { contains: (key) => stores.has(key) },
          createObjectStore(key, options) {
            const state = { keyPath: options.keyPath, data: new Map(), indexes: new Map() };
            stores.set(key, state);
            return { createIndex: (indexName, field, opts) => state.indexes.set(indexName, { field, unique: opts.unique }) };
          },
          transaction() {
            const tx = { pending: 0, error: null, abort() { queueMicrotask(() => tx.onabort?.()); }, objectStore(key) { const state = stores.get(key); return {
              get(id) { return act(() => state.data.get(id)); },
              getAll() { return act(() => [...state.data.values()]); },
              add(value) { return act(() => { if (state.data.has(value[state.keyPath])) throw new Error("duplicate key"); state.data.set(value[state.keyPath], structuredClone(value)); }); },
              delete(id) { return act(() => state.data.delete(id)); },
              put(value) { return act(() => { for (const index of state.indexes.values()) if (index.unique && [...state.data.values()].some((item) => item[index.field] === value[index.field] && item[state.keyPath] !== value[state.keyPath])) throw new Error("duplicate index"); state.data.set(value[state.keyPath], structuredClone(value)); }); },
              index(indexName) { return { get(value) { return act(() => [...state.data.values()].find((item) => item[state.indexes.get(indexName).field] === value)); } }; },
            }; } };
            function act(fn) { const req = {}; tx.pending++; queueMicrotask(() => { try { req.result = structuredClone(fn()); req.onsuccess?.(); } catch (error) { tx.error = error; req.error = error; req.onerror?.(); tx.onerror?.(); return; } if (--tx.pending === 0) queueMicrotask(() => tx.oncomplete?.()); }); return req; }
            return tx;
          },
        };
        databases.set(name, db);
      }
      request.result = db;
      if (fresh || version > db.version) { request.onupgradeneeded?.(); db.version = version; }
      request.onsuccess?.();
    });
    return request;
  },
};

// Browser upgrade from the actual Phase 1 schema must leave its records intact.
const legacyDb = await new Promise((resolve) => {
  const request = indexedDB.open("frameflow-production-records", 1);
  request.onupgradeneeded = () => {
    const assets = request.result.createObjectStore("assets", { keyPath: "assetId" });
    assets.createIndex("storageReference", "storageReference", { unique: true });
    request.result.createObjectStore("runs", { keyPath: "runId" });
  };
  request.onsuccess = () => resolve(request.result);
});
await new Promise((resolve) => { const tx = legacyDb.transaction("assets", "readwrite"); tx.objectStore("assets").put({ schemaVersion: 1, assetId: "phase1-media", kind: "video", origin: "unknown", filename: "old.mp4", mimeType: "video/mp4", createdAt: 1, storageReference: "media:phase1", sourceRunId: null }); tx.oncomplete = resolve; });

const source = await registerAsset({ kind: "image", origin: "imported", filename: "first.png", mimeType: "image/png", storageReference: "image:one", sourceRunId: null, width: 1024, height: 576, fileSize: 99 });
assert.equal((await getAsset("phase1-media")).filename, "old.mp4", "Phase 1 asset survives v2 upgrade");
const video = await registerAsset({ kind: "video", origin: "imported", filename: "input.mp4", mimeType: "video/mp4", storageReference: "media:one", sourceRunId: null, duration: 5.2, fileSize: 900 });
const audio = await registerAsset({ kind: "audio", origin: "imported", filename: "voice.wav", mimeType: "audio/wav", storageReference: "media:audio", sourceRunId: null });
assert.equal(source.schemaVersion, 1); assert.equal(video.kind, "video"); assert.equal(audio.kind, "audio");
assert.equal((await getAssetBySource("image:one")).assetId, source.assetId);
assert.equal((await ensureLegacyAsset("media:old", "video", "old.mp4")).origin, "unknown");
assert.equal((await ensureLegacyAsset("media:old", "video", "old.mp4")).assetId, (await getAssetBySource("media:old")).assetId);

const settings = { length: 141, aspect: "16:9", megapixels: 0.5, turbo: true, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32, soundMode: "ambient" };
const h3 = await snapshotH3({ referenceMode: false, prompt: "actual compiled prompt", seed: 42, settings, sourceWidth: 1024, sourceHeight: 576, hasLastFrame: false, referenceCounts: { images: 0, videos: 0, audios: 0, videoAudioFlags: [] } });
assert.equal(h3.parameters.steps, 6); assert.equal(h3.parameters.length, 141); assert.equal(h3.parameters.seed, 42); assert.equal(h3.parameters.fps, 24);
const mutableInputs = [source.assetId]; const mutableParameters = structuredClone(h3.parameters);
const run = await createRun({ ...h3, inputAssetIds: mutableInputs, rawPrompt: "Prompt A", finalPrompt: "actual compiled prompt", seed: 42, parameters: mutableParameters });
mutableInputs[0] = video.assetId; mutableParameters.steps = 999; settings.length = 362;
assert.deepEqual((await getRun(run.runId)).inputAssetIds, [source.assetId]);
assert.equal((await getRun(run.runId)).parameters.steps, 6); assert.equal((await getRun(run.runId)).rawPrompt, "Prompt A");
await Promise.all([updateRun(run.runId, { comfyPromptId: "prompt-123" }), updateRun(run.runId, { status: "running", startedAt: 1234 })]);
const generated = await registerAsset({ kind: "video", origin: "generated", filename: "generated.mp4", mimeType: "video/mp4", storageReference: "media:output", sourceRunId: run.runId, width: 768, height: 448 });
await updateRun(run.runId, { status: "completed", completedAt: 5678, outputAssetIds: [generated.assetId] });
assert.equal((await getAsset(generated.assetId)).sourceRunId, run.runId);
assert.deepEqual((await getRun(run.runId)).outputAssetIds, [generated.assetId]);
assert.equal((await getRun(run.runId)).comfyPromptId, "prompt-123");
await updateRun(run.runId, { status: "running" });
assert.equal((await getRun(run.runId)).status, "completed", "terminal run cannot regress");

const reference = await snapshotH3({ referenceMode: true, prompt: "Picture1 and Audio1", seed: 8, settings: { ...settings, length: 141 }, sourceWidth: 1024, sourceHeight: 576, hasLastFrame: false, referenceCounts: { images: 1, videos: 0, audios: 1, videoAudioFlags: [] } });
assert.equal(reference.capabilityId, "h3_ref2va"); assert.equal(reference.parameters.steps, 4); assert.equal(reference.parameters.seed, 8);
const refRun = await createRun({ ...reference, inputAssetIds: [source.assetId, audio.assetId], rawPrompt: "猫说话", finalPrompt: "Picture1 and Audio1", seed: 8, referenceInputs: [{ assetId: source.assetId, kind: "image", role: "first_frame", order: 0 }, { assetId: audio.assetId, kind: "audio", role: "reference_audio", order: 1 }] });
assert.deepEqual((await getRun(refRun.runId)).referenceInputs.map((item) => item.assetId), [source.assetId, audio.assetId]);

for (const snapshot of [await snapshotUpscale(undefined, 544, 960), await snapshotFilm(24)]) {
  const processRun = await createRun({ ...snapshot, inputAssetIds: [video.assetId], rawPrompt: null, finalPrompt: null, seed: null });
  const output = await registerAsset({ kind: "video", origin: "generated", filename: `${snapshot.capabilityId}.mp4`, mimeType: "video/mp4", storageReference: `media:${snapshot.capabilityId}`, sourceRunId: processRun.runId });
  await updateRun(processRun.runId, { status: "completed", outputAssetIds: [output.assetId] });
  assert.equal((await getAsset(output.assetId)).sourceRunId, processRun.runId);
  assert.deepEqual((await getRun(processRun.runId)).inputAssetIds, [video.assetId]);
}
assert.equal((await snapshotUpscale(undefined, 544, 960)).parameters.splitLatent, true);
assert.equal((await snapshotFilm(24)).parameters.outputFps, 60);

for (const status of ["failed", "cancelled"]) {
  const attempt = await createRun({ ...h3, inputAssetIds: [source.assetId], rawPrompt: "retry", finalPrompt: "retry", seed: 7 });
  await updateRun(attempt.runId, { status, completedAt: Date.now(), error: status });
  assert.equal((await getRun(attempt.runId)).status, status);
  assert.equal((await getRun(attempt.runId)).error, status);
}

// Simulated canvas node deletion/Undo does not touch either metadata store.
let node = { assetId: generated.assetId, runId: run.runId }; node = null; node = { assetId: generated.assetId, runId: run.runId };
assert.equal((await getRun(node.runId)).runId, run.runId); assert.equal((await getAsset(node.assetId)).assetId, generated.assetId);
const reloaded = await import("../lib/production-records.ts?test-reload=1");
assert.equal((await reloaded.getRun(run.runId)).status, "completed");
assert.equal((await reloaded.getAsset(generated.assetId)).sourceRunId, run.runId);
console.log("Asset/Run schema, four capability snapshots, lineage, terminal states and reload assertions passed");

const shot = await createShot();
assert.equal(shot.shotNumber, 1); assert.equal(shot.status, "draft");
assert.equal((await getAsset(video.assetId)).shotId, undefined, "legacy media is not assigned a fake shot");
const candidates = [];
for (const letter of ["A", "B", "C"]) {
  const attempt = await createRun({ ...h3, shotId: shot.shotId, inputAssetIds: [source.assetId], rawPrompt: `Prompt ${letter}`, finalPrompt: `Prompt ${letter}`, seed: letter.charCodeAt(0) });
  await addRunToShot(shot.shotId, attempt.runId);
  const asset = await registerAsset({ kind: "video", origin: "generated", filename: `${letter}.mp4`, mimeType: "video/mp4", storageReference: `media:${letter}`, sourceRunId: attempt.runId, shotId: shot.shotId, width: 544, height: 960, duration: 5.2, fps: 24 });
  await updateRun(attempt.runId, { status: "completed", outputAssetIds: [asset.assetId] });
  await markShotHasCandidates(shot.shotId);
  candidates.push(asset);
}
assert.deepEqual((await getShotCandidates(shot.shotId)).map((item) => item.label), ["A", "B", "C"]);
assert.equal((await getShot(shot.shotId)).status, "has_candidates");
await adoptShotAsset(shot.shotId, candidates[1].assetId);
assert.equal((await getShot(shot.shotId)).adoptedAssetId, candidates[1].assetId);
await adoptShotAsset(shot.shotId, candidates[2].assetId);
assert.equal((await getShot(shot.shotId)).adoptedAssetId, candidates[2].assetId);
assert.equal((await getAsset(candidates[1].assetId)).filename, "B.mp4", "old candidate remains");
const upscaleRun = await createRun({ ...await snapshotUpscale(undefined, 544, 960), shotId: shot.shotId, inputAssetIds: [candidates[2].assetId], rawPrompt: null, finalPrompt: null, seed: null });
await addRunToShot(shot.shotId, upscaleRun.runId);
const upscaled = await registerAsset({ kind: "video", origin: "generated", filename: "C-2x.mp4", mimeType: "video/mp4", storageReference: "media:C-2x", sourceRunId: upscaleRun.runId, shotId: shot.shotId, fps: 24 });
await updateRun(upscaleRun.runId, { status: "completed", outputAssetIds: [upscaled.assetId] });
const filmRun = await createRun({ ...await snapshotFilm(24), shotId: shot.shotId, inputAssetIds: [upscaled.assetId], rawPrompt: null, finalPrompt: null, seed: null });
await addRunToShot(shot.shotId, filmRun.runId);
const smooth = await registerAsset({ kind: "video", origin: "generated", filename: "C-48fps.mp4", mimeType: "video/mp4", storageReference: "media:C-48", sourceRunId: filmRun.runId, shotId: shot.shotId, fps: 48 });
await updateRun(filmRun.runId, { status: "completed", outputAssetIds: [smooth.assetId] });
assert.equal(await getRootCandidateLabel(shot.shotId, smooth.assetId), "C");
assert.equal(await getShotAssetLineage(shot.shotId, smooth.assetId), "候选C → 高清增强 → 流畅增强");
assert.equal((await getShotAssetVersions(shot.shotId)).length, 5);
await adoptShotAsset(shot.shotId, smooth.assetId);
assert.equal((await getShot(shot.shotId)).adoptedRunId, filmRun.runId);
assert.equal((await getShot(shot.shotId)).adoptedAssetId, smooth.assetId);
const failed = await createRun({ ...h3, shotId: shot.shotId, inputAssetIds: [source.assetId], rawPrompt: "failed", finalPrompt: "failed", seed: 1 });
await addRunToShot(shot.shotId, failed.runId); await updateRun(failed.runId, { status: "failed", error: "test" });
assert.equal((await getShotCandidates(shot.shotId)).length, 3, "failed run is not a candidate");
const nextShot = await createShot();
assert.equal(nextShot.shotNumber, 2, "tail continuation gets next shot number");
assert.equal(await attachCompletedRunToShot(nextShot.shotId, run.runId), true, "Phase 1 completed H3 run migrates only when explicitly linked");
assert.equal((await getAsset(generated.assetId)).shotId, nextShot.shotId);
assert.equal((await getRun(run.runId)).shotId, nextShot.shotId);
await assert.rejects(adoptShotAsset(shot.shotId, generated.assetId), /不属于此镜头/);
assert.equal((await reloaded.getShot(shot.shotId)).adoptedAssetId, smooth.assetId, "adoption survives module reload");
console.log("Shot numbering, candidate versions, adoption, derivation, failure filtering, legacy and reload assertions passed");
await assert.rejects(deleteShotCandidate(shot.shotId, smooth.assetId), /已采用/);
await assert.rejects(deleteShotCandidate(shot.shotId, generated.assetId), /不属于/);
const candidateRunBefore = await getRun(candidates[0].sourceRunId);
await deleteShotCandidate(shot.shotId, candidates[0].assetId);
assert.deepEqual((await getShotCandidates(shot.shotId)).map(c=>c.label), ['B','C'], 'deleting A never renumbers B/C');
assert.equal((await getShotAssetVersions(shot.shotId)).length,4);
assert.equal((await getShotAssetVersions(shot.shotId,true)).length,5);
assert.ok((await reloaded.getShot(shot.shotId)).deletedCandidateAssetIds.includes(candidates[0].assetId),'deletion survives reload');
assert.deepEqual(await getRun(candidates[0].sourceRunId),candidateRunBefore,'immutable run history remains');
assert.ok(await getAsset(candidates[0].assetId),'media metadata preserved');
await assert.rejects(adoptShotAsset(shot.shotId,candidates[0].assetId), /恢复/);
await restoreShotCandidate(shot.shotId,candidates[0].assetId);
assert.deepEqual((await getShotCandidates(shot.shotId)).map(c=>c.label), ['A','B','C']);
await deleteShotCandidate(shot.shotId,candidates[2].assetId);
assert.equal(await getShotAssetLineage(shot.shotId,smooth.assetId),'候选C → 高清增强 → 流畅增强','deleting ancestor preserves lineage');
await restoreShotCandidate(shot.shotId,candidates[2].assetId);
assert.equal((await getShot(shot.shotId)).adoptedAssetId,smooth.assetId);
console.log('PASS recoverable candidate deletion, adoption protection, stable labels, reload persistence and lineage');

// Role V1 references only Asset IDs; frozen Asset/Run/Shot and media bytes are untouched.
const images = [source, ...await Promise.all(["side.png", "full.png"].map((filename, index) => registerAsset({ kind: "image", origin: "imported", filename, mimeType: "image/png", storageReference: `image:role-${index}`, sourceRunId: null })))];
const voice = await registerAsset({ kind: "audio", origin: "imported", filename: "柴犬.m4a", mimeType: "audio/mp4", storageReference: "media:shiba-voice", sourceRunId: null });
const shiba = await createRole("柴犬");
assert.equal((await getRole(shiba.roleId)).displayName, "柴犬");
for (const image of images) assert.equal((await addRoleAsset(shiba.roleId, image.assetId, "image")).added, true);
assert.equal((await addRoleAsset(shiba.roleId, images[0].assetId, "image")).added, false, "duplicate reference is idempotent");
assert.equal((await getRole(shiba.roleId)).appearanceAssetIds.length, 3);
await setPrimaryRoleAsset(shiba.roleId, images[1].assetId, "image");
await addRoleAsset(shiba.roleId, voice.assetId, "audio");
await updateRoleDetails(shiba.roleId, { description: "棕白毛发，深灰针织衫" });
const reloadedRoles = await import("../lib/role-records.ts?test-reload=1");
assert.equal((await reloadedRoles.getRole(shiba.roleId)).primaryAppearanceAssetId, images[1].assetId);
assert.equal((await reloadedRoles.getRole(shiba.roleId)).primaryVoiceAssetId, voice.assetId);
assert.equal((await reloadedRoles.getRole(shiba.roleId)).description, "棕白毛发，深灰针织衫");
assert.equal((await listRoles()).length, 1);
await removeRoleAsset(shiba.roleId, images[1].assetId, "image");
assert.equal((await getRole(shiba.roleId)).primaryAppearanceAssetId, null);
assert.ok(await getAsset(images[1].assetId), "unlink never deletes Asset");
assert.equal((await listAssets("image")).filter((asset) => images.some((image) => image.assetId === asset.assetId)).length, 3);
await deleteRole(shiba.roleId);
assert.equal(await getRole(shiba.roleId), null);
assert.ok(await getAsset(voice.assetId), "deleting Role preserves voice Asset");
assert.ok(await getAsset(images[0].assetId), "deleting Role preserves image Asset");
assert.equal((await getShot(shot.shotId)).adoptedAssetId, smooth.assetId, "deleting Role preserves adopted Shot");
assert.equal((await getRun(run.runId)).status, "completed", "deleting Role preserves Run");
console.log("Role creation, ID-only links, primary refs, duplicate prevention, unlink, delete, reload and frozen records passed");

// Phase 5, Test 5: a queued Ref2VA Run keeps its frozen Reference Manifest after the Role voice / appearance change.
{
  const dogFace = await registerAsset({ kind: "image", origin: "imported", filename: "柴犬正面.png", mimeType: "image/png", storageReference: "image:phase5-dog", sourceRunId: null });
  const dogSide = await registerAsset({ kind: "image", origin: "imported", filename: "柴犬侧面.png", mimeType: "image/png", storageReference: "image:phase5-dog-side", sourceRunId: null });
  const dogVoice = await registerAsset({ kind: "audio", origin: "generated", filename: "柴犬.wav", mimeType: "audio/wav", storageReference: "audio:phase5-dog", sourceRunId: null });
  const dogVoice2 = await registerAsset({ kind: "audio", origin: "generated", filename: "柴犬新.wav", mimeType: "audio/wav", storageReference: "audio:phase5-dog-2", sourceRunId: null });
  const dog = await createRole("柴犬");
  for (const [assetId, kind] of [[dogFace.assetId, "image"], [dogSide.assetId, "image"], [dogVoice.assetId, "audio"], [dogVoice2.assetId, "audio"]]) await addRoleAsset(dog.roleId, assetId, kind);
  const roleData = await loadManifestRoles([dog.roleId], getRole, getAsset);
  const manifest = buildReferenceManifest({ images: [], videos: [], audios: [], ...roleData, dialogue: [{ roleId: dog.roleId, text: "你是不是一直把装修公司的报价，当成装修总预算了？" }], soundMode: "av" });
  const compiled = compileH3Ref2vaPrompt({ rawPrompt: "柴犬说话", soundMode: "av", mode: "official_structured", manifest });
  const phase5Shot = await createShot();
  const queued = await createRun({ ...reference, shotId: phase5Shot.shotId, inputAssetIds: [dogFace.assetId, dogVoice.assetId], rawPrompt: "柴犬说话", finalPrompt: compiled.prompt, seed: 5, referenceManifest: manifest, promptMode: compiled.mode, promptCompile: { compilerVersion: compiled.compilerVersion, notes: compiled.notes } });
  assert.equal(queued.status, "queued");
  await setPrimaryRoleAsset(dog.roleId, dogVoice2.assetId, "audio");
  await setPrimaryRoleAsset(dog.roleId, dogSide.assetId, "image");
  const stored = await getRun(queued.runId);
  assert.equal(stored.referenceManifest.runId, queued.runId, "manifest carries its Run identity");
  assert.equal(stored.referenceManifest.shotId, phase5Shot.shotId);
  assert.equal(stored.referenceManifest.manifestId, manifest.manifestId);
  assert.equal(stored.referenceManifest.roleBindings[0].selectedVoiceAssetId, dogVoice.assetId, "queued Run keeps the old primary voice");
  assert.equal(stored.referenceManifest.roleBindings[0].selectedAppearanceAssetId, dogFace.assetId, "queued Run keeps the old primary appearance");
  assert.deepEqual(stored.referenceManifest.submissionOrder, { images: [dogFace.assetId], videos: [], audios: [dogVoice.assetId] });
  assert.deepEqual(stored.referenceManifest.speakers.map((item) => item.speakerId), ["S1"]);
  assert.equal(stored.promptMode, "official_structured");
  assert.equal(stored.finalPrompt, compiled.prompt);
  assert.equal(manifest.runId, null, "the in-memory frozen manifest is not mutated by createRun");
  await updateRun(queued.runId, { status: "running", startedAt: 1 });
  assert.deepEqual((await getRun(queued.runId)).referenceManifest, stored.referenceManifest, "status updates never touch the manifest");
  // A new submission sees the new primaries.
  const next = buildReferenceManifest({ images: [], videos: [], audios: [], ...(await loadManifestRoles([dog.roleId], getRole, getAsset)), dialogue: [{ roleId: dog.roleId, text: "再说一次" }], soundMode: "av" });
  assert.equal(next.roleBindings[0].selectedVoiceAssetId, dogVoice2.assetId);
  assert.equal(next.roleBindings[0].selectedAppearanceAssetId, dogSide.assetId);
}

// Phase 5, Test 8: older Ref2VA Runs have no manifest and are not given a fabricated one.
{
  const legacyRun = await getRun(refRun.runId);
  assert.equal(legacyRun.capabilityId, "h3_ref2va");
  assert.equal(legacyRun.referenceManifest, undefined);
  assert.equal(legacyRun.promptMode, undefined);
  assert.equal(legacyRun.referenceInputs.length, 2, "legacy submission order still readable");
}
console.log("Phase 5 Run manifest snapshot freeze and legacy Run compatibility passed");

// Phase 6: the Run ID is reserved as the ComfyUI prompt_id and persisted before /prompt; the owner node is recorded.
{
  const reserved = await createRun({ ...h3, ownerNodeId: "shape:phase6", inputAssetIds: [], rawPrompt: "p", finalPrompt: "p", seed: 1 }, { reservePromptId: true });
  const stored = await getRun(reserved.runId);
  assert.equal(stored.comfyPromptId, reserved.runId, "prompt_id reserved = Run ID, no new identity");
  assert.match(stored.comfyPromptId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "canonical lowercase UUID accepted by ComfyUI");
  assert.equal(stored.submission, "reserved");
  assert.equal(stored.ownerNodeId, "shape:phase6");
  assert.equal(stored.status, "queued");
  assert.equal(findActiveRunForNode("shape:phase6", await listRuns()).runId, reserved.runId, "a refreshed page finds the active Run by node");
  await updateRun(reserved.runId, { submission: "accepted", status: "running", startedAt: 2 });
  assert.equal((await getRun(reserved.runId)).submission, "accepted");
  await updateRun(reserved.runId, { status: "failed", completedAt: 3, error: "x" });
  assert.equal(findActiveRunForNode("shape:phase6", await listRuns()), null, "failed Run releases the node");
  await updateRun(reserved.runId, { status: "running" });
  assert.equal((await getRun(reserved.runId)).status, "failed", "terminal state is not reopened");
  const plain = await createRun({ ...h3, inputAssetIds: [], rawPrompt: "p", finalPrompt: "p", seed: 1 });
  assert.equal(plain.comfyPromptId, null, "without reservation the old behaviour is unchanged");
  assert.equal(plain.submission, undefined);
  assert.equal(plain.ownerNodeId, undefined);
}
console.log("Phase 6 prompt_id reservation, node ownership and active-Run lookup passed");
