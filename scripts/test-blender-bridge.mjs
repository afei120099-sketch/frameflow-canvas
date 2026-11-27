import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as THREE from "three";
import { aspectRatio, degToRad, focalToVerticalFov } from "../lib/director-stage/whitebox.ts";
import { findBlender, WHITEBOX_RENDER_SCRIPT } from "./blender-runtime.ts";

// Blender Bridge V0.1: tools/blender/whitebox_render.py must frame a Scene exactly like the three.js white-box stage.
// Needs the portable Blender (FRAMEFLOW_BLENDER, or blender-*\blender.exe under FRAMEFLOW_BLENDER_SEARCH_DIR); skipped when it is absent.

const blender = findBlender();
if (!blender) {
  console.log("Blender Bridge V0.1: SKIPPED (no portable Blender found; set FRAMEFLOW_BLENDER)");
  process.exit(0);
}

const script = WHITEBOX_RENDER_SCRIPT;
const work = mkdtempSync(path.join(tmpdir(), "frameflow-blender-"));
const transform = (position, rotation, scale = [1, 1, 1]) => ({ position, rotation, scale });
const director = {
  databaseVersion: 1,
  scenes: [{ id: "scene-1", name: "白模书房", room: { width: 4, depth: 5, height: 2.8 } }],
  props: [
    { id: "prop-box", sceneId: "scene-1", name: "柜子", type: "box", geometry: "box", transform: transform([0.8, 0, -1.2], [0, 25, 0], [0.6, 1.6, 0.5]) },
    { id: "prop-tilt", sceneId: "scene-1", name: "斜放的箱子", type: "box", geometry: "box", transform: transform([-1, 0.3, -1.6], [10, -30, 20], [0.5, 0.4, 0.7]) },
    { id: "prop-plane", sceneId: "scene-1", name: "地毯", type: "plane", geometry: "plane", transform: transform([-0.4, 0.005, -0.6], [-90, 0, 15], [1.4, 1, 1]) },
    { id: "prop-legacy", sceneId: "scene-1", name: "未放入", type: "chair" },
  ],
  states: [],
  cameras: [
    { id: "cam-portrait", sceneId: "scene-1", name: "竖屏主机位", transform: transform([-0.3, 1.5, 2.2], [-12, -8, 0]), focalLength: 28, aspect: "9:16" },
    { id: "cam-wide", sceneId: "scene-1", name: "横屏机位", transform: transform([1.2, 1.2, 2], [-5, 20, 3]), focalLength: 50, aspect: "16:9" },
    { id: "cam-unplaced", sceneId: "scene-1", name: "未放入机位" },
  ],
  // Motion V0.2: a posed chair fall (plus one text-only keyframe) and a text-only camera Motion.
  motions: [
    { id: "motion-fall", sceneId: "scene-1", name: "柜子倒下", targetType: "prop", targetId: "prop-box", keyframes: [
      { frame: 0, description: "站立", transform: transform([0.8, 0, -1.2], [0, 25, 0], [0.6, 1.6, 0.5]) },
      { frame: 24, description: "晃一下" },
      { frame: 50, description: "倾斜", transform: transform([0.8, 0, -1.2], [-30, 25, 0], [0.6, 1.6, 0.5]) },
      { frame: 100, description: "倒地", transform: transform([0.8, 0, -1.2], [-90, 25, 0], [0.6, 1.6, 0.5]) },
    ] },
    { id: "motion-push", sceneId: "scene-1", name: "推近", targetType: "camera", targetId: "cam-portrait", keyframes: [{ frame: 0, description: "中景" }] },
  ],
  controlPackages: [],
};
writeFileSync(path.join(work, "director-stage.json"), JSON.stringify(director));

const render = (...extra) => spawnSync(blender, ["-b", "--factory-startup", "--python-exit-code", "1", "-P", script, "--", "--input", work, ...extra], { encoding: "utf8" });

/** Image-space bbox (0..1, top-left origin) of a Prop's corners as seen by the three.js stage camera. */
function threeBBox(prop, camera) {
  const lens = new THREE.PerspectiveCamera(focalToVerticalFov(camera.focalLength), aspectRatio(camera.aspect), 0.05, 200);
  lens.position.set(...camera.transform.position);
  lens.rotation.set(...camera.transform.rotation.map(degToRad));
  lens.updateMatrixWorld(true);
  const object = new THREE.Object3D();
  object.position.set(...prop.transform.position);
  object.rotation.set(...prop.transform.rotation.map(degToRad));
  object.scale.set(...prop.transform.scale);
  object.updateMatrixWorld(true);
  const corners = prop.geometry === "plane"
    ? [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0]]
    : [0, 1].flatMap((y) => [[-0.5, y, -0.5], [0.5, y, -0.5], [0.5, y, 0.5], [-0.5, y, 0.5]]);
  const points = corners.map((corner) => new THREE.Vector3(...corner).applyMatrix4(object.matrixWorld).project(lens)).map((ndc) => [(ndc.x + 1) / 2, (1 - ndc.y) / 2]);
  const xs = points.map((point) => point[0]); const ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function pngSize(file) {
  const bytes = readFileSync(file);
  assert.equal(bytes.toString("latin1", 1, 4), "PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

try {
  // Several placed cameras: the script refuses to guess.
  const ambiguous = render();
  assert.equal(ambiguous.status, 2, ambiguous.stderr);
  assert.match(ambiguous.stderr, /已放入白模的摄影机.*竖屏主机位/);
  assert.equal(render("--camera", "未放入机位").status, 2, "an un-placed camera cannot be rendered");

  for (const [cameraId, expected] of [["cam-portrait", { width: 540, height: 960 }], ["cam-wide", { width: 960, height: 540 }]]) {
    const out = path.join(work, cameraId);
    const result = render("--camera", cameraId, "--out", out, "--long-side", "960");
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const record = JSON.parse(readFileSync(path.join(out, "camera.json"), "utf8"));
    const camera = director.cameras.find((row) => row.id === cameraId);
    assert.equal(record.format, "frameflow-blender-camera-v1");
    assert.deepEqual(pngSize(path.join(out, "rgb.png")), expected, "exact 9:16 / 16:9 pixels");
    assert.deepEqual({ width: record.render.width, height: record.render.height }, expected);
    assert.equal(record.camera.aspect, camera.aspect);
    assert.ok(Math.abs(record.camera.verticalFovDeg - focalToVerticalFov(camera.focalLength)) < 0.01, "same vertical FOV as the three.js lens");
    assert.deepEqual(record.skippedProps, ["未放入"]);
    // Motion V0.2 export preparation: posed keyframes only, Blender matrix = Rx(+90°) · three.js matrix.
    assert.equal(record.motionFile, "motion.json");
    const motion = JSON.parse(readFileSync(path.join(out, "motion.json"), "utf8"));
    assert.equal(motion.format, "frameflow-blender-motion-v1");
    assert.equal(motion.fps, 24);
    assert.deepEqual(motion.tracks.map((track) => track.motionId), ["motion-fall"], "the text-only camera Motion is not a track");
    assert.deepEqual(motion.tracks[0].keyframes.map((keyframe) => [keyframe.frame, keyframe.seconds]), [[0, 0], [50, 2.083], [100, 4.167]]);
    const toBlender = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    for (const keyframe of motion.tracks[0].keyframes) {
      const object = new THREE.Object3D();
      object.position.set(...keyframe.transform.position); object.rotation.set(...keyframe.transform.rotation.map(degToRad)); object.scale.set(...keyframe.transform.scale);
      object.updateMatrixWorld(true);
      const expected = toBlender.clone().multiply(object.matrixWorld).transpose().toArray(); // row-major like Blender's matrix rows
      keyframe.blenderMatrixWorld.flat().forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-5, `f${keyframe.frame} matrix[${index}]`));
    }
    assert.equal(record.framing.length, 3);
    for (const row of record.framing) {
      const prop = director.props.find((item) => item.id === row.propId);
      assert.ok(row.allCornersInFront, `${prop.name} fully in front of ${camera.name}`);
      const expectedBox = threeBBox(prop, camera);
      row.bbox.forEach((value, index) => assert.ok(Math.abs(value - expectedBox[index]) < 0.002, `${camera.name} / ${prop.name} bbox[${index}]: blender ${value} vs three ${expectedBox[index].toFixed(4)}`));
    }
  }
  console.log("Blender Bridge V0.1: ambiguous / un-placed camera refused, exact 9:16 + 16:9 PNG, FOV match, Blender framing == three.js framing (box / tilted box / plane, < 0.2%), Motion V0.2 motion.json tracks + Blender matrices passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
