import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { COMFYUI_SERVER_URL } from "../lib/comfyui/config";
import { ComfyUIH3Adapter } from "../lib/comfyui/h3-adapter";
import { createAutopilotHandler } from "./autopilot-routes";
import { AutopilotWorker } from "./autopilot-worker";
import { loadDirectorSettings } from "./director-claude";
import { PYAV_PYTHON, ROUGH_CUT_SCRIPT } from "./pyav-runtime";
import { thermalSafety } from "./gpu-thermal-vite-plugin";

class ProtectedComfyAdapter extends ComfyUIH3Adapter {
  override async submit(request: Parameters<ComfyUIH3Adapter["submit"]>[0]) {
    const guard = thermalSafety();
    if (!guard) throw new Error("GPU 温度保护服务未就绪");
    await guard.assertCanSubmit();
    return super.submit(request);
  }
}

/**
 * Autopilot M1 host: the worker lives in the local dev server process (the one the desktop launcher
 * starts hidden), not in the page — closing the canvas tab leaves it running. Ledger and media under
 * <project>/runtime/autopilot (FRAMEFLOW_AUTOPILOT_DIR overrides; FRAMEFLOW_COMFYUI_URL overrides ComfyUI).
 */

const REGISTRY_KEY = "__frameflowAutopilotWorker";
type Registry = { [REGISTRY_KEY]?: AutopilotWorker };

export function autopilotPlugin(): Plugin {
  return {
    name: "frameflow-autopilot",
    configureServer(server) {
      const root = process.env.FRAMEFLOW_AUTOPILOT_DIR || fileURLToPath(new URL("../runtime/autopilot", import.meta.url));
      const comfyUrl = process.env.FRAMEFLOW_COMFYUI_URL || COMFYUI_SERVER_URL;
      // Vite builds the new server before closing the old one on a restart: the new worker waits until
      // the old one has stopped at a safe point, then takes the runtime folder over and resumes from disk.
      const registry = globalThis as Registry;
      const previous = registry[REGISTRY_KEY];
      const worker = new AutopilotWorker({
        root, python: PYAV_PYTHON, script: ROUGH_CUT_SCRIPT,
        comfy: new ProtectedComfyAdapter(comfyUrl, { timeoutMs: 120_000 }),
        thermalStatus: () => thermalSafety()?.status(),
        handover: previous?.stop(),
        report: (line) => server.config.logger.info(line, { timestamp: true }),
        // mock / local-lmstudio / claude: config/director-providers.json or FRAMEFLOW_DEFAULT_DIRECTOR.
        defaultDirector: loadDirectorSettings().defaultDirector,
      });
      registry[REGISTRY_KEY] = worker;
      void worker.start().catch((cause) => server.config.logger.error(`[autopilot] 夜班服务启动失败：${cause instanceof Error ? cause.message : String(cause)}`));
      server.httpServer?.once("close", () => { void worker.stop(); if (registry[REGISTRY_KEY] === worker) delete registry[REGISTRY_KEY]; });
      const handle = createAutopilotHandler(worker);
      server.middlewares.use("/__autopilot", (request, response) => { void handle(request, response); });
    },
  };
}
