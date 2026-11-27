// 生产线「从画布匹配」: episode file names ↔ canvas roles / assets (pure matcher, no IndexedDB).
import assert from "node:assert/strict";
import { describeSlots, planFill, suggest, rolePartAsset, AUTO_FILL_SCORE } from "../lib/production-canvas-match.ts";

const episode = {
  roles: [
    { key: "zhangsan", name: "张三", face: "zhangsan_face.png", appearance: ["zhangsan_appearance.png"], voice: "zhangsan_voice.wav" },
    { key: "lisi", name: "李四", face: "lisi_face.png", appearance: ["lisi_appearance.png", "lisi_look2.png"], voice: "lisi_voice.wav" },
    { key: "r-00000000-0000-4000-8000-000000000013", name: "配角", face: "extra_face.png", appearance: [], voice: null },
  ],
  shots: [
    { shotId: "A15", storyboard: "A15.png", dialogue: [{ roleId: "lisi", text: "x" }] },
    { shotId: "A16", storyboard: "A16.png", dialogue: [] },
    { shotId: "A17", storyboard: "shot_A17_v2.png", dialogue: [] },
    { shotId: "A18", storyboard: "aaaa-bbbb.png", dialogue: [] },
    { shotId: "A19", storyboard: "nothing_like_it.png", dialogue: [] },
  ],
};
const role = (roleId, displayName, pageIds, extra = {}) => ({ roleId, displayName, description: "", pageIds, faceAssetId: `${roleId}-face`, appearanceAssetIds: [`${roleId}-app`, `${roleId}-app2`], primaryAppearanceAssetId: `${roleId}-app`, voiceAssetId: `${roleId}-voice`, ...extra });
const roles = [
  role("r-roleA", "张三", ["p1"]), role("r-roleB", "李四", ["p1"]),
  role("r-roleA-old", "张三", ["p2"]), role("r-roleB-old", "李四", ["p2"], { faceAssetId: null }),
  role("r-00000000-0000-4000-8000-000000000013", "随便叫", ["p1"]),
];
const asset = (assetId, filename, pageIds, kind = "image", createdAt = 1) => ({ assetId, filename, kind, pageIds, createdAt });
const assets = [asset("s15", "A15.png", ["p1"]), asset("s16", "a16.PNG", ["p1"]), asset("s17", "A17 分镜.jpg", ["p1"]), asset("aaaa-bbbb", "random.png", ["p1"]), asset("old15", "A15.png", ["p2"])];

const names = ["A15.png", "A16.png", "shot_A17_v2.png", "aaaa-bbbb.png", "nothing_like_it.png", "zhangsan_face.png", "zhangsan_appearance.png", "zhangsan_voice.wav", "lisi_face.png", "lisi_look2.png", "lisi_voice.wav", "extra_face.png"];
const slots = describeSlots(episode, names);
assert.deepEqual(slots.map((s) => s.kind), ["storyboard", "storyboard", "storyboard", "storyboard", "storyboard", "face", "appearance", "voice", "face", "appearance", "voice", "face"]);
assert.equal(slots.find((s) => s.name === "zhangsan_voice.wav").media, "audio");

// Without choosing a page, the same role on two pages is ambiguous → never auto-filled.
const mixed = suggest(slots[5], roles, assets);
assert.equal(mixed.ambiguous, true);

const { pageId, plan } = planFill(slots, roles, assets, ["p1", "p2"]);
assert.equal(pageId, "p1", "the page that answers the most slots wins");
const pick = Object.fromEntries(plan.map((p) => [p.slot.name, p]));
assert.deepEqual(pick["A15.png"].suggestion.source, { type: "asset", assetId: "s15" });
assert.equal(pick["A15.png"].auto, true);
assert.equal(pick["A16.png"].auto, true, "case-only differences still match");
assert.equal(pick["shot_A17_v2.png"].suggestion?.source.assetId, "s17");
assert.equal(pick["shot_A17_v2.png"].auto, false, "a shot-id hit is suggested, not auto-filled");
assert.deepEqual(pick["aaaa-bbbb.png"].suggestion.source, { type: "asset", assetId: "aaaa-bbbb" }, "assetId codes work like the queue JSON");
assert.equal(pick["nothing_like_it.png"].suggestion, null);
assert.deepEqual(pick["zhangsan_face.png"].suggestion.source, { type: "role", roleId: "r-roleA", part: "face" });
assert.deepEqual(pick["zhangsan_appearance.png"].suggestion.source, { type: "role", roleId: "r-roleA", part: "appearance" });
assert.deepEqual(pick["zhangsan_voice.wav"].suggestion.source, { type: "role", roleId: "r-roleA", part: "voice" });
assert.equal(pick["lisi_look2.png"].suggestion.source.part, "appearance:1", "second appearance uses the role's next image");
assert.equal(pick["extra_face.png"].suggestion.reason, "角色编码相同 · 脸部参考", "role key = canvas roleId");
for (const name of ["A15.png", "zhangsan_face.png", "zhangsan_appearance.png", "zhangsan_voice.wav", "lisi_face.png", "lisi_voice.wav", "extra_face.png"]) assert.equal(pick[name].auto, true, name);

// The page the canvas is showing wins when it answers anything; a role without a face crop falls back to its appearance.
const old = planFill(slots, roles, assets, ["p1", "p2"], "p2");
assert.equal(old.pageId, "p2");
const roleBFace = old.plan.find((p) => p.slot.name === "lisi_face.png").suggestion;
assert.deepEqual(roleBFace.source, { type: "role", roleId: "r-roleB-old", part: "appearance" });
assert.ok(roleBFace.score >= AUTO_FILL_SCORE);
assert.equal(rolePartAsset(roles[3], "appearance"), "r-roleB-old-app");

console.log("production canvas match: ok");
