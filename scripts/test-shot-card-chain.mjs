// 镜头卡片「接尾帧」提示 + 一键接上：解析正本 h3q 的 [接尾帧] HINT（格式见 lib/shot-card-chain.ts），按钮只改这一镜的接帧字段。
// 不开浏览器、不提交 GPU；本机 h3q 已有 [接尾帧] 时只读地跑一次测试队列（FRAMEFLOW_TEST_QUEUE）核对真实输出。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseChainHint, chainHintOf, applyChainHint } from "../lib/shot-card-chain.ts";
import { parseH3qOutput } from "../lib/h3q-report.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";

// ── 1. 解析：h3q 2026-11-12 真实输出原样 ──
const REAL = "[接尾帧] 可以考虑接上一镜尾帧：S01｜示例镜头A → S02｜示例镜头B；理由：同一场景图、同一组人，机位景别一样（平视，工位中景，固定），站位接得上（她在画左、他在画右）。接上就在这一镜写 firstFrameFrom 上一镜 last（generationMode first-last）；代价是上一镜的瑕疵会带进来、要等上一镜出完再排（正本 什么时候用接尾帧）";
assert.deepEqual(parseChainHint(REAL), { from: "S01｜示例镜头A", to: "S02｜示例镜头B", why: "同一场景图、同一组人，机位景别一样（平视，工位中景，固定），站位接得上（她在画左、他在画右）" });
// 最简格式（理由后面没有做法说明）
assert.deepEqual(parseChainHint("[接尾帧] 可以考虑接上一镜尾帧：A → B；理由：同场同人"), { from: "A", to: "B", why: "同场同人" });
assert.equal(parseChainHint("[时长] 偏长：建议约 5 秒"), null);
assert.equal(parseChainHint("接尾帧镜建议开头写 continuing from the opening frame already moving"), null, "h3q 另一条接尾帧 HINT 不是建议");
assert.equal(chainHintOf([{ message: "[ID] x" }, { message: REAL }])?.to, "S02｜示例镜头B");
assert.equal(chainHintOf(null), null);

// ── 2. 一键接上 ──
const ID = (n) => `role_${String(n).padStart(8, "0")}`;
const base = { roleIds: [ID(1)], sceneAssetIds: ["asset_scene0001"], seconds: 6, aspect: "16:9", prompt: "<Picture 1>是场景。他坐着。" };
const queue = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "测", chapters: [{ title: "一", shots: [{ ...base, title: "A" }, { ...base, title: "B", keyframe: { prompt: "a man sits" } }, { ...base, title: "C", firstFrameAssetId: "asset_first0001", generationMode: "first-last" }] }] }));
const [a, b, c] = queue.chapters[0].shots;
const hint = { from: "A", to: "B", why: "同场同人" };
const done = applyChainHint(b, a, hint);
assert.ok("shot" in done);
assert.equal(done.shot.generationMode, "first-last");
assert.deepEqual(done.shot.firstFrameFrom, { shot: "A", frame: "last" });
assert.equal(done.shot.keyframe, undefined, "接帧后不能再有 keyframe（队列校验会拒）");
assert.equal(done.shot.prompt, b.prompt, "提示词不动：首帧不占 <Picture N> 编号");
assert.match(done.note, /关键帧描述去掉了/);
assert.ok(b.keyframe, "原来那一镜对象没被改");
// 改完整份队列还能通过校验
parseShotQueue(JSON.stringify({ ...queue, chapters: [{ ...queue.chapters[0], shots: [a, done.shot, c] }] }));
assert.match(applyChainHint(b, undefined, hint).problem, /本章第一镜/);
assert.match(applyChainHint(b, c, hint).problem, /对不上/, "上一镜标题不对（队列改过）不接");
assert.match(applyChainHint(c, b, { from: "B", to: "C", why: "" }).problem, /取消首帧/);
assert.match(applyChainHint(done.shot, a, hint).problem, /已经接了/);

// ── 3. 卡片接线 ──
const board = readFileSync(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8");
assert.match(board, /const chainHint = h3q\.state === "ok" \? chainHintOf\(h3q\.report\?\.shots\[at\]\) : null;/, "只认正本 h3q，h3q 没跑成就不显示");
assert.match(board, /card\.chainHint && !shot\.firstFrameFrom && <div className="sc-cell wide sc-duration sc-chain-hint">/);
assert.match(board, /const result = applyChainHint\(card\.shot, queue\.chapters\[card\.chapter\]\.shots\[card\.index - 1\], card\.chainHint\);[\s\S]{0,120}const problem = saveShot\(card, result\.shot\);/, "走 saveShot：进撤销历史、入队过的照常拦");
assert.match(board, /if \(lockNow\.current\) return lockNow\.current;\n\s+const result = applyChainHint/);

// ── 4. 本机 h3q 有 [接尾帧] 时（可选：FRAMEFLOW_H3_TOOLS + FRAMEFLOW_TEST_QUEUE 指向一份真实队列）：真实输出能对上镜头 ──
const H3_TOOLS = process.env.FRAMEFLOW_H3_TOOLS || "h3-tools";
const h3q = `${H3_TOOLS}/h3q.py`;
const EP03 = process.env.FRAMEFLOW_TEST_QUEUE || "";
let live = " 本机没有正本或测试队列，跳过真实输出核对";
if (EP03 && existsSync(h3q) && existsSync(EP03)) {
  let output = null;
  try { output = execFileSync("python", ["-I", h3q, "check", EP03, "--all", "--skip-table"], { encoding: "utf8", windowsHide: true, cwd: H3_TOOLS, env: { ...process.env, PYTHONIOENCODING: "utf-8" } }); } catch (cause) { output = cause.stdout ?? null; }
  if (output && /\[接尾帧\] 可以考虑/.test(output)) {
    const titles = JSON.parse(readFileSync(EP03, "utf8")).chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.title));
    const report = parseH3qOutput(output, titles);
    const hits = report.shots.map((items, i) => [i, chainHintOf(items)]).filter(([, h]) => h);
    assert.ok(hits.length > 0);
    for (const [i, h] of hits) { assert.equal(h.to, titles[i], "提示挂在「这一镜」上"); assert.equal(h.from, titles[i - 1], "上一镜就是队列里的前一镜"); assert.ok(h.why.length > 0); }
    live = ` 测试队列真实 h3q：${hits.length} 镜有接尾帧提示，标题全部对上`;
  } else live = " 本机 h3q 还没有 [接尾帧]，跳过真实输出核对";
}
console.log(`shot card chain hint: 解析 h3q [接尾帧]、一键接上（first-last + firstFrameFrom，去 keyframe，提示词不动）、对不上 / 已定首帧不接；${live}; ok`);
