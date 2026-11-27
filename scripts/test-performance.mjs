import assert from "node:assert/strict";
import { ObjectUrlRegistry } from "../lib/object-url-registry.ts";
import { affectsLinkedContent, expandBox, FAR_ZOOM, isNearViewport, shouldActivateMedia, VIEWPORT_MARGIN } from "../lib/media-activation.ts";
import { createTickBatcher, findActiveRunForNode } from "../lib/run-recovery.ts";
import { getPoster, posterCount, rememberPoster } from "../lib/poster-cache.ts";

/** Fake URL API + manual clock so revocation timing is deterministic. */
function harness(graceMs = 1000) {
  let now = 0; const timers = []; const created = []; const revoked = [];
  const registry = new ObjectUrlRegistry({
    graceMs,
    api: { createObjectURL: () => { const url = `blob:test/${created.length}`; created.push(url); return url; }, revokeObjectURL: (url) => revoked.push(url) },
    timers: { set: (fn, ms) => { const timer = { at: now + ms, fn, done: false }; timers.push(timer); return timer; }, clear: (timer) => { timer.done = true; } },
  });
  const advance = (ms) => { now += ms; for (const timer of timers) if (!timer.done && timer.at <= now) { timer.done = true; timer.fn(); } };
  return { registry, created, revoked, advance };
}
const blob = () => Promise.resolve(new Blob(["x"]));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Mixed canvas like scripts/perf/canvas-perf-harness.js: 460×420 grid, 10 node types, 3 of them players.
const PLAYERS = new Set([1, 2, 4, 8, 9]); // video, audio, video, video, audio positions in the type cycle
function grid(n) {
  const columns = Math.ceil(Math.sqrt(n * 1.6));
  return Array.from({ length: n }, (_, i) => ({ i, player: PLAYERS.has(i % 10), box: { minX: (i % columns) * 460, minY: Math.floor(i / columns) * 420, maxX: (i % columns) * 460 + 390, maxY: Math.floor(i / columns) * 420 + 300 } }));
}
const viewportAt = (x, y, zoom, width = 1600, height = 900) => ({ minX: x, minY: y, maxX: x + width / zoom, maxY: y + height / zoom });
const activePlayers = (nodes, viewport, zoom) => nodes.filter((node) => node.player && shouldActivateMedia({ near: isNearViewport(node.box, viewport), zoom })).length;

// 1–3. 100 / 300 / 500 nodes: players are bounded by what is near the viewport, not by node count.
const results = {};
for (const n of [100, 300, 500]) {
  const nodes = grid(n);
  const players = nodes.filter((node) => node.player).length;
  const atHundred = activePlayers(nodes, viewportAt(0, 0, 1), 1);
  const atMid = activePlayers(nodes, viewportAt(0, 0, 0.5), 0.5);
  const overview = activePlayers(nodes, viewportAt(-2000, -2000, 0.06, 1600 / 0.06 * 0.06, 900), 0.06);
  const started = performance.now();
  for (let frame = 0; frame < 60; frame += 1) activePlayers(nodes, viewportAt(frame * 40, frame * 20, 1), 1);
  const perFrameMs = (performance.now() - started) / 60;
  results[n] = { players, atHundred, atMid, overview, perFrameMs: Number(perFrameMs.toFixed(3)) };
  assert.equal(players, n / 2, "half of the fixture nodes are media players");
  assert.ok(atHundred <= 20, `${n} nodes @100%: ${atHundred} active players`);
  assert.ok(atMid <= 40, `${n} nodes @50%: ${atMid} active players`);
  assert.equal(overview, 0, "far LOD activates no player");
  assert.ok(perFrameMs < 2, `activation check for ${n} nodes costs ${perFrameMs.toFixed(3)} ms per camera frame`);
}
console.log("  activation", JSON.stringify(results));

// 4 + 6. Reference counting and sharing: one URL per media however many nodes, including concurrent mounts.
{
  const { registry, created } = harness();
  const urls = await Promise.all(Array.from({ length: 50 }, () => registry.acquire("media:a", blob)));
  assert.equal(created.length, 1, "50 nodes mounting together create one URL (the old cache created 50 and leaked 49)");
  assert.equal(new Set(urls).size, 1);
  assert.equal(registry.stats().referenced, 1);
  await registry.acquire("media:b", blob);
  assert.equal(created.length, 2);
}

// 5 + 9. Node removed / left viewport: released → revoked after grace; nothing revoked while still referenced.
{
  const { registry, created, revoked, advance } = harness(1000);
  await registry.acquire("media:a", blob); await registry.acquire("media:a", blob);
  registry.release("media:a");
  advance(5000);
  assert.deepEqual(revoked, [], "still referenced by the second node");
  registry.release("media:a");
  advance(999);
  assert.deepEqual(revoked, [], "grace period");
  advance(1);
  assert.deepEqual(revoked, [created[0]], "revoked once the last node released");
  assert.equal(registry.stats().keys, 0);
  registry.release("media:a");
  assert.equal(revoked.length, 1, "extra release is harmless");
}

// 8. Re-entering the viewport: inside the grace period reuses the URL; after it, a fresh URL is created.
{
  const { registry, created, revoked, advance } = harness(1000);
  const first = await registry.acquire("media:a", blob);
  registry.release("media:a"); advance(500);
  assert.equal(await registry.acquire("media:a", blob), first, "quick return reuses the URL");
  advance(5000);
  assert.equal(revoked.length, 0, "re-acquire cancelled the pending revoke");
  registry.release("media:a"); advance(1000);
  const again = await registry.acquire("media:a", blob);
  assert.notEqual(again, first);
  assert.equal(created.length, 2);
}

// Legacy resolve* callers pin: shared, never revoked (unchanged behaviour). Failed loads are retried.
{
  const { registry, created, revoked, advance } = harness(10);
  const pinned = await registry.pin("image:a", blob);
  assert.equal(await registry.acquire("image:a", blob), pinned, "nodes share the pinned URL");
  registry.release("image:a"); advance(1000);
  assert.deepEqual(revoked, []);
  await assert.rejects(registry.acquire("audio:missing", () => Promise.reject(new Error("lost"))), /lost/);
  assert.equal(await registry.acquire("audio:missing", blob), created.at(-1), "a failed load is not cached");
}
// Released while still loading: the URL is revoked instead of leaking.
{
  const { registry, revoked, advance } = harness(10);
  let finish;
  const pending = registry.acquire("media:slow", () => new Promise((resolve) => { finish = resolve; }));
  registry.release("media:slow"); advance(10);
  finish(new Blob(["x"])); await pending; await flush();
  assert.equal(revoked.length, 1, "no leak when a node unmounts before its media loaded");
}

// 7 + 10 + 11. Activation rules: off-screen video stays a poster; audio loads on demand; LOD switch.
{
  const viewport = { minX: 0, minY: 0, maxX: 1600, maxY: 900 };
  const onScreen = { minX: 100, minY: 100, maxX: 490, maxY: 400 };
  const justOutside = { minX: 1900, minY: 100, maxX: 2290, maxY: 400 };
  const farAway = { minX: 9000, minY: 9000, maxX: 9390, maxY: 9300 };
  assert.equal(isNearViewport(onScreen, viewport), true);
  assert.equal(isNearViewport(justOutside, viewport), true, `pre-activates within ${VIEWPORT_MARGIN * 100}% margin`);
  assert.equal(isNearViewport(farAway, viewport), false);
  assert.equal(isNearViewport(null, viewport), false);
  assert.deepEqual(expandBox(viewport, 0.5), { minX: -800, minY: -450, maxX: 2400, maxY: 1350 });
  assert.equal(shouldActivateMedia({ near: false, zoom: 1 }), false, "off-screen video: no player");
  assert.equal(shouldActivateMedia({ near: true, zoom: 1 }), true, "entering the viewport activates");
  assert.equal(shouldActivateMedia({ near: true, zoom: FAR_ZOOM - 0.01 }), false, "far LOD: poster only");
  assert.equal(shouldActivateMedia({ near: true, zoom: FAR_ZOOM }), true, "mid LOD: player");
  assert.equal(shouldActivateMedia({ near: false, zoom: 0.1, playing: true }), true, "a playing item is not cut off");
  assert.equal(shouldActivateMedia({ near: false, zoom: 1, keepAlive: true }), true, "open audio trimming keeps its source");
  assert.equal(shouldActivateMedia({ near: false, zoom: 1, playing: false, keepAlive: false }), false, "idle off-screen audio has no source");
}

// Re-render filter: pure moves are ignored; link-relevant changes still re-render.
{
  const props = { src: "media:a" };
  const moved = { updated: { "shape:a": [{ typeName: "shape", x: 0, y: 0, props }, { typeName: "shape", x: 50, y: 10, props }] }, added: {}, removed: {} };
  assert.equal(affectsLinkedContent(moved), false, "dragging a node does not re-render every node");
  assert.equal(affectsLinkedContent({ updated: { "shape:a": [{ typeName: "shape", props }, { typeName: "shape", props: { src: "media:b" } }] }, added: {}, removed: {} }), true, "replacing media re-renders");
  assert.equal(affectsLinkedContent({ updated: {}, added: { "binding:1": {} }, removed: {} }), true, "new connection");
  assert.equal(affectsLinkedContent({ updated: {}, added: {}, removed: { "shape:x": {} } }), true, "deleted node");
  assert.equal(affectsLinkedContent({ updated: { "binding:1": [{ typeName: "binding" }, { typeName: "binding" }] }, added: {}, removed: {} }), true, "binding change");
  assert.equal(affectsLinkedContent({ updated: { "shape:a": [{ typeName: "shape", parentId: "page:1", props }, { typeName: "shape", parentId: "shape:frame", props }] }, added: {}, removed: {} }), true, "reparent");
}

// 12. Run recovery keeps working: batched reads are shared per burst and never older than the triggering change.
{
  let reads = 0; let version = 0;
  const pending = [];
  const batched = createTickBatcher(async () => { reads += 1; return [{ runId: "r", ownerNodeId: "shape:h3", status: version ? "running" : "completed", createdAt: 1 }]; }, (fn) => pending.push(fn));
  const burst = Array.from({ length: 150 }, () => batched());
  version = 1; // the Run changed after the nodes asked (e.g. the broadcast that triggered them)
  pending.shift()();
  const answers = await Promise.all(burst);
  assert.equal(reads, 1, "150 node re-checks → one Run read");
  assert.ok(answers.every((runs) => findActiveRunForNode("shape:h3", runs)?.runId === "r"), "the shared read sees the latest state");
  const next = batched();
  assert.equal(pending.length, 1, "the next burst starts a new read");
  pending.shift()(); await next;
  assert.equal(reads, 2);
}

// Poster cache is session-only and bounded.
for (let i = 0; i < 650; i += 1) rememberPoster(`media:${i}`, `data:image/jpeg;base64,${i}`);
assert.equal(posterCount(), 600);
assert.equal(getPoster("media:0"), undefined, "oldest posters are dropped");
assert.equal(getPoster("media:649"), "data:image/jpeg;base64,649");

console.log("Performance: 100/300/500-node activation bounds, URL ref-counting/sharing/revocation, viewport enter/leave, on-demand audio, LOD, re-render filter, batched recovery reads, poster cache passed");
