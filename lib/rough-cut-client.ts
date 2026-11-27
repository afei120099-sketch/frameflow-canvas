import type { RoughCutSnapshot } from "./rough-cut.ts";

/** Browser client for the local rough-cut jobs served by the dev server (scripts/rough-cut-vite-plugin.ts). */

export interface RoughCutJobError { code: string; message: string; clip: number | null; stage: string | null; detail?: string | null; filename?: string | null; logPath?: string }
export interface RoughCutJobStatus { id: string; state: "uploading" | "ready" | "running" | "done" | "failed" | "cancelled"; stage: { stage: "upload" | "probe" | "clip" | "finalize"; index?: number; total?: number; title?: string } | null; error: RoughCutJobError | null; result: Record<string, unknown> | null; scriptVersion: string }
export interface RoughCutPlan { output: { fps: string; fpsValue: number; fpsReason: string; width: number; height: number; sizePolicy: string; frames: number; duration: number; clipFrames: number[]; reencode: boolean; unify: { clip: number; reasons: string[] }[] }; warnings: string[]; clips: { index: number; fps: number; width: number; height: number; duration: number; hasAudio: boolean; videoCodec: string; audioCodec: string | null; inPoint: number; outPoint: number }[] }

export class RoughCutJobFailure extends Error {
  readonly info: RoughCutJobError;
  constructor(info: RoughCutJobError) { super(info.message); this.name = "RoughCutJobFailure"; this.info = info; }
}

const BASE = "/__rough_cut/jobs";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`${BASE}${path}`, init); }
  catch { throw new RoughCutJobFailure({ code: "SERVER_UNAVAILABLE", message: "本地粗剪服务无法连接（请用 pnpm dev 启动画布）", clip: null, stage: null }); }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as RoughCutJobError | null;
    throw new RoughCutJobFailure(payload?.message ? payload : { code: `HTTP_${response.status}`, message: `本地粗剪服务错误（HTTP ${response.status}）`, clip: null, stage: null });
  }
  return response.headers.get("Content-Type")?.includes("application/json") ? response.json() as Promise<T> : undefined as T;
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const createRoughCutJob = (snapshot: RoughCutSnapshot) => call<{ id: string; sources: string[]; scriptVersion: string }>("", json({ clips: snapshot.clips.map((clip) => ({ key: clip.sourceKey, inPoint: clip.inPoint, outPoint: clip.outPoint, transition:clip.transition, title: clip.title, filename: clip.filename })) }));
/** Reuse the same streaming assembly service for segmented enhancement. */
export interface MediaAssemblyClip { key: string; inPoint: number; outPoint: number; title: string; filename: string; audioSourceKey?: string; audioInPoint?: number }
export const createMediaAssemblyJob = (clips: MediaAssemblyClip[]) => call<{id:string;sources:string[];scriptVersion:string}>('',json({clips}));
export const uploadRoughCutSource = (id: string, key: string, blob: Blob, signal?: AbortSignal) => call<{ received: number }>(`/${encodeURIComponent(id)}/sources/${encodeURIComponent(key)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: blob, signal });
export const planRoughCutJob = (id: string, sizePolicy: string) => call<RoughCutPlan>(`/${encodeURIComponent(id)}/plan`, json({ sizePolicy }));
export const startRoughCutJob = (id: string, sizePolicy: string) => call<RoughCutJobStatus>(`/${encodeURIComponent(id)}/start`, json({ sizePolicy }));
export const roughCutJobStatus = (id: string) => call<RoughCutJobStatus>(`/${encodeURIComponent(id)}`, { cache: "no-store" });
export const cancelRoughCutJob = (id: string) => call<void>(`/${encodeURIComponent(id)}/cancel`, { method: "POST" }).catch(() => undefined);
export const disposeRoughCutJob = (id: string) => call<void>(`/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);

export async function roughCutJobResult(id: string) {
  const response = await fetch(`${BASE}/${encodeURIComponent(id)}/result`, { cache: "no-store" });
  if (!response.ok) throw new RoughCutJobFailure({ code: "RESULT_UNAVAILABLE", message: "无法取回粗剪结果文件", clip: null, stage: "finalize" });
  const blob = await response.blob();
  return blob.slice(0, blob.size, "video/mp4");
}
