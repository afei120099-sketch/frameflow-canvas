// 第 8 条：队列和卡片上的预计耗时（估算）。实测：10 步约 140 秒一镜，理解优先 211–321 秒，关键帧约 64 秒一张。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MEASURED, shotEstimate, queueEstimate, keyframeEstimate, formatEstimate, shortEstimate, ESTIMATE_NOTE } from "../lib/shot-time-estimate.ts";

assert.deepEqual(MEASURED, { tenStepSeconds: 140, understandingSeconds: [211, 321], keyframeSeconds: 64 });
// 每镜
assert.deepEqual({ ...shotEstimate({}) }, { min: 140, max: 140, kind: "ten-step", note: "10 步实测约 140 秒一镜" });
assert.equal(shotEstimate({ tuning: "understanding" }).kind, "understanding");
assert.deepEqual([shotEstimate({ tuning: "understanding" }).min, shotEstimate({ tuning: "understanding" }).max], [211, 321]);
assert.equal(shotEstimate({}, { tuning: "understanding" }).kind, "understanding", "队列默认值也算");
assert.equal(shotEstimate({ tuning: "default" }, { tuning: "understanding" }).kind, "ten-step", "单镜覆盖默认值");
assert.equal(shotEstimate({ workflow: "fast", tuning: "understanding" }).kind, "fast", "理解优先只对终极版");
assert.match(shotEstimate({ workflow: "fast" }).note, /没有实测/);
// 整个队列 / 剩余
const queue = { defaults: { tuning: "default" }, chapters: [{ shots: [{}, { tuning: "understanding" }] }, { shots: [{}, {}] }] };
const all = queueEstimate(queue);
assert.deepEqual(all, { total: { min: 140 * 3 + 211, max: 140 * 3 + 321 }, remaining: { min: 631, max: 741 }, shots: 4, left: 4 });
const part = queueEstimate(queue, (c, s) => c === 0);
assert.deepEqual([part.left, part.remaining.min, part.remaining.max], [2, 280, 280]);
const chapter2 = queueEstimate(queue, undefined, (c) => c === 1);
assert.deepEqual([chapter2.shots, chapter2.total.max], [2, 280], "只算这一章");
assert.deepEqual(queueEstimate(queue, () => true).remaining, { min: 0, max: 0 });
// 关键帧：默认每镜 3 张
assert.deepEqual(keyframeEstimate([{ keyframe: { prompt: "a" } }, { keyframe: { prompt: "b", count: 2 } }]), { min: 5 * 64, max: 5 * 64, images: 5 });
assert.equal(keyframeEstimate([{ keyframe: { prompt: "a" } }], { count: 1 }).images, 1);
// 说人话的格式
assert.equal(formatEstimate({ min: 0, max: 0 }), "不用等");
assert.equal(formatEstimate({ min: 64, max: 64 }), "约 64 秒");
assert.equal(formatEstimate({ min: 140, max: 140 }), "约 2.3 分钟");
assert.equal(formatEstimate({ min: 211, max: 321 }), "约 3.5–5.4 分钟");
assert.equal(formatEstimate({ min: 47 * 140, max: 47 * 140 }), "约 1.8 小时");
assert.equal(formatEstimate({ min: 64, max: 140 }), "约 64 秒–2.3 分钟");
assert.equal(shortEstimate({ min: 140, max: 140 }), "≈2.3分");
assert.equal(shortEstimate({ min: 211, max: 321 }), "≈3.5–5.4分");
assert.match(ESTIMATE_NOTE, /^估算/);

// 界面：队列面板（平时 + 入队确认）和卡片（每镜、顶部、出关键帧）都显示，并写明是估算
const root = path.resolve(import.meta.dirname, "..");
const panel = readFileSync(path.join(root, "components/shot-queue-panel.tsx"), "utf8");
assert.match(panel, /⏱ 预计耗时（估算）：全部 \{est\.shots\} 镜/);
assert.match(panel, /rows\[keyOf\(c, s\)\]\?\.status === "completed"/, "剩余 = 还没出片的");
assert.match(panel, /<p title=\{ESTIMATE_NOTE\}>预计耗时（估算）：全部渲染/, "入队前确认框里也有");
const card = readFileSync(path.join(root, "components/shot-card-board.tsx"), "utf8");
assert.match(card, /cell\("预计", <span title=\{`\$\{ctx\.estimate\.note\}（估算/);
assert.match(card, /⏱ 预计 \{formatEstimate\(estimate\.total\)\}.*· 估算<\/span>/);
assert.match(card, /全部出关键帧（\{kfTodo\.length\} 镜，\{formatEstimate\(keyframeEstimate\(/);
assert.match(card, /const chosen = videos\.get\(card\.shot\.title\)\?\.chosen; return chosen && !chosen\.stale;/, "改过提示词的旧视频不算完成");

console.log("shot time estimate: per shot / queue / remaining / keyframes from measured numbers, labelled 估算 in queue panel and cards; ok");
