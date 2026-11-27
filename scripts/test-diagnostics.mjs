import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { diagnosticsReport, runDiagnostics } from "../lib/diagnostics.ts";
import { buildH3Workflow } from "../lib/comfyui/h3-adapter.ts";
import { buildReferenceWorkflow, buildSeedVR2Workflow } from "../lib/comfyui/extra-workflows.ts";
import { buildFilmWorkflow } from "../lib/comfyui/film-workflow.ts";

const json = async (name) => JSON.parse(await readFile(new URL(`../lib/comfyui/${name}`, import.meta.url), "utf8"));
const REF = { length: 141, aspect: "16:9", megapixels: 0.5, turbo: true, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: "lanczos", resolutionSteps: 32 };
// The real frozen templates and builders (same list the browser uses).
const realTemplates = [
  { name: "h3-workflow.json", template: await json("h3-workflow.json"), build: () => buildH3Workflow("d.png", "d", 1), requiredNodes: { 6: "MiniMaxH3ImageToVideo", 15: "SaveVideo", 20: "LoadImage" } },
  { name: "h3-reference-workflow.json", template: await json("h3-reference-workflow.json"), build: () => buildReferenceWorkflow({ images: ["d.png"], videos: [], audios: [] }, "d", 1, REF), requiredNodes: { 92: "SaveVideo", 136: "MiniMaxH3ReferenceToVideo", 138: "PrimitiveStringMultiline" } },
  { name: "seedvr2-workflow.json", template: await json("seedvr2-workflow.json"), build: () => buildSeedVR2Workflow("d.mp4"), requiredNodes: { 73: "LoadVideo", 76: "SaveVideo", "66:52": "UNETLoader", "66:105": "PrimitiveBoolean" } },
  { name: "film-workflow.json", template: await json("film-workflow.json"), build: () => buildFilmWorkflow("d.mp4"), requiredNodes: { 7: "SaveVideo", "16:1": "FrameInterpolationModelLoader", "16:2": "FrameInterpolate", "16:9": "PrimitiveInt" } },
];
const healthy = () => ({
  systemStats: async () => ({ status: 200, body: { system: { comfyui_version: "0.34.0" }, devices: [{ name: "RTX 4070 Ti SUPER", vram_total: 16 * 1024 ** 3, vram_free: 12 * 1024 ** 3 }] } }),
  templates: realTemplates,
  adapterConfig: { serverUrl: "http://127.0.0.1:8188", proxyPath: "/comfyui", saveNodes: { h3_fl2va: "15", h3_ref2va: "92", seedvr2_upscale: "76", film_interpolation: "7" }, webSocketUrl: "ws://127.0.0.1:8188/ws" },
  records: async () => ({
    assets: [{ assetId: "a1", filename: "dog.png", storageReference: "image:i1" }, { assetId: "v1", filename: "shot.mp4", storageReference: "media:m1", sourceRunId: "r1", shotId: "s1" }, { assetId: "w1", filename: "voice.wav", storageReference: "audio:w1", derivationType: "audio_extract", sourceVideoAssetId: "v1" }],
    runs: [{ runId: "r1", outputAssetIds: ["v1"] }],
    shots: [{ shotId: "s1", shotNumber: 1, runIds: ["r1"], adoptedAssetId: "v1", adoptedRunId: "r1" }],
    roles: [{ roleId: "dog", displayName: "柴犬", appearanceAssetIds: ["a1"], voiceAssetIds: ["w1"], primaryAppearanceAssetId: "a1", primaryVoiceAssetId: "w1" }],
  }),
  mediaKeys: async () => ({ images: ["i1"], videos: ["m1"], audios: ["w1"] }),
  audioEndpoint: async () => ({ status: 400, body: JSON.stringify({ code: "INVALID_OPERATION", message: "未知音频操作" }) }),
  browser: { directoryPicker: true, folderInput: true, indexedDB: true },
  databases: async () => [{ name: "frameflow-production-records", ok: true, detail: "v2 · assets 3" }],
});
const byId = (results) => Object.fromEntries(results.map((result) => [result.id, result]));

// All healthy — including the REAL frozen templates (unmodified, buildable without submitting).
{
  const results = await runDiagnostics(healthy());
  assert.deepEqual(results.map((result) => result.id), ["comfy-online", "comfy-stats", "templates", "adapter", "blobs", "roles", "lineage", "audio", "backup", "indexeddb"], "10 checks, fixed order");
  assert.ok(results.every((result) => result.status === "pass"), JSON.stringify(results.filter((result) => result.status !== "pass")));
  assert.match(byId(results)["comfy-stats"].detail, /ComfyUI 0\.34\.0 · RTX 4070 Ti SUPER · 显存 16\.0 GB（空闲 12\.0 GB）/);
  assert.match(byId(results).audio.detail, /未执行 PyAV/, "the audio check says what it did not verify");
  const report = diagnosticsReport(results, 0);
  assert.match(report, /^Frameflow 诊断报告/);
  assert.equal(report.split("\n").filter((line) => line.startsWith("✓")).length, 10);
}

// ComfyUI offline / proxy error.
{
  const offline = byId(await runDiagnostics({ ...healthy(), systemStats: async () => { throw new TypeError("Failed to fetch"); } }));
  assert.equal(offline["comfy-online"].status, "fail");
  assert.match(offline["comfy-online"].detail, /Failed to fetch/);
  const bad = byId(await runDiagnostics({ ...healthy(), systemStats: async () => ({ status: 502, body: null }) }));
  assert.match(bad["comfy-online"].detail, /HTTP 502/);
  assert.equal(bad.templates.status, "pass", "other checks still run");
}

// A template missing a node / failing to build is reported per template.
{
  const broken = structuredClone(realTemplates[2].template); broken["76"].class_type = "PreviewImage";
  const templates = [...realTemplates.slice(0, 2), { ...realTemplates[2], template: broken }, { ...realTemplates[3], build: () => { throw new Error("FILM 模板节点 16:2 类型不符"); } }];
  const result = byId(await runDiagnostics({ ...healthy(), templates })).templates;
  assert.equal(result.status, "fail");
  assert.deepEqual(result.items, ["seedvr2-workflow.json：节点 76 应为 SaveVideo，实际 PreviewImage", "film-workflow.json：构建任务副本失败 · FILM 模板节点 16:2 类型不符"]);
}

// Adapter configuration problems.
{
  const result = byId(await runDiagnostics({ ...healthy(), adapterConfig: { serverUrl: "http://10.0.0.5:8188", proxyPath: "comfyui", saveNodes: { h3_fl2va: "15" }, webSocketUrl: "http://x" } })).adapter;
  assert.equal(result.status, "fail");
  assert.equal(result.items.length, 6);
}

// Missing media, legacy-only, broken Role references, lineage breaks.
{
  const data = await healthy().records();
  data.assets.push({ assetId: "gone", filename: "lost.mp4", storageReference: "media:missing" }, { assetId: "old", filename: "old.png", storageReference: "legacy-inline:abc" });
  data.roles[0].voiceAssetIds.push("nope"); data.roles[0].primaryVoiceAssetId = "zzz";
  data.shots.push({ shotId: "s2", shotNumber: 2, runIds: ["ghost-run"], adoptedAssetId: "ghost-asset", adoptedRunId: null });
  data.assets.push({ assetId: "clip", filename: "clip.wav", storageReference: "audio:w1", sourceAudioAssetId: "deleted", shotId: "no-shot" });
  const results = byId(await runDiagnostics({ ...healthy(), records: async () => data }));
  assert.equal(results.blobs.status, "fail");
  assert.deepEqual(results.blobs.items, ["lost.mp4（media:missing）"]);
  assert.equal(results.roles.status, "fail");
  assert.deepEqual(results.roles.items, ["角色“柴犬”引用了不存在的 Asset nope", "角色“柴犬”的主声音不在其素材列表中"]);
  assert.equal(results.lineage.status, "warn");
  assert.deepEqual(results.lineage.items.sort(), ["clip.wav 所属镜头不存在", "clip.wav 的上游素材（sourceAudioAssetId）不存在", "镜头 2 引用了不存在的 Run ghost-run", "镜头 2 的 ★采用版本 Asset 不存在"].sort());
  const legacyOnly = byId(await runDiagnostics({ ...healthy(), records: async () => ({ ...(await healthy().records()), assets: [...(await healthy().records()).assets, { assetId: "old", filename: "old.png", storageReference: "data:image/png;base64,AA" }] }) })).blobs;
  assert.equal(legacyOnly.status, "warn");
  const unreadable = byId(await runDiagnostics({ ...healthy(), mediaKeys: async () => { throw new Error("IDB blocked"); } }));
  assert.deepEqual([unreadable.blobs.status, unreadable.roles.status, unreadable.lineage.status], ["fail", "fail", "fail"]);
}

// Audio endpoint: 404 (production build), 403, network error.
{
  assert.equal(byId(await runDiagnostics({ ...healthy(), audioEndpoint: async () => ({ status: 404, body: "<html>" }) })).audio.status, "fail");
  assert.equal(byId(await runDiagnostics({ ...healthy(), audioEndpoint: async () => ({ status: 403, body: "" }) })).audio.status, "warn");
  assert.match(byId(await runDiagnostics({ ...healthy(), audioEndpoint: async () => { throw new Error("timeout"); } })).audio.detail, /timeout/);
}

// Backup capability and databases.
{
  assert.equal(byId(await runDiagnostics({ ...healthy(), browser: { directoryPicker: false, folderInput: true, indexedDB: true } })).backup.status, "warn");
  assert.equal(byId(await runDiagnostics({ ...healthy(), browser: { directoryPicker: false, folderInput: false, indexedDB: true } })).backup.status, "fail");
  const db = byId(await runDiagnostics({ ...healthy(), databases: async () => [{ name: "a", ok: true, detail: "v1" }, { name: "b", ok: false, detail: "blocked" }] })).indexeddb;
  assert.equal(db.status, "fail");
  assert.deepEqual(db.items, ["a：v1", "b：blocked"]);
}

// Long lists are shortened, not dropped silently.
{
  const data = await healthy().records();
  for (let i = 0; i < 30; i += 1) data.assets.push({ assetId: `x${i}`, filename: `x${i}.mp4`, storageReference: `media:none${i}` });
  const result = byId(await runDiagnostics({ ...healthy(), records: async () => data })).blobs;
  assert.equal(result.items.length, 13);
  assert.equal(result.items.at(-1), "…另外 18 项");
  assert.match(result.detail, /30 \/ 33/);
}

console.log("Diagnostics: 10 read-only checks incl. real frozen templates, offline / HTTP errors, broken templates, adapter config, missing media, legacy, Role refs, lineage, audio endpoint, backup, databases, report passed");
