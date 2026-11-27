import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

/**
 * Test-only stand-in for the ComfyUI HTTP API used by Autopilot (scripts/test-autopilot-m1.mjs and
 * the isolated browser smoke). No GPU, no models: an accepted prompt "runs" for runMs and then
 * "outputs" a fixture MP4 chosen by the workflow's seed. Executes one prompt at a time like ComfyUI.
 * Failure switches on `state` let a test drop connections, fail executions or break /view.
 *
 *   node scripts/fake-comfyui.mjs <port> <seed>=<file.mp4> …   (standalone, for the browser smoke)
 */

export async function startFakeComfy({ files, port = 0, runMs = 100 }) {
  const bySeed = new Map(files.map((file) => [Number(file.seed), file.path]));
  const state = {
    runMs,
    offline: false,         // every request is dropped (as if ComfyUI were not running)
    dropBeforeAccept: 0,    // POST /prompt: connection dropped before the prompt is queued
    dropAfterAccept: 0,     // POST /prompt: queued, then the connection drops before the answer
    rejectPrompt: 0,        // POST /prompt: HTTP 400 validation error
    failures: [],           // next executions fail with these exception messages
    viewFailures: 0,        // GET /view: HTTP 500
    onPrompt: null,         // (promptId, body) => void, called when a prompt is received (before it is queued)
    prompts: [],            // accepted prompts: { id, seed, body, acceptedAt, startedAt, finishedAt, fetchedAt, state }
    promptPosts: 0,         // every POST /prompt, accepted or not
    cancels: [],
    maxConcurrent: 0,
  };
  const history = new Map();
  const queue = [];
  let running = null;
  const find = (id) => state.prompts.find((prompt) => prompt.id === id);

  function pump() {
    if (running || !queue.length) return;
    const id = queue.shift();
    const prompt = find(id);
    prompt.startedAt = Date.now(); prompt.state = "running";
    running = { id, timer: setTimeout(() => finish(id), state.runMs) };
  }
  function finish(id, interrupted = false) {
    if (running?.id === id) { clearTimeout(running.timer); running = null; }
    const prompt = find(id);
    prompt.finishedAt = Date.now();
    const error = interrupted ? null : state.failures.shift();
    if (interrupted) { prompt.state = "interrupted"; history.set(id, { status: { status_str: "error", completed: false, messages: [["execution_interrupted", { prompt_id: id }]] }, outputs: {} }); }
    else if (error) { prompt.state = "failed"; history.set(id, { status: { status_str: "error", completed: false, messages: [["execution_error", { prompt_id: id, exception_message: error }]] }, outputs: {} }); }
    else { prompt.state = "done"; history.set(id, { status: { status_str: "success", completed: true, messages: [] }, outputs: { 15: { images: [{ filename: `fake_${id}.mp4`, subfolder: "video", type: "output" }], animated: [true] } } }); }
    pump();
  }
  const json = (response, status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
  const readBody = (request) => new Promise((resolve) => { const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); } }); });

  const server = createServer(async (request, response) => {
    if (state.offline) { request.socket.destroy(); return; }
    const url = new URL(request.url, "http://fake");
    const path = url.pathname;
    if (request.method === "GET" && path === "/system_stats") return json(response, 200, { system: { comfyui_version: "fake-0.0.0", python_version: "3.12.0 (fake)", pytorch_version: "fake" } });
    if (request.method === "GET" && path.startsWith("/object_info/")) { const name = decodeURIComponent(path.slice(13)); return json(response, 200, { [name]: { python_module: "comfy_extras.nodes_fake" } }); }
    if (request.method === "POST" && path === "/prompt") {
      state.promptPosts += 1;
      if (state.dropBeforeAccept > 0) { state.dropBeforeAccept -= 1; request.socket.destroy(); return; }
      const body = await readBody(request);
      if (state.rejectPrompt > 0) { state.rejectPrompt -= 1; return json(response, 400, { error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" }, node_errors: { 6: { errors: [] } } }); }
      const id = typeof body.prompt_id === "string" ? body.prompt_id : randomUUID();
      state.onPrompt?.(id, body);
      state.prompts.push({ id, seed: Number(body.prompt?.["10"]?.inputs?.noise_seed), body, acceptedAt: Date.now(), startedAt: null, finishedAt: null, fetchedAt: null, state: "queued" });
      queue.push(id);
      state.maxConcurrent = Math.max(state.maxConcurrent, queue.length + (running ? 1 : 0));
      pump();
      if (state.dropAfterAccept > 0) { state.dropAfterAccept -= 1; request.socket.destroy(); return; }
      return json(response, 200, { prompt_id: id, number: state.prompts.length, node_errors: {} });
    }
    // Canvas H3 smoke (first frame / guides): accept an upload and answer with a name, like ComfyUI's /upload/image.
    if (request.method === "POST" && path === "/upload/image") { for await (const chunk of request) void chunk; state.uploads = (state.uploads ?? 0) + 1; return json(response, 200, { name: `fake_upload_${state.uploads}.png`, subfolder: "", type: "input" }); }
    if (request.method === "GET" && path === "/queue") return json(response, 200, { queue_running: running ? [[0, running.id, {}, {}, []]] : [], queue_pending: queue.map((id, index) => [index + 1, id, {}, {}, []]) });
    if (request.method === "POST" && path === "/queue") { const body = await readBody(request); for (const id of body.delete ?? []) { const at = queue.indexOf(id); if (at >= 0) queue.splice(at, 1); } return json(response, 200, {}); }
    if (request.method === "POST" && path === "/interrupt") { const body = await readBody(request); if (running && (!body.prompt_id || body.prompt_id === running.id)) finish(running.id, true); return json(response, 200, {}); }
    if (request.method === "POST" && /^\/api\/jobs\/[^/]+\/cancel$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]);
      state.cancels.push(id);
      const at = queue.indexOf(id);
      if (at >= 0) { queue.splice(at, 1); find(id).state = "cancelled"; return json(response, 200, { cancelled: true }); }
      if (running?.id === id) { finish(id, true); return json(response, 200, { cancelled: true }); }
      return json(response, 200, { cancelled: false });
    }
    if (request.method === "GET" && path.startsWith("/history/")) { const id = decodeURIComponent(path.slice(9)); return json(response, 200, history.has(id) ? { [id]: history.get(id) } : {}); }
    if (request.method === "GET" && path === "/view") {
      if (state.viewFailures > 0) { state.viewFailures -= 1; return json(response, 500, { error: "view failed" }); }
      const id = (url.searchParams.get("filename") ?? "").replace(/^fake_/, "").replace(/\.mp4$/, "");
      const prompt = find(id);
      // M1 seeds map to fixed clips; other seeds (M2 plans) take the fixtures in submission order.
      const file = prompt ? bySeed.get(prompt.seed) ?? files[state.prompts.indexOf(prompt) % files.length]?.path : null;
      if (!file) return json(response, 404, { error: "not found" });
      prompt.fetchedAt ??= Date.now();
      const bytes = readFileSync(file);
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
      response.end(bytes);
      return;
    }
    json(response, 404, { error: "unknown" });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    /** ComfyUI restarted: queue, running job and history are gone. */
    restart() { if (running) { clearTimeout(running.timer); running = null; } queue.length = 0; history.clear(); },
    close() { if (running) clearTimeout(running.timer); server.closeAllConnections?.(); return new Promise((resolve) => server.close(() => resolve())); },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const [port, ...pairs] = process.argv.slice(2);
  const files = pairs.map((pair) => { const at = pair.indexOf("="); return { seed: Number(pair.slice(0, at)), path: pair.slice(at + 1) }; });
  const fake = await startFakeComfy({ files, port: Number(port), runMs: Number(process.env.FAKE_COMFY_RUN_MS ?? 4000) });
  console.log(`fake ComfyUI listening on ${fake.url} (run ${fake.state.runMs} ms per prompt)`);
}
