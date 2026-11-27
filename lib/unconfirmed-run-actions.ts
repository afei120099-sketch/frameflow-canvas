import type { RunRecord } from "./production-records.ts";
import type { ComfyJobProbe } from "./comfyui/h3-adapter.ts";
import { isActiveRun, LOST_RUN_REASON, saveNodeForRun } from "./run-recovery.ts";
import { FILM_SAVE_NODE_ID } from "./comfyui/film-workflow.ts";

/**
 * Error center actions for a 「任务状态待确认」 Run. Read-only toward ComfyUI: they only look at /queue and /history.
 * They never submit and never cancel a ComfyUI job; the only write is the local Run record (→ failed) and the log entry.
 */
export const UNCONFIRMED_RUN_TITLE = "任务状态待确认";
export const unconfirmedOnceKey = (runId: string) => `unconfirmed:${runId}`;

export interface UnconfirmedRunDeps {
  getRun(runId: string): Promise<RunRecord | null>;
  updateRun(runId: string, changes: Partial<Pick<RunRecord, "status" | "completedAt" | "error">>): Promise<unknown>;
  isAvailable(): Promise<boolean>;
  probeJob(jobId: string, saveNodeId: string): Promise<ComfyJobProbe>;
  /** Segmented enhancement Runs keep their current ComfyUI job id in a checkpoint. */
  activeEnhancementPrompt?(runId: string): Promise<string | null>;
  resolveRunEntries(runId: string, resolution: string): Promise<unknown>;
  now?: () => number;
}

export type RecheckResult =
  | { kind: "settled"; message: string }      // the Run already has a final state; log entry resolved
  | { kind: "active"; message: string }       // ComfyUI still has it queued/running; the node keeps following it
  | { kind: "completed"; message: string }    // ComfyUI has the result; the node fetches it on its next check
  | { kind: "failed"; message: string }       // ComfyUI says it failed; Run settled as failed
  | { kind: "lost"; message: string }         // ComfyUI online, job nowhere; user may abandon
  | { kind: "offline"; message: string }
  | { kind: "no_job_id"; message: string };

async function jobOf(run: RunRecord, deps: UnconfirmedRunDeps) {
  if (run.parameters?.enhancementPipeline === true) {
    const id = await deps.activeEnhancementPrompt?.(run.runId) ?? null;
    return id ? { id, saveNode: run.capabilityId === "film_interpolation" ? FILM_SAVE_NODE_ID : "76" } : null;
  }
  return run.comfyPromptId ? { id: run.comfyPromptId, saveNode: saveNodeForRun(run) } : null;
}

async function probe(run: RunRecord, deps: UnconfirmedRunDeps): Promise<ComfyJobProbe | "offline" | "no_job_id"> {
  const job = await jobOf(run, deps);
  if (!job) return "no_job_id";
  try { if (!(await deps.isAvailable())) return "offline"; return await deps.probeJob(job.id, job.saveNode); }
  catch { return "offline"; }
}

const settledText = (run: RunRecord) => run.status === "completed" ? "任务已完成" : run.status === "cancelled" ? "任务已取消" : `任务已结束：${run.error ?? "失败"}`;

/** 「重新查询一次」: one read of ComfyUI. Settles the Run only when ComfyUI itself reports a failure. */
export async function recheckUnconfirmedRun(runId: string, deps: UnconfirmedRunDeps): Promise<RecheckResult> {
  const run = await deps.getRun(runId);
  if (!run) { await deps.resolveRunEntries(runId, "生成记录已不存在"); return { kind: "settled", message: "这条生成记录已经不存在了，警告已标为已处理。" }; }
  if (!isActiveRun(run)) { await deps.resolveRunEntries(runId, settledText(run)); return { kind: "settled", message: `${settledText(run)}，警告已标为已处理。` }; }
  const state = await probe(run, deps);
  if (state === "offline") return { kind: "offline", message: "现在连不上 ComfyUI，查不到。请确认 ComfyUI 已启动后再查一次。" };
  if (state === "no_job_id") return { kind: "no_job_id", message: "这个任务当初没有记下 ComfyUI 任务编号，没法查询。如果你确定它早就不在渲染了，可以「标记为已放弃」。" };
  if (state.state === "queued" || state.state === "running") return { kind: "active", message: `ComfyUI 里这个任务还在${state.state === "queued" ? "排队" : "生成"}，节点会继续跟着它，不用处理。` };
  if (state.state === "completed") return { kind: "completed", message: "ComfyUI 里这个任务已经做完了，节点几秒内会自动取回结果（不会重新渲染）。" };
  if (state.state === "failed") {
    const error = `ComfyUI 报告任务失败：${state.error || "未知原因"}（未重新提交）`;
    await deps.updateRun(runId, { status: "failed", completedAt: (deps.now ?? Date.now)(), error });
    await deps.resolveRunEntries(runId, error);
    return { kind: "failed", message: `${error}。已把它记为失败，警告已标为已处理。` };
  }
  return { kind: "lost", message: "ComfyUI 在线，但队列和历史里都找不到这个任务（ComfyUI 多半重启过）。它不会再出结果了，可以点「标记为已放弃」。" };
}

export type AbandonResult = { abandoned: boolean; message: string };

/** 「标记为已放弃」: refuses while ComfyUI still has the job (never cancels it); otherwise settles the local Run as failed. */
export async function abandonUnconfirmedRun(runId: string, deps: UnconfirmedRunDeps): Promise<AbandonResult> {
  const run = await deps.getRun(runId);
  if (!run) { await deps.resolveRunEntries(runId, "生成记录已不存在"); return { abandoned: false, message: "这条生成记录已经不存在了，警告已标为已处理。" }; }
  if (!isActiveRun(run)) { await deps.resolveRunEntries(runId, settledText(run)); return { abandoned: false, message: `${settledText(run)}，不需要放弃。警告已标为已处理。` }; }
  const state = await probe(run, deps);
  if (state !== "offline" && state !== "no_job_id") {
    if (state.state === "queued" || state.state === "running") return { abandoned: false, message: "ComfyUI 里这个任务其实还在跑，没有放弃，也没有取消它。等它跑完节点会自动取回。" };
    if (state.state === "completed") return { abandoned: false, message: "ComfyUI 里这个任务已经做完了，没有放弃；节点几秒内会自动取回结果。" };
  }
  const reason = state === "offline" ? "当时连不上 ComfyUI" : state === "no_job_id" ? "没有记录 ComfyUI 任务编号" : state.state === "failed" ? `ComfyUI 报告失败：${state.error || "未知原因"}` : LOST_RUN_REASON;
  const error = `用户在错误中心标记为已放弃（未重新提交，未取消 ComfyUI 任务）：${reason}`;
  await deps.updateRun(runId, { status: "failed", completedAt: (deps.now ?? Date.now)(), error });
  await deps.resolveRunEntries(runId, "已标记为放弃（未重新提交）");
  return { abandoned: true, message: "已标记为放弃。没有重新提交，也没有取消 ComfyUI 里的任何任务；需要的话可以在节点上手动重新生成。" };
}
