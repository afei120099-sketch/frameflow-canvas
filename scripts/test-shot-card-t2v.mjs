// 镜头卡片：没绑参考图 = 按文生视频出片（灰色，不是错误），参考图那一格写「文生视频 · 画面描述」；只有真排不出来才红。
// 实例：一镜「版本历史截图」（笔记本屏幕插入镜，roleIds / sceneAssetIds 都空）。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isTextToVideo, t2vDescription, T2V_NOTE, T2V_TITLE } from "../lib/shot-card-t2v.ts";
import { shotCompleteness } from "../lib/prompt-completeness.ts";
import { parseShotQueue, planShotReferences } from "../lib/shot-queue.ts";
import { referenceProblems, referenceCellText } from "../lib/shot-card-ref-help.ts";

const EP03 = process.env.FRAMEFLOW_TEST_QUEUE || "";
const INLINE = { title: "EP03-v4-3-5｜版本历史截图", roleIds: [], sceneAssetIds: [], seconds: 6, aspect: "9:16", soundMode: "av", prompt: [
  "参考说明（编号与提交顺序一致）：这一镜只拍屏幕和手，没有参考图。",
  "写实真人电影质感，Kodak Vision3 250D 胶片颗粒，真实皮肤毛孔与细小绒毛，布料褶皱与纤维清晰，生活感真实。开放办公区工位上，笔记本电脑放在桌上。笔记本电脑屏幕特写，平视，100mm 等效，浅景深，景深到屏幕上的字，机位固定，屏幕居中占满画面。前景是画面下沿的右手和鼠标，中景是高亮那一行，后景是列表的深色底。",
  "光线：屏幕自身发光，亮度适中，屏幕上的字清晰锐利。",
  "主要动作：版本历史停在那一行，她的右手食指点下截图。",
  "0-3秒：屏幕上高亮的一行写着恢复者赵六，周三 23:14。",
  "3-5.5秒：画面下沿的右手手指收紧，食指点一下鼠标，屏幕边缘闪一下白。",
  "声音：办公室底噪。鼠标按下，一声脆响。"].join("\n") };
// 内置样例；可选地用 FRAMEFLOW_TEST_QUEUE 指一份真实队列，第 5 镜若是文生视频镜，只要求它的场景、镜头、光线都能取到。
const shot5 = INLINE;
let live = "没有指定测试队列，跳过真实文件";
const realShot = EP03 && existsSync(EP03) ? parseShotQueue(readFileSync(EP03, "utf8")).chapters.flatMap((c) => c.shots)[4] : null;
if (realShot && isTextToVideo(realShot)) {
  const real = realShot;
  const realRows = t2vDescription(real, shotCompleteness(real, { visibleNames: [] }));
  for (const label of ["场景", "镜头", "光线"]) assert.ok(realRows.find((item) => item.label === label).lines.length, `真实文件第 5 镜取到${label}`);
  live = "真实文件第 5 镜：场景、镜头、光线都取到";
}
assert.match(shot5.title, /版本历史截图/);

// ── 1. 文生视频：灰色画面描述，取自完整度的证据 ──
assert.equal(isTextToVideo(shot5), true);
assert.deepEqual(planShotReferences(shot5, [], new Map()).pictures, [], "一张参考图都不交");
assert.deepEqual(referenceProblems(shot5, [], new Map()), [], "检查是通过的：不是错误");
assert.equal(referenceCellText([], ""), null, "没有原文、没有问题 → 不走红色那条");
const rows = t2vDescription(shot5, shotCompleteness(shot5, { visibleNames: [] }));
const row = (label) => rows.find((item) => item.label === label).lines.join(" ");
assert.deepEqual(rows.map((item) => item.label), ["风格", "场景", "镜头", "光线", "开场"]);
assert.match(row("风格"), /Kodak Vision3 250D 胶片颗粒/);
assert.match(row("场景"), /开放办公区工位上，笔记本电脑放在桌上/);
assert.match(row("镜头"), /笔记本电脑屏幕特写，平视，100mm 等效，浅景深/);
assert.match(row("光线"), /屏幕自身发光/);
assert.match(row("开场"), /^0-3秒：屏幕上高亮的一行/);
// 没写的类别：空，卡片显示灰色「没写」
const bare = { ...INLINE, prompt: "0-3秒：屏幕亮起。" };
const bareRows = t2vDescription(bare, shotCompleteness(bare, { visibleNames: [] }));
assert.deepEqual(bareRows.filter((item) => !item.lines.length).map((item) => item.label), ["风格", "场景", "镜头", "光线"]);
assert.equal(bareRows.at(-1).lines[0], "0-3秒：屏幕亮起。");
assert.deepEqual(t2vDescription(bare, undefined).slice(0, 4).map((item) => item.lines.length), [0, 0, 0, 0], "完整度还没算完：先都写没写");

// ── 2. 不是文生视频 ──
assert.equal(isTextToVideo({ ...INLINE, sceneAssetIds: ["f0e5b3fe-b5b2-44d5-81ca-a458d5b4310c"] }), false);
assert.equal(isTextToVideo({ ...INLINE, firstFrameFrom: { shot: "previous", frame: "last" } }), false);
assert.equal(isTextToVideo({ ...INLINE, roleIds: ["c68aa343-fccb-4877-a776-2fc30bef7df0"] }), false);
assert.equal(isTextToVideo({ ...INLINE, roleIds: ["c68aa343-fccb-4877-a776-2fc30bef7df0"], offscreenRoleIds: ["c68aa343-fccb-4877-a776-2fc30bef7df0"] }), true, "只有画外角色也不交图");
// 真排不出来：红色那条（参考图 / ID 说人话）
const broken = { ...INLINE, sceneAssetIds: ["办公室"] };
const brokenCell = referenceCellText(referenceProblems(broken, [], new Map()), "场景图不存在或不是图片：办公室");
assert.equal(brokenCell.owner, "这是 JSON 的问题");

// ── 3. 卡片源码 ──
const board = readFileSync(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8");
assert.doesNotMatch(board, />没有参考图</, "不再用红字写「没有参考图」");
assert.match(board, /return cellText \? <div className="sc-ref-missing sc-ref-why"[^]*?: <T2vBlock rows=\{t2vDescription\(shot, completeness\)\} open=\{t2vOpen\}/, "只有排不出来时红，否则灰色画面描述");
assert.match(board, /<b className="sc-t2v-head">文生视频 · 画面描述<\/b>/);
assert.match(board, /<span className="none">没写（文生视频更需要写清楚）<\/span>/);
assert.match(board, /<small className="sc-t2v-note">没绑参考图 · 按文生视频出片（\{T2V_NOTE\}）<\/small>/);
assert.match(board, /<div className=\{`sc-t2v \$\{clipped \? "clip" : ""\}`\} title=\{T2V_TITLE\}>/, "鼠标停上去解释");
assert.equal(T2V_NOTE, "🧪 文生视频还没真人验收；想和前后镜一致就绑场景图");
assert.match(T2V_TITLE, /没有参考图时，画面由文字决定，场景和角色的样子可能和其他镜头对不上；想跟前后镜一致，就在 sceneAssetIds 里绑上场景图/);
assert.match(board, /\.sc-t2v\.clip ul\{max-height:9em;overflow:hidden/, "最多约 6 行，超出折叠");
assert.match(board, />\{open \? "收起" : "展开全文"\}<\/button>/);
assert.doesNotMatch(board.slice(board.indexOf(".sc-t2v{"), board.indexOf(".sc-health-merged{")), /--stop|--bad|var\(--warn\)/, "灰色基调");
assert.match(board, /<ShotVideoViewer aside=\{\(key\) => \{[^}]*!card\.pictures\.length && !card\.refError && !card\.refProblems\.length \? <T2vBlock rows=\{t2vDescription\(card\.shot, completeness\.get\(card\.key\)\)\} full \/>/, "放大层直接显示全文");
const viewer = readFileSync(new URL("../components/shot-card-video-viewer.tsx", import.meta.url), "utf8");
assert.match(viewer, /const side = aside\?\.\(shot\.key\); return side \? <div className="scv-aside">\{side\}<\/div> : null;/);
console.log(`shot card T2V: gray 文生视频 · 画面描述 from completeness evidence (内置样例；${live}), 没写 categories, red only when references truly fail, full text in the viewer; ok`);
