import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { isTypingTarget } from "../lib/keyboard-guards.ts";

// Test without a browser, persistence, network, or GPU. Synthetic elements only.
assert.equal(isTypingTarget(null), false);
const originalHTMLElement = globalThis.HTMLElement;
class TestElement { constructor(tagName, isContentEditable = false) { this.tagName = tagName; this.isContentEditable = isContentEditable; } }
globalThis.HTMLElement = TestElement;
try {
  for (const tag of ["INPUT", "SELECT", "TEXTAREA"]) assert.equal(isTypingTarget(new TestElement(tag)), true);
  assert.equal(isTypingTarget(new TestElement("SPAN", true)), true);
  assert.equal(isTypingTarget(new TestElement("BUTTON")), false);
  assert.equal(isTypingTarget(new EventTarget()), false);

  // Extract the actual component handlers with TypeScript's parser, not a copied implementation.
  for (const [file, expected] of [["asset-library.tsx", 1], ["shot-board.tsx", 1], ["role-library.tsx", 2], ["shot-queue-panel.tsx", 1]]) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const handlers = [];
    const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "onKey") handlers.push(node.initializer.getText(parsed)); ts.forEachChild(node, visit); };
    visit(parsed);
    assert.equal(handlers.length, expected, `${file} handler coverage`);
    for (const handler of handlers) {
      let closed = 0, visible = true;
      const context = vm.createContext({ isTypingTarget, onClose: () => closed++, pickerKind: null, hasQueue: { current: false }, setDrawerOpen: () => {}, document: { querySelector: () => null }, panel: { current: { getClientRects: () => visible ? [{}] : [] } } });
      const js = ts.transpileModule(`const onKey = ${handler}; onKey;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      const onKey = vm.runInContext(js, context);
      const event = (target, extra = {}) => ({ key: "Escape", isComposing: false, target, stopPropagation() {}, ...extra });
      for (const tag of ["INPUT", "SELECT", "TEXTAREA"]) onKey(event(new TestElement(tag)));
      onKey(event(new TestElement("SPAN", true)));
      onKey(event(new TestElement("BUTTON"), { isComposing: true }));
      onKey(event(new TestElement("BUTTON"), { key: "Enter" }));
      assert.equal(closed, 0, `${file}: editing/composition/non-Escape must not close`);
      if (file === "shot-queue-panel.tsx") { visible = false; onKey(event(new TestElement("BUTTON"))); assert.equal(closed, 0, "hidden queue must not consume Escape"); visible = true; }
      if (handler.includes("!pickerKind")) { context.pickerKind = "image"; onKey(event(new TestElement("BUTTON"))); assert.equal(closed, 0, "role picker handles its own Escape"); context.pickerKind = null; }
      onKey(event(new TestElement("BUTTON")));
      assert.equal(closed, 1, `${file}: non-editing Escape closes panel`);
    }
  }
} finally {
  if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
  else globalThis.HTMLElement = originalHTMLElement;
}
console.log("PASS panel Escape: five actual handlers, typing/contenteditable/IME guards, hidden queue, nested picker");
