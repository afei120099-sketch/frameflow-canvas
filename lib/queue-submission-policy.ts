import { ComfyConnectionError, SubmissionNotSentError } from "./ai-adapter.ts";
import { connectionRefused } from "./comfyui/h3-adapter.ts";

/** Only the two proven-not-sent classes may advance to the next shot. */
export function classifyQueueSubmissionError(cause: unknown, aborted = false): "aborted" | "not_sent" | "uncertain" {
  if (aborted || (cause instanceof Error && cause.name === "AbortError")) return "aborted";
  if (cause instanceof SubmissionNotSentError || (cause instanceof ComfyConnectionError && connectionRefused(cause.cause))) return "not_sent";
  return "uncertain";
}

export class QueuePersistenceError extends Error {
  constructor(cause: unknown) {
    const base = "本地队列保存失败，已暂停。请检查浏览器存储空间；不要重复提交状态不明的任务。";
    super(cause instanceof Error && cause.name === "SessionConflict" ? `${base}（原因：${cause.message}）` : base, { cause }); this.name = "QueuePersistenceError"; }
}
