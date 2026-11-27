import assert from "node:assert/strict";
import { parseQuery, searchAll } from "../lib/global-search.ts";

const run = (runId, capabilityId, status, outputAssetIds, shotId) => ({ runId, capabilityId, status, outputAssetIds, inputAssetIds: [], shotId, createdAt: 1 });
const asset = (assetId, filename, kind, extra = {}) => ({ assetId, filename, kind, storageReference: `${kind}:${assetId}`, sourceRunId: null, createdAt: 1, ...extra });
const data = {
  shots: [
    { shotId: "s1", shotNumber: 1, title: "柴犬开场", runIds: ["r-aaaa1111", "r-bbbb2222"], adoptedAssetId: "vB", adoptedRunId: "r-bbbb2222" },
    { shotId: "s3", shotNumber: 3, title: "橘猫反应", runIds: ["r-cccc3333"], adoptedAssetId: null, adoptedRunId: null },
  ],
  runs: [run("r-aaaa1111", "h3_ref2va", "completed", ["vA"], "s1"), run("r-bbbb2222", "h3_fl2va", "completed", ["vB"], "s1"), run("r-cccc3333", "h3_fl2va", "completed", ["vC"], "s3"), run("r-dddd4444", "seedvr2_upscale", "failed", [], "s1")],
  assets: [asset("img", "柴犬正面.png", "image"), asset("vA", "shot01_A.mp4", "video", { shotId: "s1" }), asset("vB", "shot01_B.mp4", "video", { shotId: "s1" }), asset("vC", "shot03_A.mp4", "video", { shotId: "s3" }), asset("voice", "柴犬.wav", "audio"), asset("old", "旧柴犬.png", "image", { storageReference: "legacy-inline:abc" })],
  roles: [{ roleId: "dog", displayName: "柴犬", description: "红项圈", appearanceAssetIds: ["img"], voiceAssetIds: ["voice"] }, { roleId: "cat", displayName: "橘猫", description: "", appearanceAssetIds: [], voiceAssetIds: [] }],
  nodes: [{ id: "shape:img", type: "image-node", title: "柴犬正面.png", assetId: "img" }, { id: "shape:vB", type: "video-node", title: "shot01_B.mp4", assetId: "vB", shotId: "s1" }, { id: "shape:h3", type: "h3-node", title: "H3 · 柴犬看着橘猫说话" }],
};
const labels = (query) => searchAll(data, query).map((result) => `${result.group}:${result.label}`);
const targets = (query) => searchAll(data, query).map((result) => result.target);

assert.deepEqual(searchAll(data, "   "), []);

// File name / node title / role name.
assert.deepEqual(labels("柴犬"), ["角色:柴犬", "画布节点:柴犬正面.png", "镜头:镜头 01 · 柴犬开场", "素材:柴犬.wav", "素材:柴犬正面.png", "画布节点:H3 · 柴犬看着橘猫说话"]);
assert.ok(!labels("柴犬").some((label) => label.includes("旧柴犬")), "legacy inline media is not offered");
assert.deepEqual(labels("橘猫"), ["角色:橘猫", "镜头:镜头 03 · 橘猫反应", "画布节点:H3 · 柴犬看着橘猫说话"]);
assert.deepEqual(labels("shot01"), ["镜头:镜头 01 · 柴犬开场", "画布节点:shot01_B.mp4", "素材:shot01_A.mp4", "素材:shot01_B.mp4"], "shot01 is read as 镜头 01");
assert.deepEqual(labels("红项圈"), ["角色:柴犬"], "role description");

// Shot number in several spellings.
for (const query of ["镜头 3", "镜头03", "#3", "shot 3"]) assert.deepEqual(labels(query), ["镜头:镜头 03 · 橘猫反应", "素材:shot03_A.mp4"], query);
assert.equal(parseQuery("镜头 12 柴犬").shotNumber, 12);
assert.equal(parseQuery("镜头 12 柴犬").rest, "柴犬");

// Status: ★ adopted / candidate.
assert.deepEqual(labels("已采用"), ["画布节点:shot01_B.mp4", "镜头:镜头 01 · 柴犬开场", "素材:shot01_B.mp4"]);
assert.deepEqual(labels("★"), labels("已采用"));
assert.deepEqual(labels("候选"), ["素材:shot01_A.mp4", "素材:shot03_A.mp4"]);
assert.deepEqual(labels("候选 shot03"), ["素材:shot03_A.mp4"]);
assert.match(searchAll(data, "shot01_A")[0].detail, /候选A · 镜头 01/);
assert.match(searchAll(data, "shot01_B")[0].detail, /★ 已采用/);

// Run IDs by their last characters.
assert.deepEqual(labels("3333"), ["生成记录:Run …cccc3333"]);
assert.deepEqual(targets("run dddd4444"), [{ kind: "run", runId: "r-dddd4444", outputAssetId: null, status: "failed" }], "failed Run without output");
assert.match(searchAll(data, "dddd4444")[0].detail, /SeedVR2 · 失败 · 镜头 01/);
assert.equal(parseQuery("柴犬").runFragment, null, "ordinary words are not Run IDs");

// Targets drive the action: node → locate; asset / shot → locate or open details.
assert.deepEqual(targets("柴犬.wav"), [{ kind: "asset", assetId: "voice" }]);
assert.deepEqual(searchAll(data, "镜头 1").find((result) => result.group === "镜头").target, { kind: "shot", shotId: "s1", adoptedAssetId: "vB" });
assert.deepEqual(searchAll(data, "镜头 1")[0].target, { kind: "shot", shotId: "s1", adoptedAssetId: "vB" }, "shot-number relevance is not overridden by group priority");
assert.deepEqual(searchAll(data, "H3 · 柴犬")[0].target, { kind: "node", nodeId: "shape:h3" });

// Limit and descending relevance; group priority only breaks score ties.
{
  const many = { ...data, nodes: Array.from({ length: 500 }, (_, i) => ({ id: `shape:n${i}`, type: "image-node", title: `柴犬-${i}.png` })), assets: [...data.assets, ...Array.from({ length: 1000 }, (_, i) => asset(`a${i}`, `柴犬素材${i}.png`, "image"))] };
  const started = performance.now();
  const results = searchAll(many, "柴犬", 30);
  const elapsed = performance.now() - started;
  assert.equal(results.length, 30);
  assert.ok(results.every((result,index)=>index===0 || results[index-1].score>=result.score));
  assert.ok(elapsed < 60, `500 nodes + 1000 assets searched in ${elapsed.toFixed(1)} ms`);
  console.log(`  search 500 nodes + 1000 assets: ${elapsed.toFixed(1)} ms`);
}
const exactData={...data,nodes:[{id:'shape:unrelated',type:'h3-node',title:'另一个镜头 柴犬.wav 背景介绍'}]};
assert.equal(searchAll(exactData,'柴犬.wav')[0].id,'asset:voice','exact filename must precede a weaker node match');

console.log("Global search: names, titles, roles, shot numbers, ★ / candidate status, Run-id suffix, targets, legacy exclusion, limits, 500+1000 speed passed");
