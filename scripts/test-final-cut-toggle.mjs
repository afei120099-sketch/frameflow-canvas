import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import "./fake-indexeddb.mjs";
import { registerAsset } from "../lib/production-records.ts";
import { assetMembership, finalCutToggleAction, removeLatestForAsset, createFinalCutList, addItem, setItemRange } from "../lib/final-cut-list.ts";
import { addAssetToFinalCutList, getFinalCutSnapshot, loadFinalCutList, mutateFinalCutList, removeAssetFromFinalCutList, subscribeFinalCut } from "../lib/final-cut-store.ts";

/** Phase 18.1: state-aware 加入成片 buttons (one state + one cancel logic for all four entries). */
const video = (filename, duration = 6) => registerAsset({ kind: "video", origin: "imported", filename, mimeType: "video/mp4", storageReference: `media:${filename}`, sourceRunId: null, duration });
const a = await video("a.mp4");
const b = await video("b.mp4");

// Shared snapshot: every button reads the same published list.
let notifications = 0;
const unsubscribe = subscribeFinalCut(() => { notifications += 1; });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(getFinalCutSnapshot()?.items, [], "snapshot loaded lazily on first subscription");

// 1. Not in the list → add.
assert.deepEqual(finalCutToggleAction(getFinalCutSnapshot(), a.assetId), { kind: "add" });
await addAssetToFinalCutList(a.assetId);
await addAssetToFinalCutList(b.assetId);
assert.equal(assetMembership(getFinalCutSnapshot(), a.assetId).count, 1, "snapshot updated by the mutation itself");
assert.ok(notifications >= 3, "subscribers notified on load and on every change");

// 2. Once → the same click cancels exactly that item; other Assets untouched.
{
  const action = finalCutToggleAction(getFinalCutSnapshot(), a.assetId);
  assert.equal(action.kind, "remove");
  const { removedItemId, remaining } = await removeAssetFromFinalCutList(a.assetId, "only");
  assert.equal(removedItemId, action.itemId); assert.equal(remaining, 0);
  const stored = await loadFinalCutList();
  assert.deepEqual(stored.items.map((item) => item.assetId), [b.assetId]);
  assert.deepEqual(getFinalCutSnapshot().items.map((item) => item.assetId), [b.assetId]);
  assert.deepEqual(finalCutToggleAction(getFinalCutSnapshot(), a.assetId), { kind: "add" }, "back to 加入成片");
}

// 3. Several times → never one-click delete-all; "latest" cancels only the most recent addition.
{
  const first = await addAssetToFinalCutList(a.assetId, { now: 1000 });
  await mutateFinalCutList((list) => setItemRange(list, first.item.itemId, 1, 3, 6));
  const second = await addAssetToFinalCutList(a.assetId, { now: 2000 });
  const third = await addAssetToFinalCutList(a.assetId, { now: 3000 });
  const action = finalCutToggleAction(getFinalCutSnapshot(), a.assetId);
  assert.deepEqual(action, { kind: "choose", itemIds: [first.item.itemId, second.item.itemId, third.item.itemId], latestItemId: third.item.itemId }, "a choice, not a delete");
  await assert.rejects(removeAssetFromFinalCutList(a.assetId, "only"), /出现 3 次/, "the single-use cancel refuses when used several times");
  assert.equal(assetMembership(await loadFinalCutList(), a.assetId).count, 3, "nothing removed by the refused cancel");
  const { removedItemId, remaining } = await removeAssetFromFinalCutList(a.assetId, "latest");
  assert.equal(removedItemId, third.item.itemId); assert.equal(remaining, 2);
  const stored = await loadFinalCutList();
  assert.deepEqual(stored.items.filter((item) => item.assetId === a.assetId).map((item) => item.itemId), [first.item.itemId, second.item.itemId]);
  assert.deepEqual([stored.items.find((item) => item.itemId === first.item.itemId).inPoint, stored.items.find((item) => item.itemId === first.item.itemId).outPoint], [1, 3], "earlier uses keep their in/out");
  // "Latest" is by time added, not by position: move the newest to the top and it is still the one cancelled.
  await mutateFinalCutList((list) => ({ ...list, items: [...list.items].reverse().map((item, index) => ({ ...item, order: index + 1 })) }));
  assert.equal(assetMembership(await loadFinalCutList(), a.assetId).latestItemId, second.item.itemId);
  // Adding the same Asset again is still possible (18 behaviour unchanged).
  await addAssetToFinalCutList(a.assetId);
  assert.equal(assetMembership(await loadFinalCutList(), a.assetId).count, 3);
}

// Pure helpers, including a stale button: the store re-decides inside the queue.
{
  let list = createFinalCutList({ now: 1 });
  list = addItem(list, { asset: a }, { itemId: "x", now: 5 }).list;
  list = addItem(list, { asset: a }, { itemId: "y", now: 9 }).list;
  assert.deepEqual(removeLatestForAsset(list, a.assetId).items.map((item) => item.itemId), ["x"]);
  assert.throws(() => removeLatestForAsset(list, "nope"), /不在成片序列/);
  assert.deepEqual(assetMembership(null, a.assetId), { count: 0, itemIds: [], latestItemId: null });
  await mutateFinalCutList((current) => ({ ...current, items: current.items.filter((item) => item.assetId !== b.assetId) }));
  await assert.rejects(removeAssetFromFinalCutList(b.assetId, "only"), /已不在成片序列/, "a stale 已加入 button cannot remove something else");
}

// 4. Legacy sequence data/API stays compatible; canvas UX is now selection-based rough cut.
{
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [canvas, library, board, lineage, button] = await Promise.all(["../app/canvas-workspace.tsx", "../components/asset-library.tsx", "../components/shot-board.tsx", "../components/lineage-viewer.tsx", "../components/final-cut-button.tsx"].map(read));
  const videoNode = canvas.slice(canvas.indexOf("function VideoNodeContent"), canvas.indexOf("function AudioExtractPanel"));
  assert.doesNotMatch(videoNode, /<FinalCutButton/, "video node no longer exposes legacy add-to-sequence");
  assert.doesNotMatch(library, /<FinalCutButton/, "old sequence entry removed from library");
  assert.doesNotMatch(board, /<FinalCutButton/, "old sequence entry removed from board");
  assert.doesNotMatch(lineage, /<FinalCutButton/, "old sequence entry removed from lineage");
  for (const [name, source] of [["video node", videoNode], ["library", library], ["board", board], ["lineage", lineage]]) assert.doesNotMatch(source, /addToFinalCut\(|addAssetToFinalCutList\(|removeAssetFromFinalCutList\(/, `${name} has no private add/cancel logic`);
  assert.match(button, /finalCutToggleAction\(list, assetId\)/); assert.match(button, /cancelFinalCut\(assetId, "only"\)/); assert.match(button, /cancelFinalCut\(assetId, "latest"\)/);
  assert.match(button, /useSyncExternalStore\(subscribeFinalCut, getFinalCutSnapshot/, "state from the one shared snapshot");
  assert.match(button, /minWidth:96,minHeight:38/, "node action has a large labeled click target");
  assert.match(button, /variant !== "icon" && <span>\{label\}<\/span>/, "node action displays its label");
  assert.match(button, /onPointerUp=\{stop\}/, "pointer release must not reach the canvas drag handler");
  assert.match(canvas, /closest\("\.final-cut-toggle-holder"\).*editor\.markEventAsHandled\(event\)/, "node intercepts the action before tldraw handles it");
}

unsubscribe();
console.log("Final Cut toggle: add when absent, one-click cancel when present once, multi-use choose menu (no delete-all, latest only, in/out kept), stale-button safety, repeat add kept, shared snapshot, legacy data/API preserved and replaced canvas entries passed");
