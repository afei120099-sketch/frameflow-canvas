// Per-canvas production lines: one worker (default canvas), split canvases forward with their instance id.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductionComfyClient } from "../lib/production/comfy-client.ts";
import { ProductionWorker } from "./production-worker.ts";
import { createProductionHandler, EPISODE_TEMPLATE } from "./production-routes.ts";
import { forwardProduction } from "./production-proxy.ts";

const json = (v) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } });
const idleComfy = async (url) => new URL(url).pathname === "/queue" ? json({ queue_running: [], queue_pending: [] }) : json({});
const root = await mkdtemp(join(tmpdir(), "production-canvas-"));
const listen = (handler) => new Promise((resolve) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => resolve(s)); });
try {
  const worker = new ProductionWorker({ root, comfy: new ProductionComfyClient("http://fake", idleComfy), python: "", checksScript: "", roughCutScript: "", pollMs: 3_600_000, heartbeatMs: 3_600_000 });
  await worker.start();
  const owner = await listen((req, res) => { req.url = req.url.replace(/^\/__production/, "") || "/"; void createProductionHandler(worker, async () => "<html>page</html>")(req, res); });
  const ownerBase = `http://127.0.0.1:${owner.address().port}`;
  const splitFor = (canvas, base = ownerBase) => listen((req, res) => {
    const path = req.url.replace(/^\/__production/, "") || "/";
    if (/^\/(api|media)\//.test(path)) forwardProduction(req, res, base, canvas, path, canvas === "yemian2" ? "页面 2" : "");
    else { res.end("<html>split page</html>"); }
  });
  const page2 = await splitFor("yemian2");
  const page1 = await splitFor("page1");
  const at = (server) => `http://127.0.0.1:${server.address().port}/__production`;
  const post = (base, path, body, type = "application/json") => fetch(base + path, { method: path.includes("/media/") ? "PUT" : "POST", headers: { "X-Frameflow-Production": "1", "Content-Type": type }, body });

  // Default canvas creates one, 页面 2 creates one through the forwarder.
  const mainId = (await worker.createEpisode(JSON.stringify({ ...EPISODE_TEMPLATE, title: "主画布的剧" }))).episodeId;
  const created = await (await post(at(page2), "/api/episodes", JSON.stringify({ ...EPISODE_TEMPLATE, title: "页面2的剧" }))).json();
  assert.ok(created.episodeId, "created through the split canvas");
  assert.equal((await worker.get(created.episodeId)).episode.canvas, "yemian2", "tagged with the split canvas");
  assert.equal((await worker.get(mainId)).episode.canvas, undefined, "default canvas episodes carry no tag");

  // Each canvas sees only its own.
  const titles = async (base) => (await (await fetch(base + "/api/overview")).json()).episodes.map((e) => e.title);
  assert.deepEqual(await titles(`${ownerBase}/__production`), ["主画布的剧"]);
  assert.deepEqual(await titles(at(page2)), ["页面2的剧"]);
  assert.deepEqual(await titles(at(page1)), []);
  const ov = await (await fetch(at(page2) + "/api/overview")).json();
  assert.equal(ov.canvas, "yemian2"); assert.equal(ov.canvasName, "页面 2");
  // A brand-new canvas nobody listed anywhere works the same way.
  const fresh = await splitFor("juben-07");
  await post(at(fresh), "/api/episodes", JSON.stringify({ ...EPISODE_TEMPLATE, title: "新建画布的剧" }));
  assert.deepEqual(await titles(at(fresh)), ["新建画布的剧"]);
  assert.equal((await (await fetch(at(fresh) + "/api/overview")).json()).canvasName, "juben-07");
  fresh.close(); assert.equal(ov.owner, true, "split page talks to the worker that owns the GPU");

  // Uploads, reads, media and the write guard all pass through.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const up = await post(at(page2), `/api/episodes/${created.episodeId}/media/S01.png`, png, "application/octet-stream");
  assert.equal(up.status, 200);
  const media = await fetch(`${at(page2)}/media/${created.episodeId}/inputs/S01.png`, { headers: { Range: "bytes=0-3" } });
  assert.equal(media.status, 206); assert.equal((await media.arrayBuffer()).byteLength, 4);
  assert.equal((await fetch(at(page2) + "/api/episodes", { method: "POST", body: "{}" })).status, 403, "header still required");
  assert.equal((await (await fetch(`${at(page2)}/api/episodes/${created.episodeId}`)).json()).episode.title, "页面2的剧");
  assert.equal(await (await fetch(at(page2) + "/")).text(), "<html>split page</html>", "page itself is served by the split canvas");

  // Owner down → clear 502, not a hang.
  const orphan = await splitFor("yemian1", "http://127.0.0.1:9");
  const down = await fetch(at(orphan) + "/api/overview");
  assert.equal(down.status, 502); assert.match((await down.json()).error, /主画布/);
  for (const s of [owner, page1, page2, orphan]) s.close();
  await worker.stop();
  console.log("production per-canvas: ok (tagging, filtering, forwarding uploads/media/range, guard, owner-down error)");
} finally {
  await new Promise((r) => setTimeout(r, 200));
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
