// 2026-11-12 右键菜单瘦身（用户：「右击显示的东西太多了」）：顶层不超过 10 项，按节点类型显示，原来的功能一个不少。
// 纯逻辑 + 读源码检查接线；不开浏览器、不碰画布数据。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FRAMEFLOW_ITEMS, TLDRAW_ITEMS, contextMenuPlan, topLevelCount, allMenuItems } from "../lib/canvas-context-menu-plan.ts";

const ctx = (patch) => ({ selected: 0, videos: 0, singleVideo: false, demixable: 0, images: 0, reveal: null, ...patch });
const CONTEXTS = {
  "空白处": ctx({}),
  "一个视频节点": ctx({ selected: 1, videos: 1, singleVideo: true, demixable: 1, reveal: { many: false } }),
  "一个还没出片的 H3 节点": ctx({ selected: 1 }),
  "三个视频节点": ctx({ selected: 3, videos: 3, demixable: 3, reveal: { many: true } }),
  "一张图片": ctx({ selected: 1, images: 1, reveal: { many: false } }),
  "两张图片": ctx({ selected: 2, images: 2, reveal: { many: true } }),
  "一个音频节点": ctx({ selected: 1, reveal: { many: false } }),
  "视频 + 图片 混选": ctx({ selected: 3, videos: 2, demixable: 2, images: 1, reveal: { many: true } }),
  "别的节点（文字、箭头）": ctx({ selected: 2 }),
};
const name = (entry) => (typeof entry === "string" ? FRAMEFLOW_ITEMS[entry] ?? TLDRAW_ITEMS[entry] : `${entry.label} ▸`);
const plans = Object.fromEntries(Object.entries(CONTEXTS).map(([key, value]) => [key, contextMenuPlan(value)]));
const top = (key) => plans[key].flat().map(name);
const has = (key, id) => allMenuItems(plans[key]).includes(id);

// ── 1. 每种情况顶层不超过 10 项 ──
// 例外（2026-11-18）：选了好几个视频时顶层多一项「复制视频清单」（跟在一键粗剪后面），最多 11 项。
const MULTI_VIDEO = new Set(["三个视频节点", "视频 + 图片 混选"]);
for (const [key, plan] of Object.entries(plans)) assert.ok(topLevelCount(plan) <= (MULTI_VIDEO.has(key) ? 11 : 10), `${key}：顶层 ${topLevelCount(plan)} 项：${top(key).join("、")}`);

// ── 2. 改前的 30 来项，每一项都还在（逐项断言放在哪种情况下能找到） ──
const BEFORE = [
  ["ai-drama-cover", "一个视频节点"], ["compare-candidates", "一个视频节点"], ["promote-drafts", "一个视频节点"], ["audit-videos", "一个视频节点"],
  ["save-node-template", "一个视频节点"], ["node-templates", "空白处"], ["prompt-library", "空白处"],
  ["tail-frame-video", "一个视频节点"], ["tail-frame-hd-video", "一个视频节点"], ["capture-original-frame", "一个视频节点"], ["capture-ai-frame", "一个视频节点"],
  ["one-click-rough-cut", "一个视频节点"], ["one-click-rough-cut", "三个视频节点"], ["one-click-demix", "一个视频节点"], ["one-click-demix", "三个视频节点"],
  ["copy-video-list", "一个视频节点"], ["copy-video-list", "三个视频节点"], ["copy-video-list", "视频 + 图片 混选"],
  ["copy-selected-image-catalog", "一张图片"], ["copy-selected-image-catalog", "视频 + 图片 混选"],
  ["flux-text-to-image", "空白处"], ["text-to-voice", "空白处"], ["music-generation", "空白处"],
  ["flux-text-to-image", "一个视频节点"], ["text-to-voice", "一个视频节点"], ["music-generation", "一个视频节点"],
  ["compare-candidates", "空白处"], ["promote-drafts", "空白处"], ["audit-videos", "空白处"],
  ["delete-with-media", "一个视频节点"], ["delete-with-media", "一张图片"], ["delete-with-media", "一个音频节点"],
  // tldraw 自带
  ["tl-edit-items", "一个视频节点"], ["tl-arrange", "两张图片"], ["tl-reorder", "一个视频节点"], ["tl-move-to-page", "一个视频节点"],
  ["tl-cut", "一个视频节点"], ["tl-copy", "一个视频节点"], ["tl-paste", "空白处"], ["tl-paste", "一个视频节点"], ["tl-duplicate", "一个视频节点"],
  ["tl-delete", "一个视频节点"], ["tl-delete", "一张图片"], ["tl-copy-as", "一个视频节点"], ["tl-export-as", "一个视频节点"], ["tl-export-as", "空白处"],
  ["tl-download-original", "一张图片"], ["tl-select-all", "空白处"], ["tl-select-all", "一个视频节点"], ["tl-cursor-chat", "空白处"],
];
for (const [id, where] of BEFORE) assert.ok(has(where, id), `「${FRAMEFLOW_ITEMS[id] ?? TLDRAW_ITEMS[id]}」在「${where}」的菜单里找不到`);
for (const id of [...Object.keys(FRAMEFLOW_ITEMS), ...Object.keys(TLDRAW_ITEMS)]) {
  if (id === "reveal-in-folder") continue;
  assert.ok(BEFORE.some(([item]) => item === id), `改前的「${id}」没有逐项断言`);
}
assert.ok(has("一个视频节点", "reveal-in-folder") && has("一张图片", "reveal-in-folder") && has("一个音频节点", "reveal-in-folder"), "新加的打开所在文件夹");
assert.ok(!has("空白处", "reveal-in-folder") && !has("一个还没出片的 H3 节点", "reveal-in-folder"));

// ── 3. 顶层放常用的，和当前节点无关的不显示 ──
assert.deepEqual(top("一个视频节点"), ["打开所在文件夹", "候选并排对比", "试片转正 · 终极版", "成片质检", "一键去背景音", "接着做 ▸", "AI 工具 · 模板 ▸", "编辑 ▸", "删除并清理素材文件", "删除"]);
assert.deepEqual(top("三个视频节点"), ["打开所在文件夹", "候选并排对比", "试片转正 · 终极版", "成片质检", "一键去背景音", "一键粗剪", "复制视频清单", "AI 工具 · 模板 ▸", "编辑 ▸", "删除并清理素材文件", "删除"]);
assert.deepEqual(top("一张图片"), ["打开所在文件夹", "复制图片名称＋ID", "AI 工具 · 模板 ▸", "编辑 ▸", "删除并清理素材文件", "删除"]);
assert.deepEqual(top("一个音频节点"), ["打开所在文件夹", "AI 工具 · 模板 ▸", "编辑 ▸", "删除并清理素材文件", "删除"]);
assert.deepEqual(top("空白处"), ["视频工具 ▸", "AI 工具 · 模板 ▸", "编辑 ▸"]);
for (const key of ["一张图片", "两张图片", "一个音频节点", "空白处", "别的节点（文字、箭头）"]) {
  for (const id of ["one-click-demix", "one-click-rough-cut", "copy-video-list", "tail-frame-video", "tail-frame-hd-video", "capture-original-frame", "capture-ai-frame"]) assert.ok(!has(key, id), `${key} 不该有「${FRAMEFLOW_ITEMS[id]}」`);
}
for (const key of ["一个视频节点", "一个音频节点", "空白处"]) assert.ok(!has(key, "copy-selected-image-catalog"), `${key} 没有图片，不显示复制图片名称`);
assert.ok(!has("空白处", "save-node-template") && !has("空白处", "delete-with-media") && !has("空白处", "tl-delete"), "空白处没选中东西：不显示保存模板、删除");
// 删除在最下面
for (const [key, plan] of Object.entries(plans)) if (CONTEXTS[key].selected) assert.deepEqual(plan.at(-1), ["delete-with-media", "tl-delete"], `${key}：删除放最下面`);
// 子菜单里的东西
const sub = (key, which) => plans[key].flat().find((entry) => typeof entry !== "string" && entry.submenu === which);
assert.deepEqual(sub("一个视频节点", "next").groups, [["tail-frame-video", "tail-frame-hd-video", "one-click-rough-cut", "copy-video-list"], ["capture-original-frame", "capture-ai-frame"]]);
const mixedTop = plans["视频 + 图片 混选"][0];
assert.equal(mixedTop.indexOf("copy-video-list"), mixedTop.indexOf("one-click-rough-cut") + 1, "复制视频清单紧跟在一键粗剪后面");
assert.equal(sub("三个视频节点", "next"), undefined, "多选视频没有尾帧 / 截图（它们只对一个视频）");
assert.deepEqual(sub("一个视频节点", "ai-templates").groups, [["ai-drama-cover", "flux-text-to-image", "text-to-voice", "music-generation"], ["save-node-template", "node-templates", "prompt-library"]]);
assert.deepEqual(sub("一个视频节点", "edit").groups[0], ["tl-cut", "tl-copy", "tl-paste", "tl-duplicate"]);
assert.ok(sub("视频 + 图片 混选", "edit").groups[0].includes("copy-selected-image-catalog"), "混选时复制图片名称在「编辑 ▸」的复制组");

// ── 4. 接线：每一项都有渲染；tldraw 默认菜单的每个组件都被接上；没有再整块塞 DefaultContextMenuContent ──
const menu = readFileSync(new URL("../components/canvas/flux-image-entry.tsx", import.meta.url), "utf8");
for (const id of [...Object.keys(FRAMEFLOW_ITEMS), ...Object.keys(TLDRAW_ITEMS)]) assert.match(menu, new RegExp(`case "${id}":return`), `菜单没有渲染 ${id}`);
assert.doesNotMatch(menu, /<DefaultContextMenuContent/, "tldraw 默认项不再整块追加在底下");
const tl = readFileSync(new URL("../node_modules/tldraw/src/lib/ui/components/ContextMenu/DefaultContextMenuContent.tsx", import.meta.url), "utf8");
const used = [...tl.matchAll(/<([A-Z][A-Za-z]+)\s*\/>/g)].map((m) => m[1]);
const covered = { EditMenuSubmenu: "tl-edit-items", ClipboardMenuGroup: "tl-cut", ConversionsMenuGroup: "tl-export-as" };
for (const component of used) assert.ok(covered[component] || menu.includes(`<${component}`), `tldraw 默认右键菜单的 ${component} 没接上`);
const clipboardAndConversions = readFileSync(new URL("../node_modules/tldraw/src/lib/ui/components/menu-items.tsx", import.meta.url), "utf8");
for (const fn of ["ClipboardMenuGroup", "ConversionsMenuGroup", "EditMenuSubmenu"]) {
  const body = clipboardAndConversions.slice(clipboardAndConversions.indexOf(`export function ${fn}()`)).split("\n/** @public")[0];
  for (const [, inner] of body.matchAll(/<([A-Z][A-Za-z]+MenuItem|[A-Z][A-Za-z]+MenuGroup)\s*\/>/g)) {
    const ok = menu.includes(`<${inner}`) || (inner === "FlattenMenuItem" && /actionId="flatten-to-image"/.test(menu)) || (inner === "FrameSelectionMenuItem" && /actionId="frame-selection"/.test(menu)) || (inner === "DownloadOriginalMenuItem" && /actionId="download-original"/.test(menu));
    assert.ok(ok, `tldraw ${fn} 里的 ${inner} 没接上`);
  }
}

console.log("context menu plan: ≤10 top-level items for every node type, every old item still reachable, tldraw defaults all wired; ok");
for (const key of Object.keys(plans)) console.log(`  ${key}（${topLevelCount(plans[key])}）：${top(key).join(" / ")}`);
