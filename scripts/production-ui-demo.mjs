// UI preview for the production line: real routes + worker, fake ComfyUI that "renders" by copying
// sample files. Never talks to the real ComfyUI. Usage:
//   node --experimental-strip-types scripts/production-ui-demo.mjs <port> <sampleImage>... --video <sample.mp4>
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProductionComfyClient } from "../lib/production/comfy-client.ts";
import { ProductionWorker } from "./production-worker.ts";
import { createProductionHandler, EPISODE_TEMPLATE } from "./production-routes.ts";

const args = process.argv.slice(2);
const port = Number(args[0] || 5199);
const videoAt = args.indexOf("--video");
const video = videoAt > 0 ? await readFile(args[videoAt + 1]) : new Uint8Array([0]);
const images = await Promise.all(args.slice(1, videoAt > 0 ? videoAt : undefined).map((path) => readFile(path)));
let turn = 0;
const prompts = new Map(); const pending = [];
const json = (v) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } });
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url); const path = u.pathname;
  if (path === "/queue" && (init.method ?? "GET") === "GET") return json({ queue_running: pending.slice(0, 1).map((id) => [0, id, {}, { frameflowInstance: "production" }]), queue_pending: pending.slice(1).map((id) => [1, id, {}, { frameflowInstance: "production" }]) });
  if (path === "/upload/image") return json({ name: `demo_${Date.now()}.png` });
  if (path === "/prompt") { const body = JSON.parse(init.body); prompts.set(body.prompt_id, { video: !!body.prompt["148"], done: false }); pending.push(body.prompt_id); setTimeout(() => { prompts.get(body.prompt_id).done = true; pending.splice(pending.indexOf(body.prompt_id), 1); }, 2500); return json({ prompt_id: body.prompt_id }); }
  if (path.startsWith("/history/")) {
    const id = decodeURIComponent(path.slice(9)); const p = prompts.get(id);
    if (!p?.done) return json({});
    return json({ [id]: { prompt: [0, id, {}, { frameflowInstance: "production" }], status: { completed: true, status_str: "success" }, outputs: p.video ? { "148": { gifs: [{ filename: "c-audio.mp4", subfolder: "", type: "output" }] } } : { "7": { images: [{ filename: `k${turn++}.png`, subfolder: "", type: "output" }] }, "45": { images: [{ filename: "d.png", subfolder: "", type: "output" }] } } } });
  }
  if (path === "/view") { const name = u.searchParams.get("filename"); return new Response(name.endsWith(".mp4") ? video : images[(turn + 1) % images.length]); }
  return json({});
};
const root = await mkdtemp(join(tmpdir(), "production-ui-demo-"));
const worker = new ProductionWorker({
  root, comfy: new ProductionComfyClient("http://fake", fakeFetch), python: "", checksScript: "", roughCutScript: "", pollMs: 1500,
  exec: async (a) => a[0] === "face" || a[1] === "face" ? JSON.stringify({ results: [{ face: Math.round((0.35 + Math.random() * 0.5) * 100) / 100, faces: 1 }] }) : JSON.stringify({ duration: 6.1, hasAudio: true, blackFrames: 0, frozenRatio: 0.02, problems: [] }),
});
await worker.start();
const def = structuredClone(EPISODE_TEMPLATE);
def.title = "示例项目 · 第1集（界面演示）";
def.shots.push({ ...def.shots[0], shotId: "S03", title: "两人对视", storyboard: "S03.png", faceRole: "zhangsan", seconds: 7 }, { ...def.shots[1], shotId: "S04", title: "空办公室", storyboard: "S04.png", faceRole: null, seconds: 5 });
const ep = await worker.createEpisode(JSON.stringify(def));
const names = ["S01.png", "S02.png", "S03.png", "zhangsan_face.png", "lisi_face.png", "zhangsan_full.png", "lisi_full.png", "zhangsan_voice.wav", "lisi_voice.wav"];
for (const [i, name] of names.entries()) await worker.uploadMedia(ep.episodeId, name, images[i % images.length]);
await worker.enqueue(ep.episodeId, "keyframe", { shotIds: ["S01", "S02", "S03"] }).catch((e) => console.error(e.message));
const page = fileURLToPath(new URL("./production-ui.html", import.meta.url));
const handle = createProductionHandler(worker, () => readFile(page, "utf8"));
createServer((req, res) => {
  if (!req.url.startsWith("/__production")) { res.writeHead(302, { Location: "/__production/" }); res.end(); return; }
  req.url = req.url.slice("/__production".length) || "/";
  void handle(req, res);
}).listen(port, "127.0.0.1", () => console.log(`demo at http://127.0.0.1:${port}/__production/  (data ${root})`));
