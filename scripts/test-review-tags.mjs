import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeEntry, putEntry, problemsByTag, problemRates, planReworkQueue, reviewContext, rateText, isReviewBook, SMALL_SAMPLE, REVIEW_TAGS } from "../lib/review-tags.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";

// Tag list: the five asked for + the four extra ones.
assert.deepEqual(REVIEW_TAGS.map((tag) => tag.label), ["乱说话", "换脸", "出配乐", "手变形", "动作没做完", "开头冒人声", "站位不对", "光线不对", "其他"]);

const shot = (title, extra = {}) => ({ title, prompt: `主要动作：${title} 的正文。`, roleIds: [], sceneAssetIds: [], seconds: 6, aspect: "9:16", soundMode: "ambient", ...extra });
const queue = { version: "shot-queue-v1", title: "EP02_v5", defaults: { megapixels: 0.45 }, chapters: [
  { title: "一", shots: [shot("L01"), shot("L02", { generationMode: "first-last", firstFrameFrom: { shot: "previous", frame: "last" } }), shot("L03", { firstFrameAssetId: "img-1", generationMode: "first-last" })] },
  { title: "二", shots: [shot("L04"), shot("L05")] },
] };
const original = JSON.stringify(queue);
const ctx = (s, zhengben) => reviewContext(s, queue.defaults, zhengben);
const entry = (assetId, shotTitle, tags, extra = {}) => ({ assetId, shotTitle, queueTitle: "EP02_v5", tags, label: "A", context: ctx(queue.chapters.flatMap((c) => c.shots).find((s) => s.title === shotTitle), "v2026-11-11.2"), updatedAt: 1, ...extra });

// Context snapshot: 正本版本、模式、首帧.
assert.deepEqual(ctx(queue.chapters[0].shots[0], undefined), { zhengben: "未记录", mode: "auto", firstFrame: false });
assert.deepEqual(ctx(queue.chapters[0].shots[2], "v1"), { zhengben: "v1", mode: "first-last", firstFrame: true });
assert.equal(ctx(queue.chapters[0].shots[1], "v1").firstFrame, true, "chained first frame counts as 有首帧");

// normalize: unknown tags dropped, duplicates removed, 没问题 cleared by a problem tag, empty entry deleted.
assert.deepEqual(normalizeEntry(entry("a", "L01", ["hand", "hand", "nope"], { ok: true })).tags, ["hand"]);
assert.equal(normalizeEntry(entry("a", "L01", ["hand"], { ok: true })).ok, undefined);
assert.equal(normalizeEntry(entry("a", "L01", [], { ok: true })).ok, true);
assert.equal(normalizeEntry(entry("a", "L01", [])), null);
assert.equal(normalizeEntry(entry("a", "L01", [], { note: "  只写了备注 " })).note, "只写了备注");
let book = {};
book = putEntry(book, entry("v1", "L01", ["babble", "music"]));
book = putEntry(book, entry("v2", "L01", ["babble"], { label: "B" }));
book = putEntry(book, entry("v3", "L03", ["hand", "other"], { note: "3 秒处右手六根手指" }));
book = putEntry(book, entry("v4", "L04", [], { ok: true }));
book = putEntry(book, entry("v5", "L05", ["early_voice"]));
book = putEntry(book, entry("v6", "L05", [], { ok: true, label: "B" }));
book = putEntry(book, entry("x1", "L01", ["face_swap"], { queueTitle: "别的队列" }));
assert.ok(isReviewBook(book)); assert.equal(isReviewBook([]), false); assert.equal(isReviewBook({ a: { tags: "x" } }), false);
const before = book;
assert.equal(putEntry(book, entry("v4", "L04", [])).v4, undefined, "clearing everything removes the entry");
assert.ok(before.v4, "putEntry does not mutate");

// 问题 → 哪几镜 (only this queue, shot order).
const rows = problemsByTag(book, "EP02_v5", ["L01", "L02", "L03", "L04", "L05"]);
assert.deepEqual(rows.map((row) => row.label), ["乱说话", "出配乐", "手变形", "开头冒人声", "其他"]);
assert.deepEqual(rows[0].shots.map((s) => `${s.shotTitle}${s.label}`), ["L01A", "L01B"]);
assert.equal(rows.find((row) => row.tag === "other").shots[0].note, "3 秒处右手六根手指");
assert.ok(!rows.some((row) => row.tag === "face_swap"), "other queues are not listed");

// 问题率 by 写法: denominator = reviewed (tagged or 没问题); small sample said plainly.
const rates = problemRates(book, { queueTitle: "EP02_v5" });
const byMode = rates.find((table) => table.dimension === "mode");
const auto = byMode.groups.find((group) => group.key.startsWith("auto"));
assert.deepEqual([auto.reviewed, auto.withProblem], [5, 3]);
assert.equal(auto.small, false);
const fl = byMode.groups.find((group) => group.key.startsWith("first-last"));
assert.deepEqual([fl.reviewed, fl.withProblem, fl.small], [1, 1, true]);
assert.match(rateText(fl), /样本少/);
assert.match(rateText(auto), /^3\/5 条有问题（60%）：乱说话 2/);
assert.ok(rates.some((table) => table.dimension === "zhengben" && table.groups[0].key === "正本 v2026-11-11.2"));
assert.ok(rates.some((table) => table.dimension === "firstFrame" && table.groups.some((group) => group.key === "有首帧")));
assert.ok(!rates.some((table) => table.dimension === "experiment"), "no A/B group without experiment shots");
assert.equal(problemRates(book).find((table) => table.dimension === "mode").groups.find((g) => g.key.startsWith("auto")).reviewed, 6, "全部队列 counts the other queue too");
assert.equal(SMALL_SAMPLE, 5);

// 返修队列: tagged shots only, 没问题 on any version excludes the shot, chained shot whose source is not reworked is skipped.
book = putEntry(book, entry("v7", "L02", ["blocking"]));
const plan = planReworkQueue(queue, book);
assert.ok(!("error" in plan));
assert.equal(plan.title, "EP02_v5_返修");
const titles = plan.queue.chapters.flatMap((c) => c.shots.map((s) => s.title));
assert.deepEqual(titles, ["L01", "L02", "L03"], "L04 / L05 have a 没问题 version; L02 chains from L01, which is reworked too");
assert.deepEqual(plan.queue.chapters.map((c) => c.title), ["一"], "empty chapters dropped");
const flatOrig = queue.chapters.flatMap((c) => c.shots);
for (const s of plan.queue.chapters.flatMap((c) => c.shots)) assert.equal(s.prompt, flatOrig.find((o) => o.title === s.title).prompt, "正文一字不改");
assert.deepEqual(plan.queue.chapters[0].shots[1].firstFrameFrom, { shot: "L01", frame: "last" }, "previous pinned to the title");
assert.equal(JSON.stringify(queue), original, "原队列不动");
assert.equal(parseShotQueue(JSON.stringify(plan.queue)).title, "EP02_v5_返修", "返修队列 passes the normal queue check");
assert.match(plan.note, /^# 返修说明：EP02_v5_返修/);
assert.match(plan.note, /## L01\n- 视频 A（正本 v2026-11-11\.2）：乱说话、出配乐\n- 视频 B（正本 v2026-11-11\.2）：乱说话/);
assert.match(plan.note, /手变形、其他。备注：3 秒处右手六根手指/);
assert.ok(!plan.queue.chapters[0].shots[0].prompt.includes("返修"), "nothing added at the start of the prompt");

// Source not reworked → chained shot skipped and explained.
let book2 = putEntry({}, entry("w1", "L02", ["hand"]));
book2 = putEntry(book2, entry("w2", "L04", ["lighting"]));
const plan2 = planReworkQueue(queue, book2);
assert.deepEqual(plan2.queue.chapters.flatMap((c) => c.shots.map((s) => s.title)), ["L04"]);
assert.equal(plan2.skipped[0].title, "L02");
assert.match(plan2.note, /没收进返修队列的\n- L02：要接「L01」的画面/);
assert.match(planReworkQueue(queue, putEntry({}, entry("w1", "L02", ["hand"]))).error, /都要接别的镜头的画面/);
assert.match(planReworkQueue(queue, {}).error, /还没有打了问题标签/);

// Storage goes where A 批 put it: the production-records meta store, which the daily / folder backups copy whole.
const store = readFileSync(new URL("../lib/review-tags-store.ts", import.meta.url), "utf8");
assert.match(store, /patchMeta<ReviewBook>\(REVIEW_TAGS_META_KEY/);
const backup = readFileSync(new URL("../lib/project-backup.ts", import.meta.url), "utf8");
assert.match(backup, /getAll\(records, "meta"\)/, "light / daily backups export every meta row");

console.log("review tags: 9 tags, 问题→镜头, 问题率 by 写法 (small sample flagged), 返修队列 + 说明, original untouched; ok");
