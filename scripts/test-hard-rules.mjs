// h3q 每条单镜 ERROR 都拦（2026-11-12）：画面五项归五个标签，[开场空白] 归一组，表里没有的归「正本 h3q 写错」；
// 整集 ERROR（general）只显示、不拦；「我确认没问题」照画面五项的规矩放行；
// 用户否决了「同一镜同性别最多一人有台词」，[同性别对白] [说话人站位] 不进拦截表。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HARD_RULES, OTHER_H3Q_ERROR, hardRuleById, hardRuleOf, withFixes } from "../lib/hard-rules.ts";
import { queueGate, shotGate, shotGateMessage } from "../lib/shot-gate.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";

// ── 1. 拦截表 ──
assert.equal(HARD_RULES[0].prefix, "[开场空白]"); assert.ok(HARD_RULES.slice(1).every((rule) => rule.prefix.startsWith("[官方·") || rule.prefix === "[旧格式]"), "开场空白之外只有正本 v2026-11-13 官方格式的 [官方·xx]（同性别对白 / 说话人站位已撤）");
for (const prefix of ["[同性别对白]", "[说话人站位]"]) assert.equal(hardRuleOf(`${prefix} x`), null, `${prefix} 不在表里`);
assert.equal(hardRuleById("same_gender_lines"), null); assert.equal(hardRuleById("speaker_position"), null);
assert.equal(hardRuleById(OTHER_H3Q_ERROR.id), OTHER_H3Q_ERROR);
assert.equal(withFixes("x", "改法"), "x。改法"); assert.equal(withFixes("x ①a", "改法"), "x ①a");
const src = ["lib", "components"].flatMap((dir) => ["hard-rules.ts", "shot-gate.ts", "shot-card-board.tsx", "shot-card-completeness.tsx"].map((f) => `../${dir}/${f}`));
for (const file of src) { let text = ""; try { text = readFileSync(new URL(file, import.meta.url), "utf8"); } catch { continue; } assert.ok(!/\[同性别对白\]|\[说话人站位\]|same_gender|speaker_position/.test(text.replace(/^.*撤回.*$/gm, "")), `${file} 还接着已撤的前缀`); }

// ── 2. 每条单镜 ERROR 都拦，分组 ──
const shot = { title: "EP03-v4-3-9｜就我们两个", prompt: "0-1秒：他说话。\n对白（中文普通话，口型同步）：张三：“这张表算错了。”" };
const items = [
  { level: "ERROR", where: "", message: "[五项·光线] 没有光线句" },
  { level: "ERROR", where: "", message: "[开场空白] 第 3 秒才开始。按剧情选一种改：①a；②b；③c" },
  { level: "ERROR", where: "dialogue", message: "dialogue 不是空" },
  { level: "ERROR", where: "", message: "[以后新加的规则] 写错了" },
  { level: "WARN", where: "", message: "[什么提醒] 只是提醒" },
  { level: "HINT", where: "", message: "[同性别对白] 就算正本又报出来，HINT 也不拦" },
];
const got = shotGate(shot, [], items);
assert.deepEqual(got.map((i) => [i.id, i.label, i.source]), [["light", "光线", "h3q"], ["opening_gap", "开场空白", "h3q"], ["h3q_error", "正本 h3q 写错", "h3q"]]);
assert.equal(got[2].note, "dialogue 不是空；[以后新加的规则] 写错了", "表外 ERROR 原话合成一组");
assert.deepEqual(shotGate(shot, [], items.filter((i) => i.level !== "ERROR")), [], "只有 WARN / HINT：不拦");
// 如果正本以后又报 [同性别对白] ERROR，它不在表里，照样归「正本 h3q 写错」拦——不会被特殊放过，也不会有单独的组。
assert.deepEqual(shotGate(shot, [], [{ level: "ERROR", where: "", message: "[同性别对白] x" }]).map((i) => i.id), ["h3q_error"]);

// ── 3. 报错文字、整批、放行 ──
const msg = shotGateMessage(shot, [], undefined, items);
assert.match(msg, /^画面五项、开场空白、正本 h3q 写错不过，不能渲染：光线、开场空白、正本 h3q 写错（正本 h3q 判定）/);
assert.ok(msg.includes(OTHER_H3Q_ERROR.rule) && msg.includes(OTHER_H3Q_ERROR.fixes), "表外 ERROR 写规则和改法");
const confirmed = () => ({ prompt: shot.prompt, reason: "看过了，这镜没问题", items: ["light", "opening_gap", "h3q_error"], queueTitle: "q", shotTitle: shot.title, confirmedAt: "2026-11-12T00:00:00Z" });
assert.equal(shotGateMessage(shot, [], confirmed, items), "", "亲手确认、正文没改：放行");
assert.notEqual(shotGateMessage({ ...shot, prompt: shot.prompt + "。" }, [], confirmed, items), "", "正文一改，确认失效");
const queue = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "q", chapters: [{ title: "一", shots: [{ title: shot.title, roleIds: [], sceneAssetIds: [], seconds: 10, aspect: "9:16", soundMode: "av", prompt: shot.prompt }] }] }));
const only = [{ level: "ERROR", where: "", message: "[以后新加的规则] 写错了" }];
const report = (shots, general = []) => ({ counts: { ERROR: 1, WARN: 0, HINT: 0 }, shots, general });
const whole = queueGate(queue, undefined, undefined, { source: "h3q", report: report([only]) });
assert.equal(whole.ok, false); assert.match(whole.message, /^正本 h3q 写错有镜头不过，整批不提交：.* 正本 h3q 写错（正本 h3q 判定）/);
assert.equal(queueGate(queue, 0, undefined, { source: "h3q", report: report([only]) }).ok, false, "本章入队也拦");
assert.equal(queueGate(queue, undefined, confirmed, { source: "h3q", report: report([only]) }).ok, true, "确认放行");
// 整集 ERROR 只显示不拦
const generalOnly = queueGate(queue, undefined, undefined, { source: "h3q", report: report([[]], [{ level: "ERROR", where: "一致性", message: "两镜衣服不一样" }]) });
assert.equal(generalOnly.ok, true, "整集 ERROR 不拦");

// ── 4. 画布兜底不变：h3q 没跑成时只有五项和开场空白 ──
assert.deepEqual(shotGate(shot, []).map((i) => i.id), [], "兜底：第一句 0 秒开始、没有五项结果 = 不拦");

console.log("hard rules: h3q 每条单镜 ERROR 都拦（五项 / 开场空白 / 正本 h3q 写错三组），整集 ERROR 只显示，确认放行，同性别对白 / 说话人站位已撤; ok");
