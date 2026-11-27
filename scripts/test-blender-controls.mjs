import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import * as THREE from "three";
import "./fake-indexeddb.mjs";
import { findBlender, WHITEBOX_RENDER_SCRIPT } from "./blender-runtime.ts";
import { createBlenderRenderHandler } from "./blender-render-routes.ts";
import { planH3Handoff } from "../lib/director-stage/h3-handoff.ts";
import { generateWhiteboxControls } from "../lib/director-stage/whitebox-firstframe.ts";
import { controlPackageAssetProblem } from "../lib/director-stage/schema.ts";
import * as store from "../lib/director-stage/store.ts";

// 高级控制素材 V0.1: one Blender run gives rgb / depth / mask / object-id from the same camera. Checked pixel by
// pixel against an independent three.js ray cast of the same white-box scene (the stage's own conventions).

const blender = findBlender();
if (!blender) {
  console.log("Advanced controls V0.1: SKIPPED (no portable Blender found; set FRAMEFLOW_BLENDER)");
  process.exit(0);
}

/** Minimal PNG reader (8-bit, non-interlaced): enough for the bridge's outputs. */
function decodePng(file) {
  const buffer = readFileSync(file);
  let offset = 8; let header = null; const chunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset); const type = buffer.toString("latin1", offset + 4, offset + 8); const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === "IDAT") chunks.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  assert.equal(header.bitDepth, 8); assert.equal(header.interlace, 0);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colorType];
  const raw = inflateSync(Buffer.concat(chunks)); const stride = header.width * channels; const pixels = Buffer.alloc(header.height * stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0; const b = y ? pixels[(y - 1) * stride + x] : 0; const c = x >= channels && y ? pixels[(y - 1) * stride + x - channels] : 0;
      const paeth = () => { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
      pixels[y * stride + x] = (line[x] + [0, a, b, (a + b) >> 1, paeth()][filter === 4 ? 4 : filter]) & 255;
    }
  }
  return { ...header, channels, at: (x, y) => [...pixels.subarray((y * header.width + x) * channels, (y * header.width + x) * channels + Math.min(3, channels))] };
}

const work = mkdtempSync(path.join(tmpdir(), "frameflow-controls-"));
const transform = (position, rotation, scale = [1, 1, 1]) => ({ position, rotation, scale });
const room = { width: 4, depth: 5, height: 2.8 };
const director = {
  databaseVersion: 1,
  scenes: [{ id: "scene-1", name: "控制素材", room }],
  props: [
    { id: "prop-box", sceneId: "scene-1", name: "柜子", type: "box", geometry: "box", transform: transform([0.8, 0, -1.2], [0, 25, 0], [0.6, 1.6, 0.5]) },
    { id: "prop-tilt", sceneId: "scene-1", name: "斜放的箱子", type: "box", geometry: "box", transform: transform([-0.6, 0.3, -0.4], [10, -30, 20], [0.5, 0.4, 0.7]) },
    { id: "prop-plane", sceneId: "scene-1", name: "地毯", type: "plane", geometry: "plane", transform: transform([-0.4, 0.005, 0.6], [-90, 0, 15], [1.4, 1, 1]) },
    { id: "prop-behind", sceneId: "scene-1", name: "身后的箱子", type: "box", geometry: "box", transform: transform([0, 0, 2.45], [0, 0, 0], [0.4, 0.4, 0.2]) },
  ],
  states: [],
  cameras: [{ id: "cam-1", sceneId: "scene-1", name: "主机位", transform: transform([-0.3, 1.5, 2.2], [-14, -8, 0]), focalLength: 28, aspect: "9:16" }],
  motions: [], controlPackages: [],
};
writeFileSync(path.join(work, "director-stage.json"), JSON.stringify(director));
const render = (out, ...extra) => spawnSync(blender, ["-b", "--factory-startup", "--python-exit-code", "1", "-P", WHITEBOX_RENDER_SCRIPT, "--", "--input", work, "--out", path.join(work, out), "--long-side", "480", ...extra], { encoding: "utf8" });

try {
  // 1. One run, four images, same size; RGB identical to the RGB-only bridge.
  const plain = render("plain");
  assert.equal(plain.status, 0, plain.stderr);
  const full = render("full", "--controls", "depth,mask,object-id");
  assert.equal(full.status, 0, full.stderr);
  assert.equal(render("bad", "--controls", "normal").status, 2, "unknown control refused");
  const out = (name) => path.join(work, "full", name);
  const record = JSON.parse(readFileSync(out("camera.json"), "utf8"));
  const [rgb, rgbPlain, depth, mask, ids] = [out("rgb.png"), path.join(work, "plain", "rgb.png"), out("depth.png"), out("mask.png"), out("object-id.png")].map(decodePng);
  for (const image of [rgb, depth, mask, ids]) assert.deepEqual([image.width, image.height], [270, 480], "same pixels as rgb.png");
  assert.equal(JSON.parse(readFileSync(path.join(work, "plain", "camera.json"), "utf8")).controls, null, "RGB-only run unchanged (no controls)");
  for (let y = 0; y < 480; y += 7) for (let x = 0; x < 270; x += 7) assert.deepEqual(rgb.at(x, y), rgbPlain.at(x, y), `rgb ${x},${y} unchanged by --controls`);
  const controls = record.controls;
  assert.ok(controls.depth.farM > controls.depth.nearM && controls.depth.nearM > 0);
  const objects = controls.objectId.objects;
  assert.deepEqual(objects.map((object) => object.propId), ["prop-box", "prop-tilt", "prop-plane", "prop-behind"]);
  assert.equal(objects.find((object) => object.propId === "prop-behind").pixels, 0, "a Prop behind the camera has no pixels");
  assert.deepEqual(controls.mask.propIds, ["prop-box", "prop-tilt", "prop-plane"], "mask sources = visible Props");
  assert.equal(new Set(objects.map((object) => object.color.join())).size, objects.length, "one colour per Prop");
  assert.ok(Date.parse(controls.renderedAt.replace(/(\d\d)(\d\d)$/, "$1:$2")) > 0);

  // 2. Independent reference: three.js ray cast through every sampled pixel centre.
  const meshes = [];
  const roomMesh = new THREE.Mesh(new THREE.BoxGeometry(room.width, room.height, room.depth), new THREE.MeshBasicMaterial({ side: THREE.BackSide }));
  roomMesh.position.y = room.height / 2; roomMesh.userData.index = 0; meshes.push(roomMesh);
  director.props.forEach((prop, at) => {
    const geometry = prop.geometry === "plane" ? new THREE.PlaneGeometry(1, 1) : new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.position.set(...prop.transform.position); mesh.rotation.set(...prop.transform.rotation.map((deg) => (deg * Math.PI) / 180)); mesh.scale.set(...prop.transform.scale);
    mesh.userData.index = at + 1; meshes.push(mesh);
  });
  meshes.forEach((mesh) => mesh.updateMatrixWorld(true));
  const cam = director.cameras[0];
  const lens = new THREE.PerspectiveCamera((2 * Math.atan(12 / cam.focalLength) * 180) / Math.PI, 270 / 480, 0.05, 200);
  lens.position.set(...cam.transform.position); lens.rotation.set(...cam.transform.rotation.map((deg) => (deg * Math.PI) / 180));
  lens.updateMatrixWorld(true); lens.updateProjectionMatrix();
  const raycaster = new THREE.Raycaster();
  const colourOf = new Map(objects.map((object) => [object.color.join(), object.index]));
  const decodeDepth = (value) => controls.depth.farM - ((value - 1) * (controls.depth.farM - controls.depth.nearM)) / 254;
  const step = (controls.depth.farM - controls.depth.nearM) / 254;
  let samples = 0, idMiss = 0, maskMiss = 0, depthMiss = 0, boundaries = 0, wrongOrder = 0; const errors = [];
  const expectedAt = (x, y) => {
    raycaster.setFromCamera(new THREE.Vector2(((x + 0.5) / 270) * 2 - 1, -(((y + 0.5) / 480) * 2 - 1)), lens);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    return hit ? { index: hit.object.userData.index, z: -hit.point.clone().applyMatrix4(lens.matrixWorldInverse).z } : { index: -1, z: Infinity };
  };
  for (let y = 2; y < 480; y += 5) {
    let previous = null;
    for (let x = 2; x < 270; x += 5) {
      const expected = expectedAt(x, y); samples += 1;
      const colour = ids.at(x, y).join(); const index = colour === "0,0,0" ? 0 : colourOf.get(colour);
      if (index !== expected.index) idMiss += 1;
      if ((mask.at(x, y)[0] === 255) !== (expected.index > 0)) maskMiss += 1;
      const value = depth.at(x, y)[0];
      assert.ok(depth.at(x, y)[0] === depth.at(x, y)[2], "grey depth");
      if (value === 0 || Math.abs(decodeDepth(value) - expected.z) > step * 1.5 + 0.005) depthMiss += 1; else errors.push(Math.abs(decodeDepth(value) - expected.z));
      // Depth layering: where a Prop starts clearly in front of the room (> 2 grey steps; a rug lying on the floor is not), the Prop must be brighter.
      if (previous && previous.expected.index === 0 && expected.index > 0 && previous.expected.z - expected.z > 2 * step) { boundaries += 1; if (!(value > previous.value)) wrongOrder += 1; }
      previous = { expected, value };
    }
  }
  errors.sort((a, b) => a - b);
  const edgeShare = 0.01; // pixels exactly on a silhouette may round either way
  assert.ok(idMiss / samples <= edgeShare, `object-id: ${idMiss}/${samples} pixels differ from the ray cast`);
  assert.ok(maskMiss / samples <= edgeShare, `mask: ${maskMiss}/${samples} pixels differ from the ray cast`);
  assert.ok(depthMiss / samples <= edgeShare, `depth: ${depthMiss}/${samples} pixels off by more than 1.5 grey steps`);
  assert.ok(errors[Math.floor(errors.length / 2)] <= step, `median depth error ${errors[Math.floor(errors.length / 2)]} m vs one step ${step} m`);
  assert.ok(boundaries > 10 && wrongOrder === 0, `depth layering: ${wrongOrder}/${boundaries} Prop-in-front-of-room boundaries wrong`);
  const blenderSummary = `${samples} samples: id ${idMiss}, mask ${maskMiss}, depth ${depthMiss} off; median depth error ${(errors[Math.floor(errors.length / 2)] * 1000).toFixed(1)} mm (step ${(step * 1000).toFixed(1)} mm); ${boundaries} layering boundaries`;

  // 3. Route + client: one click → 4 Assets + 4 ControlPackages with render metadata; H3 never takes the new types.
  const handler = createBlenderRenderHandler({ blender: findBlender, script: WHITEBOX_RENDER_SCRIPT, timeoutMs: 90_000 });
  const server = createServer((request, response) => { request.url = request.url.slice("/__blender_render".length) || "/"; void handler(request, response); });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = await fetch(`${baseUrl}/__blender_render`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ director, sceneId: "scene-1", cameraId: "cam-1", controls: ["normal"] }) });
    assert.equal(bad.status, 400);
    const scene = await store.updateScene((await store.createScene({ name: "控制素材" })).id, { room });
    const placed = [];
    for (const prop of director.props) placed.push(await store.createProp({ sceneId: scene.id, name: prop.name, type: prop.type, geometry: prop.geometry, transform: prop.transform }));
    const camera = await store.createCamera({ sceneId: scene.id, name: "主机位", transform: cam.transform, focalLength: 28, aspect: "9:16" });
    const imported = [];
    const importImage = async (file) => { imported.push(file); return { assetId: `asset-${imported.length}`, filename: file.name }; };
    const result = await generateWhiteboxControls(scene.id, camera.id, { importImage, baseUrl, now: () => new Date(2026, 9, 3, 10, 0, 0) });
    assert.deepEqual(imported.map((file) => file.name.replace(/^.*_/, "")), ["rgb.png", "depth.png", "mask.png", "object-id.png"]);
    assert.deepEqual(result.items.map((item) => [item.pass, item.controlPackage.type, item.controlPackage.assetIds[0]]), [["rgb", "first_frame", "asset-1"], ["depth", "depth", "asset-2"], ["mask", "mask", "asset-3"], ["object_id", "object_id", "asset-4"]]);
    const saved = await store.listControlPackages(scene.id);
    assert.equal(saved.length, 4);
    const groupIds = new Set(saved.map((pack) => pack.render.groupId));
    assert.equal(groupIds.size, 1, "one render batch");
    for (const pack of saved) {
      assert.equal(pack.render.sceneId, scene.id); assert.equal(pack.render.cameraId, camera.id);
      assert.equal(pack.render.renderedAt, new Date(2026, 9, 3, 10, 0, 0).getTime());
      assert.deepEqual([pack.render.width, pack.render.height], [720, 1280]);
    }
    const byPass = Object.fromEntries(saved.map((pack) => [pack.render.pass, pack.render]));
    assert.ok(byPass.depth.depthRange.farM > byPass.depth.depthRange.nearM);
    assert.equal(byPass.depth.includesRoom, true);
    assert.deepEqual(byPass.mask.sourceObjects.map((object) => object.name), ["柜子", "斜放的箱子", "地毯"]);
    assert.deepEqual(byPass.object_id.sourceObjects.map((object) => [object.propId, object.index, object.pixels > 0]), [[placed[0].id, 1, true], [placed[1].id, 2, true], [placed[2].id, 3, true], [placed[3].id, 4, false]]);
    // The new types are managed only: the H3 hand-off refuses them in a first-frame slot.
    const depthPack = saved.find((pack) => pack.type === "depth");
    assert.throws(() => planH3Handoff({ sceneId: scene.id, sceneStateId: null, firstFramePackage: depthPack, lastFramePackage: null, referencePackage: null }, [], () => ({ assetId: "asset-2", kind: "image", storageReference: "image:x", filename: "d.png" })), /不是首帧类型/);
    // Render metadata is validated like every Director Stage record.
    await assert.rejects(store.createControlPackage({ sceneId: scene.id, name: "坏的", type: "mask", assetIds: [], render: { ...byPass.mask, pass: "normal" } }), /控制素材包数据不合法/);
    // Each new type takes exactly one image (the panel's binding rule).
    for (const type of ["depth", "mask", "object_id"]) {
      assert.equal(controlPackageAssetProblem(type, [{ assetId: "a", kind: "image" }]), null);
      assert.ok(controlPackageAssetProblem(type, [{ assetId: "a", kind: "image" }, { assetId: "b", kind: "image" }]));
      assert.ok(controlPackageAssetProblem(type, [{ assetId: "v", kind: "video" }]));
    }
    console.log(`Advanced controls V0.1: one Blender run → rgb / depth / mask / object-id, same 270×480 pixels, RGB unchanged; vs three.js ray cast: ${blenderSummary}; Prop behind camera = 0 px; route + client → 4 Assets + 4 packages (first_frame / depth / mask / object_id) with Scene / Camera / sources / time, not offered to H3 passed`);
  } finally {
    await new Promise((closed) => server.close(closed));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
