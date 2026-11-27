import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveAutopilot, verifyNightArchive } from "./archive-autopilot.mjs";
import { withProjectMediaWrite, withProjectRestoreLock } from "../lib/project-media-lock.ts";

let release;
let entered = false;
const holding = new Promise((done) => { release = done; });
const writer = withProjectMediaWrite(async () => { await holding; });
const restoring = withProjectRestoreLock(async () => {
  entered = true;
  await assert.rejects(() => withProjectMediaWrite(async () => {}), /正在恢复/);
});
await new Promise((done) => setTimeout(done, 10));
assert.equal(entered, false, "restore waits for existing writer");
release(); await writer; await restoring;
assert.equal(entered, true);
await withProjectMediaWrite(async () => {}); // lock released after success
await assert.rejects(() => withProjectRestoreLock(async () => { throw new Error("failure"); }), /failure/);
await withProjectMediaWrite(async () => {}); // lock released after failure

// Cross-tab API path: lock unavailable => fail closed, never execute the writer.
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
let writes = 0;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_name, options, action) => {
  assert.equal(options.mode, "shared"); assert.equal(options.ifAvailable, true); return action(null);
} } } });
await assert.rejects(() => withProjectMediaWrite(async () => { writes++; }), /正在恢复/);
assert.equal(writes, 0);
if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor); else delete globalThis.navigator;

const temporary = await mkdtemp(join(tmpdir(), "frameflow-safety-test-"));
try {
  const root = join(temporary, "night"); const destination = join(temporary, "archives");
  await mkdir(join(root, "jobs"), { recursive: true });
  await mkdir(join(root, "job-1", "output"), { recursive: true });
  await writeFile(join(root, "jobs", "job-1.json"), JSON.stringify({ plan: "test", status: "completed" }));
  await writeFile(join(root, "job-1", "output", "test.mp4"), "CPU-only fake media bytes");
  const archive = await archiveAutopilot(root, destination);
  assert.equal(await verifyNightArchive(archive), 2);
  const manifest = JSON.parse(await readFile(join(archive, "manifest.json"), "utf8"));
  assert.equal(manifest.files.some((file) => file.path === "worker.lock"), false);
  assert.equal(await readFile(join(archive, "data", "jobs", "job-1.json"), "utf8"), await readFile(join(root, "jobs", "job-1.json"), "utf8"));
  await writeFile(join(root, "worker.lock"), JSON.stringify({ pid: process.pid, instance: "live-test", heartbeat: new Date().toISOString() }));
  await assert.rejects(() => archiveAutopilot(root, destination), /仍在运行/);
  await writeFile(join(root, "worker.lock"), "malformed");
  await assert.rejects(() => archiveAutopilot(root, destination), /锁文件无法解析/);
  await assert.rejects(() => archiveAutopilot(root, join(root, "bad-destination")), /内部/);
  await writeFile(join(archive, "data", "job-1", "output", "test.mp4"), "damaged");
  await assert.rejects(() => verifyNightArchive(archive), /校验失败/);
} finally { await rm(temporary, { recursive: true, force: true }); }
console.log("Data safety: restore/write exclusion, lock release, cross-tab fail-closed, night archive hash verification, live-worker refusal, corruption refusal passed; no GPU");
