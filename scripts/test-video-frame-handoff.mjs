import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareKeyframeSubmission, videoFrameHandoffPatch, videoHandoffEdges } from "../lib/video-frame-handoff.ts";
import { buildReferenceManifest } from "../lib/reference-manifest.ts";
import { planH3Submission } from "../lib/comfyui/h3-adapter.ts";
import { readWorkspaceSource } from './workspace-source.mjs';
const original = {
  prompt: "Keep <Picture 1> scene and <Subject 1> appearance",
  referenceImages: [{ src: "image:scene", name: "scene.jpg" }],
  referenceImageOrder: ["scene"], roleIds: ["actor"], seed: "123", steps: 10, loraStrength: 0.75,
  duration: "7", mode: "16:9", workflowOptionId: "community-ultimate", workflowLock: "ultimate-ref2va",
  videoLastFrame: { src: "image:old-tail", name: "tail.jpg", sourceNodeId: "shape:old" },
};
const frame = { src: "image:captured", name: "previous-tail.jpg", sourceNodeId: "shape:previous" };
const first = { ...original, ...videoFrameHandoffPatch("first", frame) };
for (const key of ["prompt", "referenceImages", "referenceImageOrder", "roleIds", "seed", "steps", "loraStrength", "duration", "mode", "workflowOptionId", "videoLastFrame"]) assert.deepEqual(first[key], original[key]);
assert.deepEqual(first.videoFirstFrame, frame);
assert.equal(first.ultimateKeyframes, true);
assert.equal(first.workflowLock, "");
const last = { ...first, ...videoFrameHandoffPatch("last", { ...frame, sourceNodeId: "shape:next" }) };
assert.deepEqual(last.videoFirstFrame, first.videoFirstFrame);
assert.equal(last.prompt, original.prompt);
assert.deepEqual(videoHandoffEdges("right"), { capture: "last", target: "first" });
assert.deepEqual(videoHandoffEdges("left"), { capture: "first", target: "last" });
const image = id => ({ assetId:id, storageReference:"image:"+id, filename:id+".jpg" });
const manifest = buildReferenceManifest({
  images:[{...image("scene"),source:"reference_image"}], videos:[],audios:[],
  roles:[{roleId:"actor",displayName:"actor",description:"",appearanceAssetIds:["face"],voiceAssetIds:[],primaryAppearanceAssetId:"face",primaryVoiceAssetId:null}],
  roleAssets:{face:{...image("face"),kind:"image"}},dialogue:[],soundMode:"av",
  trailingImages:[{...image("first"),source:"first_frame"},{...image("last"),source:"connected_reference"}],
});
assert.deepEqual(manifest.pictureRefs.map(ref=>ref.assetId), ["scene","face","first","last"]);
assert.equal(manifest.roleBindings[0].pictureRefIndex, 2);
const adapted = prepareKeyframeSubmission(manifest, original.prompt, {first:3,last:4});
assert.equal(adapted.prompt, "Keep <Picture 3> scene and <Subject 1> appearance");
assert.deepEqual(adapted.manifest.pictureRefs.map(r=>r.assetId),["first","last","scene","face"]);
assert.equal(adapted.manifest.roleBindings[0].pictureRefIndex,4);
const plan = planH3Submission({
  workflowOptionId:"community-ultimate",taskMode:"ref2va",prompt:original.prompt,compiledPrompt:adapted.prompt,seed:1,
  communityKeyframes:adapted.frames,
  settings:{length:141,aspect:"16:9",megapixels:0.5,turbo:true,steps:10,fps:24,loraStrength:0.75,upscaleMethod:"lanczos",resolutionSteps:32,soundMode:"av"},
},{references:{images:adapted.manifest.pictureRefs.map(r=>r.filename),videos:[],audios:[]}});
assert.equal(plan.workflow["136"].class_type,"MiniMaxH3AudioConditioningT8");
assert.deepEqual(plan.workflow["136"].inputs.first_frame,["ff-community-image-0",0]);
assert.deepEqual(plan.workflow["136"].inputs.last_frame,["ff-community-image-1",0]);
assert.deepEqual(plan.workflow["136"].inputs["ref_images.ref_image_0"],["ff-community-image-2",0]);
assert.deepEqual(plan.workflow["136"].inputs["ref_images.ref_image_1"],["ff-community-image-3",0]);
const tailOnly = prepareKeyframeSubmission(manifest, original.prompt, {last:4});
assert.equal(tailOnly.frames.last,1);
const tailPlan = planH3Submission({
  workflowOptionId:"community-ultimate",taskMode:"ref2va",prompt:original.prompt,compiledPrompt:tailOnly.prompt,seed:1,
  communityKeyframes:tailOnly.frames,
  settings:{length:141,aspect:"16:9",megapixels:0.5,turbo:true,steps:10,fps:24,loraStrength:0.75,upscaleMethod:"lanczos",resolutionSteps:32,soundMode:"av"},
},{references:{images:tailOnly.manifest.pictureRefs.map(r=>r.filename),videos:[],audios:[]}});
assert.equal(tailPlan.workflow["136"].inputs.first_frame,undefined);
assert.deepEqual(tailPlan.workflow["136"].inputs.last_frame,["ff-community-image-0",0]);
assert.equal(tailPlan.workflow["136"].inputs.task_type,"Hybrid");
assert.equal(original.prompt,"Keep <Picture 1> scene and <Subject 1> appearance");
const source = readWorkspaceSource();
const handler = source.slice(source.indexOf("async function handoffVideoFrame("),source.indexOf("async function runPortAction("));
assert.doesNotMatch(handler,/createH3Node|createImageNodeForAsset|\.generate\(/);
assert.match(handler,/getShape\(targetIdResolved\)/);
console.log("PASS: both frame directions, existing target only, no auto-generation/new media node, prompt/references/roles/parameters/opposite frame retained, Picture and role semantics adapted to native T8 keyframe-first ordering");
