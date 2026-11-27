import assert from "node:assert/strict";
import "./fake-indexeddb.mjs";
import { boardFromRows, boardTotals, buildBoardRows, effectiveDuration, emptyBoard, moveRow, setInOut, SHOT_BOARD_KEY, updateItem } from "../lib/shot-board.ts";
import { adoptShotAsset, addRunToShot, createRun, createShot, getMeta, getShot, listAssets, listRuns, listShots, markShotHasCandidates, putMeta, registerAsset, updateRun } from "../lib/production-records.ts";
import { collectProject } from "../lib/project-backup.ts";

const workflow = (capabilityId) => ({ capabilityId, parameters: {}, workflowIdentity: { capabilityId, templateVersion: "sha256:t", templateFile: "t.json" }, inputAssetIds: [], rawPrompt: null, finalPrompt: null, seed: null });
async function shotWithVersion(capabilityId, filename, duration, adopt = true) {
  const shot = await createShot();
  const run = await createRun({ ...workflow(capabilityId), shotId: shot.shotId });
  const asset = await registerAsset({ kind: "video", origin: "generated", filename, mimeType: "video/mp4", storageReference: `media:${filename}`, sourceRunId: run.runId, shotId: shot.shotId, duration });
  await updateRun(run.runId, { status: "completed", outputAssetIds: [asset.assetId] });
  await addRunToShot(shot.shotId, run.runId); await markShotHasCandidates(shot.shotId);
  if (adopt) await adoptShotAsset(shot.shotId, asset.assetId);
  return { shot: await getShot(shot.shotId), asset };
}
const load = async (board) => {
  const [shots, assets, runs] = await Promise.all([listShots(), listAssets("video"), listRuns()]);
  return buildBoardRows(board ?? (await getMeta(SHOT_BOARD_KEY)) ?? emptyBoard(), shots, new Map(assets.map((a) => [a.assetId, a])), new Map(runs.map((r) => [r.runId, r])));
};

const one = await shotWithVersion("h3_fl2va", "s1.mp4", 5.875);
const two = await shotWithVersion("seedvr2_upscale", "s2_hd.mp4", 8);
const three = await shotWithVersion("film_interpolation", "s3_smooth.mp4", 10.125);
const draft = await shotWithVersion("h3_fl2va", "s4.mp4", 6, false);
const shotsBefore = structuredClone(await listShots());

// Rows: every Shot, in shot-number order by default; source label from the adopted version's Run.
let rows = await load(emptyBoard());
assert.deepEqual(rows.map((row) => row.shot.shotNumber), [1, 2, 3, 4]);
assert.deepEqual(rows.map((row) => row.source), ["H3", "高清", "流畅", null]);
assert.deepEqual(rows.map((row) => row.item.included), [true, true, true, false], "adopted shots are included by default");
assert.equal(rows[3].canInclude, false);
assert.equal(rows[3].adopted, null);
assert.equal(rows[0].adopted.assetId, one.asset.assetId);
assert.equal(rows[2].adopted.assetId, three.asset.assetId, "FILM version adopted on shot 3");

// Not adopted → cannot be included.
assert.throws(() => updateItem(rows, draft.shot.shotId, { included: true }), /还没有 ★采用/);

// Reorder, exclude, note, in/out → saved and restored.
rows = moveRow(rows, 2, 0);
rows = updateItem(rows, two.shot.shotId, { included: false, note: "节奏太慢，备选" });
rows = setInOut(rows, one.shot.shotId, 0.5, 4);
assert.equal(rows.find((row) => row.shot.shotId === one.shot.shotId).effectiveDuration, 3.5);
await putMeta(SHOT_BOARD_KEY, boardFromRows(rows, 42));
const restored = await load();
assert.deepEqual(restored.map((row) => row.shot.shotNumber), [3, 1, 2, 4], "order kept after reload");
assert.deepEqual(restored.map((row) => row.item.included), [true, true, false, false]);
assert.equal(restored.find((row) => row.shot.shotId === two.shot.shotId).item.note, "节奏太慢，备选");
assert.deepEqual([restored[1].item.inPoint, restored[1].item.outPoint], [0.5, 4]);

// Totals: included only, with in/out applied.
assert.deepEqual(boardTotals(restored), { shots: 4, adopted: 3, included: 2, seconds: 10.125 + 3.5, unknownDurations: 0 });

// In/out validation: explicit errors, no silent clamping.
assert.throws(() => setInOut(restored, one.shot.shotId, -1, null), /入点必须是不小于 0 的秒数/);
assert.throws(() => setInOut(restored, one.shot.shotId, null, 9), /出点超出采用版本时长（5\.88 秒）/);
assert.throws(() => setInOut(restored, one.shot.shotId, 3, 3.05), /至少 0\.1 秒/);
assert.throws(() => setInOut(restored, one.shot.shotId, Number.NaN, null), /入点/);
assert.equal(setInOut(restored, one.shot.shotId, null, null).find((row) => row.shot.shotId === one.shot.shotId).effectiveDuration, 5.875, "clearing in/out restores full length");
assert.equal(effectiveDuration({ inPoint: 2, outPoint: null }, null), null);
assert.equal(effectiveDuration({ inPoint: 2, outPoint: 5 }, null), 3);

// New Shots appear at the end; deleted/missing Shots are dropped from the board, never invented.
const five = await shotWithVersion("h3_ref2va", "s5.mp4", 12);
const withNew = await load(buildBoardRowsBoard([{ shotId: "gone", included: true, note: "", inPoint: null, outPoint: null }]));
function buildBoardRowsBoard(extra) { return { schemaVersion: 1, items: [...extra, ...boardFromRows(restored).items], updatedAt: 1 }; }
assert.deepEqual(withNew.map((row) => row.shot.shotNumber), [3, 1, 2, 4, 5]);
assert.equal(withNew.at(-1).shot.shotId, five.shot.shotId);

// Adoption changed elsewhere → the board shows the new adopted version; its own items are kept.
{
  const alt = await registerAsset({ kind: "video", origin: "generated", filename: "s1_alt.mp4", mimeType: "video/mp4", storageReference: "media:s1_alt", sourceRunId: (await createRun({ ...workflow("h3_fl2va"), shotId: one.shot.shotId })).runId, shotId: one.shot.shotId, duration: 7 });
  const altRun = (await listRuns()).find((run) => run.runId === alt.sourceRunId);
  await updateRun(altRun.runId, { status: "completed", outputAssetIds: [alt.assetId] });
  await adoptShotAsset(one.shot.shotId, alt.assetId);
  const row = (await load()).find((item) => item.shot.shotId === one.shot.shotId);
  assert.equal(row.adopted.assetId, alt.assetId);
  assert.deepEqual([row.item.inPoint, row.item.outPoint], [0.5, 4], "board metadata survives re-adoption");
}

// The board never writes Shot / Candidate / Adopted records.
const shotsAfter = await listShots();
for (const before of shotsBefore) {
  const after = shotsAfter.find((shot) => shot.shotId === before.shotId);
  if (before.shotId === one.shot.shotId) continue; // re-adopted above through the normal adoption API
  assert.deepEqual(after, before, `Shot ${before.shotNumber} untouched by board edits`);
}

// Stored in the existing meta store → part of Phase 8 backups; the Shot counter is protected.
const project = await collectProject();
assert.ok(project.records.meta.some((row) => row.key === SHOT_BOARD_KEY), "board is included in project backups");
assert.equal(project.records.meta.find((row) => row.key === "nextShotNumber").value, 6);
await assert.rejects(putMeta("nextShotNumber", 1), /不能直接写入/);

console.log("Shot Board: default rows, adopted-only inclusion, reorder / include / note / in-out persistence, validation, totals, new & missing Shots, re-adoption, no Shot writes, backup inclusion passed");
