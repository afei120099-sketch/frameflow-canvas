import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { PRODUCTION_SCHEMA, type Episode, type StageKind } from "../lib/production/types.ts";
import type { ProductionWorker } from "./production-worker.ts";

/**
 * /__production routes. Reads are plain GETs. Every write needs the X-Frameflow-Production header,
 * which a cross-site page cannot send without a CORS preflight this server never answers.
 */

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4", ".json": "application/json" };
const MAX_JSON = 2 * 1024 * 1024;
const MAX_MEDIA = 40 * 1024 * 1024;

async function body(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error("请求内容过大"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
function send(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

/** The editable part of an episode, in the import format (for the editor and for export). */
export function definitionOf(episode: Episode) {
  return { version: PRODUCTION_SCHEMA, title: episode.title, aspect: episode.aspect, roles: episode.roles, keyframe: episode.keyframe, video: episode.video, shots: episode.shots };
}

export const EPISODE_TEMPLATE = {
  version: PRODUCTION_SCHEMA,
  title: "示例剧 第1集",
  aspect: "9:16",
  roles: [
    { key: "zhangsan", name: "张三", description: "成年男性，短黑发，浅色衬衫", face: "zhangsan_face.png", appearance: ["zhangsan_full.png"], voice: "zhangsan_voice.wav" },
    { key: "lisi", name: "李四", description: "成年女性，白衬衫配西装外套", face: "lisi_face.png", appearance: ["lisi_full.png"], voice: "lisi_voice.wav" },
  ],
  keyframe: { look: "photorealistic modern office drama, soft window light, muted film colors", depthStrength: 1, candidates: 3, autoApproveAbove: null },
  video: { workflow: "ultimate", tuning: "understanding", soundMode: "av", megapixels: 0.5, candidates: 1 },
  shots: [
    { shotId: "S01", title: "张三看文件", storyboard: "S01.png", faceRole: "zhangsan", keyframePrompt: "a mature East Asian man in a light shirt reading a document at his desk", videoPrompt: "<Picture 1> is the first frame. He slowly lowers the document and looks up toward the door.", roles: ["zhangsan"], seconds: 6 },
    { shotId: "S02", title: "李四推门", faceRole: "lisi", keyframePrompt: "medium shot, eye-level camera, a young East Asian woman in a white shirt and blazer stands in the center of an office glass door facing camera", videoPrompt: "<Picture 1> is the first frame. She pushes the glass door open, stops in the doorway and speaks politely.", roles: ["lisi"], dialogue: [{ roleId: "lisi", text: "张总，您找我？" }], seconds: 5 },
  ],
};

function canvasNameOf(request: IncomingMessage) {
  const raw = request.headers["x-frameflow-canvas-name"];
  try { return typeof raw === "string" ? decodeURIComponent(raw).slice(0, 40) : ""; } catch { return ""; }
}

export function createProductionHandler(worker: ProductionWorker, page: () => Promise<string>) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // Which canvas is asking: split instances forward with this header; the default canvas sends none.
    const rawCanvas = request.headers["x-frameflow-canvas"];
    const canvas = typeof rawCanvas === "string" && /^[a-z0-9-]{1,40}$/i.test(rawCanvas) ? rawCanvas : "";
    try {
      if (request.method === "GET" && (parts.length === 0 || parts[0] === "ui")) {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(await page());
        return;
      }
      if (request.method === "GET" && parts[0] === "media" && parts.length >= 3) {
        const path = await worker.mediaPath(parts[1], parts.slice(2).join("/"));
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) { send(response, 404, { error: "文件不存在" }); return; }
        const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
        response.setHeader("Content-Type", type);
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Cache-Control", "private, max-age=60");
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
        if (range && (range[1] || range[2])) {
          const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
          const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
          if (start > end || start >= info.size) { response.statusCode = 416; response.setHeader("Content-Range", `bytes */${info.size}`); response.end(); return; }
          response.statusCode = 206;
          response.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
          response.setHeader("Content-Length", String(end - start + 1));
          createReadStream(path, { start, end }).pipe(response);
          return;
        }
        response.setHeader("Content-Length", String(info.size));
        createReadStream(path).pipe(response);
        return;
      }
      if (parts[0] !== "api") { send(response, 404, { error: "没有这个地址" }); return; }
      if (request.method === "GET") {
        if (parts[1] === "overview") { send(response, 200, { ...worker.overview(canvas), canvas, canvasName: canvas ? canvasNameOf(request) || canvas : "主画布" }); return; }
        if (parts[1] === "template") { send(response, 200, EPISODE_TEMPLATE); return; }
        if (parts[1] === "episodes" && parts[2] && parts.length === 3) { const result = await worker.get(parts[2]); send(response, 200, { ...result, definition: definitionOf(result.episode) }); return; }
        send(response, 404, { error: "没有这个地址" }); return;
      }
      if (request.headers["x-frameflow-production"] !== "1") { send(response, 403, { error: "缺少生产线请求头，已拒绝" }); return; }
      if (request.method === "PUT" && parts[1] === "episodes" && parts[3] === "media" && parts[4]) {
        send(response, 200, await worker.uploadMedia(parts[2], parts[4], new Uint8Array(await body(request, MAX_MEDIA)))); return;
      }
      const json = async () => { const raw = (await body(request, MAX_JSON)).toString("utf8"); return raw ? JSON.parse(raw) as Record<string, unknown> : {}; };
      if (request.method === "POST" && parts[1] === "episodes" && parts.length === 2) {
        const raw = (await body(request, MAX_JSON)).toString("utf8");
        const episode = await worker.createEpisode(raw, canvas);
        send(response, 200, { episodeId: episode.episodeId }); return;
      }
      if (request.method === "PUT" && parts[1] === "episodes" && parts[3] === "definition") {
        const episode = await worker.updateDefinition(parts[2], (await body(request, MAX_JSON)).toString("utf8"));
        send(response, 200, { episodeId: episode.episodeId }); return;
      }
      if (request.method === "POST" && parts[1] === "episodes" && parts[2]) {
        const id = parts[2]; const input = await json();
        const shotIds = Array.isArray(input.shotIds) ? input.shotIds.map(String) : undefined;
        const count = typeof input.count === "number" ? input.count : undefined;
        switch (parts[3]) {
          case "enqueue": {
            if (input.stage !== "keyframe" && input.stage !== "video") throw new Error("stage 只能是 keyframe 或 video");
            send(response, 200, await worker.enqueue(id, input.stage as StageKind, { ...(shotIds ? { shotIds } : {}), ...(count ? { count } : {}) })); return;
          }
          case "decide": {
            if (!["approved", "rejected", "candidate"].includes(String(input.decision))) throw new Error("decision 不对");
            send(response, 200, await worker.decide(id, String(input.versionId), input.decision as "approved", typeof input.note === "string" ? input.note : "")); return;
          }
          case "pause": send(response, 200, await worker.setPaused(id, Boolean(input.paused))); return;
          case "cancel": send(response, 200, await worker.cancelPending(id, typeof input.shotId === "string" ? input.shotId : undefined)); return;
          case "retry": send(response, 200, await worker.retryTask(id, String(input.taskId))); return;
          case "abandon": send(response, 200, await worker.abandonTask(id, String(input.taskId))); return;
          case "rescore": send(response, 200, await worker.rescore(id, String(input.versionId))); return;
          case "assemble": send(response, 200, await worker.assemble(id, { partial: input.partial === true })); return;
          case "delete": send(response, 200, await worker.deleteEpisode(id)); return;
          case "delete-shot": send(response, 200, await worker.deleteShot(id, String(input.shotId ?? ""))); return;
        }
      }
      send(response, 404, { error: "没有这个地址" });
    } catch (cause) {
      const status = (cause as { status?: number }).status ?? 400;
      send(response, status, { error: cause instanceof Error ? cause.message : String(cause) });
    }
  };
}

export async function readPage(path: string) { return readFile(path, "utf8"); }
