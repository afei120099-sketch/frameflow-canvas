import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { COMFYUI_SERVER_URL } from "../lib/comfyui/config";
import { ProductionComfyClient } from "../lib/production/comfy-client";
import { thermalSafety } from "./gpu-thermal-vite-plugin";
import { createProductionHandler, readPage } from "./production-routes";
import { forwardProduction } from "./production-proxy";
import { ProductionWorker } from "./production-worker";
import { PYAV_PYTHON, ROUGH_CUT_SCRIPT } from "./pyav-runtime";

/**
 * 生产线 host. The worker runs inside the default canvas dev server (5173) — the split instances
 * (5174–5177) only serve the page and API reads; a lock file keeps a single owner either way.
 * Ledger and media under <project>/runtime/production (FRAMEFLOW_PRODUCTION_DIR overrides).
 * Page: http://localhost:5173/__production/
 */

const REGISTRY_KEY = "__frameflowProductionWorker";

/** The inbox's shared switches also hold the production line: a root STOP file, or _control.json submit:false. */
async function inboxHold(): Promise<string | null> {
  const root = process.env.FRAMEFLOW_INBOX_ROOT || join(resolve(process.env.FRAMEFLOW_DATA_ROOT || "data"), "inbox");
  if (await stat(join(root, "STOP")).then((info) => info.isFile(), () => false)) return "收件箱根目录有 STOP 文件";
  let text: string;
  try { text = await readFile(join(root, "_control.json"), "utf8"); } catch { return null; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { const control = JSON.parse(text) as { submit?: unknown }; return control.submit === false ? "收件箱总控 submit:false" : null; }
  catch { return "收件箱总控 _control.json 写错了"; }
}
type Registry = { [REGISTRY_KEY]?: ProductionWorker };

export function productionPlugin(): Plugin {
  return {
    name: "frameflow-production",
    configureServer(server) {
      const root = process.env.FRAMEFLOW_PRODUCTION_DIR || fileURLToPath(new URL("../runtime/production", import.meta.url));
      const comfyUrl = process.env.FRAMEFLOW_COMFYUI_URL || COMFYUI_SERVER_URL;
      const page = fileURLToPath(new URL("./production-ui.html", import.meta.url));
      const registry = globalThis as Registry;
      const previous = registry[REGISTRY_KEY];
      const worker = new ProductionWorker({
        root,
        comfy: new ProductionComfyClient(comfyUrl),
        python: PYAV_PYTHON,
        checksScript: fileURLToPath(new URL("./production-checks.py", import.meta.url)),
        roughCutScript: ROUGH_CUT_SCRIPT,
        report: (line) => server.config.logger.info(line, { timestamp: true }),
        beforeSubmit: async () => { const guard = thermalSafety(); if (guard) await guard.assertCanSubmit(); },
        holdReason: inboxHold,
      });
      registry[REGISTRY_KEY] = worker;
      const isDefaultInstance = !process.env.FRAMEFLOW_INSTANCE_ID;
      void (async () => {
        // A Vite restart builds the new server before closing the old one: let the old worker finish its tick first.
        await previous?.stop().catch(() => {});
        if (isDefaultInstance) await worker.start();
        else await worker.store.init();
      })().catch((cause) => server.config.logger.error(`[production] 生产线启动失败：${cause instanceof Error ? cause.message : String(cause)}`));
      server.httpServer?.once("close", () => { void worker.stop(); if (registry[REGISTRY_KEY] === worker) delete registry[REGISTRY_KEY]; });
      const handle = createProductionHandler(worker, () => readPage(page));
      // Split canvases serve the page themselves (so the role bridge reads *their* roles) and forward
      // API/media to the one worker in the default canvas, tagged with their instance id.
      const instanceId = process.env.FRAMEFLOW_INSTANCE_ID || "";
      const ownerBase = process.env.FRAMEFLOW_PRODUCTION_OWNER || "http://127.0.0.1:5173";
      server.middlewares.use("/__production", (request, response) => {
        const path = (request.url ?? "/").split("?")[0];
        if (instanceId && /^\/(api|media)\//.test(path)) { forwardProduction(request, response, ownerBase, instanceId, request.url ?? "/", process.env.FRAMEFLOW_INSTANCE_NAME || instanceId); return; }
        void handle(request, response);
      });
    },
  };
}
