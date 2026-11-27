/*
 * 原来想保护什么：
 * 1. ShotQueuePanel 在画布宿主（app/canvas-workspace.tsx）中必须常驻挂载（用 display: none 隐藏而非条件卸载），确保关闭镜头卡片/队列抽屉时后台提交与执行器状态不会丢失。
 * 2. useShotQueueExecution 的提交生命周期与页隔离、停止策略完全独立于面板可见性（drawerOpen 仅调节 UI 展示轮询间隔，不中断提交），且位于 CanvasPanelBoundary 之外，界面渲染异常或关闭面板都不会中断排队任务。
 * 3. 面板隐藏时（visible === false）不得遍历画布图形或拉取角色/图片目录；重新打开后正常加载当前页目录，且忽略关闭前遗留的过期异步成功/失败回调。
 *
 * 为什么原写法失效：
 * 原测试第 10–15 行依赖 git show 44102a7 对 <ShotQueuePanel ...> 整行 JSX 与 use-shot-queue-execution.ts 做逐字冻结对比。
 * 后续产品正常迭代给 ShotQueuePanel 增加了定位镜头参数（focusNode 的 moveCamera）、createNode 的 AbortSignal 以及展示轮询节流（drawerOpen），导致整行字面相等直接报错（always-mounted queue host must remain unchanged）。
 *
 * 新写法怎么保护同一件事：
 * 1. 移除 git show 44102a7 与历史全文件比对，改为直接验证常驻挂载与生命周期不变量：
 *    - 检查 app/canvas-workspace.tsx 中 <ShotQueuePanel> 由 editor 挂载并用 display: showQueue ? "contents" : "none" 控制显隐，绝不由 showQueue && 条件挂载，且传入 visible={showQueue}、editor、persistenceKey、onClose、origin、focusNode、createNode；
 *    - 检查 components/shot-queue-panel.tsx 中 useShotQueueExecution 调用在 CanvasPanelBoundary 渲染之前；
 *    - 检查 components/use-shot-queue-execution.ts 按 pageId 隔离会话、不引用 visible、drawerOpen 仅用于轮询间隔（不参与 submit/stop 中止逻辑），且仅在显式 userStop 时撤回排队任务。
 * 2. 完整保留并加固原测试中全部运行时行为检查（1000 次隐藏态 selector 零扫描、隐藏态 effect 零读取、打开加载、关闭后忽略过期成功/失败、重新打开加载最新目录）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const panel = read('components/shot-queue-panel.tsx');
const host = read('app/canvas-workspace.tsx');
const hook = read('components/use-shot-queue-execution.ts');

// 1. 宿主常驻挂载不变量（不依赖任何历史 git 提交）
const queueHostLine = host.split('\n').find(line => line.includes('<ShotQueuePanel'));
assert.ok(queueHostLine, 'canvas-workspace.tsx must mount <ShotQueuePanel>');
assert.match(queueHostLine, /style=\{\{\s*display:\s*showQueue\s*\?\s*["']contents["']\s*:\s*["']none["']\s*\}\}/, 'ShotQueuePanel must stay mounted via CSS display toggle');
assert.doesNotMatch(queueHostLine, /showQueue\s*&&\s*<ShotQueuePanel/, 'ShotQueuePanel must never be conditionally unmounted by showQueue');
for (const prop of ['visible={showQueue}', 'editor={editor}', 'persistenceKey=', 'onClose=', 'origin=', 'focusNode=', 'createNode=']) {
  assert.ok(queueHostLine.includes(prop), `always-mounted ShotQueuePanel host must pass ${prop}`);
}

// 2. 执行器生命周期独立于展示错误边界与面板开关（drawerOpen 仅调节轮询节流，不中止提交）
const hookCallIndex = panel.indexOf('useShotQueueExecution({');
const boundaryIndex = panel.indexOf('<CanvasPanelBoundary');
assert.ok(hookCallIndex > 0 && boundaryIndex > hookCallIndex, 'useShotQueueExecution must remain outside CanvasPanelBoundary');
assert.doesNotMatch(hook, /\bvisible\b/, 'use-shot-queue-execution.ts must not branch on visible');
const submitStart = hook.indexOf('const submit =');
assert.ok(submitStart > 0, 'use-shot-queue-execution.ts must define submit');
assert.doesNotMatch(hook.slice(submitStart), /\bdrawerOpen\b/, 'drawerOpen must never affect submission or stop lifecycle');
assert.ok(hook.includes('queueSessionKey(pageId)'), 'queue execution isolates sessions per pageId');
assert.match(hook, /if\s*\(\s*controller\.signal\.aborted\s*&&\s*userStop\.current/, 'only explicit user stop cancels waiting jobs');

// 3. 面板目录门控与隐藏态零开销运行时行为检查
assert.match(panel, /visible\s*=\s*true/, 'ShotQueuePanel defaults visible to true');
assert.match(panel, /key=\{scopeKey\s*\?\s*JSON\.parse\(scopeKey\)\.pageId\s*:\s*["']hidden["']\}/, 'catalog details resets key per page or hidden state');
assert.match(panel, /scopeKey\s*&&\s*loadedCatalog\.scopeKey\s*===\s*scopeKey/, 'stale catalog from another scope/page is never shown');

const selectorMatch = panel.match(/const scopeKey = useValue\(["']shot queue current-page catalog["'],\s*\(\)\s*=>\s*(.*),\s*\[editor,\s*visible\]\);/);
const effectMatch = panel.match(/useEffect\(\(\)\s*=>\s*\{\s*\n\s*if\s*\(!scopeKey\)\s*return;([\s\S]*?)\n\s*\},\s*\[scopeKey\]\);/);
assert.ok(selectorMatch && selectorMatch[1], 'scopeKey selector must exist in ShotQueuePanel');
assert.ok(effectMatch && effectMatch[1], 'catalog loading effect must exist in ShotQueuePanel');
const selector = selectorMatch[1];
const effect = effectMatch[1];

let scans = 0, scopes = 0, reads = 0, updates = [], errors = [], deferred = [];
const context = vm.createContext({
  editor: { getCurrentPageId: () => 'page:test', getCurrentPageShapes: () => { scans++; return []; } },
  queueCatalogScope: () => { scopes++; return { assetIds: [], sources: [], roleIds: [] }; },
  visible: false, scopeKey: '',
  listRoles: () => { reads++; return new Promise((resolve, reject) => deferred.push({ resolve, reject })); },
  listAssets: () => { reads++; return Promise.resolve([]); },
  setLoadedCatalog: value => updates.push(value), setMessage: value => errors.push(value),
  buildQueueCatalog: () => ({ roles: [], images: [] }), Promise, JSON,
});

for (let n = 0; n < 1000; n++) assert.equal(vm.runInContext(selector, context), '');
assert.equal(scans, 0, 'hidden selector never scans canvas shapes');
assert.equal(scopes, 0, 'hidden selector never computes catalog scope');
const runEffect = () => vm.runInContext(ts.transpileModule('(function(){ if (!scopeKey) return;' + effect + '\n})()', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
runEffect(); assert.equal(reads, 0, 'hidden effect must not read/parse');

context.visible = true;
context.scopeKey = vm.runInContext(selector, context);
assert.equal(scans, 1); assert.equal(scopes, 1);
const cleanup = runEffect(); assert.equal(reads, 2);
cleanup(); deferred.shift().resolve([]);
await new Promise(resolve => setImmediate(resolve));
assert.equal(updates.length, 0, 'late success ignored after hiding');

const cleanupError = runEffect(); cleanupError(); deferred.shift().reject(Error('late failure'));
await new Promise(resolve => setImmediate(resolve));
assert.equal(errors.length, 0, 'late error ignored after hiding');

runEffect(); deferred.shift().resolve([]);
await new Promise(resolve => setImmediate(resolve));
assert.equal(updates.length, 1, 'reopening loads current catalog');
assert.equal(updates[0].scopeKey, context.scopeKey);
console.log('PASS visibility: always-mounted host, execution lifecycle independent of visibility, 1000 hidden selectors with zero scans/reads, stale async ignored, reopen loads catalog.');
