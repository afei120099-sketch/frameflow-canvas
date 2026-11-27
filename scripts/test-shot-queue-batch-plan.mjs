import assert from "node:assert/strict";
import { findReusableShots, planBatchStart } from "../lib/shot-queue-batch-plan.ts";

const shot = (title, prompt = "p-" + title) => ({ title, prompt, roleIds: [], sceneAssetIds: [], seconds: 6, aspect: "16:9", soundMode: "av" });
const queue = { version: "shot-queue-v1", title: "EP02", chapters: [{ title: "a", shots: [shot("L01"), shot("L02"), shot("L03")] }, { title: "b", shots: [shot("L04")] }] };
const node = (nodeId, title, prompt = "p-" + title) => ({ nodeId, title, prompt });
const run = (ownerNodeId, status, createdAt, out = status === "completed" ? ["v"] : []) => ({ ownerNodeId, status, createdAt, outputAssetIds: out });

// Same queue as the saved session → continue, never ask.
assert.deepEqual(planBatchStart({ savedQueue: structuredClone(queue), queue, nodes: [], runs: [] }), { newBatch: false, total: 4, reusable: [] });
// Edited text / other queue → new batch; counts the whole queue or just the chapter.
const edited = structuredClone(queue); edited.chapters[0].shots[0].prompt += "!";
assert.equal(planBatchStart({ savedQueue: queue, queue: edited, nodes: [], runs: [] }).newBatch, true);
assert.equal(planBatchStart({ savedQueue: null, queue, nodes: [], runs: [], chapterIndex: 1 }).total, 1);

const nodes = [node("n1", "L01"), node("n2", "L02"), node("n2old", "L02"), node("n3", "L03", "other prompt"), node("n4", "L04"), node("x", "L05")];
const runs = [
  run("n1", "completed", 10),
  run("n2old", "completed", 5), run("n2", "failed", 1), run("n2", "running", 20), // latest of n2 is running
  run("n3", "completed", 10), // prompt differs → not the same shot
  run("n4", "completed", 3, []), // completed without output → render again
];
const reusable = findReusableShots(queue, nodes, runs);
assert.deepEqual(reusable.map((r) => [r.title, r.nodeId, r.state]), [["L01", "n1", "done"], ["L02", "n2old", "done"]], "done beats busy; changed prompt and empty output are not reused");
// Only the requested chapter.
assert.deepEqual(findReusableShots(queue, nodes, runs, 1), []);
// Busy node is used when nothing is done.
assert.deepEqual(findReusableShots(queue, [node("n2", "L02")], runs).map((r) => r.state), ["busy"]);
// A node is claimed once even when two shots share title + prompt.
const twin = { ...queue, chapters: [{ title: "a", shots: [shot("L01"), shot("L01")] }] };
assert.equal(findReusableShots(twin, [node("n1", "L01")], runs).length, 1);
// Failed latest run → not reused.
assert.deepEqual(findReusableShots(queue, [node("f", "L01")], [run("f", "completed", 1), run("f", "failed", 2)]), []);

console.log("shot queue batch plan: new-batch detection, reuse of finished / rendering nodes; ok");
