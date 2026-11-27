import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import "./fake-indexeddb.mjs";
import { resolveH3TaskMode, assertH3ModeSubmittable, H3ModeNotEnabledError, H3_TASK_STATUS } from "../lib/h3-task-mode.ts";
import { runH3Preflight, frameModeCounts, findMediaReferences, ZERO_BASED_MESSAGE, H3_LIMITS } from "../lib/h3-preflight.ts";
import { buildH3Workflow, planH3Submission, ComfyUIH3Adapter } from "../lib/comfyui/h3-adapter.ts";
import { buildReferenceWorkflow } from "../lib/comfyui/extra-workflows.ts";
import { buildH3T2vaWorkflow, t2vaDimensions, H3_T2VA_TEMPLATE_FILE } from "../lib/comfyui/h3-t2va.ts";
import { snapshotH3, h3ClassTypesFor } from "../lib/production-snapshots.ts";
import { buildEngineInfo, describeEngine, packForModule } from "../lib/comfyui/engine-info.ts";
import { createRun, getRun } from "../lib/production-records.ts";
import { saveNodeForCapability } from "../lib/run-recovery.ts";
import { describeRunMedia, formatMediaLine } from "../lib/run-media-map.ts";
import { planHybrid } from "../lib/h3-hybrid.ts";
import { T8_EXPERIMENT, assertT8ExperimentEnabled, T8ExperimentDisabledError, planT8Submission, compareT8Echo } from "../lib/comfyui/experimental/h3-t8.ts";

const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const settings = { length: 141, aspect: "follow", megapixels: 0.5, turbo: true, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32, soundMode: "av" };
const counts = (pictures, extra = {}) => ({ pictures, videos: 0, audios: 0, standaloneAudios: 0, subjects: 0, ...extra });
const base = (extra) => ({ mode: "ref2va", prompt: "镜头缓慢推进", counts: counts(2), length: 141, megapixels: 0.5, ...extra });
const codes = (result) => [...result.errors.map((item) => item.code), ...result.warnings.map((item) => `~${item.code}`)];

// 1–4. Automatic mode from what is connected (the user never picks a workflow).
assert.equal(resolveH3TaskMode({ hasFirstFrame: false, hasLastFrame: false, hasReferences: false }).mode, "t2va", "1. no picture → T2VA");
assert.equal(resolveH3TaskMode({ hasFirstFrame: true, hasLastFrame: false, hasReferences: false }).mode, "i2va", "2. first frame → I2VA");
assert.equal(resolveH3TaskMode({ hasFirstFrame: true, hasLastFrame: true, hasReferences: false }).mode, "fl2va", "3. first + last → FL2VA");
assert.equal(resolveH3TaskMode({ hasFirstFrame: false, hasLastFrame: false, hasReferences: true }).mode, "ref2va", "4. references → Ref2VA");
assert.equal(resolveH3TaskMode({ hasFirstFrame: true, hasLastFrame: false, hasReferences: true }).mode, "ref2va", "first frame + references stays Ref2VA (first frame as a reference picture)");
assert.equal(resolveH3TaskMode({ hasFirstFrame: true, hasLastFrame: true, hasReferences: true }).mode, "hybrid", "keyframes + references → 🧪 Hybrid");
assert.equal(resolveH3TaskMode({ hasFirstFrame: true, hasLastFrame: false, hasReferences: true, hybridLock: true }).mode, "hybrid");
assert.equal(resolveH3TaskMode({ hasFirstFrame: false, hasLastFrame: true, hasReferences: false }).mode, null, "last frame only is not silently turned into T2VA");
assert.match(resolveH3TaskMode({ hasFirstFrame: false, hasLastFrame: true, hasReferences: false }).problem, /尾帧/);
assert.equal(H3_TASK_STATUS.t2va.verified, false, "T2VA is labelled as not yet human-verified");

// 5. Zero-based references are blocked with the explicit message.
for (const text of ["参考图0的角色", "参考音频0的音色", "参考视频0", "Picture 0", "Audio 0", "Video 0", "<Picture 0>", "Image 0", "参考图片 0"]) {
  const result = runH3Preflight(base({ prompt: text, counts: counts(2, { audios: 2, standaloneAudios: 2, videos: 1 }) }));
  assert.equal(result.ok, false, `${text} must be blocked`);
  assert.ok(result.errors.some((item) => item.code === "zero_based" && item.message.startsWith(ZERO_BASED_MESSAGE)), text);
}
assert.ok(runH3Preflight(base({ prompt: "参考图1 和 参考图2 对话，Picture 10 不是零", counts: counts(10) })).errors.every((item) => item.code !== "zero_based"), "1, 2, 10 are not zero-based");

// 6. Too many pictures → blocked.
assert.deepEqual(codes(runH3Preflight(base({ counts: counts(10) }))), ["picture_limit"], "6. 10 pictures");
assert.equal(runH3Preflight(base({ counts: counts(H3_LIMITS.pictures) })).ok, true, "9 pictures are fine");

// 7. Too many standalone audios → blocked (reference-video soundtracks do not count).
assert.deepEqual(codes(runH3Preflight(base({ counts: counts(1, { audios: 4, standaloneAudios: 4 }) }))), ["audio_limit"], "7. 4 audios");
assert.equal(runH3Preflight(base({ counts: counts(1, { videos: 3, audios: 6, standaloneAudios: 3 }) })).ok, true, "3 standalone + 3 soundtracks are fine");
assert.deepEqual(codes(runH3Preflight(base({ counts: counts(1, { videos: 4 }) }))), ["video_limit"]);

// 8. Reference video duration.
{
  const video = (durationSeconds, fps = 24) => runH3Preflight(base({ counts: counts(1, { videos: 1 }), referenceVideos: [{ name: "ref.mp4", durationSeconds, fps }] }));
  assert.deepEqual(codes(video(1.5)), ["ref_video_short"], "8. 1.5 s is blocked");
  assert.equal(video(2).ok, true); assert.equal(video(15).ok, true);
  assert.deepEqual(codes(video(20)), ["~ref_video_long"], "longer than 15 s: warning, truncated to the generation length");
  assert.deepEqual(codes(video(null)), ["~ref_video_unknown"]);
  assert.deepEqual(codes(video(5, 30)), ["~ref_video_fps"]);
}

// 9. Picture / Audio / Video / Subject numbers must exist.
assert.deepEqual(codes(runH3Preflight(base({ prompt: "<Picture 3> 看向 <Picture 1>" }))), ["tag_missing"], "9. <Picture 3> with 2 pictures");
assert.deepEqual(codes(runH3Preflight(base({ prompt: "用 <Audio 1> 的音色" }))), ["tag_missing"], "no audio connected");
assert.deepEqual(codes(runH3Preflight(base({ prompt: "参考图3 的角色", counts: counts(2) }))), ["tag_missing"], "Chinese wording too");
assert.deepEqual(codes(runH3Preflight(base({ prompt: "<Subject 2> says", counts: counts(2, { subjects: 1 }) }))), ["tag_missing"]);
assert.deepEqual(codes(runH3Preflight(base({ prompt: "the Video 2 wall screen", counts: counts(2, { videos: 1 }) }))), ["~tag_missing"], "bare English prose is only a warning");
assert.equal(runH3Preflight(base({ prompt: "<Picture 1> 与 <Picture 2> 对话，<Audio 1> 的音色", counts: counts(2, { audios: 1, standaloneAudios: 1 }) })).ok, true);
assert.deepEqual(codes(runH3Preflight({ ...base({ mode: "t2va", prompt: "<Picture 1> 在跳舞", counts: frameModeCounts("t2va") }) })), ["tag_missing"], "T2VA has no pictures");
assert.equal(runH3Preflight({ ...base({ mode: "fl2va", prompt: "从 <Picture 1> 过渡到 <Picture 2>", counts: frameModeCounts("fl2va") }) }).ok, true, "FL2VA frames are Picture 1 / 2");
assert.deepEqual(findMediaReferences("参考音频2、<Video 1>、Image 3").map((item) => `${item.kind}${item.ordinal}/${item.style}`), ["video1/tag", "picture3/bare", "audio2/chinese"]);

// Frame count, pixel budget, canvas.
assert.deepEqual(codes(runH3Preflight(base({ length: 140 }))), ["length_grid"]);
assert.deepEqual(codes(runH3Preflight(base({ length: 107 }))), ["length_range"]);
assert.deepEqual(codes(runH3Preflight(base({ megapixels: 1.2 }))), ["megapixels"]);
assert.deepEqual(codes(runH3Preflight(base({ mode: "t2va", counts: frameModeCounts("t2va"), dimensions: { width: 960, height: 540 } }))), ["dimensions"], "T2VA canvas must be /32");
assert.deepEqual(codes(runH3Preflight(base({ mode: "i2va", counts: frameModeCounts("i2va"), dimensions: { width: 1376, height: 768 } }))), ["~pixel_area"], "above 768×1344: warning only");
assert.deepEqual(codes(runH3Preflight(base({ mode: "hybrid" }))), ["mode_disabled"], "Hybrid preflight never passes");

// T2VA: separate template = frozen FL2VA minus its image nodes; same model / LoRA / sampler / node IDs.
{
  const frozen = JSON.parse(await readFile(new URL("../lib/comfyui/h3-workflow.json", import.meta.url), "utf8"));
  const t2va = JSON.parse(await readFile(new URL("../lib/comfyui/h3-t2va-workflow.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(frozen).filter((id) => !t2va[id]).sort(), ["20", "21", "22"], "only the image nodes are gone");
  for (const id of Object.keys(t2va)) if (!["6", "15"].includes(id)) assert.deepEqual(t2va[id], frozen[id], `node ${id} identical to FL2VA`);
  assert.equal(t2va["6"].class_type, "MiniMaxH3ImageToVideo"); assert.equal("first_frame" in t2va["6"].inputs, false);
  const workflow = buildH3T2vaWorkflow("一只翼龙穿过云层", 42, settings);
  assert.deepEqual([workflow["6"].inputs.width, workflow["6"].inputs.height], [960, 544], "16:9 at 0.50 MP, /32");
  assert.deepEqual(t2vaDimensions({ ...settings, aspect: "9:16" }), { width: 544, height: 960 });
  assert.equal(workflow["6"].inputs.prompt, "一只翼龙穿过云层"); assert.equal(workflow["10"].inputs.noise_seed, 42); assert.equal(workflow["6"].inputs.length, 141);
  assert.equal(workflow["1"].inputs.unet_name, "minimax_h3_fl2va_pruned_int8_convrot.safetensors"); assert.equal(workflow["5"].inputs.lora_name, "minimax_h3_turbo_v4_step600_ema.safetensors");
  assert.ok(workflow["15"] && workflow["11"], "SaveVideo 15 / sampler 11 kept (progress + recovery)"); assert.equal(saveNodeForCapability("h3_fl2va"), "15");
  assert.equal("audio" in buildH3T2vaWorkflow("x", 1, { ...settings, soundMode: "silent" })["14"].inputs, false);
  assert.throws(() => buildH3T2vaWorkflow("  ", 1, settings), /需要 Prompt/);
  assert.throws(() => buildH3T2vaWorkflow("x", 1, { ...settings, length: 140 }), /17k\+5/);
  const snapshot = await snapshotH3({ taskMode: "t2va", referenceMode: false, prompt: "x", seed: 1, settings, sourceWidth: 0, sourceHeight: 0, hasLastFrame: false, referenceCounts: { images: 0, videos: 0, audios: 0, videoAudioFlags: [] } });
  assert.equal(snapshot.capabilityId, "h3_fl2va"); assert.equal(snapshot.workflowIdentity.templateFile, H3_T2VA_TEMPLATE_FILE);
  assert.deepEqual([snapshot.parameters.mode, snapshot.parameters.width, snapshot.parameters.height, snapshot.parameters.aspectRatio], ["text", 960, 544, "16:9"]);
  // Retired 2026-11-10: the stable T2VA path is blocked before any upload; text-to-video goes through ultimate/fast H3.
  assert.throws(() => planH3Submission({ taskMode: "t2va", prompt: "x", seed: 1, settings }, { references: { images: [], videos: [], audios: [] } }), /已停用/);
}

// 10. FL2VA / Ref2VA unchanged: frozen templates and builder outputs match the hashes recorded before this change.
{
  const golden = {
    fl2va_first: "6c28cc1d105d3e0f8d82f7d1c5cd9c42ee73b7c4c69a8cbb369fe85a927aebef",
    fl2va_firstlast: "fedbeb25320a474ed70d523a506289f32b02d4090f9d3675deccc5a7ff5d7764",
    ref2va: "17a2c515a3ebd52a73718e5134cd35dbb8d2e42862ae4843a344895b4ecfd47c",
    snap_fl2va: "7b5663e8968ca0341573a6379f8f1193adc91ae1eb14f00f9e3e79ed46405dcb",
    snap_ref2va: "cd80bb6a2056dee9372636e6b539f2520f78969daa82a283d6ba029301aef024",
  };
  const firstLast = { ...settings, aspect: "16:9", soundMode: "silent" };
  const refSettings = { ...settings, aspect: "16:9" };
  const refNames = { images: ["a.png", "b.png"], videos: ["v.mp4"], audios: ["s.wav"], videoAudioFlags: [true] };
  assert.equal(sha(buildH3Workflow("first.png", "P", 7, settings)), golden.fl2va_first);
  assert.equal(sha(buildH3Workflow("first.png", "P", 7, firstLast, "last.png")), golden.fl2va_firstlast);
  assert.equal(sha(buildReferenceWorkflow(refNames, "P", 7, refSettings)), golden.ref2va);
  assert.equal(sha(await snapshotH3({ referenceMode: false, prompt: "P", seed: 7, settings, sourceWidth: 1024, sourceHeight: 768, hasLastFrame: true, referenceCounts: { images: 1, videos: 0, audios: 0, videoAudioFlags: [] } })), golden.snap_fl2va);
  assert.equal(sha(await snapshotH3({ referenceMode: true, prompt: "P", seed: 7, settings: refSettings, sourceWidth: 0, sourceHeight: 0, hasLastFrame: false, referenceCounts: { images: 2, videos: 1, audios: 1, videoAudioFlags: [true] } })), golden.snap_ref2va);
  const fileHash = async (name) => createHash("sha256").update(await readFile(new URL(`../lib/comfyui/${name}`, import.meta.url))).digest("hex");
  assert.equal(await fileHash("h3-workflow.json"), "53131f30550f78d686762033432606bee5a7a0ecc0b7820d99e3b82d1f8dc195", "frozen FL2VA template file untouched");
  assert.equal(await fileHash("h3-reference-workflow.json"), "c64c1e9aa9a5d109d3b250a0c43595dd9f84c360f32591409264a383bfb4d3c7", "frozen Ref2VA template file untouched");
  assert.equal(await fileHash("seedvr2-workflow.json"), "a12936a5d2bedb4dadf4b6ee256e7a670eb12c317c7075e741c07d7d76e0d39e");
  assert.equal(await fileHash("film-workflow.json"), "e4c622e0cc654e5be54b62645797ea374c6a66af488b679b0fd9fa72863d9599");
  // Retired 2026-11-10: the stable I2VA / FL2VA / Ref2VA submissions are all refused; the frozen builders above stay for history.
  const noRefs = { images: [], videos: [], audios: [] };
  assert.throws(() => planH3Submission({ prompt: "P", seed: 7, settings, taskMode: "i2va" }, { imageName: "first.png", references: noRefs }), /已停用/);
  assert.throws(() => planH3Submission({ prompt: "P", seed: 7, settings: firstLast, taskMode: "fl2va" }, { imageName: "first.png", lastImageName: "last.png", references: noRefs }), /已停用/);
  assert.throws(() => planH3Submission({ prompt: "raw", compiledPrompt: "P", seed: 7, settings: refSettings, referenceMode: true, taskMode: "ref2va", referenceVideos: [{ withAudio: true }] }, { imageName: "a.png", references: { images: ["b.png"], videos: ["v.mp4"], audios: ["s.wav"] } }), /已停用/);
  assert.throws(() => planH3Submission({ prompt: "P", seed: 7, settings }, { references: noRefs }), /已停用/);
}

// 11. Runs record ComfyUI / node versions (shapes taken from the real 8188 responses) and the task mode.
{
  const stats = { system: { comfyui_version: "0.34.0", python_version: "3.13.14 (tags/v3.13.14:fd17997, Jun 10 2026) [MSC v.1944 64 bit (AMD64)]", pytorch_version: "2.13.0+cu130", comfy_package_versions: [{ name: "comfy-kitchen", installed: "0.2.31", required: "0.2.31" }] } };
  const objectInfo = { MiniMaxH3ImageToVideo: { python_module: "comfy_extras.nodes_minimax_h3" }, MiniMaxH3TurboSampler: { python_module: "custom_nodes.ComfyUI-MiniMax-H3-Turbo-main" }, UNETLoader: { python_module: "nodes" } };
  const classTypes = h3ClassTypesFor("i2va");
  assert.ok(["MiniMaxH3ImageToVideo", "MiniMaxH3TurboLoRA", "MiniMaxH3TurboSampler", "UNETLoader", "CLIPLoader"].every((type) => classTypes.includes(type)), classTypes.join());
  assert.ok(h3ClassTypesFor("ref2va").includes("MiniMaxH3ReferenceToVideo"));
  const info = buildEngineInfo(stats, objectInfo, ["MiniMaxH3ImageToVideo", "MiniMaxH3TurboSampler", "UNETLoader", "MiniMaxH3TurboLoRA"], {}, 5);
  assert.deepEqual([info.comfyuiVersion, info.pythonVersion, info.pytorchVersion], ["0.34.0", "3.13.14", "2.13.0+cu130"]);
  assert.deepEqual(info.packages, [{ name: "comfy-kitchen", version: "0.2.31" }]);
  assert.deepEqual(info.nodes.map((node) => [node.classType, node.pack, node.version]), [["MiniMaxH3ImageToVideo", "ComfyUI core", "0.34.0"], ["MiniMaxH3TurboSampler", "ComfyUI-MiniMax-H3-Turbo-main", null], ["UNETLoader", "ComfyUI core", "0.34.0"], ["MiniMaxH3TurboLoRA", null, null]]);
  assert.match(info.note, /MiniMaxH3TurboLoRA/, "a missing node is reported, not guessed");
  assert.equal(buildEngineInfo(stats, objectInfo, ["MiniMaxH3TurboSampler"], { "comfyui-minimax-h3-turbo-main": { ver: "1.2.0" } }).nodes[0].version, "1.2.0", "Manager version used when available");
  assert.equal(packForModule("custom_nodes.Foo.sub"), "Foo");
  const calls = [];
  const described = await describeEngine(async (path) => { calls.push(path); if (path === "/system_stats") return stats; if (path.startsWith("/object_info/")) { const name = decodeURIComponent(path.slice(13)); return { [name]: objectInfo[name] }; } throw new Error("404"); }, ["MiniMaxH3ImageToVideo", "MiniMaxH3TurboSampler"]);
  assert.equal(described.comfyuiVersion, "0.34.0"); assert.ok(calls.includes("/v2/customnode/installed"));
  assert.ok(calls.every((path) => !path.includes("prompt")), "read-only GETs, nothing submitted");
  const offline = await describeEngine(async () => { throw new Error("offline"); }, ["UNETLoader"]);
  assert.equal(offline.comfyuiVersion, null); assert.match(offline.note, /ComfyUI/);
  const run = await createRun({ capabilityId: "h3_fl2va", parameters: {}, workflowIdentity: { capabilityId: "h3_fl2va", templateVersion: "sha256:x", templateFile: H3_T2VA_TEMPLATE_FILE }, inputAssetIds: [], rawPrompt: "x", finalPrompt: "x", seed: 1, taskMode: "t2va", engine: info });
  const stored = await getRun(run.runId);
  assert.equal(stored.taskMode, "t2va"); assert.equal(stored.engine.comfyuiVersion, "0.34.0"); assert.equal(stored.engine.nodes[1].pack, "ComfyUI-MiniMax-H3-Turbo-main");
}

// Generation info: who is which number.
{
  const manifest = {
    roleBindings: [{ roleId: "dog", roleName: "柴犬", pictureRefIndex: 1, audioRefIndex: 2, subjectIndex: 1 }, { roleId: "cat", roleName: "橘猫", pictureRefIndex: 2, audioRefIndex: null, subjectIndex: 2 }],
    pictureRefs: [{ index: 1, filename: "dog.png", sources: ["role_appearance"], roleIds: ["dog"] }, { index: 2, filename: "cat.png", sources: ["role_appearance"], roleIds: ["cat"] }, { index: 3, filename: "room.png", sources: ["reference_image"], roleIds: [] }],
    videoRefs: [{ index: 1, filename: "walk.mp4", withAudio: true, audioIndex: 1 }],
    audioRefs: [{ index: 1, kind: "video_soundtrack", filename: "walk.mp4", sources: [], roleIds: [] }, { index: 2, kind: "standalone", filename: "dog.wav", sources: ["role_voice"], roleIds: ["dog"] }],
  };
  const lines = describeRunMedia({ capabilityId: "h3_ref2va", referenceManifest: manifest, parameters: {} }).lines.map(formatMediaLine);
  assert.deepEqual(lines, ["柴犬 → Picture 1 → Audio 2", "橘猫 → Picture 2", "参考图 room.png → Picture 3", "参考视频 walk.mp4 → Video 1 → Audio 1"]);
  const frames = describeRunMedia({ capabilityId: "h3_fl2va", parameters: { mode: "first-last" }, referenceInputs: [{ assetId: "a1", kind: "image", role: "first_frame", order: 0 }, { assetId: "a2", kind: "image", role: "last_frame", order: 1 }] }, new Map([["a1", "start.png"], ["a2", "end.png"]]));
  assert.deepEqual(frames.lines.map(formatMediaLine), ["首帧 start.png → Picture 1", "尾帧 end.png → Picture 2"]);
  assert.match(describeRunMedia({ capabilityId: "h3_fl2va", taskMode: "t2va", parameters: { mode: "text" } }).note, /文生视频/);
}

// 12. Hybrid cannot be submitted by any path; the T8 experiment is design-only.
{
  assert.throws(() => assertH3ModeSubmittable("hybrid"), H3ModeNotEnabledError);
  assert.throws(() => assertH3ModeSubmittable(null), /无法判断/);
  // The stable workflow is refused first (已停用); either way Hybrid never builds a workflow.
  assert.throws(() => planH3Submission({ taskMode: "hybrid", prompt: "x", seed: 1, settings }, { imageName: "a.png", lastImageName: "b.png", references: { images: ["c.png"], videos: [], audios: [] } }), /已停用|Hybrid|混合/);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { requests.push(String(url)); return new Response("{}", { status: 200 }); };
  try {
    await assert.rejects(new ComfyUIH3Adapter().generate({ taskMode: "hybrid", prompt: "x", seed: 1, settings, image: new Blob(["x"]), lastImage: new Blob(["y"]), referenceImages: [{ blob: new Blob(["z"]), name: "r.png" }] }), /已停用|Hybrid|混合/);
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(requests, [], "no request at all (not even the availability check) for Hybrid");
  const canvas = await readFile(new URL("../app/canvas-workspace.tsx", import.meta.url), "utf8");
  const generateStart = canvas.search(/  const generate = async \(enqueueOnly = false[^)]*\) => \{\r?\n    if \(busy \|\| recovery.blocking/);
  assert.ok(generateStart >= 0, "locate the actual queue-capable H3 generation handler");
  const generateBody = canvas.slice(generateStart);
  assert.ok(generateBody.indexOf("assertH3ModeSubmittable(mode)") > 0 && generateBody.indexOf("assertH3ModeSubmittable(mode)") < generateBody.indexOf("claimNode(shape.id)"), "the canvas refuses Hybrid before claiming the node or touching any file");
  assert.ok(generateBody.indexOf("reportPreflight(runH3Preflight(") < generateBody.indexOf("createRunExclusively"), "preflight runs before any Run is recorded");

  const hybrid = planHybrid({ firstFrame: { assetId: "f", filename: "first.png" }, lastFrame: { assetId: "l", filename: "last.png" }, manifest: { ...{ roleBindings: [{ roleId: "dog" }] }, pictureRefs: [{ index: 1, assetId: "f", filename: "first.png", sources: ["first_frame"], roleIds: [] }, { index: 2, assetId: "d", filename: "dog.png", sources: ["role_appearance"], roleIds: ["dog"] }], videoRefs: [], audioRefs: [{ index: 1, kind: "standalone", roleIds: ["dog"] }] } });
  assert.deepEqual(hybrid.pictures.map((item) => `${item.index}:${item.role}:${item.filename}`), ["1:first_frame_keyframe:first.png", "2:last_frame_keyframe:last.png", "3:reference:dog.png"], "keyframes first, the first frame is not duplicated");
  assert.deepEqual(hybrid.pictureRenumbering, { 1: 1, 2: 3 });
  assert.equal(hybrid.backendEnabled, false);
  assert.equal(runH3Preflight({ ...base({ mode: "hybrid", counts: hybrid.counts }) }).ok, false);

  assert.equal(T8_EXPERIMENT.enabled, false); assert.equal(T8_EXPERIMENT.serverUrl, "http://127.0.0.1:8189");
  assert.throws(() => assertT8ExperimentEnabled(), T8ExperimentDisabledError);
  const t8 = planT8Submission({ mode: "ref2va", prompt: "<Picture 1> 说话", width: 960, height: 544, length: 141, seed: 1, steps: 8, slots: { ref_images: ["a.png"], ref_videos: [], ref_audios: ["a.wav"] }, expectedCounts: counts(1, { audios: 1, standaloneAudios: 1 }) });
  assert.deepEqual([t8.capabilityId, t8.taskType, t8.fixed.prompt_primary_audio_ordinal, t8.fixed.strict_prompt_tags], ["h3_t8_ref2va", "Ref2VA", 0, true]);
  assert.throws(() => planT8Submission({ mode: "t2va", prompt: "x", width: 960, height: 544, length: 141, seed: 1, steps: 8, slots: { first_frame: "a.png", ref_images: [], ref_videos: [], ref_audios: [] }, expectedCounts: counts(0) }), /T2VA/);
  const echo = (prompt, map) => compareT8Echo({ prompt: "<Picture 1> 说话", counts: counts(1, { audios: 1 }) }, { conditionedPrompt: prompt, mediaMapJson: JSON.stringify(map), report: "" });
  assert.equal(echo("<Picture 1> 说话", { pictures: { 1: "ref_image_1" }, videos: {}, audios: { 1: "ref_audio_1" } }).ok, true);
  assert.equal(echo("<Picture 1> says", { pictures: { 1: "x" }, videos: {}, audios: {} }).problems.length, 2, "rewritten prompt and a missing audio are both caught");
}

console.log("H3 modes: T2VA / I2VA / FL2VA / Ref2VA auto mode, Hybrid resolution, zero-based block, picture / audio / video limits, reference-video duration, missing tags, length / pixels, T2VA template + builder + snapshot, FL2VA / Ref2VA golden unchanged, engine versions on Runs, media map, Hybrid and T8 cannot submit passed");
