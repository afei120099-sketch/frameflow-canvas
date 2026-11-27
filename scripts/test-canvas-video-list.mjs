// 2026-11-18 右键「复制视频清单」：按画布位置排序 + 拼纯文本。纯逻辑，不开浏览器、不碰画布数据。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readingOrder, formatVideoList, cleanTitle, NOT_LOCAL, COPY_VIDEO_LIST_EVENT } from "../lib/canvas-video-list.ts";

const box = (id, x, y, w = 300, h = 200) => ({ id, box: { x, y, w, h } });
const order = (items) => readingOrder(items, (item) => item.box).map((item) => item.id);

// ── 1. 先按行，同一行从左到右；和选中的先后无关 ──
assert.deepEqual(order([box("b", 400, 0), box("d", 400, 300), box("a", 0, 0), box("c", 0, 300)]), ["a", "b", "c", "d"], "两行两列");
assert.deepEqual(order([box("a", 0, 0), box("b", 400, 90)]), ["a", "b"], "y 中心差 90 < 较矮高度一半 100：同一行");
assert.deepEqual(order([box("b", 0, 120), box("a", 400, 0)]), ["a", "b"], "差 120 ≥ 100：不同行，上面的先");
assert.deepEqual(order([box("tall", 400, 0, 300, 600), box("short", 0, 300, 300, 100)]), ["tall", "short"], "按较矮的高度算：中心差 50 不小于矮的一半 50，不同行（矮的在下面）");
assert.deepEqual(order([box("tall", 400, 0, 300, 600), box("short", 0, 260, 300, 100)]), ["short", "tall"], "中心差 10 < 50：同一行，左边的先");
// 错落摆放不会一行越拖越斜：和行首比，不和上一个比（和上一个比的话 c 会并进第一行排到最前）
assert.deepEqual(order([box("a", 400, 0), box("b", 800, 80), box("c", 0, 160)]), ["a", "b", "c"], "c 和行首差 160 ≥ 100 → 新一行");
assert.deepEqual(order([box("c", 0, 160), box("b", 800, 80), box("a", 400, 0)]), ["a", "b", "c"], "和选中先后无关");
assert.deepEqual(order([box("x", 0, 0), { id: "nobox", box: null }, box("y", 400, 0)]), ["x", "y", "nobox"], "拿不到位置的放最后");
assert.deepEqual(order([box("p", 0, 0), box("q", 0, 0)]), ["p", "q"], "完全重叠：保持原顺序");

// ── 2. 文本格式 ──
const text = formatVideoList([
  { title: "EP10-v1-10-1｜镜头1", path: "C:\\ComfyUI_windows_portable\\ComfyUI\\output\\video\\Frameflow_H3_ultimate_01732-audio.mp4" },
  { title: "", path: null },
  { title: "第三\n镜", path: "C:\\data\\c.mp4" },
]);
assert.equal(text, [
  "共 3 个视频（按画布从左到右、从上到下排序）",
  "01｜EP10-v1-10-1｜镜头1｜C:\\ComfyUI_windows_portable\\ComfyUI\\output\\video\\Frameflow_H3_ultimate_01732-audio.mp4",
  `02｜未命名｜${NOT_LOCAL}`,
  "03｜第三 镜｜C:\\data\\c.mp4",
  "其中 1 个没找到本机文件：序号 02",
].join("\n"));
assert.ok(!formatVideoList([{ title: "a", path: "D:\\a.mp4" }]).includes("其中"), "全找到时不加末尾那行");
const many = formatVideoList(Array.from({ length: 120 }, (_, i) => ({ title: `镜${i}`, path: i === 104 ? null : `D:\\${i}.mp4` })));
assert.match(many, /^001｜镜0｜/m, "超过 99 个用三位序号");
assert.match(many, /^120｜镜119｜/m);
assert.match(many, /其中 1 个没找到本机文件：序号 105$/);
assert.equal(formatVideoList(Array.from({ length: 99 }, () => ({ title: "x", path: null }))).split("\n")[1].slice(0, 3), "01｜", "99 个以内两位");
assert.equal(cleanTitle("  "), "未命名");

// ── 3. 接线：菜单发事件、执行端接上、用的是粗剪同一个判定和「当前显示那一版」的 resolveAsset ──
const menu = readFileSync(new URL("../components/canvas/flux-image-entry.tsx", import.meta.url), "utf8");
assert.match(menu, /case "copy-video-list":return item\(id,`\$\{label\(id\)\}（\$\{state\.videoIds\.length\}个视频）`,\(\)=>emit\(COPY_VIDEO_LIST_EVENT,\{ids:state\.videoIds\}\)\)/);
const runner = readFileSync(new URL("../components/canvas/copy-video-list.tsx", import.meta.url), "utf8");
assert.match(runner, /isCuttableVideo/, "和一键粗剪同一个「选中的视频」判定");
assert.match(runner, /locateLocalFiles/, "用只查不开的接口");
assert.doesNotMatch(runner, /revealLocalFile|__file\/reveal/, "不调用会打开资源管理器的接口");
const workspace = readFileSync(new URL("../app/canvas-workspace.tsx", import.meta.url), "utf8");
assert.match(workspace, /<CopyVideoList editor=\{editor\} resolveAsset=\{resolveRevealAsset\} \/>/, "用「打开所在文件夹」同一个 resolveAsset");
assert.equal(COPY_VIDEO_LIST_EVENT, "frameflow-copy-video-list");

console.log("canvas video list: reading order, text format, wiring; ok");
