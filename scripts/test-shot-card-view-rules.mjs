// 镜头卡片排版规则：完整度标签排序 / 全过收一行、关键帧列按需显示、顶栏「全部入队」按钮的字。
import assert from "node:assert/strict";
import { orderTags, tagsAllPass, queueUsesKeyframes, enqueueLabel } from "../lib/shot-card-view-rules.ts";

const r = (id, state) => ({ id, state });
assert.deepEqual(orderTags([r("a", "ok"), r("b", "na"), r("c", "missing"), r("d", "ok"), r("e", "missing")]).map((x) => x.id), ["c", "e", "a", "d", "b"]);
assert.equal(tagsAllPass([r("a", "ok"), r("b", "na")]), true);
assert.equal(tagsAllPass([r("a", "ok"), r("b", "missing")]), false);

const shot = (title, extra = {}) => ({ title, ...extra });
assert.equal(queueUsesKeyframes([shot("A"), shot("B")], () => false), false);
assert.equal(queueUsesKeyframes([shot("A"), shot("B", { keyframe: { prompt: "x" } })], () => false), true);
assert.equal(queueUsesKeyframes([shot("A", { firstFrameAssetId: "img1" })], () => false), true);
assert.equal(queueUsesKeyframes([shot("A", { firstFrameFrom: { shot: "previous", frame: "last" } })], () => false), true, "接尾帧的镜头要保留这一列（显示「首帧接…」）");
assert.equal(queueUsesKeyframes([shot("A")], (title) => title === "A"), true, "出过候选图也保留");

const base = { checking: false, asking: false, submitting: false, done: 0, total: 26, enqueuedBefore: false };
assert.equal(enqueueLabel(base), "全部入队（26 镜）");
assert.equal(enqueueLabel({ ...base, checking: true }), "正在盘点…");
assert.equal(enqueueLabel({ ...base, asking: true }), "等你确认…");
assert.equal(enqueueLabel({ ...base, submitting: true, done: 3, enqueuedBefore: true }), "排队中 3/26");
assert.equal(enqueueLabel({ ...base, done: 20, enqueuedBefore: true }), "继续未完成（6 镜）");
assert.equal(enqueueLabel({ ...base, done: 26, enqueuedBefore: true }), "全部已出片");
console.log("shot-card-view-rules ok");
