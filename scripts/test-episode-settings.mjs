// 本集设定：拼回后逐字相同、旧队列不变、转换只收一字不差的、写回不丢改动、规则报错、完整度在展开后的正文上认得出风格 / 光线。
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseShotQueue, shotQueueH3Props, shotQueueWarnings } from "../lib/shot-queue.ts";
import { attachEpisodeH3qItems, expandEpisode, collapseEpisode, shotQueueJson, expandedQueueJson, collectEpisode, withEpisode, renameEpisodeScene, episodeUsage, episodeSegments, episodeNearMisses, sceneNameOf, parseEpisodeSettings } from "../lib/episode-settings.ts";
import { shotCompleteness } from "../lib/prompt-completeness.ts";
import { planEpisodePreset, planShotPreset } from "../lib/zhengben-presets.ts";
import { queueGate, shotGate } from "../lib/shot-gate.ts";
import { parseH3qOutput } from "../lib/h3q-report.ts";

const fixtures = new URL("./fixtures/episode-settings/", import.meta.url);
const read = (name) => readFileSync(new URL(name, fixtures), "utf8");
const parse = (value) => parseShotQueue(typeof value === "string" ? value : JSON.stringify(value), false);
const prompts = (queue) => queue.chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.prompt));
const plan = { appearances: [], scenes: [], pictures: [] };

// ── 1. 标准范本：占位版和逐字版解析后一字不差，提交给模型的 prompt 也一样 ──
const original = parse(read("L03_标准_原文.json"));
const templated = parse(read("L03_标准_本集设定.json"));
assert.deepEqual(prompts(templated), prompts(original), "L03：换回后的正文和逐字复制版一字不差");
const rawOriginal = JSON.parse(read("L03_标准_原文.json")).chapters[0].shots[0].prompt;
assert.equal(templated.chapters[0].shots[0].prompt, rawOriginal.trim());
assert.equal(shotQueueH3Props(templated.chapters[0].shots[0], plan, templated.defaults).prompt, shotQueueH3Props(original.chapters[0].shots[0], plan, original.defaults).prompt, "提交给模型的 prompt 一样");
assert.ok(templated.chapters[0].shots[0].promptTemplate.includes("{{本集.光线.张三办公室}}"));
assert.equal(templated.episode.lighting["张三办公室"].startsWith("夜里的办公室灯火通明"), true);

// ── 2. 旧队列：没有 episode、没有占位 → 解析结果不多一个字段，写回和 JSON.stringify 一模一样 ──
assert.equal(original.episode, undefined);
assert.equal(original.chapters[0].shots[0].promptTemplate, undefined);
assert.equal(shotQueueJson(original), `${JSON.stringify(original, null, 2)}\n`, "旧队列写回不变");
assert.deepEqual(parse(shotQueueJson(original)), original);
// 正文里本来就有别的大括号的旧队列不受影响
const braces = { version: "shot-queue-v1", title: "旧", chapters: [{ title: "一", shots: [{ title: "A", prompt: "画面里的白板写着 {{x}} 和 {a}。", roleIds: [], sceneAssetIds: [], seconds: 6, soundMode: "ambient" }] }] };
assert.equal(parse(braces).chapters[0].shots[0].prompt, "画面里的白板写着 {{x}} 和 {a}。");
// 本机收件箱和范本里的真实旧队列（有就查；FRAMEFLOW_INBOX_ROOT、FRAMEFLOW_H3_TOOLS/范本）：解析结果没有新字段、写回不变、提交 prompt = 原文
const H3_TOOLS = process.env.FRAMEFLOW_H3_TOOLS || "h3-tools";
const roots = [process.env.FRAMEFLOW_INBOX_ROOT, join(H3_TOOLS, "范本")].filter((dir) => dir && existsSync(dir));
let realOld = 0;
for (const root of roots) for (const dir of readdirSync(root)) {
  const full = join(root, dir);
  if (!statSync(full).isDirectory()) continue;
  for (const file of readdirSync(full).filter((name) => name.endsWith("_queue.json"))) {
    let queue; try { queue = parse(readFileSync(join(full, file), "utf8")); } catch { continue; }
    assert.equal(queue.episode, undefined, file);
    assert.ok(queue.chapters.every((chapter) => chapter.shots.every((shot) => shot.promptTemplate === undefined)), file);
    assert.equal(shotQueueJson(queue), `${JSON.stringify(queue, null, 2)}\n`, file);
    realOld++;
  }
}

// ── 3. 转换：只收一字不差的，差一点的保留原文并列出；换回后逐镜一字不差 ──
const sameStyle = "写实真人电影质感，Kodak Vision3 250D 胶片颗粒，生活感真实。";
const light = "夜里的办公室：台灯在画右桌角，暖黄色的光照在两人脸上。窗外是城市夜景。";
const lightNear = "夜里的办公室：台灯在画右桌角，暖黄色的光照在他脸上。窗外是城市夜景。";
const require = "竖屏9:16，一条镜头拍完，中间不切换；手指数量正常。";
const shot = (title, lightLine, extra = {}) => ({ title, prompt: `参考说明（编号与提交顺序一致）：<Picture 1>是场景图，只用于布局，不用于人物。\n${sameStyle}\n他在画左。中景，机位固定。\n${lightLine}\n主要动作：他抬眼。\n0-3秒：他抬眼。\n声音：只有很轻的房间底噪。纸页轻响。\n画面要求：${require}`, roleIds: [], sceneAssetIds: ["scene-1"], seconds: 6, soundMode: "ambient", ...extra });
const corridorLight = "走廊里 2800K 台灯从画右照进来，整体曝光略高。";
const oldQueue = parse({ version: "shot-queue-v1", title: "测", chapters: [
  { title: "2-4｜办公室", shots: [shot("L01", light), shot("L02", `光线：${light}`), shot("L03", lightNear)] },
  { title: "2-5｜走廊", shots: [shot("C01", corridorLight), shot("C02", corridorLight), shot("C03", light)] },
] });
const collected = collectEpisode(oldQueue);
assert.ok(collected.ok, collected.error);
assert.equal(collected.episode.style, sameStyle);
assert.equal(collected.episode.frameRequirements, require);
assert.deepEqual(collected.episode.lighting, { 办公室: light, 走廊: corridorLight });
assert.equal(collected.used["{{本集.风格}}"], 6);
assert.equal(collected.used["{{本集.光线.办公室}}"], 3, "L01、L02（光线：标签后）、C03（走廊章但一字不差 → 办公室）");
assert.equal(collected.used["{{本集.光线.走廊}}"], 2);
assert.deepEqual(collected.kept.map((miss) => [miss.title, miss.key]), [["L03", "光线.办公室"]], "差一点的 L03 保留原文并列出");
const l03 = collected.queue.chapters[0].shots[2];
assert.ok(l03.promptTemplate.includes(lightNear), "L03 的光线句没被换掉");
assert.ok(!l03.promptTemplate.includes("{{本集.光线"));
assert.ok(collected.queue.chapters[0].shots[1].promptTemplate.includes("光线：{{本集.光线.办公室}}"));
const reparsed = parse(shotQueueJson(collected.queue));
assert.deepEqual(prompts(reparsed), prompts(oldQueue), "转换后写成 JSON 再读回：每镜一字不差");
assert.deepEqual(reparsed.episode, collected.episode);
assert.match(shotQueueJson(collected.queue), /"episode"/);
assert.doesNotMatch(shotQueueJson(collected.queue), /promptTemplate/, "写回 JSON 不带内部字段");
// 展开版（旧格式）
const expanded = JSON.parse(expandedQueueJson(reparsed));
assert.equal(expanded.episode, undefined);
assert.deepEqual(prompts(parse(expanded)), prompts(oldQueue));
// 只有 1 镜不够 2 镜重复的队列（多于 1 镜）不收；单镜队列可以收
const single = collectEpisode(parse({ version: "shot-queue-v1", title: "单", chapters: [{ title: "2-4 张三办公室（标准）", shots: [shot("S", light)] }] }));
assert.ok(single.ok);
assert.deepEqual(Object.keys(single.episode.lighting), ["张三办公室"]);
assert.equal(sceneNameOf("2-4｜办公室"), "办公室");
assert.equal(sceneNameOf("2-4 张三办公室（标准队列实测）"), "张三办公室");
// 目光不是光线句
const gaze = collectEpisode(parse({ version: "shot-queue-v1", title: "目光", chapters: [{ title: "一", shots: [shot("A", "目光还在画左那张纸上。"), shot("B", "目光还在画左那张纸上。")] }] }));
assert.equal(gaze.episode.lighting, undefined);

// ── 5. 规则报错（草案第 1.3 节） ──
const base = (prompt, episode, extra = {}) => ({ version: "shot-queue-v1", title: "规则", ...(episode ? { episode } : {}), chapters: [{ title: "一", shots: [{ title: "A", prompt, roleIds: [], sceneAssetIds: [], seconds: 6, soundMode: "ambient", ...extra }] }] });
const fails = (value, pattern) => assert.throws(() => parse(value), pattern);
fails(base("{{本集.风格}}"), /没有 episode/);
fails(base("{{本集.光线.会议室}}", { lighting: { 办公室: "灯光。" } }), /本集设定里没有.*现有：光线\.办公室/);
fails(base("{{本集.天气}}", { style: "风格。" }), /只认/);
fails(base("{本集.风格}", { style: "风格。" }), /写坏了/);
fails(base("｛｛本集.风格｝｝", { style: "风格。" }), /写坏了/);
fails(base("{{本集.风格}}", { style: "风格。", lightning: {} }), /多出：lightning/);
fails(base("{{本集.风格}}", { style: " 风格。" }), /空格/);
fails(base("{{本集.风格}}", { style: "" }), /需要一段文字/);
fails(base("{{本集.风格}}", { style: "{{本集.画面要求}}", frameRequirements: "要求。" }), /不能再写占位/);
fails(base("{{本集.风格}}", { style: "<Picture 1>是风格。" }), /Picture/);
fails(base("{{本集.光线.办 公}}", { lighting: { "办 公": "灯。" } }), /场景名/);
fails(base("{{本集.风格}}", { style: "风格。" }, { title: "{{本集.风格}}" }), /只能写在 prompt/);
fails(base("{{本集.风格}}", { style: "风格。" }, { keyframe: { prompt: "{{本集.风格}}" } }), /只能写在 prompt/);
fails(base("{{本集.风格}}", { style: "长".repeat(4001) }), /太长/);
// 未使用的设定、差一点的照抄句：只提示
const hint = parse(base(`${sameStyle}\n画面要求：${require}`, { style: sameStyle.replace("生活感", "真实感"), frameRequirements: require, ambience: { 办公室: "底噪。" } }));
const warnings = shotQueueWarnings(hint);
assert.ok(warnings.some((w) => w.includes("「底声.办公室」整集没有一镜用到")));
assert.ok(warnings.some((w) => w.includes("和本集设定「风格」差一点")));
assert.ok(warnings.some((w) => w.includes("「画面要求」整集没有一镜用到")), "逐字照抄但没用占位的也算没用到");
assert.deepEqual(parseEpisodeSettings(undefined), { errors: [] });

// ── 6. 纯文字替换：句中、标签后、一行多个、混用 ──
const ep = { style: "风格句。", lighting: { 甲: "甲光。", 乙: "乙光。" }, ambience: { 甲: "底噪。" }, frameRequirements: "要求。" };
assert.equal(expandEpisode("A{{本集.风格}}B{{本集.光线.甲}}{{本集.光线.乙}}\n声音：{{本集.底声.甲}}脚步声。\n画面要求：{{本集.画面要求}}", ep).text, "A风格句。B甲光。乙光。\n声音：底噪。脚步声。\n画面要求：要求。");
assert.deepEqual(episodeSegments("A{{本集.风格}}B", ep, "A风格句。B"), [{ text: "A" }, { text: "风格句。", key: "风格" }, { text: "B" }]);
assert.deepEqual(episodeSegments(undefined, ep, "原文"), [{ text: "原文" }]);

// ── 7. 写回不丢改动：改设定外的字 → 占位保留；改设定里的字 → 这镜这一句变原文，别的占位不动 ──
const t = "{{本集.风格}}\n他抬眼。\n{{本集.光线.甲}}";
assert.equal(collapseEpisode("风格句。\n他低头。\n甲光。", t, ep), "{{本集.风格}}\n他低头。\n{{本集.光线.甲}}");
assert.equal(collapseEpisode("风格句。\n他抬眼。\n甲光变暗。", t, ep), "{{本集.风格}}\n他抬眼。\n甲光变暗。", "设定那句被改了字：这一句变原文，别的占位不动");
assert.equal(collapseEpisode("风格换了。\n他抬眼。\n甲光。", t, ep), "风格换了。\n他抬眼。\n{{本集.光线.甲}}");
const q = parse(base(t, ep));
const edited = { ...q, chapters: [{ ...q.chapters[0], shots: [{ ...q.chapters[0].shots[0], prompt: "风格句。\n他低头。\n甲光。" }] }] };
const back = parse(shotQueueJson(edited));
assert.equal(back.chapters[0].shots[0].prompt, "风格句。\n他低头。\n甲光。");
assert.equal(back.chapters[0].shots[0].promptTemplate, "{{本集.风格}}\n他低头。\n{{本集.光线.甲}}");
// 解析结果被直接 JSON.stringify 过（会话记录）：读回还认得模板
assert.equal(parse(JSON.stringify(q)).chapters[0].shots[0].promptTemplate, t);

// ── 8. 改本集设定 / 场景改名：所有用它的镜头一起变 ──
const two = parse({ version: "shot-queue-v1", title: "两镜", episode: ep, chapters: [{ title: "一", shots: [
  { title: "A", prompt: "{{本集.光线.甲}}他抬眼。", roleIds: [], sceneAssetIds: [], seconds: 6, soundMode: "ambient" },
  { title: "B", prompt: "{{本集.光线.甲}}她低头。", roleIds: [], sceneAssetIds: [], seconds: 6, soundMode: "ambient" },
  { title: "C", prompt: "甲光。她转身。", roleIds: [], sceneAssetIds: [], seconds: 6, soundMode: "ambient" }] }] });
assert.deepEqual(episodeUsage(two).get("光线.甲"), ["A", "B"]);
const relit = parse(shotQueueJson(withEpisode(two, { ...ep, lighting: { ...ep.lighting, 甲: "甲光变冷。" } })));
assert.deepEqual(prompts(relit), ["甲光变冷。他抬眼。", "甲光变冷。她低头。", "甲光。她转身。"], "逐字照抄的 C 不跟着变");
const renamed = renameEpisodeScene(two, "lighting", "甲", "办公室");
assert.equal(typeof renamed, "object");
const renamedBack = parse(shotQueueJson(renamed));
assert.deepEqual(prompts(renamedBack), prompts(two));
assert.equal(renamedBack.chapters[0].shots[0].promptTemplate, "{{本集.光线.办公室}}他抬眼。");
assert.match(renameEpisodeScene(two, "lighting", "甲", "乙"), /已经有/);
assert.match(renameEpisodeScene(two, "lighting", "甲", "a.b"), /场景名/);

// ── 9. 一键预设：整集都换 → 这句来自本集设定就直接改设定；只换本镜 → 这镜这一句脱离设定 ──
const presetQueue = parse(read("L03_标准_本集设定.json"));
const film = { kind: "film", text: "写实真人电影质感，Kodak Portra 400 胶片颗粒" };
const episodePlan = planEpisodePreset(presetQueue, 0, 0, film);
assert.equal(episodePlan.episodeKey, "风格");
assert.match(episodePlan.queue.episode.style, /Portra 400/);
const afterEpisode = parse(shotQueueJson(episodePlan.queue));
assert.ok(afterEpisode.chapters[0].shots[0].promptTemplate.includes("{{本集.风格}}"), "整集都换：占位还在，改的是设定");
assert.match(afterEpisode.chapters[0].shots[0].prompt, /Portra 400/);
const shotPlan = planShotPreset(presetQueue.chapters[0].shots[0].prompt, film);
const afterShot = parse(shotQueueJson({ ...presetQueue, chapters: [{ ...presetQueue.chapters[0], shots: [{ ...presetQueue.chapters[0].shots[0], prompt: shotPlan.prompt }] }] }));
assert.match(afterShot.chapters[0].shots[0].prompt, /Portra 400/);
assert.equal(afterShot.episode.style.includes("Vision3"), true, "只换本镜：本集设定不动");
assert.ok(!afterShot.chapters[0].shots[0].promptTemplate.includes("{{本集.风格}}"), "只换本镜：这镜的风格句变成原文");
assert.ok(afterShot.chapters[0].shots[0].promptTemplate.includes("{{本集.光线.张三办公室}}"), "别的占位不动");
assert.equal(episodeNearMisses(afterShot.chapters[0].shots[0], afterShot.episode).length, 1, "卡片会提示这句和设定差一点");

// ── 10. 完整度 / 画面五项：在展开后的正文上跑，风格胶片、光线、画面要求认得出，和逐字版结果完全一样 ──
const ctx = { visibleNames: ["张三", "李四"], roleNames: ["张三", "李四"], previous: null, episodeRequire: null };
const fromTemplate = shotCompleteness(templated.chapters[0].shots[0], ctx);
const fromLiteral = shotCompleteness(original.chapters[0].shots[0], ctx);
assert.deepEqual(fromTemplate, fromLiteral, "完整度结果一模一样");
for (const id of ["style", "light", "require", "sound"]) assert.equal(fromTemplate.find((result) => result.id === id)?.state, "ok", `${id} 认得出`);
// 画面五项硬拦截：占位版和逐字版判定一模一样，不会把占位当成漏写
assert.deepEqual(queueGate(templated), queueGate(original), "画面五项：占位版 = 逐字版");
assert.deepEqual(shotGate(templated.chapters[0].shots[0]).filter((item) => item.id === "style" || item.id === "light"), [], "风格胶片、光线来自本集设定，不算漏写");
// 真把设定里的光线句删掉（换成跟光无关的话），五项照样拦
const noLight = parse(shotQueueJson(withEpisode(templated, { ...templated.episode, lighting: { 张三办公室: "窗外是城市夜景。" } })));
assert.ok(shotGate(noLight.chapters[0].shots[0]).some((item) => item.id === "light"), "设定里的光线句没了 → 光线漏写，照拦");

// ── 11. 和正本 h3q expand 一字不差（v2026-11-11.5，h3工具 0a89c12） ──
// 固定对照：*_h3q展开.json 是 `python -I h3q.py expand <队列> -o <输出>` 的原样输出，提交在仓库里，没有 h3q 的机器也能查。
const h3qPy = join(H3_TOOLS, "h3q.py");
const hasH3q = existsSync(h3qPy) && spawnSync("python", ["-I", "--version"]).status === 0;
const scratch = mkdtempSync(join(tmpdir(), "episode-h3q-"));
const h3qExpand = (inputFile) => {
  const outFile = join(scratch, `out-${Math.random().toString(36).slice(2)}.json`);
  const run = spawnSync("python", ["-I", h3qPy, "expand", inputFile, "-o", outFile], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  return { status: run.status, stdout: run.stdout, text: run.status === 0 ? readFileSync(outFile, "utf8") : null };
};
const rawPrompts = (json) => JSON.parse(json).chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.prompt));
let h3qCompared = 0;
for (const name of ["L03_标准", "多场景"]) {
  const golden = read(`${name}_h3q展开.json`);
  const canvas = parse(read(`${name}_本集设定.json`));
  // 画布换回后的正文 = h3q 展开后的正文，逐字（h3q 不去首尾空白；这两份对照里正文首尾本来就没有空白）
  assert.deepEqual(prompts(canvas), rawPrompts(golden), `${name}：画布展开 = h3q expand，一字不差`);
  rawPrompts(golden).forEach((text) => assert.equal(text, text.trim(), `${name}：对照正文首尾没有空白`));
  // 提交给模型的 prompt 也一样：画布读 h3q 的展开版（旧格式）编出来的，和读占位版编出来的一样
  const fromGolden = parse(golden);
  canvas.chapters.flatMap((chapter) => chapter.shots).forEach((shot, i) => assert.equal(shotQueueH3Props(shot, plan, canvas.defaults).prompt, shotQueueH3Props(fromGolden.chapters.flatMap((chapter) => chapter.shots)[i], plan, fromGolden.defaults).prompt, `${name} 第 ${i + 1} 镜：提交的 prompt 一样`));
  // 画布导出的展开版和 h3q 展开版正文一样
  assert.deepEqual(rawPrompts(expandedQueueJson(canvas)), rawPrompts(golden));
  // 画布写回的占位版再给 h3q 展开，结果还是一样
  if (hasH3q) {
    const fresh = h3qExpand(fileURLToPath(new URL(`${name}_本集设定.json`, fixtures)));
    assert.equal(fresh.status, 0, fresh.stdout);
    assert.equal(fresh.text, golden, `${name}：本机 h3q expand 的输出和仓库里的对照文件逐字相同（h3q 改了展开规则就会在这里报）`);
    const roundFile = join(scratch, `${name}-canvas.json`);
    writeFileSync(roundFile, shotQueueJson(canvas));
    assert.deepEqual(rawPrompts(h3qExpand(roundFile).text), prompts(canvas), `${name}：画布写回的占位版，h3q 展开后一字不差`);
    h3qCompared++;
  }
}
// 多场景对照里的几种写法都要真的换回来
const multi = parse(read("多场景_本集设定.json")).chapters.flatMap((chapter) => chapter.shots);
assert.match(multi[1].prompt, /生活感真实。近景，85mm/, "风格占位后同一行接着写");
assert.match(multi[1].prompt, /\n光线：夜里的办公室灯火通明：.*整体曝光略高。窗外是城市夜景。\n/, "光线标签后、句子后接着写");
assert.match(multi[3].prompt, /面部再亮一档。夜里的办公室灯火通明/, "一行两个占位");
assert.equal(multi[2].promptTemplate.includes("{{本集.风格}}"), false, "T03 逐字照抄的风格句不当占位");
assert.equal(episodeNearMisses(multi[2], parse(read("多场景_本集设定.json")).episode).map((miss) => miss.key).sort().join(","), "光线.办公室,底声.办公室", "T03 差一点的光线、底声会提示");
// EP02_v5（46 镜，有就查）：画布收进本集设定 → h3q 展开 → 和原收件箱正文、画布展开都一字不差
if (hasH3q && existsSync(v5file)) {
  const v5 = parse(readFileSync(v5file, "utf8"));
  const converted = collectEpisode(v5).queue;
  const file = join(scratch, "v5-canvas.json");
  writeFileSync(file, shotQueueJson(converted));
  const expandedV5 = h3qExpand(file);
  assert.equal(expandedV5.status, 0, expandedV5.stdout);
  assert.deepEqual(rawPrompts(expandedV5.text).map((text) => text.trim()), prompts(v5), "EP02_v5：h3q 展开画布转换版 = 原收件箱正文");
  assert.deepEqual(prompts(parse(readFileSync(file, "utf8"))), rawPrompts(expandedV5.text).map((text) => text.trim()), "EP02_v5：画布展开 = h3q 展开");
  h3qCompared++;
}
// 规则：h3q expand 不肯展开（有 ERROR）的，画布也不收；h3q 能展开的，画布也能读
if (hasH3q) {
  const okShot = (prompt, extra = {}) => ({ title: "A", prompt, roleIds: [], sceneAssetIds: [], seconds: 6, soundMode: "ambient", ...extra });
  const cases = [
    [base("{{本集.风格}}他抬眼。", { style: "风格。" }), true],
    [base("{{本集.风格}}", { style: "风格。", lightning: {} }), false],
    [base("{{本集.光线.会议室}}", { lighting: { 办公室: "灯。" } }), false],
    [base("｛｛本集.风格｝｝", { style: "风格。" }), false],
    [base("{{本集.风格}}白板上写着 {{x}}。", { style: "风格。" }), false],
    [base("本集.风格", { style: "风格。" }), false],
    [base("{{本集.风格}}", { style: "风格本集.x。" }), false],
    [base("{{本集.风格}}", { style: "风格。" }, { title: "本集.A" }), false],
    [{ ...base("{{本集.风格}}", { style: "风格。" }), title: "{{x}}" }, false],
    [{ version: "shot-queue-v1", title: "旧", chapters: [{ title: "一", shots: [okShot("白板上写着 {{x}} 和 {a}。")] }] }, true],
  ];
  cases.forEach(([queue, ok], i) => {
    const file = join(scratch, `case-${i}.json`);
    writeFileSync(file, JSON.stringify(queue));
    const h3q = h3qExpand(file);
    assert.equal(h3q.status === 0, ok, `规则第 ${i + 1} 条：h3q ${ok ? "应该能" : "不该"}展开\n${h3q.stdout}`);
    let canvasOk = true; try { parse(queue); } catch { canvasOk = false; }
    assert.equal(canvasOk, ok, `规则第 ${i + 1} 条：画布和 h3q 结论一致（${ok ? "能读" : "拦下"}）`);
  });
}
// 画面五项以 h3q 为准时：设定值里的 [五项·光线] ERROR h3q 只报在「本集设定.光线.…」上，要抄到用到它的镜头，不然这几镜会被放过
if (hasH3q) {
  const badLight = JSON.parse(read("多场景_本集设定.json"));
  badLight.episode.lighting.走廊 = `${badLight.episode.lighting.走廊}画面不暗。`;
  const file = join(scratch, "bad-light.json");
  writeFileSync(file, JSON.stringify(badLight));
  const run = spawnSync("python", ["-I", h3qPy, "check", file, "--all", "--skip-table"], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  const queue = parse(badLight);
  const raw = parseH3qOutput(run.stdout, queue.chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.title)));
  assert.ok(raw.general.some((item) => item.where === "本集设定.光线.走廊" && /\[五项·光线\]/.test(item.message)), `h3q 把设定里的光线问题报在本集设定上\n${run.stdout}`);
  const lightBlocked = (report) => queueGate(queue, undefined, undefined, { source: "h3q", report }).failures.filter((failure) => failure.items.some((item) => item.id === "light")).map((failure) => failure.title);
  assert.deepEqual(lightBlocked(raw), [], "（不抄的话光线一镜都拦不住——这就是要修的洞）");
  const attached = attachEpisodeH3qItems(raw, queue);
  assert.deepEqual(lightBlocked(attached), ["C01｜走廊用办公室底声"], "只有用了 {{本集.光线.走廊}} 的 C01 因光线被拦");
  assert.equal(attachEpisodeH3qItems(raw, original), raw, "没用本集设定的队列原样返回");
}
rmSync(scratch, { recursive: true, force: true });

console.log(`episode settings: ok（本机真实旧队列 ${realOld} 份；${hasH3q ? `和本机 h3q expand 逐字对比 ${h3qCompared} 份 + 规则 10 条` : "本机没有 h3q，只对比了仓库里的固定对照"}）`);
