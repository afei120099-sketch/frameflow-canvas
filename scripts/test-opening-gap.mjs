// 开场空白硬拦截（用户 2026-11-12：有台词的镜头第一句前不能空超过 1 秒；先沉默的拆成单独无台词一镜或挪进上一镜结尾）。
// 以正本 h3q 的 [开场空白] ERROR 为准（按前缀认），h3q 没跑成用画布兜底；拦法和画面五项一样，「我确认没问题」可放行。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { canvasOpeningGap, promptSegments, OPENING_GAP_FIXES } from "../lib/opening-gap.ts";
import { queueGate, shotGate, shotGateMessage } from "../lib/shot-gate.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";
import { parseH3qOutput } from "../lib/h3q-report.ts";

const DIALOGUE = "对白（中文普通话，口型同步）：张三：“这张表算错了。” 李四：“我还没看完。”";
const P = (...lines) => lines.join("\n");
// ── 1. 画布兜底判断（和 h3q GAP_SPEAK / GAP_NOT 同一套说话词） ──
assert.equal(canvasOpeningGap(P("0-3秒：他抬眼看她。", "3-8秒：他说话，手指点着稿纸。", DIALOGUE)), 3);
assert.equal(canvasOpeningGap(P("0-1秒：他抬眼。", "1-6秒：他说话。", DIALOGUE)), null, "1 秒以内可以");
assert.equal(canvasOpeningGap(P("0-5秒：他抬眼看向她，说话。", "5-9秒：她说话。", DIALOGUE)), null);
assert.equal(canvasOpeningGap(P("0-6秒：她没说话，低头翻稿纸。", "6-10秒：她把下一句说完。", DIALOGUE)), 6, "「没说话」不算、「说完」算");
assert.equal(canvasOpeningGap(P("0-3秒：他抬眼。", "3-8秒：他说话。")), null, "没有对白行 = 没台词，不管");
assert.equal(canvasOpeningGap(P("他看着她说话。", DIALOGUE)), null, "没有时间段，判断不了不报");
assert.deepEqual(promptSegments("0-3秒：a。3-6秒：b\n6-9秒：c").map((s) => [s.start, s.text]), [[0, "a。"], [3, "b"], [6, "c"]]);

// ── 2. 拦截：h3q 为准（只认前缀），兜底，人工放行 ──
const shot = { title: "EP03-v4-3-9｜就我们两个", prompt: P("0-3秒：他抬眼看她。", "3-8秒：他说话。", DIALOGUE) };
const h3qGap = [{ level: "ERROR", where: "镜1", message: "[开场空白] EP03-v4-3-9｜就我们两个：有台词，但第一句说话在第 3 秒才开始（随便以后怎么改写）" }];
assert.deepEqual(shotGate(shot, [], h3qGap).map((i) => [i.id, i.source]), [["opening_gap", "h3q"]], "h3q 报了：按前缀认，后面文字随正本改");
assert.match(shotGate(shot, [], h3qGap)[0].note, /第 3 秒才开始/, "显示 h3q 原话");
assert.deepEqual(shotGate(shot, [], []), [], "h3q 查过、没报：以 h3q 为准，不再自己判");
assert.deepEqual(shotGate({ ...shot, prompt: shot.prompt }, []).map((i) => [i.id, i.source]), [["opening_gap", "canvas"]], "h3q 没用上：画布兜底");
const msg = shotGateMessage(shot, [], undefined, h3qGap);
assert.match(msg, /开场空白不过，不能渲染/); assert.ok(msg.includes(OPENING_GAP_FIXES), "报错里写三种改法");
for (const fix of ["挪到 0～1 秒内开始", "拆成单独一个不带台词的镜头", "挪进上一镜的结尾"]) assert.ok(OPENING_GAP_FIXES.includes(fix), fix);
const confirmed = () => ({ prompt: shot.prompt, reason: "这一镜就是要先停顿", items: ["opening_gap"], queueTitle: "q", shotTitle: shot.title, confirmedAt: "2026-11-12T00:00:00Z" });
assert.equal(shotGateMessage(shot, [], confirmed, h3qGap), "", "亲手确认、正文没改：放行");
assert.match(shotGateMessage({ ...shot, prompt: shot.prompt + "。" }, [], confirmed, h3qGap), /开场空白/, "正文一改，确认失效");
const queue = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "q", chapters: [{ title: "一", shots: [{ title: shot.title, roleIds: [], sceneAssetIds: [], seconds: 10, aspect: "9:16", soundMode: "av", prompt: shot.prompt }] }] }));
const whole = queueGate(queue, undefined, undefined, { source: "h3q", report: { counts: { ERROR: 1, WARN: 0, HINT: 0 }, shots: [h3qGap], general: [] } });
assert.equal(whole.ok, false); assert.match(whole.message, /^开场空白有镜头不过，整批不提交/); assert.ok(whole.message.includes(OPENING_GAP_FIXES));
assert.equal(queueGate(queue, undefined, confirmed, { source: "h3q", report: { counts: { ERROR: 1, WARN: 0, HINT: 0 }, shots: [h3qGap], general: [] } }).ok, true);
assert.equal(queueGate(queue).ok, false, "收件箱 / 入队前没有 h3q 报告时画布兜底照样拦");

// ── 3. 卡片接线 ──
const board = readFileSync(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8");
assert.match(board, /confirmedShot \? extra\.filter\(\(check\) => !\(check\.source === "h3q" && check\.level === "error"\)\) : extra/, "确认放行后 h3q 那条红也收起（所有单镜 ERROR，2026-11-12 起）");
assert.match(board, /hardRuleById\(item\.id\); return rule \? \{ label: `\$\{item\.label\}（必改：\$\{rule\.rule\}）`, note: withFixes\(item\.note, rule\.fixes\) \}/, "复制给 AI：写规则和改法（开场空白走 lib/hard-rules.ts）");
{ const { withOpeningGapFixes } = await import("../lib/opening-gap.ts"); assert.ok(withOpeningGapFixes("第 3 秒").includes("挪进上一镜")); assert.equal(withOpeningGapFixes("x。按剧情选一种改：①a；②b；③c"), "x。按剧情选一种改：①a；②b；③c"); }
const row = readFileSync(new URL("../components/shot-card-completeness.tsx", import.meta.url), "utf8");
assert.match(row, /\.\.\.hard\.map\(\(item\) => item\.id\)\], reason\)/, "「我确认没问题」同样适用");
assert.match(row, /\{rule\.rule\}\{\/①\/\.test\(item\.note\) \? "。" : `。\$\{rule\.fixes\}。`\}/, "h3q 原话已带 ①②③ 就不重复");

// ── 4. 真实队列（可选，FRAMEFLOW_TEST_QUEUES 用分号分隔）：画布兜底和正本 h3q 判出的镜头一致 ──
const H3_TOOLS = process.env.FRAMEFLOW_H3_TOOLS || "h3-tools";
const H3 = `${H3_TOOLS}/h3q.py`;
let live = "";
for (const file of (process.env.FRAMEFLOW_TEST_QUEUES || "").split(";").map((item) => item.trim()).filter(Boolean)) {
  if (!existsSync(H3) || !existsSync(file)) continue;
  const run = spawnSync("python", ["-I", H3, "check", file, "--all", "--skip-table"], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, cwd: H3_TOOLS });
  if (!/\[开场空白\]/.test(run.stdout ?? "")) { live += ` ${file.split("_").at(-2)} h3q 没报开场空白（旧版？）跳过；`; continue; }
  const q = JSON.parse(readFileSync(file, "utf8"));
  const shots = q.chapters.flatMap((chapter) => chapter.shots);
  const report = parseH3qOutput(run.stdout, shots.map((s) => s.title));
  const byH3q = shots.filter((s, i) => report.shots[i].some((item) => item.level === "ERROR" && item.message.includes("[开场空白]"))).map((s) => s.title);
  const byCanvas = shots.filter((s) => canvasOpeningGap(s.prompt) !== null).map((s) => s.title);
  assert.deepEqual(byCanvas, byH3q, `${file}：画布兜底和 h3q 判的镜头一致`);
  live += ` ${file.split("/").at(-1)}：${byH3q.length} 镜，画布兜底和 h3q 一致；`;
}
console.log(`opening gap: 兜底判断、h3q 前缀为准、三种改法、人工放行、整批不提交；${live} ok`);
