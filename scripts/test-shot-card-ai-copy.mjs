// 镜头卡片「复制给 AI 修改」的文字：镜头顺序、title 原样、五项标必改、放行的标可不改、没问题时一句话。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { aiFixText, ZHENGBEN_PATH } from "../lib/shot-card-ai-copy.ts";
import { CATEGORY_BY_ID } from "../lib/zhengben-categories.ts";
import { queueCompleteness } from "../lib/prompt-completeness.ts";
import { shotGate } from "../lib/shot-gate.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";

const full = [
  "写实真人电影质感，Kodak Vision3 250D 胶片颗粒。中近景，35mm 等效，浅景深，后景虚化，机位固定。他在画左，脸在画面上三分之一，前景是桌沿。",
  "夜里的办公室：台灯在画右，暖黄色的光照在他脸上。",
  "主要动作：他抬眼。",
  "0-3秒：他抬眼，下颌轻绷。",
  "画面要求：竖屏9:16。",
].join("\n");
const shot = (title, prompt = full) => ({ title, prompt, roleIds: [], sceneAssetIds: [], seconds: 6, aspect: "9:16", soundMode: "silent", generationMode: "auto", dialogue: [] });
const noFilm = full.replace("写实真人电影质感，Kodak Vision3 250D 胶片颗粒。", "");
// 标题故意带全角竖线、空格和括号：必须原样出现。
const queue = { title: "示例项目_EP03_v2", chapters: [
  { title: "第一场 办公室", shots: [shot("EP03-L01｜张三 抬眼（夜）"), shot("EP03-L02｜缺胶片  两个空格", noFilm)] },
  { title: "第二场 走廊", shots: [shot("EP03-L03｜放行的镜头", noFilm), shot("EP03-L04｜最后一镜")] },
] };
const rows = queueCompleteness(queue, () => ({ visible: [], all: [] }));
const flat = queue.chapters.flatMap((chapter, c) => chapter.shots.map((s, i) => ({ s, c, i })));
const shots = flat.map(({ s, c }, n) => {
  const results = rows[n].results;
  return { code: s.title.split("｜")[0].replace("EP03-", ""), title: s.title, chapter: queue.chapters[c].title,
    missing: results.filter((result) => result.state === "missing").map((result) => result.id),
    h3q: n === 3 ? [{ level: "WARN", where: "镜4", message: "台词时长不够" }] : [],
    canvas: n === 0 ? [{ level: "error", message: "Picture 2 找不到素材" }] : [],
    gate: shotGate(s, results).map((item) => ({ id: item.id, label: item.label, note: item.note })),
    ...(n === 2 ? { confirmed: "这一镜是黑场转场" } : {}) };
});
assert.ok(shots[1].gate.some((item) => item.id === "style"), "缺胶片 → 画面五项不过");
assert.ok(shots[2].gate.length > 0);

const { text, count } = aiFixText({ queueTitle: queue.title, chapters: queue.chapters.map((chapter) => chapter.title), zhengbenVersion: "v2026-11-11.4", scope: "提示词完整度有漏写的镜头", shots });
const blocks = text.split("\n\n");
// 开头：队列、章节、正本路径和版本、先读正本、只改正文、title 不改、h3q 清零、不附 JSON。
assert.match(blocks[0], /「示例项目_EP03_v2」，章节：第一场 办公室、第二场 走廊/);
assert.ok(blocks[0].includes(`${ZHENGBEN_PATH}（当前版本 v2026-11-11.4）`));
assert.match(blocks[0], /先读正本/); assert.match(blocks[0], /只改提示词正文/); assert.match(blocks[0], /title 一字不改/); assert.match(blocks[0], /h3q check/); assert.match(blocks[0], /ERROR 和 WARN 清零/);
assert.match(blocks[0], /完整队列请用卡片「导出 JSON」/);
assert.doesNotMatch(text, /"chapters"|"prompt"\s*:/, "不附队列 JSON");
// 镜头顺序 + title 原样
const listed = blocks.slice(1).map((block) => /^【([^】]+)】(.*?)（章节：/.exec(block)).filter(Boolean);
assert.deepEqual(listed.map((m) => m[1]), shots.filter((item) => item.missing.length || item.gate.length || item.h3q.length || item.canvas.length).map((item) => item.code));
for (const item of shots) if (listed.some((m) => m[1] === item.code)) assert.ok(text.includes(`】${item.title}（章节：${item.chapter}）`), item.title);
assert.equal(count, listed.length);
const blockOf = (code) => blocks.find((block) => block.startsWith(`【${code}】`));
// 五项必改；放行的标可不改，且不写「必改」
assert.match(blockOf("L02"), /画面五项不过（必改，不改不能入队）：\n- 风格胶片：/);
assert.ok(blockOf("L02").includes(CATEGORY_BY_ID.style.rule), "规则取自类别表");
assert.match(blockOf("L03"), /用户已确认放行，可以不改（理由：这一镜是黑场转场）/);
assert.doesNotMatch(blockOf("L03"), /必改/);
assert.match(text, /其中 1 镜画面五项不过，必改/, "放行的不算进必改数");
// 漏写类别附「怎样才算写到」，五项类别不在漏写里重复
for (const id of shots[0].missing) assert.ok(blockOf("L01").includes(`- ${CATEGORY_BY_ID[id].label}：${CATEGORY_BY_ID[id].rule}`), id);
assert.ok(!/漏写[^]*- 风格胶片：/.test(blockOf("L02").split("漏写（")[1] ?? ""), "风格胶片只在必改里");
// h3q 原文、画布检查
assert.match(blockOf("L04"), /正本 h3q 原文：\n- WARN 镜4：台词时长不够/);
assert.match(blockOf("L01"), /画布检查（正本 h3q 查不到的）：\n- 写错：Picture 2 找不到素材/);

// 只复制一镜
const one = aiFixText({ queueTitle: queue.title, chapters: ["第一场 办公室"], scope: "这一镜", shots: [shots[1]] });
assert.equal(one.count, 1); assert.match(one.text, /当前版本 未知/);
// 整集条目
assert.match(aiFixText({ queueTitle: "Q", chapters: [], scope: "正本 h3q", shots: [], general: [{ level: "ERROR", where: "一致性", message: "光线句前后不一样" }] }).text, /整集的 h3q 条目（不属于某一镜）：\n- ERROR 一致性：光线句前后不一样/);
// 没有问题
const clean = aiFixText({ queueTitle: "Q", chapters: ["一"], zhengbenVersion: "v1", scope: "写错的镜头", shots: [{ code: "L01", title: "好", chapter: "一", missing: [], h3q: [], canvas: [], gate: [] }] });
assert.deepEqual(clean, { count: 0, text: "「Q」写错的镜头：没有问题，不用改。（正本 v1）" });

// 标准范本（本机有正本时）：0 漏写、五项过 → 没有问题。
const SAMPLE = `${process.env.FRAMEFLOW_H3_TOOLS || "h3-tools"}/范本/示例项目_EP02v5_L03_标准/示例项目_EP02v5_L03_标准_queue.json`;
if (existsSync(SAMPLE)) {
  const sample = parseShotQueue(readFileSync(SAMPLE, "utf8"));
  const sampleRows = queueCompleteness(sample, () => ({ visible: ["张三", "李四"], all: ["张三", "李四"] }));
  const list = sample.chapters.flatMap((chapter) => chapter.shots.map((s) => ({ s, chapter: chapter.title }))).map(({ s, chapter }, n) => ({ code: "L03", title: s.title, chapter, missing: sampleRows[n].results.filter((r) => r.state === "missing").map((r) => r.id), h3q: [], canvas: [], gate: shotGate(s, sampleRows[n].results) }));
  const result = aiFixText({ queueTitle: sample.title, chapters: [], scope: "提示词完整度有漏写的镜头", shots: list });
  assert.equal(result.count, 0, result.text); assert.match(result.text, /没有问题/);
  console.log("  标准范本 L03：没有问题");
}

// 接线
const board = readFileSync(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8");
const comp = readFileSync(new URL("../components/shot-card-ai-copy.tsx", import.meta.url), "utf8");
assert.match(comp, /aiFixText\(input\)/); assert.match(comp, /copyPlainText\(text, count \?/, "复制成功走右下角小提示（lib/copy-toast.ts）"); assert.match(comp, /<textarea ref=\{area\} readOnly/, "剪贴板失败时手动复制");
assert.match(comp, /已复制 \$\{count\} 镜的问题/);
for (const scope of ["提示词完整度有漏写的镜头", "正本 h3q 报了问题的镜头", "写错的镜头", "漏写的镜头", "这一镜"]) assert.ok(board.includes(`copyForAi("${scope}"`), scope);
assert.match(board, /\.scv-shade, \.sca-shade/, "手动复制框开着时 Esc 不关卡片");
assert.doesNotMatch(board, /copyProblems/, "旧的复制写法不留两套");

console.log("shot card copy for AI: order, titles verbatim, 画面五项 必改, 放行 可不改, rules from the category table, empty → 没有问题; ok");
