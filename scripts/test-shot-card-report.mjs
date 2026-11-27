import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { queueCardReport } from "../lib/shot-card-report.ts";

// The inbox writes this report into *_status.json (cardChecks); the card shows the same checks.
const role = (roleId, displayName, extra = {}) => ({ roleId, displayName, appearanceAssetIds: [], voiceAssetIds: [], primaryAppearanceAssetId: `${roleId}-look`, primaryVoiceAssetId: `${roleId}-voice`, description: "", ...extra });
const asset = (assetId, kind = "image") => ({ assetId, kind, storageReference: `local:${assetId}`, filename: `${assetId}.png`, createdAt: 1 });
const roles = [role("roleA", "张三"), role("roleB", "李四", { primaryVoiceAssetId: null })];
const assets = [asset("roleA-look"), asset("roleA-voice", "audio"), asset("roleB-look"), asset("office")];
const queue = { version: "shot-queue-v1", title: "t", defaults: { noBackgroundMusic: true }, chapters: [{ title: "c", shots: [
  { title: "L01｜好镜头", prompt: "参考说明：<Picture 1>是办公室；<Picture 2>是张三，只用于张三的脸、发型和服装。\n写实，Kodak Vision3 250D 胶片颗粒，台灯在画右，暖光照脸。\n他在画左，坐在椅子上。中景，50mm 等效，浅景深，机位固定。\n主要动作：他翻页。\n0-3秒：他用右手翻一页稿子。\n3-5.17秒：他抬眼看门口。\n声音：纸页轻响，房间底噪。", roleIds: ["roleA"], sceneAssetIds: ["office"], seconds: 5, aspect: "9:16", soundMode: "ambient" },
  { title: "L02｜李四开口", prompt: "主要动作：李四说话。\n0-3秒：李四开口。\n声音：底噪。没有背景音乐。", roleIds: ["roleB"], sceneAssetIds: [], seconds: 6, aspect: "9:16", soundMode: "av", dialogue: [{ roleId: "roleB", text: "好。" }] },
] }] };
const report = queueCardReport(queue, roles, assets);
assert.equal(report.shots.length, 2);
assert.deepEqual(report.shots[0].errors, [], JSON.stringify(report.shots[0]));
assert.ok(!report.shots[1].errors.some((m) => m.includes("没绑主声音")), "no voice check: 正本 submits without role voices");
// 写法规则（dialogue 非空、开口、点名配乐）交给正本 h3q，画布报告不再重复；报告的 note 让 AI 自己跑 h3q。
for (const word of ["dialogue 字段", "「开口」", "没有背景音乐"]) assert.ok(!report.shots[1].errors.some((m) => m.includes(word)), word);
// L02 只写了主要动作：画面五项没写全，算写错（2026-11-11 起五项必写），其余写法规则仍不在画布报告里。
assert.equal(report.errorShots, 1);
assert.ok(report.shots[1].errors.length && report.shots[1].errors.every((m) => m.startsWith("画面五项·")), JSON.stringify(report.shots[1]));
assert.equal(report.gate.ok, false); assert.deepEqual(report.gate.failures.map((f) => f.title), ["L02｜李四开口"]);
assert.ok(report.note.includes("h3q.py check"), report.note);
assert.ok(report.note.includes("title 一字不改"));
assert.ok(report.note.includes("%FRAMEFLOW_H3_TOOLS%\\SKILL_h3-video.md"), report.note);

// Real queue, if given (FRAMEFLOW_TEST_QUEUE): the report runs on all shots without throwing.
const real = process.env.FRAMEFLOW_TEST_QUEUE || "";
if (real && existsSync(real)) {
  const q = JSON.parse(readFileSync(real, "utf8"));
  const r = queueCardReport(q, [], []);
  assert.equal(r.shots.length, q.chapters.flatMap((c) => c.shots).length);
}
console.log("shot card report: ok");
