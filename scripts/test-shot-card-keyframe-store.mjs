import assert from "node:assert/strict";
import "./fake-indexeddb.mjs";

// A tab that was refreshed while keyframe jobs were waiting/running: sessionStorage still has them.
const store = new Map([["frameflow.shotCard.keyframeJobs.pending.v1", JSON.stringify([{ queueTitle: "EP02", shotTitle: "L03", index: 0, total: 2, state: "running" }, { queueTitle: "EP02", shotTitle: "L03", index: 1, total: 2, state: "waiting" }])]]);
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };

const kf = await import("../lib/shot-card-keyframes.ts");
const { putMeta, getMeta } = await import("../lib/production-records.ts");

// Lost jobs are reported (not re-run), survive another refresh until dismissed, and nothing is queued.
assert.deepEqual(kf.lostKeyframeJobs().map((job) => [job.shotTitle, job.index, job.state]), [["L03", 0, "running"], ["L03", 1, "waiting"]]);
assert.equal(kf.keyframeJobs().length, 0, "no automatic re-run after refresh");
assert.equal(kf.keyframeJobsPending(), false);
assert.ok(store.has("frameflow.shotCard.keyframeJobs.lost.v1"));
assert.equal(store.has("frameflow.shotCard.keyframeJobs.pending.v1"), false);
kf.dismissLostKeyframeJobs();
assert.deepEqual(kf.lostKeyframeJobs(), []);
assert.equal(store.has("frameflow.shotCard.keyframeJobs.lost.v1"), false);

// 另存成新队列: candidates follow to the new queue title, merged by assetId, source untouched.
await putMeta("shot-card-keyframes:v1:EP02", { L01: [{ assetId: "a1", seed: 1, createdAt: 1 }, { assetId: "a2", seed: 2, createdAt: 2, rejected: true }], L02: [{ assetId: "b1", seed: 3, createdAt: 3 }] });
await putMeta("shot-card-keyframes:v1:EP02·重渲", { L01: [{ assetId: "a1", seed: 1, createdAt: 1 }], L09: [{ assetId: "z", seed: 9, createdAt: 9 }] });
const merged = await kf.copyQueueCandidates("EP02", "EP02·重渲");
assert.deepEqual(merged.L01.map((item) => item.assetId), ["a1", "a2"]);
assert.equal(merged.L01[1].rejected, true, "rejected marks carry over");
assert.deepEqual(merged.L02.map((item) => item.assetId), ["b1"]);
assert.deepEqual(merged.L09.map((item) => item.assetId), ["z"], "nothing in the target is removed");
assert.deepEqual(Object.keys(await getMeta("shot-card-keyframes:v1:EP02")).sort(), ["L01", "L02"]);
assert.deepEqual(await kf.loadCandidates("EP02·重渲"), merged);

console.log("shot card keyframe store: lost-job notice after refresh, candidates copied on save-as; ok");
