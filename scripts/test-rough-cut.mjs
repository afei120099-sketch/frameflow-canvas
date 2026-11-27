import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import "./fake-indexeddb.mjs";
import { RoughCutJobs } from "./rough-cut-jobs.ts";
import { createFinalCutList, addItem, moveItem, setItemRange, updateItem, resolveRows } from "../lib/final-cut-list.ts";
import { freezeRoughCut, sameRoughCut, roughCutSources, roughCutFileName, beginRoughCutRun, saveRoughCut, markInterruptedRoughCuts, ROUGH_CUT_SESSION } from "../lib/rough-cut.ts";
import { createRun, getRun, listAssets, listRuns, registerAsset } from "../lib/production-records.ts";
import { getLocalVideoBlob, storeLocalVideo } from "../lib/local-video-store.ts";
import { collectProject, exportProject, readBackup, restoreProject } from "../lib/project-backup.ts";

/**
 * Phase 19 rough cut — real media end to end: real H.264/AAC fixtures, the real PyAV renderer
 * (ComfyUI embedded Python), the real job manager, pixel / audio inspection of the output. CPU only.
 */
const run = promisify(execFile);
const PYTHON = process.env.FRAMEFLOW_PYAV_PYTHON || "python";
const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "frameflow-roughcut-test-"));
const jobRoot = await mkdtemp(join(tmpdir(), "frameflow-roughcut-jobs-"));
const jobs = new RoughCutJobs({ python: PYTHON, script: here("rough-cut.py"), tempRoot: jobRoot });
const py = (args) => run(PYTHON, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });

try {
  const facts = JSON.parse((await py([here("rough-cut-fixtures.py"), "make", temp])).stdout);
  const file = (name) => join(temp, name);
  // A clip whose index is intact (faststart) but whose data stops half way.
  await py([here("rough-cut.py"), "render", await plan([{ source: file("d30_hd.mp4"), inPoint: 0, outPoint: 2 }]), file("whole.mp4")]);
  const whole = await readFile(file("whole.mp4"));
  await writeFile(file("truncated.mp4"), whole.subarray(0, Math.floor(whole.length * 0.45)));

  async function plan(clips, sizePolicy = "first") { const path = join(temp, `plan-${Math.random().toString(36).slice(2)}.json`); await writeFile(path, JSON.stringify({ sizePolicy, clips: clips.map((clip) => ({ title: "", filename: "", ...clip })) })); return path; }
  const inspect = async (path, spec) => JSON.parse((await py([here("rough-cut-fixtures.py"), "inspect", path, JSON.stringify(spec)])).stdout);

  // Canvas-side records: one video Asset per fixture (storage "media:<id>" as in the app).
  const assetFor = {};
  const sourceFile = {};
  for (const name of ["a24_audio.mp4", "b48_silent_portrait.mp4", "c24_mono441.mp4", "d30_hd.mp4", "broken.mp4", "truncated.mp4"]) {
    const seconds = facts[name]?.seconds ?? 2;
    const asset = await registerAsset({ kind: "video", origin: "imported", filename: name, mimeType: "video/mp4", storageReference: `media:${name}`, sourceRunId: null, duration: seconds });
    assetFor[name] = asset;
    sourceFile[asset.assetId.replace(/[^A-Za-z0-9_-]/g, "_")] = file(name);
  }
  const assets = () => new Map(Object.values(assetFor).map((asset) => [asset.assetId, asset]));
  const list = (items) => items.reduce((acc, [name, inPoint, outPoint, extra = {}], index) => {
    let next = addItem(acc, { asset: assetFor[name] }, { itemId: `i${index}`, now: index + 1 }).list;
    next = setItemRange(next, `i${index}`, inPoint, outPoint, assetFor[name].duration);
    return extra.enabled === false ? updateItem(next, `i${index}`, { enabled: false }) : next;
  }, createFinalCutList({ sequenceId: "seq-1", now: 1 }));
  const freeze = (value) => { const frozen = freezeRoughCut(value, resolveRows(value, { assets: assets() }), 99); assert.equal(frozen.ok, true, JSON.stringify(frozen.problems)); return frozen.snapshot; };

  /** The exact path the browser takes: create → upload each distinct source → plan → start → poll. */
  async function render(snapshot, sizePolicy = "first") {
    const created = await jobs.create(snapshot.clips.map((clip) => ({ key: clip.sourceKey, inPoint: clip.inPoint, outPoint: clip.outPoint, transition:clip.transition, title: clip.title, filename: clip.filename })));
    assert.deepEqual(created.sources, roughCutSources(snapshot).map((clip) => clip.sourceKey), "each distinct Asset uploaded once");
    for (const key of created.sources) await jobs.writeSource(created.id, key, createReadStream(sourceFile[key]));
    const planned = await jobs.plan(created.id, sizePolicy);
    await jobs.start(created.id, sizePolicy);
    let status;
    const stages = new Set();
    for (let i = 0; i < 600; i += 1) {
      status = jobs.status(created.id);
      if (status.stage) stages.add(`${status.stage.stage}${status.stage.index ?? ""}`);
      if (!["running", "ready"].includes(status.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { id: created.id, planned, status, stages, output: status.state === "done" ? (await jobs.resultFile(created.id)).path : null };
  }
  // Full browser -> job serialization -> Python path must retain transitions.
  for(const kind of ["dissolve","fade"]){
    const value=list([["a24_audio.mp4",0,1],["c24_mono441.mp4",0,1]]);
    value.items[1].transition={type:kind,seconds:.25};
    const result=await render(freeze(value));
    assert.equal(result.status.state,"done",JSON.stringify(result.status.error));
    assert.equal(result.planned.output.frames,kind==="dissolve"?42:48);
    assert.equal(result.status.result.frames,kind==="dissolve"?42:48);
    await jobs.dispose(result.id);
  }
  const G = (index) => (index * 4) % 256;
  // Segmented enhancement: two silent visual clips reuse one original continuous audio source.
  {
    const created = await jobs.create([
      {key:'silent',inPoint:0,outPoint:1,title:'segment1',filename:'silent.mp4',audioSourceKey:'original',audioInPoint:0},
      {key:'silent',inPoint:1,outPoint:2,title:'segment2',filename:'silent.mp4',audioSourceKey:'original',audioInPoint:1},
    ]);
    assert.deepEqual(created.sources,['silent','original']);
    await jobs.writeSource(created.id,'silent',createReadStream(file('b48_silent_portrait.mp4')));
    await jobs.writeSource(created.id,'original',createReadStream(file('a24_audio.mp4')));
    await jobs.plan(created.id,'first');await jobs.start(created.id,'first');
    let status;
    for(let n=0;n<600;n++){status=jobs.status(created.id);if(status.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,50));}
    assert.equal(status.state,'done',JSON.stringify(status.error));
    const result=await jobs.resultFile(created.id);
    const info=await inspect(result.path,{rms:[[.1,.9],[.95,1.05],[1.1,1.9]]});
    assert.equal(info.frameCount,96);
    assert.equal(info.video.fps,48);
    assert.ok(info.rms.every(r=>r>.01),'original audio restored across the seam despite silent segment video');
    assert.ok(Math.abs(info.audio.samples-96000)<=1024,'one continuous output audio track');
    await jobs.dispose(created.id);
  }
  const near = (actual, expected, tolerance = 10) => Math.abs(actual - expected) <= tolerance;

  // 1 + 2 + 3 + 5 + 6. Three different Assets (different "first frames" / sizes / audio) → one MP4, in order, trimmed, letterboxed, continuous audio.
  let firstOutput;
  {
    const snapshot = freeze(list([["a24_audio.mp4", 1, 2.5], ["b48_silent_portrait.mp4", 0.5, 2], ["c24_mono441.mp4", 0, 1]]));
    const result = await render(snapshot);
    assert.equal(result.status.state, "done", JSON.stringify(result.status.error));
    firstOutput = result;
    const out = result.status.result;
    assert.deepEqual([out.fps, out.fpsReason, out.width, out.height, out.frames, out.duration], ["24/1", "mixed_default_24", 640, 360, 96, 4], "24 FPS, canvas of the first clip");
    const info = await inspect(result.output, { frames: [0, 35, 36, 40, 71, 72, 95], rms: [[0.05, 1.45], [1.55, 2.95], [3.05, 3.95], [1.4, 1.5], [2.86, 2.98], [3.0, 3.06]] });
    assert.deepEqual([info.video.codec, info.video.pixFmt, info.video.fps, info.frameCount], ["h264", "yuv420p", 24, 96], "H.264 yuv420p, 24 FPS, 96 frames");
    assert.deepEqual([info.audio.codec, info.audio.rate, info.audio.channels], ["aac", 48000, 2], "AAC 48 kHz stereo");
    assert.ok(Math.abs(info.audio.samples - 4 * 48000) <= 1024, `audio length matches the picture (${info.audio.samples})`);
    const [f0, f35, f36, f40, f71, f72, f95] = info.frames;
    // 2. order A → B → C (R channel marks the clip)
    assert.ok(near(f0.centre[0], 40) && near(f36.centre[0], 110) && near(f72.centre[0], 180), "clip order");
    // 3. trim: A starts at source frame 24 (1.0 s) and ends at 59; B (48 FPS) starts at frame 24 (0.5 s)
    assert.ok(near(f0.centre[1], G(24)) && near(f35.centre[1], G(59)), `A trimmed to 1.0–2.5 s (${f0.centre[1]}, ${f35.centre[1]})`);
    assert.ok(near(f36.centre[1], G(24)) && near(f40.centre[1], G(32)) && near(f71.centre[1], G(94)), "B trimmed at 0.5 s; 48→24 takes every other frame");
    assert.ok(near(f72.centre[1], G(0)) && near(f95.centre[1], G(23)), "C from its first frame");
    // 5. no stretching: portrait 480×640 → 270×360 with black bars; 320×240 → 480×360
    assert.equal(f36.litWidth, 270); assert.deepEqual(f36.left, [0, 0, 0], "black bar, not a crop"); assert.equal(f72.litWidth, 480); assert.equal(f0.litWidth, 640);
    // 6. continuous audio: A has sound, silent B gets silence, mono C at its original level; no hole at the cuts
    const [rmsA, rmsB, rmsC, aEnd, bEnd, cStart] = info.rms;
    assert.ok(rmsA > 0.18 && rmsB < 0.01 && rmsC > 0.18, `levels ${rmsA} / ${rmsB} / ${rmsC}`);
    assert.ok(aEnd > 0.15, "A sounds right up to the cut"); assert.ok(bEnd < 0.01, "B stays silent up to its cut"); assert.ok(cStart > 0.15, "C is audible from its first frame");
    assert.ok(result.stages.has("clip3") || result.stages.has("finalize"), "stage events are reported");
    await copyFile(result.output, file("first-output.mp4"));
    firstOutput = { ...result, output: file("first-output.mp4") };
    const leftovers = (await readdir(jobRoot)).length;
    await jobs.dispose(result.id);
    assert.equal((await readdir(jobRoot)).length, leftovers - 1, "temporary job folder removed");
  }

  // 4. 24 FPS + 48 FPS where the FILM clip is most of the cut → 48 FPS; 24 FPS frames are doubled.
  {
    const result = await render(freeze(list([["a24_audio.mp4", 0, 1], ["b48_silent_portrait.mp4", 0, 3]])));
    const out = result.status.result;
    assert.deepEqual([out.fps, out.fpsReason, out.frames], ["48/1", "mixed_48_majority", 192]);
    const info = await inspect(result.output, { frames: [0, 1, 2, 3, 48, 49] });
    assert.equal(info.video.fps, 48);
    assert.deepEqual(info.frames.map((frame) => Math.round(frame.centre[1] / 4)), [0, 0, 1, 1, 0, 1], "24→48 repeats each frame; 48 FPS clip frames pass through");
    await jobs.dispose(result.id);
    const same = await render(freeze(list([["c24_mono441.mp4", 0, 1], ["a24_audio.mp4", 0, 1]])));
    assert.deepEqual([same.status.result.fps, same.status.result.fpsReason], ["24/1", "same"]);
    await jobs.dispose(same.id);
  }

  // 5b. Size policies: largest canvas, and a preset portrait canvas.
  {
    const snapshot = freeze(list([["a24_audio.mp4", 0, 0.5], ["d30_hd.mp4", 0, 0.5]]));
    const largest = await render(snapshot, "largest");
    assert.deepEqual([largest.status.result.width, largest.status.result.height], [1280, 720]);
    assert.equal((await inspect(largest.output, { frames: [0] })).frames[0].litWidth, 1280, "640×360 scaled up to fill 16:9, not stretched");
    await jobs.dispose(largest.id);
    const portrait = await render(snapshot, "1080x1920");
    assert.deepEqual([portrait.status.result.width, portrait.status.result.height, portrait.status.result.fpsReason], [1080, 1920, "mixed_default_24"]);
    await jobs.dispose(portrait.id);
  }

  // 7 + 8. Disabled item stays out; the same Asset used twice lands in both places with its own range.
  {
    const value = list([["a24_audio.mp4", 0, 1], ["c24_mono441.mp4", 0, 1, { enabled: false }], ["b48_silent_portrait.mp4", 0, 0.5], ["a24_audio.mp4", 3, 4]]);
    const snapshot = freeze(value);
    assert.deepEqual(snapshot.clips.map((clip) => [clip.order, clip.assetId]), [[1, assetFor["a24_audio.mp4"].assetId], [3, assetFor["b48_silent_portrait.mp4"].assetId], [4, assetFor["a24_audio.mp4"].assetId]]);
    assert.deepEqual(snapshot.disabled.map((item) => item.order), [2]);
    const result = await render(snapshot);
    assert.equal(result.status.result.frames, 24 + 12 + 24, "disabled clip not rendered");
    const info = await inspect(result.output, { frames: [0, 24, 36, 59] });
    assert.deepEqual(info.frames.map((frame) => Math.round(frame.centre[0] / 10) * 10), [40, 110, 40, 40]);
    assert.ok(near(info.frames[2].centre[1], G(72)) && near(info.frames[3].centre[1], G(95)), "second use of A starts at 3.0 s");
    await jobs.dispose(result.id);
  }

  // 9. The snapshot is frozen: editing the list afterwards changes nothing in this export.
  {
    let value = list([["a24_audio.mp4", 0, 1], ["c24_mono441.mp4", 0, 1]]);
    const snapshot = freeze(value);
    const before = structuredClone(snapshot);
    value = moveItem(value, 1, 0);
    value = setItemRange(value, "i0", 2, 3, 4);
    value = updateItem(value, "i1", { enabled: false, title: "改名" });
    assert.deepEqual(snapshot, before, "snapshot untouched by later edits");
    assert.equal(sameRoughCut(snapshot, freeze(list([["a24_audio.mp4", 0, 1], ["c24_mono441.mp4", 0, 1]]))), true);
    assert.equal(sameRoughCut(snapshot, freezeRoughCut(value, resolveRows(value, { assets: assets() })).snapshot), false, "a changed list is detected at start");
    const result = await render(snapshot);
    const info = await inspect(result.output, { frames: [0, 24] });
    assert.deepEqual(info.frames.map((frame) => Math.round(frame.centre[0] / 10) * 10), [40, 180], "frozen order A → C");
    await jobs.dispose(result.id);
  }

  // 10. Missing / unusable material blocks the start; nothing is skipped.
  {
    const value = list([["a24_audio.mp4", 0, 1], ["c24_mono441.mp4", 0, 1], ["b48_silent_portrait.mp4", 0, 1]]);
    const withoutC = new Map([...assets()].filter(([id]) => id !== assetFor["c24_mono441.mp4"].assetId));
    const blocked = freezeRoughCut(value, resolveRows(value, { assets: withoutC }));
    assert.deepEqual(blocked, { ok: false, problems: ["第2段素材已失效"] });
    const legacy = new Map([...assets()].map(([id, asset]) => [id, id === assetFor["b48_silent_portrait.mp4"].assetId ? { ...asset, storageReference: "legacy-inline:x" } : asset]));
    assert.match(freezeRoughCut(value, resolveRows(value, { assets: legacy })).problems[0], /第3段/);
    assert.deepEqual(freezeRoughCut(list([["a24_audio.mp4", 0, 1, { enabled: false }]]), resolveRows(list([["a24_audio.mp4", 0, 1, { enabled: false }]]), { assets: assets() })).problems, ["没有可输出的启用片段"]);
  }

  // 11. A damaged middle clip fails the whole export with clip / file / stage / PyAV error, and leaves no output.
  {
    const broken = await render(freeze(list([["a24_audio.mp4", 0, 1], ["broken.mp4", 0, 1], ["c24_mono441.mp4", 0, 1]]))).catch((cause) => ({ planError: cause.roughCut }));
    assert.ok(broken.planError, "an unreadable file is refused before any encoding (plan)");
    assert.deepEqual([broken.planError.code, broken.planError.clip, broken.planError.stage, broken.planError.filename], ["UNREADABLE_MEDIA", 2, "probe", "broken.mp4"]);
    for (const dir of await readdir(jobRoot)) await jobs.dispose(dir.replace("frameflow-roughcut-", ""));
    const truncated = await render(freeze(list([["a24_audio.mp4", 0, 1], ["truncated.mp4", 0, 2], ["c24_mono441.mp4", 0, 1]])));
    assert.equal(truncated.status.state, "failed");
    assert.deepEqual([truncated.status.error.clip, truncated.status.error.stage, truncated.status.error.filename], [2, "clip", "truncated.mp4"], JSON.stringify(truncated.status.error));
    assert.match(truncated.status.error.code, /TRUNCATED_MEDIA|CLIP_FAILED/);
    const files = await readdir(join(jobRoot, `frameflow-roughcut-${truncated.id}`));
    assert.ok(!files.includes("output.mp4"), "no half-written output");
    await assert.rejects(jobs.resultFile(truncated.id), /尚未完成/);
    await jobs.dispose(truncated.id);
  }

  // Cancel mid-render: process stopped, folder removed, no result.
  {
    const clips = Array.from({ length: 30 }, () => ["d30_hd.mp4", 0, 2]);
    const snapshot = freeze(list(clips));
    const created = await jobs.create(snapshot.clips.map((clip) => ({ key: clip.sourceKey, inPoint: clip.inPoint, outPoint: clip.outPoint, title: "", filename: "d30_hd.mp4" })));
    for (const key of created.sources) await jobs.writeSource(created.id, key, createReadStream(sourceFile[key]));
    await jobs.start(created.id, "first");
    for (let i = 0; i < 200 && jobs.status(created.id).stage?.stage !== "clip"; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    await assert.rejects(jobs.dispose(created.id), /禁止普通清理/);
    assert.equal(jobs.status(created.id).state, "running", "idle cleanup cannot kill or delete a running export");
    await jobs.cancel(created.id);
    assert.ok(!(await readdir(jobRoot)).includes(`frameflow-roughcut-${created.id}`), "temporary files removed on cancel");
    assert.equal(jobs.status(created.id).state, "cancelled", "pollers retain the explicit cancelled result, not JOB_NOT_FOUND");
    assert.match(jobs.status(created.id).error.message, /用户明确取消/);
    const cancelLog=JSON.parse(await readFile(jobs.status(created.id).error.logPath,"utf8"));
    assert.equal(cancelLog.reason,"用户明确取消粗剪");
    await jobs.dispose(created.id);
  }

  // 12 + 13. Success creates exactly one Rough Cut Asset (+ a completed final_cut_rough Run); it persists.
  let roughAsset;
  {
    const snapshot = freeze(list([["a24_audio.mp4", 1, 2.5], ["b48_silent_portrait.mp4", 0.5, 2], ["c24_mono441.mp4", 0, 1]]));
    const before = (await listAssets()).length;
    const runRecord = await beginRoughCutRun(snapshot, { sizePolicy: "first", scriptVersion: "sha256:test", plannedOutput: {} });
    assert.deepEqual([runRecord.capabilityId, runRecord.status, runRecord.parameters.sessionId], ["final_cut_rough", "running", ROUGH_CUT_SESSION]);
    const video = new Blob([await readFile(firstOutput.output)], { type: "video/mp4" });
    roughAsset = await saveRoughCut({ run: runRecord, snapshot, output: firstOutput.status.result, video, store: storeLocalVideo, now: new Date(2026, 8, 26, 10, 11, 12).getTime() });
    assert.equal((await listAssets()).length, before + 1, "exactly one new Asset");
    assert.deepEqual([roughAsset.kind, roughAsset.origin, roughAsset.derivationType, roughAsset.filename], ["video", "generated", "final_cut_rough", "粗剪_20260926_101112.mp4"]);
    assert.deepEqual([roughAsset.width, roughAsset.height, roughAsset.fps, roughAsset.duration], [640, 360, 24, 4]);
    assert.equal(roughAsset.sourceSequenceId, "seq-1");
    assert.deepEqual(roughAsset.sourceItemIds, ["i0", "i1", "i2"]);
    assert.deepEqual(roughAsset.sourceAssetIds, [assetFor["a24_audio.mp4"].assetId, assetFor["b48_silent_portrait.mp4"].assetId, assetFor["c24_mono441.mp4"].assetId]);
    const done = await getRun(runRecord.runId);
    assert.deepEqual([done.status, done.outputAssetIds, done.inputAssetIds.length, done.workflowIdentity.templateFile], ["completed", [roughAsset.assetId], 3, "rough-cut.py"]);
    assert.deepEqual(done.parameters.snapshot.clips.map((clip) => [clip.inPoint, clip.outPoint]), [[1, 2.5], [0.5, 2], [0, 1]], "Run keeps the frozen snapshot");
    const stored = await getLocalVideoBlob(roughAsset.storageReference);
    assert.equal(stored.size, video.size, "the MP4 itself is stored (re-readable after a reload)");
    for (const source of Object.values(assetFor)) assert.equal((await listAssets()).find((asset) => asset.assetId === source.assetId).storageReference, source.storageReference, "sources untouched");
    assert.equal(roughCutFileName("我的短片", new Date(2026, 8, 26, 10, 11, 12).getTime(), new Set(["我的短片_粗剪_20260926_101112.mp4"])), "我的短片_粗剪_20260926_101112_2.mp4", "titled name, never overwrites");
    // A run left "running" by an earlier page session is closed as interrupted.
    const stale = await createRun({ capabilityId: "final_cut_rough", parameters: { sessionId: "old-page" }, workflowIdentity: { capabilityId: "final_cut_rough", templateVersion: "x", templateFile: "rough-cut.py" }, inputAssetIds: [], rawPrompt: null, finalPrompt: null, seed: null });
    assert.equal(await markInterruptedRoughCuts(), 1);
    assert.equal((await getRun(stale.runId)).status, "failed");
  }

  // 14. Phase 8 backup: the Rough Cut Asset, its MP4 and its Run survive export → restore.
  {
    const files = new Map();
    const sink = { writeText: async (path, text) => { files.set(path, new Blob([text])); }, writeBlob: async (path, blob) => { files.set(path, blob); } };
    await exportProject(null, sink, { appVersion: "test", persistenceKey: "frameflow-v0.1-canvas", now: 1 });
    const records = JSON.parse(await files.get("records.json").text());
    assert.ok(records.assets.some((asset) => asset.assetId === roughAsset.assetId && asset.derivationType === "final_cut_rough"));
    assert.ok(records.runs.some((item) => item.capabilityId === "final_cut_rough" && item.status === "completed"));
    const source = { has: (path) => files.has(path), size: (path) => files.get(path)?.size ?? null, readText: async (path) => files.get(path).text(), readBlob: async (path) => files.get(path) };
    const report = await restoreProject(await readBackup(source), { current: () => null, load: () => {} });
    assert.equal(report.ok, true);
    assert.equal((await getLocalVideoBlob(roughAsset.storageReference)).size, (await stat(firstOutput.output)).size);
    assert.ok((await collectProject()).records.assets.some((asset) => asset.assetId === roughAsset.assetId));
    assert.equal((await listRuns()).filter((item) => item.capabilityId === "final_cut_rough" && item.status === "completed").length, 1);
  }

  console.log("Rough cut: 3 Assets → one MP4, order, in/out trim on real timestamps, 24/48 FPS rule, letterbox (first / largest / preset), silent + mono audio continuity, disabled excluded, repeated Asset, frozen snapshot, missing material blocked, damaged / truncated clip fails cleanly, cancel cleans up, one Rough Cut Asset + Run, persistence, Phase 8 backup passed");
} finally {
  await jobs.disposeAll();
  await rm(temp, { recursive: true, force: true });
  await rm(jobRoot, { recursive: true, force: true });
}
