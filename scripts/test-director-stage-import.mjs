import assert from "node:assert/strict";
import * as THREE from "three";
import "./fake-indexeddb.mjs";
import { DIRECTOR_STAGE_EXAMPLE, DIRECTOR_STAGE_GUIDE } from "../lib/director-stage/import-guide.ts";
import { describeImportPlan, exportDirectorStage, findConflicts, lookAtRotation, parseDirectorStageText, planDirectorStageImport, validateDirectorStageDocument } from "../lib/director-stage/import-format.ts";
import * as store from "../lib/director-stage/store.ts";

// 导演台 JSON 导入 / 导出：说明里的示例能导入、导出再导入一致、错误能用中文报出来、覆盖不留孤立数据、撤销能恢复。

const loadAll = async () => Promise.all((await store.listScenes()).map(async (scene) => ({ scene, props: await store.listProps(scene.id), states: await store.listSceneStates(scene.id), cameras: await store.listCameras(scene.id), motions: await store.listMotions(scene.id), packages: await store.listControlPackages(scene.id) })));
const strip = (rows) => rows.map(({ createdAt, updatedAt, ...rest }) => rest);
const validate = (doc, assets) => validateDirectorStageDocument(JSON.parse(JSON.stringify(doc)), assets);
const errorsOf = (doc, assets) => { const result = validate(doc, assets); assert.equal(result.ok, false, "should be refused"); return result.errors.join("\n"); };
const clone = (value) => JSON.parse(JSON.stringify(value));

// 1. lookAt → rotation matches three.js camera.lookAt (camera looks down −Z, no roll).
for (const [eye, target] of [[[0, 1.5, 2.2], [0, 0.9, -1.4]], [[1.5, 1.25, -0.6], [0, 1, -1.2]], [[-1, 0.4, 1], [1, 1.6, -2]], [[0, 1, 0], [0, 1, 3]], [[2, 1, 0], [-2, 1, 0]]]) {
  const rotation = lookAtRotation(eye, target);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(...eye); camera.lookAt(new THREE.Vector3(...target));
  const wanted = new THREE.Vector3(...target).sub(new THREE.Vector3(...eye)).normalize();
  const object = new THREE.Object3D(); object.rotation.set(...rotation.map((d) => (d * Math.PI) / 180));
  const forward = new THREE.Vector3(0, 0, -1).applyEuler(object.rotation);
  assert.ok(forward.distanceTo(wanted) < 0.005, `lookAt ${eye}→${target}: forward ${forward.toArray()} vs ${wanted.toArray()}`);
  const up = new THREE.Vector3(0, 1, 0).applyEuler(object.rotation);
  assert.ok(Math.abs(new THREE.Vector3(1, 0, 0).applyEuler(object.rotation).y) < 0.005, "no roll: camera right axis stays level");
  assert.ok(up.y > 0, "camera stays upright");
  assert.ok(new THREE.Euler(...rotation.map((d) => (d * Math.PI) / 180)).toArray().slice(0, 3).every((v, i) => Math.abs(v - camera.rotation.toArray()[i]) < 0.005), "same Euler as three.js");
}
assert.equal(lookAtRotation([0, 1, 0], [0, 1, 0]), null);
assert.equal(lookAtRotation([0, 1, 0], [0, 3, 0]), null, "straight up is refused");

// 2. The guide's rotation-sign statements are true in three.js.
const turn = (rotation, vector) => new THREE.Vector3(...vector).applyEuler(new THREE.Euler(...rotation.map((d) => (d * Math.PI) / 180)));
assert.ok(turn([0, 90, 0], [0, 0, -1]).distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-6, "Y +90: facing −z → −x");
assert.ok(turn([0, 0, 30], [0, 1, 0]).x < 0, "Z positive tips toward −x");
assert.ok(turn([30, 0, 0], [0, 1, 0]).z > 0, "X positive tips the top toward +z");
assert.ok(turn([-90, 0, 0], [0, 0, 1]).distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6, "plane at [-90,0,0] faces up");
assert.ok(turn([0, 90, 0], [0, 0, 1]).distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-6, "plane at [0,90,0] faces +x (left wall)");
assert.ok(DIRECTOR_STAGE_GUIDE.includes("director-stage-v1") && DIRECTOR_STAGE_GUIDE.includes("\"书房\""), "guide carries the example");
// The JSON block inside the guide parses to exactly the exported example.
const block = DIRECTOR_STAGE_GUIDE.split("```json\n")[1].split("\n```")[0];
assert.deepEqual(JSON.parse(block), DIRECTOR_STAGE_EXAMPLE);

// 3. The guide's example validates and imports.
const example = validate(DIRECTOR_STAGE_EXAMPLE, new Map());
assert.equal(example.ok, true, example.ok ? "" : example.errors.join("\n"));
const parsedText = parseDirectorStageText("```json\n" + JSON.stringify(DIRECTOR_STAGE_EXAMPLE) + "\n```");
assert.equal(parsedText.ok, true, "a ```json fence is accepted");
let counter = 0;
const newId = () => `id-${++counter}`;
const plan = planDirectorStageImport(example.document, await loadAll(), {}, { now: 1000, newId });
assert.equal(plan.items.length, 1);
assert.equal(plan.items[0].action, "create");
assert.match(describeImportPlan(plan)[0], /新建场景“书房”：4 个道具、2 个状态、2 台摄影机、2 个动作、1 个控制素材包/);
await store.writeSceneBundles(plan.items.map((item) => item.bundle));
let all = await loadAll();
assert.equal(all.length, 1);
const study = all[0];
assert.equal(study.scene.name, "书房");
assert.deepEqual(study.scene.room, { width: 4, depth: 5, height: 2.8 });
assert.deepEqual(study.props.map((prop) => prop.name), ["书桌", "椅子", "书架", "地毯"]);
const rug = study.props.find((prop) => prop.name === "地毯");
assert.equal(rug.geometry, "plane");
assert.deepEqual(rug.transform, { position: [0, 0.005, -0.9], rotation: [-90, 0, 0], scale: [2, 1.6, 1] });
const main = study.cameras.find((camera) => camera.name === "主机位");
assert.equal(main.focalLength, 24); assert.equal(main.aspect, "9:16");
assert.deepEqual(main.transform.rotation, lookAtRotation([0, 1.5, 2.2], [0, 0.9, -1.4]));
const messy = study.states.find((state) => state.name === "被翻乱");
assert.deepEqual(messy.propChanges.map((change) => study.props.find((prop) => prop.id === change.propId).name), ["椅子", "书架"]);
const fall = study.motions.find((motion) => motion.name === "椅子倒下");
assert.equal(fall.targetType, "prop"); assert.equal(fall.targetId, study.props.find((prop) => prop.name === "椅子").id);
assert.deepEqual(fall.keyframes.map((keyframe) => keyframe.frame), [0, 18, 36]);
assert.deepEqual(fall.keyframes[0].transform.scale, [0.45, 0.9, 0.45], "a prop pose without size uses the prop's size");
const push = study.motions.find((motion) => motion.name === "主机位慢推");
assert.equal(push.targetId, main.id); assert.deepEqual(push.keyframes[1].transform.scale, [1, 1, 1]);
assert.equal(study.packages.length, 1);

// 4. Export → import (overwrite) keeps every record and every ID.
const exported = exportDirectorStage(all);
assert.deepEqual(exported.notes, []);
assert.equal(exported.document.scenes[0].id, study.scene.id);
const reparsed = validate(exported.document, new Map());
assert.equal(reparsed.ok, true, reparsed.ok ? "" : reparsed.errors.join("\n"));
const conflicts = findConflicts(reparsed.document, all);
assert.deepEqual(conflicts.map((item) => item.name), ["书房"]);
const before = clone(all);
const roundTrip = planDirectorStageImport(reparsed.document, all, { 书房: "overwrite" }, { now: 2000, newId });
assert.equal(roundTrip.items[0].action, "overwrite");
assert.deepEqual(roundTrip.items[0].removed, []);
await store.writeSceneBundles(roundTrip.items.map((item) => item.bundle));
all = await loadAll();
for (const key of ["props", "states", "cameras", "motions", "packages"]) assert.deepEqual(strip(all[0][key]), strip(before[0][key]), `${key} unchanged after export → import`);
assert.deepEqual(strip([all[0].scene]), strip([before[0].scene]));
assert.equal(all[0].props[0].createdAt, before[0].props[0].createdAt, "createdAt kept");
// Export of the re-imported data is identical again.
assert.deepEqual(exportDirectorStage(all).document, exported.document);

// 5. Overwrite with changes: renamed record matched by id, missing ones removed (no orphans), generated packages kept.
const generated = await store.createControlPackage({ sceneId: study.scene.id, name: "白模首帧 · 主机位", type: "first_frame", assetIds: [], render: { pass: "rgb", groupId: "g1", sceneId: study.scene.id, cameraId: main.id, sourceObjects: [], includesRoom: true, renderedAt: 5, width: 9, height: 16, engine: "e", blenderVersion: "4" } });
all = await loadAll();
const edited = clone(exportDirectorStage(all).document);
assert.equal(edited.scenes[0].controlPackages.length, 1, "generated packages are not exported");
edited.scenes[0].props = edited.scenes[0].props.filter((prop) => prop.name !== "地毯");
edited.scenes[0].props.find((prop) => prop.name === "书桌").name = "大书桌";
edited.scenes[0].cameras = edited.scenes[0].cameras.filter((camera) => camera.name !== "侧机位");
edited.scenes[0].states = [edited.scenes[0].states[0]];
const editedValid = validate(edited, new Map());
assert.equal(editedValid.ok, true, editedValid.ok ? "" : editedValid.errors.join("\n"));
const desk = all[0].props.find((prop) => prop.name === "书桌");
const side = all[0].cameras.find((camera) => camera.name === "侧机位");
const overwrite = planDirectorStageImport(editedValid.document, all, { 书房: "overwrite" }, { now: 3000, newId, shots: [{ label: "镜头 01", sceneId: study.scene.id, ids: [side.id] }] });
const item = overwrite.items[0];
assert.deepEqual(item.removed.sort(), ["摄影机“侧机位”", "状态“被翻乱”", "道具“地毯”"].sort());
assert.equal(item.keptGenerated, 1);
assert.ok(overwrite.warnings.some((warning) => warning.includes("镜头 01")), "warns about a Shot bound to a removed camera");
assert.match(describeImportPlan(overwrite).join("\n"), /覆盖场景“书房”.*会删掉/);
await store.writeSceneBundles(overwrite.items.map((entry) => entry.bundle));
all = await loadAll();
assert.equal(all[0].props.find((prop) => prop.name === "大书桌").id, desk.id, "renamed prop keeps its id");
assert.equal(all[0].props.some((prop) => prop.name === "地毯"), false);
assert.equal(all[0].cameras.length, 1);
assert.ok(all[0].packages.some((pack) => pack.id === generated.id), "generated package kept");
// 6. Undo restores the scene exactly.
await store.writeSceneBundles(overwrite.items.map((entry) => entry.previous));
all = await loadAll();
assert.deepEqual(all[0].props.map((prop) => prop.name), ["书桌", "椅子", "书架", "地毯"]);
assert.equal(all[0].cameras.length, 2); assert.equal(all[0].states.length, 2);

// 7. Same name, "copy": a new scene with new IDs; the original untouched. Undo of a created scene removes it with all children.
const copy = planDirectorStageImport(example.document, all, { 书房: "copy" }, { now: 4000, newId });
assert.equal(copy.items[0].action, "copy");
assert.equal(copy.items[0].finalName, "书房（导入 2）");
await store.writeSceneBundles(copy.items.map((entry) => entry.bundle));
all = await loadAll();
assert.equal(all.length, 2);
const copied = all.find((entry) => entry.scene.name === "书房（导入 2）");
assert.ok(copied.props.every((prop) => !all.find((entry) => entry.scene.name === "书房").props.some((other) => other.id === prop.id)));
await store.writeSceneBundles([], [copied.scene.id]);
all = await loadAll();
assert.equal(all.length, 1);
for (const kind of ["listProps", "listSceneStates", "listCameras", "listMotions", "listControlPackages"]) assert.deepEqual(await store[kind](copied.scene.id), [], `${kind}: no orphans after undo`);
// IDs from the JSON that belong to another scene are never reused for a new scene.
const foreign = clone(exportDirectorStage(all).document);
foreign.scenes[0].name = "另一个书房"; delete foreign.scenes[0].id;
const foreignPlan = planDirectorStageImport(validate(foreign, new Map()).document, all, {}, { now: 5000, newId });
assert.equal(foreignPlan.items[0].action, "create");
assert.ok(foreignPlan.items[0].bundle.props.every((prop) => prop.id.startsWith("id-")), "fresh IDs for a new scene");
// The store itself refuses a bundle that would steal another scene's record.
const stolen = clone(foreignPlan.items[0].bundle); stolen.props[0].id = all[0].props[0].id;
await assert.rejects(store.writeSceneBundles([stolen]), /已属于另一个场景/);
assert.equal((await loadAll()).length, 1, "nothing written on refusal");
const broken = clone(foreignPlan.items[0].bundle); broken.states[0].propChanges[0].propId = "nope";
await assert.rejects(store.writeSceneBundles([broken]), /不属于该场景/);

// 8. Errors are reported in Chinese with where + field + how to fix.
const base = () => clone(DIRECTOR_STAGE_EXAMPLE);
const cases = [
  [(doc) => { doc.version = "v1"; }, /version 必须写 "director-stage-v1"/],
  [(doc) => { doc.scenes = []; }, /至少写一个场景/],
  [(doc) => { doc.scenes[0].props[0].position = [0, 0]; }, /道具“书桌”：position 应为 3 个数字/],
  [(doc) => { doc.scenes[0].props[0].position = [0, 0, -1600]; }, /position 的第 3 个数 -1600 超出范围/],
  [(doc) => { doc.scenes[0].props[0].position = [0, 0, -160]; }, /道具“书桌”：position 的 z = -160 超出前后墙.*厘米/],
  [(doc) => { doc.scenes[0].cameras[0].position = [0, 1.5, 3]; }, /摄影机“主机位”：position 的 z = 3 超出前后墙/],
  [(doc) => { doc.scenes[0].props[0].scale = [1, 1, 1]; }, /不认识的字段 "scale"，应写成 "size"/],
  [(doc) => { doc.scenes[0].props[1].name = "书桌"; }, /有两个道具都叫“书桌”/],
  [(doc) => { doc.scenes[0].props[0].geometry = "sphere"; }, /geometry 只能是 "box"/],
  [(doc) => { delete doc.scenes[0].props[0].type; }, /道具“书桌”：type 必须是不为空的文字/],
  [(doc) => { doc.scenes[0].states[0].changes[0].prop = "凳子"; }, /状态“整洁” → changes 第 1 项：prop 写的是“凳子”/],
  [(doc) => { doc.scenes[0].cameras[0].rotation = [0, 0, 0]; }, /rotation 和 lookAt 只写一个/],
  [(doc) => { doc.scenes[0].cameras[0].lookAt = [0, 1.5, 2.2]; }, /lookAt 不能和 position 是同一个点/],
  [(doc) => { doc.scenes[0].cameras[0].focalLength = 2; }, /focalLength = 2 超出范围/],
  [(doc) => { doc.scenes[0].cameras[0].aspect = "4:3"; }, /aspect 只能是 "9:16"/],
  [(doc) => { doc.scenes[0].cameras[0].fov = 40; }, /不认识的字段 "fov"，应写成 "focalLength"/],
  [(doc) => { doc.scenes[0].motions[0].target = { prop: "凳子" }; }, /动作“椅子倒下”：target.prop 写的是“凳子”/],
  [(doc) => { doc.scenes[0].motions[0].keyframes[1].frame = 0; }, /frame 0 在这个动作里出现了两次/],
  [(doc) => { doc.scenes[0].motions[0].keyframes[1].frame = 1.5; }, /frame 应为整数/],
  [(doc) => { delete doc.scenes[0].props[1].position; delete doc.scenes[0].props[1].rotation; delete doc.scenes[0].props[1].size; }, /动作目标没有写 position/],
  [(doc) => { doc.scenes[0].controlPackages[0] = { name: "锚", type: "guide", assetIds: [] }; }, /必须写 anchorFrame/],
  [(doc) => { doc.scenes[0].controlPackages[0].anchorFrame = 70; }, /只有 type 为 "guide" 的包才写 anchorFrame/],
  [(doc) => { doc.scenes[0].controlPackages[0].type = "photo"; }, /type 只能是/],
  [(doc) => { doc.scenes.push(clone(doc.scenes[0])); }, /有两个场景都叫“书房”/],
  [(doc) => { doc.scenes[0].room = { width: 4, depth: 5 }; }, /room：height 必填/],
  [(doc) => { doc.scenes[0].props[0].size = [1, 1, 1]; delete doc.scenes[0].props[0].position; }, /写了 rotation 或 size 就要同时写 position/],
  [(doc) => { doc.scenes[0].props[0].id = "x"; doc.scenes[0].props[1].id = "x"; }, /id "x" 和 .* 重复/],
];
for (const [mutate, pattern] of cases) { const doc = base(); mutate(doc); const result = validate(doc, new Map()); assert.equal(result.ok, false, `case ${pattern} should be refused`); assert.match(result.errors.join(" | "), pattern); }
// Asset IDs are checked against the library when it is given.
const withAsset = base(); withAsset.scenes[0].controlPackages[0].assetIds = ["made-up"];
assert.match(errorsOf(withAsset, new Map()), /素材记录不存在：made-up.*AI 不能凭空编/);
withAsset.scenes[0].controlPackages[0] = { name: "首帧", type: "first_frame", assetIds: ["a-video"] };
assert.match(errorsOf(withAsset, new Map([["a-video", "video"]])), /只能引用图片/);
assert.equal(validate(withAsset, new Map([["a-video", "image"]])).ok, true);
// Text-level problems.
assert.match(parseDirectorStageText("{ \"version\": “director-stage-v1” }").errors[0], /不是合法的 JSON.*中文引号/);
assert.match(parseDirectorStageText("  ").errors[0], /内容是空的/);
assert.match(validateDirectorStageDocument([]).errors[0], /最外层应该是一个对象/);
// Several errors at once are all listed.
const many = base(); many.scenes[0].props[0].position = "x"; many.scenes[0].cameras[1].aspect = "1:1";
assert.equal(validate(many, new Map()).errors.length, 2);

// 9. Export of messy data still produces a valid file: duplicate names get a suffix, dangling targets are dropped with a note.
const dupScene = await store.createScene({ name: "书房" });
await store.createProp({ sceneId: dupScene.id, name: "椅子", type: "chair" });
await store.createProp({ sceneId: dupScene.id, name: "椅子", type: "chair" });
const messyExport = exportDirectorStage(await loadAll());
assert.equal(validate(messyExport.document, new Map()).ok, true);
assert.ok(messyExport.notes.some((note) => note.includes("同名场景")) && messyExport.notes.some((note) => note.includes("椅子（2）")));

console.log("director-stage import tests passed");
