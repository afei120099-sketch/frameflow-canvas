// 镜头卡片 A/B/C：去配乐版不占新字母（2026-11-12 用户：「去了配音不要变成 B，本来就是 A，B 是又渲了一条」）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { letterVersions, pickChosenVersion } from "../lib/shot-card-videos.ts";
import { sameTag, tagVersions, versionTag } from "../lib/shot-card-viewer.ts";

const raw = (id, t, extra = {}) => ({ assetId: id, createdAt: t, adopted: false, stale: false, ...extra });
const demix = (id, t, from, passes) => raw(id, t, { derivationType: "music_removal", sourceVideoAssetId: from, ...(passes ? { musicRemovalPasses: passes } : {}) });
// 一条原片 → 去配乐 → 再去一次（×2，来源是去配乐版）→ 一条真正的重渲
const list = letterVersions([demix("a2", 3, "a1", 2), raw("b", 4), raw("a", 1), demix("a1", 2, "a")]);
assert.deepEqual(list.map((v) => [v.assetId, v.label]), [["a", "A"], ["a1", "A · 去配乐"], ["a2", "A · 去配乐 ×2"], ["b", "B"]]);
assert.deepEqual([...new Set(list.map((v) => v.letter))], ["A", "B"], "只有 A、B 两个字母");
assert.deepEqual(list.filter((v) => v.owner).map((v) => v.assetId), ["a", "b"], "A/B 切换只按真正的出片");
assert.deepEqual(list.map((v) => v.reviewLabel), ["A", "A（去配乐版）", "A（去配乐 ×2版）", "B"]);
assert.deepEqual(list.map((v) => v.demixPasses), [0, 1, 2, 0]);
// 已采用 = A 的去配乐版：卡片显示它，A 那个字母亮着
const adopted = letterVersions([raw("a", 1), demix("a1", 2, "a"), raw("b", 4)].map((v) => v.assetId === "a1" ? { ...v, adopted: true, adoptedAt: 9 } : v));
const chosen = pickChosenVersion(adopted);
assert.equal(chosen.label, "A · 去配乐");
assert.equal(adopted.find((v) => v.owner && v.letter === chosen.letter).assetId, "a");
// 原片被删（不在这一镜的版本里）：去配乐版自己占一个字母，不会变成「?」
const orphan = letterVersions([demix("x1", 1, "gone"), raw("y", 2)]);
assert.deepEqual(orphan.map((v) => [v.label, v.owner]), [["A · 去配乐", true], ["B", true]]);
// 26 个以后接着 AA（和画布节点候选同一套）
assert.equal(letterVersions(Array.from({ length: 27 }, (_, i) => raw(`v${i}`, i)))[26].label, "AA");

// 放大层：上面的字母只列原片，看去配乐版时 A 亮着；标签直接用「A · 去配乐」
const viewer = list.map((v) => ({ assetId: v.assetId, label: v.label, letter: v.letter, owner: v.owner, stale: false, adopted: false, demixPasses: v.demixPasses, sourceVideoAssetId: v.sourceVideoAssetId }));
assert.deepEqual(tagVersions(viewer).map((v) => v.label), ["A", "B"]);
assert.equal(sameTag(viewer[0], viewer[2]), true); assert.equal(sameTag(viewer[3], viewer[2]), false);
assert.equal(versionTag(viewer[2], viewer), "A · 去配乐 ×2");

// 卡片接线：字母来自 letterVersions，切换只列 owner，审片 / 对比用 reviewLabel
const board = readFileSync(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8");
assert.doesNotMatch(board, /String\.fromCharCode\(65 \+ i\)/, "不再按全部视频数字母");
assert.match(board, /const labelled = letterVersions\(/);
assert.match(board, /videos\.versions\.filter\(\(version\) => version\.owner\)\.map/);
assert.match(board, /<VideoReview videos=\{v\.versions\.map\(\(item\) => \(\{ assetId: item\.assetId, label: item\.reviewLabel/);
assert.match(board, /label: item\.reviewLabel, source: item\.asset\.storageReference/, "对比实验也用 reviewLabel");
assert.match(readFileSync(new URL("../components/shot-card-video-viewer.tsx", import.meta.url), "utf8"), /tagVersions\(shot\.versions\)\.map/);
console.log("shot card letters: 原片 + 去配乐 + 去配乐×2 + 重渲 → 只有 A、B；去配乐版叫「A · 去配乐」，审片叫「A（去配乐版）」；放大层同一套; ok");
