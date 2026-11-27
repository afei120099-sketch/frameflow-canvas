import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mediaAuditRoute } from "./media-audit-route.ts";
import { PYAV_PYTHON } from "./pyav-runtime.ts";
const dir = await mkdtemp(join(tmpdir(), "frameflow-audit-test-"));
const run = promisify(execFile), route = mediaAuditRoute();
const server = createServer((req, res) => void route.handle(req, res));
await new Promise((r) => server.listen(0, "127.0.0.1", r)); const url = `http://127.0.0.1:${server.address().port}`;
const before = (await readdir(tmpdir())).filter((n) => n.startsWith("frameflow-audit-"));
try {
  await run(PYAV_PYTHON, [fileURLToPath(new URL("rough-cut-fixtures.py", import.meta.url)), "make", dir], { windowsHide: true });
  await run(PYAV_PYTHON, [fileURLToPath(new URL("media-audit-fixtures.py", import.meta.url)), dir], { windowsHide: true });
  const inspect = async (name) => {
    const bytes = await readFile(join(dir, name));
    for (let i = 0; i < 20; i++) {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream", Origin: url }, body: bytes });
      if (response.status !== 409) return response;
      await response.arrayBuffer(); await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("CPU route did not finish cleanup");
  };
  const good = await inspect("a24_audio.mp4"); assert.equal(good.status, 200); const report = await good.json();
  assert.equal(report.hasAudio, true); assert.equal(report.frames, 96); assert.equal(report.fps, 24); assert.ok(report.samples.length >= 10); assert.match(report.sourceHash, /^[a-f0-9]{64}$/);
  const silent = await (await inspect("b48_silent_portrait.mp4")).json(); assert.equal(silent.hasAudio, false); assert.ok(silent.warnings.length);
  const black = await (await inspect("black.mp4")).json(); assert.equal(black.frames, 24); assert.equal(black.blackRanges.length, 1); assert.ok(black.warnings.some((w) => w.includes("近黑")));
  assert.equal((await inspect("broken.mp4")).status, 422);
  assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream", Origin: "https://evil.example" }, body: "bad" })).status, 403);
  assert.equal((await fetch(url)).status, 405);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual((await readdir(tmpdir())).filter((n) => n.startsWith("frameflow-audit-")).sort(), before.sort(), "all audit upload temp folders removed");
  console.log("PASS real CPU media audit: full decode, audio/silent, timestamps, samples, hash, corrupt file, same-origin security, temp cleanup");
} finally { route.close(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); }
