import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import "./fake-indexeddb.mjs";
import { startFakeComfy } from "./fake-comfyui.mjs";
import { findBlender, WHITEBOX_RENDER_SCRIPT } from "./blender-runtime.ts";
import { createBlenderRenderHandler } from "./blender-render-routes.ts";
import { buildSdxlDepthWorkflow, runSdxlDepthFirstFrame, SDXL_DEPTH_FIRSTFRAME, SDXL_DEPTH_PROMPT_PREFIX, SDXL_DEPTH_TEMPLATE, sdxlDepthSettings, sdxlDepthTemplateSha } from "../lib/comfyui/sdxl-depth-firstframe.ts";
import { generateDepthFirstFrame } from "../lib/director-stage/depth-firstframe.ts";
import { planH3Handoff } from "../lib/director-stage/h3-handoff.ts";
import * as store from "../lib/director-stage/store.ts";

// Depth 写实首帧 V0.1: frozen SDXL_DEPTH_FIRSTFRAME_V0.1 template, its builder, the ComfyUI round trip (fake
// ComfyUI, no GPU) and the whole Blender depth → SDXL → Asset → first_frame package chain.

const file = new URL("../lib/comfyui/sdxl-depth-firstframe-workflow.json", import.meta.url);
assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), "924a6bbbec6b395e96688c5495b89c341fef886531d694aad7268a1bf2e78b44", "template frozen");
assert.equal(await sdxlDepthTemplateSha(), `sha256:${createHash("sha256").update(JSON.stringify(SDXL_DEPTH_TEMPLATE)).digest("hex")}`);

// Template: existing models only, depth control, conservative defaults.
assert.deepEqual(Object.fromEntries(Object.entries(SDXL_DEPTH_TEMPLATE).map(([id, node]) => [id, node.class_type])), { 1: "CheckpointLoaderSimple", 2: "CLIPTextEncode", 3: "CLIPTextEncode", 4: "LoadImage", 5: "ControlNetLoader", 6: "SetUnionControlNetType", 7: "ControlNetApplyAdvanced", 8: "EmptyLatentImage", 9: "KSampler", 10: "VAEDecode", 15: "SaveImage" });
assert.deepEqual(sdxlDepthSettings(), { template: "SDXL_DEPTH_FIRSTFRAME_V0.1", templateFile: "sdxl-depth-firstframe-workflow.json", checkpoint: "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors", controlNet: "diffusion_pytorch_model.safetensors", controlType: "depth", controlStrength: 0.8, endPercent: 0.8, steps: 30, cfg: 5.5, sampler: "dpmpp_2m karras" });

// Builder: only depth image / prompt / seed / size change.
const built = buildSdxlDepthWorkflow({ depthImageName: "d.png", prompt: "  a cozy study,   wooden chair ", seed: 42, width: 1280, height: 720 });
const expected = structuredClone(SDXL_DEPTH_TEMPLATE);
expected[4].inputs.image = "d.png"; expected[2].inputs.text = `${SDXL_DEPTH_PROMPT_PREFIX}, a cozy study, wooden chair`; expected[8].inputs.width = 1280; expected[8].inputs.height = 720; expected[9].inputs.seed = 42;
assert.deepEqual(built, expected);
assert.equal(buildSdxlDepthWorkflow({ depthImageName: "d.png", prompt: "", seed: 1, width: 720, height: 1280 })[2].inputs.text, `${SDXL_DEPTH_PROMPT_PREFIX}, an empty room with simple furniture`);
assert.throws(() => buildSdxlDepthWorkflow({ depthImageName: "d.png", prompt: "", seed: 1, width: 1024, height: 1024 }), /尺寸只支持/);
assert.throws(() => buildSdxlDepthWorkflow({ depthImageName: "d.png", prompt: "", seed: -1, width: 720, height: 1280 }), /种子无效/);
assert.throws(() => buildSdxlDepthWorkflow({ depthImageName: "d.png", prompt: "x".repeat(601), seed: 1, width: 720, height: 1280 }), /最多 600/);

// ComfyUI round trip against the fake (upload → prompt → history → view), then an execution error.
const work = mkdtempSync(path.join(tmpdir(), "frameflow-sdxl-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
writeFileSync(path.join(work, "out.png"), png);
const fake = await startFakeComfy({ files: [{ seed: 0, path: path.join(work, "out.png") }], runMs: 50 });
const handler = createBlenderRenderHandler({ blender: findBlender, script: WHITEBOX_RENDER_SCRIPT, timeoutMs: 90_000 });
const server = createServer((request, response) => { request.url = request.url.slice("/__blender_render".length) || "/"; void handler(request, response); });
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
try {
  const stages = [];
  const result = await runSdxlDepthFirstFrame(new Blob([png], { type: "image/png" }), { prompt: "a study", seed: 7, width: 720, height: 1280 }, { baseUrl: fake.url, pollMs: 20, onStage: (stage) => stages.push(stage) });
  assert.deepEqual(Buffer.from(await result.image.arrayBuffer()), png);
  assert.equal(result.seed, 7);
  assert.deepEqual(fake.state.prompts[0].body.prompt, buildSdxlDepthWorkflow({ depthImageName: "fake_upload_1.png", prompt: "a study", seed: 7, width: 720, height: 1280 }), "exactly the frozen workflow + allowed fields");
  assert.deepEqual(stages, ["上传深度图", "提交 SDXL", "SDXL 生成中", "下载写实首帧"]);
  fake.state.failures.push("CUDA out of memory");
  await assert.rejects(runSdxlDepthFirstFrame(new Blob([png]), { prompt: "", seed: 8, width: 720, height: 1280 }, { baseUrl: fake.url, pollMs: 20 }), /SDXL 生成失败：CUDA out of memory/);

  if (!findBlender()) {
    console.log("Depth 写实首帧 V0.1: frozen template, builder, ComfyUI round trip passed; Blender chain SKIPPED (no portable Blender)");
  } else {
    // Whole chain: Blender depth → depth package → SDXL (fake) → realistic Asset → first_frame package → H3 plan.
    const t = (position, rotation, scale = [1, 1, 1]) => ({ position, rotation, scale });
    const scene = await store.updateScene((await store.createScene({ name: "写实书房" })).id, { room: { width: 4, depth: 5, height: 2.8 } });
    await store.createProp({ sceneId: scene.id, name: "椅子", type: "chair", geometry: "box", transform: t([0.3, 0, -0.8], [0, 20, 0], [0.5, 0.9, 0.5]) });
    const camera = await store.createCamera({ sceneId: scene.id, name: "主机位", transform: t([-0.3, 1.5, 2.2], [-12, -8, 0]), focalLength: 28, aspect: "9:16" });
    const imported = [];
    const importImage = async (blobFile) => { imported.push(blobFile); return { assetId: `asset-${imported.length}`, filename: blobFile.name }; };
    const chain = await generateDepthFirstFrame(scene.id, camera.id, "a cozy study", { importImage, baseUrl, random: () => 0.5, now: () => new Date(2026, 9, 3, 11, 0, 0), comfy: { baseUrl: fake.url, pollMs: 20 } });
    assert.deepEqual(imported.map((item) => item.name), ["白模控制_写实书房_主机位_20261003-110000_depth.png", "写实首帧_写实书房_主机位_20261003-110000.png"]);
    const sent = fake.state.prompts.at(-1).body.prompt;
    assert.equal(sent[2].inputs.text, `${SDXL_DEPTH_PROMPT_PREFIX}, a cozy study`);
    assert.deepEqual([sent[8].inputs.width, sent[8].inputs.height], [720, 1280], "SDXL size = Blender depth pixels");
    assert.equal(chain.depth.controlPackage.type, "depth");
    assert.equal(chain.firstFrame.controlPackage.type, "first_frame");
    const render = chain.firstFrame.controlPackage.render;
    assert.equal(render.pass, "sdxl_first_frame");
    assert.equal(render.groupId, chain.depth.controlPackage.render.groupId);
    assert.deepEqual([render.sceneId, render.cameraId], [scene.id, camera.id]);
    assert.equal(render.generator.template, SDXL_DEPTH_FIRSTFRAME);
    assert.deepEqual([render.generator.seed, render.generator.sourceDepthPackageId, render.generator.sourceDepthAssetId, render.generator.controlType], [Math.floor(0.5 * (2 ** 31 - 1)), chain.depth.controlPackage.id, "asset-1", "depth"]);
    assert.deepEqual((await store.listControlPackages(scene.id)).map((pack) => pack.type).sort(), ["depth", "first_frame"]);
    const plan = planH3Handoff({ sceneId: scene.id, sceneStateId: null, firstFramePackage: chain.firstFrame.controlPackage, lastFramePackage: null, referencePackage: null }, [], (assetId) => ({ assetId, kind: "image", storageReference: `image:${assetId}`, filename: "f.png", width: 720, height: 1280 }));
    assert.equal(plan.expectedMode, "i2va");
    assert.equal(plan.firstFrame.assetId, "asset-2");
    // SDXL failure keeps the depth package and says so.
    fake.state.failures.push("out of memory");
    await assert.rejects(generateDepthFirstFrame(scene.id, camera.id, "", { importImage, baseUrl, comfy: { baseUrl: fake.url, pollMs: 20 } }), /深度图已登记.*SDXL 写实首帧失败：SDXL 生成失败：out of memory/);
    console.log("Depth 写实首帧 V0.1: frozen template 924a6bbb, existing models only, builder whitelist, ComfyUI round trip + error, Blender depth → depth package → SDXL → realistic Asset → first_frame package (generator recorded) → I2VA plan passed");
  }
} finally {
  await new Promise((closed) => server.close(closed));
  await fake.close?.();
  rmSync(work, { recursive: true, force: true });
}
