import assert from "node:assert/strict";
import "./fake-indexeddb.mjs";
import { buildMotionExport, drivingMotion, isSpatialMotion, motionEndFrame, sampleMotion, shortestDelta, upsertKeyframe } from "../lib/director-stage/motion-anim.ts";
import * as store from "../lib/director-stage/store.ts";

// Motion V0.2 spatial animation: posed keyframes, interpolation, keyframe editing helpers, export
// preparation, storage + refresh, and old text-only Motions staying valid. No three.js, no Blender.

const pose = (rotationX, position = [0.8, 0, -1.2]) => ({ position, rotation: [rotationX, 25, 0], scale: [0.6, 1.0, 0.5] });
const close = (actual, expected, label) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `${label}[${index}]: ${value} vs ${expected[index]}`));

// The chair: f0 standing, f50 tilting, f100 lying on the floor; a text-only note at f24 does not take part.
const fall = [
  { frame: 0, description: "站立", transform: pose(0) },
  { frame: 24, description: "晃一下" },
  { frame: 50, description: "倾斜", transform: pose(-30) },
  { frame: 100, description: "倒地", transform: pose(-90, [0.8, 0, -0.7]) },
];
close(sampleMotion(fall, 0).rotation, [0, 25, 0], "f0");
close(sampleMotion(fall, 25).rotation, [-15, 25, 0], "f25");
close(sampleMotion(fall, 50).rotation, [-30, 25, 0], "f50");
close(sampleMotion(fall, 75).rotation, [-60, 25, 0], "f75");
close(sampleMotion(fall, 75).position, [0.8, 0, -0.95], "f75 position");
close(sampleMotion(fall, 87.5).rotation, [-75, 25, 0], "fractional frame");
close(sampleMotion(fall, -10).rotation, [0, 25, 0], "holds the first pose before it");
close(sampleMotion(fall, 500).rotation, [-90, 25, 0], "holds the last pose after it");
assert.equal(sampleMotion([{ frame: 0, description: "中景" }, { frame: 48, description: "近景" }], 10), null, "text-only Motion: no pose (text mode)");
// Rotation goes the shorter way round: 170° → −170° passes 180°, not 0°.
assert.equal(shortestDelta(170, -170), 20);
assert.equal(Math.abs(sampleMotion([{ frame: 0, description: "", transform: { ...pose(0), rotation: [0, 170, 0] } }, { frame: 10, description: "", transform: { ...pose(0), rotation: [0, -170, 0] } }], 5).rotation[1]), 180);

// Keyframe editing: add, update the pose (keeps the description), clear back to text, sorted.
let keyframes = upsertKeyframe([], 50, { description: "倾斜", transform: pose(-30) });
keyframes = upsertKeyframe(keyframes, 0, { description: "站立", transform: pose(0) });
assert.deepEqual(keyframes.map((keyframe) => keyframe.frame), [0, 50]);
keyframes = upsertKeyframe(keyframes, 50, { transform: pose(-35.04) });
assert.equal(keyframes[1].description, "倾斜", "a new pose keeps the description");
assert.equal(keyframes[1].transform.rotation[0], -35, "poses are normalised (0.1°)");
keyframes = upsertKeyframe(keyframes, 50, { transform: null });
assert.equal("transform" in keyframes[1], false, "cleared → text-only keyframe");
assert.equal(upsertKeyframe(keyframes, 10, { transform: { ...pose(0), scale: [0, 1, 1] } })[1].transform.scale[0], 0.01, "clamped like the stage's numeric fields");
assert.throws(() => upsertKeyframe(keyframes, 10, { transform: { ...pose(0), position: [Number.NaN, 0, 0] } }));

// Playback range and which Motion drives a target.
const motionA = { id: "a", sceneId: "s", name: "倒下", targetType: "prop", targetId: "chair", keyframes: fall };
const motionB = { id: "b", sceneId: "s", name: "只写了文字", targetType: "prop", targetId: "chair", keyframes: [{ frame: 200, description: "离开" }] };
const motionC = { id: "c", sceneId: "s", name: "另一种倒法", targetType: "prop", targetId: "chair", keyframes: [{ frame: 0, description: "", transform: pose(0) }, { frame: 60, description: "", transform: pose(90) }] };
assert.equal(motionEndFrame([motionA, motionB]), 100, "text-only keyframes do not extend playback");
assert.equal(isSpatialMotion(motionB), false);
assert.equal(drivingMotion([motionB, motionA, motionC], "chair")?.id, "a", "first posed Motion by default");
assert.equal(drivingMotion([motionB, motionA, motionC], "chair", "c")?.id, "c", "the Motion chosen in the stage");
assert.equal(drivingMotion([motionB, motionA, motionC], "chair", "b")?.id, "a", "a text-only choice cannot drive");

// Store: posed keyframes persist, survive a "refresh" (new module instance), old text-only Motions stay valid.
const scene = await store.createScene({ name: "椅子倒下" });
const chair = await store.createProp({ sceneId: scene.id, name: "椅子", type: "chair", geometry: "box", transform: pose(0) });
const camera = await store.createCamera({ sceneId: scene.id, name: "主机位", transform: { position: [0, 1.5, 2.2], rotation: [-8, 0, 0], scale: [1, 1, 1] }, focalLength: 35, aspect: "9:16" });
const legacy = await store.createMotion({ sceneId: scene.id, name: "推近（旧）", targetType: "camera", targetId: camera.id, keyframes: [{ frame: 48, description: "近景" }, { frame: 0, description: "中景" }] });
assert.deepEqual(legacy.keyframes, [{ frame: 0, description: "中景" }, { frame: 48, description: "近景" }], "V0.1 Motions unchanged");
const chairFall = await store.createMotion({ sceneId: scene.id, name: "椅子倒下", targetType: "prop", targetId: chair.id, keyframes: [fall[3], fall[0], fall[2]] });
assert.deepEqual(chairFall.keyframes.map((keyframe) => keyframe.frame), [0, 50, 100], "sorted");
await assert.rejects(store.updateMotion(chairFall.id, { keyframes: [{ frame: 0, description: "", transform: { ...pose(0), position: [999, 0, 0] } }] }), /动作数据不合法/);
await assert.rejects(store.updateMotion(chairFall.id, { keyframes: [{ frame: 0, description: "", transform: { position: [0, 0, 0] } }] }), /动作数据不合法/, "a pose needs position, rotation and scale");
// Panel edit of frame / description merges into the keyframe (the pose stays).
const edited = await store.updateMotion(chairFall.id, { keyframes: chairFall.keyframes.map((keyframe, at) => at === 1 ? { ...keyframe, ...{ frame: 50, description: "开始倾斜" } } : keyframe) });
assert.deepEqual(edited.keyframes[1].transform, pose(-30));
// Camera Motion with poses (camera scale stays 1).
await store.updateMotion(legacy.id, { keyframes: upsertKeyframe(legacy.keyframes, 48, { transform: { position: [0, 1.5, 1.2], rotation: [-5, 0, 0], scale: [1, 1, 1] } }) });

const reloaded = await import("../lib/director-stage/store.ts?motion-v2-refresh");
const motions = await reloaded.listMotions(scene.id);
const restoredFall = motions.find((motion) => motion.id === chairFall.id);
assert.deepEqual(restoredFall.keyframes.map((keyframe) => [keyframe.frame, keyframe.description, keyframe.transform.rotation[0]]), [[0, "站立", 0], [50, "开始倾斜", -30], [100, "倒地", -90]]);
assert.deepEqual(motions.find((motion) => motion.id === legacy.id).keyframes.map((keyframe) => Boolean(keyframe.transform)), [false, true], "mixed text / posed keyframes");

// Blender export preparation: posed tracks only, unwrapped rotations, seconds at 24 FPS.
const exported = buildMotionExport(await reloaded.getScene(scene.id), await reloaded.listProps(scene.id), await reloaded.listCameras(scene.id), [...motions, { ...motionB, id: "text-only", sceneId: scene.id, targetId: chair.id }]);
assert.equal(exported.format, "frameflow-motion-v1");
assert.equal(exported.fps, 24);
assert.equal(exported.endFrame, 100);
assert.deepEqual(exported.tracks.map((track) => [track.name, track.targetType, track.targetName, track.keyframes.length]).sort(), [["推近（旧）", "camera", "主机位", 1], ["椅子倒下", "prop", "椅子", 3]]);
assert.equal(exported.tracks.find((track) => track.targetType === "prop").geometry, "box");
assert.deepEqual(exported.tracks.find((track) => track.targetType === "prop").keyframes.map((keyframe) => keyframe.seconds), [0, 2.083, 4.167]);
assert.deepEqual(exported.textOnly.map((motion) => motion.name), ["只写了文字"]);
const spin = buildMotionExport(scene, [chair], [], [{ id: "spin", sceneId: scene.id, name: "转身", targetType: "prop", targetId: chair.id, keyframes: [170, -170, -10].map((y, index) => ({ frame: index * 10, description: "", transform: { ...pose(0), rotation: [0, y, 0] } })) }]);
assert.deepEqual(spin.tracks[0].keyframes.map((keyframe) => keyframe.transform.rotation[1]), [170, 190, 350], "unwrapped: a linear F-curve follows the preview's path");

console.log("Motion V0.2: chair f0 / f50 / f100 interpolation, holds, shorter-way rotation, text-only Motions untouched, keyframe upsert / clear, driving Motion, store + refresh persistence, pose validation, panel edits keep poses, export tracks (unwrapped, 24 FPS) passed");
