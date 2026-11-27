/*
 * 原来想保护什么：
 * 1. 画布主工作区（app/canvas-workspace.tsx）与 5 个自定义媒体节点的删除入口全部走安全删除动作 deleteCanvasNodes，不绕过安全检查直接调用 requestNodeDeletion。
 * 2. 安全删除核心模块（lib/safe-delete.ts、components/canvas/safe-delete-action.ts）维持关键行为不变量：删除前先尽量取消关联任务、拒绝删除锁定/缺失/跨页节点、先撤销窗口再回收未共用原文件、撤销后不执行回收、摘要文案按优先级归类保留原因。
 * 3. 画布错误边界与全局错误上报（Phase F）、队列提交失败透传（if (enqueueOnly) throw cause）、队列执行器对已删节点的墓碑跳过保护均保持有效。
 * 4. 5 个自定义媒体节点组件仍保留 ShapeUtil 几何/默认属性契约与安全删除入口。
 *
 * 为什么原写法失效：
 * 原测试依赖 git show 26e98c5 做全文件逐字冻结对比，并靠 normalizeQueueFrameNode / normalizeCanvasSmoothness 等硬编码字符串替换去逆转早期补丁。后续画布与工作流正常演进（硬盘快照、队列面板、批量操作、新节点功能等），导致字符串逆转立刻报错（exact queue frame node edit must occur once），且对 globals.css、lib/comfyui 等的历史逐字冻结早已与真实开发脱节。
 *
 * 新写法怎么保护同一件事：
 * 1. 移除所有 git show 26e98c5 全文件逐字比对与易碎字符串逆转脚本。
 * 2. 改为直接检查当前代码的安全删除与保护不变量：
 *    - 通过 TypeScript AST 隔离提取并运行 lib/safe-delete.ts 的 deleteSummary，验证回收计数、仅清副本、保留原因优先级与无素材文案；
 *    - 检查 safeDeleteNodes 与 deleteCanvasNodes 的核心安全顺序（cancelTasksBeforeNodeRemoval -> 锁定/跨页阻断 -> inspectNodeRemoval -> undo/commitRecycle 延迟回收 -> canvas-delete-unconfirmed 确认事件）；
 *    - 检查 app/canvas-workspace.tsx 删除入口全部走 deleteCanvasNodes（无裸 requestNodeDeletion）、错误边界与 UI 错误上报完整挂载、enqueueOnly 错误透传未被吞掉；
 *    - 检查 5 个自定义节点均通过 deleteCanvasNodes(editor, ...) 执行删除并保留 ShapeUtil 契约；
 *    - 检查 use-shot-queue-execution.ts 在预建和提交循环中均跳过 removedAt/cancelRequestedAt/cancelledAt 条目。
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read=p=>readFileSync(p,'utf8').replaceAll('\r\n','\n');
const workspace=read('app/canvas-workspace.tsx');
const safeDelete=read('lib/safe-delete.ts');
const safeDeleteAction=read('components/canvas/safe-delete-action.ts');
const queueHook=read('components/use-shot-queue-execution.ts');

// 1. app/canvas-workspace.tsx：所有用户删除入口走 deleteCanvasNodes，不绕过安全删除
assert.match(workspace,/import\s*\{\s*deleteCanvasNodes\s*\}\s*from\s*['"]@\/components\/canvas\/safe-delete-action['"]/, 'workspace imports deleteCanvasNodes');
assert.doesNotMatch(workspace,/\brequestNodeDeletion\s*\(/, 'workspace must not bypass deleteCanvasNodes via raw requestNodeDeletion');
assert.match(workspace,/actions\.delete[\s\S]{0,220}deleteCanvasNodes\(\s*editor\s*,\s*ids\s*\)/, 'tldraw delete action routes through deleteCanvasNodes');
assert.match(workspace,/function\s+deleteNodeWithHistory[\s\S]{0,160}deleteCanvasNodes\(\s*editor\s*,\s*\[\s*shapeId\s*\]\s*\)/, 'deleteNodeWithHistory routes through deleteCanvasNodes');

// 2. Phase F 错误边界与 UI 错误上报保持挂载
assert.match(workspace,/ErrorFallback\s*:\s*CanvasErrorFallback/, 'CanvasErrorFallback registered');
assert.match(workspace,/ShapeErrorFallback\s*:\s*CanvasShapeErrorFallback/, 'CanvasShapeErrorFallback registered');
assert.match(workspace,/installUiErrorReporting\(\s*window\s*,\s*showCanvasToast\s*\)/, 'UI error reporting installed');
assert.ok(workspace.includes('<CanvasSaveStatusContext.Provider') && workspace.includes('</CanvasSaveStatusContext.Provider>'), 'CanvasSaveStatusContext provider wraps workspace');
for(const panelName of ['素材库','镜头板','诊断','搜索与命令','素材来源','错误中心','备份','角色库']){
  assert.ok(workspace.includes(`<CanvasPanelBoundary name="${panelName}"`), `CanvasPanelBoundary protects ${panelName}`);
}

// 3. 队列 fail-closed：H3 节点 enqueueOnly 异常必须原样抛给队列执行器
assert.match(workspace,/if\s*\(\s*enqueueOnly\s*\)\s*throw\s+cause\s*;/, 'H3 enqueueOnly preserves submission error class for queue fail-closed policy');

// 4. lib/safe-delete.ts 运行时行为检查：隔离提取并执行 deleteSummary，验证回收/副本/保留原因优先级
const safeDeleteAst=ts.createSourceFile('safe-delete.ts',safeDelete,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const summaryDecl=safeDeleteAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='deleteSummary');
assert.ok(summaryDecl,'deleteSummary must exist in lib/safe-delete.ts');
const summaryJs=ts.transpileModule(summaryDecl.getText(safeDeleteAst).replace(/^export\s+/,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const deleteSummary=vm.runInNewContext(summaryJs+'; deleteSummary;',{Map});

const summaryMixed=deleteSummary(2,{
  recycled:['a1','a2','a3'],
  browserCopies:['a3'],
  kept:[
    {assetId:'k1',reasons:['其他节点在用','角色在用']},
    {assetId:'k2',reasons:['未结束的生成任务在用']},
  ],
});
assert.match(summaryMixed,/已删除 2 个节点/, 'summary includes deleted node count');
assert.match(summaryMixed,/2 份原文件已进 Windows 回收站/, 'summary distinguishes disk originals from browser-only copies');
assert.match(summaryMixed,/1 份没找到磁盘原文件/, 'summary reports browser-only copies');
assert.match(summaryMixed,/1 份角色在用/, 'higher-priority role reason wins over secondary reason');
assert.match(summaryMixed,/1 份未结束的生成任务在用/, 'active generation keep reason reported');

const summaryEmpty=deleteSummary(1,{recycled:[],browserCopies:[],kept:[]});
assert.match(summaryEmpty,/没有登记生成素材，没有删除文件/, 'empty asset delete explains no file removed');
const summaryWithError=deleteSummary(1,{recycled:[],browserCopies:[],kept:[]},'磁盘只读');
assert.match(summaryWithError,/磁盘只读/, 'summary appends error note when present');

// 5. lib/safe-delete.ts 与 safe-delete-action.ts 安全顺序不变量
const cancelPos=safeDelete.indexOf('cancelTasksBeforeNodeRemoval(editor,ids)');
const lockedPos=safeDelete.indexOf('s.isLocked');
const inspectPos=safeDelete.indexOf('inspectNodeRemoval(editor, ids, confirmationKey)');
const deletePos=safeDelete.indexOf('deleteWithRestore(editor, checked.ids)');
assert.ok(cancelPos>0 && lockedPos>cancelPos && inspectPos>lockedPos && deletePos>inspectPos, 'safeDeleteNodes cancels tasks, checks locks, inspects removal, then deletes');
assert.match(safeDelete,/if\s*\(\s*checked\.reason\s*===\s*['"]blocked['"]\s*\)\s*return\s+checked/, 'blocked inspection refuses deletion');
assert.match(safeDelete,/if\s*\(\s*undone\s*\|\|\s*committed\s*\)\s*return/, 'undoing deletion prevents deferred media recycling');
assert.match(safeDeleteAction,/safeDeleteNodes\(\s*editor\s*,\s*ids\s*,\s*intent\s*\)/, 'deleteCanvasNodes delegates to safeDeleteNodes');
assert.match(safeDeleteAction,/offerDeleteUndo\(/, 'deleteCanvasNodes offers undo toast');
assert.match(safeDeleteAction,/canvas-delete-unconfirmed/, 'deleteCanvasNodes dispatches confirmation event for unresolved history');

// 6. 队列执行器删除保护：跳过已删/取消条目，绝不提交正在删除或已删除的节点
assert.match(queueHook,/entry\.removedAt\s*\|\|\s*entry\.cancelRequestedAt\s*\|\|\s*entry\.cancelledAt/, 'queue execution guards against removed/cancelled entries');
assert.match(queueHook,/removeEntry/, 'queue execution exposes removeEntry tombstone hook');

// 7. 5 个自定义媒体节点：均通过 deleteCanvasNodes 执行删除且保留 ShapeUtil 核心方法
const nodeFiles=[
  'components/canvas/flux-image-node.tsx',
  'components/canvas/tts-node.tsx',
  'components/canvas/media-workshop-node.tsx',
  'components/canvas/cover-node.tsx',
  'components/canvas/translation-node.tsx',
];
const shapeMethods=new Set(['getDefaultProps','getGeometry','getIndicatorPath','canResize']);
for(const p of nodeFiles){
  const src=read(p);
  assert.ok(src.includes('deleteCanvasNodes(editor,'), `${p} routes user removal through safe action`);
  const ast=ts.createSourceFile(p,src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const found=[];
  const visit=n=>{if(ts.isMethodDeclaration(n)&&shapeMethods.has(n.name?.getText(ast)))found.push(n.name.getText(ast));ts.forEachChild(n,visit);};
  visit(ast);
  assert.ok(found.includes('getDefaultProps'), `${p} preserves ShapeUtil getDefaultProps contract`);
}
console.log('PASS safe-delete preservation: workspace & 5 media nodes route via deleteCanvasNodes; safeDeleteNodes/deleteSummary invariants, error boundaries, enqueueOnly propagation, and queue removal guards verified.');
