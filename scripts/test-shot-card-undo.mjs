// 镜头卡片 Ctrl+Z / Ctrl+Y（用户 2026-11-11）：按键分流、文本框先撤自己的字、撤销提示文字、接到顶栏同一套历史、不漏到画布。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { undoKeyIntent, fieldOrCard, countFieldInput, describeQueueChange, shotCode } from "../lib/shot-card-undo.ts";

// ── 1. 按键 ──
const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
assert.equal(undoKeyIntent(key("z", { ctrlKey: true })), "undo");
assert.equal(undoKeyIntent(key("Z", { ctrlKey: true, shiftKey: true })), "redo");
assert.equal(undoKeyIntent(key("y", { ctrlKey: true })), "redo");
assert.equal(undoKeyIntent(key("z", { metaKey: true })), "undo", "Mac ⌘Z");
assert.equal(undoKeyIntent(key("z")), null);
assert.equal(undoKeyIntent(key("z", { ctrlKey: true, altKey: true })), null);
assert.equal(undoKeyIntent(key("c", { ctrlKey: true })), null);

// ── 2. 文本框：有字可撤先撤字，撤到底再走卡片；新出来的框（保存后）直接走卡片 ──
let field = { typed: 0, undone: 0 };
assert.equal(fieldOrCard("undo", field), "card", "没打过字的框：Ctrl+Z 撤卡片");
field = countFieldInput(field, "insertText"); field = countFieldInput(field, "insertText");
assert.equal(fieldOrCard("undo", field), "field");
field = countFieldInput(field, "historyUndo"); assert.equal(fieldOrCard("undo", field), "field");
assert.equal(fieldOrCard("redo", field), "field", "撤了一下，Ctrl+Y 先恢复框里的字");
field = countFieldInput(field, "historyUndo"); assert.equal(fieldOrCard("undo", field), "card", "撤到底了");
field = countFieldInput(field, "historyRedo"); field = countFieldInput(field, "historyRedo");
assert.equal(fieldOrCard("redo", field), "card");
field = countFieldInput(countFieldInput(field, "historyUndo"), "insertText");
assert.equal(field.undone, 0, "撤了以后又打字：恢复链断开，和编辑器一样");

// ── 3. 撤销提示 ──
assert.equal(shotCode("DEMO-std-L03｜示例镜头A"), "L03");
const shot = (title, extra = {}) => ({ title, prompt: `主要动作：${title}\n对白（中文普通话，口型同步）：张三：“好。”`, roleIds: ["a"], sceneAssetIds: ["s"], seconds: 10, aspect: "9:16", soundMode: "av", generationMode: "auto", dialogue: [], ...extra });
const q = (shots, extra = {}) => ({ version: "shot-queue-v1", title: "测试", defaults: { noBackgroundMusic: true }, chapters: [{ title: "一", shots }], ...extra });
const A = shot("EP-L01｜一"), B = shot("EP-L02｜二"), C = shot("EP-L03｜三");
assert.equal(describeQueueChange(q([A, B]), q([{ ...A, prompt: A.prompt.replace("主要动作", "主要动作：改了") }, B])), "L01 正文");
assert.equal(describeQueueChange(q([A, B]), q([{ ...A, prompt: A.prompt.replace("好。", "不好。") }, B])), "L01 台词");
assert.equal(describeQueueChange(q([A, B]), q([A, { ...B, seconds: 12 }])), "L02 参数");
assert.equal(describeQueueChange(q([A, B, C]), q([A, B])), "删了 L03");
assert.equal(describeQueueChange(q([A, B]), q([B, A])), "镜头顺序");
assert.equal(describeQueueChange(q([A, B]), q([{ ...A, roleIds: ["a", "b"] }, { ...B, roleIds: ["a", "b"] }])), "L01、L02 角色");
assert.equal(describeQueueChange(q([A]), q([A], { defaults: { noBackgroundMusic: false } })), "队列设置");

// ── 4. 接线：顶栏按钮和按键走同一处；捕获阶段拦住、不漏到 tldraw；锁定时不撤并说原因 ──
const root = new URL("..", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const board = read("components/shot-card-board.tsx"), hook = read("components/use-card-undo-keys.ts");
assert.match(board, /useCardUndoKeys\(stepHistory\)/);
assert.match(board, /onClick=\{\(\) => stepHistory\("undo"\)\}>撤销</); assert.match(board, /onClick=\{\(\) => stepHistory\("redo"\)\}>恢复</);
assert.match(board, /if \(locked\) return flashUndo\(`不能\$\{word\}：\$\{locked\}`\)/);
assert.match(board, /已撤销" : "已恢复"\}：\$\{describeQueueChange/);
assert.match(hook, /addEventListener\("keydown", onKey, true\)/, "窗口捕获阶段，比画布先收到");
assert.match(hook, /event\.stopPropagation\(\);\n\s+if \(isTextField/, "先拦住不往下传，再决定交给文本框还是卡片");
assert.match(hook, /removeEventListener\("keydown", onKey, true\)/, "卡片关掉就摘掉，Ctrl+Z 归画布");
assert.match(read("lib/shot-queue-history.ts"), /export function stepVersion/, "历史还是 shot-queue-history 那一套");

// ── 5. 顶栏：常用按钮在外面，按钮不用白底块；折叠成一排小卡片 ──
const head = board.slice(board.indexOf('<header className="sc-slate-head scf-head"'), board.indexOf("</header>", board.indexOf('<header className="sc-slate-head scf-head"')));
const more = head.slice(head.indexOf("<ScMoreMenu>"), head.indexOf("</ScMoreMenu>"));
// 2026-11-12 顶栏瘦身：「全部入队」进顶栏后，「复制卡片功能说明」「换队列 JSON」收进「更多」，「导出 JSON」留在外面
// 2026-11-12 用户要求：「换队列 JSON」放顶栏，「导出 JSON」收进「更多」
for (const label of ["换队列 JSON"]) { assert.ok(head.includes(label), label); assert.ok(!more.includes(label), `${label} 不在「更多」里`); }
for (const label of ["复制卡片功能说明", "导出 JSON"]) assert.ok(more.includes(label), `${label} 在「更多」里`);
assert.ok(more.includes("从 JSON 导入台词"));
const headerCss = read("components/shot-card-header.tsx");
assert.match(headerCss, /\.sc-root \.sc-btn\.primary,[^{]*\{background:var\(--panel-2\)/, "主按钮深底");
assert.ok(!/sc-render-btn\{[^}]*background:var\(--ff-white\)/.test(read("components/shot-card-layout.ts")), "渲染这一镜不是白底");
assert.match(board, /<ScFoldBar items=\{\[/); assert.match(headerCss, /\.scf-cards\{display:grid;grid-template-columns:repeat\(auto-fit/);
console.log("shot card undo: Ctrl+Z / Ctrl+Y 分流、文本框先撤字、撤销提示、同一套历史、不漏到画布；顶栏按钮和小卡片; ok");
