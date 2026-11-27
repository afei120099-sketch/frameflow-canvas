import type { AutopilotJob, AutopilotJobSummary } from "./autopilot.ts";
import type { DirectorConstraints, M2PresetId, PlanCheck, SubjectAnchor } from "./autopilot-director.ts";
import type { DirectorPackageRequest, ExternalProviderLabel } from "./autopilot-package.ts";

/** Browser side of Autopilot M1: it only asks the local worker; nothing here runs or keeps a job alive. */

export interface AutopilotOverview {
  owner: boolean;
  pid: number;
  ownerPid: number | null;
  damaged: { file: string; error: string }[];
  active: AutopilotJob | null;
  latest: AutopilotJob | null;
  jobs: AutopilotJobSummary[];
}

export class AutopilotRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: { errors?: string[]; checks?: PlanCheck[] | null } | null;
  constructor(message: string, code: string, status: number, details: AutopilotRequestError["details"] = null) { super(message); this.name = "AutopilotRequestError"; this.code = code; this.status = status; this.details = details; }
}

const BASE = "/__autopilot";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(`${BASE}${path}`, { cache: "no-store", ...init }); }
  catch { throw new AutopilotRequestError("无法连接本地开发服务器（夜班服务运行在其中）", "SERVER_OFFLINE", 0); }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: string; message?: string; details?: AutopilotRequestError["details"] } | null;
    if (response.status === 404 && !body?.code) throw new AutopilotRequestError("夜班服务只在本地开发服务器（pnpm dev / 桌面启动器）中可用", "UNAVAILABLE", 404);
    throw new AutopilotRequestError(body?.message ?? `夜班服务请求失败（HTTP ${response.status}）`, body?.code ?? "REQUEST_FAILED", response.status, body?.details ?? null);
  }
  return response.json() as Promise<T>;
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const getAutopilotOverview = () => call<AutopilotOverview>("/jobs");
export const startAutopilotJob = () => post<AutopilotJob>("/jobs");
export const getAutopilotJob = (jobId: string) => call<AutopilotJob>(`/jobs/${encodeURIComponent(jobId)}`);
export const cancelAutopilotJob = (jobId: string) => post<AutopilotJob>(`/jobs/${encodeURIComponent(jobId)}/cancel`);
export const resumeAutopilotJob = (jobId: string, resubmit = false) => post<AutopilotJob>(`/jobs/${encodeURIComponent(jobId)}/resume`, { resubmit });
export const revealAutopilotOutput = (jobId: string) => post<{ path: string }>(`/jobs/${encodeURIComponent(jobId)}/reveal`);
export const autopilotOutputUrl = (jobId: string, download = false) => `${BASE}/jobs/${encodeURIComponent(jobId)}/output${download ? "?download=1" : ""}`;

// ——— M2 ———
export interface DirectorProviderInfo { id: string; label: string; kind: "mock" | "local" | "cloud"; usesLocalGpu: boolean; available: boolean; reason: string | null }
export const getDirectorProviders = () => call<{ defaultDirector: string; providers: DirectorProviderInfo[] }>("/directors");
export const startDirectorDraft = (input: { intent: string; targetSeconds: number; aspect: string; director?: string; preset?: M2PresetId; approvedFacts?: string[]; forbiddenClaims?: string[]; constraints?: Partial<DirectorConstraints>; subjectAnchor?: SubjectAnchor | null }) => post<AutopilotJob>("/jobs", { kind: "m2", ...input });
export const getDirectorTask = (request: DirectorPackageRequest) => post<{ text: string; runtimeSkill: { version: string; hash: string }; request: DirectorPackageRequest }>("/director-task", { request });
export const importDirectorPlan = (input: { packageText: string; providerLabel: ExternalProviderLabel; expected: DirectorPackageRequest | null }) => post<AutopilotJob>("/jobs", { kind: "m2-import", ...input });
export const confirmDirectorDraft = (jobId: string) => post<AutopilotJob>(`/jobs/${encodeURIComponent(jobId)}/start`);
