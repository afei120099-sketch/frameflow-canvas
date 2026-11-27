import assert from "node:assert/strict";
import { ACTIVE_RUN_ERROR, claimNode, createRunExclusively, finalizeRunOutput, findActiveRunForNode, isActiveRun, isNodeClaimed, saveNodeForCapability, watchRun } from "../lib/run-recovery.ts";
import { comfyUIH3Adapter } from "../lib/comfyui/h3-adapter.ts";
import { ComfyConnectionError, SubmissionUncertainError } from "../lib/ai-adapter.ts";

const RUN_ID = "00000000-0000-4000-8000-000000000017";
const run = (overrides = {}) => ({ schemaVersion: 1, runId: RUN_ID, capabilityId: "h3_fl2va", status: "running", createdAt: 1, startedAt: 1, completedAt: null, comfyPromptId: RUN_ID, submission: "accepted", ownerNodeId: "shape:h3", inputAssetIds: [], outputAssetIds: [], rawPrompt: "p", finalPrompt: "p", seed: 1, parameters: {}, workflowIdentity: { capabilityId: "h3_fl2va", templateVersion: "sha256:x", templateFile: "h3-workflow.json" }, error: null, ...overrides });
const noSleep = async () => {};
/** Scripted fake ComfyUI. It has no submit(): recovery must never need one. */
function fakeClient(script) {
  const calls = { probes: [], submits: 0 };
  let step = 0;
  const current = () => script[Math.min(step, script.length - 1)];
  return {
    calls,
    // An "offline" step is consumed by the availability check itself (no probe happens while offline).
    async isAvailable() { if (current() !== "offline") return true; step += 1; return false; },
    async probeJob(jobId, saveNodeId) { calls.probes.push({ jobId, saveNodeId }); const value = current(); step += 1; if (value === "offline") throw new Error("offline"); return value; },
  };
}
const watch = (target, client, extra = {}) => { const phases = []; return watchRun(target, client, { sleep: noSleep, onPhase: (phase) => phases.push(phase), ...extra }).then((outcome) => ({ outcome, phases })); };

// Test 1: Run=running with prompt_id; after refresh the queue still has it → running, no submit.
{
  const controller = new AbortController();
  const client = fakeClient([{ state: "running" }, { state: "running" }]);
  let runningCalls = 0;
  const { outcome, phases } = await watchRun(run({ status: "queued" }), client, { sleep: async () => { if (client.calls.probes.length >= 2) controller.abort(); }, signal: controller.signal, onPhase: () => {}, onRunning: () => { runningCalls += 1; } }).then((result) => ({ outcome: result, phases: [] }));
  assert.equal(outcome.phase, "detached");
  assert.equal(runningCalls, 1, "Run is moved to running once");
  assert.equal(client.calls.submits, 0);
  assert.deepEqual(client.calls.probes[0], { jobId: RUN_ID, saveNodeId: "15" });
  const queued = await watch(run(), (() => { const c = fakeClient([{ state: "queued" }, { state: "completed", file: { filename: "a.mp4" } }]); return c; })());
  assert.deepEqual(queued.phases, ["queued"]);
  void phases;
}

// Test 2 + 3: history already completed → completed; output registered exactly once however often it is reached.
{
  const { outcome } = await watch(run(), fakeClient([{ state: "completed", file: { filename: "H3_00001.mp4", subfolder: "video", type: "output" } }]));
  assert.deepEqual(outcome, { phase: "completed", file: { filename: "H3_00001.mp4", subfolder: "video", type: "output" } });

  const runs = new Map([[RUN_ID, run()]]);
  const assets = new Map();
  let produced = 0;
  const store = {
    async getRun(id) { return structuredClone(runs.get(id) ?? null); },
    async getAsset(id) { return structuredClone(assets.get(id) ?? null); },
    async listAssets() { return [...assets.values()].map((item) => structuredClone(item)); },
    async updateRun(id, changes) { const next = { ...runs.get(id), ...changes }; runs.set(id, next); return structuredClone(next); },
  };
  const produce = async (current) => { produced += 1; await new Promise((resolve) => setTimeout(resolve, 5)); const asset = { assetId: `asset-${produced}`, kind: "video", sourceRunId: current.runId, filename: "H3_00001.mp4", storageReference: `media:${produced}` }; assets.set(asset.assetId, asset); return asset; };
  // Live WS path, HTTP fallback and a refresh all hit completion concurrently.
  const results = await Promise.all([finalizeRunOutput(RUN_ID, store, produce), finalizeRunOutput(RUN_ID, store, produce), finalizeRunOutput(RUN_ID, store, produce)]);
  assert.equal(produced, 1, "one Asset for one Run output");
  assert.deepEqual(results.map((item) => item.created), [true, false, false]);
  assert.ok(results.every((item) => item.asset.assetId === "asset-1"));
  assert.deepEqual(runs.get(RUN_ID).outputAssetIds, ["asset-1"]);
  assert.equal(runs.get(RUN_ID).status, "completed");
  // Repeated history checks later: still no new Asset.
  for (let index = 0; index < 3; index += 1) assert.equal((await finalizeRunOutput(RUN_ID, store, produce)).created, false);
  assert.equal(produced, 1);
  assert.equal(assets.size, 1);

  // Crash between Asset write and Run update: the orphan Asset (sourceRunId) is attached, not duplicated.
  const orphanRunId = "00000000-0000-4000-8000-000000000018";
  runs.set(orphanRunId, run({ runId: orphanRunId, comfyPromptId: orphanRunId }));
  assets.set("orphan", { assetId: "orphan", kind: "video", sourceRunId: orphanRunId, filename: "o.mp4", storageReference: "media:orphan" });
  const attached = await finalizeRunOutput(orphanRunId, store, produce);
  assert.equal(attached.created, false);
  assert.equal(attached.asset.assetId, "orphan");
  assert.deepEqual(runs.get(orphanRunId).outputAssetIds, ["orphan"]);
  assert.equal(produced, 1);
}

// Test 4: ComfyUI unreachable → waiting_connection, never submits, keeps waiting.
{
  const controller = new AbortController();
  const client = fakeClient(["offline"]);
  const phases = [];
  let waits = 0;
  const outcome = await watchRun(run(), client, { signal: controller.signal, onPhase: (phase) => phases.push(phase), sleep: async () => { waits += 1; if (waits >= 3) controller.abort(); } });
  assert.equal(outcome.phase, "detached");
  assert.deepEqual([...new Set(phases)], ["waiting_connection"]);
  assert.equal(client.calls.submits, 0);
  assert.equal(client.calls.probes.length, 0, "no probe while offline");
}

// Test 5: ComfyUI comes back → the original job is re-confirmed (by the same prompt_id).
{
  const client = fakeClient(["offline", "offline", { state: "running" }, { state: "completed", file: { filename: "back.mp4" } }]);
  const { outcome, phases } = await watch(run(), client);
  assert.deepEqual(phases, ["waiting_connection", "waiting_connection", "running"]);
  assert.equal(outcome.phase, "completed");
  assert.ok(client.calls.probes.filter((probe) => probe !== undefined).every((probe) => probe.jobId === RUN_ID));
}

// Unknown to ComfyUI (never accepted, or ComfyUI restarted): "unconfirmed", no resubmission. One miss alone is not enough.
{
  const once = await watch(run(), fakeClient([{ state: "not_found" }, { state: "running" }, { state: "failed", error: "boom" }]));
  assert.deepEqual(once.outcome, { phase: "failed", error: "boom" });
  const reserved = await watch(run({ submission: "reserved", status: "queued" }), fakeClient([{ state: "not_found" }, { state: "not_found" }]));
  assert.equal(reserved.outcome.phase, "unconfirmed");
  assert.match(reserved.outcome.reason, /提交前页面已关闭|ComfyUI 已重启/);
  const legacy = await watch(run({ comfyPromptId: null, submission: undefined, status: "queued" }), fakeClient([{ state: "running" }]));
  assert.equal(legacy.outcome.phase, "unconfirmed", "a Run without any recorded prompt_id is never guessed or resubmitted");
}

// Test 6: two clicks → only one real submit.
{
  const first = claimNode("shape:double");
  const second = claimNode("shape:double");
  assert.equal(typeof first, "function");
  assert.equal(second, null, "second click in the same tick is rejected synchronously");
  assert.equal(isNodeClaimed("shape:double"), true);
  first();
  assert.equal(isNodeClaimed("shape:double"), false);

  // Even without the in-memory claim (other tab / after refresh), the lock + active-Run check allows one Run only.
  const stored = [];
  let submits = 0;
  const listRuns = async () => stored.map((item) => structuredClone(item));
  const create = async () => { await new Promise((resolve) => setTimeout(resolve, 5)); const created = run({ runId: `r-${stored.length}`, ownerNodeId: "shape:tabs", status: "queued", submission: "reserved" }); stored.push(created); submits += 1; return created; };
  const outcomes = await Promise.allSettled([createRunExclusively("shape:tabs", listRuns, create), createRunExclusively("shape:tabs", listRuns, create)]);
  assert.deepEqual(outcomes.map((item) => item.status), ["fulfilled", "rejected"]);
  assert.equal(outcomes[1].reason.message, ACTIVE_RUN_ERROR);
  assert.equal(submits, 1);
}

// Test 7: an active Run blocks the node (after refresh the node finds it again).
{
  const runs = [run({ runId: "old", ownerNodeId: "shape:a", status: "completed" }), run({ runId: "live", ownerNodeId: "shape:a", status: "running", createdAt: 5 }), run({ runId: "other", ownerNodeId: "shape:b", status: "running" })];
  assert.equal(findActiveRunForNode("shape:a", runs).runId, "live");
  await assert.rejects(createRunExclusively("shape:a", async () => runs, async () => { throw new Error("must not create"); }), { message: ACTIVE_RUN_ERROR });
  assert.equal(findActiveRunForNode("shape:c", runs), null);
  // Older Runs without ownerNodeId are never re-attached to a node.
  assert.equal(findActiveRunForNode("shape:a", [run({ ownerNodeId: undefined })]), null);
}

// Tests 8 + 9: failed / cancelled Runs are not active, so recovery never starts and nothing is retried.
for (const status of ["failed", "cancelled", "completed"]) {
  assert.equal(isActiveRun(run({ status })), false);
  assert.equal(findActiveRunForNode("shape:h3", [run({ status })]), null, `${status} is not re-attached`);
  let created = 0;
  await createRunExclusively("shape:h3", async () => [run({ status })], async () => { created += 1; return run({ runId: "fresh" }); });
  assert.equal(created, 1, `${status} Run does not block a new user-initiated submit`);
}

// Test 10: all four capabilities use their own frozen save node for recovery.
{
  assert.deepEqual(["h3_fl2va", "h3_ref2va", "seedvr2_upscale", "film_interpolation"].map(saveNodeForCapability), ["15", "92", "76", "7"]);
  for (const capabilityId of ["h3_fl2va", "h3_ref2va", "seedvr2_upscale", "film_interpolation"]) {
    const client = fakeClient([{ state: "completed", file: { filename: `${capabilityId}.mp4` } }]);
    const { outcome } = await watch(run({ capabilityId }), client);
    assert.equal(outcome.phase, "completed");
    assert.equal(client.calls.probes[0].saveNodeId, saveNodeForCapability(capabilityId));
  }
}

// Real adapter against a fake HTTP layer: reserved prompt_id, uncertain submit, and queue/history probing.
{
  const originalFetch = globalThis.fetch;
  const requests = [];
  let respond = () => new Response("{}");
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); return respond(String(url), init); };
  try {
    respond = () => Response.json({ prompt_id: RUN_ID, number: 1, node_errors: {} });
    const job = await comfyUIH3Adapter.submit({ capability: "comfyui-h3", inputs: { workflow: { a: 1 }, clientId: "client", promptId: RUN_ID } });
    assert.equal(job.jobId, RUN_ID);
    assert.equal(JSON.parse(requests.at(-1).init.body).prompt_id, RUN_ID, "Run ID is sent as the ComfyUI prompt_id");
    const legacySubmit = await comfyUIH3Adapter.submit({ capability: "comfyui-h3", inputs: { workflow: { a: 1 }, clientId: "client" } });
    assert.equal(legacySubmit.jobId, RUN_ID);
    assert.equal("prompt_id" in JSON.parse(requests.at(-1).init.body), false);

    // Network failure during /prompt: the job may exist → SubmissionUncertainError (caller keeps the Run for recovery).
    respond = () => { throw new TypeError("fetch failed"); };
    await assert.rejects(comfyUIH3Adapter.submit({ capability: "comfyui-h3", inputs: { workflow: {}, clientId: "c", promptId: RUN_ID } }), SubmissionUncertainError);
    // Any other request failing at network level is a ComfyConnectionError.
    await assert.rejects(comfyUIH3Adapter.probeJob(RUN_ID, "15"), ComfyConnectionError);
    // HTTP-level rejection of /prompt is a definite failure, not "uncertain".
    respond = () => Response.json({ error: { message: "invalid prompt" } }, { status: 400 });
    await assert.rejects(comfyUIH3Adapter.submit({ capability: "comfyui-h3", inputs: { workflow: {}, clientId: "c", promptId: RUN_ID } }), (error) => !(error instanceof SubmissionUncertainError) && /invalid prompt/.test(error.message));

    const history = (entry) => (url) => url.includes("/history/") ? Response.json(entry ? { [RUN_ID]: entry } : {}) : Response.json({ queue_running: [], queue_pending: [] });
    for (const [capabilityId, saveNode] of [["h3_fl2va", "15"], ["h3_ref2va", "92"], ["seedvr2_upscale", "76"], ["film_interpolation", "7"]]) {
      respond = history({ status: { status_str: "success", completed: true, messages: [] }, outputs: { [saveNode]: { images: [{ filename: `${capabilityId}.mp4`, subfolder: "video", type: "output" }] } } });
      assert.deepEqual(await comfyUIH3Adapter.probeJob(RUN_ID, saveNodeForCapability(capabilityId)), { state: "completed", file: { filename: `${capabilityId}.mp4`, subfolder: "video", type: "output" } });
    }
    respond = history({ status: { status_str: "error", completed: false, messages: [["execution_error", { exception_message: "CUDA out of memory" }]] }, outputs: {} });
    assert.deepEqual(await comfyUIH3Adapter.probeJob(RUN_ID, "15"), { state: "failed", error: "CUDA out of memory" });
    respond = (url) => url.includes("/history/") ? Response.json({}) : Response.json({ queue_running: [[3, RUN_ID, {}, {}, []]], queue_pending: [] });
    assert.deepEqual(await comfyUIH3Adapter.probeJob(RUN_ID, "15"), { state: "running" });
    await new Promise(resolve=>setTimeout(resolve,260)); // Read-only queue snapshots share a 250ms window.
    respond = (url) => url.includes("/history/") ? Response.json({}) : Response.json({ queue_running: [[3, "someone-else", {}, {}, []]], queue_pending: [[4, RUN_ID, {}, {}, []]] });
    assert.deepEqual(await comfyUIH3Adapter.probeJob(RUN_ID, "15"), { state: "queued" });
    // Finished between the history and queue requests: the second history read catches it.
    await new Promise(resolve=>setTimeout(resolve,260));
    let historyReads = 0;
    respond = (url) => url.includes("/history/") ? Response.json(++historyReads === 1 ? {} : { [RUN_ID]: { status: { status_str: "success", completed: true }, outputs: { 15: { images: [{ filename: "late.mp4" }] } } } }) : Response.json({ queue_running: [], queue_pending: [] });
    assert.equal((await comfyUIH3Adapter.probeJob(RUN_ID, "15")).state, "completed");
    respond = history(null);
    assert.deepEqual(await comfyUIH3Adapter.probeJob(RUN_ID, "15"), { state: "not_found" });
    assert.ok(requests.every((request) => !request.url.endsWith("/prompt") || request.init?.method === "POST"));
  } finally { globalThis.fetch = originalFetch; }
}

console.log("Run recovery: re-attach, completed/failed/unconfirmed, offline wait, idempotent output, duplicate-submit guard, four capabilities passed");
