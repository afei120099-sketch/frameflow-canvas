// 第 14 条：原生确认框（window.confirm / alert / prompt）换成页面内对话框。
// 原生框弹着时整页暂停（收件箱心跳也停）。这里测：确认后才执行、取消/Esc 不执行、
// 同一时间只有一个问题（连点不会弹两个、不会执行两次），以及源码里不再有原生框。
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createDialogQueue } from "../lib/in-page-dialog-queue.ts";

// 1. 只有「确认」才 resolve true
{
  const q = createDialogQueue(); const seen = [];
  q.subscribe((d) => seen.push(d ? d.message : null));
  const p = q.ask({ message: "删掉？" });
  assert.equal(q.current()?.message, "删掉？");
  q.current().answer(true);
  assert.equal(await p, true);
  assert.equal(q.current(), null);
  assert.deepEqual(seen, ["删掉？", null]);
}
// 2. 取消 → false；答过之后再点按钮不会改答案
{
  const q = createDialogQueue();
  const p = q.ask({ message: "x" }); const open = q.current();
  open.answer(false); open.answer(true);
  assert.equal(await p, false);
}
// 3. 已有问题开着时，第二个请求立刻得到 false（连点两次只问一次、最多执行一次）
{
  const q = createDialogQueue(); let ran = 0;
  const click = async () => { if (await q.ask({ message: "提交？" })) ran++; };
  const a = click(), b = click();
  await b; assert.equal(ran, 0, "第二次点击不执行");
  q.current().answer(true); await a;
  assert.equal(ran, 1, "只执行一次");
  // 关掉以后可以再问
  const c = click(); q.current().answer(true); await c; assert.equal(ran, 2);
}
// 4. 页面卸载：还在等的问题按「取消」处理
{
  const q = createDialogQueue();
  const p = q.ask({ message: "y" }); q.cancelAll();
  assert.equal(await p, false); assert.equal(q.current(), null);
}

// 5. 源码：画布页面代码里不再调用原生确认框
const root = path.resolve(import.meta.dirname, "..");
const files = [];
const walk = (dir) => { for (const name of readdirSync(dir)) { const full = path.join(dir, name); if (statSync(full).isDirectory()) walk(full); else if (/\.(tsx?|jsx?)$/.test(name)) files.push(full); } };
for (const dir of ["app", "components", "lib", "hooks"]) walk(path.join(root, dir));
const offenders = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "").replace(/^\s*\*.*$/, "");
    if (/\bwindow\.(confirm|alert|prompt)\s*\(|(^|[^\w.])(confirm|alert)\s*\(\s*['"`]/.test(code)) offenders.push(`${path.relative(root, file)}:${i + 1}`);
  });
}
assert.deepEqual(offenders, [], "还有原生确认框：" + offenders.join(", "));

// 6. 改过的地方都用共用对话框；卡片里等回答后会重新看锁（页面不再暂停，回答期间可能开始提交）
const src = (rel) => readFileSync(path.join(root, rel), "utf8");
for (const rel of ["app/canvas-workspace.tsx", "components/shot-card-board.tsx", "components/shot-queue-panel.tsx", "components/canvas/canvas-rough-cut.tsx", "components/canvas/canvas-tools.tsx", "components/canvas/cover-node.tsx", "components/director-stage/director-stage-panel.tsx", "components/h3-preset-bar.tsx", "components/role-library.tsx"])
  assert.match(src(rel), /import \{ askConfirm \} from "@\/components\/in-page-dialog";/, rel);
const card = src("components/shot-card-board.tsx");
// 2026-11-11 去掉了关键帧 / 接尾帧的「Picture 编号整体 +1 / -1」三处确认（正本：首帧不占编号，提交时画布自己挪）。
assert.equal((card.match(/await askConfirm|askConfirm\(\{/g) ?? []).length >= 5, true, "卡片里的确认");
assert.doesNotMatch(card, /整体 \+1|整体 -1|shiftPictureTags/, "不再让用户手动挪 Picture 编号");
assert.match(card, /if \(lockNow\.current\) return lockNow\.current;\n\s*return saveShot\(card, next\);/, "通过关键帧：保存前再看锁");
assert.match(card, /next\.firstFrameFrom = \{ shot: card\.shot\.title, frame: "last" \};\n\s*if \(lockNow\.current\) return lockNow\.current;/, "接尾帧：保存前再看锁");
assert.match(card, /if \(lockedNow\.current\) return lockedNow\.current; const problem = onLoad\(text\);/, "换队列：回答后再看锁");
assert.match(src("components/shot-queue-panel.tsx"), /await askConfirm\('用格式示例替换当前镜头表文本？[^']*'\)\) return; if \(cardBusy\.current\)/, "填入示例：回答后再看是否在提交");
const dialog = src("components/in-page-dialog.tsx");
assert.match(dialog, /if \(typeof window !== "undefined"\) window\.addEventListener\("keydown"/, "按键拦截在模块加载时注册，先于各面板");
assert.match(dialog, /event\.key === "Escape"\) \{ event\.preventDefault\(\); open\.answer\(false\)/, "Esc = 取消");
assert.match(dialog, /\(dialog\.noticeOnly \? ok\.current : cancel\.current\)\?\.focus\(\)/, "默认焦点在「取消」，回车不会误确认");

console.log("in-page dialog: confirm-only-on-yes, one question at a time, no native confirm/alert/prompt left in the canvas code; ok");
