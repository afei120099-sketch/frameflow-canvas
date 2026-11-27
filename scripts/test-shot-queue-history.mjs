import assert from "node:assert/strict";
import { pushVersion, stepVersion, canUndo, canRedo, QueueHistoryStore, QUEUE_HISTORY_LIMIT } from "../lib/shot-queue-history.ts";

const empty = { versions: [], index: -1 };
let h = pushVersion(empty, "v1");
assert.deepEqual(h, { versions: ["v1"], index: 0 });
assert.equal(canUndo(h), false); assert.equal(canRedo(h), false);
assert.equal(pushVersion(h, "v1"), h, "same text twice is one version");
h = pushVersion(pushVersion(h, "v2"), "v3");
const back = stepVersion(h, -1); assert.equal(back.text, "v2"); assert.equal(canRedo(back.history), true);
const back2 = stepVersion(back.history, -1); assert.equal(back2.text, "v1"); assert.equal(stepVersion(back2.history, -1), null);
const forward = stepVersion(back2.history, 1); assert.equal(forward.text, "v2");
// A new edit after undo drops the undone versions.
const branched = pushVersion(forward.history, "v2b"); assert.deepEqual(branched.versions, ["v1", "v2", "v2b"]); assert.equal(canRedo(branched), false);
// Only the last 20 are kept.
let many = empty; for (let i = 1; i <= 25; i++) many = pushVersion(many, "t" + i);
assert.equal(many.versions.length, QUEUE_HISTORY_LIMIT); assert.equal(QUEUE_HISTORY_LIMIT, 20);
assert.equal(many.versions[0], "t6"); assert.equal(many.index, 19);

// Store: per queue title, persisted, survives a new store (= page reload), serialised.
const db = new Map(); let puts = 0;
const meta = { get: async (key) => structuredClone(db.get(key)), put: async (key, value) => { puts++; db.set(key, structuredClone(value)); } };
const store = new QueueHistoryStore(meta);
await Promise.all([store.record("EP02", "a"), store.record("EP02", "b"), store.record("EP03", "x")]);
assert.deepEqual((await store.state("EP02")).versions, ["a", "b"]);
assert.deepEqual((await store.state("EP03")).versions, ["x"]);
const undone = await store.step("EP02", -1); assert.equal(undone.text, "a");
const reloaded = new QueueHistoryStore(meta);
assert.equal((await reloaded.state("EP02")).index, 0, "position survives reload");
assert.equal((await reloaded.step("EP02", 1)).text, "b");
assert.equal(await reloaded.step("EP02", 1), null);
// Broken saved data → start clean instead of crashing.
db.set("shot-queue-history:v1:bad", { versions: "nope" });
assert.deepEqual(await new QueueHistoryStore(meta).state("bad"), { versions: [], index: -1 });
// A failing disk does not break the in-page history.
const flaky = new QueueHistoryStore({ get: async () => undefined, put: async () => { throw new Error("disk full"); } });
await assert.rejects(flaky.record("Q", "1"));
assert.deepEqual((await flaky.state("Q")).versions, ["1"]);

console.log("shot queue history: 20 versions per queue, undo/redo, persisted, serialised; ok");
