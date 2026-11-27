// CPU-only test of the production line against a fake ComfyUI. No GPU, no real ComfyUI, no canvas.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionComfyClient } from "../lib/production/comfy-client.ts";
import { nextTask } from "../lib/production/scheduler.ts";
import { parseEpisodeDefinition, createEpisode, enqueueKeyframes, enqueueVideos, decideVersion, autoApproveKeyframes, shotStage, requiredMedia } from "../lib/production/episode.ts";
import { buildKeyframeGraph } from "../lib/production/graphs.ts";
import { ProductionWorker } from "./production-worker.ts";
import { createProductionHandler, EPISODE_TEMPLATE } from "./production-routes.ts";

const png = (w, h) => { const b = new Uint8Array(40); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); const v = new DataView(b.buffer); v.setUint32(16, w); v.setUint32(20, h); return b; };

/** Fake ComfyUI: prompts wait in "pending" until finish(); foreign prompts can be injected. */
class FakeComfy {
  prompts = new Map(); pending = []; foreign = []; uploads = []; lose = new Set(); dropResponse = new Set(); refuse = 0; submitted = [];
  finish(id) { this.pending = this.pending.filter((x) => x !== id); this.prompts.get(id).done = true; }
  finishAll() { for (const id of [...this.pending]) this.finish(id); }
  fetch = async (url, init = {}) => {
    const path = new URL(url).pathname; const method = init.method ?? "GET";
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/system_stats") return json({});
    if (path === "/queue" && method === "GET") return json({ queue_running: this.foreign.map((id) => [0, id, {}, {}]), queue_pending: this.pending.map((id) => [1, id, this.prompts.get(id).graph, this.prompts.get(id).extra]) });
    if (path === "/queue" && method === "POST") { const { delete: ids } = JSON.parse(init.body); this.pending = this.pending.filter((id) => !ids.includes(id)); return json({}); }
    if (path === "/upload/image") { const name = `up_${this.uploads.length}.png`; this.uploads.push(name); return json({ name, subfolder: "" }); }
    if (path === "/prompt") {
      if (this.refuse > 0) { this.refuse -= 1; throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }
      const body = JSON.parse(init.body); this.submitted.push(body.prompt_id);
      if (!this.lose.has(body.prompt_id)) { this.prompts.set(body.prompt_id, { graph: body.prompt, extra: body.extra_data, done: false }); this.pending.push(body.prompt_id); }
      if (this.dropResponse.has("next")) { this.dropResponse.delete("next"); throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); }
      return json({ prompt_id: body.prompt_id, number: 1, node_errors: {} });
    }
    if (path.startsWith("/history/")) {
      const id = decodeURIComponent(path.slice(9)); const p = this.prompts.get(id);
      if (!p?.done) return json({});
      const isVideo = !!p.graph["148"];
      const outputs = isVideo ? { "148": { gifs: [{ filename: "clip.mp4", subfolder: "video", type: "output" }, { filename: "clip-audio.mp4", subfolder: "video", type: "output" }] } } : { "7": { images: [{ filename: "kf.png", subfolder: "", type: "output" }] }, "45": { images: [{ filename: "depth.png", subfolder: "", type: "output" }] } };
      return json({ [id]: { prompt: [0, id, p.graph, p.extra], status: { completed: true, status_str: "success", messages: [] }, outputs } });
    }
    if (path === "/view") { const name = new URL(url).searchParams.get("filename"); return new Response(name.endsWith(".mp4") ? new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]) : png(864, 1536)); }
    return new Response("not found", { status: 404 });
  };
}

const root = await mkdtemp(join(tmpdir(), "production-test-"));
try {
  // ── pure parts ──
  const definitionText = JSON.stringify({ ...EPISODE_TEMPLATE, keyframe: { ...EPISODE_TEMPLATE.keyframe, candidates: 2 } });
  const def = parseEpisodeDefinition(definitionText);
  assert.equal(def.shots.length, 2);
  // storyboard is optional: no storyboard → no depth map, composition from keyframePrompt; not a required file
  assert.equal(def.shots[0].storyboard, "S01.png");
  assert.equal(def.shots[1].storyboard, null, "template S02 has no storyboard");
  for (const value of [null, ""]) assert.equal(parseEpisodeDefinition(JSON.stringify({ ...EPISODE_TEMPLATE, shots: [{ ...EPISODE_TEMPLATE.shots[0], storyboard: value }] })).shots[0].storyboard, null);
  assert.ok(!requiredMedia(def).includes("S02.png") && requiredMedia(def).includes("S01.png"));
  const graphFor = (shot, storyboard) => Object.values(buildKeyframeGraph({ ...def, aspect: "9:16" }, shot, { seed: 1 }, { storyboard, face: "f.png" }));
  assert.ok(graphFor(def.shots[0], "sb.png").some((node) => node.class_type === "LoadImage" && node.inputs.image === "sb.png"), "storyboard → depth image");
  const plain = graphFor(def.shots[1], null);
  assert.ok(!plain.some((node) => node.class_type === "LoadImage" && node.inputs.image !== "f.png"), "no storyboard → only the face image is loaded");
  assert.ok(plain.some((node) => node.class_type === "LoadImage" && node.inputs.image === "f.png"), "face lock still applies");
  assert.deepEqual(parseEpisodeDefinition(JSON.stringify({ ...EPISODE_TEMPLATE, shots: [{ ...EPISODE_TEMPLATE.shots[1], storyboard: null }] })).shots[0].storyboard, null, "definition round-trip with null");
  assert.throws(() => parseEpisodeDefinition(JSON.stringify({ ...EPISODE_TEMPLATE, shots: [{ ...EPISODE_TEMPLATE.shots[0], faceRole: "nobody" }] })), /不在 roles/);
  assert.throws(() => parseEpisodeDefinition(JSON.stringify({ ...EPISODE_TEMPLATE, shots: [{ ...EPISODE_TEMPLATE.shots[0], storyboard: "../x.png" }] })), /素材文件名/);
  assert.throws(() => parseEpisodeDefinition(JSON.stringify({ ...EPISODE_TEMPLATE, extra: 1 })), /不认识字段/);
  assert.throws(() => parseEpisodeDefinition(JSON.stringify({ ...EPISODE_TEMPLATE, video: { soundMode: "silent" } })), /必须是 av/);
  assert.throws(() => parseEpisodeDefinition(JSON.stringify({ ...EPISODE_TEMPLATE, shots: [{ ...EPISODE_TEMPLATE.shots[1], dialogue: [{ roleId: "zhangsan", text: "x" }] }] })), /本镜头绑定角色/);
  const pure = createEpisode(def, "ep-20261108-000000-aaaa", "2026-11-08T00:00:00.000Z");
  let n = 0; const ids = { taskId: () => `t${n++}`, seed: () => 7 };
  assert.equal(enqueueKeyframes(pure, ids, "a").length, 4);
  assert.equal(enqueueKeyframes(pure, ids, "b").length, 0, "no duplicates while open");
  assert.deepEqual(enqueueVideos(pure, ids, "c").skipped, ["S01", "S02"], "stage gate: no video without approved keyframe");
  // scheduler: family stickiness and yielding to others
  const fake = (stage, createdAt) => ({ ...pure, episodeId: stage, createdAt, paused: false, tasks: [{ taskId: stage, stage, shotId: "S01", state: "pending", createdAt }] });
  assert.equal(nextTask({ episodes: [fake("keyframe", "2"), fake("video", "1")], comfyBusy: false, lastStage: "video" }).task.stage, "video", "stays on the loaded model");
  assert.equal(nextTask({ episodes: [fake("keyframe", "2"), fake("video", "1")], comfyBusy: false, lastStage: null }).task.stage, "keyframe", "cheap gate first");
  assert.equal(nextTask({ episodes: [fake("keyframe", "2")], comfyBusy: true, lastStage: null }).reason, "comfy_busy");

  // ── worker end to end ──
  const comfy = new FakeComfy();
  const checks = [];
  const exec = async (args) => { checks.push(args); return args[1] === "face" ? JSON.stringify({ results: [{ face: 0.72, faces: 1 }] }) : JSON.stringify({ duration: 6, hasAudio: true, blackFrames: 0, frozenRatio: 0, problems: [] }); };
  const make = () => new ProductionWorker({ root, comfy: new ProductionComfyClient("http://fake", comfy.fetch), python: "python", checksScript: "checks.py", roughCutScript: "rc.py", exec, pollMs: 3_600_000, heartbeatMs: 3_600_000 });
  const worker = make();
  await worker.start();
  assert.equal(worker.overview().owner, true);
  const episode = await worker.createEpisode(definitionText);
  const id = episode.episodeId;
  await assert.rejects(worker.enqueue(id, "keyframe"), /还缺这些素材/);
  for (const name of ["S01.png", "S02.png", "zhangsan_face.png", "lisi_face.png", "zhangsan_full.png", "lisi_full.png", "zhangsan_voice.wav", "lisi_voice.wav"]) await worker.uploadMedia(id, name, png(512, 912));
  await assert.rejects(worker.uploadMedia(id, "../evil.png", png(1, 1)), /文件名/);
  comfy.foreign = ["someone-else"];
  assert.equal((await worker.enqueue(id, "keyframe")).created, 4);
  await worker.whenIdle();
  await worker.tick();
  assert.equal(comfy.submitted.length, 0, "never submits while ComfyUI holds other work");
  assert.equal(worker.overview().status.state, "comfy_busy");
  comfy.foreign = [];

  await worker.whenIdle(); await worker.tick();
  assert.equal(comfy.submitted.length, 1);
  const first = (await worker.get(id)).episode.tasks.find((t) => t.state === "queued");
  assert.ok(first, "accepted task is queued");
  assert.equal(comfy.prompts.get(comfy.submitted[0]).extra.frameflowInstance, "production");
  await worker.tick();
  assert.equal(comfy.submitted.length, 1, "one production prompt in flight at a time");

  // restart while in flight: the new worker probes, never resubmits
  await worker.stop();
  const again = make();
  await again.start();
  comfy.finish(comfy.submitted[0]);
  await again.whenIdle(); await again.tick();
  await again.checksSettled();
  let state = (await again.get(id)).episode;
  assert.equal(state.versions.length, 1, "result collected after restart");
  assert.equal(comfy.submitted.length, 2, "next task submitted after collection");
  const v1 = state.versions[0];
  assert.equal(v1.score.face, 0.72);
  assert.ok(v1.extra.depth.endsWith("_depth.png"));
  assert.equal(checks[0][1], "face");

  // uncertain submission: stays reserved, found in ComfyUI, not resubmitted
  comfy.finishAll(); await again.whenIdle(); await again.tick(); await again.checksSettled();
  comfy.dropResponse.add("next");
  comfy.finishAll(); await again.whenIdle(); await again.tick(); await again.checksSettled();
  state = (await again.get(id)).episode;
  const reserved = state.tasks.find((t) => t.state === "reserved");
  assert.ok(reserved, "connection reset after send keeps the task reserved");
  const before = comfy.submitted.length;
  await again.whenIdle(); await again.tick();
  assert.equal(comfy.submitted.length, before, "doubt is resolved by lookup, not resubmission");
  assert.equal((await again.get(id)).episode.tasks.find((t) => t.taskId === reserved.taskId).state, "queued");
  comfy.finishAll(); await again.whenIdle(); await again.tick(); await again.checksSettled();
  state = (await again.get(id)).episode;
  assert.equal(state.versions.filter((v) => v.stage === "keyframe").length, 4);
  assert.equal(shotStage(state, "S01"), "keyframe_review");

  // approve one keyframe per shot → videos
  for (const shotId of ["S01", "S02"]) await again.decide(id, state.versions.find((v) => v.shotId === shotId).versionId, "approved");
  assert.equal((await again.enqueue(id, "video")).created, 2);
  await again.whenIdle(); await again.tick();
  const videoPrompt = comfy.prompts.get(comfy.submitted.at(-1));
  assert.equal(videoPrompt.graph["136"].class_type, "MiniMaxH3AudioConditioningT8", "ultimate first-frame route");
  assert.equal(videoPrompt.graph["136"].inputs.task_type, "Hybrid", "first frame + role appearance reference");
  assert.equal(videoPrompt.graph["145"].inputs.strength_model, 0, "understanding preset: no DMAD LoRA");
  // S02 (second video submitted later) carries dialogue: compiled by the canvas manifest compiler with Li Si's voice.


  // lost prompt → needs confirmation, episode blocked, explicit retry
  comfy.prompts.delete(comfy.submitted.at(-1)); comfy.pending = [];
  await again.whenIdle(); await again.tick();
  assert.ok(!(await again.get(id)).episode.tasks.some((t) => t.state === "needs_confirmation"), "one miss is not enough");
  await again.whenIdle(); await again.tick();
  state = (await again.get(id)).episode;
  const lost = state.tasks.find((t) => t.state === "needs_confirmation");
  assert.ok(lost, "missing from queue and history → needs confirmation");
  const count = comfy.submitted.length;
  await again.whenIdle(); await again.tick();
  assert.equal(comfy.submitted.length, count, "blocked episode submits nothing");
  await again.retryTask(id, lost.taskId);
  await again.whenIdle(); await again.tick();
  assert.equal(comfy.submitted.length, count + 1);
  comfy.finishAll(); await again.whenIdle(); await again.tick(); await again.checksSettled();
  comfy.finishAll(); await again.whenIdle(); await again.tick(); await again.checksSettled();
  state = (await again.get(id)).episode;
  const videos = state.versions.filter((v) => v.stage === "video");
  assert.equal(videos.length, 2);
  assert.ok(videos[0].file.startsWith("videos/"));
  assert.equal(videos[0].score.duration, 6);
  const dialogueGraph = [...comfy.prompts.values()].map((p) => p.graph).find((g) => g["ff-community-audio-0"]);
  assert.ok(dialogueGraph, "the dialogue shot submits its role voice");
  assert.ok(String(dialogueGraph["136"].inputs.prompt).includes("张总，您找我？"), "dialogue compiled verbatim by the canvas compiler");
  assert.ok(String(dialogueGraph["136"].inputs.prompt).includes("<Audio 1>"));
  assert.equal((await readFile(join(root, id, videos[0].file))).length, 12, "picked the -audio.mp4 output and stored it");

  // assembly: every shot needs a selected video; plan uses measured durations
  await assert.rejects(again.assemble(id), /还没有选定视频/);
  for (const v of videos) await again.decide(id, v.versionId, "approved");
  const cut = await again.assemble(id);
  assert.ok(cut.file.startsWith("output/") && cut.file.endsWith(".mp4"));
  const plan = JSON.parse(await readFile((await import("node:fs")).readdirSync(join(root, id, "output")).filter((f) => f.startsWith("plan_")).map((f) => join(root, id, "output", f))[0], "utf8"));
  assert.deepEqual(plan.clips.map((c) => c.outPoint), [6, 6], "out points come from the measured duration");
  assert.equal(checks.at(-1)[0], "rc.py", "render goes through the rough-cut script");
  // one-click rough cut (partial): chosen video first, else the newest candidate; shots without video skipped
  await again.decide(id, videos[1].versionId, "candidate");
  const rough = await again.assemble(id, { partial: true });
  assert.equal(rough.clips, 2);
  assert.deepEqual(rough.unchosen, [videos[1].shotId]);
  assert.deepEqual(rough.skipped, []);
  await again.decide(id, videos[1].versionId, "approved");

  // refused connection before sending → retried automatically, then failed
  await again.enqueue(id, "keyframe", { shotIds: ["S01"], count: 1 });
  comfy.refuse = 5;
  await again.whenIdle(); await again.tick(); await again.whenIdle(); await again.tick(); await again.whenIdle(); await again.tick();
  state = (await again.get(id)).episode;
  assert.equal(state.tasks.at(-1).state, "failed");
  assert.equal(state.tasks.at(-1).attempts.filter((a) => a.outcome === "not_sent").length, 3);

  // auto approval threshold
  const auto = createEpisode(parseEpisodeDefinition(JSON.stringify({ ...EPISODE_TEMPLATE, keyframe: { ...EPISODE_TEMPLATE.keyframe, autoApproveAbove: 0.6 } })), "ep-20261108-000000-bbbb", "x");
  auto.versions.push({ versionId: "a", stage: "keyframe", shotId: "S01", taskId: "x", file: "f", seed: 1, status: "candidate", score: { face: 0.55 }, createdAt: "", decidedAt: null, note: "" }, { versionId: "b", stage: "keyframe", shotId: "S01", taskId: "y", file: "g", seed: 2, status: "candidate", score: { face: 0.7 }, createdAt: "", decidedAt: null, note: "" });
  assert.deepEqual(autoApproveKeyframes(auto, "now").map((v) => v.versionId), ["b"]);
  decideVersion(auto, "a", "approved", "later");
  assert.equal(auto.versions.find((v) => v.versionId === "b").status, "candidate", "one approved version per shot and stage");

  // shared emergency stop holds new submissions
  const held = new ProductionWorker({ root: await mkdtemp(join(tmpdir(), "production-hold-")), comfy: new ProductionComfyClient("http://fake", comfy.fetch), python: "", checksScript: "", roughCutScript: "", exec, pollMs: 3_600_000, heartbeatMs: 3_600_000, holdReason: async () => "收件箱根目录有 STOP 文件" });
  await held.start();
  const heldEp = await held.createEpisode(definitionText);
  for (const name of ["S01.png", "S02.png", "zhangsan_face.png", "lisi_face.png"]) await held.uploadMedia(heldEp.episodeId, name, png(64, 64));
  await held.enqueue(heldEp.episodeId, "keyframe", { shotIds: ["S01"], count: 1 });
  const sentBefore = comfy.submitted.length;
  await held.whenIdle(); await held.tick();
  assert.equal(comfy.submitted.length, sentBefore, "STOP holds the production line");
  assert.equal(held.overview().status.state, "held");
  await held.stop();

  // lock: a second worker on the same folder does not take over a fresh owner
  const rival = make();
  await rival.start();
  assert.equal(rival.overview().owner, false);
  await assert.rejects(rival.enqueue(id, "keyframe"), /另一个画布进程/);
  await rival.stop();

  // routes: writes need the header, reads do not
  const server = createServer(createProductionHandler(again, async () => "<html>ok</html>"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/overview`)).status, 200);
  assert.equal((await fetch(`${base}/api/episodes/${id}/pause`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/api/episodes/${id}/pause`, { method: "POST", headers: { "X-Frameflow-Production": "1" }, body: JSON.stringify({ paused: true }) })).status, 200);
  const media = await fetch(`${base}/media/${id}/${videos[0].file}`, { headers: { Range: "bytes=0-3" } });
  assert.equal(media.status, 206);
  assert.equal((await fetch(`${base}/media/${id}/..%2F..%2Fsecret.txt`)).status, 400);
  assert.equal((await fetch(`${base}/ui`)).status, 200);
  // delete a shot, then the whole episode (moved to trash, never erased)
  const doomed = await again.createEpisode(definitionText);
  for (const name of ["S01.png", "lisi_face.png"]) await again.uploadMedia(doomed.episodeId, name, png(64, 64));
  await again.setPaused(doomed.episodeId, true);
  await assert.rejects(again.deleteShot(doomed.episodeId, "S09"), /没有这个镜头/);
  await again.enqueue(doomed.episodeId, "keyframe", { shotIds: ["S02"], count: 1 });
  await again.deleteShot(doomed.episodeId, "S02");
  let doomedState = (await again.get(doomed.episodeId)).episode;
  assert.deepEqual(doomedState.shots.map((x) => x.shotId), ["S01"]);
  assert.ok(doomedState.tasks.filter((t) => t.shotId === "S02").every((t) => t.state === "cancelled"), "the deleted shot's pending tasks are cancelled");
  await assert.rejects(again.deleteShot(doomed.episodeId, "S01"), /最后一镜/);
  const fs = await import("node:fs");
  const trashed = await again.deleteEpisode(doomed.episodeId);
  assert.ok(trashed.trash.startsWith("trash/"));
  assert.ok(fs.existsSync(join(root, trashed.trash, `${doomed.episodeId}.json`)) && fs.existsSync(join(root, trashed.trash, doomed.episodeId, "inputs", "S01.png")), "ledger and files moved to trash");
  assert.ok(!fs.existsSync(join(root, "episodes", `${doomed.episodeId}.json`)) && !fs.existsSync(join(root, doomed.episodeId)));
  assert.ok(!again.overview().episodes.some((e) => e.episodeId === doomed.episodeId));
  await assert.rejects(again.get(doomed.episodeId), /没有这个剧集/);
  await again.tick(); await again.whenIdle();
  assert.ok(!fs.existsSync(join(root, "episodes", `${doomed.episodeId}.json`)), "a deleted episode is not written back");
  server.close();
  await again.stop();
  console.log("production line: ok (scheduler, stage gate, reserved ids, restart, uncertain/lost/refused submissions, checks, auto-approve, lock, routes)");
} finally {
  await new Promise((r) => setTimeout(r, 300)); await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
