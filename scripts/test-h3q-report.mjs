// 正本 h3q check 的输出按镜头拆开（卡片标「正本 h3q」）；h3q 跑不起来要明说，不能当作通过。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { h3qFix, parseH3qOutput } from "../lib/h3q-report.ts";
import { readZhengbenVersion, runH3qCheck, H3_TOOLS } from "./zhengben-helper.mjs";
const H3Q_PY = path.join(H3_TOOLS, "h3q.py");

const titles = ["EP02-L01｜标题里有：冒号", "EP02-L02｜第二镜"];
const output = [
  "队列: 测试 ｜ 2 镜 ｜ 接帧依赖 0 条",
  "结果: ERROR 2 ｜ WARN 2 ｜ HINT 1",
  "ERROR 镜1 EP02-L01｜标题里有：冒号：dialogue 不是空的：画布会追加中文角色名",
  "WARN  镜2 EP02-L02｜第二镜：没写景别（如 medium shot from the waist up）",
  "ERROR 镜2 EP02-L02｜第二镜 台词1：缺 text",
  "HINT  镜1 EP02-L01｜标题里有：冒号：没写焦段（如 50mm-equivalent lens）和景深",
  "WARN  一致性：风格块有 2 种写法（镜 1 / 2）；整集逐字复用一套",
  "有 ERROR，不能投递。",
].join("\n");
const report = parseH3qOutput(output, titles);
assert.ok(report);
assert.deepEqual(report.counts, { ERROR: 2, WARN: 2, HINT: 1 });
assert.equal(report.shots[0].length, 2);
assert.equal(report.shots[0][0].message, "dialogue 不是空的：画布会追加中文角色名", "标题里的「：」不拆错");
assert.equal(report.shots[0][1].level, "HINT");
assert.deepEqual(report.shots[1].map((item) => item.message), ["没写景别（如 medium shot from the waist up）", "台词1：缺 text"]);
assert.deepEqual(report.general, [{ level: "WARN", where: "一致性", message: "风格块有 2 种写法（镜 1 / 2）；整集逐字复用一套" }]);
assert.equal(parseH3qOutput("Traceback (most recent call last):\n  boom", titles), null, "看不懂的输出不能当作通过");
assert.equal(h3qFix(report.shots[0][0].message), "dialogue_field");
assert.equal(h3qFix("正文点了背景音乐或配乐，包含「没有背景音乐」"), "music_named");
assert.equal(h3qFix("没写景别"), null);

// 跑不起来：明确的失败原因，不是通过。
const prev = process.env.FRAMEFLOW_PYTHON;
process.env.FRAMEFLOW_PYTHON = "frameflow-no-such-python";
const { runH3qCheck: runMissing } = await import(`./zhengben-helper.mjs?missing=${Date.now()}`);
const missing = await runMissing({ queue: { version: "shot-queue-v1", title: "x", chapters: [] } });
if (existsSync(H3Q_PY)) { assert.equal(missing.ok, false); assert.match(missing.error, /没找到 frameflow-no-such-python/); }
else assert.match(missing.error, /h3q\.py 不在/);
if (prev === undefined) delete process.env.FRAMEFLOW_PYTHON; else process.env.FRAMEFLOW_PYTHON = prev;
assert.equal((await runH3qCheck({})).ok, false, "没收到队列");
const badTable = await runH3qCheck({ queue: { version: "shot-queue-v1", title: "x", chapters: [] }, tableFile: "C:/x/不是对照表.md" });
assert.equal(badTable.ok, false);

// 真跑一次（机器上有 h3q 时）：结果能解析，没对照表时加了 --skip-table。
if (existsSync(H3Q_PY)) {
  const queue = { version: "shot-queue-v1", title: "h3q 冒烟", defaults: { noBackgroundMusic: true }, chapters: [{ title: "一", shots: [{ title: "S1", prompt: "0-5秒：她走到窗边。没有背景音乐。", roleIds: [], sceneAssetIds: [], seconds: 5, aspect: "9:16", soundMode: "ambient" }] }] };
  const result = await runH3qCheck({ queue });
  if (result.ok) {
    assert.match(result.command, /--skip-table/);
    assert.equal(result.table, false);
    const parsed = parseH3qOutput(result.output, ["S1"]);
    // 正本 v2026-11-13.1 起旧格式每镜报 [旧格式] ERROR、不再细查点名配乐；之前的版本报点名配乐。两种都算 h3q 跑通、能解析。
    assert.ok(parsed && parsed.shots[0].some((item) => item.level === "ERROR" && (h3qFix(item.message) === "music_named" || item.message.includes("[旧格式]"))), result.output);
  } else assert.match(result.error, /没找到|不在|超过|没给出结果/, result.error);
}

// 正本版本号：读开头「正本 v…」那句；读不到记「未知」（写进 Run 记录和入队会话）。
{
  const dir = mkdtempSync(path.join(os.tmpdir(), "zhengben-version-"));
  try {
    const file = path.join(dir, "SKILL_h3-video.md");
    writeFileSync(file, ["---", "name: h3-video", "---", "> **正本 v2026-11-09.6**｜唯一正本", ""].join("\n"));
    assert.equal((await readZhengbenVersion(file)).version, "v2026-11-09.6");
    writeFileSync(file, ["---", "name: h3-video", "---", "没有版本号", ""].join("\n"));
    assert.equal((await readZhengbenVersion(file)).version, "未知");
    assert.equal((await readZhengbenVersion(path.join(dir, "不存在.md"))).version, "未知");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  if (existsSync(path.join(H3_TOOLS, "SKILL_h3-video.md"))) assert.match((await readZhengbenVersion()).version, /^v\d{4}-\d{2}-\d{2}/, "本机正本能读到版本号");
}
console.log("h3q report: 按镜拆开、跑不起来明说、真跑能解析、正本版本号; ok");
