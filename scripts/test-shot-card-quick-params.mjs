// 镜头卡片「参数」列快改：秒数 ▲▼、像素 0.45 / 0.88 快选、整集统一像素、正本 h3q「[时长]」建议秒数。
// 不开浏览器、不提交 GPU；本机有正本时只读地跑一次 python h3q.py check 核对真实输出格式。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { episodeMpState, SECONDS_MIN, SECONDS_MAX, stepSeconds, canStepSeconds, MP_PRESETS, mpPreset, withMegapixels, planEpisodeMegapixels, parseDurationAdvice, durationAdviceOf, planDurationFixes } from "../lib/shot-card-duration.ts";
import { getActualDuration } from "../lib/comfyui/h3-parameters.ts";
import { parseShotQueue, shotQueueMegapixels } from "../lib/shot-queue.ts";
import { shotQueueJson } from "../lib/episode-settings.ts";
import { QueueHistoryStore, canUndo } from "../lib/shot-queue-history.ts";
import { parseH3qOutput } from "../lib/h3q-report.ts";
import { checkShot } from "../lib/shot-card-checks.ts";
import { breakdownShotPrompt } from "../lib/shot-card-breakdown.ts";

// ── 1. 秒数边界（正本 h3q：seconds 5～15）──
const H3_TOOLS = process.env.FRAMEFLOW_H3_TOOLS || "h3-tools";
const h3q = `${H3_TOOLS}/h3q.py`;
if (existsSync(h3q)) assert.match(readFileSync(h3q, "utf8"), /not \(5 <= sec <= 15\)/, "范围和正本 h3q 一致");
assert.deepEqual([SECONDS_MIN, SECONDS_MAX], [5, 15]);
assert.equal(stepSeconds(12, 1), 13); assert.equal(stepSeconds(12, -1), 11);
assert.equal(stepSeconds(15, 1), 15); assert.equal(stepSeconds(5, -1), 5);
assert.equal(stepSeconds(14.5, 1), 15); assert.equal(stepSeconds(5.5, -1), 5);
assert.equal(canStepSeconds(15, 1), false); assert.equal(canStepSeconds(15, -1), true);
assert.equal(canStepSeconds(5, -1), false); assert.equal(canStepSeconds(5, 1), true);

// ── 2. 帧数跟着重算（卡片用同一个 getActualDuration，17n+5 帧对齐那一套）──
const d12 = getActualDuration(12), d13 = getActualDuration(13);
assert.equal(d12.length, 294, "12 秒 = 294 帧（卡片上「实际 12.25 s · 294 帧」）");
assert.ok(Math.abs(d12.actualSeconds - 12.25) < 1e-9);
assert.ok(d13.length > d12.length && d13.actualSeconds > d12.actualSeconds);
const board = readFileSync(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8").replaceAll("\r\n", "\n");
assert.match(board, /const duration = getActualDuration\(shot\.seconds\);/, "卡片按 shot.seconds 重算实际秒数和帧数");
assert.match(readFileSync(new URL("../lib/shot-card-report.ts", import.meta.url), "utf8"), /actualSeconds: getActualDuration\(shot\.seconds\)\.actualSeconds, requestedSeconds: shot\.seconds/, "卡片检查按新秒数重算");
{ // 正文时间段写到 10 秒，秒数从 10 ▼ 到 9：出现现有的 timeline_overflow 提示，正文不动
  const prompt = "主要动作：她抬头。\n0-5秒：她抬头看门。\n5-10秒：她站起来。";
  const at = (seconds) => checkShot({ prompt, breakdown: breakdownShotPrompt(prompt), actualSeconds: getActualDuration(seconds).actualSeconds, requestedSeconds: seconds, roles: [], pictures: [] }).map((check) => check.code);
  assert.ok(!at(10).includes("timeline_overflow"));
  assert.ok(at(stepSeconds(10, -1)).includes("timeline_overflow"), "改短后提示时间段超了");
}
const checks = readFileSync(new URL("../lib/shot-card-checks.ts", import.meta.url), "utf8");
assert.match(checks, /error\("timeline_overflow", `时间轴写到 \$\{last\.end\} 秒，超过了这一镜的 \$\{requested\} 秒/, "不自动改正文，只提示");

// ── 3. 像素快选写回 JSON ──
const base = { version: "shot-queue-v1", title: "快改测试", defaults: { megapixels: 0.5 }, chapters: [{ title: "一", shots: [
  { title: "A", prompt: "0-6秒：她抬头。", roleIds: [], sceneAssetIds: [], seconds: 12, aspect: "9:16", soundMode: "ambient" },
  { title: "B", prompt: "0-6秒：门开了。", roleIds: [], sceneAssetIds: [], seconds: 8, aspect: "9:16", soundMode: "ambient", megapixels: 0.88 },
  { title: "C", prompt: "0-6秒：灯灭。", roleIds: [], sceneAssetIds: [], seconds: 6, aspect: "16:9", soundMode: "ambient" },
] }] };
const queue = parseShotQueue(JSON.stringify(base));
assert.deepEqual([...MP_PRESETS], [0.45, 0.88]);
assert.equal(mpPreset(0.45), 0.45); assert.equal(mpPreset(0.88), 0.88); assert.equal(mpPreset(0.5), null, "队列写 0.5：两个都不高亮");
const picked = withMegapixels(queue.chapters[0].shots[0], 0.45);
const written = { ...queue, chapters: [{ ...queue.chapters[0], shots: [picked, ...queue.chapters[0].shots.slice(1)] }] };
const reparsed = parseShotQueue(shotQueueJson(written));
assert.equal(reparsed.chapters[0].shots[0].megapixels, 0.45, "写回 JSON 再读出来还是 0.45");
assert.equal(shotQueueMegapixels(reparsed.chapters[0].shots[0], reparsed.defaults), 0.45);
assert.equal(reparsed.chapters[0].shots[1].megapixels, 0.88, "别的镜不动");
// 整集统一：已经是这个值的不算
const all88 = planEpisodeMegapixels(queue, 0.88);
assert.equal(all88.changed, 2, "A（默认 0.5）、C（默认 0.5）要改，B 已经 0.88");
assert.ok(parseShotQueue(shotQueueJson(all88.queue)).chapters[0].shots.every((shot) => shotQueueMegapixels(shot, all88.queue.defaults) === 0.88));
assert.equal(all88.queue.chapters[0].shots[1], queue.chapters[0].shots[1], "B 原样");
assert.equal(planEpisodeMegapixels(all88.queue, 0.88).changed, 0);

// ── 4. 撤销：改秒数 / 像素是一版新的队列文本，撤销回到上一版 ──
const meta = new Map();
const store = new QueueHistoryStore({ get: async (key) => meta.get(key), put: async (key, value) => { meta.set(key, value); } });
const v1 = shotQueueJson(queue);
const v2 = shotQueueJson({ ...queue, chapters: [{ ...queue.chapters[0], shots: [{ ...queue.chapters[0].shots[0], seconds: stepSeconds(12, 1) }, ...queue.chapters[0].shots.slice(1)] }] });
await store.record(queue.title, v1);
const h = await store.record(queue.title, v2);
assert.equal(canUndo(h), true);
const back = await store.step(queue.title, -1);
assert.equal(parseShotQueue(back.text).chapters[0].shots[0].seconds, 12, "Ctrl+Z / 撤销回到 12 秒");
// 卡片里：都走 ctx.save → onChange（队列面板把每个通过检查的文本记进修改历史）
assert.match(board, /const quickSave = \(next: ShotQueueShot\) => \{ setFixError\(""\); if \(ctx\.locked\) \{ setFixError\(ctx\.locked\); return; \} const problem = ctx\.save\(next\);/);
assert.match(board, /const setSeconds = \(seconds: number\) => \{ if \(seconds !== shot\.seconds\) quickSave\(\{ \.\.\.shot, seconds \}\); \};/);
assert.match(board, /const pickMp = \(value: MpPreset\) => quickSave\(withMegapixels\(shot, value\)\);/);
assert.match(board, /const problem = onChange\(plan\.queue\);/, "整集改动也走 onChange");

// ── 5. 已入队过 / 提交中：按钮灰、悬停说明 ──
assert.match(board, /const quickLock = ctx\.locked \? \(ctx\.locked\.includes\("入队过"\) \? "已入队过，要改先另存成新队列" : ctx\.locked\) : "";/);
assert.match(board, /aria-label="加 1 秒" title=\{quickLock \|\|[^}]*\} disabled=\{Boolean\(ctx\.locked\) \|\| !canStepSeconds\(shot\.seconds, 1\)\}/);
assert.match(board, /aria-label="减 1 秒" title=\{quickLock \|\|[^}]*\} disabled=\{Boolean\(ctx\.locked\) \|\| !canStepSeconds\(shot\.seconds, -1\)\}/);
assert.match(board, /className=\{currentMp === value \? "on" : ""\} disabled=\{Boolean\(ctx\.locked\)\} title=\{quickLock \|\|/);
assert.match(board, /disabled=\{Boolean\(ctx\.locked\) \|\| advice\.suggest === shot\.seconds\} title=\{quickLock \|\|/, "「改成 N 秒」同样锁");
assert.match(board, /<span className="scf-mp" title=\{locked \|\|[^}]*\}>整集像素\{MP_PRESETS\.map\(\(value\) => <button key=\{value\} type="button" aria-pressed=\{episodeMp\.current === value\} className=\{episodeMp\.current === value \? "on" : ""\} disabled=\{!!locked\}/, "整集像素：全部同一个值时那个选中");
assert.match(board, /\{episodeMp\.current === null && <em>\{episodeMp\.mixed \|\|/, "不一样时写混合");
assert.match(board, /flashCut\(`已把 \$\{plan\.changed\} 镜改成 \$\{value\.toFixed\(2\)\} MP（还没入队；Ctrl\+Z 可撤销）`\)/, "提示改说法、几秒后淡出");
assert.doesNotMatch(board, /MP，尚未提交|建议秒数，尚未提交/);
assert.match(board, /\.sc-mp button\.on,\.scf-mp button\.on\{border-color:var\(--ff-text-2\);background:var\(--ff-hover\);color:var\(--paper\);font-weight:600\}/, "选中：亮细线框 + 稍亮底色，只用灰阶");
{ // 整集像素状态
  const same = planEpisodeMegapixels(queue, 0.45).queue;
  assert.deepEqual([episodeMpState(same).current, episodeMpState(same).mixed], [0.45, ""]);
  const mixed = { ...queue, chapters: [{ ...queue.chapters[0], shots: [...same.chapters[0].shots.slice(0, 2), withMegapixels(same.chapters[0].shots[2], 0.88)] }] };
  assert.deepEqual([episodeMpState(mixed).current, episodeMpState(mixed).mixed], [null, "混合：0.45 ×2 / 0.88 ×1"]);
  assert.equal(episodeMpState(queue).current, null, "默认 0.50 不是快选值：两个都不选中");
  assert.equal(episodeMpState(queue).mixed, "混合：0.50 ×2 / 0.88 ×1");
}
assert.match(board, /if \(lockNow\.current\) \{ setCutNote\(`不能改：\$\{lockNow\.current\}`\); return; \}/, "页面里回答后再看一次锁");
assert.match(board, /\{value === 0\.45 && <small>测试<\/small>\}/, "0.45 旁边小字「测试」");
assert.match(board, /\{currentMp === null && <em [^>]*>现在 \{card\.megapixels\.toFixed\(2\)\}<\/em>\}/, "别的值：显示原来的值");

// ── 6. 正本 h3q「[时长]」──
const keep = "[时长] 偏长：2 个小反应 估计只要约 3.5 秒，写了 8 秒，有空档模型会自己编动作；要么保留 8 秒，把 0-4秒、4-8秒 补成有内容的（加一个看得见的动作、反应、表情变化或机位变化）；要么缩短，建议约 5 秒";
const a = parseDurationAdvice(keep);
assert.equal(a.kind, "long"); assert.equal(a.suggest, 5, "只取「建议约 N 秒」，不是「保留 8 秒」的 8");
assert.equal(a.keep, "保留 8 秒，把 0-4秒、4-8秒 补成有内容的（加一个看得见的动作、反应、表情变化或机位变化）");
const insert = parseDurationAdvice("[时长] 偏长：2-9.5秒 7.5 秒没有新变化（只有停在/仍然/保持这类，没有新动作）；没有角色的插入镜写了 10 秒，一般 5～6 秒就够；缩短，建议约 5 秒");
assert.deepEqual([insert.kind, insert.suggest, insert.keep], ["long", 5, null]);
const short = parseDurationAdvice("[时长] 偏短：2 个动作、9 个小反应 + 28 字台词 挤在 8 秒（估计至少要约 12.3 秒）；建议约 14 秒");
assert.deepEqual([short.kind, short.suggest, short.keep], ["short", 14, null]);
assert.equal(parseDurationAdvice("[时长] 偏短：要拆镜；建议约 15 秒").suggest, 15);
assert.equal(parseDurationAdvice("[时长] 偏长：建议约 20 秒").suggest, null, "超出 5～15：不出按钮");
assert.equal(parseDurationAdvice("[时长] 新格式看不懂").suggest, null, "不认识的格式：原样显示，不出按钮");
assert.equal(parseDurationAdvice("[时长] 新格式看不懂").text, "[时长] 新格式看不懂");
assert.equal(parseDurationAdvice("[五项·光线] 没写光线"), null);
assert.equal(durationAdviceOf([{ message: "[五项·构图] x" }, { message: keep }]).suggest, 5);
assert.equal(durationAdviceOf(null), null);
const fixes = planDurationFixes(queue, (c, s) => s === 0 ? a : s === 1 ? short : null);
assert.deepEqual(fixes.rows, [{ title: "A", from: 12, to: 5 }, { title: "B", from: 8, to: 14 }]);
assert.deepEqual(fixes.queue.chapters[0].shots.map((shot) => shot.seconds), [5, 14, 6]);
assert.equal(fixes.queue.chapters[0].shots[0].prompt, queue.chapters[0].shots[0].prompt, "只改秒数，不改正文");
assert.equal(planDurationFixes(fixes.queue, (c, s) => s === 0 ? a : null).rows.length, 0, "已经是建议秒数的不再改");
// 卡片：显示原话、「改成 N 秒」走 ▲▼ 同一条路、顶部「N 镜时长可能不合适」筛选、全部改先在页面里问；不拦截入队
assert.match(board, /const durationAdvice = h3q\.state === "ok" \? durationAdviceOf\(h3q\.report\?\.shots\[at\]\) : null;/);
assert.match(board, /onClick=\{\(\) => setSeconds\(advice\.suggest!\)\}>\{advice\.suggest === shot\.seconds \? `已改成 \$\{advice\.suggest\} 秒` : `改成 \$\{advice\.suggest\} 秒`\}/);
assert.match(board, /\{advice\.keep && <small className="muted">或者\{advice\.keep\}/, "两条路时把「补内容」原话也写出来");
assert.match(board, /<b>\{durationCards\.length\}<\/b> 镜时长可能不合适/);
assert.match(board, /filter === "duration" \? Boolean\(card\.durationAdvice\)/);
assert.match(board, /askConfirm\(\{ title: "全部改成建议秒数？"/);
assert.match(board, /只提醒，不拦截入队/);
assert.doesNotMatch(readFileSync(new URL("../lib/shot-gate.ts", import.meta.url), "utf8"), /时长/, "画面五项拦截不看时长");

// ── 7. 本机有正本（可选，FRAMEFLOW_H3_TOOLS）：真实 h3q 输出（标准范本 0 条）──
const runH3q = (file) => execFileSync("python", ["-I", h3q, "check", file, "--all", "--skip-table"], { encoding: "utf8", windowsHide: true, cwd: H3_TOOLS });
const titlesOf = (file) => JSON.parse(readFileSync(file, "utf8")).chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.title));
const SAMPLE = `${H3_TOOLS}/范本/示例项目_EP02v5_L03_标准/示例项目_EP02v5_L03_标准_queue.json`;
let live = "";
if (existsSync(h3q) && existsSync(SAMPLE)) {
  let output = null; try { output = runH3q(SAMPLE); } catch (cause) { output = cause.stdout ?? null; }
  if (output) { const report = parseH3qOutput(output, titlesOf(SAMPLE)); assert.ok(report.shots.every((items) => !durationAdviceOf(items)), "标准范本 0 条"); live += " 标准范本：0 条"; }
}
console.log(`shot card quick params: seconds 5–15 ▲▼, frames re-aligned, 0.45/0.88 written back, episode unify, undo, locked when submitted, h3q [时长] advice parsed;${live || " 本机没有正本，跳过真实 h3q"} ok`);
