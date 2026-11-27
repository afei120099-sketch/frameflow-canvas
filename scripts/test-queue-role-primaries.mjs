// 第 13 条：自动入队前补「主外观」不再写死《李四》的素材 ID，也不再悄悄挑第一张。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { planQueuePrimaries } from "../lib/queue-role-primaries.ts";

const queue = (shots) => ({ chapters: [{ shots }] });
const role = (roleId, appearanceAssetIds, primaryAppearanceAssetId) => ({ roleId, displayName: roleId.toUpperCase(), appearanceAssetIds, primaryAppearanceAssetId });

// 已有主外观：什么都不改
assert.deepEqual(planQueuePrimaries(queue([{ roleIds: ["a"] }]), [role("a", ["x", "y"], "y")]), { set: [], error: null });
// 只有一张外观图：唯一选择，可以补上
assert.deepEqual(planQueuePrimaries(queue([{ roleIds: ["a"] }]), [role("a", ["x"])]), { set: [{ roleId: "a", assetId: "x", name: "A" }], error: null });
// 同一张图登记两次也算一张
assert.equal(planQueuePrimaries(queue([{ roleIds: ["a"] }]), [role("a", ["x", "x"])]).set[0].assetId, "x");
// 多张外观图、没选主外观：不替用户挑，拦下并说明
const many = planQueuePrimaries(queue([{ roleIds: ["a"] }]), [role("a", ["x", "y", "z"])]);
assert.deepEqual(many.set, []);
assert.match(many.error, /角色「A」有 3 张外观图，还没选主外观/);
// 李四那张图在列表里也一样不会被特殊对待
const lisi = planQueuePrimaries(queue([{ roleIds: ["lw"] }]), [role("lw", ["other", "5bdf89b5-cece-4777-8443-e64bf6b3302c"])]);
assert.deepEqual(lisi.set, []); assert.ok(lisi.error);
// 没有外观图 / 角色不存在：照旧报错
assert.match(planQueuePrimaries(queue([{ roleIds: ["a"] }]), [role("a", [])]).error, /没有外观图/);
assert.match(planQueuePrimaries(queue([{ roleIds: ["ghost"] }]), []).error, /角色不存在：ghost/);
// 画外角色、队列里没用到的角色：不需要主外观，也不改它们
assert.deepEqual(planQueuePrimaries(queue([{ roleIds: ["a"], offscreenRoleIds: ["a"] }]), [role("a", ["x", "y"])]), { set: [], error: null });
assert.deepEqual(planQueuePrimaries(queue([{ roleIds: ["a"] }]), [role("a", ["x"], "x"), role("b", ["p", "q"])]), { set: [], error: null });
// 出错时一个都不写（不会补了一半）
assert.deepEqual(planQueuePrimaries(queue([{ roleIds: ["a", "b"] }]), [role("a", ["x"]), role("b", ["p", "q"])]).set, []);

// 源码：通用代码里不再有写死的素材 ID
const root = path.resolve(import.meta.dirname, "..");
const panel = readFileSync(path.join(root, "components/shot-queue-panel.tsx"), "utf8");
assert.doesNotMatch(panel, /5bdf89b5|LIN_WAN/);
assert.doesNotMatch(panel, /appearanceAssetIds\[0\]/, "不再悄悄取第一张");
assert.match(panel, /planQueuePrimaries\(parsed, await listRoles\(\)\)/);

console.log("queue role primaries: no hard-coded asset, only an unambiguous single image is filled in, several images → ask the user; ok");
