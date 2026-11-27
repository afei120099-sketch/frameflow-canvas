// 画面五项·必写（用户 2026-11-11）：风格胶片、光线、景别焦段、构图、运镜机位漏写 → 这镜写错、不能渲染；整集 / 本章 / 收件箱整批不提交；标准范本照常能入队。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { GATE_CATEGORIES, H3Q_FIVE_SINCE, h3qChecksFive, h3qGateCategory, h3qGateItems, queueGate, shotGate, shotGateMessage } from "../lib/shot-gate.ts";
import { parseH3qOutput } from "../lib/h3q-report.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueCardReport, shotCardChecks } from "../lib/shot-card-report.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";
import { SHOT_CARD_GUIDE } from "../lib/shot-card-guide.ts";
import { GateConfirmStore, confirmationHolds, gateConfirmKey } from "../lib/shot-gate-confirm.ts";

assert.deepEqual([...GATE_CATEGORIES], ["style", "light", "shotsize", "compose", "camera"]);

// ── 1. 标准范本：五项都写了，能入队 ──
const H3_TOOLS = process.env.FRAMEFLOW_H3_TOOLS || "h3-tools";
const SAMPLE = `${H3_TOOLS}/范本/示例项目_EP02v5_L03_标准/示例项目_EP02v5_L03_标准_queue.json`;
let sampleChecked = false;
if (existsSync(SAMPLE)) {
  const sample = parseShotQueue(readFileSync(SAMPLE, "utf8"));
  const gate = queueGate(sample);
  assert.equal(gate.ok, true, gate.message); assert.equal(gate.message, "");
  assert.equal(shotGateMessage(sample.chapters[0].shots[0]), "");
  assert.ok(!shotCardChecks(sample.chapters[0].shots[0], sample, [], new Map()).some((check) => check.code.startsWith("gate:")));
  sampleChecked = true;
}

// ── 2. 漏写一项 → 写错、不能渲染、整批不提交 ──
const full = [
  "写实真人电影质感，Kodak Vision3 250D 胶片颗粒。中近景，35mm 等效，浅景深，后景虚化，机位固定。他在画左，脸在画面上三分之一，前景是桌沿。",
  "夜里的办公室：台灯在画右，暖黄色的光照在他脸上。",
  "主要动作：他抬眼。",
  "0-3秒：他抬眼，下颌轻绷。",
  "画面要求：竖屏9:16。",
].join("\n");
const shot = (title, prompt = full) => ({ title, prompt, roleIds: [], sceneAssetIds: [], seconds: 6, aspect: "9:16", soundMode: "silent", generationMode: "auto", dialogue: [] });
assert.deepEqual(shotGate(shot("EP-L01｜好")), []);
const noDof = shot("EP-L02｜缺景深", full.replace("浅景深，后景虚化，", ""));
const noFilm = shot("EP-L03｜缺胶片", full.replace("写实真人电影质感，Kodak Vision3 250D 胶片颗粒。", ""));
const noCamera = shot("EP-L04｜缺机位", full.replace("机位固定。", ""));
assert.deepEqual(shotGate(noDof).map((item) => item.id), ["shotsize"]); assert.match(shotGate(noDof)[0].note, /缺景深/);
assert.deepEqual(shotGate(noFilm).map((item) => item.id), ["style"]);
assert.deepEqual(shotGate(noCamera).map((item) => item.id), ["camera"]);
assert.match(shotGateMessage(noDof), /画面五项漏写或写错，不能渲染：景别焦段（画布完整度判定）/);
const checks = shotCardChecks(noDof, { defaults: {} }, [], new Map());
assert.ok(checks.some((check) => check.code === "gate:shotsize" && check.level === "error"), "卡片上算写错（红）");
// 其余类别（如每段表情、参考说明）漏写不拦。
assert.equal(queueGate(parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "好", chapters: [{ title: "一", shots: [shot("EP-L01｜好")] }] }))).ok, true);

const q = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "测试", defaults: { noBackgroundMusic: true }, chapters: [{ title: "一", shots: [shot("EP-L01｜好"), noDof] }, { title: "二", shots: [noFilm, noCamera] }] }));
const all = queueGate(q);
assert.equal(all.ok, false); assert.equal(all.failures.length, 3);
assert.match(all.message, /整批不提交：L02 景别焦段；L03 风格胶片；L04 运镜机位/);
const ch1 = queueGate(q, 0); assert.equal(ch1.failures.length, 1); assert.match(ch1.message, /本章不提交：L02/);
assert.equal(queueGate(parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "测试", chapters: [{ title: "一", shots: [shot("EP-L01｜好")] }, { title: "二", shots: [noFilm] }] })), 0).ok, true, "只入第一章时第二章不影响");
const report = queueCardReport(q, [], []);
assert.equal(report.gate.ok, false); assert.deepEqual(report.gate.failures.map((f) => f.title), ["EP-L02｜缺景深", "EP-L03｜缺胶片", "EP-L04｜缺机位"]);
assert.ok(report.shots[1].errors.some((e) => e.startsWith("画面五项·景别焦段漏写")));

// ── 2a. 以正本 h3q 为准：[五项·…] ERROR 拦；h3q 没跑成画布兜底并写明；占位不算漏写 ──
assert.equal(h3qGateCategory("[五项·景别焦段] 没写景别"), "shotsize"); assert.equal(h3qGateCategory("[五项·运镜机位] x"), "camera"); assert.equal(h3qGateCategory("对白里有人名"), null);
assert.equal(H3Q_FIVE_SINCE, "v2026-11-11.4");
for (const [v, ok] of [["v2026-11-11.4", true], ["v2026-11-11.5", true], ["v2026-11-12.1", true], ["v2026-11-12", true], ["v2026-11-11", false], ["v2026-11-11.3", false], ["v2026-10-30.9", false], ["未知", false], [undefined, false]]) assert.equal(h3qChecksFive(v), ok, String(v));
assert.deepEqual(h3qGateItems([{ level: "ERROR", where: "", message: "[五项·光线] 没有光线句" }, { level: "WARN", where: "", message: "[五项·构图] 只是提醒" }, { level: "ERROR", where: "", message: "[五项·光线] 写了「只有一盏灯」" }, { level: "ERROR", where: "", message: "dialogue 不是空" }]).map((i) => [i.id, i.source, i.note]),
  [["light", "h3q", "没有光线句；写了「只有一盏灯」"]], "只认 ERROR，同类合并，其他 ERROR 不拦");
const titles = (queue) => queue.chapters.flatMap((part) => part.shots.map((item) => item.title));
// h3q 说 L02 / L03 / L04 五项都过（画布关键词没认出来也不拦），L01 光线写错（画布没看出来也要拦）。
const fakeOut = (queue, lines) => [...lines, "结果: ERROR " + lines.filter((l) => l.startsWith("ERROR")).length + " ｜ WARN 0 ｜ HINT 0"].join(String.fromCharCode(10));
const h3qReport = parseH3qOutput(fakeOut(q, ["ERROR 镜1 EP-L01｜好：[五项·光线] 光线写了「不暗 / 不死黑」这类否定句"]), titles(q));
const viaH3q = queueGate(q, undefined, undefined, { source: "h3q", report: h3qReport });
assert.equal(viaH3q.source, "h3q"); assert.deepEqual(viaH3q.failures.map((f) => [f.code, f.items.map((i) => i.id)]), [["L01", ["light"]]]);
assert.match(viaH3q.message, /L01 光线（正本 h3q 判定）/);
assert.equal(shotGateMessage(noDof, undefined, undefined, [], { source: "h3q", report: h3qReport }), "", "h3q 查过没报五项 = 过");
assert.match(shotGateMessage(shot("EP-L01｜好"), undefined, undefined, h3qReport.shots[0]), /不能渲染：光线（正本 h3q 判定）/);
const viaCanvas = queueGate(q, undefined, undefined, { source: "canvas", why: "h3q 没跑成：收件箱助手没启动" });
assert.equal(viaCanvas.source, "canvas"); assert.equal(viaCanvas.failures.length, 3);
assert.match(viaCanvas.message, /画布兜底判定：正本 h3q 没用上——h3q 没跑成：收件箱助手没启动/);
// 兜底时本集设定占位算写了：{{本集.风格}} / {{本集.光线.办公室}} 换掉原句，不拦。
const held = shot("EP-L05｜占位", full.replace("写实真人电影质感，Kodak Vision3 250D 胶片颗粒。", "{{本集.风格}}").replace("夜里的办公室：台灯在画右，暖黄色的光照在他脸上。", "{{本集.光线.办公室}}"));
assert.deepEqual(shotGate(held), [], "占位不当成漏写");
assert.deepEqual(shotGate(shot("EP-L06｜真漏", full.replace("夜里的办公室：台灯在画右，暖黄色的光照在他脸上。", ""))).map((i) => i.id), ["light"], "没占位的照样拦");
// 真跑一次正本 h3q（本机有 python 和 h3工具时）：五项 ERROR 的前缀和画布对得上。
const H3Q = `${H3_TOOLS}/h3q.py`;
let realH3q = "没跑（本机没有 h3工具）";
if (existsSync(H3Q)) {
  const dir = mkdtempSync(join(tmpdir(), "gate-h3q-")); const file = join(dir, "q.json");
  writeFileSync(file, JSON.stringify({ version: "shot-queue-v1", title: "五项测试", chapters: [{ title: "一", shots: [shot("EP-L01｜好"), shot("EP-L06｜真漏", full.replace("夜里的办公室：台灯在画右，暖黄色的光照在他脸上。", "")), noCamera] }] }));
  const run = spawnSync("python", ["-I", H3Q, "check", file, "--all", "--skip-table"], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  rmSync(dir, { recursive: true, force: true });
  const parsed = run.status !== null ? parseH3qOutput(run.stdout ?? "", ["EP-L01｜好", "EP-L06｜真漏", noCamera.title]) : null;
  if (parsed) {
    const ids = parsed.shots.map((items) => h3qGateItems(items).map((i) => i.id));
    // 正本 v2026-11-13.1（f053768）起旧格式每镜报 [旧格式] ERROR、不再查旧格式的五项：卡片按「旧格式」一组照拦（官方格式的五项见 test:official-format）。
    if (parsed.shots.every((items) => items.some((item) => item.level === "ERROR" && item.message.includes("[旧格式]")))) {
      for (const items of parsed.shots) assert.ok(shotGate(shot("x"), [], items).some((i) => i.id === "legacy_format"), "旧格式照拦");
      realH3q = "真跑 h3q：正本已停用旧格式，三镜都报 [旧格式]，卡片按「旧格式」拦";
    } else {
    assert.ok(ids[1].includes("light"), `h3q 应对缺光线报 [五项·光线]：${JSON.stringify(parsed.shots[1])}`);
    assert.ok(ids[2].includes("camera"), `h3q 应对缺机位报 [五项·运镜机位]：${JSON.stringify(parsed.shots[2])}`);
    realH3q = `真跑 h3q：L06 ${ids[1].join("+")}、L04 ${ids[2].join("+")}，L01 ${ids[0].join("+") || "五项全过"}`;
    }
  } else realH3q = `h3q 没跑成（${(run.stderr || run.error?.message || "").slice(0, 80)}），只测了解析`;
}

// ── 2b. 用户在卡片里亲手确认（写理由）才放行；只对当时那段正文有效；文件里的确认字段一律无视 ──
const mem = new Map();
const store = new GateConfirmStore({ get: async (key) => mem.get(key) ?? null, put: async (key, value) => { mem.set(key, value); } });
await assert.rejects(store.confirm({ prompt: noDof.prompt, reason: "  ", items: ["shotsize"], queueTitle: "测试", shotTitle: noDof.title }), /理由/);
await store.confirm({ prompt: noDof.prompt, reason: "黑场转场，不需要景深", items: ["shotsize"], queueTitle: "测试", shotTitle: noDof.title });
const shotsOf = (queue) => queue.chapters.flatMap((part) => part.shots);
let lookup = await store.lookupFor(shotsOf(q));
const withConfirm = queueGate(q, undefined, lookup);
assert.equal(withConfirm.failures.length, 2, "L02 确认过放行，L03 / L04 照样拦");
assert.deepEqual(withConfirm.overridden, [{ title: noDof.title, reason: "黑场转场，不需要景深" }]);
assert.equal(queueGate(q, 0, lookup).ok, true, "第一章只剩确认过的 L02");
assert.equal(shotGateMessage(noDof, undefined, lookup), "");
// 正文一改（预设、整集都换、撤销恢复都一样是改正文）就失效。
const edited = { ...noDof, prompt: noDof.prompt.replace("中近景", "近景") };
assert.equal(confirmationHolds(mem.get(gateConfirmKey(noDof.title)), edited), false);
const qEdited = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "测试", chapters: [{ title: "一", shots: [shot("EP-L01｜好"), edited] }] }));
assert.equal(queueGate(qEdited, undefined, await store.lookupFor(shotsOf(qEdited))).ok, false, "改了正文后确认失效");
assert.match(shotGateMessage(edited, undefined, lookup), /不能渲染/, "旧的查找结果也不认新正文");
// 卡片看到失效记录会删掉：撤销回原文也不复活。
assert.equal(await store.current(edited, "测试"), null);
assert.equal(mem.get(gateConfirmKey(noDof.title)), null, "失效记录已删");
assert.equal(queueGate(q, 0, await store.lookupFor(shotsOf(q))).ok, false, "回到原文要重新确认");
// 取消确认。
await store.confirm({ prompt: noDof.prompt, reason: "再确认一次", items: ["shotsize"], queueTitle: "测试", shotTitle: noDof.title });
assert.equal(queueGate(q, 0, await store.lookupFor(shotsOf(q))).ok, true);
await store.revoke(noDof.title);
assert.equal(queueGate(q, 0, await store.lookupFor(shotsOf(q))).ok, false, "取消确认后重新被拦");
// AI 写进队列 JSON 的「确认 / 跳过检查」字段：不管 parse 留不留，都不放行。
const forged = { version: "shot-queue-v1", title: "测试", skipGate: true, gateConfirmed: true, defaults: { noBackgroundMusic: true, skipChecks: true },
  chapters: [{ title: "一", shots: [{ ...noDof, gateOverride: { reason: "AI 说没问题" }, confirmed: true, manualConfirm: "我确认没问题", skipGate: true }] }] };
let forgedQueue; try { forgedQueue = parseShotQueue(JSON.stringify(forged)); } catch { forgedQueue = forged; }
assert.equal(queueGate(forgedQueue).ok, false, "文件里的确认字段不算数");
assert.equal(queueGate(forged).ok, false);
assert.equal(queueCardReport(forgedQueue, [], []).gate.ok, false, "收件箱报告照样不过");

// ── 3. 接线：所有入队口都拦，只认画布 store 里的亲手确认 ──
const root = new URL("..", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const exec = read("components/use-shot-queue-execution.ts");
const gateAt = exec.indexOf("const gate = await checkQueueGate(queue, chapterIndex)"), lockAt = exec.indexOf("boundedLock(`frameflow-shot-queue-submit");
assert.ok(gateAt > 0 && gateAt < lockAt, "submit 在建节点之前先过五项");
assert.match(exec, /if \(!gate\.ok\) \{ say\(gate\.message\); if \(matchingInboxRequest\(pageId, queue\)\) reportInboxRequest\(pageId, queue, "blocked", \{ error: gate\.message \}\); return; \}/);
assert.match(read("components/use-inbox-scheduler.ts"), /const gate=await checkQueueGate\(report\.queue\);.*?if\(!gate\.ok\)\{r\.result='rejected';r\.error=gate\.message;/);
assert.match(read("components/shot-card-board.tsx"), /: shotGateMessage\(card\.shot, completeness\.get\(card\.key\), gateConfirm\.lookup, card\.h3qItems, gateBasis \?\? undefined\)\);/, "「渲染这一镜」按钮按 h3q 判");
assert.ok(!/强行入队/.test(read("components/shot-queue-panel.tsx")), "没有一键强行入队按钮");
const gateCheck = read("components/gate-check.ts");
assert.match(gateCheck, /runH3qCheck\(JSON\.parse\(shotQueueJson\(queue\)\)\)/); assert.match(gateCheck, /attachEpisodeH3qItems\(report, queue\)/); // 本集设定：发写回版、设定里的五项 ERROR 抄到镜头 assert.match(gateCheck, /h3qChecksFive\(result\.version\)/); assert.match(gateCheck, /gateConfirmStore\.lookupFor\(/); assert.match(gateCheck, /queueGate\(queue, chapter, confirmed, basis\)/);
assert.match(read("components/shot-card-board.tsx"), /h3qChecksFive\(h3q\.version\)/, "卡片也按正本版本决定用不用 h3q");
for (const file of ["lib/shot-gate.ts", "lib/shot-gate-confirm.ts", "components/use-inbox-scheduler.ts", "components/gate-check.ts"]) assert.ok(!/skipGate|gateConfirmed|manualConfirm|\.gateOverride/.test(read(file)), `${file} 不读文件里的确认字段`);
assert.match(read("components/gate-confirm-store.ts"), /getMeta|putMeta/, "存在画布 IndexedDB meta（跟备份走）");
assert.equal((read("app/canvas-workspace.tsx").match(/snapshot\.parameters\.gateOverride = gateOverride/g) ?? []).length, 2, "两条提交路径都把人工确认写进 Run");
assert.match(read("components/shot-card-completeness.tsx"), /我确认没问题/);
assert.match(read("components/shot-card-board.tsx"), /gate-confirmed/, "放行的镜头整张卡灰色标记");
assert.match(SHOT_CARD_GUIDE, /画面五项·必写（会拦）/);
console.log(`shot gate: 五项漏写算写错、不能渲染、整集 / 本章 / 收件箱整批不提交${sampleChecked ? "，标准范本能入队" : ""}；亲手确认放行、改正文失效、文件字段无视；h3q 为准、兜底写明、占位不算漏写（${realH3q}）; ok`);

// 对比实验的 A / B 两镜在五项提示里要能分开（镜号带 A / B），不能都叫 L02。
{
  const pairQueue = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "对比", chapters: [{ title: "一", shots: [{ ...noDof, title: "EP-L02｜好·对比A" }, { ...noDof, title: "EP-L02｜好·对比B" }, { ...noDof, title: "EP-L05·对比2B" }] }] }));
  assert.match(queueGate(pairQueue).message, /L02·A.*L02·B.*L05·2B/, "对比 A / B 镜号分得开");
  assert.match(read("components/shot-card-board.tsx"), /code: pair \?/, "卡片镜号也带 A / B");
  console.log("shot gate: 对比 A / B 镜号分得开 ok");
}
