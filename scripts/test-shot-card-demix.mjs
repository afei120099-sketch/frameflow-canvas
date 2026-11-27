// 镜头卡片里的去配乐：按钮状态、整集只挑没处理过的、和画布节点用同一个提交函数。ComfyUI 不会被调用。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import "./fake-indexeddb.mjs";
import { registerAsset, putMeta } from "../lib/production-records.ts";
import { enqueueMusicRemoval, refreshDemixJobs, resetMusicRemovalMemory, MUSIC_REMOVAL_STATE_KEY } from "../lib/music-removal.ts";
import { cardDemixState, planEpisodeDemix } from "../lib/shot-card-demix.ts";

const src = (id, extra = {}) => ({ assetId: id, derivationType: undefined, ...extra });
const out = (id, from, passes = 1) => ({ assetId: id, derivationType: "music_removal", sourceVideoAssetId: from, musicRemovalPasses: passes });
const row = (jobs) => ({ version: 1, jobs: Object.fromEntries(jobs.map((job) => [job.sourceAssetId, { updatedAt: 1, ...job }])) });

// ---------- 按钮状态（和画布节点 DemixNodeControl 同一套规则） ----------
assert.deepEqual([cardDemixState(src("a"), [src("a")], null).sound, cardDemixState(src("a"), [src("a")], null).action.label], ["原声版", "去配乐"]);
assert.equal(cardDemixState(src("a"), [], row([{ sourceAssetId: "a", state: "waiting" }])).action.kind, "busy");
assert.equal(cardDemixState(src("a"), [], row([{ sourceAssetId: "a", state: "running", stage: "正在去配乐" }])).action.label, "正在去配乐…");
const failed = cardDemixState(src("a"), [], row([{ sourceAssetId: "a", state: "failed", error: "显存不够" }])).action;
assert.equal(failed.label, "去配乐失败 · 重试"); assert.equal(failed.retry, true);
assert.deepEqual(cardDemixState(src("a"), [], row([{ sourceAssetId: "a", state: "done", outputAssetId: "m" }])).action, { kind: "show", label: "看去配乐版", title: "已去配乐，点一下看去配乐版（原声版保留）", assetId: "m" });
// 状态记录丢了，但候选里已经有它的去配乐版 → 也不会再给原声版排一次。
assert.equal(cardDemixState(src("a"), [src("a"), out("m", "a")], null).action.kind, "show");
assert.equal(cardDemixState(src("a"), [], row([{ sourceAssetId: "a", state: "skipped" }])).action.label, "已处理过");
// 去配乐版：再去一次 / 切回原声 / ×2 已处理过
const once = cardDemixState(out("m", "a"), [], null);
assert.deepEqual([once.sound, once.action.label, once.original], ["去配乐版", "再去一次", "a"]);
assert.equal(cardDemixState(out("m", "a"), [], row([{ sourceAssetId: "m", state: "failed" }])).action.label, "再去一次失败 · 重试");
assert.equal(cardDemixState(out("m", "a"), [], row([{ sourceAssetId: "m", state: "done", outputAssetId: "m2" }])).action.label, "看 ×2 版");
const twice = cardDemixState(out("m2", "a", 2), [], null);
assert.deepEqual([twice.sound, twice.action.label, twice.action.kind, twice.original], ["去配乐 ×2 版", "已处理过", "processed", "a"]);

// ---------- 整集去配乐：只挑没处理过的原声版 ----------
const item = (code, asset, versions = [asset]) => ({ title: code, code, asset, nodeId: `n-${code}`, duration: 6, versions });
const items = [
  item("01", src("a")),
  item("02", out("m", "b")),                                   // 显示的是去配乐版
  item("03", src("c")),                                        // 状态里已去过
  item("04", src("d"), [src("d"), out("dm", "d")]),            // 候选里已有它的去配乐版
  item("05", src("e")),                                        // 正在去
  item("06", src("f")),                                        // 节点认出已处理过
  item("07", src("g")),                                        // 上次失败 → 再排
  item("08", src("a")),                                        // 和 01 同一个视频
];
const plan = planEpisodeDemix(items, row([{ sourceAssetId: "c", state: "done" }, { sourceAssetId: "e", state: "running" }, { sourceAssetId: "f", state: "skipped" }, { sourceAssetId: "g", state: "failed" }]));
assert.deepEqual(plan.todo.map((entry) => entry.code), ["01", "07"]);
assert.deepEqual(plan.skipped.map((entry) => [entry.item.code, entry.reason]), [["02", "显示的已经是去配乐版"], ["03", "已经去过配乐"], ["04", "已经去过配乐"], ["05", "正在去配乐"], ["06", "已处理过"], ["08", "和前面的是同一个视频"]]);

// ---------- 同一个提交函数：已处理过的会被它拒掉 ----------
resetMusicRemovalMemory();
const done = await registerAsset({ kind: "video", origin: "generated", filename: "done.mp4", mimeType: "video/mp4", storageReference: "url:done", sourceRunId: null });
const two = await registerAsset({ kind: "video", origin: "generated", filename: "two.mp4", mimeType: "video/mp4", storageReference: "url:two", sourceRunId: null, derivationType: "music_removal", sourceVideoAssetId: done.assetId, musicRemovalPasses: 2 });
await putMeta(MUSIC_REMOVAL_STATE_KEY, { version: 1, jobs: { [done.assetId]: { sourceAssetId: done.assetId, state: "done", outputAssetId: two.assetId, updatedAt: 1 } } });
await refreshDemixJobs();
assert.deepEqual(await enqueueMusicRemoval({ sourceAssetId: done.assetId, nodeId: "n" }), { queued: false, reason: "already_done" });
assert.deepEqual(await enqueueMusicRemoval({ sourceAssetId: two.assetId, nodeId: "n" }), { queued: false, reason: "max_passes" });

// 卡片（视频列、放大层、整集）和画布节点都只调用 lib/music-removal 的 enqueueMusicRemoval，卡片没有自己的一套提交。
const card = await readFile(new URL("../components/shot-card-demix.tsx", import.meta.url), "utf8");
const node = await readFile(new URL("../components/canvas/canvas-demix.tsx", import.meta.url), "utf8");
const board = await readFile(new URL("../components/shot-card-board.tsx", import.meta.url), "utf8");
for (const text of [card, node]) assert.match(text, /import \{[^}]*\benqueueMusicRemoval\b[^}]*\} from "@\/lib\/music-removal"/);
assert.equal((card.match(/enqueueMusicRemoval\(/g) ?? []).length, 2, "按钮一处、整集一处");
assert.doesNotMatch(card, /createRun|\/prompt|processOne|fetch\(/, "卡片不自己提交 ComfyUI");
assert.doesNotMatch(board, /music_removal|processOne|buildMusicRemovalWorkflow/, "卡片主文件也没有另一套去配乐提交");
assert.match(board, /<DemixCardControl asset=\{v\.chosen\.asset\} nodeId=\{v\.chosen\.nodeId\}/, "挂在出这条视频的节点上");
assert.match(board, /<DemixCardControl compact/, "放大层里也有");
assert.match(board, /autoRemoveMusic: !autoDemix/, "自动去配乐开关改的是队列默认设置（走 onChange，进撤销）");
assert.match(board, /queue\.defaults\?\.autoRemoveMusic \?\? true/, "不写 = 开，和队列面板一致");

console.log("shot card demix: same enqueue as the node, processed videos skipped, episode picks only unprocessed; ok");
