import assert from "node:assert/strict";
import { parseStoryChapters, chapterPlanningTask } from "../lib/story-chapters.ts";
const script = "第一幕：进门。\n第二幕：抬头。";
const plan = { version: "story-chapters-v1", script, chapters: [
  { title: "进门", source: "第一幕：进门。\n", brief: "主角走进房间", seconds: 15, continuity: "同一人物" },
  { title: "观察", source: "第二幕：抬头。", brief: "主角观察空间", seconds: 20, continuity: "接上一段" },
] };
const parse = (p) => parseStoryChapters(JSON.stringify(p), script);
assert.equal(parse(plan).chapters.length, 2);
assert.deepEqual(parse(JSON.parse(JSON.stringify(plan))), plan, "download/load roundtrip");
assert.throws(() => parse({ ...plan, script: "别的剧本" }), /原剧本/);
assert.throws(() => parse({ ...plan, chapters: [...plan.chapters].reverse() }), /完整拼回/);
assert.throws(() => parse({ ...plan, chapters: [plan.chapters[0]] }), /完整拼回/);
assert.throws(() => parse({ ...plan, chapters: [...plan.chapters, plan.chapters[1]] }), /完整拼回/);
assert.throws(() => parse({ ...plan, chapters: [{ ...plan.chapters[0], brief: "字".repeat(501) }, plan.chapters[1]] }), /过长/);
assert.throws(() => parse({ ...plan, chapters: [{ ...plan.chapters[0], seconds: 120 }, plan.chapters[1]] }), /时长/);
assert.throws(() => parseStoryChapters("null", script));
assert.throws(() => chapterPlanningTask(" "));
assert.throws(() => chapterPlanningTask("字".repeat(30001)));
assert.ok(chapterPlanningTask(script).includes(JSON.stringify(script)), "no source truncation");
console.log("PASS story chapters: exact coverage, limits, order, roundtrip, no execution");
