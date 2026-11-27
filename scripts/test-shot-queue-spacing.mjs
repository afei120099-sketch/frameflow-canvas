/*
 * 原来想保护什么：
 * 1. 新建队列 H3 节点的布局策略（宽 H3_NEW_NODE_WIDTH、高 H3_NEW_NODE_HEIGHT、横向间距 100、按章分行与章间空行、零重叠）与节点参数/质量默认值/参考图顺序不被改坏。
 * 2. 实际工厂函数 createH3Node 与队列预建循环协同工作时，能正确预建全部 49 个镜头节点并逐条持久化。
 * 3. 断点续传/历史自定义位置与尺寸的已有节点绝不被重新排版或改尺寸；崩后通过 metadata 认回的已有节点同样不动；用户从画布删除的节点绝不被静默重建，且不阻断后续镜头。
 *
 * 为什么原写法失效：
 * 1. 原测试用 git show 22bb7f4 对 lib/h3-node-layout-policy.ts、lib/shot-queue.ts（4 个函数源码）以及 app/canvas-workspace.tsx（createH3Node 源码）做逐字冻结对比，任何正常演进（如角色主外观校验文案、配乐默认值、AbortSignal 支持）都会直接触发 AssertionError。
 * 2. 产品代码（J2）已正常将队列节点布局从「全部单行无限右排」升级为「按章分行：每行最多 10 个、同行横向间距 100、章间空一行」，原测试仍硬编码断言所有 49 个节点 y === batch.origin.y 与字面量 queueNodePosition(batch.origin, index)。
 *
 * 新写法怎么保护同一件事：
 * 1. 移除全部 git show 22bb7f4 源码冻结对比，改为行为检查：
 *    - 直接调用 planShotReferences 与 shotQueueH3Props，验证缺失角色/缺少主外观时 fail-closed 抛错、质量/种子/标题/提示词默认值正确落入 H3 props、角色与场景参考图顺序严格按输入顺序保持；
 *    - 验证 createH3Node 创建节点的尺寸/坐标/H3_NEW_LAYOUT_META 与 AbortSignal 取消行为；
 *    - 在真实预建循环上跑完 3 章共 49 镜（20/20/9），逐一断言：每行最多 10 个、同行相邻节点净间距严格为 100、同章换行步长等于 H3_NEW_NODE_HEIGHT + QUEUE_GAP_Y、章与章之间严格空出一行、49 个节点两两零重叠、全部渲染参数与 shotQueueH3Props 一致；
 *    - 完整保留无关老节点保护、自定义位置/尺寸断点续传零改动、metadata 崩溃认回零改动、已删节点不重建且标记 removedAt 并继续其余镜头的全部行为断言。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { H3_NEW_NODE_WIDTH, H3_NEW_NODE_HEIGHT, H3_NEW_LAYOUT_META } from '../lib/h3-node-layout-policy.ts';
import { newQueueSession, queueNodePosition, queueRowKey, QUEUE_ROW_LIMIT, QUEUE_GAP_X, QUEUE_GAP_Y } from '../lib/shot-queue-session.ts';
import { parseShotQueue, planShotReferences, shotQueueH3Props } from '../lib/shot-queue.ts';
import { hasQueueFrameSources, queueFrameDescription } from '../lib/shot-queue-frames.ts';

const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const hook = read('components/use-shot-queue-execution.ts');
// K1（11-26）把 createH3Node 等共用函数搬到了 components/canvas/workspace-shared.ts，两个文件一起读
const source = read('app/canvas-workspace.tsx') + '\n' + read('components/canvas/workspace-shared.ts');

// 1. 布局常量与参考图/参数默认值行为检查（替代旧版 git show 22bb7f4 冻结对比）
assert.ok(H3_NEW_NODE_WIDTH > 0 && H3_NEW_NODE_HEIGHT > 0, 'H3 layout policy dimensions must be positive');
assert.ok(H3_NEW_LAYOUT_META && typeof H3_NEW_LAYOUT_META === 'object', 'H3_NEW_LAYOUT_META exported');
assert.equal(QUEUE_ROW_LIMIT, 10, 'default queue row wrap limit is 10');
assert.equal(QUEUE_GAP_X, 100, 'default horizontal gap is 100');
assert.ok(QUEUE_GAP_Y > 0, 'vertical gap between rows must be positive');

const baseShot = { title: '参考顺序校验', prompt: '行为测试提示词', seconds: 5, aspect: '16:9', roleIds: [], sceneAssetIds: [] };
assert.throws(
  () => planShotReferences({ ...baseShot, roleIds: ['role-missing'] }, [], new Map()),
  /角色不存在/,
  'missing role must fail closed',
);
assert.throws(
  () => planShotReferences({ ...baseShot, roleIds: ['role-no-look'] }, [{ roleId: 'role-no-look', displayName: '无外观角色' }], new Map()),
  /没有主外观/,
  'role without primaryAppearanceAssetId must fail closed',
);

const testRoles = [
  { roleId: 'role-alpha', displayName: '角色甲', primaryAppearanceAssetId: 'asset-role-alpha' },
  { roleId: 'role-beta', displayName: '角色乙', primaryAppearanceAssetId: 'asset-role-beta' },
];
const testAssets = new Map([
  ['asset-role-alpha', { assetId: 'asset-role-alpha', kind: 'image', storageReference: 'local:role-alpha', filename: 'alpha.png' }],
  ['asset-role-beta', { assetId: 'asset-role-beta', kind: 'image', storageReference: 'local:role-beta', filename: 'beta.png' }],
  ['asset-scene-first', { assetId: 'asset-scene-first', kind: 'image', storageReference: 'local:scene-first', filename: 'scene1.png' }],
  ['asset-scene-second', { assetId: 'asset-scene-second', kind: 'image', storageReference: 'local:scene-second', filename: 'scene2.png' }],
]);
const orderShotAB = { ...baseShot, roleIds: ['role-alpha', 'role-beta'], sceneAssetIds: ['asset-scene-first', 'asset-scene-second'] };
const orderShotBA = { ...baseShot, roleIds: ['role-beta', 'role-alpha'], sceneAssetIds: ['asset-scene-second', 'asset-scene-first'] };
const planAB = planShotReferences(orderShotAB, testRoles, testAssets);
const planBA = planShotReferences(orderShotBA, testRoles, testAssets);
const propsAB = shotQueueH3Props(orderShotAB, planAB, { workflow: 'ultimate', megapixels: 0.88, seed: 123 });
const propsBA = shotQueueH3Props(orderShotBA, planBA, { workflow: 'ultimate', megapixels: 0.88, seed: 123 });
assert.equal(propsAB.megapixels, 0.88, 'defaults.megapixels propagates into H3 props');
assert.equal(String(propsAB.seed), '123', 'defaults.seed propagates into H3 props');
assert.equal(propsAB.shotTitle, orderShotAB.title, 'shot title propagates into H3 props');
assert.equal(propsAB.prompt, orderShotAB.prompt, 'shot prompt propagates into H3 props');
const planABText = JSON.stringify(planAB);
const planBAText = JSON.stringify(planBA);
assert.ok(planABText.indexOf('role-alpha') > -1 && planABText.indexOf('role-alpha') < planABText.indexOf('role-beta'), 'role reference ordering preserved (alpha before beta)');
assert.ok(planBAText.indexOf('role-beta') > -1 && planBAText.indexOf('role-beta') < planBAText.indexOf('role-alpha'), 'role reference ordering follows input order (beta before alpha)');
const propsABText = JSON.stringify(propsAB);
const propsBAText = JSON.stringify(propsBA);
assert.ok(propsABText.indexOf('local:scene-first') > -1 && propsABText.indexOf('local:scene-first') < propsABText.indexOf('local:scene-second'), 'scene reference ordering preserved (first before second)');
assert.ok(propsBAText.indexOf('local:scene-second') > -1 && propsBAText.indexOf('local:scene-second') < propsBAText.indexOf('local:scene-first'), 'scene reference ordering follows input order (second before first)');

// 2. 提取真实 createH3Node 与预建循环并验证行为
const parsed = ts.createSourceFile('workspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let factory;
const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'createH3Node') factory = node.getText(parsed).replace(/^export\s+/, ''); ts.forEachChild(node, visit); };
visit(parsed);
assert.ok(factory, 'createH3Node factory must exist in canvas-workspace.tsx or workspace-shared.ts');

const start = hook.indexOf('        for (let index = 0; index < batch.entries.length; index++) {');
const end = hook.indexOf('        // Verify tldraw', start);
assert.ok(start > 0 && end > start, 'prebuild loop must precede canvas save verification');
const creation = hook.slice(start, end);
assert.ok(creation.indexOf('if (entry.nodeId)') > -1 && creation.indexOf('if (entry.nodeId)') < creation.indexOf('queueNodePosition('), 'existing entry.nodeId check must run before laying out a new node');

const raw = { version: 'shot-queue-v1', title: 'C间距独立验收', defaults: { workflow: 'ultimate', megapixels: 0.88, seed: 123 }, chapters: [{ title: '测试章', shots: Array.from({ length: 49 }, (_, i) => ({ title: '镜头' + i, prompt: '仅CPU隔离测试', seconds: 5, aspect: '16:9', roleIds: [], sceneAssetIds: [] })) }] };
const allShots = raw.chapters[0].shots;
raw.chapters = [0, 20, 40].map((s, i) => ({ title: '测试章' + i, shots: allShots.slice(s, s + 20) }));
const queue = parseShotQueue(JSON.stringify(raw));
const batch = newQueueSession('page:spacing-test', queue, { x: -123.5, y: 567.25 });
const records = new Map([['shape:legacy-unrelated', { id: 'shape:legacy-unrelated', type: 'h3-node', x: -999, y: -333, props: { w: 431, h: 643 }, meta: {} }]]);
const legacy = structuredClone(records.get('shape:legacy-unrelated'));
let created = 0, persisted = 0; const said = [];
const editor = {
  createShape: shape => records.set(shape.id, structuredClone(shape)),
  getShape: id => records.get(id),
  getCurrentPageShapes: () => [...records.values()],
  updateShape: patch => { const prev = records.get(patch.id); records.set(patch.id, { ...prev, ...patch, meta: { ...prev.meta, ...patch.meta } }); },
};
const context = vm.createContext({
  batch, editor, guard() {}, prebuildGuard() {}, retryTarget: undefined, framesOnly: false, prebuild: { check() {}, signal: undefined }, hasQueueFrameSources, queueFrameDescription, queueNodePosition, queueRowKey, shotQueueH3Props,
  plans: batch.entries.map(entry => ({ plan: planShotReferences(batch.queue.chapters[entry.chapter].shots[entry.shot], [], new Map()) })),
  crypto, H3_NODE_WIDTH: H3_NEW_NODE_WIDTH, H3_DEFAULT_HEIGHT: H3_NEW_NODE_HEIGHT, H3_NEW_LAYOUT_META,
  createShapeId: () => 'shape:new-' + (++created), createShot: async () => ({ shotId: 'test-' + created }), linkShotToH3Node: async () => ({ shotId: 'test-link' }),
  getAsset: async () => { throw Error('Unexpected real asset lookup'); }, persist: async () => { persisted++; }, persistScoped: async () => { persisted++; }, say: text => { said.push(text); },
  listRuns: async () => [], maySubmitQueueEntry: () => true,
});
const compile = code => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const actualFactory = vm.runInContext(compile(factory + '; createH3Node;'), context);
context.createNode = (props, point, signal) => actualFactory(editor, point, props, undefined, signal);

// 验证 createH3Node 响应 AbortSignal，被中止时不创建幽灵节点
const aborted = new AbortController(); aborted.abort();
await assert.rejects(() => actualFactory(editor, { x: 0, y: 0 }, { shotTitle: 'aborted' }, undefined, aborted.signal), { name: 'AbortError' });
assert.equal(records.size, 1, 'aborted createH3Node must not create a shape');
created = 0;

// 3. 运行真实预建循环（3 章：[20, 20, 9] 共 49 镜）并检查按章分行布局与参数完整性
const prebuild = vm.runInContext(compile('(async function(){' + creation + '\n})'), context);
await prebuild();
assert.equal(created, 49); assert.equal(persisted, 49);

const chapterSizes = batch.queue.chapters.map(c => c.shots.length);
const rowStep = H3_NEW_NODE_HEIGHT + QUEUE_GAP_Y;
const createdNodes = [];
for (let i = 0; i < batch.entries.length; i++) {
  const entry = batch.entries[i];
  const node = records.get(entry.nodeId);
  createdNodes.push(node);
  const expectedPos = queueNodePosition(batch.origin, i, undefined, { chapter: entry.chapter, shot: entry.shot, chapterSizes });
  assert.equal(node.props.w, H3_NEW_NODE_WIDTH);
  assert.equal(node.props.h, H3_NEW_NODE_HEIGHT);
  assert.equal(node.x, expectedPos.x, `entry ${i} x matches chapter-wrapped layout`);
  assert.equal(node.y, expectedPos.y, `entry ${i} y matches chapter-wrapped layout`);
  assert.equal(node.props.megapixels, 0.88);
  const expectedProps = shotQueueH3Props(batch.queue.chapters[entry.chapter].shots[entry.shot], context.plans[i].plan, batch.queue.defaults);
  for (const [key, value] of Object.entries(expectedProps)) {
    if (key === 'seedMode' || key === 'seed') continue;
    assert.deepEqual(node.props[key], value, 'render parameter unchanged: ' + key);
  }
  assert.equal(node.props.seedMode, '固定', 'prebuilt node freezes seedMode');
  if (entry.shot % QUEUE_ROW_LIMIT > 0) {
    const prev = records.get(batch.entries[i - 1].nodeId);
    assert.equal(node.x - prev.x - prev.props.w, QUEUE_GAP_X, 'adjacent cards in same row keep 100 horizontal gap');
    assert.equal(node.y, prev.y, 'cards in same row share y');
  } else {
    assert.equal(node.x, batch.origin.x, 'first card of each row aligns with origin.x');
  }
}
// 验证章内换行与章间空一行
const ch0Row0 = records.get(batch.entries[0].nodeId);
const ch0Row1 = records.get(batch.entries[10].nodeId);
const ch1Row0 = records.get(batch.entries[20].nodeId);
const ch2Row0 = records.get(batch.entries[40].nodeId);
assert.equal(ch0Row1.y - ch0Row0.y, rowStep, 'same-chapter wrap advances by one rowStep');
assert.equal(ch1Row0.y - ch0Row1.y, 2 * rowStep, 'chapter boundary leaves one blank row');
assert.equal(ch2Row0.y - ch1Row0.y, 3 * rowStep, 'chapter 2 starts after 2 rows of chapter 1 plus 1 blank row');
// 验证 49 个新建节点两两无重叠
for (let a = 0; a < createdNodes.length; a++) {
  for (let b = a + 1; b < createdNodes.length; b++) {
    const na = createdNodes[a], nb = createdNodes[b];
    const overlapX = na.x < nb.x + nb.props.w && nb.x < na.x + na.props.w;
    const overlapY = na.y < nb.y + nb.props.h && nb.y < na.y + na.props.h;
    assert.equal(overlapX && overlapY, false, `nodes ${a} and ${b} must not overlap`);
  }
}
assert.deepEqual(records.get('shape:legacy-unrelated'), legacy, 'unrelated legacy node untouched');

// 4. Resume saved nodes with historical/custom positions: never resize or re-layout.
for (let i = 0; i < batch.entries.length; i++) {
  const id = batch.entries[i].nodeId, node = records.get(id);
  records.set(id, { ...node, x: i * 660 + 17, y: i % 2 ? 912 : 29, props: { ...node.props, w: i % 2 ? 560 : 431, h: 644 } });
}
const saved = structuredClone([...records]);
await prebuild();
assert.equal(created, 49); assert.equal(persisted, 49);
assert.deepEqual([...records], saved, 'existing records byte-equivalent after resume');

// 5. Crash recovery: entry ID missing, but metadata-owned card already exists.
const recoveredId = batch.entries[0].nodeId;
delete batch.entries[0].nodeId;
await prebuild();
assert.equal(batch.entries[0].nodeId, recoveredId);
assert.equal(created, 49);
assert.deepEqual([...records], saved, 'metadata recovery does not move/resize existing cards');

// 6. Deleted node: never recreated, recorded as removedAt, remaining shots continue.
records.delete(batch.entries[1].nodeId);
const removedId = batch.entries[1].nodeId;
await prebuild();
assert.equal(created, 49, 'removed existing node must not be silently recreated');
assert.ok(batch.entries[1].removedAt, 'a node deleted from the canvas is recorded as removed');
assert.equal(batch.entries[1].nodeId, removedId);
assert.ok(!records.has(removedId));
assert.match(said.at(-1), /已从画布删除/);
assert.ok(batch.entries.slice(2).every(entry => !entry.removedAt), 'remaining shots are not blocked');
assert.equal(queueNodePosition({ x: 10, y: 20 }, 1, 560).x, 670);
console.log('PASS queue spacing: behavioral ref-ordering/defaults, 49-entry chapter-wrapped prebuild (10/row, 100 gap, blank row between chapters, zero overlap), resume/recovery immutability, deleted-node skip. CPU only.');
