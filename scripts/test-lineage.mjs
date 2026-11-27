import assert from "node:assert/strict";
import "./fake-indexeddb.mjs";
import { buildLineage, candidateLabels, lineageLines, relationName } from "../lib/lineage.ts";
import { addRunToShot, adoptShotAsset, createRun, createShot, getShot, getShotCandidates, listAssets, listRuns, listShots, markShotHasCandidates, registerAsset, updateRun } from "../lib/production-records.ts";

const wf = (capabilityId) => ({ capabilityId, parameters: {}, workflowIdentity: { capabilityId, templateVersion: "sha256:t", templateFile: "t.json" }, rawPrompt: null, finalPrompt: null, seed: null });
const asset = (filename, kind, extra = {}) => registerAsset({ kind, origin: extra.origin ?? "generated", filename, mimeType: kind === "image" ? "image/png" : kind === "audio" ? "audio/wav" : "video/mp4", storageReference: `${kind}:${filename}`, sourceRunId: null, ...extra });
async function completed(capabilityId, inputs, outputName, shotId, referenceInputs) {
  const run = await createRun({ ...wf(capabilityId), inputAssetIds: inputs.map((a) => a.assetId), shotId, referenceInputs });
  const out = await asset(outputName, "video", { sourceRunId: run.runId, shotId });
  await updateRun(run.runId, { status: "completed", outputAssetIds: [out.assetId] });
  if (shotId) await addRunToShot(shotId, run.runId);
  return { run, out };
}

// A realistic project.
const dog = await asset("柴犬正面.png", "image", { origin: "imported" });
const voice = await asset("柴犬.wav", "audio", { origin: "imported" });
const shot = await createShot();
const a = await completed("h3_ref2va", [dog, voice], "shot01_A.mp4", shot.shotId, [{ assetId: dog.assetId, kind: "image", role: "role_appearance", order: 0 }, { assetId: voice.assetId, kind: "audio", role: "role_voice", order: 1 }]);
const failedRun = await createRun({ ...wf("h3_fl2va"), inputAssetIds: [dog.assetId], shotId: shot.shotId });
await updateRun(failedRun.runId, { status: "failed" }); await addRunToShot(shot.shotId, failedRun.runId);
const b = await completed("h3_fl2va", [dog], "shot01_B.mp4", shot.shotId, [{ assetId: dog.assetId, kind: "image", role: "first_frame", order: 0 }]);
await markShotHasCandidates(shot.shotId);
await adoptShotAsset(shot.shotId, b.out.assetId);
const hd = await completed("seedvr2_upscale", [b.out], "shot01_B_hd.mp4", shot.shotId);
const smooth = await completed("film_interpolation", [hd.out], "shot01_B_hd_smooth.mp4", shot.shotId);
const extract = await asset("extract.wav", "audio", { derivationType: "audio_extract", sourceVideoAssetId: a.out.assetId });
const clip = await asset("clip.wav", "audio", { derivationType: "audio_clip", sourceAudioAssetId: extract.assetId, sourceVideoAssetId: a.out.assetId, sourceStartTime: 1, sourceEndTime: 2.5 });

const records = async () => { const [assets, runs, shots] = await Promise.all([listAssets(), listRuns(), listShots()]); return { assets: new Map(assets.map((x) => [x.assetId, x])), runs: new Map(runs.map((x) => [x.runId, x])), shots: new Map(shots.map((x) => [x.shotId, x])) }; };
const data = await records();

// Candidate letters agree with the real candidate panel (failed Run skipped, SeedVR2/FILM not candidates).
{
  const labels = candidateLabels(await getShot(shot.shotId), data.runs);
  const real = await getShotCandidates(shot.shotId);
  assert.deepEqual([...labels.entries()].map(([id, label]) => [id, label]), real.map((candidate) => [candidate.asset.assetId, candidate.label]));
  assert.deepEqual([...labels.values()], ["A", "B"]);
}

// FILM result → all the way up to the source image, with capabilities and ★ / candidate / derived roles.
{
  const lineage = buildLineage(smooth.out.assetId, data);
  assert.deepEqual(lineageLines(lineage.root), [
    "0|shot01_B_hd_smooth.mp4|result|film_interpolation|镜头衍生@1",
    "1|shot01_B_hd.mp4|source_video|seedvr2_upscale|镜头衍生@1",
    "2|shot01_B.mp4|source_video|h3_fl2va|★采用@1",
    "3|柴犬正面.png|first_frame||",
  ]);
  assert.equal(lineage.root.producedBy.capability, "FILM 流畅增强");
  assert.equal(lineage.derived.length, 0);
}

// Candidate A: Ref2VA inputs keep their manifest roles; downstream shows the extracted audio.
{
  const lineage = buildLineage(a.out.assetId, data);
  assert.deepEqual(lineageLines(lineage.root), ["0|shot01_A.mp4|result|h3_ref2va|候选A@1", "1|柴犬正面.png|role_appearance||", "1|柴犬.wav|role_voice||"]);
  assert.deepEqual(lineage.derived.map((node) => [node.asset.filename, node.relation]), [["extract.wav", "视频提取声音"]]);
  assert.equal(relationName("role_appearance"), "角色主外观");
  assert.equal(relationName("first_frame+reference_image"), "首帧 / 参考图");
}

// Adopted B: downstream is the SeedVR2 result.
assert.deepEqual(buildLineage(b.out.assetId, data).derived.map((node) => [node.asset.filename, node.relation]), [["shot01_B_hd.mp4", "SeedVR2 高清增强"]]);

// Audio clip → extract → source video (→ its own H3 inputs).
{
  const lines = lineageLines(buildLineage(clip.assetId, data).root);
  assert.equal(lines[0], "0|clip.wav|result|声音裁剪（1.00–2.50 秒）|");
  assert.equal(lines[1], "1|extract.wav|source_audio|视频提取声音|");
  assert.equal(lines[2], "2|shot01_A.mp4|source_video|h3_ref2va|候选A@1");
  assert.equal(lines.length, 5);
}

// The source image is a root; its downstream lists every Run that used it.
{
  const lineage = buildLineage(dog.assetId, data);
  assert.equal(lineage.root.producedBy, null);
  assert.equal(lineage.root.inputs.length, 0);
  assert.deepEqual(lineage.derived.map((node) => node.asset.filename).sort(), ["shot01_A.mp4", "shot01_B.mp4"], "failed Runs are not listed as results");
}

// Missing records and cycles are shown, never invented or looped.
{
  const broken = { ...data, assets: new Map(data.assets) };
  broken.assets.delete(b.out.assetId);
  const lines = lineageLines(buildLineage(hd.out.assetId, broken).root);
  assert.deepEqual(lines, ["0|shot01_B_hd.mp4|result|seedvr2_upscale|镜头衍生@1", `1|缺失:${b.out.assetId}|source_video|||missing`]);
  const cyclic = { ...data, assets: new Map(data.assets), runs: new Map(data.runs) };
  const loopRun = { ...data.runs.get(b.run.runId), inputAssetIds: [smooth.out.assetId] };
  cyclic.runs.set(b.run.runId, loopRun);
  const cycleLines = lineageLines(buildLineage(smooth.out.assetId, cyclic).root);
  assert.ok(cycleLines.at(-1).endsWith("|cycle"), cycleLines.join("\n"));
  assert.equal(cycleLines.length, 4);
}

// Read-only: building lineage never changes records.
{
  const before = JSON.stringify([...(await listAssets()), ...(await listRuns()), ...(await listShots())]);
  for (const id of [smooth.out.assetId, clip.assetId, dog.assetId]) buildLineage(id, await records());
  assert.equal(JSON.stringify([...(await listAssets()), ...(await listRuns()), ...(await listShots())]), before);
}

console.log("Lineage: candidate letters match the candidate panel, FILM→SeedVR2→★H3→image chain, Ref2VA roles, downstream results, audio extract/clip chain, missing & cycle guards, read-only passed");
