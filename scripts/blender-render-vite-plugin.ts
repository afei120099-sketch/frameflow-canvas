import type { Plugin } from "vite";
import { findBlender, WHITEBOX_RENDER_SCRIPT } from "./blender-runtime";
import { createBlenderRenderHandler } from "./blender-render-routes";

/** Director Stage 一键白模首帧: the local dev server runs the portable Blender for the page (see blender-render-routes.ts). */
export function blenderRenderPlugin(): Plugin {
  return {
    name: "frameflow-blender-render",
    configureServer(server) {
      const handle = createBlenderRenderHandler({ blender: findBlender, script: WHITEBOX_RENDER_SCRIPT, log: (line) => server.config.logger.info(line, { timestamp: true }) });
      server.middlewares.use("/__blender_render", (request, response) => { void handle(request, response); });
    },
  };
}
