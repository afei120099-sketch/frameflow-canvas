// Stage I: extracted from canvas-workspace.tsx without behaviour change.
import { categorize, configureErrorLog, ERROR_LOG_KEY, logEvent, type LogEntry } from "@/lib/error-log";
import { getMeta, putMeta, updateRun } from "@/lib/production-records";
import { showCanvasToast } from "./canvas-events";

// Phase 12: the error center / task log persists in the existing meta store.
configureErrorLog({ load: () => getMeta<LogEntry[]>(ERROR_LOG_KEY), save: (entries) => putMeta(ERROR_LOG_KEY, entries) });
export const TASK_LABELS: Record<string, string> = { "h3-node": "H3 生成", "upscale-node": "高清增强", "smooth-node": "流畅增强" };
export const taskLabel = (nodeType: string) => TASK_LABELS[nodeType] ?? "任务";
export function logTaskFailure(nodeType: string, nodeId: string, runId: string, message: string, shotId?: string) {
  void logEvent({ level: "error", category: categorize(message, runId ? "task" : "submit"), title: `${taskLabel(nodeType)}失败`, detail: message, nodeId, runId: runId || undefined, shotId });
}
export function logTaskUncertain(nodeType: string, nodeId: string, runId: string) {
  void logEvent({ level: "warning", category: "submit", title: `${taskLabel(nodeType)}：提交后与 ComfyUI 连接中断`, detail: "任务是否已被 ComfyUI 接收暂时无法确认；节点会自动重新确认，不会重复提交。", nodeId, runId: runId || undefined });
}
export function logTaskDone(nodeType: string, nodeId: string, runId: string, shotId?: string) {
  void logEvent({ level: "info", category: "task", title: `${taskLabel(nodeType)}完成`, detail: "结果已登记并显示在画布上。", nodeId, runId: runId || undefined, shotId });
}
/** Recovery retries every few seconds; log the first problem per Run only. */
export const loggedRecoveryRetries = new Set<string>();

export function recordRunUpdate(runId: string, changes: Parameters<typeof updateRun>[1]) {
  void updateRun(runId, changes).catch((cause) => showCanvasToast(cause instanceof Error ? `生成记录保存失败：${cause.message}` : "生成记录保存失败"));
}


