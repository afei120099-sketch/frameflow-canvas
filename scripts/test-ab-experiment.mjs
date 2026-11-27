import assert from "node:assert/strict";
import { planExperiment, experimentSegments, experimentPair, experimentDiff, experimentContext, randomSeed } from "../lib/ab-experiment.ts";
import { parseShotQueue, queueGeneration } from "../lib/shot-queue.ts";
import { problemRates, putEntry, reviewContext } from "../lib/review-tags.ts";
import { pushVersion, stepVersion } from "../lib/shot-queue-history.ts";
import { describeQueueChange } from "../lib/shot-card-undo.ts";

const prompt = [
  "参考说明（编号与提交顺序一致）：<Picture 1>是窗侧场景图，只用于这间办公室，光线按正文。",
  "写实真人电影质感，Kodak Vision3 250D 胶片颗粒。机位在桌沿下，仰拍，中近景，35mm 等效，机位固定。",
  "夜里的办公室：天花板的筒灯开着，台灯在画右桌角，暖黄色的光照在桌面的稿纸上。",
  "主要动作：她走到桌前拿起信。",
  "0-3秒：她停在门口，右手扶门框。",
  "3-6秒：她走到桌前，左手拿起信。",
  "声音：脚步声，纸张摩擦声。",
  "画面要求：竖屏9:16，一条镜头拍完，中间不切换。",
].join("\n");
const shot = (title, extra = {}) => ({ title, prompt, roleIds: [], sceneAssetIds: ["office"], seconds: 6, aspect: "9:16", soundMode: "ambient", ...extra });
const queue = { version: "shot-queue-v1", title: "EP02_v5", chapters: [{ title: "办公室", shots: [shot("L01"), shot("L02", { generationMode: "first-last", firstFrameFrom: { shot: "previous", frame: "last" } }), shot("L03", { seed: 777 })] }] };
const original = JSON.stringify(queue);

// Segments = the card's existing cut.
const segs = experimentSegments(prompt);
const lightIndex = segs.findIndex((s) => s.label === "光线");
assert.ok(lightIndex >= 0, `光线 is a segment: ${segs.map((s) => s.label).join(" / ")}`);
assert.deepEqual(segs.map((s) => s.label), ["参考说明", "风格 · 机位景别", "光线", "主要动作", "0–3秒", "3–6秒", "声音", "画面要求"]);

// Insert (queue not submitted): A = original text, B = only that segment changed, same seed; random → one fixed seed.
const newLight = "夜里的办公室：只有窗外冷白月光，桌面一半在暗处。";
const plan = planExperiment(queue, 0, 0, lightIndex, newLight, { seed: 12345 });
assert.ok(!("error" in plan), plan.error);
assert.equal(plan.where, "insert");
assert.deepEqual(plan.titles, { a: "L01·对比A", b: "L01·对比B" });
assert.equal(plan.seedWasRandom, true); assert.equal(plan.seed, 12345);
const flat = plan.queue.chapters[0].shots;
assert.deepEqual(flat.map((s) => s.title), ["L01", "L01·对比A", "L01·对比B", "L02", "L03"]);
const [orig, a, b] = flat;
assert.equal(orig.seed, undefined, "原镜不动");
assert.equal(a.prompt, prompt, "A is the original text");
assert.equal(a.seed, 12345); assert.equal(b.seed, 12345);
assert.equal(b.prompt, prompt.replace("夜里的办公室：天花板的筒灯开着，台灯在画右桌角，暖黄色的光照在桌面的稿纸上。", newLight), "B: only that segment differs");
assert.deepEqual(experimentDiff(a.prompt, b.prompt).map((d) => d.label), ["光线"]);
assert.deepEqual(flat[3].firstFrameFrom, { shot: "L01", frame: "last" }, "L02 still chains from L01, not from the inserted B");
assert.equal(JSON.stringify(queue), original, "input queue not mutated");
assert.equal(parseShotQueue(JSON.stringify(plan.queue)).chapters[0].shots.length, 5, "passes the queue check");
assert.equal(queueGeneration(b, undefined).seed, 12345);

// Ctrl+Z / 撤销: the insert goes through the queue history like any card edit, so one step back is the queue before A / B.
const textBefore = `${JSON.stringify(queue, null, 2)}
`, textAfter = `${JSON.stringify(plan.queue, null, 2)}
`;
const undone = stepVersion(pushVersion(pushVersion({ versions: [], index: -1 }, textBefore), textAfter), -1);
assert.equal(undone.text, textBefore);
assert.match(describeQueueChange(JSON.parse(textAfter), JSON.parse(textBefore)), /删了 .*对比A.*对比B|删了/);

// Fixed seed is reused; a second experiment on the same shot gets ·对比2A / ·对比2B.
const fixed = planExperiment(queue, 0, 2, lightIndex, newLight);
assert.equal(fixed.seed, 777); assert.equal(fixed.seedWasRandom, false);
const again = planExperiment(plan.queue, 0, 0, lightIndex, "夜里的办公室：顶光。");
assert.deepEqual(again.titles, { a: "L01·对比2A", b: "L01·对比2B" });
assert.notEqual(randomSeed(), randomSeed());
assert.ok(Number.isSafeInteger(randomSeed()));

// Submitted queue → a small new queue with just A / B; original untouched; chained shot refused with a reason.
const small = planExperiment(queue, 0, 2, lightIndex, newLight, { newQueue: true });
assert.equal(small.where, "new");
assert.equal(small.queue.title, "EP02_v5_对比");
assert.deepEqual(small.queue.chapters.map((c) => c.shots.map((s) => s.title)), [["L03·对比A", "L03·对比B"]]);
assert.equal(parseShotQueue(JSON.stringify(small.queue)).title, "EP02_v5_对比");
assert.match(planExperiment(queue, 0, 1, lightIndex, newLight, { newQueue: true }).error, /要接「L01」的画面/);
assert.equal(planExperiment(queue, 0, 1, lightIndex, newLight).where, "insert", "chained shot is fine when inserting in place");

// Refusals.
assert.match(planExperiment(queue, 0, 0, lightIndex, segs[lightIndex].text).error, /没有改动/);
assert.match(planExperiment(queue, 0, 0, lightIndex, "  ").error, /空的/);
assert.match(planExperiment(queue, 0, 0, 99, "x").error, /找不到/);

// Pair names and 审片 grouping by A / B.
assert.deepEqual(experimentPair("L01·对比2B"), { base: "L01", run: "2", side: "B", key: "L01·对比2", other: "L01·对比2A" });
assert.equal(experimentPair("L01·副本"), null);
const ctxB = experimentContext(plan.queue, "L01·对比B");
assert.deepEqual(ctxB, { base: "L01", side: "B", changed: "光线" });
assert.deepEqual(experimentContext(plan.queue, "L01·对比A"), { base: "L01", side: "A", changed: "光线" });
assert.equal(experimentContext(plan.queue, "L01"), undefined);
let book = putEntry({}, { assetId: "va", shotTitle: "L01·对比A", queueTitle: "EP02_v5", tags: ["early_voice"], context: reviewContext(a, undefined, "v1", experimentContext(plan.queue, a.title)), updatedAt: 1 });
book = putEntry(book, { assetId: "vb", shotTitle: "L01·对比B", queueTitle: "EP02_v5", tags: [], ok: true, context: reviewContext(b, undefined, "v1", ctxB), updatedAt: 1 });
const ab = problemRates(book).find((table) => table.dimension === "experiment");
assert.deepEqual(ab.groups.map((g) => `${g.key}:${g.withProblem}/${g.reviewed}`), ["A（原写法）:1/1", "B（改了光线）:0/1"]);
assert.ok(ab.groups.every((g) => g.small), "one pair is a small sample");

console.log("A/B experiment: one segment changed, same seed (random fixed first), insert or small new queue, pair compare + 审片 grouping; ok");

// 和本集设定一起用：改到来自本集设定的那一段，只改 B 这一镜，A 与本集设定不动。
{
  const { segmentEpisodeKeys } = await import("../lib/ab-experiment.ts");
  const { shotTemplate, expandEpisode } = await import("../lib/episode-settings.ts");
  const withLight = prompt.replace("夜里的办公室：天花板的筒灯开着，台灯在画右桌角，暖黄色的光照在桌面的稿纸上。", "{{本集.光线.办公室}}");
  const ep = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "EP", episode: { lighting: { 办公室: "夜里的办公室：天花板的筒灯开着，台灯在画右桌角，暖黄色的光照在桌面的稿纸上。" } }, chapters: [{ title: "办公室", shots: [{ ...shot("L01"), prompt: withLight }] }] }));
  const s0 = ep.chapters[0].shots[0];
  assert.ok(s0.promptTemplate, "用了占位的镜头带模板");
  const light = experimentSegments(s0.prompt).find((s) => s.label === "光线");
  assert.deepEqual(segmentEpisodeKeys(ep, s0, light.text), ["光线.办公室"], "光线这段认出来自本集设定");
  const other = experimentSegments(s0.prompt).find((s) => s.label === "主要动作");
  assert.deepEqual(segmentEpisodeKeys(ep, s0, other.text), [], "别的段不是");
  const p = planExperiment(ep, 0, 0, experimentSegments(s0.prompt).findIndex((s) => s.label === "光线"), "夜里的办公室：只有窗外冷白月光。", { seed: 1 });
  assert.ok(!("error" in p), p.error);
  const [, pa, pb] = p.queue.chapters[0].shots;
  assert.ok(shotTemplate(pa, p.queue.episode).includes("{{本集.光线.办公室}}"), "A 仍跟着本集设定");
  assert.ok(!shotTemplate(pb, p.queue.episode).includes("{{本集.光线.办公室}}"), "B 这句脱离本集设定");
  assert.equal(expandEpisode(shotTemplate(pb, p.queue.episode), p.queue.episode).text, pb.prompt, "B 写回后展开等于 B 的正文");
  assert.equal(p.queue.episode.lighting.办公室, ep.episode.lighting.办公室, "本集设定本身不动");
  console.log("ab-experiment: 本集设定那一段只改 B，A 和设定不动 ok");
}
