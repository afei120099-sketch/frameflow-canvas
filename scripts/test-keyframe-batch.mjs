import assert from "node:assert/strict";
import fs from "node:fs";
import { buildFluxDev, FLUX_PULID } from "../lib/comfyui/flux-dev.ts";
import { pixelCrop, SHEET_FACE_CLOSEUP, SHEET_FRONT_BODY } from "../lib/character-sheet-crop.ts";
import { KEYFRAME_IDENTITY_VERSION, buildIdentityPrompt, identityBodyDenoise, identityDispatch, identityFaceWeight, keyframeIdentityExample, parseKeyframeIdentity, planIdentityBatch } from "../lib/keyframe-identity.ts";
import { KEYFRAME_BATCH_LIMIT, KEYFRAME_BATCH_VERSION, KEYFRAME_FLUX, KEYFRAME_INPUT_CHAIN, KEYFRAME_INPUT_MASTER, KEYFRAME_STILL, buildKeyframePrompt, keyframeBatchExample, parseKeyframeBatch, planKeyframeChain, runKeyframeBatch } from "../lib/keyframe-batch.ts";

const edits = [
  { camera: "略俯，齐胸", pose: "双手自然下垂" },
  { camera: "平视", pose: "重心在右脚" },
  { camera: "略仰", pose: "抬头看向前方" },
];
const masterPlans = planKeyframeChain(edits);
const chainPlans = planKeyframeChain(edits, KEYFRAME_INPUT_CHAIN);
assert.equal(masterPlans.length, 3);
assert.equal(KEYFRAME_INPUT_MASTER, "master");
assert.deepEqual(masterPlans.map(plan => plan.mode), ["master", "master", "master"]);
assert.deepEqual(masterPlans.map(plan => plan.source), ["master", "master", "master"]);
assert.deepEqual(chainPlans.map(plan => plan.mode), ["chain", "chain", "chain"]);
assert.deepEqual(chainPlans.map(plan => plan.source), ["master", "previous", "previous"]);
assert.deepEqual(masterPlans.map(plan => plan.index), [0, 1, 2]);
assert.deepEqual(masterPlans.map(plan => plan.prompt), chainPlans.map(plan => plan.prompt));
assert.equal(KEYFRAME_STILL.width / KEYFRAME_STILL.height, 9 / 16);
assert.equal(KEYFRAME_STILL.width % 16, 0);
assert.equal(KEYFRAME_STILL.height % 16, 0);
for (const plan of masterPlans) {
  assert.match(plan.prompt, /画幅 9:16/);
  assert.match(plan.prompt, /动作开始前/);
  assert.match(plan.prompt, /机位高低和身体姿态/);
  assert.match(plan.prompt, /左右站位/);
  assert.match(plan.prompt, /衣服、道具保持原图/);
  assert.match(plan.prompt, new RegExp(plan.camera));
  assert.match(plan.prompt, new RegExp(plan.pose));
  assert.doesNotMatch(plan.prompt, /<\s*picture\b|\bpicture\s*(?:\d+|k)\b/i);
  assert.equal(plan.prompt.includes("firstFrameFrom"), false);
  assert.equal(plan.prompt.includes("generationMode"), false);
  assert.equal(plan.prompt.includes("timeAnchors"), false);
}

assert.throws(() => buildKeyframePrompt({ camera: "<Picture 1>", pose: "站着" }), /Picture/);
assert.throws(() => buildKeyframePrompt({ camera: "平视", pose: "Picture k" }), /Picture/);
assert.throws(() => buildKeyframePrompt({ camera: "  ", pose: "站着" }), /机位高低和身体姿态/);
const document = parseKeyframeBatch(keyframeBatchExample("asset-master"));
assert.equal(document.version, KEYFRAME_BATCH_VERSION);
assert.equal(document.masterAssetId, "asset-master");
assert.equal(document.mode, KEYFRAME_INPUT_MASTER);
assert.equal(document.denoise, KEYFRAME_FLUX.denoise);
assert.deepEqual(planKeyframeChain(document.frames).map(plan => plan.source), ["master", "master"]);
assert.deepEqual(planKeyframeChain(document.frames, document.mode).map(plan => plan.source), ["master", "master"]);
const legacy = parseKeyframeBatch(JSON.stringify({ version: KEYFRAME_BATCH_VERSION, masterAssetId: "legacy-master", frames: edits }));
assert.equal(legacy.mode, KEYFRAME_INPUT_MASTER);
assert.deepEqual(planKeyframeChain(legacy.frames, legacy.mode).map(plan => [plan.index, plan.source]), [[0, "master"], [1, "master"], [2, "master"]]);
const chainDocument = parseKeyframeBatch(JSON.stringify({ version: KEYFRAME_BATCH_VERSION, masterAssetId: "asset-master", mode: KEYFRAME_INPUT_CHAIN, frames: edits }));
assert.equal(chainDocument.mode, KEYFRAME_INPUT_CHAIN);
assert.deepEqual(planKeyframeChain(chainDocument.frames, chainDocument.mode).map(plan => plan.source), ["master", "previous", "previous"]);
assert.throws(() => parseKeyframeBatch("{"), /合法 JSON/);
assert.throws(() => parseKeyframeBatch(JSON.stringify({ version: "shot-queue-v1", chapters: [] })), /视频镜头队列/);
assert.throws(() => parseKeyframeBatch(JSON.stringify({ version: KEYFRAME_BATCH_VERSION, masterAssetId: "m", frames: [{ camera: "平视", pose: "站着" }], chapters: [] })), /不属于静帧表/);
assert.throws(() => parseKeyframeBatch(JSON.stringify({ version: KEYFRAME_BATCH_VERSION, masterAssetId: "m", frames: [{ camera: "<Picture 1>", pose: "站着" }] })), /Picture/);
assert.throws(() => parseKeyframeBatch(JSON.stringify({ version: KEYFRAME_BATCH_VERSION, masterAssetId: "m", denoise: 0, frames: [{ camera: "平视", pose: "站着" }] })), /denoise/);
assert.throws(() => parseKeyframeBatch(JSON.stringify({ version: KEYFRAME_BATCH_VERSION, masterAssetId: "m", mode: "parallel", frames: [{ camera: "平视", pose: "站着" }] })), /mode/);
assert.throws(() => planKeyframeChain([]), /至少写一张/);
assert.throws(() => planKeyframeChain(Array.from({ length: KEYFRAME_BATCH_LIMIT + 1 }, () => edits[0])), /一次最多/);

const graph = buildFluxDev({
  prompt: masterPlans[0].prompt,
  width: KEYFRAME_STILL.width,
  height: KEYFRAME_STILL.height,
  seed: 1,
  steps: KEYFRAME_FLUX.steps,
  guidance: KEYFRAME_FLUX.guidance,
  sampler: KEYFRAME_FLUX.sampler,
  scheduler: KEYFRAME_FLUX.scheduler,
  denoise: KEYFRAME_FLUX.denoise,
  imageName: "master.png",
});
assert.equal(graph["3"].class_type, "VAEEncode");
assert.equal(graph["8"].class_type, "LoadImage");
assert.equal(graph["9"].inputs.width, 864);
assert.equal(graph["9"].inputs.height, 1536);
assert.equal(graph["5"].inputs.denoise, KEYFRAME_FLUX.denoise);
assert.equal(graph["15"], undefined);
assert.equal(graph["2"].inputs.text, masterPlans[0].prompt);

const still = (index, promptId) => ({ assetId: `asset-${index}`, src: `image:${index}`, filename: `k${index}.png`, promptId });
const master = { assetId: "master", src: "image:master" };

const sources = [];
let flight = 0;
let maxFlight = 0;
const completed = await runKeyframeBatch(chainPlans, {
  signal: new AbortController().signal,
  master,
  submit: async (step, source, receipt) => {
    flight += 1;
    maxFlight = Math.max(maxFlight, flight);
    sources.push([step.index, source.assetId, source.src]);
    assert.equal(step.source, step.index === 0 ? "master" : "previous");
    receipt.onAccepted(`prompt-${step.index}`);
    flight -= 1;
    return still(step.index, `prompt-${step.index}`);
  },
  onUpdate: () => {},
});
assert.equal(completed, "completed");
assert.equal(maxFlight, 1);
assert.deepEqual(sources, [[0, "master", "image:master"], [1, "asset-0", "image:0"], [2, "asset-1", "image:1"]]);

const masterSources = [];
const masterCompleted = await runKeyframeBatch(masterPlans, {
  signal: new AbortController().signal,
  master,
  submit: async (step, source, receipt) => {
    masterSources.push([step.index, source.assetId, source.src, step.prompt]);
    assert.equal(step.mode, KEYFRAME_INPUT_MASTER);
    assert.equal(step.source, "master");
    receipt.onAccepted(`master-prompt-${step.index}`);
    return still(step.index, `master-prompt-${step.index}`);
  },
  onUpdate: () => {},
});
assert.equal(masterCompleted, "completed");
assert.deepEqual(masterSources.map(item => item.slice(0, 3)), [
  [0, "master", "image:master"],
  [1, "master", "image:master"],
  [2, "master", "image:master"],
]);
assert.equal(new Set(masterSources.map(item => item[3])).size, 3);

let started = 0;
let release = () => {};
const gate = new Promise((resolve) => { release = resolve; });
const gated = runKeyframeBatch(chainPlans.slice(0, 2), {
  signal: new AbortController().signal,
  master,
  submit: async (step, _source, receipt) => {
    started += 1;
    if (step.index === 0) await gate;
    receipt.onAccepted(`prompt-${step.index}`);
    return still(step.index, `prompt-${step.index}`);
  },
  onUpdate: () => {},
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(started, 1);
await assert.rejects(runKeyframeBatch(chainPlans.slice(0, 1), {
  signal: new AbortController().signal,
  master,
  submit: async () => { throw new Error("第二批不应入队"); },
  onUpdate: () => {},
}), /等这一批停下/);
release();
assert.equal(await gated, "completed");
assert.equal(started, 2);

const failedUpdates = [];
let failedCalls = 0;
const failed = await runKeyframeBatch(chainPlans, {
  signal: new AbortController().signal,
  master,
  submit: async (step, _source, receipt) => {
    failedCalls += 1;
    if (step.index === 1) throw new Error("采样失败");
    receipt.onAccepted(`prompt-${step.index}`);
    return still(step.index, `prompt-${step.index}`);
  },
  onUpdate: (index, status) => failedUpdates.push([index, status]),
});
assert.equal(failed, "failed");
assert.equal(failedCalls, 2);
assert.deepEqual(failedUpdates.filter((item) => item[1] === "stopped").map((item) => item[0]), [2]);
assert.equal(failedUpdates.some((item) => item[0] === 1 && item[1] === "failed"), true);

const uncertainUpdates = [];
let uncertainCalls = 0;
const uncertain = await runKeyframeBatch(chainPlans, {
  signal: new AbortController().signal,
  master,
  submit: async (step, _source, receipt) => {
    uncertainCalls += 1;
    receipt.onReserved?.(`reserved-${step.index}`);
    throw new Error("提交状态待确认");
  },
  onUpdate: (index, status) => uncertainUpdates.push([index, status]),
});
assert.equal(uncertain, "unconfirmed");
assert.equal(uncertainCalls, 1);
assert.deepEqual(uncertainUpdates.filter((item) => item[1] === "stopped").map((item) => item[0]), [1, 2]);
assert.equal(uncertainUpdates.some((item) => item[0] === 0 && item[1] === "unconfirmed"), true);

const controller = new AbortController();
let stoppedCalls = 0;
const stopped = await runKeyframeBatch(chainPlans, {
  signal: controller.signal,
  master,
  submit: async (step, _source, receipt) => {
    stoppedCalls += 1;
    receipt.onAccepted(`prompt-${step.index}`);
    return still(step.index, `prompt-${step.index}`);
  },
  onUpdate: (index, status) => { if (index === 0 && status === "completed") controller.abort(); },
});
assert.equal(stopped, "stopped");
assert.equal(stoppedCalls, 1);

const aborted = new AbortController();
aborted.abort();
let abortedCalls = 0;
assert.equal(await runKeyframeBatch(chainPlans, {
  signal: aborted.signal,
  master,
  submit: async () => { abortedCalls += 1; throw new Error("不应入队"); },
  onUpdate: () => {},
}), "stopped");
assert.equal(abortedCalls, 0);

await assert.rejects(runKeyframeBatch([{ ...masterPlans[0], source: "previous" }], {
  signal: new AbortController().signal,
  master,
  submit: async () => { throw new Error("不应入队"); },
  onUpdate: () => {},
}), /原始母版/);
await assert.rejects(runKeyframeBatch([chainPlans[0], { ...chainPlans[1], source: "master" }], {
  signal: new AbortController().signal,
  master,
  submit: async () => { throw new Error("不应入队"); },
  onUpdate: () => {},
}), /第 1 张改母版/);

let reused = 0;
assert.equal(await runKeyframeBatch(masterPlans.slice(0, 1), {
  signal: new AbortController().signal,
  master,
  submit: async (_step, _source, receipt) => {
    reused += 1;
    receipt.onAccepted("prompt-same");
    return { assetId: master.assetId, src: "image:new", filename: "same.png", promptId: "prompt-same" };
  },
  onUpdate: () => {},
}), "unconfirmed");
assert.equal(reused, 1);

for (const file of ["lib/keyframe-batch.ts", "components/keyframe-batch-panel.tsx"]) {
  const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  for (const banned of ["firstFrameFrom", "generationMode", "timeAnchors", "_queue.json", "<Picture", 'from "@/lib/shot-queue"', "from '@/lib/shot-queue'"]) {
    assert.equal(text.includes(banned), false, `${file} 不应包含 ${banned}`);
  }
}
const panelText = fs.readFileSync(new URL("../components/keyframe-batch-panel.tsx", import.meta.url), "utf8");
assert.match(panelText, /原始母版（默认）/);
assert.match(panelText, /连续递进/);
assert.match(panelText, /planKeyframeChain\(doc\.frames, doc\.mode\)/);
assert.match(panelText, /getLocalImageBlob\(source\.src\)/);

const identity = parseKeyframeIdentity(keyframeIdentityExample("sheet-1", "role-1"));
assert.equal(identity.version, KEYFRAME_IDENTITY_VERSION);
assert.equal(identity.mode, KEYFRAME_INPUT_MASTER);
assert.equal(identity.cropsConfirmed, false);
assert.throws(() => planIdentityBatch(identity), /确认/);
const ready = parseKeyframeIdentity(JSON.stringify({ ...identity, cropsConfirmed: true, faceReferenceAssetId: "face-1", bodyReferenceAssetId: "body-1" }));
const identityPlans = planIdentityBatch(ready);
assert.deepEqual(identityPlans.map(plan => plan.source), ["master", "master", "master", "master", "master"]);
assert.deepEqual(identityPlans.map(plan => plan.shotId), ["shot-front", "shot-left", "shot-right", "shot-low", "shot-high"]);
for (const plan of identityPlans) {
  assert.match(plan.prompt, /只有一个人物/);
  assert.match(plan.prompt, /不要四格分镜/);
  assert.match(plan.prompt, /固定服装/);
  assert.match(plan.prompt, new RegExp(plan.cameraAngle));
  assert.match(plan.prompt, new RegExp(plan.shotSize));
  assert.equal(plan.faceReferenceAssetId, "face-1");
  assert.equal(plan.bodyReferenceAssetId, "body-1");
}
assert.throws(() => planIdentityBatch({ ...ready, faceReferenceAssetId: "sheet-1" }), /四格设定图不能当作生成底图/);
assert.throws(() => parseKeyframeIdentity(JSON.stringify({ ...identity, chapters: [] })), /不属于身份关键帧表/);
assert.equal(identityDispatch({ promptId: "prompt-1", assetId: "", index: 0, shotId: "s", seed: 1, status: "running" }, 0, 2), "poll");
assert.equal(identityDispatch({ promptId: "", assetId: "", index: 0, shotId: "s", seed: 1, status: "failed" }, 0, 2), "submit");
assert.equal(identityDispatch({ promptId: "", assetId: "", index: 0, shotId: "s", seed: 1, status: "failed" }, 2, 2), "stop");
assert.equal(identityDispatch({ promptId: "", assetId: "asset-1", index: 0, shotId: "s", seed: 1, status: "completed" }, 0, 2), "done");
const face = pixelCrop(832, 1248, SHEET_FACE_CLOSEUP);
const body = pixelCrop(832, 1248, SHEET_FRONT_BODY);
assert.deepEqual(body, { x: 0, y: 0, width: 416, height: 624 });
assert.deepEqual(face, { x: 416, y: 624, width: 416, height: 624 });
assert.throws(() => pixelCrop(832, 1248, { x: 0.8, y: 0.8, width: 0.5, height: 0.5 }), /超出画面/);
const identityPrompt = buildIdentityPrompt(ready, ready.frames[0]);
const identityGraph = buildFluxDev({ prompt: identityPrompt, width: KEYFRAME_STILL.width, height: KEYFRAME_STILL.height, seed: 7, denoise: 1, faceImageName: "face.png" });
assert.equal(identityGraph["3"].class_type, "EmptySD3LatentImage");
assert.equal(identityGraph["8"], undefined);
assert.equal(identityGraph["31"].inputs.provider, "CPU");
assert.equal(identityGraph["30"].inputs.pulid_file, FLUX_PULID.file);
assert.equal(identityFaceWeight("正面平视"), 0.85);
assert.equal(identityFaceWeight("高机位俯拍"), 0.75);
assert.equal(identityFaceWeight("低机位仰拍"), 0.5);
assert.equal(identityGraph["34"].inputs.weight, 0.85);
assert.equal(identityGraph["34"].class_type, "ApplyPulidFlux");
assert.match(identityPlans.find(plan => plan.shotId === "shot-high").prompt, /Extreme high-angle/);
assert.deepEqual(identityGraph["5"].inputs.model, ["34", 0]);
assert.deepEqual(identityGraph["34"].inputs.model, ["1", 0]);
assert.equal(identityGraph["26"], undefined, "no extra LoRA loader");
const chained = buildFluxDev({ prompt: identityPrompt, width: KEYFRAME_STILL.width, height: KEYFRAME_STILL.height, seed: 7, denoise: 0.8, imageName: "previous.png", faceImageName: "face.png" });
assert.equal(chained["3"].class_type, "VAEEncode");
assert.equal(chained["33"].class_type, "LoadImage");
assert.equal(chained["33"].inputs.image, "face.png");
assert.equal(chained["8"].inputs.image, "previous.png");
assert.equal(identityBodyDenoise("正面平视"), 0.72);
assert.equal(identityBodyDenoise("高机位俯拍"), 1);
const bodyGraph = buildFluxDev({ prompt: identityPrompt, width: KEYFRAME_STILL.width, height: KEYFRAME_STILL.height, seed: 7, denoise: 0.72, faceImageName: "face.png", bodyImageName: "body.png" });
assert.equal(bodyGraph["3"].class_type, "VAEEncode");
assert.equal(bodyGraph["35"].inputs.image, "body.png");
assert.equal(bodyGraph["8"], undefined);
assert.equal(bodyGraph["5"].inputs.denoise, 0.72);
const chainBeatsBody = buildFluxDev({ prompt: identityPrompt, width: KEYFRAME_STILL.width, height: KEYFRAME_STILL.height, seed: 7, denoise: 0.8, imageName: "previous.png", faceImageName: "face.png", bodyImageName: "body.png" });
assert.equal(chainBeatsBody["8"].inputs.image, "previous.png");
assert.equal(chainBeatsBody["35"], undefined);

console.log("keyframe batch ok");
