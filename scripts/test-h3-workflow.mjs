import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calculateH3Dimensions, getActualDuration, H3_LENGTH_GRID, H3_LENGTH_OFFSET, H3_MAX_LENGTH, H3_MAX_REQUESTED_SECONDS, H3_MIN_LENGTH, H3_TRAINED_MAX_LENGTH_BOUND, lengthToSeconds, secondsToH3Length } from "../lib/comfyui/h3-parameters.ts";
import { buildH3Workflow, parseComfyProgressMessage } from "../lib/comfyui/h3-adapter.ts";
import { buildReferenceWorkflow, buildSeedVR2Workflow } from "../lib/comfyui/extra-workflows.ts";
import { compileH3Prompt } from "../lib/comfyui/h3-prompt.ts";

const workflow = JSON.parse(await readFile(new URL("../lib/comfyui/h3-workflow.json", import.meta.url), "utf8"));
const required = {
  "6": "MiniMaxH3ImageToVideo",
  "10": "RandomNoise",
  "15": "SaveVideo",
  "20": "LoadImage",
  "25": "PrimitiveBoolean",
  "27": "PrimitiveInt",
};

for (const [id, classType] of Object.entries(required)) {
  assert.equal(workflow[id]?.class_type, classType, `节点 ${id} 缺失或类型不正确`);
}
assert.equal(workflow["6"].inputs.length, 141);
assert.equal(workflow["25"].inputs.value, true);
assert.equal(workflow["27"].inputs.value, 6);
assert.equal(workflow["28"].inputs.value, 20);
assert.equal(workflow["14"].inputs.fps, 24);
assert.equal(workflow["14"].inputs.bit_depth, 8);
assert.equal(workflow["14"].inputs.color_space, "sRGB");
assert.equal(workflow["15"].inputs.filename_prefix, "video/MiniMax_H3_i2v");

const copy = structuredClone(workflow);
copy["20"].inputs.image = "frameflow-test.png";
copy["6"].inputs.prompt = "test prompt";
copy["10"].inputs.noise_seed = 123456;
assert.equal(workflow["20"].inputs.image, "", "任务副本修改了原始模板");
assert.equal(workflow["6"].inputs.prompt, "", "任务副本修改了原始模板");
assert.notEqual(copy["10"].inputs.noise_seed, workflow["10"].inputs.noise_seed);

const durationCases = new Map([
  [3, 124],
  [5, 124],
  [5.5, 124],
  [5.875, 141],
  [8, 192],
  [10, 243],
  [12, 294],
  [15, 362],
  [20, 362],
]);
for (const [seconds, expectedLength] of durationCases) {
  assert.equal(secondsToH3Length(seconds), expectedLength, `${seconds} 秒映射错误`);
}
for (let length = H3_MIN_LENGTH; length <= H3_MAX_LENGTH; length += 17) {
  assert.equal((length - 5) % 17, 0, `${length} 不满足 17k+5`);
  assert.equal(getActualDuration(lengthToSeconds(length)).length, length);
}

assert.equal(H3_MAX_LENGTH, H3_LENGTH_OFFSET + Math.floor((H3_TRAINED_MAX_LENGTH_BOUND - H3_LENGTH_OFFSET) / H3_LENGTH_GRID) * H3_LENGTH_GRID);
assert.ok(H3_MAX_LENGTH <= H3_TRAINED_MAX_LENGTH_BOUND);
assert.ok(H3_MAX_LENGTH + H3_LENGTH_GRID > H3_TRAINED_MAX_LENGTH_BOUND);
assert.equal(H3_MAX_REQUESTED_SECONDS, 15);
assert.deepEqual(getActualDuration(15), { requestedSeconds: 15, length: 362, actualSeconds: 362 / 24 });

const injected = buildH3Workflow("dynamic-frame.png", "dynamic prompt", 987654, {
  length: 362,
  aspect: "16:9",
  megapixels: 1,
  turbo: false,
  steps: 20,
  fps: 30,
  loraStrength: 0.75,
  upscaleMethod: "bicubic",
  resolutionSteps: 64,
}, "dynamic-last-frame.png");
assert.equal(injected["20"].inputs.image, "dynamic-frame.png");
assert.equal(injected["6"].inputs.prompt, "dynamic prompt");
assert.equal(injected["6"].inputs.length, 362);
assert.equal(injected["10"].inputs.noise_seed, 987654);
assert.equal(injected["21"].inputs.megapixels, 1);
assert.equal(injected["21"].inputs.upscale_method, "bicubic");
assert.equal(injected["21"].inputs.resolution_steps, 64);
assert.deepEqual(injected["21"].inputs.image, ["32", 0]);
assert.equal(injected["5"].inputs.strength, 0.75);
assert.equal(injected["25"].inputs.value, false);
assert.equal(injected["28"].inputs.value, 20);
assert.equal(injected["14"].inputs.fps, 30);
assert.deepEqual([injected["32"].inputs.width, injected["32"].inputs.height, injected["32"].inputs.crop], [1024, 576, "center"]);
assert.equal(injected["33"].inputs.image, "dynamic-last-frame.png");
assert.deepEqual(injected["34"].inputs.image, ["33", 0]);
assert.deepEqual([injected["34"].inputs.width, injected["34"].inputs.height, injected["34"].inputs.crop], [["22", 0], ["22", 1], "center"]);
assert.deepEqual(injected["6"].inputs.last_frame, ["34", 0]);

const firstFrameOnly = buildH3Workflow("first-only.png", "prompt", 1);
assert.equal("last_frame" in firstFrameOnly["6"].inputs, false);
assert.equal(firstFrameOnly["33"], undefined);
const turboOn = buildH3Workflow("first.png", "prompt", 1, { length: 141, aspect: "follow", megapixels: .5, turbo: true, steps: 20, fps: 24, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32 });
const turboOff = buildH3Workflow("first.png", "prompt", 1, { length: 141, aspect: "follow", megapixels: .5, turbo: false, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32 });
assert.equal(turboOn["27"].inputs.value, 6);
assert.equal(turboOff["28"].inputs.value, 20);
const silent = buildH3Workflow("first.png", "prompt", 1, { length: 141, aspect: "follow", megapixels: .5, turbo: true, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32, soundMode: "silent" });
assert.equal("audio" in silent["14"].inputs, false);
const chinesePrompt = "镜头缓缓推近，猫咪抬头。";
assert.equal(compileH3Prompt(chinesePrompt, "av"), chinesePrompt);
assert.match(compileH3Prompt(chinesePrompt, "ambient"), /可听到的只有与画面同步的房间底噪和动作声/);
assert.equal(compileH3Prompt(chinesePrompt, "silent"), chinesePrompt);
assert.deepEqual(calculateH3Dimensions(1920, 1080, "follow", .5, 32), { width: 960, height: 544 });

const refSettings = { length: 141, aspect: "16:9", megapixels: .5, turbo: true, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32 };
const ref = buildReferenceWorkflow({ images: ["main.png", "secondary.webp"], videos: [], audios: ["voice.m4a"] }, chinesePrompt, 42, refSettings);
assert.equal(ref["136"].class_type, "MiniMaxH3ReferenceToVideo");
assert.equal(ref["138"].inputs.value, chinesePrompt);
assert.equal(ref["136"].inputs.length, 141);
assert.equal(ref["129"].inputs.noise_seed, 42);
assert.equal(ref["146"].inputs.value, true);
assert.equal(ref["144"].inputs.value, 4);
assert.equal(ref["143"].inputs.value, 20);
assert.equal(ref["ff-image-0"].inputs.image, "main.png");
assert.equal(ref["ff-image-1"].inputs.image, "secondary.webp");
assert.equal(ref["ff-audio-0"].inputs.audio, "voice.m4a");
assert.deepEqual(ref["136"].inputs["ref_images.ref_image_0"], ["ff-image-0", 0]);
assert.deepEqual(ref["136"].inputs["ref_audios.ref_audio_0"], ["ff-audio-0", 0]);
assert.equal(buildReferenceWorkflow({ images: ["main.png"], videos: ["reference.mp4"], audios: [] }, chinesePrompt, 42, { ...refSettings, turbo: false })["146"].inputs.value, false);
assert.equal(buildReferenceWorkflow({ images: ["main.png"], videos: ["reference.mp4"], audios: [] }, chinesePrompt, 42, refSettings)["136"].inputs["ref_video_audios.ref_video_audio_0"], undefined);
assert.deepEqual(buildReferenceWorkflow({ images: ["main.png"], videos: ["reference.mp4"], audios: [], videoAudioFlags: [true] }, chinesePrompt, 42, refSettings)["136"].inputs["ref_video_audios.ref_video_audio_0"], ["ff-video-components-0", 1]);
assert.equal(buildReferenceWorkflow({ images: ["main.png"], videos: [], audios: [] }, chinesePrompt, 42, { ...refSettings, soundMode: "silent" })["130"].inputs.audio, undefined);
const upscale = buildSeedVR2Workflow("source.mp4");
assert.equal(upscale["73"].inputs.file, "source.mp4");
assert.equal(upscale["66:52"].inputs.unet_name, "seedvr2_7b_sharp_int8_convrot.safetensors");
assert.equal(upscale["66:51"].inputs.vae_name, "seedvr2_ema_vae_fp16.safetensors");
assert.equal(upscale["66:57"].inputs["resize_type.multiplier"], 2);
assert.equal(upscale["66:105"].inputs.value, true);
assert.equal(upscale["66:81"].inputs.switch, false);
assert.deepEqual(upscale["66:75"].inputs.audio, ["66:74", 1]);
const clipped = buildSeedVR2Workflow("source.mp4", { clip: { start: 3, duration: 5 } });
assert.equal(clipped["66:81"].inputs.switch, true);
assert.equal(clipped["66:79"].inputs.start_time, 3);
assert.equal(clipped["66:79"].inputs.duration, 5);

assert.deepEqual(parseComfyProgressMessage({ type: "progress", data: { prompt_id: "job", node: "11", value: 43, max: 100 } }, "job"), { status: "running", percent: 43, stage: "H3 采样", step: 43, steps: 100 });
assert.deepEqual(parseComfyProgressMessage({ type: "execution_start", data: { prompt_id: "job" } }, "job"), { status: "loading", stage: "开始执行工作流" });
assert.deepEqual(parseComfyProgressMessage({ type: "executing", data: { prompt_id: "job", node: "14" } }, "job"), { status: "decoding", stage: "解码视频" });
assert.deepEqual(parseComfyProgressMessage({ type: "execution_interrupted", data: { prompt_id: "job" } }, "job"), { status: "cancelled", stage: "ComfyUI 已中断任务" });
assert.deepEqual(parseComfyProgressMessage({ type: "progress", data: { prompt_id: "ref", node: "125", value: 2, max: 4 } }, "ref", "125", "92"), { status: "running", percent: 50, stage: "H3 采样", step: 2, steps: 4 });
assert.deepEqual(parseComfyProgressMessage({ type: "executing", data: { prompt_id: "seed", node: "66:54" } }, "seed", "66:54", "76"), { status: "running", stage: "高清采样" });
assert.equal(parseComfyProgressMessage({ type: "progress", data: { prompt_id: "other", node: "11", value: 99, max: 100 } }, "job"), null);

console.log("H3 workflow, parameter injection and progress parsing assertions passed");
