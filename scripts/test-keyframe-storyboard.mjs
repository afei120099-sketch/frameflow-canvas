import assert from "node:assert/strict";
import { buildFluxDev, FLUX_DEPTH } from "../lib/comfyui/flux-dev.ts";
import { parseKeyframeStoryboard, planStoryboardBatch, keyframeStoryboardExample, storyboardPromptWarnings, buildStoryboardPrompt, isStoryboardDocument } from "../lib/keyframe-storyboard.ts";

// Workflow: depth branch wiring
const g = buildFluxDev({ prompt: "a man", width: 864, height: 1536, seed: 7, guidance: 10, depthImageName: "board.png", faceImageName: "face.png", faceWeight: 0.8 });
assert.equal(g["3"], undefined, "no empty latent: InstructPixToPix supplies it");
assert.deepEqual(g["40"].inputs.model, ["1", 0], "depth LoRA loads directly on the base UNet");
assert.equal(g["40"].inputs.lora_name, FLUX_DEPTH.lora);
assert.equal(g["42"].inputs.crop, "center");
assert.equal(g["43"].class_type, "DepthAnythingV2Preprocessor");
assert.deepEqual(g["44"].inputs.pixels, ["43", 0]);
assert.deepEqual(g["5"].inputs.latent_image, ["44", 2]);
assert.deepEqual(g["5"].inputs.positive, ["44", 0]);
assert.deepEqual(g["5"].inputs.negative, ["44", 1]);
assert.deepEqual(g["34"].inputs.model, ["40", 0], "PuLID applies on top of the depth LoRA");
assert.deepEqual(g["5"].inputs.model, ["34", 0]);
assert.equal(g["5"].inputs.denoise, 1);
assert.equal(g["7"].inputs.filename_prefix, "Frameflow_Flux_Depth_Keyframe");
const noFace = buildFluxDev({ prompt: "corridor", width: 1536, height: 864, seed: 1, depthImageName: "b.png" });
assert.deepEqual(noFace["5"].inputs.model, ["40", 0]);
assert.equal(noFace["34"], undefined);
assert.throws(() => buildFluxDev({ prompt: "x", width: 864, height: 1536, seed: 1, depthImageName: "b.png", imageName: "a.png" }));
// Old paths unchanged
const old = buildFluxDev({ prompt: "x", width: 864, height: 1536, seed: 1, faceImageName: "f.png" });
assert.deepEqual(old["34"].inputs.model, ["1", 0]);
assert.equal(old["40"], undefined);
assert.equal(old["3"].class_type, "EmptySD3LatentImage");

// Document
const ex = parseKeyframeStoryboard(keyframeStoryboardExample());
assert.ok(isStoryboardDocument(keyframeStoryboardExample()));
assert.equal(ex.frames.length, 3);
assert.equal(ex.frames[0].faceReferenceAssetId, ex.faceReferenceAssetId, "frames inherit the document face");
assert.equal(ex.frames[2].faceReferenceAssetId, null, "explicit null = no face lock");
assert.equal(ex.frames[1].faceWeight, 0.6);
const plans = planStoryboardBatch(ex);
assert.ok(plans.every(p => p.mode === "master" && p.source === "master"));
assert.deepEqual(plans.flatMap(p => storyboardPromptWarnings(p.prompt)), [], "example prompts are clean English");
assert.equal(buildStoryboardPrompt("look.", "shot."), "shot. look. photorealistic film still, natural skin texture.");
assert.ok(storyboardPromptWarnings("他站着").length === 1);
assert.ok(storyboardPromptWarnings("no hat").length === 1);
const base = JSON.parse(keyframeStoryboardExample());
assert.throws(() => parseKeyframeStoryboard(JSON.stringify({ ...base, extra: 1 })), /extra/);
assert.throws(() => parseKeyframeStoryboard(JSON.stringify({ ...base, aspect: "4:3" })));
assert.throws(() => parseKeyframeStoryboard(JSON.stringify({ ...base, frames: [base.frames[0], base.frames[0]] })), /重复/);
assert.throws(() => parseKeyframeStoryboard(JSON.stringify({ ...base, look: "", frames: [{ shotId: "a", storyboardAssetId: "b" }] })));
console.log("keyframe storyboard: ok");
