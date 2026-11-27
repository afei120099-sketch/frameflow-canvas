import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { GpuThermalSafety, parseGpuTemperatures } from "./gpu-thermal-safety.ts";
import { stopComfyForHeat } from "./gpu-thermal-vite-plugin.ts";
import { AutopilotWorker } from "./autopilot-worker.ts";

const root = await mkdtemp(join(tmpdir(), "frameflow-thermal-test-"));
let temperature = 44, stops = 0, confirmed = false;
const options = { file: join(root, "thermal.json"), readTemperature: async () => temperature, stopComfy: async () => { stops++; return confirmed; } };
assert.equal(parseGpuTemperatures("44\n83"), 83);
for (const invalid of ["", "N/A", "0", "44\nN/A", "-1", "Infinity"]) assert.equal(parseGpuTemperatures(invalid), null);
const guard = new GpuThermalSafety(options);
await guard.assertCanSubmit(); assert.equal(guard.status().blocked, false);
temperature = 80;
await assert.rejects(guard.assertCanSubmit(), { code: "GPU_THERMAL_BLOCKED" });
assert.equal(stops, 1); assert.equal(guard.status().latched, true); assert.equal(guard.status().stopConfirmed, false);
assert.equal(JSON.parse(await readFile(options.file, "utf8")).latched, true);
temperature = 74;
await assert.rejects(guard.resume()); // request alone does not mean stopped
confirmed = true; temperature = 75;
await assert.rejects(guard.resume()); // strictly below 75
temperature = 74; await guard.sample();
assert.equal(guard.status().canResume, true);
await assert.rejects(guard.assertCanSubmit()); // cooling does not resume
const restarted = new GpuThermalSafety(options);
await assert.rejects(restarted.assertCanSubmit()); // restart does not bypass latch
await restarted.resume(); await restarted.assertCanSubmit();
temperature = null; await assert.rejects(restarted.assertCanSubmit());
assert.equal(restarted.status().temperatureC, null);
await writeFile(options.file, "broken");
const damaged = new GpuThermalSafety(options);
temperature = 44; await assert.rejects(damaged.assertCanSubmit());
let reads = 0;
const concurrent = new GpuThermalSafety({ ...options, file: join(root, "concurrent.json"), readTemperature: async () => { reads++; await new Promise((r) => setTimeout(r, 15)); return 44; } });
await Promise.all([concurrent.sample(), concurrent.sample(), concurrent.assertCanSubmit()]); assert.equal(reads, 1);
concurrent.start(); await concurrent.stop(); const stoppedReads = reads;
await new Promise((r) => setTimeout(r, 30)); assert.equal(reads, stoppedReads);

const calls = []; let clearFails = false;
const fake = createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/queue" && req.method === "POST" && clearFails) { res.statusCode = 500; res.end("{}"); return; }
  res.end(JSON.stringify(req.method === "GET" ? { queue_running: [], queue_pending: [] } : {}));
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
try {
  const base = `http://127.0.0.1:${fake.address().port}`;
  assert.equal(await stopComfyForHeat(base), true);
  assert.deepEqual(calls, ["POST /queue", "POST /interrupt", "GET /queue"]);
  clearFails = true; calls.length = 0;
  assert.equal(await stopComfyForHeat(base), false);
  assert.ok(calls.includes("POST /interrupt"));
} finally { await new Promise((r) => fake.close(r)); }

// No worker start / GPU / media: exercise the real dispatch loop with a paused thermal gate.
let submitted = 0, paused = 0;
const worker = new AutopilotWorker({ root: join(root, "worker"), python: "unused", script: "unused", comfy: { submit: async () => { submitted++; } }, thermalStatus: () => ({ blocked: true, latched: true, reason: "模拟高温保护" }) });
worker.owner = true;
worker.pauseJob = async (job) => { paused++; job.status = "paused"; };
for (const status of ["pending", "queued", "running", "submitting"]) assert.equal(await worker.runShot({}, { status }), "paused");
assert.equal(submitted, 0); assert.equal(paused, 4);
console.log("PASS: thermal thresholds, stop confirmation, manual resume, persistence, unknown sensors, parallel sampling, timer cleanup, fake Comfy interruption and night dispatch pause");
