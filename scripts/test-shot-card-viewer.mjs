import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { refNav, refSequence, versionStatus, versionTag, viewerKey, viewerNav, viewerSequence } from "../lib/shot-card-viewer.ts";

const ver = (assetId, label, extra = {}) => ({ assetId, label, stale: false, adopted: false, demixPasses: 0, ...extra });
const shot = (title, chosenId, versions) => ({ key: title, title, code: title, name: title, chosenId, versions });

// 卡片顺序：01 有视频，02 没出过，03 有，04 chosenId 指向已删掉的那条（当没视频），05 有。
const shots = [
  shot("01", "a1", [ver("a1", "A")]),
  shot("02", null, []),
  shot("03", "c2", [ver("c1", "A"), ver("c2", "B", { adopted: true })]),
  shot("04", "gone", [ver("d1", "A")]),
  shot("05", "e1", [ver("e1", "A")]),
];
const seq = viewerSequence(shots);
assert.deepEqual(seq.map((item) => item.title), ["01", "03", "05"], "按卡片顺序，跳过没视频的镜头");

// 首条：上一条变灰；尾条：下一条变灰；中间两边都能点。
assert.deepEqual(viewerNav(seq, "01"), { index: 0, prev: null, next: "03" });
assert.deepEqual(viewerNav(seq, "03"), { index: 1, prev: "01", next: "05" });
assert.deepEqual(viewerNav(seq, "05"), { index: 2, prev: "03", next: null });
assert.deepEqual(viewerNav(seq, "02"), { index: -1, prev: null, next: null }, "不在顺序里的镜头两边都灰");
assert.deepEqual(viewerNav(viewerSequence([shots[0]]), "01"), { index: 0, prev: null, next: null }, "只有一条时两边都灰");

// 按键。
assert.equal(viewerKey("Escape"), "close");
assert.equal(viewerKey("ArrowLeft"), "prev");
assert.equal(viewerKey("ArrowRight"), "next");
assert.equal(viewerKey("ArrowUp"), null);
assert.equal(viewerKey(" "), null);

// 标签：原声 / 去配乐版 / 去配乐 ×2。
const versions = [ver("o", "A"), ver("b", "B"), ver("m", "C", { demixPasses: 1, sourceVideoAssetId: "b" }), ver("m2", "D", { demixPasses: 2, sourceVideoAssetId: "b" })];
assert.equal(versionTag(versions[0], versions), "A");
assert.equal(versionTag(versions[2], versions), "C · B 的去配乐版");
assert.equal(versionTag(versions[3], versions), "D · B 的去配乐 ×2 版");
assert.equal(versionTag(ver("x", "E", { demixPasses: 1, sourceVideoAssetId: "missing" }), versions), "E · 去配乐版");
assert.equal(versionStatus(ver("a", "A", { adopted: true }), "a"), "★ 已采用 · 原声版");
assert.equal(versionStatus(ver("a", "A"), "a"), "最新 · 原声版");
assert.equal(versionStatus(ver("m", "C", { demixPasses: 1, stale: true }), "a"), "候选 · 去配乐版 · 旧提示词出的");

// 参考图：只在这一镜的图之间，按 P1 → P2 → … 走（不按场景 / 角色分组的显示顺序），没地址的跳过。
const refs = [
  { tag: "P3", group: "角色", name: "张三", src: "img:3" },
  { tag: "P1", group: "场景", name: "张三办公室", src: "img:1" },
  { tag: "P10", group: "角色", name: "路人", src: "img:10" },
  { tag: "P4", group: "角色", name: "李四", src: "img:4" },
  { tag: "P2", group: "首帧", name: "首帧", src: "img:2" },
  { tag: "P5", group: "角色", name: "没有图", src: "" },
];
const order = refSequence(refs);
assert.deepEqual(order.map((item) => item.tag), ["P1", "P2", "P3", "P4", "P10"]);
assert.deepEqual(refNav(order, "P1"), { index: 0, prev: null, next: "P2" });
assert.deepEqual(refNav(order, "P3"), { index: 2, prev: "P2", next: "P4" });
assert.deepEqual(refNav(order, "P10"), { index: 4, prev: "P4", next: null });

// 接线：Esc 先关放大层不关整张卡片；放大层释放受管 URL、只放一条、不用浏览器全屏、不改已采用。
const board = await readFile(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8");
const viewer = await readFile(new URL("../components/shot-card-video-viewer.tsx", import.meta.url), "utf8");
assert.match(board, /\.rough-cut-panel, \.ab-shade, \.scv-shade/, "卡片的 Esc 在放大层打开时不关卡片");
assert.match(board, /<ShotVideoViewer /);
assert.match(board, /zoom: \(\) => setViewing\(card\.shot\.title\)/);
assert.match(viewer, /acquireMediaUrl\(source\)/);
assert.match(viewer, /releaseMediaUrl\(held\.key\)/);
assert.match(viewer, /releaseMediaUrl\(media\.key\)/, "关掉后才拿到的地址也要释放");
assert.match(viewer, /video\.pause\(\); video\.removeAttribute\("src"\)/, "切走时暂停并清掉 src");
assert.match(viewer, /querySelectorAll<HTMLVideoElement>\("\.sc-root video"\)/, "打开时暂停卡片里其他视频");
assert.doesNotMatch(viewer, /requestFullscreen/);
assert.doesNotMatch(viewer, /adoptShotAsset|onChoose|\.choose\(/, "放大层里切 A/B/C 不改已采用");
assert.doesNotMatch(viewer.slice(viewer.indexOf("VIEWER_STYLE")), /#fff\b|#ffffff|background:\s*white/i, "按钮不用白底");

console.log("shot card viewer: order skips shots without video, first/last buttons disabled, ←/→/Esc, demix tags, URL released; ok");
// 参考图放大：同一个放大层，受管地址会释放，只看不改。
const refPart = viewer.slice(viewer.indexOf("export function RefImageViewer"), viewer.indexOf("export const VIEWER_STYLE"));
assert.match(refPart, /acquireMediaUrl\(source\)/);
assert.match(refPart, /releaseMediaUrl\(held\.key\)/);
assert.match(refPart, /useViewerKeys\(nav\.prev, nav\.next, go, onClose\)/);
assert.match(refPart, /className="scv-shade"/);
assert.doesNotMatch(refPart, /onChange|save\(|createNode/);
assert.match(board, /zoomRef: \(tag\) => setViewingRef\(\{ key: card\.key, tag \}\)/);
// ── 参考图 ID（2026-11-12 用户：「这个上面带上图片ID，还要能复制」「角色也是的」） ──
{
  const { refIds, clipMiddle } = await import("../lib/shot-card-viewer.ts");
  const ROLE = "c68aa343-fccb-4877-a776-2fc30bef7df0", LOOK = "asset_look_000000000001", SCENE = "asset_scene_00000000001";
  assert.deepEqual(refIds({ roleId: ROLE, assetId: LOOK }), [{ kind: "角色 ID", id: ROLE }, { kind: "图片 ID", id: LOOK }], "角色图：角色 ID 在前，外观图片 ID 在后，分清楚");
  assert.deepEqual(refIds({ assetId: SCENE }), [{ kind: "图片 ID", id: SCENE }], "场景图：sceneAssetIds 里那个图片 ID");
  assert.deepEqual(refIds({}), []);
  assert.equal(clipMiddle(ROLE), "c68aa343…2fc30bef7df0"); assert.equal(clipMiddle("short-id"), "short-id");
  const viewer = await readFile(new URL("../components/shot-card-video-viewer.tsx", import.meta.url), "utf8");
  assert.match(viewer, /<code title=\{item\.id\}>\{clipMiddle\(item\.id\)\}<\/code><button[^>]*onClick=\{\(\) => void copyPlainText\(item\.id, `已复制\$\{item\.kind\}`\)\}>复制<\/button>/, "放大层：截中间、悬停全文、复制纯 ID、右下角提示");
  assert.match(board, /roleId: picture\.roleId, assetId: picture\.assetId \}\)\)\} \/>/, "卡片把 ID 传给放大层");
  assert.match(board, /\.\.\.\(role \? \{ roleId: role\.roleId \} : \{\}\), \.\.\.\(\(role\?\.appearance\?\.assetId \?\? scene\?\.assetId\)/, "角色图带角色 ID + 外观图片 ID，场景图带场景图片 ID");
  assert.match(board, /<Thumb key=\{picture\.label\} ids=\{refIds\(picture\)\}/, "格子悬停显示 ID");
  assert.match(board, /onContextMenu=\{first \? \(event\) => \{ event\.preventDefault\(\); copyId\(\); \}/, "格子右键复制");
  assert.match(board, /shotLabel=\{`镜头 \$\{code\} · \$\{name\}`\}/, "顶栏右边写明是哪一镜（以前只写「1 又绕回原样了」像漏出来的提示）");
}
console.log("shot card viewer: reference images P1 → P2 → … in the same viewer; IDs shown + copyable; ok");
