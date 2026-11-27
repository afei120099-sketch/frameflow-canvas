import assert from "node:assert/strict";
import { parseShotQueue } from "../lib/shot-queue.ts";
import { keyframeFluxPrompt, keyframeCount, shiftPictureTags } from "../lib/shot-queue-keyframe.ts";

const base = { title: "L01", prompt: "<Picture 1> is the office. 张三抬头。", roleIds: [], sceneAssetIds: ["scene"], seconds: 6, aspect: "9:16", soundMode: "ambient" };
const queue = (shots, defaults) => JSON.stringify({ version: "shot-queue-v1", title: "t", ...(defaults ? { defaults } : {}), chapters: [{ title: "c", shots }] });

// keyframe block survives parse (the parser builds shots field by field, so it must be listed explicitly).
const parsed = parseShotQueue(queue([{ ...base, keyframe: { prompt: "a man looks up, medium close-up", count: 2 } }], { keyframe: { look: "photoreal film grain", count: 4 } }));
assert.deepEqual(parsed.chapters[0].shots[0].keyframe, { prompt: "a man looks up, medium close-up", count: 2 });
assert.deepEqual(parsed.defaults.keyframe, { look: "photoreal film grain", count: 4 });
assert.equal(keyframeFluxPrompt(parsed.chapters[0].shots[0].keyframe, parsed.defaults.keyframe), "a man looks up, medium close-up, photoreal film grain");
assert.equal(keyframeCount({ prompt: "x" }, parsed.defaults.keyframe), 4);
// round trip: stringify → parse keeps it
assert.deepEqual(parseShotQueue(JSON.stringify(parsed)).chapters[0].shots[0].keyframe, parsed.chapters[0].shots[0].keyframe);

// no keyframe: nothing added
assert.equal(parseShotQueue(queue([base])).chapters[0].shots[0].keyframe, undefined);

// validation
assert.throws(() => parseShotQueue(queue([{ ...base, keyframe: { prompt: "" } }])), /keyframe.prompt/);
assert.throws(() => parseShotQueue(queue([{ ...base, keyframe: { prompt: "x", faceRoleId: "nobody" } }])), /faceRoleId/);
assert.throws(() => parseShotQueue(queue([{ ...base, keyframe: { prompt: "x", count: 9 } }])), /count/);
assert.throws(() => parseShotQueue(queue([{ ...base, keyframe: { prompt: "x", typo: 1 } }])), /多出：typo/);
// a chained shot already has its first frame
assert.throws(() => parseShotQueue(queue([base, { ...base, title: "L02", generationMode: "first-last", firstFrameFrom: { shot: "L01", frame: "last" }, keyframe: { prompt: "x" } }])), /接帧/);

// approved keyframe = static first frame in first-last mode, still parses with the keyframe block kept
const approved = parseShotQueue(queue([{ ...base, generationMode: "first-last", firstFrameAssetId: "kf-asset", keyframe: { prompt: "x" } }]));
assert.equal(approved.chapters[0].shots[0].firstFrameAssetId, "kf-asset");

// first frame takes Picture 1: tags move up by one
assert.equal(shiftPictureTags("<Picture 1> is the office; <Picture 2> is 张三"), "<Picture 2> is the office; <Picture 3> is 张三");

console.log("shot queue keyframe: ok");
