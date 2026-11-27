import assert from "node:assert/strict";
import { pickChosenVersion } from "../lib/shot-card-videos.ts";

const v = (id, createdAt, extra = {}) => ({ id, createdAt, adopted: false, stale: false, ...extra });

assert.equal(pickChosenVersion([]), null);
// Nothing adopted: newest fresh.
assert.equal(pickChosenVersion([v("A", 1), v("B", 2)]).id, "B");
// Nothing adopted, all stale: newest overall.
assert.equal(pickChosenVersion([v("A", 1, { stale: true }), v("B", 2, { stale: true })]).id, "B");
// Two nodes for one shot (另存·重渲): old node A adopted earlier, user then picks C on the new node → C, not A.
const twoNodes = [v("A", 1, { adopted: true, adoptedAt: 100 }), v("B", 50), v("C", 60, { adopted: true, adoptedAt: 200 })];
assert.equal(pickChosenVersion(twoNodes).id, "C");
// ... and back to A again → A.
assert.equal(pickChosenVersion([v("A", 1, { adopted: true, adoptedAt: 300 }), v("B", 50), v("C", 60, { adopted: true, adoptedAt: 200 })]).id, "A");
// Legacy adoption without adoptedAt loses to any timed choice.
assert.equal(pickChosenVersion([v("A", 1, { adopted: true }), v("C", 60, { adopted: true, adoptedAt: 5 })]).id, "C");
// Two legacy adoptions: newer video wins.
assert.equal(pickChosenVersion([v("A", 1, { adopted: true }), v("C", 60, { adopted: true })]).id, "C");
// Chosen on purpose although stale (old prompt) → keep it…
assert.equal(pickChosenVersion([v("A", 1, { adopted: true, adoptedAt: 100, stale: true }), v("B", 50)]).id, "A");
// …until a fresh video arrives after that choice.
assert.equal(pickChosenVersion([v("A", 1, { adopted: true, adoptedAt: 100, stale: true }), v("B", 150)]).id, "B");
// Legacy stale adoption with a fresh version: fresh wins (previous behaviour).
assert.equal(pickChosenVersion([v("A", 1, { adopted: true, stale: true }), v("B", 50)]).id, "B");

console.log("shot card videos: latest choice wins across nodes; ok");
