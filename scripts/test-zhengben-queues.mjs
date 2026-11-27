// 拿正本（%FRAMEFLOW_H3_TOOLS%\SKILL_h3-video.md v2026-11-09.6）的写法和 h3工具 下的现成队列测卡片检查与提交正文。
// h3工具 下的文件只读；机器上没有这些文件时只跑仓库里的范例。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { compileQueueShotPictures } from "../lib/queue-picture-order.ts";
import { shotCardChecks } from "../lib/shot-card-report.ts";
import { parseShotQueue } from "../lib/shot-queue.ts";
import { dialogueFieldToRow } from "../lib/shot-card-fixes.ts";
import { isOfficialFormat } from "../lib/official-format.ts";
import { shotGate } from "../lib/shot-gate.ts";
import { h3qFix, parseH3qOutput } from "../lib/h3q-report.ts";
import { runH3qCheck } from "./zhengben-helper.mjs";

const H3 = process.env.FRAMEFLOW_H3_TOOLS || "h3-tools";
/** Every roleId / scene id gets a fake role or image, so pictures and checks run without the canvas database. */
function world(queue, names = {}) {
  const shots = queue.chapters.flatMap((chapter) => chapter.shots);
  const roleIds = [...new Set(shots.flatMap((shot) => shot.roleIds))];
  const sceneIds = [...new Set(shots.flatMap((shot) => shot.sceneAssetIds))];
  const roles = roleIds.map((roleId) => ({ roleId, displayName: names[roleId] ?? roleId, description: "", appearanceAssetIds: [`${roleId}-look`], voiceAssetIds: [`${roleId}-voice`], primaryAppearanceAssetId: `${roleId}-look`, primaryVoiceAssetId: `${roleId}-voice` }));
  const assets = new Map([
    ...sceneIds.map((id) => [id, { assetId: id, kind: "image", storageReference: `image:${id}`, filename: `${id}.png` }]),
    ...roleIds.flatMap((id) => [[`${id}-look`, { assetId: `${id}-look`, kind: "image", storageReference: `image:${id}-look`, filename: `${names[id] ?? id}.png` }], [`${id}-voice`, { assetId: `${id}-voice`, kind: "audio", storageReference: `audio:${id}-voice`, filename: `${names[id] ?? id}.wav` }]]),
  ]);
  return { roles, assets };
}
/** The prompt the queue path submits (frames left out: they only renumber Picture labels). */
function submitted(shot, queue, w, noBackgroundMusic) {
  const plain = { ...shot }; delete plain.firstFrameFrom; delete plain.lastFrameFrom; delete plain.firstFrameAssetId; delete plain.lastFrameAssetId;
  const roles = w.roles.filter((role) => shot.roleIds.includes(role.roleId));
  const scenes = shot.sceneAssetIds.map((id) => ({ assetId: id, src: `image:${id}`, name: `${id}.png` }));
  const roleAssets = Object.fromEntries([...w.assets.values()].map((asset) => [asset.assetId, asset]));
  return compileQueueShotPictures({ shot: plain, scenes, roles, assets: w.assets, roleAssets, includeRoleVoices: true, noBackgroundMusic }).prepared.compiled.prompt;
}
// Positive sentences the canvas may add: per-segment 「这段听到的」 (禁背景乐 / 只要环境声), the closing audible-audio
// sentence (禁背景乐) and the 只要环境声 「声音要求」 line. Nothing else.
const strip = (text) => text.replace(/(?:这段听到的：[^。]*。| ?Heard in this segment: [^.]*\.)/g, "").replace(/\n\n声音要求：可听到的只有与画面同步的房间底噪和动作声。$/, "").replace(/\n\nAudible audio is [^\n]*$/, "");
// 写法规则（dialogue 留空、开口、人名、点名配乐）只认正本 h3q：卡片直接调用它（lib/h3q-report.ts）。
// 机器上有 python 和 h3q.py 时，用真的 h3q 跑；没有就跳过这几段（卡片会明说「没跑成」，不当作通过）。
const HAS_H3Q = existsSync(`${H3}/h3q.py`);
async function h3qReport(queue) {
  const result = await runH3qCheck({ queue });
  if (!result.ok) { assert.ok(!/结果/.test(result.error), result.error); return null; }
  const report = parseH3qOutput(result.output, queue.chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.title)));
  assert.ok(report, "h3q 输出能解析");
  return report;
}
// 正本 v2026-11-13.1（h3工具 f053768）起旧格式每镜多一条 [旧格式] ERROR（停用提示，卡片照拦，见 test:official-format）。
// 这里的范例都是旧格式，测的是旧格式其余规则：把这一条单独拿出来，其余照旧比。
const RETIRED = (message) => message.includes("[旧格式]");
const h3qErrors = (report, i) => report.shots[i].filter((item) => item.level === "ERROR" && !RETIRED(item.message)).map((item) => item.message);

// ── 1. 正本「第一集写法」范例（2026-11-12 按正本 v2026-11-12.1 [开场空白] 改成第一句从 0 秒开始；EP02 L03 测试 B 按 v2026-11-09.6 改：人名只在参考说明和对白行，不写开口 / 嘴唇闭着 / 背景音乐） ──
// 正本 v2026-11-11.8 起 ID 字段只能填 ID（h3q [ID] ERROR）：范例用格式正确的假 ID（8-4-4-4-12），名字靠 world() 的 names 对上。
const ZY = "00000000-0000-4000-8000-0000000000a1", LW = "00000000-0000-4000-8000-0000000000a2", OFFICE = "00000000-0000-4000-8000-0000000000b1";
const NAMES = { [ZY]: "张三", [LW]: "李四" };
const L03 = {
  title: "EP02-L03｜抬头等她过来", roleIds: [ZY, LW], sceneAssetIds: [OFFICE], seconds: 14, aspect: "9:16", soundMode: "av", generationMode: "auto", dialogue: [],
  prompt: [
    "参考说明（编号与提交顺序一致）：<Picture 1>是窗侧场景图，只用于这间办公室的桌、椅、玻璃门和窗，光线按正文；<Picture 2>是张三，只用于张三的脸、发型和服装；<Picture 3>是李四，只用于李四的脸、发型和服装。",
    "写实真人电影质感，Kodak Vision3 250D 胶片颗粒，真实皮肤毛孔与细小绒毛，布料褶皱与纤维清晰，生活感真实。他在画左，四分之三侧脸，坐在椅子上；她在画右，站在桌子靠门的一侧。玻璃门在画中后景，关着。机位在桌沿下，仰拍，中近景，35mm 等效，景深到两个人的脸，后景轻微虚化，机位固定。",
    "夜里的办公室灯火通明：天花板的筒灯开着，台灯在画右桌角，暖黄色的光照在张三和李四的脸上和桌面的稿纸上。",
    "主要动作：桌沿下仰看，他抬眼看向画右的她，她先听他说完再说话。",
    "0-5秒：他抬眼看向画右的她，说话，四分之三侧脸，右手食指点在稿纸的圈注上。她看向他，眨一下眼。",
    "5-10秒：她说话，四分之三侧脸，左手按住桌沿。",
    "10-13秒：她看向他，脚留在画右，右手把一缕头发别到耳后。",
    "13-13.6秒：他的右手停在稿纸上，看着她。",
    "声音：很轻的房间底噪，手碰到纸时有纸页轻响。",
    "对白（中文普通话，口型同步）：张三：“这张表算错了。过来，我指给你看。” 李四：“等等啊。我这一页还没改完呢，你先坐。”",
    "画面要求：竖屏9:16，一条镜头拍完，中间不切换；人物脸型、发型与参考图严格一致，手指数量正常、手部不变形，口型与台词同步；画面中除场景本身的文件、屏幕文字外，没有字幕、水印或文字叠加；保持真实质感，皮肤不过度磨皮，没有卡通或CG塑料感，前景没有额外人物闯入，画面稳定不闪烁。参考图里已有的标志、招牌、商标保持原样。",
  ].join("\n"),
};
const sample = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "正本范例", defaults: { noBackgroundMusic: true }, chapters: [{ title: "一", shots: [L03] }] }));
const sampleWorld = world(sample, NAMES);
const sampleShot = sample.chapters[0].shots[0];
const sampleChecks = shotCardChecks(sampleShot, sample, sampleWorld.roles, sampleWorld.assets);
assert.deepEqual(sampleChecks.filter((c) => c.level === "error"), [], JSON.stringify(sampleChecks));
assert.deepEqual(sampleChecks.map((c) => c.code), [], "按正本写的镜头：不红也不黄");
if (HAS_H3Q) {
  const report = await h3qReport(sample);
  // 用户 2026-11-13 定「旧格式不用了」：正本 v2026-11-13.1 起这一镜（旧格式）被 [旧格式] 拦住，卡片按「旧格式」一组拦；合格范例改看 test:official-format 的官方范本。
  if (report && report.shots[0].some((item) => RETIRED(item.message))) assert.deepEqual(shotGate(sampleShot, [], report.shots[0]).map((item) => item.id), ["legacy_format"], "旧格式会被拦");
  if (report) { assert.deepEqual(h3qErrors(report, 0), [], "正本范例 h3q 除了 [旧格式] 不报 ERROR"); assert.equal(report.counts.ERROR, report.shots[0].filter((item) => item.level === "ERROR" && RETIRED(item.message)).length); }
}
export const SAMPLE_PLAIN = submitted(sampleShot, sample, sampleWorld, false);
export const SAMPLE_BGM = submitted(sampleShot, sample, sampleWorld, true);
assert.equal(SAMPLE_PLAIN, L03.prompt, "没勾禁背景乐：提交的正文和原文逐字一致");
assert.equal(strip(SAMPLE_BGM), L03.prompt, "勾了禁背景乐：只多「这段听到的」和结尾那句");
assert.equal(SAMPLE_BGM.split("这段听到的：").length - 1, 4);
assert.match(SAMPLE_BGM, /0-5秒：他抬眼看向画右的她，说话，[^\n]*。这段听到的：房间底噪、这段的对白和动作的声响。/);
assert.match(SAMPLE_BGM, /10-13秒：[^\n]*。这段听到的：房间底噪和这段动作的声响。/);
for (const sentence of SAMPLE_BGM.match(/这段听到的：[^。]*。/g)) assert.doesNotMatch(sentence, /张三|李四|开口|台词/);
assert.doesNotMatch(SAMPLE_BGM, /Role appearance|voice-timbre|Spoken dialogue|numbered|lips closed|\(张三|\(李四|background music/i);

// ── 2. 正本前的旧写法（L03 测试 B 原文）：卡片报红，和 h3q check 一样 ──
const oldB = `${H3}/../收件箱/示例项目_EP02_L03_B/示例项目_EP02_L03_B_queue.json`;
if (existsSync(oldB)) {
  const q = parseShotQueue(readFileSync(oldB, "utf8"));
  const w = world(q, { "99e67465-7b1e-494b-befa-53a85534a365": "张三", "c68aa343-fccb-4877-a776-2fc30bef7df0": "李四" });
  const codes = shotCardChecks(q.chapters[0].shots[0], q, w.roles, w.assets).map((c) => c.code);
  for (const code of ["mouth_words", "name_misplaced", "music_named"]) assert.ok(!codes.includes(code), `画布不再自己查 ${code}，交给 h3q`);
  const report = HAS_H3Q ? await h3qReport(q) : null;
  // 正本 v2026-11-13.1 起旧格式只报 [旧格式]（停用），不再细查旧写法；之前的版本报下面三条。
  const retiredOnly = report && !h3qErrors(report, 0).length && report.shots[0].some((item) => item.level === "ERROR" && RETIRED(item.message));
  if (report && !retiredOnly) {
    const red = h3qErrors(report, 0).join("\n");
    for (const re of [/开口 \/ 不出声 \/ 嘴唇闭着/, /人名 .* 出现在参考说明/, /点了背景音乐或配乐/]) assert.match(red, re);
    assert.ok(h3qErrors(report, 0).some((message) => h3qFix(message) === "music_named"), "点名配乐有一键删掉");
  }
}

// ── 3. h3工具 下的现成队列（有就查）：dialogue 为空的不报红，提交正文逐字一致；dialogue 非空 → 红 + 一键搬进正文 ──
const ep01 = ["EP01_queue_a.json", "EP01_queue_b.json", "EP01_queue_c.json"].map((name) => `${H3}/${name}`).filter(existsSync);
let checked = 0;
for (const file of ep01) {
  const q = parseShotQueue(readFileSync(file, "utf8"));
  const w = world(q);
  const report = HAS_H3Q ? await h3qReport(q) : null;
  for (const [i, shot] of q.chapters.flatMap((chapter) => chapter.shots).entries()) {
    const red = report ? h3qErrors(report, i).map(h3qFix).filter(Boolean) : [];
    // 这几份是六段式写的：2026-11-13 起和正本 h3q 一样按官方格式认（lib/official-format.ts）。
    const official = isOfficialFormat(shot.prompt);
    if (shot.dialogue?.length) {
      const moved = dialogueFieldToRow(shot, (id) => id);
      if (official) {
        // 官方格式：h3q 报 [官方·台词]（dialogue 留空、台词写进 <d>），卡片不替它改写成中文对白行。
        if (report) assert.ok(h3qErrors(report, i).some((message) => message.includes("[官方·台词]")), `${shot.title}: ${JSON.stringify(h3qErrors(report, i))}`);
        assert.ok("error" in moved, shot.title);
        continue;
      }
      if (report) assert.deepEqual(red, ["dialogue_field"], `${shot.title}: ${JSON.stringify(h3qErrors(report, i))}`);
      assert.ok("shot" in moved && !moved.shot.dialogue && /对白（中文普通话，口型同步）：/.test(moved.shot.prompt), shot.title);
      continue;
    }
    if (official) {
      // 官方格式：禁背景乐、只要环境声都原样提交，一个字不加。
      for (const nbm of [false, true]) assert.equal(submitted(shot, q, w, nbm), shot.prompt.trim(), `${shot.title}: 官方格式原样提交`);
      checked++;
      continue;
    }
    assert.deepEqual(red, [], `${shot.title}: ${JSON.stringify(red)}`);
    if (shot.soundMode === "av") assert.equal(submitted(shot, q, w, false), shot.prompt.trim(), `${shot.title}: 原样提交`);
    else assert.equal(strip(submitted(shot, q, w, false)), shot.prompt.trim(), `${shot.title}: 只要环境声只加正向句`);
    assert.equal(strip(submitted(shot, q, w, true)), shot.prompt.trim(), `${shot.title}: 禁背景乐只加正向句`);
    checked++;
  }
}

// ── 4. EP02 v3（反例）：点名背景音乐 → 红 ──
const ep02 = `${H3}/EP02_queue.json`;
if (existsSync(ep02)) {
  const q = parseShotQueue(readFileSync(ep02, "utf8"));
  const w = world(q);
  void w;
  const report = HAS_H3Q ? await h3qReport(q) : null;
  // EP02 v3 是六段式写的：2026-11-13 起 h3q 按官方格式查，No background music 报 [官方·禁止句]（WARN）；之前的版本报点名配乐（ERROR）。
  if (report) assert.ok(report.shots.some((items) => items.some((item) => (item.level === "ERROR" && h3qFix(item.message) === "music_named") || item.message.includes("[官方·禁止句]"))), "EP02 v3 写了 No background music：h3q 报出来");
}
// ── 5. 首帧不占 Picture 编号（正本第 63 行）：接尾帧 / 首帧镜头照样从场景、角色编 1 号，卡片不报红；提交时画布自己往后挪一位 ──
{
  const chained = { ...L03, title: "EP02-L03b｜接上一镜", generationMode: "first-last", firstFrameFrom: { shot: L03.title, frame: "last" } };
  const q = parseShotQueue(JSON.stringify({ version: "shot-queue-v1", title: "接帧", defaults: { noBackgroundMusic: true }, chapters: [{ title: "一", shots: [L03, chained] }] }));
  const w = world(q, NAMES);
  const shot = q.chapters[0].shots[1];
  const codes = shotCardChecks(shot, q, w.roles, w.assets).map((c) => c.code);
  assert.ok(!codes.includes("picture_order") && !codes.includes("picture_count"), codes.join());
  // 写错（按「首帧占 1 号」写）才报红
  const shifted = { ...shot, prompt: shot.prompt.replace(/<Picture (\d)>/g, (_, n) => `<Picture ${Number(n) + 1}>`) };
  assert.ok(shotCardChecks(shifted, q, w.roles, w.assets).some((c) => c.code === "picture_order" || c.code === "picture_count"));
  // 提交：首帧占 1 号，原文的 <Picture 1>（场景）变成 <Picture 2>
  const roles = w.roles; const scenes = shot.sceneAssetIds.map((id) => ({ assetId: id, src: `image:${id}`, name: `${id}.png` }));
  const roleAssets = Object.fromEntries([...w.assets.values()].map((asset) => [asset.assetId, asset]));
  const { prepared, pictures } = compileQueueShotPictures({ shot, scenes, roles, assets: w.assets, roleAssets, includeRoleVoices: true, noBackgroundMusic: false });
  assert.match(pictures[0].name, /^首帧 /);
  assert.match(prepared.compiled.prompt, /<Picture 2>是窗侧场景图[^\n]*<Picture 3>是张三[^\n]*<Picture 4>是李四/);
}

// ── 6. 可选：一份按正本写好的整份真实队列（FRAMEFLOW_TEST_QUEUE，h3q 0 错 0 警）：卡片 0 红，和 h3q 一致 ──
const v5 = process.env.FRAMEFLOW_TEST_QUEUE || "";
let v5Shots = 0;
if (v5 && existsSync(v5)) {
  const q = parseShotQueue(readFileSync(v5, "utf8"));
  const w = world(q);
  for (const shot of q.chapters.flatMap((chapter) => chapter.shots)) {
    // [开场空白] 是硬规则，按 test:opening-gap 单独核对；其余应 0 红。
    const red = shotCardChecks(shot, q, w.roles, w.assets).filter((c) => c.level === "error" && c.code !== "gate:opening_gap");
    assert.deepEqual(red, [], `${shot.title}: ${JSON.stringify(red)}`);
    v5Shots++;
  }
  const h3q = spawnSync("python", ["-I", `${H3}/h3q.py`, "check", v5], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  if (h3q.status !== null && /结果: ERROR (\d+)/.test(h3q.stdout ?? "")) assert.equal((h3q.stdout.match(/^ERROR\s+(?!.*\[(?:开场空白|旧格式)\]).*$/gm) ?? []).length, 0, "h3q 除开场空白 / 旧格式（正本 v2026-11-13.1 起每镜一条）外也是 0 个 ERROR");
}
console.log(`正本 queues: 范例原样提交、不报红；旧写法报红；现成队列 ${checked} 镜原样提交${existsSync(ep02) ? "；EP02 反例报红" : ""}；首帧不占编号${v5Shots ? `；测试队列 ${v5Shots} 镜 0 红（和 h3q 一致）` : ""}; ok`);
