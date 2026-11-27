// 卡片里每个角色的「台词」，按正本 %FRAMEFLOW_H3_TOOLS%\SKILL_h3-video.md「第一集写法」：
// 写进正文「对白（中文普通话，口型同步）：」那一行，dialogue 留空；提交时正文原样，不追加人名、声音录音、元指令、嘴唇句。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { roleLines, setRoleLines, linesFromText, planDialogueImport, applyDialogueImport, importSummary } from "../lib/shot-role-lines.ts";
import { parseDialogueRow, writeDialogueRow, DIALOGUE_ROW_LABEL } from "../lib/dialogue-row.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";
import { pushVersion, stepVersion } from "../lib/shot-queue-history.ts";
import { prepareH3ReferenceSubmission } from "../lib/h3-reference-submission.ts";
import { SHOT_CARD_GUIDE } from "../lib/shot-card-guide.ts";

const BODY = [
  "参考说明（编号与提交顺序一致）：<Picture 1>是张三，只用于张三的脸、发型和服装；<Picture 2>是李四，只用于李四的脸、发型和服装。",
  "写实真人电影质感，办公室，白天窗光从画左照进来，中景固定机位。他在画左，站着；她在画右，坐着。",
  "主要动作：他把文件推到她面前，她看完说话。",
  "0-3秒：他站在画左，用右手把文件推到她面前。",
  "3-7秒：她低头看文件，抬眼说话。",
  "7-10秒：他点头，右手手指敲了敲桌面。",
  "声音：很轻的房间底噪，纸页轻响，指节敲桌面的轻响。",
  "画面要求：竖屏9:16，人物脸型、发型、服装与参考图严格一致，口型与台词同步。",
].join("\n");

// ── 1. 按角色读写正文对白行：插在画面要求前；改一个角色只动他的句子；其余正文一字不动 ──
const base = { title: "EP03-05", prompt: BODY, roleIds: ["roleA", "roleB"], sceneAssetIds: [], seconds: 10, aspect: "9:16", soundMode: "av" };
let step = setRoleLines(base, "李四", ["这份报价，你自己看过吗？", "  ", "第二句 "]);
let shot = step.shot;
assert.equal(shot.prompt, BODY.replace("\n画面要求", `\n${DIALOGUE_ROW_LABEL}李四：“这份报价，你自己看过吗？” 李四：“第二句”\n画面要求`));
assert.equal("dialogue" in shot, false, "不写 dialogue");
shot = setRoleLines(shot, "张三", ["看过。"]).shot;
shot = setRoleLines(shot, "李四", ["改过的一句"]).shot;
assert.deepEqual(parseDialogueRow(shot.prompt).entries.map((e) => `${e.speaker}:${e.text}`), ["李四:改过的一句", "张三:看过。"], "改李四：留在原位置，张三的不动");
assert.deepEqual(roleLines(shot, "张三"), ["看过。"]);
assert.equal(shot.prompt.replace(/\n对白[^\n]*/, ""), BODY, "对白行以外一字不动");
// 清空就从对白行去掉；都清空就没有对白行
assert.deepEqual(roleLines(setRoleLines(shot, "李四", []).shot, "李四"), []);
assert.equal(setRoleLines(setRoleLines(shot, "李四", []).shot, "张三", []).shot.prompt, BODY);
// 已有的语气（张三（平淡））保留；对白行原有标签不改
const toned = { ...base, prompt: BODY.replace("\n画面要求", "\n对白（中文普通话，口型同步）：张三（平淡）：“看过。” 李四：“好。”\n画面要求") };
assert.match(setRoleLines(toned, "张三", ["看过了。"]).shot.prompt, /对白（中文普通话，口型同步）：张三（平淡）：“看过了。” 李四：“好。”/);
// 看不出是谁说的：不猜，报错
assert.ok("error" in setRoleLines({ ...base, prompt: "对白：“没写谁”" }, "李四", ["x"]));
assert.deepEqual(linesFromText("一\r\n\n 二 \n"), ["一", "二"]);
assert.equal(writeDialogueRow("主要动作：x。", [{ speaker: "李四", text: "好。" }]), `主要动作：x。\n${DIALOGUE_ROW_LABEL}李四：“好。”`);

// ── 2. 按正本写的队列：载入就能在角色下看到对白行里的台词 ──
const queueJson = { version: "shot-queue-v1", title: "示例项目 EP03", defaults: { noBackgroundMusic: true }, chapters: [{ title: "一", shots: [
  { ...base, title: "EP03-05", prompt: BODY.replace("\n画面要求", `\n${DIALOGUE_ROW_LABEL}李四：“你自己看过吗？”\n画面要求`) },
  { ...base, title: "EP03-06", prompt: "0-10秒：两人对视。", soundMode: "ambient" },
] }] };
const queue = parseShotQueue(JSON.stringify(queueJson));
assert.deepEqual(roleLines(queue.chapters[0].shots[0], "李四"), ["你自己看过吗？"]);
assert.deepEqual(roleLines(queue.chapters[0].shots[0], "张三"), []);

// ── 3. 从 JSON 导入台词：写进对白行，不写 dialogue；对不上的列出来；先预览再写 ──
const roles = [{ roleId: "roleA", displayName: "张三" }, { roleId: "roleB", displayName: "李四" }];
const mapPlan = planDialogueImport(JSON.stringify({ "EP03-05": { "李四": ["新的一句", "第二句"], "张三": "哪儿不对？" }, "EP03-06": { "李四": ["嗯。"], "钱总": ["我是谁"] }, "EP09-01": { "李四": ["不存在的镜头"] } }), queue, roles);
assert.ok(!("error" in mapPlan));
assert.deepEqual(mapPlan.changes.map((c) => [c.shotTitle, c.roleName, c.lines.length, c.replaced]), [["EP03-05", "李四", 2, 1], ["EP03-05", "张三", 1, 0], ["EP03-06", "李四", 1, 0]]);
assert.deepEqual(mapPlan.unmatched, ["「EP03-06」里没有角色「钱总」", "队列里没有镜头「EP09-01」"]);
assert.deepEqual(mapPlan.needsAv, ["EP03-06"], "只要环境声的镜头要改有声");
const summary = importSummary(mapPlan);
assert.match(summary, /会改 2 镜、3 个角色的台词，写进正文「对白」那一行，覆盖已有台词 1 句/);
assert.match(summary, /「EP03-05」李四：2 句（覆盖原有 1 句）/);
assert.match(summary, /会改成「有声 av」（背景乐禁用不变）：EP03-06/);
const before = JSON.stringify(queue);
const imported = applyDialogueImport(queue, mapPlan);
assert.equal(JSON.stringify(queue), before, "预览和写入是分开的：原队列没被改");
assert.deepEqual(parseDialogueRow(imported.chapters[0].shots[0].prompt).entries.map((e) => `${e.speaker}:${e.text}`), ["李四:新的一句", "李四:第二句", "张三:哪儿不对？"]);
assert.equal(imported.chapters[0].shots.some((s) => "dialogue" in s), false);
assert.equal(imported.chapters[0].shots[1].soundMode, "av");
assert.equal(imported.defaults.noBackgroundMusic, true);
const importedText = `${JSON.stringify(imported, null, 2)}\n`;
assert.doesNotThrow(() => parseShotQueue(importedText));
const history = pushVersion(pushVersion({ versions: [], index: -1 }, before), importedText);
assert.equal(stepVersion(history, -1).text, before, "撤销 = 回到导入前");
// 整份队列：按正本写的读对白行；旧队列读 dialogue（roleId 或 speaker 名字）
const fromRow = planDialogueImport(JSON.stringify({ chapters: [{ shots: [{ title: "EP03-06", prompt: `${DIALOGUE_ROW_LABEL}张三：“走吧。” 李四：“好。”`, dialogue: [] }] }] }), queue, roles);
assert.deepEqual(fromRow.changes.map((c) => [c.roleName, c.lines]), [["张三", ["走吧。"]], ["李四", ["好。"]]]);
const fromField = planDialogueImport(JSON.stringify({ chapters: [{ shots: [{ title: "EP03-06", dialogue: [{ roleId: "roleA", text: "走吧。" }, { speaker: "李四", text: "好。" }, { text: "没写谁" }, { roleId: "ghost", text: "鬼" }] }] }] }), queue, roles);
assert.deepEqual(fromField.changes.map((c) => [c.roleName, c.lines]), [["张三", ["走吧。"]], ["李四", ["好。"]]]);
assert.equal(fromField.unmatched.length, 2);
assert.match(planDialogueImport("{ broken", queue, roles).error, /不是合法 JSON/);

// ── 4. 提交的正文：对白行原样提交，不追加人名、声音录音、元指令、嘴唇句 ──
const asset = (assetId, kind, filename) => ({ assetId, kind, storageReference: `${kind}:${assetId}`, filename });
const roleAssets = { roleAFace: asset("roleAFace", "image", "张三.png"), roleBFace: asset("roleBFace", "image", "李四.png"), roleBVoice: asset("roleBVoice", "audio", "李四.wav"), roleAVoice: asset("roleAVoice", "audio", "张三.wav") };
const roleA = { roleId: "roleA", displayName: "张三", description: "", appearanceAssetIds: ["roleAFace"], voiceAssetIds: ["roleAVoice"], primaryAppearanceAssetId: "roleAFace", primaryVoiceAssetId: "roleAVoice" };
const roleB = { roleId: "roleB", displayName: "李四", description: "", appearanceAssetIds: ["roleBFace"], voiceAssetIds: ["roleBVoice"], primaryAppearanceAssetId: "roleBFace", primaryVoiceAssetId: "roleBVoice" };
const compile = (prompt, noBackgroundMusic, dialogue = []) => prepareH3ReferenceSubmission({ images: [], videos: [], audios: [], roles: [roleA, roleB], roleAssets, dialogue, soundMode: "av" }, { noBackgroundMusic, prompt, promptMode: "plain", community: false }).compiled.prompt;
const withRoleBes = setRoleLines(base, "李四", ["这份报价，你自己看过吗？"]).shot.prompt;
// 没勾禁背景乐：逐字一致
assert.equal(compile(withRoleBes, false), withRoleBes);
// 勾了禁背景乐：只多每段一句「这段听到的」和结尾一句正向的可听声音句；去掉它们就是原文
const bgm = compile(withRoleBes, true);
const strip = (text) => text.replace(/这段听到的：[^。]*。/g, "").replace(/\n\nAudible audio is [^\n]*$/, "");
assert.equal(strip(bgm), withRoleBes);
assert.match(bgm, /3-7秒：她低头看文件，抬眼说话。这段听到的：房间底噪、这段的对白和动作的声响。/);
assert.match(bgm, /0-3秒：[^\n]*。这段听到的：房间底噪和这段动作的声响。/);
for (const text of [compile(withRoleBes, false), bgm]) {
  assert.doesNotMatch(text, /Role appearance|voice-timbre|Spoken dialogue|numbered|complete speech|lips closed|keeps the lips|\(李四|\(张三|开口|不出声|嘴唇闭着|background music|配乐/i, text);
  assert.equal(text.split("这份报价，你自己看过吗？").length - 1, 1, "台词只出现一次");
}
// 旧队列 dialogue 非空：仍按旧办法追加（卡片标红并给一键按钮），但不再加元指令和嘴唇句
const legacy = compile(BODY, true, [{ roleId: "roleB", text: "看过吗？" }]);
assert.match(legacy, /Spoken dialogue, in playback order:\n1\. <Subject 2> \(李四, S1\)/);
assert.doesNotMatch(legacy, /complete speech|numbered lines are|keeps the lips closed|的第 \d+ 句台词/);

// ── 5. 卡片界面和功能说明 ──
const card = readFileSync(path.resolve(import.meta.dirname, "../components/shot-card-board.tsx"), "utf8");
assert.match(card, /onClick=\{\(\) => openLines\(role\.roleId\)\}>台词/, "角色后面有「台词」");
assert.match(card, /const problem = ctx\.save\(next\);/, "保存走卡片的修改路径（进撤销历史、导出、另存）");
assert.match(card, /if \(!await askConfirm\(\{ title: "导入台词", message: importSummary\(plan\)/, "导入前页面内预览确认");
assert.doesNotMatch(card, /window\.confirm/);
assert.match(card, /dialogue_field: "把台词搬进正文对白"/, "旧 dialogue 一键搬进正文对白");
assert.doesNotMatch(card, /把正文对白改成台词字段|＋ 加一句台词/);
assert.match(SHOT_CARD_GUIDE, /规则以正本 %FRAMEFLOW_H3_TOOLS%\\SKILL_h3-video\.md 为准/);
assert.match(SHOT_CARD_GUIDE, /dialogue 一律留空/);
assert.match(SHOT_CARD_GUIDE, /对白（中文普通话，口型同步）：张三（平淡）：“台词。”/);
assert.doesNotMatch(SHOT_CARD_GUIDE, /"dialogue":\[\{|X 开口|嘴唇闭着 \/ 不出声 \/ stays silent/);
assert.match(SHOT_CARD_GUIDE, /从 JSON 导入台词/);

console.log("shot role lines: 台词 go into the prompt's 对白 row (正本 第一集写法), dialogue stays empty, submitted as written; import preview/undo; ok");
