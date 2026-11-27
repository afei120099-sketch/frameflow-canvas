import assert from "node:assert/strict";
import { breakdownShotPrompt, classifyClause, splitClauses, storyTimeline, cameraTimeline, nameSubjects } from "../lib/shot-card-breakdown.ts";

// The user's own label style (李四 / 张三 coffee shot).
const zh = `参考说明（编号与提交顺序一致）：<Picture 1>是李四，低挽发髻、黑色西装外套配白衬衫；<Picture 2>是张三，深灰色西装；<Picture 3>是场景图。
写实真人电影质感，Kodak Vision3 250D 胶片颗粒，真实皮肤毛孔与细小绒毛。靠窗工位，李四坐着看一叠用黑色长尾夹夹好的A4打印稿。桌上黑色印白色Z字母的马克杯必须清晰可见。
主要动作：一只男人的手把一杯纸杯美式放在桌角，李四抬头。
0-2秒：特写，张三的手放下美式，衬衫袖口挽到小臂。
2-6秒：低角度近景，从李四视线往上看：张三站在桌边，背后窗外灰白天光，脸处在半逆光里，表情看不清。最终状态：张三站在画面中央俯视桌面，李四仰头看他。
声音：键盘声、空调声。
无任何对白、无人说话、无旁白，只有环境声。
画面要求：竖屏9:16，主体保持在画面中央，一个主要动作完成后停在最终状态。`;

const b = breakdownShotPrompt(zh);
assert.equal(b.unstructured, false);
assert.deepEqual(b.summary, ["一只男人的手把一杯纸杯美式放在桌角", "李四抬头"]);
assert.equal(b.beats.length, 2);
assert.equal(b.beats[0].range, "0–2秒");
assert.deepEqual(b.beats[0].camera, ["特写"]);
assert.deepEqual(b.beats[0].story, ["张三的手放下美式", "衬衫袖口挽到小臂"]);
assert.deepEqual(b.beats[1].camera, ["低角度近景", "从李四视线往上看"]);
assert.ok(b.beats[1].story.includes("张三站在桌边"));
assert.ok(b.beats[1].story.some((s) => s.startsWith("最终：") && s.includes("张三站在画面中央")));
assert.ok(b.beats[1].look.includes("背后窗外灰白天光"));
assert.ok(b.beats[1].look.includes("脸处在半逆光里"));
// Story box never carries camera / light / sound.
for (const line of [...b.summary, ...storyTimeline(b).map((x) => x.story)]) assert.ok(!/特写|近景|低角度|天光|逆光|键盘声/.test(line), line);
assert.deepEqual(cameraTimeline(b).map((x) => x.camera), ["特写", "低角度近景 · 从李四视线往上看"]);
assert.deepEqual(b.sound, ["键盘声、空调声", "无任何对白、无人说话、无旁白，只有环境声"]);
assert.ok(b.reference.startsWith("<Picture 1>是李四"));
assert.ok(b.requirements.startsWith("竖屏9:16"));
assert.ok(b.look.some((s) => s.includes("Kodak")));

// Dialogue line keeps each speaker apart.
const talk = breakdownShotPrompt(`主要动作：小刘把纸箱放上桌。\n0-5秒：中景，小刘拍拍椅背，得意地说话。\n5-9秒：李四淡淡点头说谢谢。\n对白（中文普通话，口型同步）：小刘（得意）：“这个！一看就没人坐。”李四（淡）：“谢谢。”`);
assert.deepEqual(talk.dialogue, ["小刘（得意）：“这个！一看就没人坐。”", "李四（淡）：“谢谢。”"]);
assert.deepEqual(talk.beats[0].camera, ["中景"]);
assert.deepEqual(talk.beats[1].camera, []);
assert.deepEqual(talk.beats[1].story, ["李四淡淡点头说谢谢"]);

// English queue style.
const en = breakdownShotPrompt("<Picture 1> is the first frame. A man sits at his desk by the window, soft afternoon light. Static camera. [0s-3s] He slowly lowers the document. [3s-6s] Slow push-in, he looks up toward the door. Sound: quiet office room tone.");
assert.equal(en.beats.length, 2);
assert.deepEqual(en.beats[0].story, ["He slowly lowers the document"]);
assert.deepEqual(en.beats[1].camera, ["Slow push-in"]);
assert.ok(en.camera.includes("Static camera"));

// 范本 six-part format (kb.md 提示词/范本): 00:00-03:00 is seconds, not minutes; lip-sync boilerplate is not story.
const six = breakdownShotPrompt(`subject_definitions: <Subject 1>: Zhang San, dark suit. <Picture 1> is the office.
summary: [reference generation, one continuous take] From under the desk edge, Subject 1 looks up at Subject 2 on frame right.
retention_analysis: <Picture 1> partially preserved.
detailed_description: Photoreal live-action vertical 9:16 drama, Kodak Vision3 250D film grain [style v2]. The desk lamp sits on the right corner. Medium close-up, 35mm equivalent, focus to both faces. Low angle from under the desk edge, camera locked. Already in motion at 00:00: Subject 1 is frame left, seated in the chair. 00:00-03:00 Subject 1 looks up at Subject 2, jaw slightly tight. Subject 2 blinks once, stays silent, lips closed. 03:00-08:00 Subject 1 speaks, face three-quarter to camera, lips moving continuously to the end of the sentence, while Subject 2's lips stay pressed together and still. After the last word, the shot ends during this quiet beat. One continuous take, no cuts.
overall_soundscape: Only a very light room tone. Subject 1's voice is low and close.
non_diegetic_music: N/A`);
assert.deepEqual(six.summary, ["Subject 1 looks up at Subject 2 on frame right"]);
assert.ok(six.camera.includes("From under the desk edge") && six.camera.includes("camera locked") && six.camera.includes("Medium close-up"));
assert.deepEqual(six.beats.map((x) => x.range), ["开始", "0–3秒", "3–8秒"]);
assert.deepEqual(six.beats[0].story, ["Subject 1 is frame left, seated in the chair"]);
assert.deepEqual(six.beats[1].story, ["Subject 1 looks up at Subject 2, jaw slightly tight", "Subject 2 blinks once"]);
assert.deepEqual(six.beats[2].story, ["Subject 1 speaks"]);
assert.ok(six.beats[2].lip.length >= 2);
assert.ok(six.look.includes("Photoreal live-action vertical 9:16 drama"));
assert.ok(six.look.some((s) => s.includes("desk lamp")));
assert.ok(six.requirements.startsWith("After the last word"));
assert.ok(six.sound.includes("音乐：N/A"));
assert.ok(six.reference.includes("Zhang San"));
assert.equal(nameSubjects("Subject 1 looks up at <Subject 2>", ["张三", "李四"]), "张三 looks up at 李四");

// Chinese six-part (EP02 办公室场 v4 L03): positions → 开始; bare 仰 → camera; trailing line → end of last segment.
const zh6 = breakdownShotPrompt(`参考说明（编号与提交顺序一致）：<Picture 1>是窗侧场景图。
写实真人电影质感，Kodak Vision3 250D 胶片颗粒。
张三在画左，四分之三侧脸，坐在椅子上。李四在画右，人留在桌子靠门的一侧。玻璃门在画中后景，关着。 仰，镜头在桌沿下，中近景，机位固定。
主要动作：桌沿下仰看，张三抬眼看向画右的李四。
0-3秒：张三抬眼，看向画右的李四，下颌轻绷。李四看向他，眨一下眼，嘴唇闭着，不出声。
3-8秒：张三开口，四分之三侧脸，嘴唇一直动到这句说完。他说话时，李四嘴唇一直闭着不动。
13-14秒：她看向他，脚留在画右，嘴唇闭着。
她这句已经说完，人留在画右，眼睛还看着他。
最后一个字说完后留一拍，镜头停在还在做的动作上。
声音：只有很轻的房间底噪。`);
const open6 = zh6.beats.find((x) => x.range === "开始");
assert.deepEqual(open6.story, ["张三在画左", "四分之三侧脸", "坐在椅子上", "李四在画右", "人留在桌子靠门的一侧"]);
assert.ok(zh6.look.includes("玻璃门在画中后景"));
assert.ok(zh6.camera.includes("仰") && zh6.camera.includes("机位固定"));
assert.deepEqual(zh6.beats.find((x) => x.range === "3–8秒").story, ["张三开口", "四分之三侧脸"]);
assert.ok(zh6.beats.find((x) => x.range === "3–8秒").lip.includes("他说话时，李四嘴唇一直闭着不动"));
assert.ok(zh6.beats.find((x) => x.range === "13–14秒").story.includes("最终：她这句已经说完"));
assert.ok(zh6.requirements.startsWith("最后一个字说完"));

// No labels at all → unstructured, nothing lost.
const plain = breakdownShotPrompt("一个女人站在窗前。");
assert.equal(plain.unstructured, true);

// Gaze is action, not lighting; user overrides win.
assert.equal(classifyClause("她的目光落在文件上"), "story");
assert.equal(classifyClause("他看向镜头"), "story");
assert.equal(classifyClause("张三站在逆光里递咖啡"), "look");
assert.equal(classifyClause("张三站在逆光里递咖啡", { "张三站在逆光里递咖啡": "story" }), "story");

// Quotes and decimals are not split.
assert.deepEqual(splitClauses("他说：“好，走吧。”然后离开"), ["他说", "“好，走吧。”然后离开"]);
assert.deepEqual(splitClauses("[0.5s] holds 0.5 seconds"), ["[0.5s] holds 0.5 seconds"]);

// review fixes: actions that mention camera / lamp words stay in the story
assert.equal(classifyClause("她转身背对镜头走开"), "story");
assert.equal(classifyClause("She tilts her head"), "story");
assert.equal(classifyClause("她把灯关掉"), "story");
assert.equal(classifyClause("Slow tilt up to the window"), "camera");
assert.equal(classifyClause("台灯在画右桌角"), "look");
console.log("shot card breakdown: ok");
