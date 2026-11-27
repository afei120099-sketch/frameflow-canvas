import assert from "node:assert/strict";
import { withVideoOutputOptions } from "../lib/comfyui/submission-scheduler.ts";
import { productionPromptBody } from "../lib/production/comfy-client.ts";

const video = { "148": { class_type: "VHS_VideoCombine", inputs: {} }, "1": { class_type: "UNETLoader", inputs: {} } };
const image = { "7": { class_type: "SaveImage", inputs: {} } };

// Canvas scheduler: video graphs get the flag, existing extra_data is kept, image graphs untouched.
const body = { prompt: video, extra_data: { frameflowInstance: "yemian2", extra_pnginfo: { workflow: { extra: { other: 1 } } } } };
assert.equal(withVideoOutputOptions(body), true);
assert.equal(body.extra_data.frameflowInstance, "yemian2");
assert.deepEqual(body.extra_data.extra_pnginfo.workflow.extra, { other: 1, VHS_KeepIntermediate: false });
const plain = { prompt: video };
withVideoOutputOptions(plain);
assert.equal(plain.extra_data.extra_pnginfo.workflow.extra.VHS_KeepIntermediate, false);
const still = { prompt: image };
assert.equal(withVideoOutputOptions(still), false);
assert.equal(still.extra_data, undefined, "image graphs keep clean PNG metadata");

// Production client.
const p = productionPromptBody(video, "id-1");
assert.equal(p.extra_data.frameflowInstance, "production");
assert.equal(p.extra_data.extra_pnginfo.workflow.extra.VHS_KeepIntermediate, false);
assert.equal(productionPromptBody(image, "id-2").extra_data.extra_pnginfo, undefined);
console.log("video output options: ok");
