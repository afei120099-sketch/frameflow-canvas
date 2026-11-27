import assert from "node:assert/strict";
import { createServer } from "node:http";
import "./fake-indexeddb.mjs";
import { findBlender, WHITEBOX_RENDER_SCRIPT } from "./blender-runtime.ts";
import { createBlenderRenderHandler } from "./blender-render-routes.ts";
import { planH3Handoff } from "../lib/director-stage/h3-handoff.ts";
import { blenderStatus, buildRenderJob, generateWhiteboxFirstFrame, placedCameras } from "../lib/director-stage/whitebox-firstframe.ts";
import * as store from "../lib/director-stage/store.ts";

// 一键白模首帧 V0.2: Scene + Camera → /__blender_render (real portable Blender) → PNG → image Asset (the
// canvas import, stubbed here) → first_frame ControlPackage → the unchanged Director Stage → H3 plan.

const handler = createBlenderRenderHandler({ blender: findBlender, script: WHITEBOX_RENDER_SCRIPT, timeoutMs: 90_000 });
const server = createServer((request, response) => {
  if (!request.url?.startsWith("/__blender_render")) { response.statusCode = 404; response.end(); return; }
  request.url = request.url.slice("/__blender_render".length) || "/";
  void handler(request, response);
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const post = (body, headers = { "Content-Type": "application/json" }) => fetch(`${baseUrl}/__blender_render`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

const transform = (position, rotation, scale = [1, 1, 1]) => ({ position, rotation, scale });
const imported = [];
const importImage = async (file) => { imported.push(file); return { assetId: `asset-${imported.length}`, filename: file.name }; };

try {
  // Scene: room, a box, a plane, an un-placed prop, a placed 9:16 camera and an un-placed camera.
  const scene = await store.updateScene((await store.createScene({ name: "白模书房" })).id, { room: { width: 4, depth: 5, height: 2.8 } });
  await store.createProp({ sceneId: scene.id, name: "柜子", type: "box", geometry: "box", transform: transform([0.8, 0, -1.2], [0, 25, 0], [0.6, 1.6, 0.5]) });
  await store.createProp({ sceneId: scene.id, name: "地毯", type: "plane", geometry: "plane", transform: transform([-0.4, 0.005, -0.6], [-90, 0, 15], [1.4, 1, 1]) });
  await store.createProp({ sceneId: scene.id, name: "台灯", type: "lamp" });
  const camera = await store.createCamera({ sceneId: scene.id, name: "竖屏主机位", transform: transform([-0.3, 1.5, 2.2], [-12, -8, 0]), focalLength: 28, aspect: "9:16" });
  const loose = await store.createCamera({ sceneId: scene.id, name: "未放入机位" });
  const other = await store.createScene({ name: "别的场景" });
  const before = { scene: await store.getScene(scene.id), props: await store.listProps(scene.id), cameras: await store.listCameras(scene.id) };

  // Job payload: just this Scene; un-placed / foreign cameras refused before any render.
  assert.deepEqual(placedCameras(before.cameras).map((row) => row.id), [camera.id]);
  const job = buildRenderJob(before.scene, before.props, before.cameras, camera.id);
  assert.deepEqual(job.director.scenes.map((row) => row.id), [scene.id]);
  assert.deepEqual(job.director.cameras.map((row) => row.id), [camera.id]);
  assert.equal(job.director.props.length, 3);
  assert.equal(job.longSide, 1280);
  assert.throws(() => buildRenderJob(before.scene, before.props, before.cameras, loose.id), /还没有放入 3D 白模/);
  assert.throws(() => buildRenderJob(other, [], before.cameras, camera.id), /请选择这个场景里的摄影机/);
  await assert.rejects(generateWhiteboxFirstFrame(scene.id, loose.id, { importImage, baseUrl }), /还没有放入 3D 白模/);

  // Route guards: JSON only, loopback pages only, sane bodies.
  assert.equal((await post(job, { "Content-Type": "text/plain" })).status, 403, "no form-style posts");
  assert.equal((await post(job, { "Content-Type": "application/json", Origin: "https://evil.example" })).status, 403, "no cross-site pages");
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post({ ...job, cameraId: "../x" })).status, 400);
  assert.equal((await post({ ...job, longSide: 1000 })).status, 400, "long side must keep the aspect exact");
  assert.equal((await fetch(`${baseUrl}/__blender_render/other`)).status, 404);

  const status = await blenderStatus({ baseUrl });
  assert.equal(status.reachable, true);
  if (!findBlender()) {
    assert.equal(status.available, false);
    assert.equal((await post(job)).status, 503);
    console.log("一键白模首帧 V0.2: job payload, guards and the no-Blender answer passed; render SKIPPED (no portable Blender)");
  } else {
    assert.equal(status.available, true);
    assert.match(status.build, /^blender-/);

    // A Scene problem found by the Blender script comes back as 422 with its message.
    const missing = await post({ ...job, director: { ...job.director, cameras: [] } });
    assert.equal(missing.status, 422);
    assert.match((await missing.json()).message, /摄影机/);

    // One render at a time.
    const [first, second] = await Promise.all([post(job), post(job)]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);

    // The button's flow.
    const result = await generateWhiteboxFirstFrame(scene.id, camera.id, { importImage, baseUrl, now: () => new Date(2026, 9, 2, 18, 30, 5) });
    assert.equal(imported.length, 1, "exactly one image registered");
    const file = imported[0];
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(file.type, "image/png");
    assert.equal(bytes.toString("latin1", 1, 4), "PNG");
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [720, 1280], "exact 9:16");
    assert.equal(file.name, "白模首帧_白模书房_竖屏主机位_20261002-183005.png");
    assert.deepEqual({ width: result.record.render.width, height: result.record.render.height }, { width: 720, height: 1280 });
    assert.equal(result.record.camera.id, camera.id);
    assert.deepEqual(result.record.skippedProps, ["台灯"]);

    const pack = result.controlPackage;
    assert.equal(pack.type, "first_frame");
    assert.deepEqual(pack.assetIds, ["asset-1"]);
    assert.equal(pack.name, "白模首帧 · 竖屏主机位 · 18:30:05");
    assert.deepEqual((await store.listControlPackages(scene.id)).map((row) => row.id), [pack.id]);

    // Straight into the existing Director Stage → H3 hand-off (I2VA, same plan as a hand-made package).
    const lookup = (assetId) => (assetId === "asset-1" ? { assetId, kind: "image", storageReference: "image:asset-1", filename: file.name, width: 720, height: 1280 } : null);
    const plan = planH3Handoff({ sceneId: scene.id, sceneStateId: null, firstFramePackage: pack, lastFramePackage: null, referencePackage: null, guidePackages: [] }, [], lookup);
    assert.equal(plan.expectedMode, "i2va");
    assert.equal(plan.firstFrame.assetId, "asset-1");
    assert.deepEqual(plan.context, { sceneId: scene.id, controlPackageIds: [pack.id], assetIds: ["asset-1"] });

    // Scene / Prop / Camera records untouched.
    assert.deepEqual({ scene: await store.getScene(scene.id), props: await store.listProps(scene.id), cameras: await store.listCameras(scene.id) }, before);
    console.log(`一键白模首帧 V0.2: job payload, guards, script 422, one-at-a-time 409, real Blender ${result.record.render.seconds}s → 720×1280 PNG → one Asset → first_frame package → I2VA hand-off, Scene / Prop / Camera unchanged passed`);
  }
} finally {
  await new Promise((closed) => server.close(closed));
}
