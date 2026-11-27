import assert from "node:assert/strict";
import { planH3Submission } from "../lib/comfyui/h3-adapter.ts";
import { parseShotQueue, planShotReferences, runChapterShots, shotQueueExample, shotQueueH3Props, SHOT_QUEUE_LOCK, SHOT_QUEUE_WORKFLOW } from "../lib/shot-queue.ts";

const sample = shotQueueExample();
sample.chapters[0].shots[0].roleIds = ["role-lin"];
sample.chapters[0].shots[0].sceneAssetIds = ["scene-door"];
const queue = parseShotQueue(JSON.stringify(sample));
assert.equal(queue.chapters[0].shots[0].aspect, "9:16");
assert.equal(queue.chapters[0].shots[0].soundMode, "av");

const roles = [{ roleId: "role-lin", displayName: "李四", primaryAppearanceAssetId: "face-lin" }];
const assets = new Map([
  ["face-lin", { assetId: "face-lin", kind: "image", storageReference: "image:face", filename: "lin.png" }],
  ["scene-door", { assetId: "scene-door", kind: "image", storageReference: "image:door", filename: "door.png" }],
]);
const plan = planShotReferences(queue.chapters[0].shots[0], roles, assets);
const props = shotQueueH3Props(queue.chapters[0].shots[0], plan);
assert.deepEqual(props.referenceImages.map((item) => item.name), ["door.png"]);
assert.deepEqual(props.roleIds, ["role-lin"]);
assert.equal(SHOT_QUEUE_WORKFLOW, "community-ultimate");
assert.equal(props.workflowOptionId, SHOT_QUEUE_WORKFLOW);
assert.equal(props.workflowLock, "queue-config-v2");
assert.equal(props.allReferenceMode, true);
assert.equal(props.promptMode, "plain");
assert.equal(props.generationCount, 1);
assert.equal(props.hybridLock, false);
assert.equal(props.ultimateKeyframes, false);
const planned = planH3Submission({
  workflowOptionId: props.workflowOptionId,
  taskMode: "ref2va",
  prompt: props.prompt,
  seed: 1,
  settings: { length: 141, aspect: "9:16", megapixels: 0.5, turbo: true, steps: 10, fps: 24, loraStrength: 0.75, upscaleMethod: "lanczos", resolutionSteps: 32, soundMode: "ambient" },
}, { references: { images: ["lin.png", "door.png"], videos: [], audios: [] } });
assert.equal(planned.taskMode, "ref2va");
assert.equal(planned.workflow["136"].class_type, "MiniMaxH3ReferenceToVideo");
assert.equal(Object.keys(planned.workflow["136"].inputs).filter((key) => key.startsWith("ref_images.")).length, 2);
assert.equal(planned.workflow["145"].inputs.strength_model, 0.75);
assert.equal(planned.workflow["136"].inputs.task_type, undefined);
assert.deepEqual(plan.pictures.map((item) => item.name), ["场景 door.png", "角色 李四"]);

assert.throws(() => parseShotQueue(JSON.stringify({ ...queue, chapters: [{ ...queue.chapters[0], shots: [{ ...queue.chapters[0].shots[0], mode: "i2va" }] }] })), /ref2va/);
assert.throws(() => parseShotQueue(JSON.stringify({ ...queue, chapters: [{ ...queue.chapters[0], shots: [{ ...queue.chapters[0].shots[0], promptMode: "official_structured" }] }] })), /普通提示词/);
assert.throws(() => parseShotQueue(JSON.stringify({ ...queue, chapters: [{ ...queue.chapters[0], shots: [{ ...queue.chapters[0].shots[0], aspect: "follow" }] }] })), /比例/);
const expandedShot = { ...queue.chapters[0].shots[0], prompt: "p".repeat(12000) };
const expandedQueue = { ...queue, chapters: [{ ...queue.chapters[0], shots: Array.from({ length: 20 }, () => expandedShot) }] };
assert.equal(parseShotQueue(JSON.stringify(expandedQueue)).chapters[0].shots.length, 20);
assert.equal(parseShotQueue(JSON.stringify(expandedQueue)).chapters[0].shots[0].prompt, expandedShot.prompt);
assert.equal(parseShotQueue(JSON.stringify({ ...queue, chapters: [{ ...queue.chapters[0], shots: Array.from({ length: 21 }, () => queue.chapters[0].shots[0]) }] })).chapters[0].shots.length, 21);
assert.throws(() => parseShotQueue(JSON.stringify({ ...queue, chapters: [{ ...queue.chapters[0], shots: [{ ...expandedShot, prompt: "p".repeat(12001) }] }] })), /12000/);
assert.throws(() => planShotReferences(queue.chapters[0].shots[0], roles, new Map([["face-lin", assets.get("face-lin")], ["scene-door", assets.get("face-lin")]])), /同一张/);

const calls = [];
const states = new Map();
const updates = [];
const nodeState = (status) => ({ busy: false, status, error: status === "failed" ? "采样失败" : "", taskMode: "ref2va", preflight: { ok: true, errors: [] }, generate: async () => { states.set(calls.at(-1), nodeState(status)); } });
const completedChapter = await runChapterShots([{ props }, { props }], {
  signal: new AbortController().signal,
  create: async () => { const id = `node-${calls.length + 1}`; calls.push(id); states.set(id, nodeState("completed")); return { id }; },
  read: (id) => states.get(id) ?? null,
  focus: () => {},
  onUpdate: (index, status) => updates.push([index, status]),
  wait: async () => {},
});
assert.equal(completedChapter, "completed");
assert.deepEqual(calls, ["node-1", "node-2"]);
assert.deepEqual(updates.filter((item) => item[1] === "completed").map((item) => item[0]), [0, 1]);

calls.length = 0;
updates.length = 0;
states.clear();
const failedChapter = await runChapterShots([{ props }, { props }], {
  signal: new AbortController().signal,
  create: async () => { const id = "bad"; calls.push(id); states.set(id, nodeState("failed")); return { id }; },
  read: (id) => states.get(id) ?? null,
  focus: () => {},
  onUpdate: (index, status) => updates.push([index, status]),
  wait: async () => {},
});
assert.equal(failedChapter, "failed");
assert.deepEqual(calls, ["bad"]);
assert.equal(updates.some((item) => item[0] === 1 && item[1] === "stopped"), true);

const stopped = new AbortController();
stopped.abort();
updates.length = 0;
const stoppedChapter = await runChapterShots([{ props }], {
  signal: stopped.signal,
  create: async () => { throw new Error("不应创建"); },
  read: () => null,
  focus: () => {},
  onUpdate: (index, status) => updates.push([index, status]),
  wait: async () => {},
});
assert.equal(stoppedChapter, "stopped");
assert.deepEqual(updates, [[0, "stopped"]]);

console.log("shot queue parse, picture order, ultimate Ref2VA lock, and chapter stop PASS");
