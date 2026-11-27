import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Stage I: static resource-hygiene audit. Every listener / interval / observer / channel / Object URL
 * created in app, components and lib must have its release in the same file, or a documented
 * ownership contract below. This is a guard against leaks creeping in; it does not replace review.
 */
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
async function files(dir) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}
/** Files that create something whose release is intentionally elsewhere, with the reason. */
const CONTRACTS = {
  "lib/local-video-store.ts:createObjectURL": "resolveVideoSource returns { revoke: true } for data: sources; the caller revokes (checked in callers). Persisted media URLs are owned by the ObjectUrlRegistry.",
  "lib/object-url-registry.ts:createObjectURL": "The registry itself: revokes on release after the grace period (tested in test-performance).",
  "lib/asset-library.ts:createObjectURL": "OwnedObjectUrls.revokeAll() on drawer close (tested in test-asset-library).",
  "app/canvas-workspace.tsx:addEventListener(\"error\")": "module-level ResizeObserver-notice filter, registered once for the page lifetime (not per component).",
  "components/in-page-dialog.tsx:addEventListener(\"keydown\")": "module-level key guard for the shared in-page confirm, registered once at import so it runs before every panel's own listener; idle when no dialog is open.",
  "lib/production-records.ts:BroadcastChannel": "one module-level sender, unref'd; lives for the page (notification only).",
};
const problems = [];
const report = [];
for (const path of [...await files("app"), ...await files("components"), ...await files("lib")]) {
  const rel = relative(root, join(root, path)).replace(/\\/g, "/");
  const text = await readFile(join(root, path), "utf8");
  const count = (re) => (text.match(re) ?? []).length;
  const allowed = (what) => CONTRACTS[`${rel}:${what}`];

  // Listeners: each event name added must also be removed (unless once / signal-bound).
  for (const match of text.matchAll(/\.addEventListener\(\s*("[^"]+"|[A-Z_]+|[a-zA-Z.]+)\s*,[^;]*?\)/g)) {
    const name = match[1];
    const call = match[0];
    if (/once:\s*true|signal:/.test(call)) continue;
    const removed = new RegExp(`removeEventListener\\(\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text);
    if (!removed && !allowed(`addEventListener(${name})`)) problems.push(`${rel}: addEventListener(${name}) without removeEventListener`);
  }
  const intervals = count(/\bsetInterval\(/g); if (intervals && !count(/\bclearInterval\(/g)) problems.push(`${rel}: setInterval without clearInterval`);
  const observers = count(/new (?:Resize|Intersection|Mutation|Performance)Observer\(/g); if (observers && !count(/\.disconnect\(/g)) problems.push(`${rel}: observer without disconnect()`);
  const channels = count(/new BroadcastChannel\(/g); if (channels && !count(/\.close\(\)|\.unref\?\.\(\)/g) && !allowed("BroadcastChannel")) problems.push(`${rel}: BroadcastChannel without close()`);
  const urls = count(/URL\.createObjectURL\(|api\.createObjectURL\(/g);
  if (urls && !count(/revokeObjectURL\(/g) && !allowed("createObjectURL")) problems.push(`${rel}: createObjectURL without revokeObjectURL`);
  if (urls || intervals || observers || channels) report.push(`${rel}: urls ${urls}/${count(/revokeObjectURL\(/g)} · intervals ${intervals}/${count(/\bclearInterval\(/g)} · observers ${observers}/${count(/\.disconnect\(/g)} · channels ${channels}`);
}
console.log(report.map((line) => `  ${line}`).join("\n"));
assert.deepEqual(problems, [], `resource hygiene problems:\n${problems.join("\n")}`);
console.log("Resource hygiene: listeners, intervals, observers, channels and Object URLs are released (or have a documented owner) in app / components / lib passed");
