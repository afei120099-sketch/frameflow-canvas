import assert from "node:assert/strict";
import "./fake-indexeddb.mjs";
import { aspectRatio, DEFAULT_ROOM, defaultCameraTransform, defaultPropTransform, fitAspect, focalToVerticalFov, normalizeTransform } from "../lib/director-stage/whitebox.ts";

// 3D white-box stage V0.1-A: pure helpers + the optional Scene / Prop / Camera fields (no three.js needed).

// Focal length → vertical FOV (full-frame equivalent, 24 mm sensor height).
assert.equal(focalToVerticalFov(35), 37.85);
assert.equal(focalToVerticalFov(24), 53.13);
assert.ok(focalToVerticalFov(85) < focalToVerticalFov(35), "longer lens = narrower view");
assert.equal(aspectRatio("16:9"), 16 / 9);
assert.equal(aspectRatio("9:16"), 9 / 16);
assert.deepEqual(fitAspect(1000, 800, 9 / 16), { width: 450, height: 800 });
assert.deepEqual(fitAspect(1000, 800, 16 / 9), { width: 1000, height: 562 });

// Normalisation: mm / 0.1° precision, rotation wrapped into [−180, 180), scale floor.
assert.deepEqual(normalizeTransform({ position: [1.23456, 0, -2.0004], rotation: [370, -190, 45.04], scale: [0.0001, 2.5, 1] }), { position: [1.235, 0, -2], rotation: [10, 170, 45], scale: [0.01, 2.5, 1] });
assert.throws(() => normalizeTransform({ position: [Number.NaN, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }));

// Defaults: boxes stand on the floor, planes lie flat, cameras stand at eye height inside the room looking in (−Z).
const box = defaultPropTransform("box");
assert.equal(box.position[1], 0, "box origin is its bottom centre, standing on the floor");
assert.deepEqual(defaultPropTransform("plane").rotation, [-90, 0, 0]);
const cameraTransform = defaultCameraTransform(DEFAULT_ROOM);
assert.equal(cameraTransform.position[1], 1.5);
assert.ok(cameraTransform.position[2] < DEFAULT_ROOM.depth / 2, "inside the room");

const store = await import("../lib/director-stage/store.ts");
const scene = await store.createScene({ name: "白模书房" });
assert.equal(scene.room, undefined, "room is optional");
const withRoom = await store.updateScene(scene.id, { room: { width: 4, depth: 5, height: 2.8 } });
assert.deepEqual(withRoom.room, { width: 4, depth: 5, height: 2.8 });
await assert.rejects(store.updateScene(scene.id, { room: { width: 0.1, depth: 5, height: 2.8 } }), /场景数据不合法/);

// Old-style Props / Cameras (no 3D fields) stay valid and can be placed later.
const legacyProp = await store.createProp({ sceneId: scene.id, name: "椅子", type: "chair" });
assert.equal(legacyProp.geometry, undefined);
const placed = await store.updateProp(legacyProp.id, { geometry: "box", transform: defaultPropTransform("box") });
assert.equal(placed.geometry, "box"); assert.deepEqual(placed.transform, box);
const plane = await store.createProp({ sceneId: scene.id, name: "地毯", type: "plane", geometry: "plane", transform: defaultPropTransform("plane", 1) });
assert.equal(plane.geometry, "plane");
await assert.rejects(store.createProp({ sceneId: scene.id, name: "x", type: "x", geometry: "sphere", transform: box }), /道具数据不合法/);
await assert.rejects(store.updateProp(plane.id, { transform: { ...box, scale: [0, 1, 1] } }), /道具数据不合法/);
await assert.rejects(store.updateProp(plane.id, { transform: { ...box, position: [500, 0, 0] } }), /道具数据不合法/);

const camera = await store.createCamera({ sceneId: scene.id, name: "主机位", transform: cameraTransform, focalLength: 35, aspect: "9:16" });
assert.equal(camera.focalLength, 35); assert.equal(camera.aspect, "9:16");
const moved = await store.updateCamera(camera.id, { transform: normalizeTransform({ position: [0.5, 1.6, 2], rotation: [-5, 10, 0], scale: [1, 1, 1] }), focalLength: 50, aspect: "16:9" });
assert.deepEqual(moved.transform.rotation, [-5, 10, 0]); assert.equal(moved.focalLength, 50); assert.equal(moved.aspect, "16:9");
await assert.rejects(store.updateCamera(camera.id, { focalLength: 4 }), /摄影机数据不合法/);
await assert.rejects(store.updateCamera(camera.id, { aspect: "4:3" }), /摄影机数据不合法/);
const bareCamera = await store.createCamera({ sceneId: scene.id, name: "备用" });
assert.equal(bareCamera.transform, undefined, "camera 3D fields are optional");

// "Refresh": a new module instance reads the same 3D layout back.
const reloaded = await import("../lib/director-stage/store.ts?whitebox-refresh");
assert.deepEqual((await reloaded.getScene(scene.id)).room, { width: 4, depth: 5, height: 2.8 });
assert.deepEqual((await reloaded.getProp(legacyProp.id)).transform, box);
assert.equal((await reloaded.getCamera(camera.id)).focalLength, 50);

// Motions keep working against placed Props / Cameras.
const motion = await reloaded.createMotion({ sceneId: scene.id, name: "推近", targetType: "camera", targetId: camera.id, keyframes: [{ frame: 0, description: "中景" }] });
assert.equal(motion.targetId, camera.id);

console.log("Director Stage 3D white-box V0.1-A: FOV / aspect / normalisation helpers, defaults, optional room / geometry / transform / focal / aspect fields, limits, refresh persistence passed");
