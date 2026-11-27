import { join } from "node:path";
import type { Plugin } from "vite";
import { COMFYUI_SERVER_URL } from "../lib/comfyui/config.ts";
import { GpuThermalSafety, readGpuTemperature } from "./gpu-thermal-safety.ts";

const registry = globalThis as typeof globalThis & { frameflowThermal?: GpuThermalSafety };
export const thermalSafety = () => registry.frameflowThermal;
export async function stopComfyForHeat(base: string) {
  const call = async (path: string, body?: object) => {
    const response = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`ComfyUI ${response.status}`);
    return response;
  };
  // Even if clearing pending jobs fails, still request interruption of the active job.
  let failed = false;
  await call("/queue", { clear: true }).catch(() => { failed = true; });
  await call("/interrupt", {}).catch(() => { failed = true; });
  const queue = await (await call("/queue")).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  return !failed && Array.isArray(queue.queue_running) && Array.isArray(queue.queue_pending) && !queue.queue_running.length && !queue.queue_pending.length;
}
export function gpuThermalPlugin(): Plugin {
  return { name: "frameflow-gpu-thermal-safety", configureServer(server) {
    const previous = registry.frameflowThermal;
    const previousStopped = previous?.stop();
    const guard = new GpuThermalSafety({
      file: join(server.config.root, process.env.FRAMEFLOW_AUTOPILOT_DIR || "runtime/autopilot", "thermal-safety.json"),
      readTemperature: async () => { await previousStopped; return readGpuTemperature(); },
      stopComfy: () => stopComfyForHeat(process.env.FRAMEFLOW_COMFYUI_URL || COMFYUI_SERVER_URL),
    });
    registry.frameflowThermal = guard;
    guard.start();
    server.httpServer?.once("close", () => { void guard.stop(); });
    server.middlewares.use(async (request, response, next) => {
      const path = (request.url ?? "").split("?")[0];
      const resume = path === "/__thermal_safety/resume" && request.method === "POST";
      const submit = path === "/comfyui/prompt" && request.method === "POST";
      if (!resume && !submit) return next();
      const host = request.headers.host ?? "";
      const origin = request.headers.origin;
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) || !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(request.socket.remoteAddress ?? "") || (origin && origin !== `http://${host}`) || (resume && !request.headers["content-type"]?.startsWith("application/json"))) {
        response.statusCode = 403; response.end(); return;
      }
      try {
        if (resume) await guard.resume(); else await guard.assertCanSubmit();
        if (submit) return next();
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(guard.status()));
      } catch (cause) {
        response.statusCode = 503; response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }));
      }
    });
  } };
}
