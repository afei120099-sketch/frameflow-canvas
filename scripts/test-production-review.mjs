import assert from "node:assert/strict";
import { databases } from "./fake-indexeddb.mjs";
import { addItem, createFinalCutList, finalCutJson, normalizeFinalCutList, resolveRows, setItemRange, updateItem } from "../lib/final-cut-list.ts";
import { clipReviewState, reviewClip, setReviewRequired } from "../lib/production-review.ts";
import { collectAdoptedClips } from "../lib/production-assembly.ts";
import { collectAdoptedToFinalCutList, loadFinalCutList, mutateFinalCutList } from "../lib/final-cut-store.ts";
import { freezeRoughCut, sameRoughCut } from "../lib/rough-cut.ts";
import { buildBoardRows } from "../lib/shot-board.ts";
import { addRunToShot, adoptShotAsset, createRun, createShot, listAssets, listRuns, listShots, putMeta, registerAsset, updateRun } from "../lib/production-records.ts";
import { storeLocalVideo } from "../lib/local-video-store.ts";
import { exportProject, readBackup, restoreProject } from "../lib/project-backup.ts";

const asset = { assetId: "a", kind: "video", origin: "imported", filename: "a.mp4", storageReference: "media:a", sourceRunId: null, duration: 5, mimeType: "video/mp4", fileSize: 10 };
let list = addItem(createFinalCutList(), { asset }, { itemId: "clip" }).list;
const rows = (value, source = asset) => resolveRows(value, { assets: new Map([[source.assetId, source]]) });
const freeze = (value, source = asset) => freezeRoughCut(value, rows(value, source));
assert.equal(freeze(list).ok, true, "old free editing unchanged");
list = setReviewRequired(list, true);
assert.equal(freeze(list).ok, false, "pending enabled clip blocks, never silently omitted");
assert.equal(rows(list)[0].counted, false);
assert.equal(rows(list)[0].status, "review_pending");
list = reviewClip(list, "clip", asset, "approved", 100);
assert.equal(freeze(list).ok, true);
assert.equal(freeze(list).snapshot.review.items[0].reviewedAt, 100);
assert.equal(sameRoughCut(freeze(list).snapshot, { ...freeze(list).snapshot, review: undefined }), false, "changed approval evidence requires reprepare");
assert.equal(clipReviewState(list.items[0], asset), "approved");
assert.equal(clipReviewState(list.items[0], { ...asset, storageReference: "media:new" }), "stale");
assert.equal(freeze(list, { ...asset, fileSize: 20 }).ok, false);
assert.equal(freeze(setItemRange(list, "clip", 1, 4, 5)).ok, false, "trim invalidates approval");
assert.equal(freeze(updateItem(list, "clip", { title: "new title", note: "notes" })).ok, true, "editorial text does not invalidate media");
assert.equal(normalizeFinalCutList(JSON.parse(JSON.stringify(list))).items[0].review.decision, "approved");
assert.equal(JSON.parse(finalCutJson(list, rows(list))).requireReview, true);
assert.equal(JSON.parse(finalCutJson(list, rows(list))).items[0].review.decision, "approved");
assert.throws(() => reviewClip(list, "clip", { ...asset, assetId: "wrong" }, "approved"), /素材已失效/);
assert.throws(() => reviewClip(list, "missing", asset, "approved"), /不在成片/);
assert.throws(() => reviewClip({ ...list, items: [{ ...list.items[0], outPoint: null }] }, "clip", asset, "approved"), /时长/);
const rejected = reviewClip(list, "clip", asset, "rejected");
assert.equal(freeze(rejected).ok, false);
assert.equal(freeze(setReviewRequired(rejected, false)).ok, true, "explicit opt-out leaves free editing available");
const two = addItem(rejected, { asset: { ...asset, assetId: "b", storageReference: "media:b" } }).list;
const disabled = updateItem(two, "clip", { enabled: false });
assert.equal(freezeRoughCut(disabled, resolveRows(disabled, { assets: new Map([["a", asset], ["b", { ...asset, assetId: "b" }]]) })).ok, false, "remaining pending still blocks");

async function fixture(title) {
  const shot = await createShot(title);
  const run = await createRun({ shotId: shot.shotId, capabilityId: "h3_fl2va", parameters: {}, workflowIdentity: { capabilityId: "h3_fl2va", templateVersion: "test", templateFile: "test" }, inputAssetIds: [], rawPrompt: null, finalPrompt: null, seed: null });
  const storageReference = await storeLocalVideo(new Blob([title], { type: "video/mp4" }), `${title}.mp4`);
  const video = await registerAsset({ ...asset, assetId: undefined, filename: `${title}.mp4`, shotId: shot.shotId, storageReference, sourceRunId: run.runId });
  await updateRun(run.runId, { status: "completed", outputAssetIds: [video.assetId] });
  await addRunToShot(shot.shotId, run.runId); await adoptShotAsset(shot.shotId, video.assetId);
  return { shot, video };
}
const first = await fixture("第一镜"), second = await fixture("第二镜");
const board = { schemaVersion: 1, updatedAt: 1, items: [
  { shotId: second.shot.shotId, included: true, inPoint: 1, outPoint: 3, note: "第二镜先放" },
  { shotId: first.shot.shotId, included: true, inPoint: null, outPoint: null, note: "" },
] };
await putMeta("shotBoard", board);
const before = structuredClone({ assets: await listAssets(), runs: await listRuns(), shots: await listShots() });
const collected = await collectAdoptedToFinalCutList();
assert.equal(collected.result.added, 2);
assert.deepEqual(collected.list.items.map((item) => item.assetId), [second.video.assetId, first.video.assetId]);
assert.equal(collected.list.items[0].inPoint, 1); assert.equal(collected.list.items[0].outPoint, 3);
assert.equal(collected.list.items[0].review, undefined, "adoption is not an invented human approval");
assert.equal((await collectAdoptedToFinalCutList()).result.added, 0, "repeat collection is idempotent");
const runMap = new Map((await listRuns()).map((run) => [run.runId, run]));
const boardRows = buildBoardRows(board, await listShots(), new Map((await listAssets()).map((video) => [video.assetId, video])), runMap);
assert.equal(collectAdoptedClips(createFinalCutList(), boardRows, new Map()).added, 0, "mismatched provenance rejected");
assert.deepEqual({ assets: await listAssets(), runs: await listRuns(), shots: await listShots() }, before, "never edits existing generation records");

await mutateFinalCutList((current) => reviewClip(setReviewRequired(current, true), current.items[0].itemId, second.video, "approved", 123));
const saved = await loadFinalCutList();
const files = new Map();
await exportProject(null, { writeBlob: async (name, blob) => files.set(name, blob), writeText: async (name, value) => files.set(name, new Blob([value])) }, { appVersion: "test", persistenceKey: "frameflow-v0.1-canvas", now: 1 });
const backup = await readBackup({ has: (name) => files.has(name), size: (name) => files.get(name)?.size ?? null, readText: async (name) => files.get(name)?.text() ?? null, readBlob: async (name) => files.get(name) ?? null });
for (const db of databases.values()) { const tx = db.transaction(); for (const name of ["assets", "runs", "shots", "meta", "videos", "images", "audios", "roles"]) if (db.objectStoreNames.contains(name)) tx.objectStore(name).clear(); }
await new Promise((resolve) => setTimeout(resolve, 0));
const restored = await restoreProject(backup, { current: () => null, load: () => {} });
assert.equal(restored.ok, true);
assert.deepEqual(await loadFinalCutList(), saved, "review policy, decisions and fingerprint survive backup/restore");
console.log("Production review: approval gate, source/trim invalidation, rejection, legacy compatibility, ordered adopted collection, idempotency, provenance, immutable generation records and backup/restore passed");
