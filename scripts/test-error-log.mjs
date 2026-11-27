import assert from "node:assert/strict";
import "./fake-indexeddb.mjs";
import { categorize, clearRead, configureErrorLog, entryDetails, ERROR_LOG_KEY, flushLog, getLogVersion, listEntries, logEvent, logToast, markAllRead, MAX_ENTRIES, subscribeLog, unreadCount } from "../lib/error-log.ts";
import { getMeta, putMeta } from "../lib/production-records.ts";

const metaStorage = { load: () => getMeta(ERROR_LOG_KEY), save: (entries) => putMeta(ERROR_LOG_KEY, entries) };
configureErrorLog(metaStorage);

// Explicit task failure with context.
const failure = await logEvent({ level: "error", category: "task", title: "H3 生成失败", detail: "显存不足：请降低时长或像素预算后重试", nodeId: "shape:h3", runId: "run-1234567890", shotId: "shot-1" });
assert.equal(failure.read, false);
assert.equal(unreadCount(), 1);

// The same toast right after is not logged twice.
assert.equal(await logToast("显存不足：请降低时长或像素预算后重试", "error"), null);
// An identical explicit entry within the window merges into one with a repeat count.
const again = await logEvent({ level: "error", category: "task", title: "H3 生成失败", detail: "显存不足：请降低时长或像素预算后重试", nodeId: "shape:h3" });
assert.equal(again.id, failure.id);
assert.equal(again.repeat, 2);
// A different, uncaptured error toast is recorded (as UI / asset by content).
const toast = await logToast("引用素材已失效：柴犬.wav", "error");
assert.equal(toast.category, "asset");
assert.equal(categorize("ComfyUI 生成失败", "task"), "task");
await logEvent({ level: "warning", category: "recovery", title: "任务状态待确认", detail: "ComfyUI 中找不到此任务", runId: "r2" });
await logEvent({ level: "info", category: "task", title: "高清增强完成", detail: "结果已登记" });

let list = await listEntries();
assert.deepEqual(list.map((entry) => entry.title), ["高清增强完成", "任务状态待确认", "引用素材已失效：柴犬.wav", "H3 生成失败"], "newest first");
assert.equal(unreadCount(), 3, "unread badge counts errors + warnings, not info");
assert.equal(unreadCount(["error", "warning", "info"]), 4);

// "复制高级信息"
const details = JSON.parse(entryDetails(list.at(-1)));
assert.deepEqual([details.title, details.nodeId, details.runId, details.shotId, details.repeat], ["H3 生成失败", "shape:h3", "run-1234567890", "shot-1", 2]);

// Persisted in the meta store; a fresh session (page reload) sees the same log.
await flushLog();
assert.equal((await getMeta(ERROR_LOG_KEY)).length, 4);
configureErrorLog(metaStorage);
assert.deepEqual((await listEntries()).map((entry) => entry.title), list.map((entry) => entry.title), "restored after reload");

// Read state + clearing read entries.
let notified = 0;
const off = subscribeLog(() => { notified += 1; });
const versionBefore = getLogVersion();
await markAllRead();
assert.equal(unreadCount(["error", "warning", "info"]), 0);
assert.ok(notified >= 1 && getLogVersion() > versionBefore, "badge subscribers are notified");
await logEvent({ level: "error", category: "backup", title: "备份恢复未完成", detail: "✗ canvas" });
await clearRead();
list = await listEntries();
assert.deepEqual(list.map((entry) => entry.title), ["备份恢复未完成"], "only unread entries remain");
off();

// Capped at the newest 300.
for (let i = 0; i < MAX_ENTRIES + 20; i += 1) await logEvent({ level: "info", category: "task", title: `任务 ${i}`, detail: String(i), time: 10_000 + i * 10_000 });
list = await listEntries();
assert.equal(list.length, MAX_ENTRIES);
assert.equal(list[0].title, `任务 ${MAX_ENTRIES + 19}`);

// A failing storage never breaks the caller.
configureErrorLog({ load: () => Promise.reject(new Error("IDB blocked")), save: () => Promise.reject(new Error("quota")) });
const safe = await logEvent({ level: "error", category: "ui", title: "界面错误", detail: "x" });
assert.equal(safe.title, "界面错误");
await flushLog();
assert.equal((await listEntries()).length, 1);

console.log("Error log: context entries, toast de-dup, merge, categories, badge counts, copy details, meta persistence across reload, read/clear, 300 cap, storage failures passed");
