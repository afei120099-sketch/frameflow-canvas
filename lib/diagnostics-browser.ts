import type { DiagnosticsDeps } from "./diagnostics.ts";
import { COMFYUI_PROXY_PATH, COMFYUI_SERVER_URL, getComfyWebSocketUrl } from "./comfyui/config.ts";
import { buildH3Workflow } from "./comfyui/h3-adapter.ts";
import { buildReferenceWorkflow, buildSeedVR2Workflow } from "./comfyui/extra-workflows.ts";
import { buildFilmWorkflow } from "./comfyui/film-workflow.ts";
import { saveNodeForCapability } from "./run-recovery.ts";
import { listAssets, listRuns, listShots } from "./production-records.ts";
import { listRoles } from "./role-records.ts";
import h3Template from "./comfyui/h3-workflow.json" with { type: "json" };
import referenceTemplate from "./comfyui/h3-reference-workflow.json" with { type: "json" };
import upscaleTemplate from "./comfyui/seedvr2-workflow.json" with { type: "json" };
import filmTemplate from "./comfyui/film-workflow.json" with { type: "json" };

const TIMEOUT_MS = 4_000;
const REF_SETTINGS = { length: 141, aspect: "16:9" as const, megapixels: 0.5, turbo: true, steps: 6, fps: 24, loraStrength: 1, upscaleMethod: "lanczos" as const, resolutionSteps: 32 };
const DATABASES = ["frameflow-production-records", "frameflow-role-records", "frameflow-local-media", "frameflow-local-audio", "TLDRAW_DOCUMENT_v2frameflow-v0.1-canvas"];

async function existing() { return new Set((await indexedDB.databases()).map((db) => db.name ?? "")); }
/** Opens an existing database at its current version; never creates or upgrades one. */
function openExisting(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error("数据库不存在")); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开"));
  });
}
const keysOf = (db: IDBDatabase, store: string) => new Promise<string[]>((resolve, reject) => {
  if (!db.objectStoreNames.contains(store)) { resolve([]); return; }
  const request = db.transaction(store, "readonly").objectStore(store).getAllKeys();
  request.onsuccess = () => resolve((request.result as IDBValidKey[]).map(String));
  request.onerror = () => reject(request.error ?? new Error(`${store} 读取失败`));
});
const countOf = (db: IDBDatabase, store: string) => new Promise<number>((resolve, reject) => {
  const request = db.transaction(store, "readonly").objectStore(store).count();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error(`${store} 计数失败`));
});

export function browserDiagnosticsDeps(): DiagnosticsDeps {
  return {
    systemStats: async () => {
      const response = await fetch(`${COMFYUI_PROXY_PATH}/system_stats`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
      let body: unknown = null; try { body = await response.json(); } catch { /* non-JSON error page */ }
      return { status: response.status, body };
    },
    templates: [
      { name: "h3-workflow.json（FL2VA）", template: h3Template, build: () => buildH3Workflow("diagnostic.png", "diagnostic", 1), requiredNodes: { 6: "MiniMaxH3ImageToVideo", 15: "SaveVideo", 20: "LoadImage" } },
      { name: "h3-reference-workflow.json（Ref2VA）", template: referenceTemplate, build: () => buildReferenceWorkflow({ images: ["diagnostic.png"], videos: [], audios: [] }, "diagnostic", 1, REF_SETTINGS), requiredNodes: { 92: "SaveVideo", 136: "MiniMaxH3ReferenceToVideo", 138: "PrimitiveStringMultiline" } },
      { name: "seedvr2-workflow.json", template: upscaleTemplate, build: () => buildSeedVR2Workflow("diagnostic.mp4"), requiredNodes: { 73: "LoadVideo", 76: "SaveVideo", "66:52": "UNETLoader", "66:105": "PrimitiveBoolean" } },
      { name: "film-workflow.json", template: filmTemplate, build: () => buildFilmWorkflow("diagnostic.mp4"), requiredNodes: { 7: "SaveVideo", "16:1": "FrameInterpolationModelLoader", "16:2": "FrameInterpolate", "16:9": "PrimitiveInt" } },
    ],
    adapterConfig: {
      serverUrl: COMFYUI_SERVER_URL,
      proxyPath: COMFYUI_PROXY_PATH,
      saveNodes: Object.fromEntries((["h3_fl2va", "h3_ref2va", "seedvr2_upscale", "film_interpolation"] as const).map((id) => [id, saveNodeForCapability(id)])),
      webSocketUrl: getComfyWebSocketUrl(window.location.hostname),
    },
    records: async () => {
      const [assets, runs, shots, roles] = await Promise.all([listAssets(), listRuns(), listShots(), listRoles()]);
      return { assets, runs, shots, roles } as unknown as Awaited<ReturnType<DiagnosticsDeps["records"]>>;
    },
    mediaKeys: async () => {
      const names = await existing();
      const media = names.has("frameflow-local-media") ? await openExisting("frameflow-local-media") : null;
      const audio = names.has("frameflow-local-audio") ? await openExisting("frameflow-local-audio") : null;
      try { return { images: media ? await keysOf(media, "images") : [], videos: media ? await keysOf(media, "videos") : [], audios: audio ? await keysOf(audio, "audios") : [] }; }
      finally { media?.close(); audio?.close(); }
    },
    audioEndpoint: async () => {
      const response = await fetch("/__audio_extract?operation=diagnostic", { method: "POST", body: new Blob([]), signal: AbortSignal.timeout(TIMEOUT_MS) });
      return { status: response.status, body: await response.text().catch(() => "") };
    },
    browser: {
      directoryPicker: typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function",
      folderInput: "webkitdirectory" in document.createElement("input"),
      indexedDB: typeof indexedDB !== "undefined",
    },
    databases: async () => {
      const names = await existing();
      return Promise.all(DATABASES.map(async (name) => {
        if (!names.has(name)) return { name, ok: true, detail: "尚未创建（项目还没有这类数据）" };
        try {
          const db = await openExisting(name);
          try { const counts = await Promise.all([...db.objectStoreNames].map(async (store) => `${store} ${await countOf(db, store)}`)); return { name, ok: true, detail: `v${db.version} · ${counts.join(" · ")}` }; }
          finally { db.close(); }
        } catch (cause) { return { name, ok: false, detail: cause instanceof Error ? cause.message : String(cause) }; }
      }));
    },
  };
}
