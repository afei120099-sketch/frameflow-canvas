// 第 7 条：界面上的「自动入队 开/关」「急停」和「本页是执行页」。
// 开关改的必须是同一个 _control.json（autoEnqueue）和 STOP 文件，不另起一套状态。
// 全程用临时目录，不碰真实收件箱；ComfyUI 是假的，不提交 GPU。
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { inboxRootControlPlugin, readInboxRootControl, switchInboxRootControl as serverSwitch, ROOT_CONTROL_PATH } from "./inbox-root-control.mjs";
import { switchInboxRootControl, readInboxRootSnapshot } from "../lib/inbox-root-control.ts";
import { executorView, PRESENCE_TIMEOUT_MS } from "../lib/inbox-executor-presence.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "frameflow-control-switch-test-"));
assert.notEqual(path.resolve(root), path.resolve(ROOT_CONTROL_PATH), "测试不能用真实收件箱");
const controlFile = path.join(root, "_control.json"), stopFile = path.join(root, "STOP");
const exists = (file) => fs.stat(file).then(() => true, () => false);
let handler, forwarded = 0;
inboxRootControlPlugin({ root }).configureServer({ middlewares: { use(fn) { handler = fn; } } });
const server = createServer((req, res) => handler(req, res, () => { forwarded++; res.end("mock ComfyUI; no GPU"); }));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (body, headers = {}) => fetch(base + "/__inbox/control", { method: "POST", headers: { origin: base, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const prompt = () => fetch(base + "/comfyui/prompt", { method: "POST", headers: { origin: base, "x-frameflow-control-kind": "automatic" }, body: "CPU" });
try {
  // 1. 没有 _control.json：界面不替你新建，也不写任何东西
  let response = await post({ autoEnqueue: true });
  assert.equal(response.status, 409); assert.match((await response.json()).error, /还没有 _control\.json/);
  assert.equal(await exists(controlFile), false);
  // 急停不依赖 _control.json：照样能建 STOP
  response = await post({ stop: true }); assert.equal(response.status, 200);
  assert.equal(await exists(stopFile), true); assert.match(await fs.readFile(stopFile, "utf8"), /画布界面急停/);
  response = await post({ stop: false }); assert.equal(response.status, 200); assert.equal(await exists(stopFile), false);

  // 2. 开 / 关：只改 autoEnqueue，其他字段原样保留
  const original = { autoEnqueue: false, autoChain: true, submit: true, stopSessions: ["s-old"], pauseSessions: ["s-p"], priority: ["s-1"], 备注: "用户自己写的" };
  await fs.writeFile(controlFile, "﻿" + JSON.stringify(original, null, 2));
  assert.equal((await prompt()).status, 423, "autoEnqueue 关：自动提交被拦"); assert.equal(forwarded, 0);
  response = await post({ autoEnqueue: true }); assert.equal(response.status, 200);
  const turnedOn = await response.json(); assert.equal(turnedOn.autoEnqueue, true); assert.equal(turnedOn.effective.autoEnqueue, true);
  assert.deepEqual(JSON.parse(await fs.readFile(controlFile, "utf8")), { ...original, autoEnqueue: true });
  assert.equal((await prompt()).status, 200, "开了以后才放行"); assert.equal(forwarded, 1);
  // 和手改文件是一回事：GET 读到的就是文件
  assert.equal((await readInboxRootControl(root)).autoEnqueue, true);
  // 值没变就不重写文件
  const before = await fs.stat(controlFile); await new Promise((r) => setTimeout(r, 20));
  assert.equal((await post({ autoEnqueue: true })).status, 200); assert.equal((await fs.stat(controlFile)).mtimeMs, before.mtimeMs);
  response = await post({ autoEnqueue: false }); assert.equal((await response.json()).effective.autoEnqueue, false);
  assert.equal(JSON.parse(await fs.readFile(controlFile, "utf8")).autoEnqueue, false);
  await post({ autoEnqueue: true });

  // 3. 急停 = STOP 文件：所有新提交都停，_control.json 不动
  const fileBefore = await fs.readFile(controlFile, "utf8");
  response = await post({ stop: true }); const stopped = await response.json();
  assert.equal(stopped.stop, true); assert.deepEqual(stopped.effective, { autoEnqueue: false, autoChain: false, submit: false });
  assert.equal((await prompt()).status, 423); assert.equal(forwarded, 1);
  assert.equal(await fs.readFile(controlFile, "utf8"), fileBefore);
  // 已有 STOP（比如用户手建的空文件）再点急停：不覆盖
  await fs.writeFile(stopFile, ""); assert.equal((await post({ stop: true })).status, 200); assert.equal(await fs.readFile(stopFile, "utf8"), "");
  // 解除急停 = 删 STOP；开关回到文件里的值
  response = await post({ stop: false }); const released = await response.json();
  assert.equal(released.stop, false); assert.equal(released.effective.autoEnqueue, true); assert.equal(await exists(stopFile), false);
  assert.equal((await prompt()).status, 200); assert.equal(forwarded, 2);

  // 4. 坏文件不覆盖；乱请求不执行；外站请求拒绝
  await fs.writeFile(controlFile, "{ broken");
  response = await post({ autoEnqueue: true }); assert.equal(response.status, 409); assert.match((await response.json()).error, /读不出来/);
  assert.equal(await fs.readFile(controlFile, "utf8"), "{ broken");
  await fs.writeFile(controlFile, JSON.stringify({ autoEnqueue: "yes", autoChain: true, submit: true }));
  assert.equal((await post({ autoEnqueue: true })).status, 409);
  await fs.writeFile(controlFile, JSON.stringify(original));
  for (const bad of [{}, { autoEnqueue: "true" }, { submit: true }, { autoChain: true }, { stop: 1 }]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post({ stop: true }, { origin: "http://evil.example" })).status, 403);
  assert.equal(await exists(stopFile), false);
  assert.deepEqual(JSON.parse(await fs.readFile(controlFile, "utf8")), original, "乱请求一个字都没改");
  // 并发点击按顺序执行，最后一下为准
  await Promise.all([serverSwitch({ autoEnqueue: true }, root), serverSwitch({ autoEnqueue: false }, root), serverSwitch({ autoEnqueue: true }, root)]);
  assert.equal(JSON.parse(await fs.readFile(controlFile, "utf8")).autoEnqueue, true);

  // 5. 浏览器端：结果直接更新本页的总控快照
  const fakeFetch = (url, init) => fetch(base + url, { ...init, headers: { ...init.headers, origin: base } });
  const snap = await switchInboxRootControl({ autoEnqueue: false }, fakeFetch);
  assert.equal(snap.autoEnqueue, false); assert.equal(readInboxRootSnapshot().autoEnqueue, false);
  await fs.writeFile(controlFile, "{ broken");
  await assert.rejects(switchInboxRootControl({ autoEnqueue: true }, fakeFetch), /读不出来/);
} finally {
  server.close(); await fs.rm(root, { recursive: true, force: true });
}

// 6. 「本页是执行页」：只观察，不决定谁执行
const now = 100_000, me = { tabId: "me", at: now, lastTickAt: now - 2000 };
assert.equal(executorView(me, [], now).label, "本页是执行页");
assert.equal(executorView(me, [{ tabId: "old", at: now - PRESENCE_TIMEOUT_MS - 1, lastTickAt: now - 99_000 }], now).kind, "only", "关掉的页不算");
const shared = executorView(me, [{ tabId: "b", at: now - 1000, lastTickAt: now - 3000 }], now);
assert.equal(shared.kind, "shared"); assert.equal(shared.pages, 2); assert.match(shared.label, /执行页不固定（开着 2 页）/); assert.match(shared.detail, /本页和另外 1 页最近都接过手/);
assert.match(executorView({ ...me, lastTickAt: null }, [{ tabId: "b", at: now, lastTickAt: now - 1000 }], now).detail, /最近是另一页在接手/);
assert.match(executorView({ ...me, lastTickAt: null }, [], now).detail, /还没在本页跑起来/);

// 7. 源码：画布主文件只加了挂载；开关组件不用紫色/琥珀色、不新增配色变量；调度只记一笔不改逻辑
const src = (rel) => readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf8");
const ws = src("app/canvas-workspace.tsx");
assert.equal((ws.match(/<InboxControlBar \/>/g) ?? []).length, 1);
const bar = src("components/inbox-control-bar.tsx");
assert.doesNotMatch(bar, /#(?![0-9a-f]{3}\b|[0-9a-f]{6}\b)|purple|amber|#9a8ff0|#d6bd84|--ff-run|--ff-warn/i);
for (const hex of bar.match(/#[0-9a-f]{6}\b/gi) ?? []) assert.ok(hex.slice(1, 3) === hex.slice(3, 5) && hex.slice(3, 5) === hex.slice(5, 7), "只用灰：" + hex);
assert.doesNotMatch(bar, /--ff-[a-z-]+\s*:/, "不新增配色变量");
assert.match(bar, /const stopNow = \(\) => void send\(\{ stop: true \}\);/, "急停一下就停，不弹确认");
assert.match(bar, /if \(value && !await askConfirm/, "打开自动入队先确认");
const scheduler = src("components/use-inbox-scheduler.ts");
assert.match(scheduler, /if \(!lock \|\| stopped\) return;\r?\n\s*noteInboxSchedulerTick\(\);/);
assert.match(scheduler, /navigator\.locks\.request\("frameflow-inbox-scheduler-v2", \{ifAvailable:true\}/, "调度锁没改");

console.log("inbox control switch: 自动入队 / 急停 write the same _control.json autoEnqueue and STOP file, keep other fields, refuse broken files; executor label observes only; ok");
