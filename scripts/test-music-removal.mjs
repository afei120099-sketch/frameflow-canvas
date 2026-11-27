// 去配乐（CDX23 / Frameflow-Demix）canvas wiring. ComfyUI is a mock: nothing is ever sent to the real server.
import assert from "node:assert/strict";
import "./fake-indexeddb.mjs";
import { createRun, createShot, getAsset, getRun, getShot, getShotCandidates, getShotAssetLineage, getShotAssetVersions, getMeta, putMeta, registerAsset, updateRun, addRunToShot, markShotHasCandidates } from "../lib/production-records.ts";
import { buildMusicRemovalWorkflow, readDemixOutput, estimateMusicRemovalSeconds, demixDeviceLabel } from "../lib/comfyui/music-removal-workflow.ts";
import { configureMusicRemoval, enqueueMusicRemoval, drainMusicRemoval, maybeAutoRemoveMusic, recoverMusicRemovals, refreshDemixJobs, resetMusicRemovalMemory, withdrawWaiting, demixViewFor, MUSIC_REMOVAL_STATE_KEY } from "../lib/music-removal.ts";
import { parseShotQueue, shotQueueH3Props } from "../lib/shot-queue.ts";

// ---------- workflow ----------
const graph = buildMusicRemovalWorkflow("in.mp4", "abcdef12-3456-7890");
assert.equal(graph["1"].class_type, "LoadVideo");
assert.equal(graph["2"].class_type, "FrameflowDemixVideo");
assert.deepEqual(graph["2"].inputs.video, ["1", 0]);
assert.equal(graph["2"].inputs.quality, "high");
assert.equal(graph["2"].inputs.device, "auto");
assert.equal(graph["2"].inputs.music_gain_db, -120);
assert.equal(graph["2"].inputs.source_tag, "abcdef12-3456-7890");
assert.equal(graph["2"].inputs.if_already_demixed, "skip");
assert.equal(graph["2"].inputs.filename_prefix, "video/Frameflow_Demix_abcdef12");
assert.equal(readDemixOutput(undefined), null);
assert.equal(readDemixOutput({ frameflow_demix: [{ status: "skipped", reason: "already_demixed" }] }).kind, "skipped");
assert.equal(readDemixOutput({ images: [{ filename: "a.mp4", subfolder: "video" }], frameflow_demix: [{ status: "done", device: "cuda" }] }).kind, "done");
assert.equal(readDemixOutput({ images: [{ filename: "a.png" }] }), null);
assert.ok(estimateMusicRemovalSeconds([6, 6]).gpu < estimateMusicRemovalSeconds([6, 6]).cpu);
assert.match(demixDeviceLabel("cuda（可用 14.8 GB）"), /^显卡/);
assert.match(demixDeviceLabel("cpu"), /^CPU/);

// ---------- mock ComfyUI ----------
const comfy = { nodes: new Set(["LoadVideo", "FrameflowDemixVideo"]), jobs: new Map(), posts: [], outstandingMax: 0, plan: new Map(), uploads: 0, rejectNext: false };
const outstanding = () => [...comfy.jobs.values()].filter((job) => !job.finished).length;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
async function mockFetch(url, init = {}) {
  const path = String(url).replace(/^\/comfyui/, "");
  if (path.startsWith("/object_info/")) { const type = decodeURIComponent(path.slice(13)); return json(comfy.nodes.has(type) ? { [type]: { input: { required: {} } } } : {}); }
  if (path === "/upload/image") { comfy.uploads++; const form = init.body; assert.ok(form.get("image").size > 0); return json({ name: `up-${comfy.uploads}.mp4`, subfolder: "" }); }
  if (path === "/prompt") {
    const body = JSON.parse(init.body);
    if (comfy.rejectNext) { comfy.rejectNext = false; return json({ error: { message: "bad" }, node_errors: {} }, 400); }
    comfy.posts.push(body);
    const source = body.prompt["2"].inputs.source_tag;
    const plan = comfy.plan.get(source) ?? "done";
    comfy.jobs.set(body.prompt_id, { body, polls: 0, plan, finished: false });
    comfy.outstandingMax = Math.max(comfy.outstandingMax, outstanding());
    return json({ prompt_id: body.prompt_id, number: 1 });
  }
  if (path.startsWith("/history/")) {
    const id = decodeURIComponent(path.slice(9)), job = comfy.jobs.get(id);
    if (!job) return json({});
    if (++job.polls < 2) return json({});
    job.finished = true;
    const source = job.body.prompt["2"].inputs.source_tag;
    if (job.plan === "error") return json({ [id]: { status: { status_str: "error", completed: false, messages: [["execution_error", { exception_message: "boom" }]] }, outputs: {} } });
    if (job.plan === "skipped") return json({ [id]: { status: { status_str: "success", completed: true }, outputs: { "2": { frameflow_demix: [{ status: "skipped", reason: "already_demixed", source_tag: source }] } } } });
    return json({ [id]: { status: { status_str: "success", completed: true }, outputs: { "2": { images: [{ filename: `Frameflow_Demix_${source.slice(0, 4)}_00001_.mp4`, subfolder: "video", type: "output" }], frameflow_demix: [{ status: "done", source_tag: source, device: "cuda（可用 14.8 GB）", seconds: 2.8 }] } } } });
  }
  if (path === "/queue") {
    const running = [...comfy.jobs.entries()].filter(([, job]) => !job.finished).map(([id]) => [1, id]);
    return json({ queue_running: running.slice(0, 1), queue_pending: running.slice(1) });
  }
  if (path.startsWith("/view?")) return new Response(new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: "video/mp4" }));
  throw new Error(`unexpected ${path}`);
}
const store = new Map();
let shotEvents = 0, clock = 1_000_000;
const covers = [];
const io = {
  fetch: mockFetch,
  loadVideo: async (source) => { if (!store.has(source)) throw new Error("没有这个视频"); return store.get(source); },
  storeVideo: async (blob, name) => { const id = `media:test-${store.size}-${name}`; store.set(id, blob); return id; },
  readMetadata: async () => ({ width: 720, height: 1280, duration: 6 }),
  onShotChanged: () => { shotEvents++; },
  onOutputStored: async (original, output, blob) => { covers.push({ original, output, size: blob.size }); },
  tabAlive: async (id) => id === "tab-alive",
  pollMs: 1,
  now: () => clock,
};
configureMusicRemoval(io);

async function h3Output(name, { auto, completedAt = clock } = {}) {
  const shot = await createShot("测试镜头");
  const run = await createRun({ capabilityId: "h3_ultimate_guide", inputAssetIds: [], rawPrompt: "p", finalPrompt: "p", seed: 1, parameters: { ...(auto === undefined ? {} : { autoRemoveMusic: auto }) }, workflowIdentity: { capabilityId: "h3_ultimate_guide", templateVersion: "t", templateFile: "f" }, shotId: shot.shotId, ownerNodeId: "shape:h3" });
  const source = `media:src-${name}`;
  store.set(source, new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" }));
  const asset = await registerAsset({ kind: "video", origin: "generated", filename: `${name}.mp4`, mimeType: "video/mp4", storageReference: source, sourceRunId: run.runId, shotId: shot.shotId, width: 720, height: 1280, duration: 6, fps: 24 });
  await updateRun(run.runId, { status: "completed", completedAt, outputAssetIds: [asset.assetId] });
  await addRunToShot(shot.shotId, run.runId); await markShotHasCandidates(shot.shotId);
  return { shot, run, asset };
}
const job = async (assetId) => (await getMeta(MUSIC_REMOVAL_STATE_KEY))?.jobs[assetId];

// ---------- one video: new version on the same shot, original kept ----------
{
  const { shot, asset } = await h3Output("one");
  const result = await enqueueMusicRemoval({ sourceAssetId: asset.assetId, nodeId: "shape:h3" });
  assert.deepEqual(result, { queued: true, pass: 1 });
  await drainMusicRemoval();
  const state = await job(asset.assetId);
  assert.equal(state.state, "done", state.error);
  const run = await getRun(state.runId);
  assert.equal(run.capabilityId, "music_removal");
  assert.equal(run.status, "completed");
  assert.deepEqual(run.inputAssetIds, [asset.assetId]);
  assert.equal(run.parameters.model, "CDX23");
  assert.equal(run.parameters.quality, "high");
  assert.equal(run.parameters.modelCount, 3);
  assert.equal(run.parameters.device, "auto");
  assert.equal(run.musicRemoval.status, "done");
  assert.match(run.musicRemoval.device, /^cuda/);
  assert.equal(run.musicRemoval.seconds, 2.8);
  assert.match(run.musicRemoval.output, /^video\/Frameflow_Demix_/);
  assert.equal(run.musicRemoval.totalPasses, 1);
  assert.equal(run.musicRemoval.passes.length, 1);
  assert.equal(run.musicRemoval.passes[0].pass, 1);
  assert.equal(run.musicRemoval.passes[0].input, "one.mp4");
  assert.equal(run.musicRemoval.passes[0].inputAssetId, asset.assetId);
  assert.equal(run.musicRemoval.passes[0].outputFile, undefined, "internal field not kept");
  assert.equal(comfy.posts.at(-1).prompt["2"].inputs.if_already_demixed, "skip");
  assert.equal(run.comfyPromptId, run.runId, "prompt id reserved = Run id (refresh lookup)");
  assert.equal(comfy.posts.at(-1).prompt_id, run.runId);
  assert.equal(comfy.posts.at(-1).prompt["2"].inputs.source_tag, asset.assetId);
  assert.equal(comfy.posts.at(-1).prompt["1"].inputs.file, "up-1.mp4");
  assert.equal(run.outputAssetIds.length, 1);
  const versions = await getShotAssetVersions(shot.shotId);
  const output = versions.find((item) => item.assetId === run.outputAssetIds[0]);
  assert.ok(output, "output is a version of the same shot");
  assert.ok(versions.some((item) => item.assetId === asset.assetId), "original stays");
  assert.equal(output.derivationType, "music_removal");
  assert.equal(output.sourceVideoAssetId, asset.assetId);
  assert.equal(output.sourceRunId, run.runId);
  assert.match(output.filename, /-去配乐\.mp4$/);
  assert.equal((await getShotCandidates(shot.shotId)).length, 1, "no new candidate letter");
  assert.equal(await getShotAssetLineage(shot.shotId, output.assetId), "候选A → 去配乐");
  assert.ok((await getShot(shot.shotId)).runIds.includes(run.runId));
  assert.ok(shotEvents > 0);
  const cover = covers.find((item) => item.output === output.storageReference);
  assert.ok(cover, "the new file gets a cover image (H3 node shows it without playing)");
  assert.equal(cover.original, asset.storageReference);
  assert.ok(cover.size > 0);
  assert.equal(state.outputAssetId, output.assetId);
  assert.equal(demixViewFor(output, null).kind, "output");
  assert.equal(demixViewFor(output, null).originalAssetId, asset.assetId);
  assert.equal(demixViewFor(asset, await refreshDemixJobs()).job.state, "done");
  // Already processed: refused, nothing new sent.
  const posts = comfy.posts.length;
  assert.deepEqual(await enqueueMusicRemoval({ sourceAssetId: asset.assetId }), { queued: false, reason: "already_done" });
  assert.equal(comfy.posts.length, posts);
  assert.equal(demixViewFor(output, null).passes, 1);
  assert.equal(demixViewFor(output, null).canRunAgain, true);

  // 「再去一次」 by hand: a 1-pass version gets pass 2 -> one new version 「去配乐 ×2」 under the same candidate.
  assert.deepEqual(await enqueueMusicRemoval({ sourceAssetId: output.assetId, nodeId: "shape:h3" }), { queued: true, pass: 2 });
  await drainMusicRemoval();
  const again = await job(output.assetId);
  assert.equal(again.state, "done", again.error);
  const againRun = await getRun(again.runId);
  assert.equal(comfy.posts.length, posts + 1, "one more pass, nothing else");
  assert.equal(comfy.posts.at(-1).prompt["2"].inputs.if_already_demixed, "run_again", "the node must not skip the demixed input");
  assert.deepEqual(againRun.inputAssetIds, [output.assetId], "input = the 1-pass version");
  assert.equal(againRun.parameters.pass, 2);
  assert.equal(againRun.musicRemoval.totalPasses, 2);
  assert.equal(againRun.musicRemoval.passes[0].pass, 2);
  assert.equal(againRun.musicRemoval.passes[0].inputAssetId, output.assetId);
  assert.match(againRun.musicRemoval.passes[0].input, /-去配乐\.mp4$/);
  const twice = await getAsset(againRun.outputAssetIds[0]);
  assert.equal(twice.musicRemovalPasses, 2);
  assert.equal(twice.sourceVideoAssetId, asset.assetId, "still hangs under the untouched original");
  assert.equal(twice.filename, "one-去配乐x2.mp4");
  assert.equal(await getShotAssetLineage(shot.shotId, twice.assetId), "候选A → 去配乐 ×2");
  assert.equal((await getShotCandidates(shot.shotId)).length, 1, "still no new candidate letter");
  assert.ok(await getAsset(output.assetId), "the 1-pass version stays");
  assert.ok(covers.some((item) => item.output === twice.storageReference && item.original === asset.storageReference), "×2 gets the original's cover");
  assert.equal(demixViewFor(twice, null).canRunAgain, false);
  const after = comfy.posts.length;
  assert.deepEqual(await enqueueMusicRemoval({ sourceAssetId: twice.assetId }), { queued: false, reason: "max_passes" }, "×2: 已处理过");
  assert.deepEqual(await enqueueMusicRemoval({ sourceAssetId: output.assetId }), { queued: false, reason: "already_done" }, "再去一次 only once");
  assert.deepEqual(await enqueueMusicRemoval({ sourceAssetId: asset.assetId }), { queued: false, reason: "already_done" });
  assert.equal(comfy.posts.length, after);
}

// ---------- batch: one job each, never two outstanding at once ----------
{
  const items = await Promise.all(["b1", "b2", "b3"].map((name) => h3Output(name)));
  comfy.outstandingMax = 0;
  const before = comfy.posts.length;
  for (const { asset } of items) assert.deepEqual(await enqueueMusicRemoval({ sourceAssetId: asset.assetId }), { queued: true, pass: 1 }, "batch: one pass each");
  // A second click while queued is refused.
  assert.deepEqual(await enqueueMusicRemoval({ sourceAssetId: items[0].asset.assetId }), { queued: false, reason: "active" });
  await drainMusicRemoval();
  assert.equal(comfy.posts.length - before, 3, "one ComfyUI job per video");
  assert.equal(comfy.outstandingMax, 1, "next job is only sent after the previous finished");
  for (const { asset, shot } of items) {
    const state = await job(asset.assetId);
    assert.equal(state.state, "done");
    const versions = await getShotAssetVersions(shot.shotId);
    assert.ok(versions.some((item) => item.sourceVideoAssetId === asset.assetId), "result goes back to its own shot");
  }
}

// ---------- node says skipped (already demixed file): not a failure ----------
{
  const { asset } = await h3Output("skip");
  comfy.plan.set(asset.assetId, "skipped");
  await enqueueMusicRemoval({ sourceAssetId: asset.assetId });
  await drainMusicRemoval();
  const state = await job(asset.assetId);
  assert.equal(state.state, "skipped");
  const run = await getRun(state.runId);
  assert.equal(run.status, "completed");
  assert.deepEqual(run.outputAssetIds, []);
  assert.equal(run.musicRemoval.status, "skipped");
  assert.deepEqual(await enqueueMusicRemoval({ sourceAssetId: asset.assetId }), { queued: false, reason: "already_skipped" });
}

// ---------- failure → retry ----------
{
  const { asset } = await h3Output("fail");
  comfy.plan.set(asset.assetId, "error");
  await enqueueMusicRemoval({ sourceAssetId: asset.assetId });
  await drainMusicRemoval();
  let state = await job(asset.assetId);
  assert.equal(state.state, "failed");
  assert.match(state.error, /boom/);
  assert.equal((await getRun(state.runId)).status, "failed");
  comfy.plan.set(asset.assetId, "done");
  assert.deepEqual(await enqueueMusicRemoval({ sourceAssetId: asset.assetId, retry: true }), { queued: true, pass: 1 });
  await drainMusicRemoval();
  state = await job(asset.assetId);
  assert.equal(state.state, "done");
}

// ---------- ComfyUI without the node / rejecting: nothing hangs, clear message ----------
{
  const { asset } = await h3Output("nonode");
  comfy.nodes.delete("FrameflowDemixVideo");
  const posts = comfy.posts.length;
  await enqueueMusicRemoval({ sourceAssetId: asset.assetId });
  await drainMusicRemoval();
  const state = await job(asset.assetId);
  assert.equal(state.state, "failed");
  assert.match(state.error, /缺少节点：FrameflowDemixVideo/);
  assert.equal(comfy.posts.length, posts, "not submitted");
  comfy.nodes.add("FrameflowDemixVideo");
  const second = await h3Output("rejected");
  comfy.rejectNext = true;
  await enqueueMusicRemoval({ sourceAssetId: second.asset.assetId });
  await drainMusicRemoval();
  assert.match((await job(second.asset.assetId)).error, /拒绝/);
}

// ---------- withdraw waiting jobs (only those not sent yet) ----------
{
  const first = (await h3Output("withdraw-1")).asset, { asset } = await h3Output("withdraw");
  await enqueueMusicRemoval({ sourceAssetId: first.assetId });
  await enqueueMusicRemoval({ sourceAssetId: asset.assetId });
  assert.equal(await withdrawWaiting([first.assetId, asset.assetId]), 1, "the one already being sent is not withdrawn");
  await drainMusicRemoval();
  assert.equal(await job(asset.assetId), undefined);
  assert.equal((await job(first.assetId)).state, "done");
}

// ---------- refresh recovery ----------
{
  const lostAsset = (await h3Output("lost")).asset;
  const liveAsset = (await h3Output("live")).asset;
  const sentAsset = (await h3Output("sent")).asset;
  // A job reserved + sent before the refresh: ComfyUI still has it.
  const sentRun = await createRun({ capabilityId: "music_removal", inputAssetIds: [sentAsset.assetId], rawPrompt: null, finalPrompt: null, seed: null, parameters: { model: "CDX23" }, workflowIdentity: { capabilityId: "music_removal", templateVersion: "v", templateFile: "f" }, shotId: sentAsset.shotId }, { reservePromptId: true });
  comfy.jobs.set(sentRun.runId, { body: { prompt: buildMusicRemovalWorkflow("x.mp4", sentAsset.assetId) }, polls: 0, plan: "done", finished: false });
  const row = (await getMeta(MUSIC_REMOVAL_STATE_KEY));
  await putMeta(MUSIC_REMOVAL_STATE_KEY, { version: 1, jobs: { ...row.jobs,
    [lostAsset.assetId]: { sourceAssetId: lostAsset.assetId, state: "waiting", tabId: "tab-closed", updatedAt: 1 },
    [liveAsset.assetId]: { sourceAssetId: liveAsset.assetId, state: "waiting", tabId: "tab-alive", updatedAt: 1 },
    [sentAsset.assetId]: { sourceAssetId: sentAsset.assetId, state: "running", runId: sentRun.runId, updatedAt: 1 },
  } });
  resetMusicRemovalMemory();
  const posts = comfy.posts.length;
  const result = await recoverMusicRemovals();
  assert.deepEqual(result.lost, [lostAsset.assetId]);
  assert.deepEqual(result.resumed, [sentAsset.assetId]);
  const lost = await job(lostAsset.assetId);
  assert.equal(lost.state, "failed");
  assert.match(lost.error, /刷新前.*没有提交.*重试/);
  assert.equal((await job(liveAsset.assetId)).state, "waiting", "another open tab still owns it");
  for (let i = 0; i < 50 && (await job(sentAsset.assetId)).state === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const sent = await job(sentAsset.assetId);
  assert.equal(sent.state, "done", sent.error);
  assert.equal(comfy.posts.length, posts, "recovery never re-sends");
  assert.equal((await getRun(sentRun.runId)).status, "completed");
  // A reserved job ComfyUI never saw: reported, not re-sent.
  const ghost = (await h3Output("ghost")).asset;
  const ghostRun = await createRun({ capabilityId: "music_removal", inputAssetIds: [ghost.assetId], rawPrompt: null, finalPrompt: null, seed: null, parameters: {}, workflowIdentity: { capabilityId: "music_removal", templateVersion: "v", templateFile: "f" } }, { reservePromptId: true });
  const latest = await getMeta(MUSIC_REMOVAL_STATE_KEY);
  await putMeta(MUSIC_REMOVAL_STATE_KEY, { version: 1, jobs: { ...latest.jobs, [ghost.assetId]: { sourceAssetId: ghost.assetId, state: "running", runId: ghostRun.runId, updatedAt: 1 } } });
  await recoverMusicRemovals();
  for (let i = 0; i < 50 && (await job(ghost.assetId)).state === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await job(ghost.assetId)).state, "failed");
  assert.match((await job(ghost.assetId)).error, /没有自动重新提交/);
  assert.equal(comfy.posts.length, posts);
}

// ---------- refresh while 「再去一次」 is in ComfyUI ----------
{
  const { asset } = await h3Output("again-refresh");
  await enqueueMusicRemoval({ sourceAssetId: asset.assetId });
  await drainMusicRemoval();
  const first = await getAsset((await job(asset.assetId)).outputAssetId);
  const run = await createRun({ capabilityId: "music_removal", inputAssetIds: [first.assetId], rawPrompt: null, finalPrompt: null, seed: null, parameters: { pass: 2, previousPasses: 1, inputFilename: first.filename }, workflowIdentity: { capabilityId: "music_removal", templateVersion: "v", templateFile: "f" }, shotId: first.shotId }, { reservePromptId: true });
  await updateRun(run.runId, { musicRemoval: { status: "running", totalPasses: 2, passes: [{ pass: 2, promptId: run.runId, input: first.filename, inputAssetId: first.assetId }] } });
  comfy.jobs.set(run.runId, { body: { prompt: buildMusicRemovalWorkflow("x.mp4", first.assetId) }, polls: 0, plan: "done", finished: false });
  const row = await getMeta(MUSIC_REMOVAL_STATE_KEY);
  await putMeta(MUSIC_REMOVAL_STATE_KEY, { version: 1, jobs: { ...row.jobs, [first.assetId]: { sourceAssetId: first.assetId, state: "running", runId: run.runId, updatedAt: 1 } } });
  resetMusicRemovalMemory();
  const posts = comfy.posts.length;
  await recoverMusicRemovals();
  for (let i = 0; i < 80 && (await job(first.assetId)).state === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const state = await job(first.assetId);
  assert.equal(state.state, "done", state.error);
  assert.equal((await getAsset(state.outputAssetId)).musicRemovalPasses, 2);
  assert.equal(comfy.posts.length, posts, "recovery never re-sends");
}

// ---------- 出片后自动去配乐: only new H3 outputs that recorded the switch ----------
{
  const on = await h3Output("auto-on", { auto: true });
  const off = await h3Output("auto-off", { auto: false });
  const legacy = await h3Output("auto-legacy");
  const stale = await h3Output("auto-stale", { auto: true, completedAt: clock - 2 * 60 * 60_000 });
  assert.deepEqual(await maybeAutoRemoveMusic(on.run.runId), { queued: true, pass: 1 }, "auto: one pass only");
  assert.equal(await maybeAutoRemoveMusic(on.run.runId), null, "twice → once");
  assert.equal(await maybeAutoRemoveMusic(off.run.runId), null);
  assert.equal(await maybeAutoRemoveMusic(legacy.run.runId), null, "old runs never carry the switch");
  assert.equal(await maybeAutoRemoveMusic(stale.run.runId), null, "not old videos");
  await drainMusicRemoval();
  const state = await job(on.asset.assetId);
  assert.equal(state.state, "done");
  assert.equal(state.auto, true);
  assert.equal((await getRun(state.runId)).parameters.auto, true);
  // A demix Run change itself is not an H3 output.
  assert.equal(await maybeAutoRemoveMusic(state.runId), null);
  assert.equal((await getAsset(state.outputAssetId)).musicRemovalPasses, 1, "auto never does a second pass by itself");
}

// ---------- queue defaults / single-shot override ----------
{
  const shot = { title: "镜", prompt: "A quiet room.", roleIds: [], sceneAssetIds: [], seconds: 6, aspect: "9:16", soundMode: "ambient" };
  const raw = (defaults, override) => JSON.stringify({ version: "shot-queue-v1", title: "t", ...(defaults ? { defaults } : {}), chapters: [{ title: "c", shots: [{ ...shot, ...override }] }] });
  const plan = { scenes: [], appearances: [], pictures: [] };
  const props = (queue) => shotQueueH3Props(queue.chapters[0].shots[0], plan, queue.defaults);
  assert.equal(props(parseShotQueue(raw())).autoRemoveMusic, true, "default on");
  assert.equal(props(parseShotQueue(raw({ autoRemoveMusic: false }))).autoRemoveMusic, false);
  assert.equal(props(parseShotQueue(raw({ autoRemoveMusic: false }, { autoRemoveMusic: true }))).autoRemoveMusic, true, "single shot overrides");
  assert.equal(props(parseShotQueue(raw({}, { autoRemoveMusic: false }))).autoRemoveMusic, false);
  assert.throws(() => parseShotQueue(raw({ autoRemoveMusic: "yes" })), /defaults\.autoRemoveMusic/);
  assert.throws(() => parseShotQueue(raw({}, { autoRemoveMusic: 1 })), /autoRemoveMusic/);
}

console.log("music removal tests passed");
