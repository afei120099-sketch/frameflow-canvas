import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { H3_WORKFLOW_OPTIONS, workflowBlockedReason } from "../lib/h3-workflow-options.ts";
assert.equal(H3_WORKFLOW_OPTIONS.length, 4);
for (const id of [undefined, 'stable', 'h3-extend']) assert.match(workflowBlockedReason(id), /已停用/);
for (const id of ["community-ultimate", "community-dialogue"]) assert.equal(workflowBlockedReason(id), null, "validated workflows available");
assert.ok(workflowBlockedReason("unknown"), "unknown selection must not silently fall back");
for (const name of ["h3-community-ultimate.json", "h3-community-dialogue.json"]) {
  const workflow = JSON.parse(readFileSync(new URL("../lib/comfyui/experimental/" + name, import.meta.url), "utf8"));
  assert.equal(workflow["136"].class_type, "MiniMaxH3ReferenceToVideo");
  assert.equal(Object.keys(workflow["136"].inputs).filter(k => k.startsWith("ref_images.")).length, 4);
  assert.equal(workflow["148"].class_type, "VHS_VideoCombine");
}
const source = readFileSync(new URL("../app/canvas-workspace.tsx", import.meta.url), "utf8");
assert.ok(source.includes("workflowOptionId: T.optional(T.string)"), "saved canvas field");
const generate = source.slice(source.indexOf("  const generate = async () => {"));
assert.ok(generate.indexOf("workflowBlockedReason") < generate.indexOf('setProgress({ status: "preparing"'), "block before records/uploads/submission");
const mediaSource=readFileSync(new URL('../components/canvas/media-workshop-node.tsx',import.meta.url),'utf8');
const mediaGenerate=mediaSource.slice(mediaSource.indexOf(' const generate=async()=>{'));
assert.ok(mediaGenerate.indexOf('LEGACY_H3_RETIRED_MESSAGE')<mediaGenerate.indexOf('getLocalAudioBlob(p.audioSrc)'), 'retired audio-lock blocked before reading/uploading media');
assert.ok(mediaSource.includes('(!music&&!p.pendingId)||busy'), 'retired generation disabled, history and pending-query recovery retained');
console.log("PASS retired stable/extend are blocked; ultimate/fast unchanged; audio-lock blocked before uploads, original history/pending queries retained.");
