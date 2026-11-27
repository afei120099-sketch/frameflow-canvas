import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { parseSplitPages } from '../lib/frameflow-instance.ts';
import { readVocab } from './zhengben-helper.mjs';

assert.deepEqual(parseSplitPages(''), []);
const rows = parseSplitPages(JSON.stringify([{ id: 'sample', label: '示例项目', port: 5174, inboxPort: 5194, claimPort: 8804 }]));
assert.equal(rows[0].match(' 示例项目 '), true);
assert.equal(rows[0].match('其他页面'), false);
for (const input of ['{}', '[{}]', JSON.stringify([{ id: '../bad', label: 'A', port: 5174 }])]) assert.throws(() => parseSplitPages(input));
assert.throws(() => parseSplitPages(JSON.stringify([{ id: 'a', label: 'A', port: 5174, inboxPort: 5174, claimPort: 8804 }])));

const dir = await mkdtemp(join(tmpdir(), 'frameflow-portability-'));
try {
  const file = join(dir, 'vocab.json');
  assert.deepEqual((await readVocab(file)).vocab, {});
  assert.equal((await readVocab(file)).ok, true);
  await writeFile(file, JSON.stringify({ camera: [['固定', 'static']] }));
  assert.deepEqual((await readVocab(file)).vocab, { camera: [['固定', 'static']] });
  await writeFile(file, '{invalid');
  assert.equal((await readVocab(file)).ok, false);
} finally { await rm(dir, { recursive: true, force: true }); }

const source = await readFile(new URL('../components/inbox-delete.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('delete.ts', source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'runInboxDelete').getText(ast).replace(/^export /, '');
for (const switchPage of [false, true]) {
  const assetId = '00000000-0000-4000-8000-00000000000a';
  const reports = [], deleted = [];
  let page = 'page:active';
  const shape = { id: 'shape:a', type: 'image-node', parentId: page, props: { assetId } };
  const context = vm.createContext({ crypto, TextEncoder, Uint8Array, URLSearchParams, fetch: async () => ({ text: async () => JSON.stringify({ assetIds: [assetId] }) }), getAsset: async () => ({ assetId }), inspectNodeRemoval: async () => ({ ok: true, ids: [shape.id] }) });
  const run = vm.runInContext(ts.transpileModule(fn + '; runInboxDelete;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const editor = { getCurrentPageId: () => page, getPageShapeIds: id => { assert.equal(id, 'page:active'); return deleted.length ? [] : [shape.id]; }, getShape: () => shape, deleteShapes: ids => deleted.push(...ids) };
  await run(editor, 'sample', [{ name: '_delete.json' }], async (project, name, report) => { reports.push({ name, report }); if (switchPage && name.includes('backup')) page = 'page:other'; });
  assert.equal(deleted.length, switchPage ? 0 : 1);
  assert.equal(reports.at(-1).report.state, switchPage ? 'waiting' : 'done');
  assert.equal(reports[0].report.page, 'page:active');
}
console.log('PASS public portability: configurable split pages, optional vocab, active-page deletion, backup and page-switch guard');
