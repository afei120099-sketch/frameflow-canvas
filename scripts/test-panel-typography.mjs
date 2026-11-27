import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Use the CSS parser already installed with Vite; no new dependency or network.
const requireVite = createRequire(import.meta.resolve("vite"));
const postcss = requireVite("postcss");
// Batch C has its own strict scope test; keep this test checking every pre-existing A rule.
const after = postcss.parse(readFileSync(new URL("../app/globals.css", import.meta.url), "utf8").replace(/\/\* Batch C scoped typography: begin \*\/[\s\S]*?\/\* Batch C scoped typography: end \*\//, ""));
const allowed = /^\.(?:asset-library-|role-(?!add-select|chip)|shot-board|shot-queue-|shot-candidate-|backup-|error-center|diagnostics|autopilot|director-stage|ff-panel|app-bar\b|save-state\b|version-pill\b|canvas-library-bar\b|generation-info-panel|generation-info-backdrop)/;
let fonts = 0;
after.walkDecls("font-size", decl => {
  if (!decl.value.includes("--fs-")) return;
  assert.ok(decl.parent.selectors.every(selector => allowed.test(selector)), `node/unapproved selector changed: ${decl.parent.selector}`);
  const match = /^var\(--fs-(\d+)\)$/.exec(decl.value);
  assert.ok(match && Number(match[1]) >= 5 && Number(match[1]) <= 16);
  decl.value = `${match[1]}px`;
  fonts++;
});
assert.ok(fonts >= 60, "panel font declarations must be scaled");
after.walkDecls(decl => {
  if (/^--fs-(?:scale|\d+)$/.test(decl.prop)) {
    assert.equal(decl.parent.selector, ":root");
    assert.equal(decl.value, decl.prop === "--fs-scale" ? "1.28" : `calc(${decl.prop.slice(5)}px * var(--fs-scale))`);
    decl.remove();
  }
});
// Only the save-state colour is in batch A. Video/H3 colours stay unchanged.
after.walkRules(".save-state", rule => rule.walkDecls("color", decl => {
  if (decl.value === "var(--ff-text-3)") decl.value = "var(--ff-text-4)";
}));
// Split mixed selector: the non-whitelisted asset picker keeps its old font.
after.walkRules(".role-card small,.role-hint", rule => {
  assert.equal(rule.nodes.length, 1);
  assert.equal(rule.first.prop, "font-size");
  assert.equal(rule.first.value, "11px");
  rule.remove();
});
console.log(`PASS panel typography: ${fonts} scoped declarations; mixed selector isolated`);
