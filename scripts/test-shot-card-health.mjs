// 镜头卡片「程序体检」：顶部小卡片计数、和 h3q / 卡片重复的合并、「复制给 AI 修改」里带上体检和 h3q [时长]。
// 不开浏览器、不提交 GPU；本机有正本时只读跑一次 h3q.py check（EP02_v5）看真实合并情况。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { rawShotHealth, cardHealth, healthDigest, versionAtLeast, H3Q_DURATION_SINCE } from "../lib/shot-card-health.ts";
import { aiFixText } from "../lib/shot-card-ai-copy.ts";
import { parseShotQueue, shotQueueWarnings, shotHealth } from "../lib/shot-queue.ts";
import { parseH3qOutput } from "../lib/h3q-report.ts";

const shot = (extra) => ({ title: "T", prompt: "主要动作：她抬头。", roleIds: [], sceneAssetIds: [], seconds: 10, aspect: "9:16", soundMode: "av", ...extra });

// ── 1. 来源和 code ──
const beats = shot({ seconds: 12, prompt: "主要动作：她走过去。\n0-3秒：她抬头。\n3-6秒：她起身。\n6-9秒：她走到门口。\n9-14秒：她开门。\n对白（中文普通话，口型同步）：李四：“好。”" });
const raw = rawShotHealth(beats);
const codes = raw.map((entry) => entry.code);
assert.ok(codes.includes("duration_align"), "12 秒对齐到 12.25 秒");
assert.ok(codes.includes("health:timeline_overflow"), "写到 14 秒");
assert.ok(codes.includes("health:beats_accelerated"), "4 个时间段 + 10 步");
assert.ok(codes.includes("dialogue_slow"), "1 个字 / 12 秒");
assert.ok(raw.find((entry) => entry.code === "health:beats_accelerated").message.startsWith("体检："), "体检提示照旧带「体检：」");
// 和原来 shotQueueWarnings 每镜那部分一字不差（只是带上 code）
const single = { version: "shot-queue-v1", title: "q", chapters: [{ title: "c", shots: [beats] }] };
assert.deepEqual(raw.map((entry) => entry.message), shotQueueWarnings(parseShotQueue(JSON.stringify(single))).map((w) => w.replace(/^「[^」]*」/, "")));
assert.deepEqual(shotHealth(beats), raw.filter((entry) => entry.code.startsWith("health:")).map((entry) => entry.message), "shotHealth 输出不变");

// 修掉的误报：单镜算「本集设定」会把别的镜用到的设定报成「整集没有一镜用到」
const ep = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "ep", episode: { style: "写实真人电影质感，Kodak Vision3 250D 胶片颗粒。" }, chapters: [{ title: "c", shots: [
  shot({ title: "A", prompt: "{{本集.风格}}\n主要动作：她抬头。" }), shot({ title: "B", prompt: "主要动作：门开了。" })] }] }));
const oneShotQueue = { ...ep, chapters: [{ title: "", shots: [ep.chapters[0].shots[1]] }] };
assert.ok(shotQueueWarnings(oneShotQueue).some((w) => w.includes("整集没有一镜用到")), "旧算法单镜会误报");
assert.ok(!rawShotHealth(ep.chapters[0].shots[1]).some((entry) => entry.message.includes("本集设定")), "卡片不再误报");

// ── 2. 去重 ──
assert.equal(versionAtLeast("v2026-11-11.7", H3Q_DURATION_SINCE), true);
assert.equal(versionAtLeast("v2026-11-11.5", H3Q_DURATION_SINCE), false);
assert.equal(versionAtLeast(undefined, H3Q_DURATION_SINCE), false);
const dur = { message: "[时长] 偏短：4 个动作 挤在 12 秒；建议约 14 秒" };
// h3q 没跑成（null）：只合并帧数对齐那条（参数格子永远有）；时间轴看卡片自己的检查
let h = cardHealth(raw, { h3q: null, cardCodes: [] });
assert.deepEqual(h.merged.map((entry) => entry.code), ["duration_align"]);
h = cardHealth(raw, { h3q: null, cardCodes: ["timeline_overflow"] });
assert.deepEqual(h.merged.map((entry) => entry.code).sort(), ["duration_align", "health:timeline_overflow"]);
// h3q 报了 [时长]：偏慢 / 留白合并进去
h = cardHealth(raw, { h3q: [dur], h3qVersion: "v2026-11-11.7", cardCodes: [] });
assert.ok(h.merged.some((entry) => entry.code === "dialogue_slow" && entry.into === "正本 h3q「[时长]」"));
// 正本有时长检查但没报：偏慢也合并（以正本为准）；旧正本不合并
assert.ok(cardHealth(raw, { h3q: [], h3qVersion: "v2026-11-11.7", cardCodes: [] }).merged.some((entry) => entry.code === "dialogue_slow"));
assert.ok(cardHealth(raw, { h3q: [], h3qVersion: "v2026-11-11.5", cardCodes: [] }).items.some((entry) => entry.code === "dialogue_slow"));
// 动作节点太密 + h3q 偏短：合并
const dense = rawShotHealth(shot({ seconds: 5, prompt: "0-1秒：抬头。\n1-2秒：起身。\n2-3秒：转身。\n3-4秒：走。" }));
assert.ok(dense.some((entry) => entry.code === "health:too_many_beats"));
assert.ok(cardHealth(dense, { h3q: [{ message: "[时长] 偏短：挤；建议约 9 秒" }], h3qVersion: "v2026-11-11.7", cardCodes: [] }).merged.some((entry) => entry.code === "health:too_many_beats"));
assert.ok(cardHealth(dense, { h3q: [{ message: "[时长] 偏长：空；建议约 5 秒" }], h3qVersion: "v2026-11-11.7", cardCodes: [] }).items.some((entry) => entry.code === "health:too_many_beats"), "偏长不合并太密");
// 对白过快 + h3q 字/秒
const fast = rawShotHealth(shot({ seconds: 5, prompt: "对白（中文普通话，口型同步）：李四：“" + "好".repeat(40) + "”" }));
assert.ok(fast.some((entry) => entry.code === "dialogue_fast"));
assert.ok(cardHealth(fast, { h3q: [{ message: "中文台词 40 字 / 5 秒 = 8.0 字/秒，超过 3.5（易吞尾字）" }], cardCodes: [] }).merged.some((entry) => entry.code === "dialogue_fast"));
// 和 h3q 不重复的照旧显示
assert.ok(h.items.some((entry) => entry.code === "health:beats_accelerated"), "10 步加速提醒 h3q 不查，留着");

// ── 3. 顶部小卡片计数 ──
const d = healthDigest([{ items: [{ code: "a", message: "1" }, { code: "b", message: "2" }], merged: [{ code: "c", message: "3", into: "x" }] }, { items: [], merged: [] }, undefined, { items: [{ code: "a", message: "1" }], merged: [] }]);
assert.deepEqual([d.shots, d.items, d.merged], [2, 3, 1]);
assert.equal(d.text, "2 镜有 3 条体检提示 · 另有 1 条和 h3q / 卡片重复，已合并");
assert.equal(healthDigest([]).text, "没有体检提示");
assert.equal(healthDigest([{ items: [], merged: [{ code: "c", message: "3", into: "x" }] }]).text, "没有要看的体检提示（1 条和 h3q / 卡片重复，已合并）");

// ── 4. 复制给 AI 修改：带体检，和 h3q 分开；[时长] 单独写 ──
const base = { code: "L01", title: "L01｜她抬头", chapter: "办公室", missing: [], canvas: [], gate: [] };
const text = aiFixText({ queueTitle: "q", chapters: ["办公室"], scope: "这一镜", shots: [
  { ...base, h3q: [{ level: "WARN", where: "", message: "[时长] 偏长：没新动作；缩短，建议约 5 秒" }, { level: "HINT", where: "", message: "最后一句台词后没写留白" }], health: ["体检：4 个按时间排的动作节点：…可改用「理解优先」"] },
  { ...base, code: "L02", title: "L02｜只有体检", h3q: [], health: ["对白可能偏慢或留白较长：约 1.3 字当量/秒"] },
] }).text;
assert.match(text, /画布程序体检（只是提醒，和正本冲突时听正本）：\n- 体检：4 个按时间排的动作节点/);
assert.match(text, /【L02】L02｜只有体检[\s\S]*画布程序体检[\s\S]*对白可能偏慢/, "只有体检提示的镜头也列出来");
assert.match(text, /时长（正本 h3q，只是提醒；秒数由用户在卡片里点「改成 N 秒」改[^\n]*\n- \[时长\] 偏长：没新动作；缩短，建议约 5 秒/);
const h3qBlock = text.slice(text.indexOf("正本 h3q 原文："), text.indexOf("时长（正本 h3q"));
assert.ok(h3qBlock.includes("最后一句台词后没写留白") && !h3qBlock.includes("[时长]"), "[时长] 不在 h3q 原文里重复");
assert.ok(text.indexOf("正本 h3q 原文") < text.indexOf("画布程序体检"), "h3q 和体检分开写");

// ── 5. 卡片源码：小卡片放在 h3q 后面（截图里那个空格子）、每镜折叠区有复制图标、所有复制都带体检 ──
const board = readFileSync(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8");
const at = (needle) => board.indexOf(needle);
assert.ok(at('{ id: "h3q", label: "正本 h3q"') < at('id: "health", label: "程序体检"') && at('id: "health", label: "程序体检"') < at('id: "completeness", label: "提示词完整度"'));
assert.match(board, /<AiCopyButton title="把有程序体检提示的镜头[^"]*" onCopy=\{\(\) => copyForAi\("有程序体检提示的镜头", rows\)\} \/>/);
assert.match(board, /summary: digest\.text/);
assert.match(board, /health: \(card\.health\?\.items \?\? \[\]\)\.map\(\(entry\) => entry\.message\),/, "aiShot 带体检：顶栏写错 / 漏写、完整度、h3q、每镜复制都走它");
assert.match(board, /className="sc-btn sc-checks-copy" title="把这一镜的问题（画布红字、正本 h3q、程序体检[^"]*" onClick=\{ctx\.copyForAi\}><ClipboardCopy aria-hidden="true" \/>复制给 AI 修改<\/button>/, "每镜检查框（含程序体检）右上角有文字按钮");
assert.match(board, /healthItems\.length > 0\) && <div className=\{`sc-checks/, "只有体检提示的镜头也显示折叠区");
assert.match(board, /const health = cardHealth\(card\.healthRaw, \{ h3q: h3q\.state === "ok" \? h3q\.report\?\.shots\[at\] \?\? \[\] : null, h3qVersion: h3q\.version, cardCodes: card\.checks\.map\(\(check\) => check\.code\) \}\);/);

// ── 6. 本机有正本（可选：FRAMEFLOW_H3_TOOLS + FRAMEFLOW_TEST_QUEUE）：真实 h3q 下的合并情况 ──
const H3_TOOLS = process.env.FRAMEFLOW_H3_TOOLS || "h3-tools";
const h3q = `${H3_TOOLS}/h3q.py`;
const EP02 = process.env.FRAMEFLOW_TEST_QUEUE || "";
let live = " 本机没有正本，跳过真实 h3q";
if (EP02 && existsSync(h3q) && existsSync(EP02)) {
  let output; try { output = execFileSync("python", ["-I", h3q, "check", EP02, "--all", "--skip-table"], { encoding: "utf8", windowsHide: true, cwd: H3_TOOLS }); } catch (cause) { output = cause.stdout ?? ""; }
  const version = /正本\s*(v\d{4}-\d{2}-\d{2}(?:\.\d+)?)/.exec(output)?.[1] ?? /(v2026-\d{2}-\d{2}(?:\.\d+)?)/.exec(readFileSync(`${H3_TOOLS}/SKILL_h3-video.md`, "utf8"))?.[1];
  const q = parseShotQueue(readFileSync(EP02, "utf8"));
  const titles = q.chapters.flatMap((c) => c.shots.map((s) => s.title));
  const report = parseH3qOutput(output, titles);
  if (report) {
    const list = q.chapters.flatMap((c) => c.shots).map((s, i) => cardHealth(rawShotHealth(s, q.defaults), { h3q: report.shots[i] ?? [], h3qVersion: version, cardCodes: [] }));
    const digest = healthDigest(list);
    const mergedCodes = {}; for (const health of list) for (const entry of health.merged) mergedCodes[entry.code] = (mergedCodes[entry.code] ?? 0) + 1;
    const keptCodes = {}; for (const health of list) for (const entry of health.items) keptCodes[entry.code] = (keptCodes[entry.code] ?? 0) + 1;
    live = ` 测试队列（正本 ${version}）：${digest.text}；合并 ${JSON.stringify(mergedCodes)}；留下 ${JSON.stringify(keptCodes)}`;
  }
}
console.log(`shot card health: codes, episode misfire fixed, merges with h3q / card, top-card counts, AI copy includes 体检 and [时长];${live} ok`);
