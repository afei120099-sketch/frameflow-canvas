// 镜头卡片参考图 / ID 错误说人话：格子里写原因 + 「JSON 的问题 / 画布的问题」，复制给 AI 的文字带改法，能从「<Picture N>是X」推出角色名。
// 实例：某镜 roleIds 第 2 项写成了一句描述（重现这种写错的情况）。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { referenceProblems, referenceCellText, pictureNames, rolePictureNumber, looksLikeId } from "../lib/shot-card-ref-help.ts";
import { aiFixText } from "../lib/shot-card-ai-copy.ts";
import { parseShotQueue, planShotReferences } from "../lib/shot-queue.ts";

const ROLE_A = "00000000-0000-4000-8000-00000000000b", ROLE_B = "00000000-0000-4000-8000-000000000019", OFFICE = "00000000-0000-4000-8000-00000000001a";
const SENTENCE = "他的头发长度和发型全镜不变，浅蓝条纹衬衫扣好，工牌挂在胸前。";
const EP03 = process.env.FRAMEFLOW_TEST_QUEUE || "";
// 第 3 张是王五；第 7 节可选地拿一份真实队列（FRAMEFLOW_TEST_QUEUE）的第 6 镜另查一遍。
const shot6 = { title: "S01｜示例镜头A", prompt: "参考说明（编号与提交顺序一致）：<Picture 1>是开放办公区工位场景图，只用于场景。<Picture 2>是李四，只用于李四的脸。<Picture 3>是王五，只用于王五的脸。\n0-4秒：王五抬头。", roleIds: [ROLE_A, SENTENCE], sceneAssetIds: [OFFICE], seconds: 8, aspect: "9:16", soundMode: "av" };

// ── 1. 基础 ──
assert.equal(looksLikeId(ROLE_A), true); assert.equal(looksLikeId(SENTENCE), false); assert.equal(looksLikeId("roleA"), false);
const names = pictureNames(shot6.prompt);
assert.equal(names.get(2), "李四"); assert.equal(names.get(3), "王五");
assert.equal(rolePictureNumber(shot6, 1), 3, "场景 1 张 + 前面 1 个出镜角色 → 第 3 张");
assert.equal(rolePictureNumber({ ...shot6, offscreenRoleIds: [shot6.roleIds[0]] }, 1), 2, "画外角色不占编号");

// ── 2. 角色库里没有王五（截图那种情况） ──
const image = { kind: "image" };
const assets = new Map([[OFFICE, image], ["app-roleB", image], ["app-role-b", image]]);
const onlyRoleA = [{ roleId: ROLE_A, displayName: "李四", primaryAppearanceAssetId: "app-roleB" }];
const problems = referenceProblems(shot6, onlyRoleA, assets);
assert.equal(problems.length, 1);
const [p] = problems;
assert.equal(p.owner, "json");
assert.equal(p.short, `roleIds 第 2 项不是角色 ID（写成了「${SENTENCE.slice(0, 24)}…」）：请填王五在角色库里的 ID，没有这个角色先去角色库建`);
assert.equal(p.fix, `roleIds 第 2 项不是角色 ID，而是一句描述「${SENTENCE}」。正文里 <Picture 3> 是王五：请填王五在角色库里的 ID；如果角色库里没有王五，请告诉用户先在画布角色库里新建王五、配好外观图，再把 ID 填进来。描述句不要放进 roleIds，放在正文里。`);
const cell = referenceCellText(problems, "角色不存在：" + SENTENCE);
assert.equal(cell.owner, "这是 JSON 的问题"); assert.equal(cell.more, 0);
// 和 planShotReferences 抛的原文对得上（格子鼠标停上去显示原文）
assert.throws(() => planShotReferences(shot6, onlyRoleA, assets), new RegExp(`角色不存在：${SENTENCE.slice(0, 8)}`));

// ── 3. 角色库里有王五：把 ID 直接写出来 ──
const both = [...onlyRoleA, { roleId: ROLE_B, displayName: "王五", primaryAppearanceAssetId: "app-role-b" }];
assert.match(referenceProblems(shot6, both, assets)[0].fix, new RegExp(`请填王五在角色库里的 ID（角色库里已经有王五，ID 是 ${ROLE_B}）`));
assert.deepEqual(referenceProblems({ ...shot6, roleIds: [ROLE_A, ROLE_B] }, both, assets), [], "填好以后没问题");

// ── 4. 画布的问题 ──
const missingRole = referenceProblems({ ...shot6, roleIds: [ROLE_A, "00000000-0000-4000-8000-000000000013"] }, onlyRoleA, assets)[0];
assert.equal(missingRole.owner, "canvas"); assert.match(missingRole.short, /角色 ID 不在这个画布的角色库里（roleIds 第 2 项，应是王五）/);
assert.equal(referenceCellText([missingRole], "x").owner, "这是画布的问题");
const noLook = referenceProblems({ ...shot6, roleIds: [ROLE_A] }, [{ roleId: ROLE_A, displayName: "李四", primaryAppearanceAssetId: null }], assets)[0];
assert.deepEqual([noLook.owner, noLook.short], ["canvas", "角色「李四」没有主外观"]);
const sceneGone = referenceProblems({ ...shot6, roleIds: [ROLE_A] }, onlyRoleA, new Map([["app-roleB", image]]))[0];
assert.deepEqual([sceneGone.owner, sceneGone.short], ["canvas", "素材 ID 不在这个画布里（sceneAssetIds 第 1 项）"]);
const sceneWord = referenceProblems({ ...shot6, roleIds: [ROLE_A], sceneAssetIds: ["office"] }, onlyRoleA, assets)[0];
assert.equal(sceneWord.owner, "json"); assert.match(sceneWord.fix, /sceneAssetIds 第 1 项不是素材 ID，而是「office」。正文里 <Picture 1> 是开放办公区工位场景图：请填这张场景图在画布素材库里的 Asset ID/);
assert.equal(referenceCellText([], ""), null);
assert.match(referenceCellText([], "时间锚点图不存在或不是图片：x").text, /^参考图排不出来：时间锚点图不存在/, "认不出的原文照写");

// ── 5. 复制给 AI 的文字 ──
const text = aiFixText({ queueTitle: "示例项目 EP03 v4", chapters: ["3"], scope: "这一镜", shots: [{ code: "6", title: shot6.title, chapter: "3", missing: [], h3q: [], canvas: [], gate: [], idFixes: problems.map(({ owner, fix }) => ({ owner, fix })) }] }).text;
assert.match(text, /ID 字段写错了（这是 JSON 的问题，必改：不改这一镜排不出参考图、不能渲染）：\n- roleIds 第 2 项不是角色 ID，而是一句描述「他的头发/);
assert.ok(text.includes("正文里 <Picture 3> 是王五：请填王五在角色库里的 ID；如果角色库里没有王五，请告诉用户先在画布角色库里新建王五、配好外观图，再把 ID 填进来。描述句不要放进 roleIds，放在正文里。"));
assert.match(text, /只改提示词正文（prompt）和下面明确写了「ID 字段写错了」的 roleIds \/ sceneAssetIds/, "要求里允许改 ID 字段");
const canvasText = aiFixText({ queueTitle: "q", chapters: [], scope: "这一镜", shots: [{ code: "1", title: "t", chapter: "", missing: [], h3q: [], canvas: [], gate: [], idFixes: [{ owner: "canvas", fix: noLook.fix }] }] }).text;
assert.match(canvasText, /画布里缺的（这是画布的问题：请告诉用户在画布里补/);

// ── 6. 卡片源码：格子写原因、鼠标停上去原文、每镜检查框文字按钮、顶栏「复制」带说明 ──
const board = readFileSync(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8");
assert.doesNotMatch(board, /"参考图排不出来"/, "不再只写「参考图排不出来」");
assert.match(board, /className="sc-ref-missing sc-ref-why" title=\{card\.refError \? `原文：\$\{card\.refError\}` : undefined\}>\{cellText\.text\}/);
assert.match(board, /\{cellText\.owner && <em>——\{cellText\.owner\}<\/em>\}/);
assert.match(board, /idFixes: card\.refProblems\.map\(\(problem\) => \(\{ owner: problem\.owner, fix: problem\.fix \}\)\),/, "所有复制都带 ID 改法");
assert.match(board, /className="sc-btn sc-checks-copy"[^>]*onClick=\{ctx\.copyForAi\}><ClipboardCopy aria-hidden="true" \/>复制给 AI 修改<\/button>/, "每镜检查框右上角文字按钮，只复制这一镜");
assert.match(board, /aria-label="复制写错的镜头给 AI 修改" title=\{`复制给 AI 修改：写错的 \$\{errorCards\.length\} 镜（/);
assert.match(board, /onClick=\{\(\) => copyForAi\("写错的镜头", errorCards\)\}><ClipboardCopy size=\{12\} \/>复制<\/button>/, "顶栏写错旁边是带字的「复制」");
assert.match(board, /onClick=\{\(\) => copyForAi\("漏写的镜头", warnCards\)\}><ClipboardCopy size=\{12\} \/>复制<\/button>/);
// ── 7. 本机有真实文件：第 6 镜把 roleIds 第 2 项换回一句描述，推出的名字 = 它现在正文里 <Picture 3> 写的人 ──
let live = "没有指定测试队列，跳过真实文件";
const realShot = EP03 && existsSync(EP03) ? parseShotQueue(readFileSync(EP03, "utf8")).chapters.flatMap((c) => c.shots)[5] : null;
if (realShot && realShot.roleIds.length > 0) {
  const real = realShot;
  const broken = { ...real, roleIds: [real.roleIds[0], SENTENCE, ...real.roleIds.slice(2)] };
  const n = rolePictureNumber(broken, 1), who = pictureNames(real.prompt).get(n);
  assert.ok(who, "正文里写了 <Picture N>是X");
  const fix = referenceProblems(broken, onlyRoleA, assets).find((item) => item.short.startsWith("roleIds 第 2 项"));
  assert.ok(fix.fix.includes(`正文里 <Picture ${n}> 是${who}：请填${who}在角色库里的 ID；如果角色库里没有${who}，请告诉用户先在画布角色库里新建${who}`));
  live = `真实文件第 6 镜 → ${who}`;
}
console.log(`shot card ref help: plain-language ID errors with owner, <Picture N> name inference (第 6 镜 → 王五；${live}), cell + AI copy + visible copy buttons; ok`);
