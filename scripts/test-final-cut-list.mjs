import assert from "node:assert/strict";
import { databases } from "./fake-indexeddb.mjs";
import { addRunToShot, adoptShotAsset, createRun, createShot, getMeta, getShot, listAssets, listRuns, listShots, markShotHasCandidates, registerAsset, updateRun } from "../lib/production-records.ts";
import { storeLocalVideo, getLocalVideoBlob } from "../lib/local-video-store.ts";
import { collectProject, exportProject, readBackup, restoreProject } from "../lib/project-backup.ts";
import { confirmDuration, CSV_COLUMNS, duplicateItem, exportEntries, exportFinalCutMedia, filterRows, FINAL_CUT_KEY, finalCutCsv, finalCutJson, finalCutTotals, mediaFileName, MEDIA_NOTE, moveItem, normalizeFinalCutList, removeItem, resolveRows, setItemRange, updateItem, createFinalCutList, addItem } from "../lib/final-cut-list.ts";
import { addAssetToFinalCutList, loadFinalCutList, mutateFinalCutList } from "../lib/final-cut-store.ts";

const workflow = (capabilityId) => ({ capabilityId, parameters: {}, workflowIdentity: { capabilityId, templateVersion: "sha256:t", templateFile: "t.json" }, inputAssetIds: [], rawPrompt: null, finalPrompt: null, seed: null });
/** A generated video in its own Shot (its own "first frame" / H3 node / batch). */
async function generated(capabilityId, filename, duration, { shotTitle = "", adopt = false, shot: existingShot } = {}) {
  const shot = existingShot ?? await createShot(shotTitle);
  const run = await createRun({ ...workflow(capabilityId), shotId: shot.shotId });
  const storageReference = await storeLocalVideo(new Blob([`MP4:${filename}`], { type: "video/mp4" }), filename);
  const asset = await registerAsset({ kind: "video", origin: "generated", filename, mimeType: "video/mp4", storageReference, sourceRunId: run.runId, shotId: shot.shotId, duration });
  await updateRun(run.runId, { status: "completed", outputAssetIds: [asset.assetId] });
  await addRunToShot(shot.shotId, run.runId); await markShotHasCandidates(shot.shotId);
  if (adopt) await adoptShotAsset(shot.shotId, asset.assetId);
  return { shot: await getShot(shot.shotId), run, asset };
}
const lookups = async () => ({ assets: new Map((await listAssets()).map((asset) => [asset.assetId, asset])), shots: new Map((await listShots()).map((shot) => [shot.shotId, shot])) });
const rowsOf = async (list) => resolveRows(list ?? await loadFinalCutList(), await lookups());

// Fixtures: three videos from different Shots / first frames / batches, one imported video without Shot / Run.
const bedroom = await generated("h3_fl2va", "主卧首帧A.mp4", 5.875, { shotTitle: "主卧首帧A", adopt: true });
const dog = await generated("h3_ref2va", "柴犬对话.mp4", 8.042, { shotTitle: "柴犬对话" });
const living = await generated("seedvr2_upscale", "客厅C_hd.mp4", 10);
const smooth = await generated("film_interpolation", "黑洞_smooth.mp4", 6, { shotTitle: "黑洞" });
const importedRef = await storeLocalVideo(new Blob(["MP4:imported"], { type: "video/mp4" }), "航拍素材.mp4");
const imported = await registerAsset({ kind: "video", origin: "imported", filename: "航拍素材.mp4", mimeType: "video/mp4", storageReference: importedRef, sourceRunId: null, duration: 12.5 });
const noDurationRef = await storeLocalVideo(new Blob(["MP4:unknown"], { type: "video/mp4" }), "未知时长.mp4");
const noDuration = await registerAsset({ kind: "video", origin: "imported", filename: "未知时长.mp4", mimeType: "video/mp4", storageReference: noDurationRef, sourceRunId: null });
const image = await registerAsset({ kind: "image", origin: "imported", filename: "首帧.png", mimeType: "image/png", storageReference: "image:x", sourceRunId: null });
const recordsBefore = structuredClone({ assets: await listAssets(), runs: await listRuns(), shots: await listShots() });

// 1. Three videos from different Shots / first frames → one list, in the order they were added.
await addAssetToFinalCutList(dog.asset.assetId);
await addAssetToFinalCutList(bedroom.asset.assetId);
await addAssetToFinalCutList(living.asset.assetId);
let list = await loadFinalCutList();
assert.deepEqual(list.items.map((item) => item.assetId), [dog.asset.assetId, bedroom.asset.assetId, living.asset.assetId], "added order, not shot number / time / ID");
assert.deepEqual(list.items.map((item) => item.order), [1, 2, 3]);
assert.deepEqual(list.items.map((item) => item.sourceCapability), ["h3", "h3", "seedvr2"]);
assert.deepEqual(list.items.map((item) => item.title), ["柴犬对话", "主卧首帧A", "客厅C_hd.mp4"], "Shot title, else file name");
assert.deepEqual(list.items.map((item) => [item.inPoint, item.outPoint]), [[0, 8.042], [0, 5.875], [0, 10]], "default range = whole video");
assert.equal(list.items[0].shotId, dog.shot.shotId); assert.equal(list.items[0].runId, dog.run.runId);

// 2. Imported video without Shot / Run → allowed, shown as 独立素材.
const importedAdd = await addAssetToFinalCutList(imported.assetId);
assert.equal(importedAdd.item.shotId, undefined); assert.equal(importedAdd.item.runId, undefined);
assert.equal(importedAdd.item.sourceCapability, "imported");
let rows = await rowsOf();
assert.equal(rows[3].shotLabel, "独立素材"); assert.equal(rows[3].sourceLabel, "导入视频"); assert.equal(rows[3].problem, null);
assert.equal(rows[0].shotLabel, `镜头 ${String(dog.shot.shotNumber).padStart(2, "0")} · 柴犬对话`);
// Only video Assets; images and unknown IDs are refused with a clear message.
await assert.rejects(addAssetToFinalCutList(image.assetId), /只有视频素材/);
await assert.rejects(addAssetToFinalCutList("no-such-asset"), /素材记录不存在/);

// 3. Same Asset twice → different itemIds, independent ranges.
const again = await addAssetToFinalCutList(dog.asset.assetId, { title: "柴犬对话 · 后半段" });
list = await loadFinalCutList();
const [first, second] = list.items.filter((item) => item.assetId === dog.asset.assetId);
assert.notEqual(first.itemId, second.itemId);
assert.equal(second.itemId, again.item.itemId);
({ list } = await mutateFinalCutList((current) => setItemRange(setItemRange(current, first.itemId, 0, 2, 8.042), second.itemId, 4, 6, 8.042)));
assert.deepEqual(list.items.filter((item) => item.assetId === dog.asset.assetId).map((item) => [item.inPoint, item.outPoint]), [[0, 2], [4, 6]]);
{ // duplicateItem inserts right after the original with its own ID.
  const dup = duplicateItem(list, first.itemId, { itemId: "dup-1", now: 5 });
  assert.equal(dup.list.items[1].itemId, "dup-1"); assert.equal(dup.list.items[1].assetId, dog.asset.assetId); assert.equal(dup.list.items.length, list.items.length + 1);
  assert.deepEqual(dup.list.items.map((item) => item.order), dup.list.items.map((_, index) => index + 1));
}

// 4. Drag reorder → saved; after reload the order is kept exactly (no automatic sorting).
({ list } = await mutateFinalCutList((current) => moveItem(current, 4, 0))); // second dog range to the top
({ list } = await mutateFinalCutList((current) => moveItem(current, 2, 4)));
const expectedOrder = list.items.map((item) => item.itemId);
const reloaded = normalizeFinalCutList(structuredClone(await getMeta(FINAL_CUT_KEY)));
assert.deepEqual(reloaded.items.map((item) => item.itemId), expectedOrder, "order kept after reload");
assert.deepEqual(reloaded.items.map((item) => item.order), [1, 2, 3, 4, 5]);
{ // Stored order field wins over array position (robust load).
  const shuffled = structuredClone(reloaded); shuffled.items.reverse();
  assert.deepEqual(normalizeFinalCutList(shuffled).items.map((item) => item.itemId), expectedOrder);
}

// 5. enabled=false → kept in the list, not in the total; exported with status "disabled" and no cutOrder / media file.
rows = await rowsOf();
const totalBefore = finalCutTotals(rows);
const disabledId = list.items.find((item) => item.assetId === living.asset.assetId).itemId;
({ list } = await mutateFinalCutList((current) => updateItem(current, disabledId, { enabled: false, note: "节奏太慢" })));
rows = await rowsOf();
const totals = finalCutTotals(rows);
assert.equal(totals.items, 5); assert.equal(totals.enabled, 4); assert.equal(totals.counted, 4);
assert.equal(totals.seconds, Math.round((totalBefore.seconds - 10) * 1000) / 1000, "disabled clip not in the total");
assert.equal(totals.seconds, 2 + 2 + 5.875 + 12.5);
const disabledEntry = exportEntries(rows).find((entry) => entry.status === "disabled");
assert.deepEqual([disabledEntry.enabled, disabledEntry.cutOrder, disabledEntry.mediaFile, disabledEntry.note], [false, null, null, "节奏太慢"]);

// 6. In / out validation: 0 ≤ in < out ≤ duration, explicit errors, never saved when invalid.
{
  const id = list.items.find((item) => item.assetId === bedroom.asset.assetId).itemId;
  assert.throws(() => setItemRange(list, id, -0.5, 3, 5.875), /入点必须是不小于 0/);
  assert.throws(() => setItemRange(list, id, 0, 6, 5.875), /出点超出视频时长（5\.875 秒）/);
  assert.throws(() => setItemRange(list, id, 3, 3, 5.875), /出点必须晚于入点/);
  assert.throws(() => setItemRange(list, id, 4, 3, 5.875), /出点必须晚于入点/);
  assert.throws(() => setItemRange(list, id, Number.NaN, 3, 5.875), /入点/);
  assert.throws(() => setItemRange(list, id, 0, 3, null), /无法确认视频时长/);
  assert.equal(setItemRange(list, id, 0, 5.875, 5.875).items.find((item) => item.itemId === id).outPoint, 5.875, "out = full duration is valid");
  await assert.rejects(mutateFinalCutList((current) => setItemRange(current, id, 0, 99, 5.875)), /出点超出/);
  assert.deepEqual((await loadFinalCutList()).items.find((item) => item.itemId === id), list.items.find((item) => item.itemId === id), "a rejected range is not saved");
  // Real browser durations have more decimals than the UI shows (2.461533 s is shown as 2.462).
  {
    const precise = { ...imported, assetId: "precise", duration: 2.461533 };
    const added = addItem(createFinalCutList({ now: 1 }), { asset: precise }, { itemId: "p", now: 1 });
    const preciseRows = resolveRows(added.list, { assets: new Map([["precise", precise]]) });
    assert.deepEqual([preciseRows[0].problem, preciseRows[0].item.outPoint, preciseRows[0].clipDuration], [null, 2.461533, 2.462], "default out = exact end, counted");
    const typedEnd = setItemRange(added.list, "p", 0.5, 2.462, 2.461533);
    assert.equal(typedEnd.items[0].outPoint, 2.461533, "the displayed end value is accepted as the end");
    assert.equal(resolveRows(typedEnd, { assets: new Map([["precise", precise]]) })[0].problem, null);
    assert.throws(() => setItemRange(added.list, "p", 0, 2.463, 2.461533), /出点超出视频时长（2.462 秒）/);
  }
  // Unknown duration: added, clearly marked, not counted, range editing refused.
  const unknown = await addAssetToFinalCutList(noDuration.assetId);
  assert.equal(unknown.durationKnown, false);
  const unknownRow = (await rowsOf()).find((row) => row.item.itemId === unknown.item.itemId);
  assert.equal(unknownRow.problem, "unknown_duration"); assert.equal(unknownRow.counted, false);
  // Reading the duration later ("读取时长") makes it a normal clip; invalid durations are refused.
  {
    const current = await loadFinalCutList();
    assert.throws(() => confirmDuration(current, unknown.item.itemId, Number.NaN), /无法确认视频时长/);
    const fixed = confirmDuration(current, unknown.item.itemId, 7.5);
    const fixedRow = resolveRows(fixed, await lookups()).find((row) => row.item.itemId === unknown.item.itemId);
    assert.deepEqual([fixedRow.problem, fixedRow.item.outPoint, fixedRow.clipDuration], [null, 7.5, 7.5]);
  }
  // A probe fills in the duration (the Asset record itself is not modified).
  const probed = await addAssetToFinalCutList(noDuration.assetId, { probeDuration: async () => 3.25 });
  assert.deepEqual([probed.durationKnown, probed.item.outPoint, probed.item.sourceDuration], [true, 3.25, 3.25]);
  assert.equal((await listAssets()).find((asset) => asset.assetId === noDuration.assetId).duration, undefined, "Asset record untouched");
  ({ list } = await mutateFinalCutList((current) => removeItem(removeItem(current, unknown.item.itemId), probed.item.itemId)));
}

// 7. Missing Asset → item kept, marked 素材已失效, not in the total, not exported as a clip.
{
  const ghost = createFinalCutList({ sequenceId: "g", now: 1 });
  const withGhost = addItem(ghost, { asset: { ...imported, assetId: "deleted-asset" } }, { itemId: "ghost", now: 1 }).list;
  const withBoth = addItem(withGhost, { asset: imported }, { itemId: "real", now: 1 }).list;
  const ghostRows = resolveRows(withBoth, await lookups());
  assert.equal(ghostRows.length, 2, "missing item is not dropped");
  assert.deepEqual([ghostRows[0].problem, ghostRows[0].status, ghostRows[0].counted], ["missing", "missing", false]);
  assert.equal(finalCutTotals(ghostRows).seconds, 12.5);
  assert.equal(exportEntries(ghostRows)[0].cutOrder, null); assert.equal(exportEntries(ghostRows)[1].cutOrder, 1);
  // An Asset whose recorded duration no longer covers the saved range is flagged, not clamped.
  const shrunk = resolveRows(withBoth, { assets: new Map([[imported.assetId, { ...imported, duration: 5 }]]) });
  assert.equal(shrunk[1].problem, "invalid_range"); assert.equal(shrunk[1].item.outPoint, 12.5);
}

// 8. Shot ★ adopted video → one click (Shot Board passes the Shot as a hint).
{
  const adopted = await addAssetToFinalCutList(bedroom.shot.adoptedAssetId, { shotId: bedroom.shot.shotId });
  assert.equal(adopted.item.assetId, bedroom.asset.assetId); assert.equal(adopted.item.shotId, bedroom.shot.shotId); assert.equal(adopted.item.title, "主卧首帧A");
  ({ list } = await mutateFinalCutList((current) => removeItem(current, adopted.item.itemId)));
}

// 9. Not adopted, other candidate of a Shot, FILM output → all allowed.
{
  const candidateB = await generated("h3_fl2va", "主卧首帧A_候选B.mp4", 5.875, { shot: bedroom.shot });
  const b = await addAssetToFinalCutList(candidateB.asset.assetId);
  const film = await addAssetToFinalCutList(smooth.asset.assetId);
  assert.equal(b.item.shotId, bedroom.shot.shotId, "a non-adopted candidate of the same Shot");
  assert.equal(film.item.sourceCapability, "film");
  assert.notEqual((await getShot(bedroom.shot.shotId)).adoptedAssetId, candidateB.asset.assetId);
  list = await loadFinalCutList();
}

// Shot / Run / Asset records are never written by the list (only the extra fixtures above were added).
{
  const after = { assets: await listAssets(), runs: await listRuns(), shots: await listShots() };
  for (const [kind, key] of [["assets", "assetId"], ["runs", "runId"]]) for (const before of recordsBefore[kind]) assert.deepEqual(after[kind].find((row) => row[key] === before[key]), before, `${kind} untouched`);
  for (const before of recordsBefore.shots.filter((shot) => shot.shotId !== bedroom.shot.shotId)) assert.deepEqual(after.shots.find((shot) => shot.shotId === before.shotId), before, "Shot untouched");
}

// 11 + 12. JSON / CSV in exactly the user's order, every required field present.
rows = await rowsOf(list);
{
  const json = JSON.parse(finalCutJson(list, rows, 1_700_000_000_000));
  assert.equal(json.format, "frameflow-final-cut-list"); assert.equal(json.mediaNote, MEDIA_NOTE); assert.equal(json.timeUnit, "seconds");
  assert.deepEqual(json.items.map((entry) => entry.assetId), list.items.map((item) => item.assetId), "JSON order = list order");
  assert.deepEqual(json.items.map((entry) => entry.order), list.items.map((_, index) => index + 1));
  for (const key of ["order", "title", "assetId", "filename", "inPoint", "outPoint", "clipDuration", "enabled", "shotId", "runId", "sourceCapability", "note"]) assert.ok(key in json.items[0], `JSON has ${key}`);
  assert.deepEqual(json.items.filter((entry) => entry.cutOrder !== null).map((entry) => entry.cutOrder), [1, 2, 3, 4, 5, 6]);
  assert.equal(json.totals.seconds, finalCutTotals(rows).seconds);
  const dogRanges = json.items.filter((entry) => entry.assetId === dog.asset.assetId).map((entry) => [entry.inPoint, entry.outPoint, entry.clipDuration]);
  assert.deepEqual(dogRanges, [[4, 6, 2], [0, 2, 2]], "repeated Asset keeps both ranges, in list order");

  const csv = finalCutCsv(rows);
  assert.ok(csv.startsWith("﻿"), "BOM for spreadsheet apps");
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.equal(lines[0], CSV_COLUMNS.join(","));
  assert.equal(lines.length, list.items.length + 1);
  const assetColumn = CSV_COLUMNS.indexOf("assetId");
  assert.deepEqual(lines.slice(1).map((line) => line.split(",")[assetColumn]), list.items.map((item) => item.assetId), "CSV order = list order");
  // Quoting and formula-safety.
  const tricky = resolveRows(updateItem(list, list.items[0].itemId, { title: "=HYPERLINK(\"x\")", note: "有逗号, 和\n换行" }), await lookups());
  const trickyLine = finalCutCsv(tricky).split("\r\n")[1];
  assert.ok(trickyLine.includes(`"'=HYPERLINK(""x"")"`), trickyLine);
  assert.ok(trickyLine.includes(`"有逗号, 和\n换行"`));
}

// Media export: only cut clips, numbered in order, original bytes, plus the edit list and the note.
{
  const files = new Map();
  const sink = { writeBlob: async (path, blob) => { files.set(path, blob); }, writeText: async (path, text) => { files.set(path, text); } };
  const report = await exportFinalCutMedia(list, rows, sink, (asset) => getLocalVideoBlob(asset.storageReference), { now: 1 });
  const expected = exportEntries(rows).filter((entry) => entry.cutOrder !== null);
  assert.deepEqual(report.written.map((entry) => entry.file), expected.map((entry) => entry.mediaFile));
  assert.ok(report.written[0].file.startsWith("001_") && report.written.at(-1).file.startsWith(`${String(expected.length).padStart(3, "0")}_`));
  assert.equal(await files.get(report.written[0].file).text(), `MP4:${rows.find((row) => row.item.assetId === report.written[0].assetId).asset.filename}`, "original bytes, not cut");
  assert.deepEqual(report.skipped.map((entry) => entry.reason), ["未纳入成片"]);
  assert.ok(files.has("剪辑清单.json") && files.has("剪辑清单.csv") && files.get("说明.txt").includes(MEDIA_NOTE));
  assert.equal(mediaFileName(7, 'a<b>:c"/d\\e|f?g*. ', "x.MP4"), "007_a_b__c__d_e_f_g_.mp4");
  assert.equal(mediaFileName(12, "", "clip.webm"), "012_片段.webm");
}

// 10. Phase 8 backup: export → wipe → restore → the list comes back identical.
{
  const saved = await loadFinalCutList();
  assert.ok(saved.items.some((item) => !item.enabled) && saved.items.some((item) => item.note) && saved.items.some((item) => item.inPoint > 0));
  const files = new Map();
  const sink = { writeText: async (path, text) => { files.set(path, new Blob([text])); }, writeBlob: async (path, blob) => { files.set(path, blob); } };
  const source = { has: (path) => files.has(path), size: (path) => files.get(path)?.size ?? null, readText: async (path) => files.get(path).text(), readBlob: async (path) => files.get(path) };
  await exportProject(null, sink, { appVersion: "test", persistenceKey: "frameflow-v0.1-canvas", now: 1 });
  assert.ok(JSON.parse(await files.get("records.json").text()).meta.some((row) => row.key === FINAL_CUT_KEY), "list is in records.json meta");
  // Wipe in place (the modules keep their open connections), so the restore really rebuilds everything.
  const STORES = { "frameflow-production-records": ["assets", "runs", "shots", "meta"], "frameflow-local-media": ["videos", "images"], "frameflow-local-audio": ["audios"], "frameflow-role-records": ["roles"] };
  for (const [name, stores] of Object.entries(STORES)) { const db = databases.get(name); if (!db) continue; const tx = db.transaction(); for (const store of stores) if (db.objectStoreNames.contains(store)) tx.objectStore(store).clear(); }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await loadFinalCutList()).items.length, 0);
  assert.equal((await listAssets()).length, 0);
  const parsed = await readBackup(source);
  const report = await restoreProject(parsed, { current: () => null, load: () => {} });
  assert.equal(report.ok, true);
  const restored = await loadFinalCutList();
  assert.deepEqual(restored, saved, "order, in/out, notes, enabled, titles, IDs all restored");
  assert.equal(resolveRows(restored, await lookups()).filter((row) => row.problem === "missing").length, 0, "Assets restored too");
  assert.ok((await collectProject()).records.meta.some((row) => row.key === FINAL_CUT_KEY));
}

// Concurrent adds (node button + library + panel) are serialised; nothing is lost.
{
  const before = (await loadFinalCutList()).items.length;
  await Promise.all([dog, bedroom, living, smooth].map((fixture) => addAssetToFinalCutList(fixture.asset.assetId)));
  assert.equal((await loadFinalCutList()).items.length, before + 4);
}

// 13. 500 items: reorder, search, totals.
{
  const assets = new Map(Array.from({ length: 250 }, (_, i) => [`a${i}`, { schemaVersion: 1, assetId: `a${i}`, kind: "video", origin: "imported", filename: `片段${i}.mp4`, mimeType: "video/mp4", createdAt: i, storageReference: `media:${i}`, sourceRunId: null, duration: 4 + (i % 7) }]));
  let big = createFinalCutList({ sequenceId: "big", now: 1 });
  for (let i = 0; i < 500; i += 1) big = addItem(big, { asset: assets.get(`a${i % 250}`) }, { itemId: `i${i}`, now: 1 }).list;
  const started = performance.now();
  for (let i = 0; i < 50; i += 1) big = moveItem(big, 499, 0, 2);
  const bigRows = resolveRows(big, { assets });
  const hits = filterRows(bigRows, "片段12");
  const bigTotals = finalCutTotals(bigRows);
  const csv = finalCutCsv(bigRows);
  const elapsed = performance.now() - started;
  assert.equal(big.items.length, 500); assert.equal(big.items[0].itemId, "i450"); assert.equal(big.items[0].order, 1);
  assert.ok(hits.length > 0 && hits.every((row) => row.item.title.includes("片段12")));
  assert.equal(bigTotals.counted, 500);
  assert.equal(csv.split("\r\n").length, 502);
  assert.ok(elapsed < 250, `500 items: 50 moves + rows + search + totals + CSV in ${elapsed.toFixed(1)} ms`);
  console.log(`  500 items: 50 reorders + resolve + search + totals + CSV: ${elapsed.toFixed(1)} ms`);
}

console.log("Final Cut List: mixed Shots / first frames, standalone import, repeated Asset, reorder persistence, enabled, in/out validation, unknown duration, missing Asset, ★ adopted one-click, non-adopted, no record writes, JSON / CSV order, media export, Phase 8 backup restore, serialised adds, 500-item speed passed");
