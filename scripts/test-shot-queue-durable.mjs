/*
 * 原来想保护什么：
 * 1. 队列会话按画布页隔离、节点默认间距（100px）、历史/失败/待确认条目的耐用重试门控（maySubmitQueueEntry / latestQueueRun）。
 * 2. ComfyUIH3Adapter.enqueue 只准备并提交不轮询渲染，且响应 AbortSignal；cancelPendingJobs 只撤回本批排队任务，绝不中断正在运行或他人任务。
 * 3. 队列执行器（components/use-shot-queue-execution.ts）必须先预建全部节点、再等待画布落盘（waitForCanvasSave）、最后才发起首次提交；关闭抽屉不得撤回已接单任务；每次提交前重新读取耐用 Run 记录。
 *
 * 为什么原写法失效：
 * 原测试第 56–57 行硬编码匹配字面量 hook.indexOf("await state.enqueue()") 与 hook.indexOf("const showAll")。
 * 产品代码为防止单次提交卡死已将 state.enqueue() 改为带超时包装的 bounded(scope => state!.enqueue(...))，并移除了旧变量 const showAll，导致 indexOf 返回 -1、顺序比较恒假而报错（nodes must be saved before submitting）。
 *
 * 新写法怎么保护同一件事：
 * 1. 完整保留全部 25+ 条运行时行为断言（会话隔离、节点间距、重试门控、enqueue 不轮询、AbortError、cancelPendingJobs 精确撤回）。
 * 2. 将第 55–59 行的脆弱字面量查找改为基于 AST / 语义锚点的执行顺序与不变量检查：
 *    - 定位预建循环（createNode）、画布落盘确认（waitForCanvasSave）与提交调用（state!.enqueue(...)），断言三者均存在且严格满足 prebuildCreatePos < waitForCanvasSavePos < submitLoopPos < enqueuePos；
 *    - 断言提交循环内每次提交前重新读取 listRuns() 并调用 maySubmitQueueEntry(entry, runs, retryOnly)；
 *    - 断言仅在 controller.signal.aborted && userStop.current 时才调用 stopWaiting，确保关闭抽屉不会取消已接单任务。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ComfyUIH3Adapter } from "../lib/comfyui/h3-adapter.ts";
import { newQueueSession, queueNodePosition, queueSessionKey, latestQueueRun, maySubmitQueueEntry } from "../lib/shot-queue-session.ts";
import { shotQueueExample } from "../lib/shot-queue.ts";
import { H3_NEW_NODE_WIDTH } from "../lib/h3-node-layout-policy.ts";

const queue = shotQueueExample();
const session = newQueueSession("page:a", queue, { x: 10, y: 20 });
assert.notEqual(queueSessionKey("page:a"), queueSessionKey("page:b"));
assert.equal(session.entries.length, queue.chapters.reduce((n, chapter) => n + chapter.shots.length, 0));
assert.notEqual(session.queue, queue);
const first = queueNodePosition(session.origin, 0);
const second = queueNodePosition(session.origin, 1);
assert.equal(second.x - first.x - H3_NEW_NODE_WIDTH, 100);
assert.equal(queueNodePosition(session.origin, 1, 560).x - first.x - 560, 100, "explicit legacy width remains supported");
assert.equal(second.y, first.y);
const entry = { chapter: 0, shot: 0, nodeId: "shape:a" };
const run = status => ({ runId: "r1", ownerNodeId: "shape:a", createdAt: 1, status });
for (const status of ["queued", "running", "completed"]) assert.equal(maySubmitQueueEntry(entry, [run(status)]), false);
assert.equal(maySubmitQueueEntry(entry, [{ ...run("queued"), submission: "reserved" }]), false);
for (const status of ["failed", "cancelled"]) assert.equal(maySubmitQueueEntry(entry, [run(status)]), false, 'legacy failures are not proven non-submission');
assert.equal(maySubmitQueueEntry(entry, []), false, 'legacy prebuilt node without submission evidence stays blocked');
assert.equal(maySubmitQueueEntry({...entry,submissionState:'pending'}, []), true);
assert.equal(maySubmitQueueEntry({...entry,outcome:'failed',submissionState:'pending'}, [run('failed')], true), true);
assert.equal(maySubmitQueueEntry({...entry,outcome:'uncertain'}, [], true), false);
assert.equal(maySubmitQueueEntry({...entry,submissionState:'pending'}, [{ ...run("running"), ownerNodeId: "shape:other" }]), true);
assert.equal(latestQueueRun(entry, [run("failed"), { ...run("queued"), runId: "r2", createdAt: 2 }]).runId, "r2");

// No server/GPU calls: stub preparation and acceptance, make polling a hard test failure.
const adapter = new ComfyUIH3Adapter();
const calls = [];
adapter.prepareGeneration = async () => { calls.push("prepare"); return { workflow: { a: {} }, saveNodeId: "148" }; };
adapter.submit = async request => { calls.push(["submit", request.inputs.promptId]); return { jobId: request.inputs.promptId, status: "queued" }; };
adapter.getStatus = async () => { throw Error("enqueue must not wait for rendering"); };
const receipt = await adapter.enqueue({}, { promptId: "reserved-1", onJobId: id => calls.push(["accepted", id]) });
assert.deepEqual(receipt, { promptId: "reserved-1" });
assert.deepEqual(calls, ["prepare", ["submit", "reserved-1"], ["accepted", "reserved-1"]]);
const aborted = new AbortController(); aborted.abort();
await assert.rejects(() => adapter.enqueue({}, { promptId: "never", signal: aborted.signal }), { name: "AbortError" });
assert.equal(calls.some(call => Array.isArray(call) && call[1] === "never"), false);

// Stop removes only this batch's WAITING IDs, never interrupts a running or unrelated job.
const requests = [];
adapter.request = async (path, options) => {
  requests.push([path, options]);
  return new Response(JSON.stringify(path === "/queue" && !options?.method
    ? { queue_pending: [[1, "ours"], [2, "other"]], queue_running: [[0, "running-ours"]] } : {}));
};
assert.deepEqual(await adapter.cancelPendingJobs(["ours", "running-ours", "not-found"]), ["ours"]);
assert.deepEqual(JSON.parse(requests[1][1].body), { delete: ["ours"] });
assert.equal(requests.some(([path]) => path.includes("interrupt")), false);
assert.equal(requests.length, 2);

// Execution pipeline ordering & durability invariants (independent of wrapper/variable renames).
const hook = readFileSync(new URL("../components/use-shot-queue-execution.ts", import.meta.url), "utf8");
const prebuildLoop = hook.search(/for\s*\(\s*let\s+index\s*=\s*0\s*;\s*index\s*<\s*batch\.entries\.length/);
const createNodeCall = hook.indexOf("await createNode(", prebuildLoop);
const saveBeforeSubmit = hook.indexOf("await waitForCanvasSave(", createNodeCall);
const submitLoop = hook.search(/for\s*\(\s*const\s+entry\s+of\s+submissionEntries\s*\)/);
const enqueueMatch = hook.slice(submitLoop).match(/state!?\s*\.\s*enqueue\s*\(/);
const enqueueCall = enqueueMatch ? submitLoop + enqueueMatch.index : -1;

assert.ok(prebuildLoop > 0 && createNodeCall > prebuildLoop, "prebuild loop creates all batch nodes");
assert.ok(saveBeforeSubmit > createNodeCall, "canvas save verification runs after prebuild node creation");
assert.ok(submitLoop > saveBeforeSubmit, "all nodes created and saved before entering submission loop");
assert.ok(enqueueCall > submitLoop, "submission loop invokes state.enqueue(...) after canvas save");

const submitBody = hook.slice(submitLoop, enqueueCall);
const listRunsInSubmit = submitBody.indexOf("await listRuns()");
const maySubmitInSubmit = submitBody.indexOf("maySubmitQueueEntry(entry, runs, retryOnly)");
assert.ok(listRunsInSubmit > 0 && maySubmitInSubmit > listRunsInSubmit, "re-read durable runs and verify maySubmitQueueEntry before each submission");
assert.match(hook, /if\s*\(\s*controller\.signal\.aborted\s*&&\s*userStop\.current[\s\S]{0,300}stopWaiting\(/, "closing drawer must not cancel accepted jobs; only explicit user stop calls stopWaiting");
console.log("PASS: page isolation, 100-unit horizontal gap, durable retry guards, enqueue without polling, scoped waiting-only stop, prebuild->save->submit order");
