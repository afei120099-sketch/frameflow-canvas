// 提示词完整度：类别表覆盖设计要求列的全部类别；正本写法的范例逐类判断合理；h3工具 下的旧队列能跑、不抛错。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { PROMPT_CATEGORIES, ZHENGBEN_CATEGORY_VERSION, categoryGuideText, categoryTableStale } from "../lib/zhengben-categories.ts";
import { shotCompleteness, queueCompleteness, positionsIn, handsIn } from "../lib/prompt-completeness.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";
import { SHOT_CARD_GUIDE } from "../lib/shot-card-guide.ts";

// ── 1. 类别表 ──
assert.match(ZHENGBEN_CATEGORY_VERSION, /^v\d{4}-\d{2}-\d{2}\.\d+$/);
const labels = PROMPT_CATEGORIES.map((c) => c.label);
// 设计要求「至少包括」+「完整度必须补上的空白」11 项。
for (const need of ["参考说明", "风格胶片", "场景", "道具可见", "光线", "主要动作", "分秒动作", "景别焦段", "构图", "站位朝向", "运镜机位", "每段表情", "左右手", "动作声", "声音段", "对白语气", "台词时长", "画面要求", "镜间衔接"]) assert.ok(labels.includes(need), need);
assert.equal(new Set(PROMPT_CATEGORIES.map((c) => c.id)).size, PROMPT_CATEGORIES.length);
for (const c of PROMPT_CATEGORIES) assert.ok(c.rule && c.source, c.id);
// 「复制卡片功能说明」同步列出类别。
assert.ok(SHOT_CARD_GUIDE.includes(categoryGuideText()), "说明里有类别清单");
assert.ok(SHOT_CARD_GUIDE.includes(ZHENGBEN_CATEGORY_VERSION));

// ── 2. 正本写法范例（和 test-zhengben-queues 同一镜 L03） ──
const L03 = [
  "参考说明（编号与提交顺序一致）：<Picture 1>是窗侧场景图，只用于这间办公室的桌、椅、玻璃门和窗，光线按正文；<Picture 2>是张三，只用于张三的脸、发型和服装；<Picture 3>是李四，只用于李四的脸、发型和服装。",
  "写实真人电影质感，Kodak Vision3 250D 胶片颗粒，真实皮肤毛孔与细小绒毛，布料褶皱与纤维清晰，生活感真实。他在画左，四分之三侧脸，坐在椅子上；她在画右，站在桌子靠门的一侧。玻璃门在画中后景，关着。机位在桌沿下，仰拍，中近景，35mm 等效，机位固定。",
  "夜里的办公室灯火通明：天花板的筒灯开着，台灯在画右桌角，暖黄色的光照在张三和李四的脸上和桌面的稿纸上。",
  "主要动作：桌沿下仰看，他抬眼看向画右的她，她先听他说完再说话。",
  "0-3秒：他抬眼，看向画右的她，下颌轻绷。她看向他，眨一下眼。",
  "3-8秒：他说话，四分之三侧脸，右手食指点在稿纸的圈注上。",
  "8-13秒：她说话，四分之三侧脸，左手按住桌沿。",
  "13-13.6秒：她看向他，脚留在画右，右手把一缕头发别到耳后。",
  "声音：很轻的房间底噪，手碰到纸时有纸页轻响。",
  "对白（中文普通话，口型同步）：张三：“这张表算错了。过来，我指给你看。” 李四：“等等啊。我这一页还没改完呢，你先坐。”",
  "画面要求：竖屏9:16，一条镜头拍完，中间不切换；人物脸型、发型与参考图严格一致，手指数量正常、手部不变形，口型与台词同步；画面中除场景本身的文件、屏幕文字外，没有字幕、水印或文字叠加；保持真实质感，皮肤不过度磨皮，没有卡通或CG塑料感，前景没有额外人物闯入，画面稳定不闪烁。参考图里已有的标志、招牌、商标保持原样。",
].join("\n");
const shot = { title: "EP02-L03｜抬头等她过来", roleIds: ["zy", "lw"], sceneAssetIds: ["office"], seconds: 14, aspect: "9:16", soundMode: "av", prompt: L03 };
const ctx = { visibleNames: ["张三", "李四"], roleNames: ["张三", "李四"] };
const result = Object.fromEntries(shotCompleteness(shot, ctx).map((r) => [r.id, r]));
assert.equal(Object.keys(result).length, PROMPT_CATEGORIES.length);
const stateOf = (id) => result[id].state;
for (const id of ["style", "scene", "light", "main", "timeline", "compose", "camera", "hands", "actionSound", "sound", "dialogueTime", "require"]) assert.equal(stateOf(id), "ok", `${id}: ${JSON.stringify(result[id])}`);
assert.equal(stateOf("props"), "na");
assert.equal(stateOf("continuity"), "na", "队列第一镜");
// 场景图没写「不用于人物」、对白没写语气：正本模板的写法，不是硬要求（标准范本也没写），算写了、只提示。
assert.equal(stateOf("reference"), "ok"); assert.match(result.reference.note, /提示.*不用于人物/);
assert.equal(stateOf("shotsize"), "missing"); assert.equal(result.shotsize.note, "缺景深");
assert.equal(stateOf("blocking"), "missing"); assert.match(result.blocking.note, /两人距离/);
assert.equal(stateOf("face"), "missing"); assert.match(result.face.note, /3-8秒/);
assert.equal(stateOf("dialogue"), "ok"); assert.match(result.dialogue.note, /提示：张三、李四 可以加语气/);
// 台词放进 dialogue 字段、正文没有对白行 → 漏写。
const fieldOnly = Object.fromEntries(shotCompleteness({ ...shot, prompt: L03.replace(/\n对白[^\n]*/, ""), dialogue: [{ roleId: "zy", text: "这张表算错了。" }] }, ctx).map((r) => [r.id, r]));
assert.equal(fieldOnly.dialogue.state, "missing"); assert.match(fieldOnly.dialogue.note, /dialogue 字段/); assert.match(fieldOnly.dialogue.note, /没有「对白/);
assert.ok(result.style.evidence.some((e) => e.includes("Kodak Vision3 250D")), "点开能看到原文");
assert.ok(result.camera.evidence.length && result.light.evidence.length);

// 补齐以后都变成「写了」。
const fixed = L03
  .replace("<Picture 1>是窗侧场景图，只用于这间办公室的桌、椅、玻璃门和窗，光线按正文", "<Picture 1>是窗侧场景图，只用于这间办公室的桌、椅、玻璃门和窗的布局与光线，不用于人物")
  .replace("35mm 等效，机位固定", "35mm 等效，浅景深，背景虚化，机位固定").replace("站在桌子靠门的一侧", "隔着桌子站在靠门的一侧")
  .replace("3-8秒：他说话，四分之三侧脸，右手食指点在稿纸的圈注上。", "3-8秒：他说话，四分之三侧脸，右手食指点在稿纸的圈注上。她垂眼看稿纸，手指收紧。")
  .replace("8-13秒：她说话，四分之三侧脸，左手按住桌沿。", "8-13秒：她说话，四分之三侧脸，左手按住桌沿。他挑眉，靠回椅背。")
  .replace("13-13.6秒：她看向他，脚留在画右", "13-13.6秒：她看向他，嘴角一松，他点头，她脚留在画右")
  .replace("张三：“", "张三（平淡）：“").replace("李四：“", "李四（为难）：“");
const fixedResult = shotCompleteness({ ...shot, prompt: fixed }, ctx);
assert.deepEqual(fixedResult.filter((r) => r.state === "missing").map((r) => `${r.id}:${r.note}`), []);

// 静音镜：声音和动作声不适用；没台词：对白两项不适用。
const silent = Object.fromEntries(shotCompleteness({ ...shot, soundMode: "silent", prompt: L03.replace(/\n对白[^\n]*/, "") }, ctx).map((r) => [r.id, r.state]));
assert.equal(silent.sound, "na"); assert.equal(silent.actionSound, "na"); assert.equal(silent.dialogue, "na"); assert.equal(silent.dialogueTime, "na");

// 手拿道具：没写「必须清晰可见」→ 漏写；写了 → 写了。左右手不分 → 漏写。
const prop = L03.replace("右手食指点在稿纸的圈注上", "手里拿着一支红笔");
const propResult = Object.fromEntries(shotCompleteness({ ...shot, prompt: prop }, ctx).map((r) => [r.id, r]));
assert.equal(propResult.props.state, "missing"); assert.equal(propResult.hands.state, "missing");
assert.equal(Object.fromEntries(shotCompleteness({ ...shot, prompt: prop.replace("手里拿着一支红笔", "右手拿着一支红笔，红笔必须清晰可见") }, ctx).map((r) => [r.id, r.state])).props, "ok");

// 台词太长 → 台词时长漏写。
const long = Object.fromEntries(shotCompleteness({ ...shot, prompt: L03.replace("这张表算错了。过来，我指给你看。", "长".repeat(40)) }, ctx).map((r) => [r.id, r]));
assert.equal(long.dialogueTime.state, "missing"); assert.match(long.dialogueTime.note, /3-8秒说 40 字/);

// ── 3. 镜间衔接和整集画面要求 ──
assert.deepEqual(positionsIn("他在画左，坐着；李四站在画右", ["李四"]), { 他: "画左", 李四: "画右" });
const next = { ...shot, title: "EP02-L04｜下一镜", prompt: L03.replace("他在画左，四分之三侧脸", "他在画右，四分之三侧脸").replace(/^画面要求：[^\n]*/m, "画面要求：竖屏。") };
const queue = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "测试", defaults: { noBackgroundMusic: true }, chapters: [{ title: "一", shots: [shot, next, { ...shot, title: "EP02-L05｜再一镜" }] }] }));
const rows = queueCompleteness(queue, () => ({ visible: ["张三", "李四"], all: ["张三", "李四"] }));
const r2 = Object.fromEntries(rows[1].results.map((r) => [r.id, r]));
// 上一镜结尾「她…脚留在画右」→ 这一镜「她在画右」接得上；他在上一镜结尾没写，不算冲突。
assert.equal(r2.continuity.state, "ok", JSON.stringify(r2.continuity));
assert.equal(r2.require.state, "missing"); assert.match(r2.require.note, /整集/);
assert.equal(Object.fromEntries(rows[0].results.map((r) => [r.id, r.state])).require, "ok");
const clashing = { ...shot, title: "EP02-L06｜冲突", prompt: L03.replace("她在画右，站在桌子靠门的一侧", "她在画左，站在桌子靠门的一侧") };
const q2 = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "测试2", chapters: [{ title: "一", shots: [shot, clashing] }] }));
const c2 = queueCompleteness(q2, () => ({ visible: ["张三", "李四"], all: ["张三", "李四"] }))[1].results.find((r) => r.id === "continuity");
assert.equal(c2.state, "missing"); assert.match(c2.note, /上一镜结束她在画右，这一镜开始在画左/);
const chained = queueCompleteness(parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "测试3", chapters: [{ title: "一", shots: [shot, { ...clashing, generationMode: "first-last", firstFrameFrom: { shot: shot.title, frame: "last" } }] }] })), () => ({ visible: ["张三", "李四"], all: [] }))[1].results.find((r) => r.id === "continuity");
assert.equal(chained.state, "ok", "首帧接上一镜尾帧算衔接上");
// 手和道具：上一镜结束右手拿着红笔，这一镜开始换成左手 → 漏写（衔接不上）。
assert.deepEqual(handsIn("她右手拿着一支红笔，左手攥着手机。右手食指点在稿纸上。"), { 红笔: "右手", 手机: "左手" });
const penEnd = { ...shot, title: "EP02-L07｜拿笔", prompt: L03.replace("13-13.6秒：她看向他，脚留在画右，右手把一缕头发别到耳后。", "13-13.6秒：她看向他，脚留在画右，右手拿着一支红笔。") };
const penSwap = { ...shot, title: "EP02-L08｜换手", prompt: L03.replace("她在画右，站在桌子靠门的一侧", "她在画右，左手拿着一支红笔，站在桌子靠门的一侧") };
const penSame = { ...penSwap, title: "EP02-L09｜同手", prompt: penSwap.prompt.replace("左手拿着一支红笔", "右手拿着一支红笔") };
const pens = queueCompleteness(parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "测试4", chapters: [{ title: "一", shots: [penEnd, penSwap] }, { title: "二", shots: [penEnd, penSame] }] })), () => ({ visible: ["张三", "李四"], all: ["张三", "李四"] })).map((row) => row.results.find((r) => r.id === "continuity"));
assert.equal(pens[1].state, "missing"); assert.match(pens[1].note, /红笔在右手，这一镜开始换到了左手/);
assert.equal(pens[3].state, "ok", JSON.stringify(pens[3]));
// 类别表跟的正本版本：正本改版时提示同步。
assert.equal(categoryTableStale(ZHENGBEN_CATEGORY_VERSION), false); assert.equal(categoryTableStale("未知"), false); assert.equal(categoryTableStale(undefined), false);
assert.equal(categoryTableStale("v2099-01-01.1"), true);

// ── 3b. 标准范本（正本 v2026-11-11.2 的标准队列实测 EP02v5 L03，h3q 0 错 0 警 0 提示）：必须 0 漏写 ──
const H3 = process.env.FRAMEFLOW_H3_TOOLS || "h3-tools";
const SAMPLE = `${H3}/范本/示例项目_EP02v5_L03_标准/示例项目_EP02v5_L03_标准_queue.json`;
let sampleChecked = false;
if (existsSync(SAMPLE)) {
  const sampleRows = queueCompleteness(parseShotQueue(readFileSync(SAMPLE, "utf8")), () => ({ visible: ["张三", "李四"], all: ["张三", "李四"] }));
  assert.deepEqual(sampleRows.flatMap((row) => row.results.filter((r) => r.state === "missing").map((r) => `${row.title} ${r.id}:${r.note}`)), [], "标准范本 0 漏写");
  const sr = Object.fromEntries(sampleRows[0].results.map((r) => [r.id, r]));
  // 范本 2026-11-12 按正本 v2026-11-12.1 改成第一句从 0 秒开始（[开场空白] 硬规则），不再有「开场 N 秒没台词」的提示。
  assert.equal(sr.dialogueTime.state, "ok"); assert.doesNotMatch(sr.dialogueTime.note ?? "", /开场 \d+(?:\.\d+)? 秒没台词/);
  assert.match(sr.actionSound.note, /不写「很轻」/);
  sampleChecked = true;
}

// ── 4. h3工具 下的现成队列：每镜每类都有结果，不抛错 ──
let counted = 0;
for (const name of ["EP01_queue.json", "EP02_queue.json"]) {
  const file = `${H3}/${name}`;
  if (!existsSync(file)) continue;
  const q = parseShotQueue(readFileSync(file, "utf8"));
  for (const row of queueCompleteness(q, (s) => ({ visible: s.roleIds.filter((id) => !s.offscreenRoleIds?.includes(id)), all: s.roleIds }))) {
    assert.equal(row.results.length, PROMPT_CATEGORIES.length);
    // 这两份是六段式写的：2026-11-13 起和正本 h3q（is_official）一样按官方格式认——中文写法的类别不判（不适用，写明原因），只判画面五项。
    for (const id of ["reference", "main", "require"]) { const r = row.results.find((x) => x.id === id); assert.equal(r.state, "na", `${row.title} ${id}`); assert.match(r.note, /官方格式/); }
    counted++;
  }
}
console.log(`prompt completeness: ${PROMPT_CATEGORIES.length} 类，正本范例逐类合理${sampleChecked ? "，标准范本 0 漏写" : ""}${counted ? `，h3工具 旧队列 ${counted} 镜` : ""}; ok`);
