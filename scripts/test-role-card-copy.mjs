import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('components/role-library.tsx', 'utf8');
const role = { roleId: '0144d66a-9f9c-4000-8000-123456789abc', displayName: '沈宴', appearanceAssetIds: [], voiceAssetIds: [], description: '' };
const copied = [], setters = [];
let stateIndex = 0, copyOK = true;
const element = (type, props, ...children) => ({ type, props: { ...props, children } });
const react = {
  createElement: element,
  useState(initial) { const index = stateIndex++; return [index === 0 ? [role] : initial, value => setters.push({ index, value })]; },
  useEffect() {}, useRef() { return { current: null }; },
};
const exports = {};
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
vm.runInNewContext(js, {
  exports, React: react, document: { body: {} },
  require(name) {
    if (name === 'react') return react;
    if (name === 'react-dom') return { createPortal: tree => tree };
    if (name === '@/lib/copy-plain-text') return { copyPlainText: async text => { copied.push(text); return copyOK; } };
    // Any data write would fail: no record mutation functions are provided.
    return {};
  },
});
const tree = exports.RoleLibrary({ onClose() {}, onUpload() { throw Error('unexpected upload'); } });
const buttons = [];
function walk(node, insideButton = false) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(child => walk(child, insideButton));
  if (node.type === 'button') { assert.equal(insideButton, false, 'no nested buttons'); buttons.push(node); }
  walk(node.props?.children, insideButton || node.type === 'button');
}
walk(tree);
const copy = buttons.find(button => button.props.className === 'role-card-copy');
assert.ok(copy);
assert.equal(copy.props['aria-label'], '复制沈宴的名称和ID');
copy.props.onClick();
await new Promise(resolve => setImmediate(resolve));
assert.equal(copied[0], `角色名称：沈宴\nroleId: ${role.roleId}`);
assert.ok(setters.some(item => item.value === '已复制“沈宴”的名称和完整 ID'));
assert.ok(!setters.some(item => item.index === 2), 'copy must not select/open role');
copyOK = false;
copy.props.onClick();
await new Promise(resolve => setImmediate(resolve));
assert.ok(setters.some(item => String(item.value).startsWith('复制失败')));
console.log('PASS: complete name/ID copy, success/failure feedback, independent accessible buttons, no detail navigation or record writes. CPU component harness, not live clipboard acceptance.');
