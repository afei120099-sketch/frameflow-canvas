import assert from "node:assert/strict";
import "./fake-indexeddb.mjs";
import { generationSeeds, runSerialGenerations, candidateRunInput } from "../lib/generation-batch.ts";
import { createRun, createShot, addRunToShot, updateRun, registerAsset, attachCompletedRunToShot, getShotCandidates, getShot, adoptShotAsset } from "../lib/production-records.ts";
assert.deepEqual(generationSeeds(3, 42), [42, 42, 42]);
assert.equal(new Set(generationSeeds(10, undefined, () => .5)).size, 10);
for (const count of [0, -1, 11, 1.5, NaN]) assert.throws(() => generationSeeds(count));
const seeds = generationSeeds(3);
let active = 0, max = 0;
const done = [];
await runSerialGenerations(seeds, new AbortController().signal, async (seed, i) => {
  active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 5)); done.push([seed, i]); active--;
});
assert.equal(max, 1); assert.deepEqual(done.map(x => x[1]), [0, 1, 2]);
for (const failure of [new Error("生成失败"), new Error("GPU_THERMAL_BLOCKED"), new Error("SubmissionUncertainError")]) {
  const calls = [];
  await assert.rejects(runSerialGenerations(seeds, new AbortController().signal, async (_, i) => { calls.push(i); if (i === 1) throw failure; }), failure);
  assert.deepEqual(calls, [0, 1]);
}
const controller = new AbortController(); let called = 0;
await assert.rejects(runSerialGenerations(seeds, controller.signal, async () => { called++; controller.abort(); }));
assert.equal(called, 1);
const shot = await createShot("批量候选", "h3-batch-test");
const template = await createRun({ capabilityId: "h3_fl2va", inputAssetIds: [], rawPrompt: "固定镜头", finalPrompt: "固定镜头", seed: seeds[0], parameters: { seed: seeds[0], generationBatch: { id: "batch", index: 1, count: 3 } }, workflowIdentity: { capabilityId: "h3_fl2va", templateVersion: "frozen", templateFile: "unchanged" }, shotId: shot.shotId, ownerNodeId: "h3-batch-test", directorContext: { sceneId: "scene", sceneStateId: null, cameraId: "camera", motionIds: ["motion"], controlPackageIds: ["guide"], handoffAssetIds: [], inputsMatchHandoff: true, anchorFrames: [50] } }, { reservePromptId: true });
const ids = [];
await runSerialGenerations(seeds, new AbortController().signal, async (seed, index) => {
  const run = index === 0 ? template : await createRun(candidateRunInput(template, seed, { id: "batch", index: index + 1, count: 3 }), { reservePromptId: true });
  ids.push(run.runId); assert.equal(run.comfyPromptId, run.runId); assert.equal(run.parameters.seed, seed); assert.deepEqual(run.directorContext.motionIds, ["motion"]);
  await addRunToShot(shot.shotId, run.runId);
  const asset = await registerAsset({ kind: "video", origin: "generated", filename: `candidate-${index}.mp4`, mimeType: "video/mp4", storageReference: `test:${index}`, sourceRunId: run.runId, shotId: shot.shotId });
  await updateRun(run.runId, { status: "completed", outputAssetIds: [asset.assetId] });
  await attachCompletedRunToShot(shot.shotId, run.runId, asset.assetId);
  if (index === 0) await adoptShotAsset(shot.shotId, asset.assetId);
});
assert.equal(new Set(ids).size, 3);
assert.equal((await getShotCandidates(shot.shotId)).length, 3);
assert.equal((await getShot(shot.shotId)).adoptedAssetId, (await getShotCandidates(shot.shotId))[0].asset.assetId);
console.log("PASS: 1–10 counts, unique random/fixed seeds, serial dispatch, cancel/failure/thermal/uncertainty stop, unique Run IDs, three candidates, director lineage and adopted asset preservation");
