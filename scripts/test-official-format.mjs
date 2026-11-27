// 官方 Ref2VA 六段式（正本 v2026-11-13，h3工具 6f71917）：画布原样提交、卡片认官方格式。
// 范本两份（h3工具\范本 的原样副本，放在 scripts/fixtures/official-format/）：0 拦截、0 误报，提交出去的正文和原文逐字一致。
// 旧格式的行为不变由 test:zhengben-queues / test:prompt-completeness / test:shot-gate 等原有测试管；这里只补几条旧格式对照。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isOfficialFormat, officialCuts, officialDialogue, officialDialogueLines, officialSections, officialSubjects, subjectsByPicture, OFFICIAL_FIELDS } from "../lib/official-format.ts";
import { compileH3Prompt, suppressBackgroundMusic } from "../lib/comfyui/h3-prompt.ts";
import { compileQueueShotPictures } from "../lib/queue-picture-order.ts";
import { shotCardChecks, queueCardReport } from "../lib/shot-card-report.ts";
import { shotCompleteness } from "../lib/prompt-completeness.ts";
import { queueGate, shotGate, shotGateMessage } from "../lib/shot-gate.ts";
import { rawShotHealth } from "../lib/shot-card-health.ts";
import { resolveH3Speaker } from "../lib/h3-speaker-policy.ts";
import { hardRuleOf } from "../lib/hard-rules.ts";
import { setRowLines } from "../lib/dialogue-row.ts";
import { dialogueFieldToRow } from "../lib/shot-card-fixes.ts";
import { aiFixText } from "../lib/shot-card-ai-copy.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";
import { parseH3qOutput } from "../lib/h3q-report.ts";
import { runH3Preflight } from "../lib/h3-preflight.ts";
import { promptTagErrors } from "../lib/shot-prompt-checks.ts";
import { runH3qCheck, H3_TOOLS } from "./zhengben-helper.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/official-format/${name}`, import.meta.url), "utf8"));
const NAMES = { "99e67465-7b1e-494b-befa-53a85534a365": "张三", "c68aa343-fccb-4877-a776-2fc30bef7df0": "李四", "f7e3b45b-8987-48ca-816a-273f99224ec4": "王五" };
function world(queue) {
  const shots = queue.chapters.flatMap((c) => c.shots);
  const roleIds = [...new Set(shots.flatMap((s) => s.roleIds))], sceneIds = [...new Set(shots.flatMap((s) => s.sceneAssetIds))];
  const roles = roleIds.map((roleId) => ({ roleId, displayName: NAMES[roleId] ?? roleId, description: "", appearanceAssetIds: [`${roleId}-look`], voiceAssetIds: [`${roleId}-voice`], primaryAppearanceAssetId: `${roleId}-look`, primaryVoiceAssetId: `${roleId}-voice` }));
  const assets = new Map([...sceneIds.map((id) => [id, { assetId: id, kind: "image", storageReference: `image:${id}`, filename: `${id}.png` }]), ...roleIds.flatMap((id) => [[`${id}-look`, { assetId: `${id}-look`, kind: "image", storageReference: `image:${id}-look`, filename: `${NAMES[id]}.png` }], [`${id}-voice`, { assetId: `${id}-voice`, kind: "audio", storageReference: `audio:${id}-voice`, filename: `${NAMES[id]}.wav` }]])]);
  return { roles, assets };
}
const submit = (shot, w, noBackgroundMusic, soundMode) => compileQueueShotPictures({ shot: { ...shot, ...(soundMode ? { soundMode } : {}) }, scenes: shot.sceneAssetIds.map((id) => ({ assetId: id, src: `image:${id}`, name: `${id}.png` })), roles: w.roles.filter((r) => shot.roleIds.includes(r.roleId)), assets: w.assets, roleAssets: Object.fromEntries([...w.assets.values()].map((a) => [a.assetId, a])), includeRoleVoices: true, noBackgroundMusic }).prepared.compiled;

const O1O2 = fixture("O1O2_queue.json"), L03 = fixture("L03_queue.json");

// ── 1. 认格式：和 h3q is_official 一样（行首栏目名两种以上） ──
for (const q of [O1O2, L03]) for (const shot of q.chapters.flatMap((c) => c.shots)) {
  assert.ok(isOfficialFormat(shot.prompt), shot.title);
  assert.deepEqual(Object.keys(officialSections(shot.prompt)), [...OFFICIAL_FIELDS], shot.title);
}
assert.equal(isOfficialFormat("参考说明：<Picture 1>是办公室。\n0-3秒：他翻页。"), false);
assert.equal(isOfficialFormat("summary: only one heading"), false, "一种栏目名不算");
assert.equal(isOfficialFormat("  summary: x\n  detailed_description: y"), false, "要在行首（和 h3q 一样）");
assert.equal(isOfficialFormat("summary: x\nnon_diegetic_music:\nN/A"), true);

// 载入队列不报「<Subject 4> 不存在」：官方格式的 Subject 由 subject_definitions 定义（场景也占一个），不按角色数算。
for (const q of [O1O2, L03]) assert.doesNotThrow(() => parseShotQueue(JSON.stringify(q)), q.title);
{ const shot = O1O2.chapters[0].shots[0];
  const pre = runH3Preflight({ mode: "ref2va", prompt: shot.prompt, rawPrompt: shot.prompt, counts: { pictures: 4, videos: 0, audios: 0, standaloneAudios: 0, subjects: 3 }, length: 209, megapixels: 0.45 });
  assert.deepEqual(pre.errors.filter((e) => e.code === "tag_missing"), [], "节点提交前检查也认 subject_definitions");
  assert.ok(runH3Preflight({ mode: "ref2va", prompt: "<Subject 4> says hi", counts: { pictures: 4, videos: 0, audios: 0, standaloneAudios: 0, subjects: 3 }, length: 209, megapixels: 0.45 }).errors.some((e) => e.code === "tag_missing"), "旧写法照旧按角色数");
  assert.ok(promptTagErrors(shot.prompt.replace("<Subject 3> lowers", "<Subject 5> lowers"), { pictures: 4, videos: 0, audios: 0, standaloneAudios: 0, subjects: 3 }).some((e) => e.includes("<Subject 5>")), "官方格式用了没定义的编号照样报"); }

// ── 2. Subject / 台词 / 切点 ──
const o1 = O1O2.chapters[0].shots[0].prompt, l3 = L03.chapters[0].shots[0].prompt;
assert.deepEqual(officialSubjects(o1).map((s) => [s.index, s.pictures, s.name]), [[1, [1], "daytime boardroom"], [2, [2], "Zhang San"], [3, [3], "Li Si"], [4, [4], "Wang Wu"]]);
assert.deepEqual(officialSubjects(l3).map((s) => [s.index, s.pictures]), [[1, [1, 2]], [2, [3]], [3, [4]]], "场景一个 Subject 两张图");
assert.deepEqual([...subjectsByPicture(l3)].map(([p, s]) => [p, s.map((x) => x.index)]), [[1, [1]], [2, [1]], [3, [2]], [4, [3]]]);
assert.deepEqual(officialDialogue(o1).map((l) => [l.order, l.shot, l.subject, l.speakerId, l.language, l.text]), [[1, 1, 4, "S1", "Chinese", "又绕回原样了？"], [2, 2, 2, "S2", "Chinese", "v3。"]]);
assert.deepEqual(officialDialogue(l3).map((l) => [l.subject, l.speakerId, l.text]), [[2, "S1", "这张表算错了。过来，我指给你看。"], [3, "S2", "等等啊。我这一页还没改完呢，你先坐。"]]);
assert.deepEqual(officialDialogueLines(o1, (n) => ({ 2: "张三", 4: "王五" })[n] ?? null), ["S1 <Subject 4> 王五：又绕回原样了？", "S2 <Subject 2> 张三：v3。"]);
assert.deepEqual(officialDialogueLines("detailed_description:\n[Shot 1] He says: <d>[Chinese] 好。</d>\nsummary: x"), ["（没标说话人）：好。"]);
assert.deepEqual(officialCuts(o1), [{ shot: 1, at: 0 }, { shot: 2, at: 4 }, { shot: 3, at: 7 }]);

// ── 3. 原样提交：禁背景乐、只要环境声、角色声音都不往正文加东西 ──
for (const q of [O1O2, L03]) {
  const w = world(q);
  for (const shot of q.chapters.flatMap((c) => c.shots)) {
    for (const nbm of [false, true]) for (const sound of [undefined, "ambient"]) {
      const compiled = submit(shot, w, nbm, sound);
      assert.equal(compiled.prompt, shot.prompt, `${shot.title} nbm=${nbm} sound=${sound}：提交正文和原文逐字一致`);
      if (nbm) assert.ok(compiled.notes.some((n) => n.includes("non_diegetic_music")), "记录里写明配乐由 non_diegetic_music 控制");
    }
    assert.equal(compileH3Prompt(shot.prompt, "av", true), shot.prompt);
    assert.equal(compileH3Prompt(shot.prompt, "ambient", false), shot.prompt, "只要环境声也不加「声音要求」行");
    assert.equal(suppressBackgroundMusic(shot.prompt), shot.prompt);
    // 角色声音：有 <d> 也不自动选说话角色，不报「缺少说话角色」；显式 voiceRoleIds 也不送。
    const auto = resolveH3Speaker({ prompt: shot.prompt, roleIds: shot.roleIds, dialogue: [], autoVoiceEnabled: true, soundMode: "av" });
    assert.deepEqual([auto.hasDialogue, auto.official, auto.voiceRoleId, auto.voiceRoleIds, auto.errors], [true, true, undefined, undefined, []]);
    const explicit = resolveH3Speaker({ prompt: shot.prompt, roleIds: shot.roleIds, voiceRoleIds: [shot.roleIds[0]], dialogue: [], autoVoiceEnabled: true, soundMode: "av" });
    // 2026-11-13 晚起：写了 voiceRoleIds 就送（test:official-voice）；这两份范本正文没写 <Audio N>，卡片会拦「官方·角色声音」。
    assert.deepEqual(explicit.voiceRoleIds, [shot.roleIds[0]]); assert.equal(explicit.voiceRoleId, undefined);
    assert.ok(shotGate({ ...shot, voiceRoleIds: [shot.roleIds[0]] }).some((item) => item.id === "official_voice"));
    assert.deepEqual(resolveH3Speaker({ prompt: shot.prompt, roleIds: shot.roleIds, dialogue: [], soundMode: "silent" }).errors.length, 1, "有台词还是要 av");
  }
}
// 旧格式对照：同一套函数照旧加句子（行为不变）。
const OLD = "参考说明：<Picture 1>是办公室。\n0-3秒：他翻页。\n声音：纸页轻响。";
assert.notEqual(compileH3Prompt(OLD, "av", true), OLD); assert.match(compileH3Prompt(OLD, "av", true), /这段听到的：|Audible audio is/);
assert.equal(resolveH3Speaker({ prompt: "<d>[Chinese] 好。</d>", roleIds: ["a"], dialogue: [], autoVoiceEnabled: true, soundMode: "av" }).voiceRoleId, "a", "旧写法 <d> 照旧自动选第一个角色");

// ── 4. 卡片：0 拦截、0 误报 ──
for (const q of [O1O2, L03]) {
  const w = world(q);
  for (const shot of q.chapters.flatMap((c) => c.shots)) {
    assert.deepEqual(shotCardChecks(shot, q, w.roles, w.assets), [], `${shot.title} 画布检查 0 条`);
    const complete = shotCompleteness(shot, { visibleNames: [] });
    assert.deepEqual(complete.filter((r) => r.state === "missing").map((r) => r.id), [], `${shot.title} 完整度 0 漏写`);
    assert.deepEqual(complete.filter((r) => r.state === "ok").map((r) => r.id).sort(), ["camera", "compose", "light", "shotsize", "style"], "只判画面五项，其余不适用");
    assert.ok(complete.filter((r) => r.state === "na").every((r) => /官方格式/.test(r.note ?? "")), "不适用写明原因");
    assert.deepEqual(shotGate(shot), [], `${shot.title} 画布兜底 0 拦`);
    assert.deepEqual(rawShotHealth(shot, q.defaults).map((h) => h.code).filter((c) => c !== "duration_align"), [], `${shot.title} 体检只剩帧数对齐`);
  }
  const report = queueCardReport(q, w.roles, [...w.assets.values()]);
  assert.equal(report.errorShots, 0); assert.equal(report.gate.ok, true);
}
// 兜底的五项用英文词：删掉机位角度就拦「运镜机位」，删掉胶片就拦「风格胶片」，原因写官方格式的改法。
// （词表照抄 h3q official_five，连它的宽松处也一样：例如「pan」也会匹配到 panel，所以这里用一段短正文。）
const SHORT = `subject_definitions:
<Subject 1> is Zhang San from <Picture 1>.

summary:
[reference generation] He reads.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved.

detailed_description:
Live-action, Kodak Vision3 250D film grain, soft window daylight from the left, 35mm-equivalent lens, shallow depth of field.
[Shot 1] A medium close-up frames <Subject 1> on the left of the frame, the bookshelf blurred in the background. He turns a page.

overall_soundscape:
Quiet room tone.

non_diegetic_music:
N/A`;
assert.deepEqual(shotGate({ ...L03.chapters[0].shots[0], prompt: SHORT.replace("A medium close-up", "A fixed camera at eye level, medium close-up") }), []);
const noCam = { ...L03.chapters[0].shots[0], prompt: SHORT };
assert.deepEqual(shotGate(noCam).map((i) => i.id), ["camera"]); assert.match(shotGate(noCam)[0].note, /官方格式没写运镜机位：写机位角度/);
const noFilm = { ...O1O2.chapters[0].shots[0], prompt: o1.replace("with Kodak Vision3 250D film grain, ", "") };
assert.deepEqual(shotGate(noFilm).map((i) => i.id), ["style"]);
// 官方格式没有时间段：开场空白兜底不判（正本 v2026-11-13 不管官方格式的开场空白）。
assert.ok(!shotGate({ ...O1O2.chapters[0].shots[0], prompt: `${o1}\n对白（中文普通话，口型同步）：王五：“又绕回原样了？”` }).some((i) => i.id === "opening_gap"));

// ── 5. h3q [官方·xx] ERROR 按单镜拦、WARN 不拦；拦截表有中文名和改法 ──
for (const prefix of ["[官方·六栏]", "[官方·Subject]", "[官方·台词]", "[官方·切镜]", "[官方·声音]", "[官方·中文]", "[官方·追加句]"]) {
  const rule = hardRuleOf(`${prefix} x`); assert.ok(rule && rule.label.startsWith("官方·") && rule.fixes && !rule.canvasFallback, prefix);
}
const shot0 = O1O2.chapters[0].shots[0];
const h3qItems = [{ level: "ERROR", where: "", message: "[官方·台词] <d>又绕回原样了</d> 前面没标说话人；写成 <Subject N>, <声音描述> (S1) asks: <d>…</d>" }, { level: "WARN", where: "", message: "[官方·闭嘴] 没写闭嘴" }];
assert.deepEqual(shotGate(shot0, [], h3qItems).map((i) => [i.id, i.label]), [["official_lines", "官方·台词"]]);
assert.match(shotGateMessage(shot0, [], undefined, h3qItems), /^官方·台词不过，不能渲染/);
assert.deepEqual(shotGate(shot0, [], [h3qItems[1]]), [], "WARN 不拦");
const q1 = parseShotQueue(JSON.stringify({ ...O1O2, chapters: [{ ...O1O2.chapters[0], shots: [shot0] }] }));
assert.equal(queueGate(q1, undefined, undefined, { source: "h3q", report: { counts: { ERROR: 1, WARN: 1, HINT: 0 }, shots: [h3qItems], general: [] } }).ok, false, "整批入队也拦");
assert.equal(queueGate(q1, undefined, undefined, { source: "h3q", report: { counts: { ERROR: 0, WARN: 1, HINT: 0 }, shots: [[]], general: [{ level: "WARN", where: "格式", message: "[旧格式] 1 镜是旧格式" }] } }).ok, true, "[旧格式] 整集 WARN 不拦");

// ── 6. 不往官方格式正文写中文对白行 ──
assert.ok("error" in setRowLines(o1, "王五", ["好。"]));
assert.ok("error" in dialogueFieldToRow({ ...shot0, dialogue: [{ roleId: shot0.roleIds[0], text: "好。" }] }, () => "张三"));

// ── 7. 复制给 AI：按官方格式写，指向新正本和范本，列出认出的台词 ──
const copy = aiFixText({ queueTitle: "q", chapters: [], zhengbenVersion: "v2026-11-13", scope: "全部", shots: [{ code: "O1", title: shot0.title, chapter: "", missing: [], h3q: h3qItems, canvas: [], gate: [], official: true, lines: ["S1 <Subject 4> 王五：又绕回原样了？"] }, { code: "L1", title: "旧", chapter: "", missing: ["main"], h3q: [], canvas: [], gate: [], official: false }] }).text;
for (const want of ["get 提示词 官方格式", "官方格式_示例_O1O2", "示例项目_EP02v5_L03_官方格式", "non_diegetic_music 写 N/A", "（官方格式）", "S1 <Subject 4> 王五：又绕回原样了？", "旧格式：第一集中文写法", "[官方·…]"]) assert.ok(copy.includes(want), want);

// ── 8. 真跑本机正本 h3q（有的话）：两份范本 0 ERROR，按卡片判也 0 拦 ──
let live = "h3q 没跑（本机没有 h3工具）";
if (existsSync(`${H3_TOOLS}/h3q.py`)) {
  const results = [];
  for (const q of [O1O2, L03]) {
    const run = await runH3qCheck({ queue: q });
    if (!run.ok) { results.push(`没跑成：${run.error}`); continue; }
    const report = parseH3qOutput(run.output, q.chapters.flatMap((c) => c.shots.map((s) => s.title)));
    assert.equal(report.counts.ERROR, 0, run.output);
    assert.equal(queueGate(parseShotQueue(JSON.stringify(q)), undefined, undefined, { source: "h3q", report }).ok, true);
    results.push(`${q.title} ERROR 0`);
  }
  live = `真跑 h3q（正本 ${(await runH3qCheck({ queue: O1O2 })).version ?? "?"}）：${results.join("；")}`;
}
console.log(`official format: 认格式和 h3q 一致、Subject / 台词 / 切点、原样提交（禁背景乐 / 环境声 / 角色声音都不加）、卡片 0 拦 0 误报、五项英文兜底、[官方·xx] 拦、复制给 AI 指向新正本（${live}）; ok`);

// ── 9. 三栏式（正本 v2026-11-13.1：T2VA / I2VA / FL2VA / L2VA）：一样认、一样原样提交、五项在 integrated_multimodal_description 里找 ──
{
  const T2VA = `integrated_multimodal_description:\nLive-action, Kodak Vision3 250D film grain, warm lamp light from the right. [Shot 1] A fixed camera at eye level frames a woman on the left of the frame in a medium close-up, 35mm-equivalent lens, the window blurred in the background. She lifts a cup and says: <d>[Chinese] 好。</d> She closes her mouth.\n\noverall_soundscape:\nQuiet room tone, a cup set on a table.\n\nnon_diegetic_music:\nN/A`;
  const I2VA = `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n${T2VA}`;
  for (const p of [T2VA, I2VA]) {
    assert.equal(isOfficialFormat(p), true);
    assert.deepEqual(Object.keys(officialSections(p)), ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"]);
    assert.equal(compileH3Prompt(p, "ambient", true), p, "三栏式也原样提交");
    const t2 = { title: "T", prompt: p, roleIds: [], sceneAssetIds: [], seconds: 5, aspect: "9:16", soundMode: "av" };
    assert.deepEqual(shotGate(t2), [], "五项在 integrated_multimodal_description 里找到");
    assert.deepEqual(officialDialogue(p).map((l) => l.text), ["好。"]);
  }
  assert.deepEqual(shotGate({ title: "T", prompt: T2VA.replace("Kodak Vision3 250D film grain, ", ""), roleIds: [], sceneAssetIds: [], seconds: 5, aspect: "9:16", soundMode: "av" }).map((i) => i.id), ["style"]);
  for (const prefix of ["[官方·三栏]", "[官方·对齐句]", "[官方·类型]", "[官方·本集设定]", "[旧格式]"]) assert.ok(hardRuleOf(`${prefix} x`), prefix);
  assert.deepEqual(shotGate({ title: "旧", prompt: "0-3秒：他翻页。", roleIds: [], sceneAssetIds: [], seconds: 5, aspect: "9:16", soundMode: "av" }, [], [{ level: "ERROR", where: "", message: "[旧格式] 旧格式已停用，请按官方格式重写" }]).map((i) => [i.id, i.label]), [["legacy_format", "旧格式"]], "正本 v2026-11-13.1 每镜 [旧格式] ERROR：照拦，归「旧格式」一组");
}
console.log("official format 三栏式: ok");

// ── 10. 非参考图出片（首帧 / 首尾帧 / 纯文生）的三栏式：载入不报错、提交原样、帧占 <Picture 1>（官方对齐句就这么写） ──
{
  const T = "integrated_multimodal_description:\nLive-action, Kodak film grain, warm lamp light. [Shot 1] A fixed camera at eye level frames her on the left of the frame in a medium close-up, 35mm lens, background blurred. She says: <d>[Chinese] 好。</d>\n\noverall_soundscape:\nRoom tone.\n\nnon_diegetic_music:\nN/A";
  const I2 = `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\n${T}`;
  const FL = `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 5.00-second mark of the target video.\n\n${T}`;
  const frames = new Map([["f1", { assetId: "f1", kind: "image", storageReference: "image:f1", filename: "f1.png" }], ["f2", { assetId: "f2", kind: "image", storageReference: "image:f2", filename: "f2.png" }]]);
  for (const [name, prompt, extra, pics] of [["I2VA", I2, { firstFrameAssetId: "f1", generationMode: "first-last" }, ["首帧 f1.png"]], ["FL2VA", FL, { firstFrameAssetId: "f1", lastFrameAssetId: "f2", generationMode: "first-last" }, ["首帧 f1.png", "尾帧 f2.png"]], ["T2VA", T, {}, []]]) {
    const shot = { title: name, prompt, roleIds: [], sceneAssetIds: [], seconds: 5, aspect: "9:16", soundMode: "av", ...extra };
    for (const nbm of [false, true]) {
      const out = compileQueueShotPictures({ shot, scenes: [], roles: [], assets: frames, roleAssets: Object.fromEntries(frames), includeRoleVoices: true, noBackgroundMusic: nbm });
      assert.equal(out.prepared.compiled.prompt, prompt, `${name} nbm=${nbm} 原样提交`);
      assert.deepEqual(out.pictures.map((p) => p.name), pics, `${name} 帧占 Picture 1 起`);
    }
    assert.deepEqual(shotCardChecks(shot, { defaults: {} }, [], frames).filter((c) => c.level === "error"), [], `${name} 卡片不报红`);
  }
}
console.log("official format 非参考图出片: ok");
