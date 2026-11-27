import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOPILOT_RETIRED_MESSAGE } from "../lib/autopilot.ts";
import { ComfyUIH3Adapter } from "../lib/comfyui/h3-adapter.ts";
import { AutopilotWorker } from "./autopilot-worker.ts";
import { startFakeComfy } from "./fake-comfyui.mjs";

/**
 * 夜班已下线（2026-11-11）：它只会用已停用的稳定版 H3。开工（M1 create / M2 confirm）和继续（resume）
 * 都被拒绝，一次 ComfyUI 提交都不发。旧的 test-autopilot-m1 / m2 / m2-package 和 test-director-lmstudio
 * 测的是开工后的整条出片流程，已随夜班退役（见 git 历史）。
 */
const comfy = await startFakeComfy({ files: [], runMs: 10 });
const root = await mkdtemp(join(tmpdir(), "frameflow-autopilot-retired-"));
const worker = new AutopilotWorker({ root, comfy: new ComfyUIH3Adapter(comfy.url, { timeoutMs: 2_000 }), python: "python", script: "rough-cut.py", pollMs: 20, reconnectMs: 20, reconnectLimitMs: 200, heartbeatMs: 100, roughCutPollMs: 30 });
const retired = (cause) => cause.code === "RETIRED" && cause.status === 410 && cause.message === AUTOPILOT_RETIRED_MESSAGE;
try {
  await assert.rejects(worker.create(), retired, "M1 三镜头测试不能再开工");
  await assert.rejects(worker.confirm("00000000-0000-4000-8000-000000000012"), retired, "M2 导演计划不能再开始制作");
  await assert.rejects(worker.resume("00000000-0000-4000-8000-000000000012"), retired, "暂停的旧任务不能继续");
  assert.deepEqual((await worker.list()).jobs, [], "没有建出任何任务");
  assert.equal(comfy.state.prompts.length, 0, "没有向 ComfyUI 提交");
  assert.match(AUTOPILOT_RETIRED_MESSAGE, /夜班已下线/);
  console.log("autopilot retired: create / confirm / resume refused, nothing submitted");
} finally {
  await worker.stop();
  await comfy.close();
  await rm(root, { recursive: true, force: true });
}
