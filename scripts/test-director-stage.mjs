import assert from "node:assert/strict";
import { databases } from "./fake-indexeddb.mjs";

// Director Stage data layer V0.1 on the shared in-memory IndexedDB double. A "refresh" is simulated
// by importing a fresh copy of the store module (new connection) over the same stored databases.
const load = (tag) => import(`../lib/director-stage/store.ts?${tag}`);
const store = await load("first");

// 1. Create a Scene.
const scene = await store.createScene({ name: "《这一笔》书房" });
assert.equal(scene.schemaVersion, 1);
assert.equal(scene.name, "《这一笔》书房");
assert.ok(scene.id && scene.createdAt > 0 && scene.updatedAt === scene.createdAt);
await assert.rejects(store.createScene({ name: "   " }), /场景数据不合法/);
await assert.rejects(store.createScene({ name: "x", extra: 1 }), /场景数据不合法/);

// 2. Create a Prop bound to the Scene; a missing Scene is refused.
const chair = await store.createProp({ sceneId: scene.id, name: "椅子", type: "chair" });
assert.equal(chair.sceneId, scene.id);
await assert.rejects(store.createProp({ sceneId: "no-such-scene", name: "桌子", type: "table" }), /场景不存在/);
assert.deepEqual((await store.listProps(scene.id)).map((prop) => prop.id), [chair.id]);

// 3. Two States of the same Scene.
const upright = await store.createSceneState({ sceneId: scene.id, name: "椅子立着", propChanges: [{ propId: chair.id, description: "立在书桌前" }] });
const fallen = await store.createSceneState({ sceneId: scene.id, name: "椅子倒地", propChanges: [{ propId: chair.id, description: "侧倒在地上" }] });
assert.deepEqual((await store.listSceneStates(scene.id)).map((state) => state.name).sort(), ["椅子倒地", "椅子立着"]);
const otherScene = await store.createScene({ name: "另一个空间" });
await assert.rejects(store.createSceneState({ sceneId: otherScene.id, name: "错绑", propChanges: [{ propId: chair.id, description: "" }] }), /不属于该场景/);
await assert.rejects(store.createSceneState({ sceneId: scene.id, name: "重复", propChanges: [{ propId: chair.id, description: "a" }, { propId: chair.id, description: "b" }] }), /出现多次/);

// Camera / Motion / ControlPackage CRUD.
const camera = await store.createCamera({ sceneId: scene.id, name: "主机位", note: "35mm 低机位" });
assert.equal(camera.note, "35mm 低机位");
const bareCamera = await store.createCamera({ sceneId: scene.id, name: "备用机位" });
assert.equal(bareCamera.note, undefined, "note is optional");
assert.equal((await store.updateCamera(bareCamera.id, { note: "手持" })).note, "手持");
await store.deleteCamera(bareCamera.id);
// Motion: keyframes given out of order are stored sorted by frame; duplicates / wrong target type are refused.
const motion = await store.createMotion({ sceneId: scene.id, name: "椅子倒下", targetType: "prop", targetId: chair.id, keyframes: [{ frame: 72, description: "倒地" }, { frame: 0, description: "立着" }, { frame: 36, description: "开始倾斜" }] });
assert.deepEqual(motion.keyframes.map((keyframe) => keyframe.frame), [0, 36, 72]);
assert.equal(motion.name, "椅子倒下"); assert.equal(motion.targetType, "prop");
await assert.rejects(store.createMotion({ sceneId: scene.id, name: "x", targetType: "prop", targetId: "nothing", keyframes: [] }), /动作目标不是该场景的道具/);
await assert.rejects(store.createMotion({ sceneId: scene.id, name: "x", targetType: "camera", targetId: chair.id, keyframes: [] }), /动作目标不是该场景的摄影机/);
await assert.rejects(store.createMotion({ sceneId: scene.id, name: "x", targetType: "prop", targetId: chair.id, keyframes: [{ frame: 10, description: "a" }, { frame: 10, description: "b" }] }), /重复帧 10/);
await assert.rejects(store.createMotion({ sceneId: scene.id, name: "x", targetType: "prop", targetId: chair.id, keyframes: [{ frame: -1, description: "a" }] }), /动作数据不合法/);
await assert.rejects(store.createMotion({ sceneId: scene.id, name: "x", targetType: "prop", targetId: chair.id, keyframes: [{ frame: 1.5, description: "a" }] }), /动作数据不合法/);
await assert.rejects(store.createMotion({ sceneId: scene.id, targetType: "prop", targetId: chair.id, keyframes: [] }), /动作数据不合法/, "name is required");
const cameraMove = await store.createMotion({ sceneId: scene.id, name: "推近", targetType: "camera", targetId: camera.id, keyframes: [{ frame: 0, description: "中景" }] });
const control = await store.createControlPackage({ sceneId: scene.id, name: "椅子参考", type: "reference", assetIds: ["asset-a", "asset-b"] });
assert.equal(control.name, "椅子参考");
for (const type of ["first_frame", "last_frame", "guide"]) assert.equal((await store.createControlPackage({ sceneId: scene.id, name: type, type, assetIds: [] })).type, type);
// 高级控制素材 V0.1 brought back depth / mask (+ object_id) as managed-only types; pose / lidar stay unknown.
for (const type of ["depth", "mask", "object_id"]) { const pack = await store.createControlPackage({ sceneId: scene.id, name: type, type, assetIds: [] }); assert.equal(pack.type, type); await store.deleteControlPackage(pack.id); }
for (const removed of ["pose", "lidar", "normal"]) await assert.rejects(store.createControlPackage({ sceneId: scene.id, name: "x", type: removed, assetIds: [] }), /控制素材包数据不合法/);
await assert.rejects(store.createControlPackage({ sceneId: scene.id, type: "guide", assetIds: [] }), /控制素材包数据不合法/, "name is required");
// 🧪 guide packages carry an optional anchorFrame (1…361); older packages without it stay valid.
const anchored = await store.createControlPackage({ sceneId: scene.id, name: "倒地锚点", type: "guide", assetIds: [], anchorFrame: 70 });
assert.equal(anchored.anchorFrame, 70);
assert.equal((await store.updateControlPackage(anchored.id, { anchorFrame: 110 })).anchorFrame, 110);
for (const bad of [0, 362, 70.5]) await assert.rejects(store.createControlPackage({ sceneId: scene.id, name: "x", type: "guide", assetIds: [], anchorFrame: bad }), /控制素材包数据不合法/);
for (const extra of await store.listControlPackages(scene.id)) if (extra.id !== control.id) await store.deleteControlPackage(extra.id);

// Asset rules per package type (kinds come from production-records; checked before writing).
const { controlPackageAssetProblem } = await import("../lib/director-stage/schema.ts");
const image = (assetId) => ({ assetId, kind: "image" });
assert.equal(controlPackageAssetProblem("first_frame", [image("i1")]), null);
assert.match(controlPackageAssetProblem("first_frame", [image("i1"), image("i2")]), /最多引用 1 个/);
assert.match(controlPackageAssetProblem("last_frame", [{ assetId: "v1", kind: "video" }]), /只能引用图片/);
assert.equal(controlPackageAssetProblem("guide", [image("i1"), { assetId: "v1", kind: "video" }]), null);
assert.match(controlPackageAssetProblem("guide", [{ assetId: "a1", kind: "audio" }]), /只能引用图片 \/ 视频/);
assert.equal(controlPackageAssetProblem("reference", [image("i1"), { assetId: "v1", kind: "video" }, { assetId: "a1", kind: "audio" }]), null);
assert.match(controlPackageAssetProblem("reference", [image("i1"), image("i1")]), /重复/);
assert.match(controlPackageAssetProblem("reference", [{ assetId: "gone", kind: null }]), /素材记录不存在：gone/);

// Update keeps identity fields; sceneId cannot be patched.
const renamed = await store.updateScene(scene.id, { name: "书房（夜）" });
assert.equal(renamed.createdAt, scene.createdAt);
const retyped = await store.updateProp(chair.id, { type: "office-chair" });
assert.equal(retyped.sceneId, scene.id);
await assert.rejects(store.updateProp(chair.id, { sceneId: otherScene.id }), /道具数据不合法/);
assert.equal((await store.updateControlPackage(control.id, { assetIds: ["asset-c"] })).assetIds[0], "asset-c");
assert.deepEqual((await store.updateMotion(motion.id, { keyframes: [{ frame: 96, description: "倒地静止" }, { frame: 0, description: "立着" }, { frame: 48, description: "慢慢倒下" }] })).keyframes.map((keyframe) => keyframe.frame), [0, 48, 96]);
await assert.rejects(store.updateMotion(motion.id, { keyframes: [{ frame: 5, description: "a" }, { frame: 5, description: "b" }] }), /重复帧 5/);
await assert.rejects(store.updateMotion(motion.id, { targetType: "camera" }), /动作目标不是该场景的摄影机/, "type must match the target");
assert.equal((await store.updateMotion(motion.id, { name: "椅子慢慢倒下" })).name, "椅子慢慢倒下");
assert.equal((await store.getMotion(motion.id)).keyframes.length, 3, "refused updates change nothing");

// 4. "Refresh": a new module instance reads the same data back.
const reloaded = await load("after-refresh");
assert.equal((await reloaded.getScene(scene.id))?.name, "书房（夜）");
assert.equal((await reloaded.getProp(chair.id))?.type, "office-chair");
assert.equal((await reloaded.listSceneStates(scene.id)).length, 2);
assert.equal((await reloaded.listCameras(scene.id)).length, 1);
assert.equal((await reloaded.listMotions(scene.id)).length, 2);
assert.deepEqual((await reloaded.getMotion(motion.id)).keyframes.map((keyframe) => keyframe.frame), [0, 48, 96]);
assert.equal((await reloaded.getControlPackage(control.id))?.type, "reference");
assert.equal((await reloaded.getCamera(camera.id))?.note, "35mm 低机位");
assert.equal((await reloaded.listScenes()).length, 2);

// Referenced Prop / Camera cannot be deleted; after removing references they can.
await assert.rejects(reloaded.deleteProp(chair.id), /仍被引用/);
await assert.rejects(reloaded.deleteCamera(camera.id), /仍被动作引用/);
await reloaded.deleteMotion(cameraMove.id);
await reloaded.deleteCamera(camera.id);
assert.equal(await reloaded.getCamera(camera.id), null);

// Deleting the Scene removes its children only; the other Scene stays.
const { deletedChildren } = await reloaded.deleteScene(scene.id);
assert.equal(deletedChildren, 5); // chair, 2 states, 1 motion, 1 control package
for (const list of [reloaded.listProps, reloaded.listSceneStates, reloaded.listMotions, reloaded.listControlPackages]) assert.equal((await list(scene.id)).length, 0);
assert.equal(await reloaded.getSceneState(upright.id), null);
assert.equal(await reloaded.getSceneState(fallen.id), null);
assert.equal((await reloaded.listScenes()).length, 1);
await assert.rejects(reloaded.deleteScene(scene.id), /场景不存在/);

// Only the Director Stage database was created.
assert.deepEqual([...databases.keys()], ["frameflow-director-stage"]);

console.log("Director Stage V0.1: Scene / Prop / two States / Camera / Motion / ControlPackage CRUD, scene binding, reference checks, refresh persistence, cascade delete passed");
