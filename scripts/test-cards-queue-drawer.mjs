// 2026-11-11「卡片」和「队列」合成一个入口：顶栏没有「队列」按钮，原队列面板的全部功能都在卡片顶栏「JSON / 进度」抽屉里。
// 只读源码 + 把真实的 Escape 处理函数拿出来跑；不开浏览器、不碰画布数据、不提交 GPU。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { isTypingTarget } from "../lib/keyboard-guards.ts";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const ws = read("app/canvas-workspace.tsx");
const panel = read("components/shot-queue-panel.tsx");
const board = read("components/shot-card-board.tsx");
const bar = read("components/inbox-control-bar.tsx");
const css = read("app/globals.css");

// ── 1. 顶栏：只有「卡片」，没有「队列」 ──
const nav = ws.slice(ws.indexOf('<nav className="header-nav"'), ws.indexOf("</nav>", ws.indexOf('<nav className="header-nav"')));
assert.ok(nav.length > 100, "找到顶栏");
assert.doesNotMatch(nav, />队列<\/button>|ListOrdered|镜头队列：/, "顶栏没有「队列」按钮");
assert.doesNotMatch(ws, /ListOrdered/, "队列图标不再引入");
assert.match(nav, /<LayoutGrid size=\{14\} \/>卡片/, "顶栏有「卡片」");
assert.match(nav, /aria-pressed=\{showQueue\}[^>]*>.*卡片/s, "卡片按钮显示开着 / 关着");
assert.match(nav, /window\.dispatchEvent\(new Event\("frameflow-open-shot-cards"\)\)/, "卡片按钮照旧让队列文本先解析");
assert.match(nav, /\{cardsIncoming > 0 && !showQueue && <span className="header-badge cards-dot"/, "收件箱有新队列、卡片关着：小红点");
assert.match(css, /\.header-badge\.cards-dot \{/, "小红点样式");
// 「更多」菜单里本来就没有队列；命令面板的「镜头队列」改成打开卡片的抽屉
const more = ws.slice(ws.indexOf('className="canvas-quick-menu header-more-menu"'), ws.indexOf("</div>}", ws.indexOf('className="canvas-quick-menu header-more-menu"')));
assert.doesNotMatch(more, /队列/, "「更多」里没有队列入口");
const paletteQueue = ws.split("\n").find((line) => line.includes('id: "open-shot-queue"'));
assert.match(paletteQueue, /label: "打开镜头卡片 · JSON \/ 进度"/);
assert.match(paletteQueue, /setShowQueue\(true\); window\.dispatchEvent\(new Event\("frameflow-open-queue-drawer"\)\)/, "命令面板打开卡片并展开抽屉");
assert.doesNotMatch(ws, /label: "打开镜头队列"/);
// 画布听两件事：卡片主人要求显示（收件箱 *_cards.json）、新队列个数（小红点）
assert.match(ws, /addEventListener\("frameflow-show-shot-cards", show\)/);
assert.match(ws, /addEventListener\("frameflow-cards-incoming", incoming\)/);
// 队列主人照旧一直挂载（卡片关着也在跑），挂载那一行没改
assert.equal((ws.match(/<ShotQueuePanel /g) ?? []).length, 1);
assert.match(ws, /<div style=\{\{ display: showQueue \? "contents" : "none" \}\}><ShotQueuePanel visible=\{showQueue\} editor=\{editor\} persistenceKey=\{CANVAS_PERSISTENCE_KEY\} autoSubmitText=\{pendingQueueText\} autoSubmitRequestId=\{pendingQueueDelivery\} onClose=\{\(\) => setShowQueue\(false\)\}/);

// ── 2. 抽屉里有原队列面板的全部功能 ──
const drawerStart = panel.indexOf('<aside ref={panel} className="sc-queue-drawer"');
assert.ok(drawerStart > 0, "抽屉在队列主人里渲染");
const drawer = panel.slice(drawerStart, panel.indexOf("</aside>", drawerStart));
const features = {
  "JSON 文本框": /<span>镜头表 JSON<\/span><textarea/,
  "载入 JSON 文件": /载入 JSON 文件<input aria-label="载入镜头表文件" type="file"/,
  "检查镜头表": />检查镜头表<\/button>/,
  "填入示例": />填入示例<\/button>/,
  "填入首尾帧示例": />填入首尾帧示例<\/button>/,
  "导出台词清单": />导出台词清单<\/button>/,
  "收件箱新队列切换": /切换到收件箱新队列「\{incoming\[incoming\.length - 1\]\.file\}」/,
  // 2026-11-12 停止排队修复：抽屉按钮走 stopQueue（先开抽屉再 execution.stop），停的时候显示「正在停止…」
  "停止后续排队": /onClick=\{stopQueue\}>\{execution\.stopping \? "正在停止…" : "停止后续排队（保留正在执行的镜头）"\}/,
  "重试失败镜头": /void execution\.retryFailed\(\)\}>重试失败镜头/,
  "全部入队／继续未完成": /onClick=\{\(\) => void startManual\(\)\}>\{runningAll \? "正在依次入队" : "全部镜头入队／继续未完成"\}/,
  "本章入队／继续未完成": /onClick=\{\(\) => void startManual\(chapterIndex\)\}>\{busyChapter === chapterIndex \? "正在提交本章" : "本章入队／继续未完成"\}/,
  "排队进度（每镜状态）": /row \? ` · \$\{statusText\[row\.status\]\}` : ""/,
  "删除镜头": /className="shot-queue-delete"/,
  "预计耗时": /⏱ 预计耗时（估算）/,
  "禁止背景音乐": /禁止背景音乐（新导入队列/,
  "出片后自动去配乐": /出片后自动去配乐（默认开/,
  "体检提示": /<QueueCheckupList warnings=\{shotQueueWarnings\(queue\)\} \/>/,
  "两阶段说明": /两阶段：先完成主镜头/,
  "角色和图片 ID": /<summary>当前画布角色和图片 ID<\/summary>/,
  "自动入队 / 急停": /<InboxControlBar embedded \/>/,
  "状态消息": /role="status"/,
};
for (const [name, pattern] of Object.entries(features)) assert.match(drawer, pattern, `抽屉里有：${name}`);
// 入队前确认（2026-11-12）：不在抽屉里，在页面正中间（portal 到 body，全屏遮罩居中）；Esc / 点遮罩 = 取消
const askAt = panel.indexOf('{queue && startAsk && createPortal(<div className="sq-ask-shade" style={ASK_SHADE}');
assert.ok(askAt > panel.indexOf("</aside>", drawerStart), "入队确认框在抽屉外面");
assert.match(panel.slice(askAt), /role="alertdialog" aria-modal="true" aria-label="入队前确认"/);
assert.match(panel, /const ASK_SHADE: CSSProperties = \{ position: "fixed", inset: 0,[^}]*placeItems: "center"/, "居中遮罩");
assert.match(panel, /autoFocus onClick=\{cancelAsk\}>取消（不提交）/, "默认焦点在取消上");
// 卡片顶栏「全部入队（N 镜）」和章节「本章入队」走同一个 startManual（同一把防重复锁、同样先问、画面五项照常拦）
assert.match(panel, /all: \(\) => \{ if \(submitting\) setDrawerOpen\(true\); else if \(!startAsk && !checking\) void startManual\(\); \}/);
assert.match(panel, /chapter: \(index: number\) => \{ if \(!submitting && !startAsk && !checking\) void startManual\(index\); \}/);
assert.match(board, /className="sc-btn primary sc-enqueue"[^>]*onClick=\{queueDrawer\.enqueue\.all\}/, "顶栏主按钮");
assert.match(board, /className="sc-btn sc-chapter-go"[^>]*onClick=\{\(\) => queueDrawer\.enqueue!\.chapter\(c\)\}>本章入队/, "章节标题旁本章入队");
assert.doesNotMatch(drawer, /className="shot-queue-cards"|打开镜头卡片：/, "不再有「打开镜头卡片」按钮（本来就在卡片里）");
// 换队列、导出 JSON、撤销恢复、收件箱提示条：卡片顶栏照旧
const head = board.slice(board.indexOf('<header className="sc-slate-head scf-head"'), board.indexOf("</header>", board.indexOf('<header className="sc-slate-head scf-head"')));
for (const label of ["换队列 JSON", "导出 JSON", "撤销", "恢复", "新队列待切换"]) assert.ok(head.includes(label), `卡片顶栏：${label}`);
assert.match(head, /aria-expanded=\{queueDrawer\.open\}[^>]*onClick=\{queueDrawer\.toggle\}>JSON \/ 进度/, "卡片顶栏「JSON / 进度」按钮");
assert.match(head, /queueDrawer\.busy \? <small> · 提交中<\/small>/, "提交中时按钮上写着");
assert.match(board, /收件箱来了新队列「\{incoming\.file\}」\{incoming\.count > 1/, "卡片里的收件箱提示条");

// ── 3. 空状态：没有队列就直接打开抽屉 ──
assert.match(board, /if \(!queue && queueDrawer\) return <EmptyCards onClose=\{onClose\} incoming=\{incoming\} \/>;/);
assert.match(board, /aria-label="镜头卡片 · 还没有队列"/);
const shownExpr = panel.match(/const drawerShown = (.*);/)[1];
const shown = (env) => vm.runInNewContext(shownExpr, env);
assert.equal(shown({ visible: true, replacing: false, drawerOpen: false, queue: null }), true, "没有队列：抽屉开着");
assert.equal(shown({ visible: true, replacing: false, drawerOpen: false, queue: {} }), false, "有队列：默认收起，看卡片");
assert.equal(shown({ visible: true, replacing: false, drawerOpen: true, queue: {} }), true);
assert.equal(shown({ visible: false, replacing: false, drawerOpen: true, queue: null }), false, "卡片关着：抽屉也不显示（执行照常）");
assert.equal(shown({ visible: true, replacing: true, drawerOpen: true, queue: {} }), false, "换队列输入框打开时让开");
assert.match(panel, /queueDrawer=\{\{ open: drawerShown, toggle: \(\) => setDrawerOpen\(\(open\) => !open\), busy: submitting, onReplacing: setReplacing, enqueue \}\}/);
assert.match(panel, /setAutoStart\(true\);\n\s*setDrawerOpen\(true\);/, "收件箱自动入队：展开抽屉看进度");

// ── 4. 入队逻辑照旧（只搬界面） ──
assert.ok(panel.indexOf("const execution = useShotQueueExecution(") < panel.indexOf("return <CanvasPanelBoundary"), "执行钩子在显示边界外面");
assert.match(panel, /plan = await execution\.previewStart\(chapter\);/, "入队前先盘点");
assert.match(panel, /if \(plan && plan\.newBatch\) \{ setMessage\(""\); setStartAsk\(\{ plan, chapter \}\); return; \}/, "新一批：页面里先问");
assert.match(panel, /void \(chapter === undefined \? submitAll\(true, reuse\) : submit\(chapter, true, reuse\)\)\.finally\(\(\) => \{ startLock\.current = false; \}\);/);
assert.match(panel, /if \(startLock\.current\) \{ setMessage\(DUPLICATE\); return; \}/, "防重复：快速连点两下只提交一次（顶栏、章节、抽屉三处同一把锁）");
assert.match(panel, /disabled=\{!execution\.ready \|\| busyChapter !== null \|\| startAsk !== null\} onClick=\{\(\) => void startManual\(\)\}/, "防重复：提交中 / 正在问时按钮灰掉");
assert.match(panel, /disabled=\{!execution\.ready \|\| busyChapter !== null\} onClick=\{\(\) => void startManual\(chapterIndex\)\}/);
assert.doesNotMatch(panel, /window\.confirm\(|强行入队/);
assert.match(panel, /locked=\{submitting \? "队列正在提交，先在「JSON \/ 进度」里点「停止后续排队」，再改" : ""\}/, "提交中卡片不能改");
assert.match(board, /const locked = busyLock \|\| \(submitted \? "这份队列已经入队过/, "已入队过的队列不能原地改");
assert.match(board, /shotGateMessage\(card\.shot/, "画面五项拦截照旧");
assert.match(board, /if \(lockedNow\.current\) return lockedNow\.current; const problem = onLoad\(text\);/, "换队列：回答后再看锁");
// 收件箱 *_cards.json：提交中不换、别的队列开着就放提示条，绝不提交
assert.match(panel, /if \(cardBusy\.current\) \{ reply\("卡片正在提交别的队列，等它结束"\); return; \}/);
assert.match(panel, /setIncoming\(\(list\) => \[\.\.\.list\.filter\(\(item\) => item\.file !== file\), \{ text, file \}\]\); setIncomingHidden\(false\);/);
assert.match(panel, /window\.dispatchEvent\(new CustomEvent\("frameflow-cards-incoming", \{ detail: incoming\.length \}\)\)/);
// 显示卡片只发「显示」事件，不会重新解析旧文本覆盖刚载入的队列
assert.match(panel, /const showCards = \(\) => window\.dispatchEvent\(new Event\("frameflow-show-shot-cards"\)\);/);
assert.doesNotMatch(panel, /setShowCards/);

// ── 5. 自动入队 / 急停：同一套开关，抽屉里不多一个「执行页」心跳 ──
assert.equal((panel.match(/<InboxControlBar embedded \/>/g) ?? []).length, 1);
assert.equal((ws.match(/<InboxControlBar \/>/g) ?? []).length, 1, "左下角那个还在");
assert.match(bar, /if \(embedded\) \{ setView\(sharedView\); viewListeners\.add\(setView\);/, "嵌入的不另起心跳（否则一页会算成两页）");
assert.equal((bar.match(/startPresence\(/g) ?? []).length, 1);

// ── 6. Escape：抽屉开着先收抽屉；空卡片直接关；在打字 / 有确认框 / 卡片关着时不管 ──
const parsed = ts.createSourceFile("p.tsx", readFileSync(new URL("../components/shot-queue-panel.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = [];
const visit = (node) => { if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "onKey") handlers.push(node.initializer.getText(parsed)); ts.forEachChild(node, visit); };
visit(parsed);
assert.equal(handlers.length, 1);
class El { constructor(tagName) { this.tagName = tagName; this.isContentEditable = false; } }
const originalHTMLElement = globalThis.HTMLElement; globalThis.HTMLElement = El;
try {
  let closed = 0, folded = 0, visible = true, dialog = false;
  const context = vm.createContext({ isTypingTarget, onClose: () => closed++, setDrawerOpen: (value) => { assert.equal(value, false); folded++; }, hasQueue: { current: true },
    panel: { current: { getClientRects: () => visible ? [{}] : [] } }, document: { querySelector: () => dialog ? {} : null } });
  const onKey = vm.runInContext(ts.transpileModule(`const onKey = ${handlers[0]}; onKey;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const esc = (target, extra = {}) => ({ key: "Escape", isComposing: false, target, stopPropagation() {}, ...extra });
  onKey(esc(new El("TEXTAREA"))); onKey(esc(new El("BUTTON"), { isComposing: true })); onKey(esc(new El("BUTTON"), { key: "Enter" }));
  dialog = true; onKey(esc(new El("BUTTON"))); dialog = false;
  visible = false; onKey(esc(new El("BUTTON"))); visible = true;
  assert.deepEqual([closed, folded], [0, 0], "打字、输入法、确认框、抽屉没显示：都不处理");
  onKey(esc(new El("BUTTON"))); assert.deepEqual([closed, folded], [0, 1], "有队列：收起抽屉，不关卡片");
  context.hasQueue.current = false; onKey(esc(new El("BUTTON"))); assert.deepEqual([closed, folded], [1, 1], "空卡片：关掉卡片");
} finally { if (originalHTMLElement === undefined) delete globalThis.HTMLElement; else globalThis.HTMLElement = originalHTMLElement; }
assert.match(board, /\.scv-shade, \.sca-shade, \.sc-queue-drawer"\)/, "卡片自己的 Escape 在抽屉开着时让给抽屉");

// ── 7. 样式：灰阶 token，整页一个主按钮 ──
const drawerCss = css.split("\n").filter((line) => line.includes(".sc-queue-drawer")).join("\n");
assert.ok(drawerCss.length > 0);
assert.doesNotMatch(drawerCss, /#[0-9a-f]{3,6}\b|rgba?\(|--ff-(warn|run|bad|ok|queue)/i, "抽屉只用灰阶 token");
assert.doesNotMatch(drawer, /sc-btn primary/, "抽屉里没有第二个白色主按钮");
assert.match(drawer, /className=\{queue \? "" : "is-primary"\}[^\n]*?>检查镜头表<\/button>/, "只有空卡片时「检查镜头表」是主按钮（那时没有「一键粗剪」）");
assert.match(css, /body \.sc-queue-drawer \.shot-queue-submit-all button \{ border:1px solid var\(--ff-text-3\); color:var\(--ff-text\); background:var\(--ff-control\); \}/, "抽屉里的入队按钮深色描边");
// 2026-11-12：卡片顶栏唯一的主按钮改成「全部入队（N 镜）」（用户找不到渲染按钮），「一键粗剪」降成普通按钮
assert.equal((head.match(/className="sc-btn primary/g) ?? []).length, 1, "顶栏只有一个主按钮");
assert.match(board, /className="sc-btn primary sc-enqueue"/);
assert.match(board, /className="sc-btn" onClick=\{roughCut\}/);

console.log("cards + queue merged: 顶栏全部入队 + 本章入队 + 页面正中确认, no 队列 button, every old queue feature in the cards' JSON / 进度 drawer, empty cards open the drawer, enqueue logic unchanged, red dot, Escape, grey styles; ok");
