// 一键选预设：词库条目按正本清理、替换正文里对应的那句、整集都换只换一字不差的镜头；词库只读。
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { applyPresetText, applyShotSize, cleanPresetText, locatePreset, planEpisodePreset, presetItems, subjectWord } from "../lib/zhengben-presets.ts";
import { misplacedNames } from "../lib/shot-card-checks.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";

const L03 = [
  "参考说明（编号与提交顺序一致）：<Picture 1>是窗侧场景图，只用于布局与光线，不用于人物；<Picture 2>是张三，只用于张三的脸、发型和服装；<Picture 3>是李四，只用于李四的脸、发型和服装。",
  "写实真人电影质感，Kodak Vision3 250D 胶片颗粒，真实皮肤毛孔与细小绒毛。他在画左，四分之三侧脸；她在画右。机位在桌沿下，仰拍，中近景，35mm 等效，机位固定。",
  "夜里的办公室灯火通明：天花板的筒灯开着，暖黄色的光照在张三和李四的脸上。",
  "主要动作：他抬眼看她。",
  "0-3秒：他抬眼，中景，看向画右的她，下颌轻绷。",
  "声音：很轻的房间底噪。",
  "对白（中文普通话，口型同步）：张三（平淡）：“这张表算错了。”",
  "画面要求：竖屏9:16，画面稳定不闪烁。",
].join("\n");
const lineOf = (prompt, i) => prompt.split("\n")[i];

// ── 1. 词库条目 ──
const vocab = { film: [["Vision3 500T", "主体，使用 Kodak Vision3 500T 拍摄，35mm 电影胶片，电影颗粒"], ["坏", ""], "x"], light: [["背光", "背光 主体，头发变成发光的光环，画面定格，没有背景音乐"], ["单灯", "主体 上的台灯光，只有一盏灯，不暗"]] };
assert.deepEqual(presetItems(vocab, "film").map((item) => item.name), ["Vision3 500T"], "空条目和坏行跳过");
assert.deepEqual(presetItems(null, "film"), []);

// ── 2. 按正本清理 ──
assert.equal(subjectWord(L03), "两人");
assert.equal(subjectWord("0-3秒：她抬眼。"), "她");
assert.equal(subjectWord("0-3秒：他抬眼。"), "他");
assert.equal(subjectWord("参考说明：是李四"), "");
assert.equal(cleanPresetText(vocab.film[0][1], "0-3秒：她抬眼。"), "使用 Kodak Vision3 500T 拍摄，35mm 电影胶片，电影颗粒", "开头的「主体，」直接去掉");
assert.equal(cleanPresetText(vocab.light[0][1], "0-3秒：她抬眼。"), "背光她，头发变成发光的光环", "定格、点名配乐的小句去掉，主体换成她");
assert.equal(cleanPresetText(vocab.light[1][1], "0-3秒：他抬眼。"), "他身上的台灯光", "唯一光源、「不暗」去掉");
assert.equal(cleanPresetText("主体 的特写，开口说话，张三的脸占满画面", "0-3秒：他抬眼。", ["张三"]), "他的特写，他的脸占满画面", "人名换成他，「开口」去掉");
assert.equal(cleanPresetText("围绕 主体 旋转的镜头", "空镜，没有人"), "围绕旋转的镜头", "没人物时删掉「主体」");

// ── 3. 替换正文里对应的那句 ──
const film = applyPresetText(L03, "film", "使用 Kodak Vision3 500T 拍摄，电影颗粒");
assert.equal(film.before, "Kodak Vision3 250D 胶片颗粒");
assert.match(lineOf(film.prompt, 1), /^写实真人电影质感，使用 Kodak Vision3 500T 拍摄，电影颗粒，真实皮肤毛孔/);
assert.equal(film.prompt.split("\n").length, L03.split("\n").length);
for (let i = 0; i < 8; i++) if (i !== 1) assert.equal(lineOf(film.prompt, i), lineOf(L03, i), `只动风格那一行（第 ${i} 行没变）`);

const light = applyPresetText(L03, "light", "台灯在画右桌角，暖黄色的光照亮两人的脸");
assert.equal(light.before, lineOf(L03, 2), "光线句整行换");
assert.equal(lineOf(light.prompt, 2), "台灯在画右桌角，暖黄色的光照亮两人的脸。");
assert.deepEqual(misplacedNames(light.prompt, ["张三", "李四"]), [], "换进去的光线句不带人名");

const camera = applyPresetText(L03, "camera", "镜头缓慢推近");
assert.equal(camera.before, "机位在桌沿下，仰拍，机位固定");
assert.match(lineOf(camera.prompt, 1), /她在画右。镜头缓慢推近，中近景，35mm 等效。$/, "第一处换成新运镜，同一行里旧的机位句去掉");

const lens = applyPresetText(L03, "lens", "50mm f/1.4 镜头，浅景深");
assert.equal(lens.before, "35mm 等效");
assert.match(lineOf(lens.prompt, 1), /中近景，50mm f\/1\.4 镜头，浅景深，机位固定/);

const compose = applyPresetText(L03, "compose", "他在左三分之一");
assert.equal(compose.inserted, true, "没写构图：接在风格行末尾");
assert.match(lineOf(compose.prompt, 1), /机位固定，他在左三分之一。$/);
assert.equal(locatePreset(compose.prompt, "compose").text, "他在左三分之一");
const noLight = L03.split("\n").filter((_, i) => i !== 2).join("\n");
const addLight = applyPresetText(noLight, "light", "窗外天光");
assert.equal(addLight.inserted, true); assert.equal(lineOf(addLight.prompt, 2), "窗外天光。", "光线句单独一行，放在风格行后面");

// 景别快捷按钮：只换第一处景别词，时间段里的不动。
const size = applyShotSize(L03, "近景");
assert.equal(size.before, "中近景"); assert.equal(size.after, "近景");
assert.match(lineOf(size.prompt, 1), /仰拍，近景，35mm/); assert.equal(lineOf(size.prompt, 4), lineOf(L03, 4));
assert.match(lineOf(applyShotSize(L03.replace("中近景，", ""), "特写").prompt, 1), /机位固定，特写。$/);

// 不碰参考说明、对白、画面要求。
for (const kind of ["film", "light", "camera", "lens", "compose"]) {
  const changed = applyPresetText(L03, kind, "测试句");
  for (const i of [0, 3, 4, 5, 6, 7]) assert.equal(lineOf(changed.prompt, i), lineOf(L03, i), `${kind} 动了第 ${i} 行`);
}

// ── 4. 整集都换：一字不差的才换 ──
const shot = (title, prompt) => ({ title, prompt, roleIds: ["roleA", "roleB"], sceneAssetIds: ["office"], seconds: 10, aspect: "9:16", soundMode: "av" });
const queue = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "预设", chapters: [{ title: "一", shots: [shot("A", L03), shot("B", L03.replace("0-3秒：他抬眼", "0-3秒：他低头"))] }, { title: "二", shots: [shot("C", L03.replace("Kodak Vision3 250D 胶片颗粒", "Fuji Eterna 胶片颗粒"))] }] }));
const plan = planEpisodePreset(queue, 0, 0, { kind: "film", text: "Kodak Vision3 500T 胶片颗粒" });
assert.deepEqual(plan.changed, ["A", "B"]); assert.deepEqual(plan.skipped, ["C"]);
assert.match(plan.queue.chapters[0].shots[1].prompt, /Kodak Vision3 500T 胶片颗粒/);
assert.equal(plan.queue.chapters[1].shots[0].prompt, queue.chapters[1].shots[0].prompt, "写法不同的镜头不动");
assert.equal(queue.chapters[0].shots[0].prompt, L03, "原队列不被改");
const sizePlan = planEpisodePreset(queue, 0, 0, { kind: "size", size: "特写" });
assert.deepEqual(sizePlan.changed, ["A", "B", "C"]);

// ── 5. 用户词库：能读、只读 ──
const VOCAB = `${process.env.FRAMEFLOW_H3_TOOLS || "h3-tools"}/源文件/vocab.json`;
if (existsSync(VOCAB)) {
  const before = statSync(VOCAB).mtimeMs;
  const { readVocab } = await import("./zhengben-helper.mjs");
  const read = await readVocab();
  assert.ok(read.ok, read.error);
  for (const kind of ["film", "light", "camera", "lens", "compose"]) assert.ok(presetItems(read.vocab, kind).length >= 10, kind);
  // 每一条清理后都不点名配乐、不写「开口 / 不出声 / 嘴唇闭着」、不留「主体」。
  for (const kind of ["film", "light", "camera", "lens", "compose"]) for (const item of presetItems(read.vocab, kind)) {
    const text = cleanPresetText(item.text, L03, ["张三", "李四"]);
    assert.doesNotMatch(text, /背景音乐|配乐|soundtrack|BGM|开口|不出声|嘴唇闭着|主体|定格|唯一的?光源/i, `${kind}/${item.name}: ${text}`);
  }
  assert.equal(statSync(VOCAB).mtimeMs, before, "词库没有被写");
}
console.log("zhengben presets: 清理、替换、整集都换、词库只读; ok");
