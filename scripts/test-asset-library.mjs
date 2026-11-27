import assert from "node:assert/strict";
import "./fake-indexeddb.mjs";
import { assetNodeProps, assetShotStatus, assetSourceLabel, filterAssets, formatAssetMeta, isLibraryAsset, OwnedObjectUrls, roleKindForAsset, rolesUsingAsset } from "../lib/asset-library.ts";
import { createRun, getAsset, getRun, listAssets, registerAsset, renameAsset, updateRun } from "../lib/production-records.ts";
import { normalizeAssetFilename } from "../lib/asset-name.ts";
import { addRoleAsset, createRole, getRole } from "../lib/role-records.ts";

const asset = (assetId, kind, filename, createdAt, extra = {}) => ({ schemaVersion: 1, assetId, kind, origin: "imported", filename, mimeType: kind === "image" ? "image/png" : kind === "audio" ? "audio/wav" : "video/mp4", createdAt, storageReference: `${kind === "audio" ? "audio" : kind === "image" ? "image" : "media"}:${assetId}`, sourceRunId: null, ...extra });
const sample = [
  asset("i1", "image", "柴犬正面.png", 3, { width: 1024, height: 1024 }),
  asset("v1", "video", "镜头01.mp4", 5, { width: 960, height: 544, duration: 5.875, fps: 24 }),
  asset("a1", "audio", "柴犬.wav", 1, { duration: 3.2 }),
  // Misleading extension: kind decides, never the filename.
  asset("a2", "audio", "not-a-video.mp4", 4),
  asset("i2", "image", "橘猫.webp", 2),
];

// Visibility is a panel-only filter, never a database deletion.
{
  const generated = asset('generated', 'image', 'Frameflow_Frame_HD_00008_.png', 10, { origin: 'generated' });
  const unknown = asset('unknown', 'image', 'old.png', 9, { origin: 'unknown' });
  const derived = asset('derived', 'audio', 'cut.wav', 8, { derivationType: 'audio_clip' });
  assert.deepEqual([...sample, generated, unknown, derived].filter(isLibraryAsset).map(item => item.assetId), sample.map(item => item.assetId));
  const stored = await registerAsset({ kind: 'image', origin: 'generated', filename: 'frame.png', mimeType: 'image/png', storageReference: 'image:generated', sourceRunId: null });
  assert.equal(isLibraryAsset(stored), false);
  assert.ok((await listAssets()).some(item => item.assetId === stored.assetId));
  assert.equal((await getAsset(stored.assetId)).assetId, stored.assetId);
  assert.equal(assetNodeProps(stored).props.assetId, stored.assetId);
}

// 1. Categories strictly by Asset.kind.
assert.deepEqual(filterAssets(sample, { kind: "image", search: "", sort: "newest" }).map((item) => item.assetId), ["i1", "i2"]);
assert.deepEqual(filterAssets(sample, { kind: "video", search: "", sort: "newest" }).map((item) => item.assetId), ["v1"]);
assert.deepEqual(filterAssets(sample, { kind: "audio", search: "", sort: "newest" }).map((item) => item.assetId), ["a2", "a1"]);
assert.equal(filterAssets(sample, { kind: "all", search: "", sort: "newest" }).length, 5);

// 2. Filename search (case-insensitive, trimmed).
assert.deepEqual(filterAssets(sample, { kind: "all", search: " 柴犬 ", sort: "newest" }).map((item) => item.assetId), ["i1", "a1"]);
assert.deepEqual(filterAssets(sample, { kind: "all", search: "MP4", sort: "newest" }).map((item) => item.assetId), ["v1", "a2"]);
assert.deepEqual(filterAssets(sample, { kind: "video", search: "不存在", sort: "newest" }), []);

// 3. Sorting.
assert.deepEqual(filterAssets(sample, { kind: "all", search: "", sort: "newest" }).map((item) => item.createdAt), [5, 4, 3, 2, 1]);
assert.deepEqual(filterAssets(sample, { kind: "all", search: "", sort: "oldest" }).map((item) => item.createdAt), [1, 2, 3, 4, 5]);
assert.deepEqual(filterAssets([asset("n10", "image", "shot10.png", 1), asset("n2", "image", "shot2.png", 2), asset("n1", "image", "shot1.png", 3)], { kind: "all", search: "", sort: "name" }).map((item) => item.filename), ["shot1.png", "shot2.png", "shot10.png"]);
assert.equal(sample[0].assetId, "i1", "filtering never mutates the source list");

// 4. Placing the same Asset twice: two node specs pointing at the same Asset and Blob; nothing is registered.
{
  const stored = await registerAsset({ kind: "video", origin: "imported", filename: "reuse.mp4", mimeType: "video/mp4", storageReference: "media:reuse", sourceRunId: null, width: 640, height: 360, duration: 4, fps: 24, fileSize: 2_000_000 });
  const before = (await listAssets()).length;
  const first = assetNodeProps(stored);
  const second = assetNodeProps(stored);
  assert.equal(first.type, "video-node");
  assert.deepEqual(first, second);
  assert.equal(first.props.src, "media:reuse", "the node reuses the stored Blob reference");
  assert.equal(first.props.assetId, stored.assetId, "the node reuses the Asset identity");
  assert.equal((await listAssets()).length, before, "no Asset created by placing");
  assert.equal(first.props.size, "1.9 MB");
  assert.equal(first.props.duration, "4.0 秒");
  assert.deepEqual(assetNodeProps(sample[0]), { type: "image-node", props: { src: "image:i1", name: "柴犬正面.png", originalPath: "柴犬正面.png", assetId: "i1", naturalWidth: 1024, naturalHeight: 1024 } });
  assert.equal(assetNodeProps(sample[2]).type, "audio-node");
  assert.equal(assetNodeProps(sample[2]).props.src, "audio:a1");
  assert.throws(() => assetNodeProps(asset("legacyVoice", "audio", "role-upload.m4a", 1, { storageReference: "media:voice" })), /暂不能放到画布/);
}

// 5-7. Role reuse via the existing addRoleAsset: image → appearance, audio → voice, no duplicates.
{
  const image = await registerAsset({ kind: "image", origin: "imported", filename: "dog.png", mimeType: "image/png", storageReference: "image:lib-dog", sourceRunId: null });
  const voice = await registerAsset({ kind: "audio", origin: "imported", filename: "dog.wav", mimeType: "audio/wav", storageReference: "audio:lib-dog", sourceRunId: null });
  const role = await createRole("柴犬");
  assert.equal(roleKindForAsset(image), "image");
  assert.equal(roleKindForAsset(voice), "audio");
  assert.equal(roleKindForAsset(sample[1]), null, "video cannot join a Role");
  assert.equal((await addRoleAsset(role.roleId, image.assetId, roleKindForAsset(image))).added, true);
  assert.equal((await addRoleAsset(role.roleId, voice.assetId, roleKindForAsset(voice))).added, true);
  assert.equal((await addRoleAsset(role.roleId, image.assetId, "image")).added, false);
  assert.equal((await addRoleAsset(role.roleId, voice.assetId, "audio")).added, false);
  const saved = await getRole(role.roleId);
  assert.deepEqual(saved.appearanceAssetIds, [image.assetId]);
  assert.deepEqual(saved.voiceAssetIds, [voice.assetId]);
  assert.deepEqual(rolesUsingAsset(image.assetId, [saved]), [{ roleId: role.roleId, displayName: "柴犬", uses: ["主外观"] }]);
  assert.deepEqual(rolesUsingAsset(voice.assetId, [saved]), [{ roleId: role.roleId, displayName: "柴犬", uses: ["主声音"] }]);
  assert.deepEqual(rolesUsingAsset("unused", [saved]), []);
}

// 8. Source label and lineage come from real records only.
{
  const run = await createRun({ capabilityId: "seedvr2_upscale", inputAssetIds: [], rawPrompt: null, finalPrompt: null, seed: null, parameters: {}, workflowIdentity: { capabilityId: "seedvr2_upscale", templateVersion: "sha256:x", templateFile: "seedvr2-workflow.json" } });
  await updateRun(run.runId, { status: "completed" });
  const runs = new Map([[run.runId, await getRun(run.runId)]]);
  const upscaled = asset("up", "video", "hd.mp4", 1, { origin: "generated", sourceRunId: run.runId });
  assert.equal(assetSourceLabel(upscaled, runs), "SeedVR2");
  const h3Runs = new Map([["r-fl", { capabilityId: "h3_fl2va" }], ["r-ref", { capabilityId: "h3_ref2va" }], ["r-film", { capabilityId: "film_interpolation" }]]);
  assert.equal(assetSourceLabel(asset("g1", "video", "a.mp4", 1, { origin: "generated", sourceRunId: "r-fl" }), h3Runs), "H3生成");
  assert.equal(assetSourceLabel(asset("g2", "video", "a.mp4", 1, { origin: "generated", sourceRunId: "r-ref" }), h3Runs), "H3生成（多参考）");
  assert.equal(assetSourceLabel(asset("g3", "video", "a.mp4", 1, { origin: "generated", sourceRunId: "r-film" }), h3Runs), "FILM");
  assert.equal(assetSourceLabel(asset("g4", "video", "a.mp4", 1, { origin: "generated", sourceRunId: "missing" }), h3Runs), "生成（Run 记录缺失）", "never invented");
  assert.equal(assetSourceLabel(asset("x1", "audio", "e.wav", 1, { origin: "generated", derivationType: "audio_extract", sourceVideoAssetId: "v1" }), h3Runs), "视频提取声音");
  assert.equal(assetSourceLabel(asset("x2", "audio", "c.wav", 1, { origin: "generated", derivationType: "audio_clip", sourceAudioAssetId: "x1" }), h3Runs), "声音裁剪");
  assert.equal(assetSourceLabel(sample[0], h3Runs), "导入");
  assert.equal(assetSourceLabel(asset("old", "video", "old.mp4", 1, { origin: "unknown" }), h3Runs), "旧版素材（来源未记录）");
  const clip = assetNodeProps(asset("x2", "audio", "c.wav", 1, { derivationType: "audio_clip", sourceAudioAssetId: "x1", sourceVideoAssetId: "v1" }));
  assert.equal(clip.props.sourceAudioAssetId, "x1");
  assert.equal(clip.props.sourceVideoAssetId, "v1");
}

// 9. Adopted ★ vs candidate vs derived version.
{
  const runs = new Map([["h3run", { capabilityId: "h3_fl2va" }], ["hdrun", { capabilityId: "seedvr2_upscale" }]]);
  const shot = { shotId: "s1", adoptedAssetId: "adopted", title: "镜头 01" };
  assert.deepEqual(assetShotStatus(asset("adopted", "video", "a.mp4", 1, { shotId: "s1", sourceRunId: "h3run" }), shot, runs), { label: "★ 已采用", adopted: true });
  assert.deepEqual(assetShotStatus(asset("cand", "video", "b.mp4", 1, { shotId: "s1", sourceRunId: "h3run" }), shot, runs), { label: "候选", adopted: false });
  assert.deepEqual(assetShotStatus(asset("hd", "video", "c.mp4", 1, { shotId: "s1", sourceRunId: "hdrun" }), shot, runs), { label: "镜头衍生版本", adopted: false });
  assert.equal(assetShotStatus(sample[0], null, runs), null);
}

// 10. Missing metadata never crashes.
{
  const bare = { schemaVersion: 1, assetId: "bare", kind: "video", origin: "unknown", filename: undefined, mimeType: "", createdAt: undefined, storageReference: "media:bare", sourceRunId: null };
  assert.equal(formatAssetMeta(bare), "");
  assert.doesNotThrow(() => filterAssets([bare, ...sample], { kind: "all", search: "x", sort: "name" }));
  assert.doesNotThrow(() => filterAssets([bare, ...sample], { kind: "all", search: "", sort: "oldest" }));
  assert.equal(assetNodeProps(bare).props.duration, "—");
  assert.equal(assetNodeProps(bare).props.size, "—");
  assert.equal(assetSourceLabel(bare, new Map()), "旧版素材（来源未记录）");
  assert.equal(formatAssetMeta(asset("nan", "video", "n.mp4", 1, { duration: Number.NaN, fps: Number.POSITIVE_INFINITY })), "");
  assert.equal(isLibraryAsset({ ...bare, storageReference: "legacy-inline:abc" }), false, "inline legacy media is not offered for reuse");
}

// 10b. Renaming changes only the display name.
{
  assert.equal(normalizeAssetFilename("  雨夜进门  "), "雨夜进门");
  assert.equal(normalizeAssetFilename("客厅  门口"), "客厅 门口");
  assert.throws(() => normalizeAssetFilename("   "), /名称不能为空/);
  assert.throws(() => normalizeAssetFilename("a/b"), /斜杠/);
  assert.throws(() => normalizeAssetFilename("名".repeat(81)), /80/);
  const stored = await registerAsset({ kind: "image", origin: "imported", filename: "image.jpg", mimeType: "image/jpeg", storageReference: "image:scene-door", sourceRunId: null, width: 784, height: 1168 });
  const renamed = await renameAsset(stored.assetId, "雨夜进门");
  assert.equal(renamed.filename, "雨夜进门");
  assert.equal(renamed.assetId, stored.assetId);
  assert.equal(renamed.storageReference, "image:scene-door");
  const again = await getAsset(stored.assetId);
  assert.equal(again.filename, "雨夜进门");
  assert.equal((await renameAsset(stored.assetId, "雨夜进门")).filename, "雨夜进门");
  await assert.rejects(renameAsset(stored.assetId, "  "), /名称不能为空/);
  await assert.rejects(renameAsset("missing-asset", "门口"), /素材不存在/);
  assert.equal((await getAsset(stored.assetId)).filename, "雨夜进门");
}

// 11. 500 metadata-only Assets: filter/search/sort stays fast and never touches Blobs.
{
  const kinds = ["image", "video", "audio"];
  const many = Array.from({ length: 500 }, (_, index) => asset(`m${index}`, kinds[index % 3], `素材_${String(index).padStart(3, "0")}_${index % 7 === 0 ? "柴犬" : "场景"}.bin`, index, { width: 1920, height: 1080 }));
  const started = performance.now();
  let result;
  for (let round = 0; round < 50; round += 1) result = filterAssets(many, { kind: round % 2 ? "video" : "all", search: round % 3 ? "柴犬" : "", sort: round % 2 ? "name" : "newest" });
  const perRound = (performance.now() - started) / 50;
  assert.ok(perRound < 20, `500 Assets filtered in ${perRound.toFixed(2)} ms per pass`);
  assert.ok(result.length > 0);
  assert.equal(filterAssets(many, { kind: "all", search: "柴犬", sort: "newest" }).length, many.filter((item) => item.filename.includes("柴犬")).length);
  console.log(`  500 Assets: ${perRound.toFixed(2)} ms per filter+search+sort pass`);
}

// 12. Object URLs created by the library are released when it closes.
{
  const created = []; const revoked = [];
  const urls = new OwnedObjectUrls({ createObjectURL: () => { const url = `blob:test/${created.length}`; created.push(url); return url; }, revokeObjectURL: (url) => revoked.push(url) });
  const a = urls.create(new Blob(["a"]));
  urls.create(new Blob(["b"]));
  urls.adopt("blob:external");
  urls.release(a);
  assert.deepEqual(revoked, [a]);
  urls.release("blob:not-owned");
  assert.deepEqual(revoked, [a], "only owned URLs are revoked");
  assert.equal(urls.size, 2);
  urls.revokeAll();
  assert.deepEqual(revoked.sort(), [a, "blob:external", "blob:test/1"].sort());
  assert.equal(urls.size, 0);
}

console.log("Asset Library categories, search, sort, reuse without copies, Role reuse, lineage, adopted status, missing metadata, 500-Asset filtering and URL release passed");
