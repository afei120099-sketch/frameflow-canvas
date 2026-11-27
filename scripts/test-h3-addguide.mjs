import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import "./fake-indexeddb.mjs";
import { buildH3AddGuideWorkflow, normalizeGuides, H3_ADDGUIDE_EXPERIMENTAL, H3_ADDGUIDE_TEMPLATE_FILE, H3_ADDGUIDE_NOTE } from "../lib/comfyui/experimental/h3-addguide.ts";
import { buildH3Workflow, planH3Submission } from "../lib/comfyui/h3-adapter.ts";
import { compileH3Prompt } from "../lib/comfyui/h3-prompt.ts";
import { snapshotH3, h3ClassTypesFor } from "../lib/production-snapshots.ts";
import { isH3Capability } from "../lib/production-records.ts";

// 🧪 H3 AddGuide experimental capability: frozen templates, wiring, ordering, routing, snapshot identity.
const sha = async (path) => createHash("sha256").update(await readFile(new URL(path, import.meta.url))).digest("hex");
assert.equal(await sha("../lib/comfyui/h3-workflow.json"), "53131f30550f78d686762033432606bee5a7a0ecc0b7820d99e3b82d1f8dc195", "production I2VA/FL2VA template untouched");
assert.equal(await sha("../lib/comfyui/experimental/h3-i2va-addguide-workflow.json"), "0dab2b094a3304c41d53dfd31addc035ed8a70d5777f082a20244f9b1b651cdd", "experimental template frozen");

// The experimental template is exactly production I2VA + one guide pair (40 LoadImage → 41 AddGuide → 7).
const experimental = JSON.parse(await readFile(new URL("../lib/comfyui/experimental/h3-i2va-addguide-workflow.json", import.meta.url), "utf8"));
const production = JSON.parse(await readFile(new URL("../lib/comfyui/h3-workflow.json", import.meta.url), "utf8"));
assert.equal(experimental["41"].class_type, "MiniMaxH3AddGuide");
assert.deepEqual(experimental["7"].inputs.conditioning, ["41", 0]);
const stripped = structuredClone(experimental); delete stripped["40"]; delete stripped["41"]; stripped["7"].inputs.conditioning = ["6", 0];
assert.deepEqual(stripped, production);

const settings = { length: 141, aspect: "follow", megapixels: 0.5, turbo: true, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32, soundMode: "av" };
const prompt = compileH3Prompt("A chair falls.", "av");
const base = buildH3Workflow("first.png", prompt, 7, settings);

// One guide: production workflow + guide pair, nothing else changed.
const one = buildH3AddGuideWorkflow("first.png", prompt, 7, settings, [{ imageName: "fallen.png", frameIdx: 70 }]);
assert.deepEqual(one["40"].inputs, { image: "fallen.png" });
assert.deepEqual(one["41"].inputs, { positive: ["6", 0], latent: ["6", 1], vae: ["3", 0], image: ["40", 0], frame_idx: 70 });
assert.deepEqual(one["7"].inputs.conditioning, ["41", 0]);
const oneStripped = structuredClone(one); delete oneStripped["40"]; delete oneStripped["41"]; oneStripped["7"].inputs.conditioning = ["6", 0];
assert.deepEqual(oneStripped, base, "all production parameters (0.5MP / Turbo 6 / 141 frames / seed) unchanged");

// Two guides given out of order: chained in frame order, each on the same AV latent.
const two = buildH3AddGuideWorkflow("first.png", prompt, 7, settings, [{ imageName: "moved.png", frameIdx: 117 }, { imageName: "fallen.png", frameIdx: 47 }]);
assert.equal(two["41"].inputs.frame_idx, 47); assert.equal(two["40"].inputs.image, "fallen.png");
assert.equal(two["ff-guide-1"].inputs.frame_idx, 117); assert.equal(two["ff-guide-1-load"].inputs.image, "moved.png");
assert.deepEqual(two["ff-guide-1"].inputs.positive, ["41", 0]);
assert.deepEqual(two["ff-guide-1"].inputs.latent, ["6", 1]);
assert.deepEqual(two["7"].inputs.conditioning, ["ff-guide-1", 0]);
assert.deepEqual(two["11"].inputs.latent_image, ["6", 1], "sampling latent unchanged");

// Refusals.
assert.throws(() => normalizeGuides([], 141), /至少需要一个/);
assert.throws(() => normalizeGuides([{ imageName: "a", frameIdx: 0 }], 141), /超出本次视频范围/);
assert.throws(() => normalizeGuides([{ imageName: "a", frameIdx: 141 }], 141), /超出本次视频范围（1–140 帧）/);
assert.throws(() => normalizeGuides([{ imageName: "a", frameIdx: 50 }, { imageName: "b", frameIdx: 50 }], 141), /同一帧 50/);
assert.throws(() => normalizeGuides([1, 2, 3, 4, 5].map((n) => ({ imageName: `g${n}`, frameIdx: n * 10 })), 141), /最多 4 个/);

// planH3Submission: guides route to the experimental builder for I2VA only; without guides nothing changes.
const references = { images: [], videos: [], audios: [] };
const input = { taskMode: "i2va", prompt: "A chair falls.", seed: 7, settings };
// Retired 2026-11-10: the stable workflow these guides were routed through is blocked before any upload.
assert.throws(() => planH3Submission(input, { imageName: "first.png", references }), /已停用/);
assert.throws(() => planH3Submission(input, { imageName: "first.png", references, guides: [{ imageName: "fallen.png", frameIdx: 70 }] }), /已停用/);

// Run snapshot: experimental capability + template identity + anchor frames; plain I2VA snapshot unchanged.
const snapshot = await snapshotH3({ referenceMode: false, prompt, seed: 7, settings, sourceWidth: 1088, sourceHeight: 1920, hasLastFrame: false, referenceCounts: { images: 1, videos: 0, audios: 0, videoAudioFlags: [] }, guides: [{ frameIdx: 117 }, { frameIdx: 47 }] });
assert.equal(snapshot.capabilityId, H3_ADDGUIDE_EXPERIMENTAL);
assert.equal(snapshot.capabilityId, "h3_addguide_experimental");
assert.equal(snapshot.workflowIdentity.templateFile, H3_ADDGUIDE_TEMPLATE_FILE);
assert.equal(snapshot.workflowIdentity.templateVersion, `sha256:${createHash("sha256").update(JSON.stringify(experimental)).digest("hex")}`);
assert.deepEqual(snapshot.parameters.anchorFrames, [47, 117]);
assert.equal(snapshot.parameters.mode, "first+guides");
assert.equal(snapshot.parameters.steps, 6); assert.equal(snapshot.parameters.length, 141); assert.equal(snapshot.parameters.megapixels, 0.5);
const plain = await snapshotH3({ referenceMode: false, prompt, seed: 7, settings, sourceWidth: 1088, sourceHeight: 1920, hasLastFrame: false, referenceCounts: { images: 1, videos: 0, audios: 0, videoAudioFlags: [] } });
assert.equal(plain.capabilityId, "h3_fl2va"); assert.equal(plain.workflowIdentity.templateFile, "h3-workflow.json"); assert.equal("anchorFrames" in plain.parameters, false);
await assert.rejects(snapshotH3({ referenceMode: false, prompt, seed: 7, settings, sourceWidth: 0, sourceHeight: 0, hasLastFrame: true, referenceCounts: { images: 1, videos: 0, audios: 0, videoAudioFlags: [] }, guides: [{ frameIdx: 70 }] }), /只支持首帧图生视频/);

// Engine record includes the AddGuide class; the capability counts as an H3 generation (Shot candidates).
assert.ok(h3ClassTypesFor("i2va_guide").includes("MiniMaxH3AddGuide"));
assert.equal(h3ClassTypesFor("i2va").includes("MiniMaxH3AddGuide"), false);
assert.equal(isH3Capability("h3_addguide_experimental"), true);
assert.equal(isH3Capability("seedvr2_upscale"), false);
assert.match(H3_ADDGUIDE_NOTE, /不保证动作在该帧发生/);

console.log("H3 AddGuide (🧪): frozen templates, 1/2-guide wiring + ordering, refusals, I2VA-only routing, unchanged plain path, snapshot identity passed");
