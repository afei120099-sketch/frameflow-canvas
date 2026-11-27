import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { deleteWithRestore } from '../lib/canvas-delete-undo.ts';

function fixture() {
  const initial = [
    { id: 'node', typeName: 'shape', x: 10 },
    { id: 'arrow', typeName: 'shape', end: 'node' },
    { id: 'binding', typeName: 'binding', toId: 'node' },
    { id: 'other', typeName: 'shape', x: 20 },
  ];
  const records = new Map(initial.map(r => [r.id, r]));
  const editor = {
    store: { allRecords: () => [...records.values()], get: id => records.get(id),
      remove: ids => ids.forEach(id => records.delete(id)), put: rows => rows.forEach(r => records.set(r.id, r)) },
    markHistoryStoppingPoint() {}, run: callback => callback(),
    deleteShapes() { records.delete('node'); records.delete('binding'); records.set('arrow', { id: 'arrow', typeName: 'shape', end: null }); },
  };
  return { editor, records, initial };
}
{
  const { editor, records, initial } = fixture();
  const restore = deleteWithRestore(editor, ['node']);
  records.set('other', { id: 'other', typeName: 'shape', x: 999 });
  assert.equal(restore(), true);
  for (const r of initial.filter(r => r.id !== 'other')) assert.deepEqual(records.get(r.id), r);
  assert.equal(records.get('other').x, 999, 'later unrelated edits survive');
  assert.equal(restore(), false, 'toast undo is one-shot');
}
{
  const { editor, records } = fixture();
  const restore = deleteWithRestore(editor, ['node']);
  records.set('arrow', { id: 'arrow', typeName: 'shape', end: 'new-target' });
  assert.equal(restore(), false, 'never overwrite a subsequently edited edge');
  assert.equal(records.has('node'), false);
}

const source = await readFile(new URL('../components/canvas/slot-drop-feedback.ts', import.meta.url), 'utf8');
const nearestUrl = new URL('../lib/frame-drop-target.ts', import.meta.url).href;
const compiled = ts.transpileModule(source.replace('"../../lib/frame-drop-target"', JSON.stringify(nearestUrl))
  .replace('import { showDropFeedback } from "./interaction-ui";', 'const showDropFeedback = value => globalThis.feedback = value;'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { findVisibleSlot, trackImageSlotDragging, currentImageSlotTarget } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const handlers = new Map();
const card = {
  dataset: { frameRole: 'reference' }, attributes: {}, disabled: false,
  closest(selector) { return selector === '.h3-creative-dock' ? { dataset: { nodeId: 'h3' } } : null; },
  matches() { return this.disabled; }, querySelector() { return null; },
  getBoundingClientRect: () => ({ left: 100, top: 100, right: 180, bottom: 180, width: 80, height: 80 }),
  setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; },
};
const nodes = new Map([['h3', { id: 'h3', type: 'h3-node' }], ['image1', { id: 'image1', type: 'image-node' }], ['image2', { id: 'image2', type: 'image-node' }]]);
const editor = { getShape: id => nodes.get(id), isIn: () => true, getSelectedShapeIds: () => ['image1', 'image2'] };
globalThis.document = {
  querySelectorAll: () => [card],
  addEventListener: (name, callback) => handlers.set(name, callback),
  removeEventListener: name => handlers.delete(name),
};
assert.equal(findVisibleSlot(editor, { x: 140, y: 140 }, [], 'image-node').role, 'reference');
assert.equal(findVisibleSlot(editor, { x: 140, y: 140 }, ['h3'], 'image-node'), null);
card.disabled = true;
assert.equal(findVisibleSlot(editor, { x: 140, y: 140 }, [], 'image-node'), null);
card.disabled = false;
nodes.get('h3').isLocked = true;
assert.equal(findVisibleSlot(editor, { x: 140, y: 140 }, [], 'image-node'), null);
nodes.get('h3').isLocked = false;
const stop = trackImageSlotDragging(editor);
handlers.get('pointermove')({ clientX: 140, clientY: 140 });
assert.equal(currentImageSlotTarget(editor).role, 'reference');
assert.equal(globalThis.feedback.valid, true);
assert.match(globalThis.feedback.label, /2 张/);
card.dataset.frameRole = 'first';
handlers.get('pointermove')({ clientX: 140, clientY: 140 });
assert.equal(currentImageSlotTarget(editor), null);
assert.equal(globalThis.feedback.valid, false);
stop();
assert.equal(handlers.size, 0);
assert.equal(globalThis.feedback, null);
assert.equal(card.attributes['data-magnetic'], undefined);
delete globalThis.document;
delete globalThis.feedback;
console.log('Canvas interaction tests passed: deletion delta, safe undo, slot eligibility, multi-image feedback and cleanup.');
