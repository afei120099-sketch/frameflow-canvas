// 镜头卡片「视频」格：渲染中 · 已 N 秒 / 排队中 · 第 N 位（lib/shot-render-status.ts）。
import assert from "node:assert/strict";
import { createQueueWatch, formatSeconds, parseQueueSnapshot, queuedText, renderStatusOf, runningText } from "../lib/shot-render-status.ts";
import { parseComfyProgressMessage } from "../lib/comfyui/h3-adapter.ts";

const T0 = Date.UTC(2026, 10, 12, 8, 0, 0);
const run = (id, extra = {}) => ({ status: "queued", promptId: id, createdAt: T0 - 600_000, startedAt: null, title: id, ...extra });
const ten = () => ({ min: 140, max: 140 });

// ── ComfyUI /queue 原样解析：pending 按号码排（号码小的先跑），坏数据跳过 ──
{
  const snap = parseQueueSnapshot({ queue_running: [[5, "A", {}]], queue_pending: [[9, "C", {}], [7, "B", {}], ["x"], [8, "X", {}]] });
  assert.deepEqual(snap, { running: ["A"], pending: ["B", "X", "C"] });
  assert.deepEqual(parseQueueSnapshot(null), { running: [], pending: [] });
}

// ── 渲染中：秒数（ComfyUI 时间戳 = 准的，不标「约」），第几步 ──
{
  const a = run("A", { status: "running" });
  const status = renderStatusOf(a, { snapshot: { running: ["A"], pending: [] }, live: { startedAt: T0 - 42_000, step: 7, steps: 10, percent: 70 }, now: T0 });
  assert.equal(status.kind, "running");
  assert.equal(status.approx, false);
  const text = runningText(status, T0, { step: 7, steps: 10, percent: 70 });
  assert.equal(text.head, "渲染中 · 已 42 秒");
  assert.equal(text.step, "第 7/10 步");
  assert.equal(text.percent, 70);
  // 每秒刷新：同一个状态，时间往前走一秒，秒数加一
  assert.equal(runningText(status, T0 + 1000, null).head, "渲染中 · 已 43 秒");
  assert.equal(runningText(status, T0 + 83_000, null).head, "渲染中 · 已 2 分 05 秒");
  // 拿不到第几步、百分比：不显示，不编
  const bare = runningText(status, T0, null);
  assert.equal(bare.step, ""); assert.equal(bare.percent, null);
  // 只有百分比
  assert.equal(runningText(status, T0, { percent: 33.4 }).step, "33%");
  // 步数不合理（比总数大）不显示
  assert.equal(runningText(status, T0, { step: 12, steps: 10 }).step, "");
  assert.equal(formatSeconds(59.9), "59 秒");
}

// ── 拿不到 ComfyUI 开始时间：用画布看到的时间，标「约」 ──
{
  // Run.startedAt 是画布看到它开始的时间（不是 ComfyUI 时间戳）
  const observed = renderStatusOf(run("A", { status: "running", startedAt: T0 - 30_000 }), { snapshot: null, now: T0 });
  assert.equal(observed.approx, true);
  assert.equal(runningText(observed, T0, null).head, "渲染中 · 已约 30 秒");
  assert.match(runningText(observed, T0, null).title, /约/);
  // Run 里还是 queued、ComfyUI 已经在跑、也没有开始时间：用卡片第一次看到的时间，标「约」
  const seen = renderStatusOf(run("A"), { snapshot: { running: ["A"], pending: [] }, now: T0, seenRunningAt: (id) => id === "A" ? T0 - 5_000 : undefined });
  assert.equal(seen.kind, "running"); assert.equal(seen.approx, true);
  assert.equal(runningText(seen, T0, null).head, "渲染中 · 已约 5 秒");
  // 什么时间都没有
  const none = renderStatusOf(run("A", { status: "running" }), { snapshot: null, now: T0 });
  assert.equal(runningText(none, T0, null).head, "渲染中 · 刚开始");
  // 不像真时间戳的值不用
  const junk = renderStatusOf(run("A", { status: "running" }), { snapshot: null, live: { startedAt: 12 }, now: T0 });
  assert.equal(junk.approx, true);
}

// ── 排队中：第几位、前面几条、画布外的任务只算数不认人、估算 ──
{
  const mine = [run("A", { status: "running", startedAt: T0 - 40_000 }), run("B"), run("C")];
  const snapshot = { running: ["A"], pending: ["B", "C"] };
  const b = renderStatusOf(mine[1], { snapshot, others: mine, now: T0, estimateOf: ten });
  assert.deepEqual({ ...b, wait: b.wait }, { kind: "queued", position: 1, ahead: 1, foreignAhead: 0, wait: { min: 100, max: 100 } });
  const c = renderStatusOf(mine[2], { snapshot, others: mine, now: T0, estimateOf: ten });
  assert.equal(c.position, 2); assert.equal(c.ahead, 2);
  assert.deepEqual(c.wait, { min: 240, max: 240 });
  const text = queuedText(c);
  assert.equal(text.head, "排队中 · 第 2 位");
  assert.equal(text.sub, "前面还有 2 条 · 约等 4 分钟（估算）");
  // 画布外直接 POST 给 ComfyUI 的任务（X）：算进位置，只说「前面还有 N 条」，不估等多久
  const withForeign = { running: ["X"], pending: ["B", "Y", "C"] };
  const c2 = renderStatusOf(mine[2], { snapshot: withForeign, others: mine, now: T0, estimateOf: ten });
  assert.equal(c2.position, 3); assert.equal(c2.ahead, 3); assert.equal(c2.foreignAhead, 2); assert.equal(c2.wait, null);
  assert.equal(queuedText(c2).sub, "前面还有 3 条 · 其中 2 条不是这份队列的");
  assert.equal(queuedText(c2).head, "排队中 · 第 3 位");
  // 估算算不出来（缺一条估算）：只写第几位
  const c3 = renderStatusOf(mine[2], { snapshot, others: mine, now: T0, estimateOf: (r) => r.promptId === "B" ? null : ten() });
  assert.equal(c3.wait, null); assert.equal(queuedText(c3).sub, "前面还有 2 条");
  // 正在跑的那条已经超时：剩余按 0 算，不出负数
  const late = [run("A", { status: "running", startedAt: T0 - 900_000 }), run("B")];
  const b2 = renderStatusOf(late[1], { snapshot: { running: ["A"], pending: ["B"] }, others: late, now: T0, estimateOf: ten });
  assert.deepEqual(b2.wait, { min: 0, max: 0 });
  assert.equal(queuedText(b2).sub, "前面还有 1 条");
  // /queue 还没读到：只写「排队中」，不编位置
  const unknown = renderStatusOf(mine[1], { snapshot: null, others: mine, now: T0 });
  assert.equal(unknown.position, null); assert.equal(queuedText(unknown).head, "排队中");
  // 同一时刻只有一条在渲：ComfyUI 说 B 在排队，Run 里写着 running 也按排队显示
  const stale = renderStatusOf(run("B", { status: "running" }), { snapshot, others: mine, now: T0 });
  assert.equal(stale.kind, "queued");
}

// ── ComfyUI 刚读到的队列里已经没有它（出完了）：不再显示「渲染中」，卡片照旧 ──
{
  const done = run("A", { status: "running", startedAt: T0 - 100_000 });
  assert.equal(renderStatusOf(done, { snapshot: { running: [], pending: [] }, snapshotAt: T0, now: T0 }), null);
  // 但那份 /queue 是旧的（之后读失败）：保留 Run 里的状态
  assert.equal(renderStatusOf(done, { snapshot: { running: [], pending: [] }, snapshotAt: T0, snapshotStale: true, now: T0 }).kind, "running");
  // 读 /queue 之后才提交的：还没进那份快照，照 Run 显示
  assert.equal(renderStatusOf(run("N", { createdAt: T0 }), { snapshot: { running: [], pending: [] }, snapshotAt: T0 - 2000, now: T0 }).kind, "queued");
  assert.equal(renderStatusOf(undefined, { snapshot: null, now: T0 }), null);
}

// ── 请求失败（显卡满负荷 / ComfyUI 卡住）：安静地保留上一次，不抛错、不清空 ──
{
  const timers = [];
  const setTimer = (fn) => { timers.push(fn); return timers.length; };
  const answers = [
    { queue_running: [[1, "A"]], queue_pending: [[2, "B"]] },
    new Error("timeout"),
    new Error("timeout"),
    { queue_running: [[1, "A"]], queue_pending: [[2, "B"]] },
    { queue_running: [[2, "B"]], queue_pending: [] },
  ];
  let reads = 0;
  const seen = [];
  const watch = createQueueWatch({
    read: async () => { const next = answers[reads++]; if (next instanceof Error) throw next; return next; },
    onSnapshot: (snapshot, meta) => seen.push({ snapshot, stale: meta.stale }),
    setTimer, clearTimer: () => {},
  });
  const step = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
  await step();
  assert.equal(seen.length, 1); assert.deepEqual(seen[0], { snapshot: { running: ["A"], pending: ["B"] }, stale: false });
  timers.shift()(); await step(); // 第一次失败：保留旧的，只标 stale
  assert.equal(seen.length, 2); assert.deepEqual(seen[1], { snapshot: { running: ["A"], pending: ["B"] }, stale: true });
  assert.deepEqual(watch.last, { running: ["A"], pending: ["B"] });
  timers.shift()(); await step(); // 连续失败：不再重复通知、不清空
  assert.equal(seen.length, 2); assert.equal(watch.stale, true);
  timers.shift()(); await step(); // 恢复：同样的内容也要把 stale 去掉
  assert.equal(seen.length, 3); assert.equal(seen[2].stale, false);
  timers.shift()(); await step(); // 变了才通知
  assert.equal(seen.length, 4); assert.deepEqual(seen[3].snapshot, { running: ["B"], pending: [] });
  watch.stop();
  assert.equal(reads, 5);
  // 停了以后不再排下一次
  const before = timers.length; timers.shift()?.(); await step(); assert.equal(timers.length, Math.max(0, before - 1));
  // 第一次就失败：什么都不通知（卡片照 Run 显示「排队中」不带位置）
  const quiet = [];
  const w2 = createQueueWatch({ read: async () => { throw new Error("down"); }, onSnapshot: (s) => quiet.push(s), setTimer: () => 0, clearTimer: () => {} });
  await step(); assert.equal(quiet.length, 0); w2.stop();
}

// ── ComfyUI 进度消息：第几步、execution_start 自带的开始时间戳 ──
{
  assert.deepEqual(parseComfyProgressMessage({ type: "progress", data: { prompt_id: "job", node: "11", value: 7, max: 10 } }, "job"), { status: "running", percent: 70, stage: "H3 采样", step: 7, steps: 10 });
  assert.deepEqual(parseComfyProgressMessage({ type: "execution_start", data: { prompt_id: "job", timestamp: T0 } }, "job"), { status: "loading", stage: "开始执行工作流", startedAt: T0 });
  // 没有时间戳（旧版 ComfyUI）：不编
  assert.deepEqual(parseComfyProgressMessage({ type: "execution_start", data: { prompt_id: "job" } }, "job"), { status: "loading", stage: "开始执行工作流" });
  // 不是整数的进度：只给百分比，不给第几步
  assert.deepEqual(parseComfyProgressMessage({ type: "progress", data: { prompt_id: "job", node: "11", value: 0.5, max: 1 } }, "job"), { status: "running", percent: 50, stage: "H3 采样" });
}

console.log("render-status: ok");
