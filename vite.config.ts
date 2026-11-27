import vinext from "vinext";
import { defineConfig, type ProxyOptions } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { readExecutionProfile } from "./scripts/execution-profile.mjs";
import { localStartupCachePlugin } from "./scripts/local-startup-cache.mjs";
import { clipboardPlugin } from "./scripts/clipboard-vite-plugin.mjs";
import { queuePathPlugin } from "./scripts/queue-path-vite-plugin.mjs";
import { revealFilePlugin } from "./scripts/reveal-file-vite-plugin.mjs";
import { inboxRootControlPlugin } from './scripts/inbox-root-control.mjs';
import { sites } from "./build/sites-vite-plugin";
import { localStatusPlugin } from "./scripts/local-status-vite-plugin";
import { gpuThermalPlugin } from "./scripts/gpu-thermal-vite-plugin";
import {comfyProgressPlugin} from "./scripts/comfy-progress-vite-plugin";
import { audioExtractPlugin } from "./scripts/audio-extract-vite-plugin";
import { voiceDesignPlugin } from './scripts/voice-design-middleware';
import { roughCutPlugin } from "./scripts/rough-cut-vite-plugin";
import {coverPlugin} from './scripts/cover-vite-plugin';
import { autopilotPlugin } from "./scripts/autopilot-vite-plugin";
import { productionPlugin } from "./scripts/production-vite-plugin";
import { blenderRenderPlugin } from "./scripts/blender-render-vite-plugin";
import { automationPlugin } from "./scripts/automation-vite-plugin";
import { COMFYUI_PROXY_PATH, COMFYUI_SERVER_URL } from "./lib/comfyui/config";
import { Agent } from "node:http";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so sandboxed previews (CODEX_SANDBOX=seatbelt) need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const managedLinux = readExecutionProfile() === "managed-linux";

// Without an agent, Vite's http-proxy sends `Connection: close` upstream and back to the page, so every
// /comfyui request burned two loopback ports (5173 and 8188) into TIME_WAIT. Reuse sockets instead.
const comfyUiAgent = new Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 32, maxFreeSockets: 8, timeout: 60_000 });

const comfyUiProxy: ProxyOptions = {
  target: COMFYUI_SERVER_URL,
  agent: comfyUiAgent,
  changeOrigin: true,
  ws: true,
  rewrite: (path: string) => path.replace(new RegExp(`^${COMFYUI_PROXY_PATH}`), ""),
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyRequest) => proxyRequest.setHeader("origin", COMFYUI_SERVER_URL));
    proxy.on("proxyReqWs", (proxyRequest) => proxyRequest.setHeader("origin", COMFYUI_SERVER_URL));
  },
};

const localBindingConfig = {
  main: "vinext/server/fetch-handler",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Use Miniflare's local Request.cf placeholder unless fetching is requested.
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.WRANGLER_REGISTRY_PATH ??= ".wrangler/dev-registry";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    // A second canvas instance sets this so it does not share the running server's optimizer cache.
    cacheDir: process.env.FRAMEFLOW_VITE_CACHE || "node_modules/.vite",
    server: {
      ...(managedLinux ? { host: "0.0.0.0", allowedHosts: ["terminal.local"] } : {}),
      // runtime/ holds the Autopilot ledger and videos; they are data, not sources to watch.
      watch: { ignored: ["**/runtime/**"], ...(isCodexSeatbeltSandbox ? { useFsEvents: false, usePolling: true } : {}) },
      proxy: {
        [COMFYUI_PROXY_PATH]: comfyUiProxy,
      },
    },
    plugins: [{
      name: "frameflow-instance-html",
      transformIndexHtml() {
        const payload = JSON.stringify({
          id: process.env.FRAMEFLOW_INSTANCE_ID || "",
          name: process.env.FRAMEFLOW_INSTANCE_NAME || "",
          inboxPort: Number(process.env.FRAMEFLOW_INBOX_PORT || 5193),
          claimPort: Number(process.env.FRAMEFLOW_CLAIM_PORT || 8791),
          transfer: "http://127.0.0.1:5198",
        });
        return { tags: [{ tag: "script", injectTo: "head", children: `window.__FRAMEFLOW_INSTANCE__=${payload}` }] };
      },
    }, ...(!managedLinux ? [localStartupCachePlugin(), clipboardPlugin(), queuePathPlugin(), revealFilePlugin(), inboxRootControlPlugin()] : []), comfyProgressPlugin(),
      vinext(),
      sites({ mockAuth: !managedLinux }),
      gpuThermalPlugin(),
      localStatusPlugin(),
      audioExtractPlugin(),
      voiceDesignPlugin(),
      roughCutPlugin(),
      coverPlugin(),
      autopilotPlugin(),
      productionPlugin(),
      blenderRenderPlugin(),
      automationPlugin(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});
