import assert from "node:assert/strict";
import { configureErrorLog, listEntries, logEvent, resolveRunEntries } from "../lib/error-log.ts";
import { findActiveRunForNode, LOST_RUN_AFTER_MS, watchRun } from "../lib/run-recovery.ts";
import { abandonUnconfirmedRun, recheckUnconfirmedRun, UNCONFIRMED_RUN_TITLE, unconfirmedOnceKey } from "../lib/unconfirmed-run-actions.ts";

// Bug: a Run ComfyUI no longer knows stayed 「任务状态待确认」 forever and the error center counted ×11, ×12, …
let saved = null;
configureErrorLog({ load: async () => saved, save: async (entries) => { saved = structuredClone(entries); } });

const RUN_ID = "run-0d886d1d";
const NOW = Date.UTC(2026, 10, 11, 11, 0);
const runs = new Map();
const makeRun = (overrides = {}) => ({ schemaVersion: 1, runId: RUN_ID, capabilityId: "h3_fl2va", status: "running", createdAt: NOW - 60 * 60_000, startedAt: NOW - 60 * 60_000, completedAt: null, comfyPromptId: RUN_ID, submission: "accepted", ownerNodeId: "shape:PpR67yXt", shotId: "shot-9e42c25e", inputAssetIds: [], outputAssetIds: [], parameters: {}, error: null, ...overrides });
/** Fake ComfyUI: no submit(), and cancel() fails the test if ever reached. */
function fakeComfy(state) {
  const calls = { probes: 0, cancels: 0, submits: 0 };
  return { calls, set(next) { state = next; }, isAvailable: async () => state !== "offline", probeJob: async () => { calls.probes += 1; return { state }; }, cancel: async () => { calls.cancels += 1; throw Error("must never cancel"); }, submit: async () => { calls.submits += 1; throw Error("must never submit"); } };
}
const deps = (comfy) => ({
  getRun: async (id) => runs.get(id) ?? null,
  updateRun: async (id, changes) => { runs.set(id, { ...runs.get(id), ...changes }); },
  isAvailable: comfy.isAvailable, probeJob: comfy.probeJob,
  resolveRunEntries, now: () => NOW,
});
/** The same steps useRunRecovery runs every ~5 s: watch → 「待确认」 → log. */
async function recoveryTick(comfy, options = {}) {
  const run = findActiveRunForNode("shape:PpR67yXt", [...runs.values()]);
  if (!run) return "no-active-run";
  const outcome = await watchRun(run, comfy, { sleep: async () => {}, ...options });
  if (outcome.phase === "unconfirmed") await logEvent({ level: "warning", category: "recovery", title: UNCONFIRMED_RUN_TITLE, detail: outcome.reason, nodeId: run.ownerNodeId, runId: run.runId, shotId: run.shotId, onceKey: unconfirmedOnceKey(run.runId) });
  return outcome.phase;
}
const warnings = async () => (await listEntries()).filter((entry) => entry.title === UNCONFIRMED_RUN_TITLE && entry.runId === RUN_ID);

// 1. An old build already left a ×11 entry (no onceKey). Twenty more polls, some >5 s apart: still that one entry, count unchanged.
runs.set(RUN_ID, makeRun());
saved = [{ id: "legacy", time: NOW - 30_000, level: "warning", category: "recovery", title: UNCONFIRMED_RUN_TITLE, detail: "ComfyUI 中找不到此任务（ComfyUI 可能已重启，历史记录已清空）", nodeId: "shape:PpR67yXt", shotId: "shot-9e42c25e", runId: RUN_ID, read: false, repeat: 11 }];
const comfy = fakeComfy("not_found");
for (let index = 0; index < 20; index += 1) assert.equal(await recoveryTick(comfy), "unconfirmed");
let list = await warnings();
assert.equal(list.length, 1, "one warning per Run however often recovery polls");
assert.equal(list[0].repeat, 11, "the ×N count no longer grows");
assert.equal(list[0].onceKey, unconfirmedOnceKey(RUN_ID), "the legacy row is adopted");
// A different Run still gets its own warning.
await logEvent({ level: "warning", category: "recovery", title: UNCONFIRMED_RUN_TITLE, detail: "x", runId: "other-run", onceKey: unconfirmedOnceKey("other-run") });
assert.equal((await listEntries()).filter((entry) => entry.title === UNCONFIRMED_RUN_TITLE).length, 2);

// 2. With lostAfterMs (what the node passes), an online ComfyUI that cannot find an old Run ends as "lost", not 「待确认」.
const lost = await watchRun(makeRun(), fakeComfy("not_found"), { sleep: async () => {}, lostAfterMs: LOST_RUN_AFTER_MS, now: () => NOW });
assert.equal(lost.phase, "lost");
assert.match(lost.reason, /没有重新提交/);
// A fresh Run (submit may still be in flight) keeps the safe 「待确认」.
const fresh = await watchRun(makeRun({ createdAt: NOW - 30_000, startedAt: null, submission: "reserved", status: "queued" }), fakeComfy("not_found"), { sleep: async () => {}, lostAfterMs: LOST_RUN_AFTER_MS, now: () => NOW });
assert.equal(fresh.phase, "unconfirmed");
// Offline ComfyUI is never treated as lost: it keeps waiting.
{
  const controller = new AbortController(); let waits = 0;
  const offline = await watchRun(makeRun(), fakeComfy("offline"), { lostAfterMs: LOST_RUN_AFTER_MS, now: () => NOW, signal: controller.signal, sleep: async () => { if (++waits >= 3) controller.abort(); } });
  assert.equal(offline.phase, "detached");
}

// 3. 「重新查询一次」 while ComfyUI still runs it: nothing settled, nothing cancelled.
comfy.set("running");
let recheck = await recheckUnconfirmedRun(RUN_ID, deps(comfy));
assert.equal(recheck.kind, "active");
assert.equal(runs.get(RUN_ID).status, "running");
// 「标记为已放弃」 is refused while ComfyUI has the job.
let abandon = await abandonUnconfirmedRun(RUN_ID, deps(comfy));
assert.equal(abandon.abandoned, false);
assert.equal(runs.get(RUN_ID).status, "running");
assert.equal((await warnings())[0].resolvedAt, undefined);

// 4. Job gone: recheck says so, abandon settles the local Run only.
comfy.set("not_found");
recheck = await recheckUnconfirmedRun(RUN_ID, deps(comfy));
assert.equal(recheck.kind, "lost");
abandon = await abandonUnconfirmedRun(RUN_ID, deps(comfy));
assert.equal(abandon.abandoned, true);
assert.equal(runs.get(RUN_ID).status, "failed");
assert.match(runs.get(RUN_ID).error, /未重新提交，未取消 ComfyUI 任务/);
list = await warnings();
assert.ok(list[0].resolvedAt, "the warning is marked handled");
assert.equal(list[0].read, true);

// 5. After handling: recovery finds no active Run, so the warning never comes back.
for (let index = 0; index < 10; index += 1) assert.equal(await recoveryTick(comfy), "no-active-run");
list = await warnings();
assert.equal(list.length, 1);
assert.equal(list[0].repeat, 11);
// Repeating the action on a settled Run only reports; it does not touch the Run again.
recheck = await recheckUnconfirmedRun(RUN_ID, deps(comfy));
assert.equal(recheck.kind, "settled");

// 6. ComfyUI reports failure → recheck settles as failed (a real final state). Never submitted or cancelled anywhere.
runs.set("run-f", makeRun({ runId: "run-f", comfyPromptId: "run-f" }));
const failing = fakeComfy("failed");
assert.equal((await recheckUnconfirmedRun("run-f", deps(failing))).kind, "failed");
assert.equal(runs.get("run-f").status, "failed");
for (const client of [comfy, failing]) { assert.equal(client.calls.cancels, 0); assert.equal(client.calls.submits, 0); }

console.log("Unconfirmed Run: one warning per Run (no ×N growth), lost Runs settle, error-center recheck/abandon read-only, no resubmit/cancel passed");
