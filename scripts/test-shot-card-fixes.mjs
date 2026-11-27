import assert from "node:assert/strict";
import { promptSegments, replaceSegments } from "../lib/shot-card-breakdown.ts";
import { dialogueFieldToRow, removeMusicSentences } from "../lib/shot-card-fixes.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";

const prompt = `参考说明（编号与提交顺序一致）：<Picture 1>是张三，只用于张三的脸、发型和服装。
写实真人电影质感。
主要动作：他抬头。
0-3秒：他抬眼，看向画右的她。
3-8秒：他说话，下颌轻绷。
声音：只有很轻的房间底噪。 他的声音低。 没有背景音乐。
画面要求：竖屏9:16。`;

// Segments are exact pieces: unchanged texts rebuild the prompt byte for byte; one edit touches only that piece.
const segments = promptSegments(prompt);
assert.equal(replaceSegments(prompt, segments, segments.map((s) => s.text)), prompt);
assert.deepEqual(segments.map((s) => s.label), ["参考说明", "正文", "主要动作", "0–3秒", "3–8秒", "声音", "画面要求"]);
const edited = replaceSegments(prompt, segments, segments.map((s) => s.label === "0–3秒" ? "0-3秒：他放下笔。" : s.text));
assert.equal(edited, prompt.replace("0-3秒：他抬眼，看向画右的她。", "0-3秒：他放下笔。"));

// English six-part, segments inside one paragraph.
const en = "detailed_description: Style [style v2]. Already in motion at 00:00: Subject 1 sits. 00:00-03:00 Subject 1 looks up. 03:00-06:00 Subject 1 speaks. After the last word, the shot ends.\noverall_soundscape: Room tone.";
const enSeg = promptSegments(en);
assert.equal(replaceSegments(en, enSeg, enSeg.map((s) => s.text)), en);
assert.ok(enSeg.some((s) => s.label === "0–3秒") && enSeg.some((s) => s.label === "开始"));

// 旧队列 dialogue 字段 → 正文对白行（正本「第一集写法」），dialogue 清空；其余正文一字不动。
const names = { zy: "张三", lw: "李四" };
const shot = { title: "L03", prompt, roleIds: ["zy", "lw"], sceneAssetIds: [], seconds: 8, aspect: "9:16", soundMode: "av", autoVoiceAssigned: true,
  dialogue: [{ roleId: "zy", text: "这张表算错了。过来。" }, { roleId: "lw", text: "不行啊。" }] };
const fixed = dialogueFieldToRow(shot, (id) => names[id]);
assert.ok("shot" in fixed, JSON.stringify(fixed));
assert.equal("dialogue" in fixed.shot, false);
assert.equal("autoVoiceAssigned" in fixed.shot, false);
assert.equal(fixed.shot.prompt, prompt.replace("\n画面要求", "\n对白（中文普通话，口型同步）：张三：“这张表算错了。过来。” 李四：“不行啊。”\n画面要求"), fixed.shot.prompt);
assert.doesNotThrow(() => parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "t", chapters: [{ title: "c", shots: [fixed.shot] }] })));
// 已经在对白行里的句子不写第二遍；对白行原有的语气留着。
const both = { ...shot, prompt: prompt.replace("\n画面要求", "\n对白（中文普通话，口型同步）：张三（得意）：“这张表算错了。过来。”\n画面要求") };
const merged = dialogueFieldToRow(both, (id) => names[id]);
assert.match(merged.shot.prompt, /对白（中文普通话，口型同步）：张三（得意）：“这张表算错了。过来。” 李四：“不行啊。”\n画面要求/);
assert.equal(merged.shot.prompt.split("这张表算错了").length - 1, 1);
// 路人（没有 roleId）用 speaker 名字；没有对白行也没有画面要求时写在最后。
const guest = dialogueFieldToRow({ ...shot, prompt: "主要动作：x。", dialogue: [{ roleId: "", speaker: "路人", text: "让一让。" }] }, () => undefined);
assert.equal(guest.shot.prompt, "主要动作：x。\n对白（中文普通话，口型同步）：路人：“让一让。”");
assert.ok("error" in dialogueFieldToRow({ ...shot, dialogue: [{ roleId: "ghost", text: "鬼" }] }, (id) => names[id]), "unknown role refuses");
assert.ok("error" in dialogueFieldToRow({ ...shot, dialogue: [] }, (id) => names[id]), "nothing to move");

// Music sentence removal keeps the rest of the sound line; the same words h3q flags.
const noMusic = removeMusicSentences(prompt);
assert.ok(!noMusic.includes("背景音乐"));
assert.ok(noMusic.includes("声音：只有很轻的房间底噪。 他的声音低。"));
assert.equal(removeMusicSentences("Room tone. No background music; keep only the diegetic sounds."), "Room tone.");
assert.equal(removeMusicSentences("声音：只有房间底噪，没有背景音乐。"), "声音：只有房间底噪。");
assert.equal(removeMusicSentences("他的声音低。 没有背景音乐。"), "他的声音低。");
assert.equal(removeMusicSentences("声音：只有房间底噪，无配乐。"), "声音：只有房间底噪。");
assert.equal(removeMusicSentences("Room tone. A soft soundtrack swells."), "Room tone.");
console.log("shot card fixes: ok");
