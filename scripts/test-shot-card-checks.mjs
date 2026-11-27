// 画布自己的检查：只留正本 h3q 查不到的（参考图顺序 / 数量、时间轴、角色绑定、对白说话人、每段有动作、声音）。
// 写法规则（dialogue、人名、嘴、配乐、定格、no logos、景别、光线、左右手、说话段字数）只认 h3q，这里断言画布不再重复报。
import assert from "node:assert/strict";
import { breakdownShotPrompt } from "../lib/shot-card-breakdown.ts";
import { checkShot, misplacedNames } from "../lib/shot-card-checks.ts";

const role = (name, extra = {}) => ({ name, offscreen: false, speaks: false, hasAppearance: true, hasVoice: true, missing: false, ...extra });
const run = (prompt, extra = {}) => checkShot({ prompt, breakdown: breakdownShotPrompt(prompt), actualSeconds: 8.71, soundMode: "av", pictures: [], roles: [role("张三"), role("李四")], fieldLines: {}, noBackgroundMusic: true, ...extra });
const codes = (list) => list.map((c) => c.code);

// 按正本写：dialogue 空，台词只在对白行；动作段用他 / 她，不写开口 / 嘴唇闭着；声音段不点名配乐。
const good = `参考说明（编号与提交顺序一致）：<Picture 1>是张三，只用于张三的脸、发型和服装；<Picture 2>是李四，只用于李四的脸、发型和服装；<Picture 3>是场景图，只用于办公室的布局与光线，不用于人物。
写实真人电影质感，台灯在画右桌角，暖光照在两人脸上。他在画左，坐在椅子上；她在画右，站着。中景，机位固定。
主要动作：他把稿子推给她。
0-4秒：他用右手把稿子推到画右，她低头看稿。
4-8.7秒：她抬眼说话，他的手指点在圈注上。
声音：很轻的房间底噪，纸页轻响。
对白（中文普通话，口型同步）：李四（平静）：“好。”
画面要求：竖屏9:16，人物脸型、发型、服装与参考图严格一致，口型与台词同步。`;
const pics = [{ label: "Picture 1", name: "角色 张三" }, { label: "Picture 2", name: "角色 李四" }, { label: "Picture 3", name: "场景 office.png" }];
const ok = run(good, { pictures: pics });
assert.deepEqual(codes(ok), [], JSON.stringify(ok));
// 没绑声音也不报：正本原样提交、不带角色声音。
assert.deepEqual(codes(run(good, { pictures: pics, roles: [role("张三", { hasVoice: false }), role("李四", { hasVoice: false })] })), []);
// 没有台词的镜头：不要求写「不出声 / 嘴唇闭着」。
assert.deepEqual(codes(run(good.replace(/\n对白[^\n]*/, "").replace("她抬眼说话", "她抬眼看他"), { pictures: pics })), []);

// 1. Picture order / count.
const swapped = good.replace("<Picture 1>是张三，只用于张三", "<Picture 1>是李四，只用于李四");
assert.ok(codes(run(swapped, { pictures: pics })).includes("picture_order"));
assert.ok(codes(run(good + "\n<Picture 5> 的桌子", { pictures: pics })).includes("picture_count"));

// 2. Timeline.
assert.ok(codes(run(good.replace("4-8.7秒", "4-10秒"))).includes("timeline_overflow"));
assert.ok(codes(run(good.replace("4-8.7秒", "5-8.7秒"))).includes("timeline_gap"));

// 3–7. 交给正本 h3q 的写法规则：画布不再自己报（免得两边说法打架）。
const MOVED = ["dialogue_too_short", "dialogue_field", "mouth_words", "name_misplaced", "music_named", "freeze", "no_logos", "meta", "no_start", "no_camera", "no_light", "hand_side", "timeline_missing"];
const risky = [
  run(good.replace("“好。”", "“这一段台词特别特别长，长到四秒多根本说不完，肯定会被截断的。”")),
  run(good, { fieldLines: { 李四: ["好。"] } }),
  run(good.replace("她抬眼说话", "她抬眼开口")),
  run(good.replace("0-4秒：他用右手", "0-4秒：张三用右手")),
  run(`${good}\n没有背景音乐。`),
  run(good + "\n画面定格在两人对视。"),
  run(good + "\nno logos or lettering."),
  run(`主要动作：她拿起杯子。\n0-4秒：她拿起杯子。\n4-8.7秒：她看着他。`),
  run("她拿起杯子，走到窗边。", { actualSeconds: 10 }),
];
for (const list of risky) for (const code of MOVED) assert.ok(!codes(list).includes(code), `${code} 应交给 h3q：${codes(list)}`);
// misplacedNames 还在（一键选预设的测试用它确认换进去的句子不带人名）。
assert.deepEqual(misplacedNames(good, ["张三", "李四"]), []);
assert.deepEqual(misplacedNames(good.replace("0-4秒：他用右手", "0-4秒：张三用右手"), ["张三", "李四"]), ["张三"]);
assert.deepEqual(misplacedNames(good + "\n夜里的办公室灯火通明，台灯暖光照在张三和李四的脸上。", ["张三", "李四"]), [], "设定档光线句可以带人名");

// 8. Bindings / risky words / omissions.
assert.ok(codes(run(good, { roles: [role("张三", { hasAppearance: false }), role("李四")] })).includes("role_appearance"));
const bare = `主要动作：她拿起杯子。\n0-4秒：她拿起杯子。\n4-8.7秒：她看着他。`;
const bareCodes = codes(run(bare));
for (const code of ["no_sound", "beat_static"]) assert.ok(bareCodes.includes(code), `${code} in ${bareCodes}`);
assert.ok(codes(run(bare, { roles: [role("张三"), role("李四"), role("小刘")] })).includes("role_unmentioned"));
assert.ok(codes(run(good.replace("李四（平静）", "小刘"))).includes("dialogue_speaker"));
assert.ok(!codes(run(good.replace("4-8.7秒", "4-8.8秒"), { requestedSeconds: 9 })).some((c) => c.startsWith("timeline")), "0.1 s alignment is not noise-worthy");
console.log("shot card checks (画布独有，写法规则交给 h3q): ok");
