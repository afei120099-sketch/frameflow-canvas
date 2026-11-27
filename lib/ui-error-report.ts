import { logEvent } from "./error-log";

export function errorDetails(error: unknown, componentStack = "") {
  let message = "未知错误";
  try { message = error instanceof Error ? error.message : String(error); } catch { /* hostile thrown values */ }
  let stack = componentStack.trim().split("\n").slice(0, 3).join("\n");
  if (!stack) {
    try { if (error instanceof Error && typeof error.stack === "string") stack = "异常位置（未提供组件栈）：\n" + error.stack.split("\n").slice(1, 4).join("\n"); } catch { /* Error getters must not break fallback UI. */ }
  }
  return [message, stack].filter(Boolean).join("\n");
}

/** Logging must not itself produce an unhandled rejection (especially in ErrorCenter). */
export function reportUiError(title: string, error: unknown, stack = "") {
  void logEvent({ level: "error", category: "ui", title, detail: errorDetails(error, stack) }).catch(() => {});
}

export function saveStateExplanation(label: string) {
  if (label === "画布已保存") return "画布内容已核实写入本机浏览器存储，可重新加载页面。";
  if (label === "保存核实失败，请导出备份") return "无法确认最近的改动是否已保存。重新加载可能丢失最后一次改动。如顶部备份仍可用，请先导出；画布故障时备份也可能不可用。";
  return "最近改动可能尚未保存，请先等待核实。重新加载可能丢失最后一次改动。";
}

const resizeNotice = /^(?:Uncaught\s+(?:Error:\s*)?)?ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)\.?$/;

/** Observation only: never suppress real errors, reload, cancel or submit jobs. */
export function installUiErrorReporting(target: Window, toast: (message: string) => void) {
  let last = "", lastAt = 0;
  const report = (title: string, error: unknown) => {
    const detail = errorDetails(error);
    if (resizeNotice.test(detail.split("\n")[0].trim())) return;
    const signature = `${title}:${detail.split("\n")[0]}`, now = Date.now();
    if (signature === last && now - lastAt < 5000) return;
    last = signature; lastAt = now;
    reportUiError(title, error);
    toast("界面发生错误，详情已记录到错误中心。请核实任务状态，不要重复提交。");
  };
  const onError = (event: ErrorEvent) => report("界面脚本错误", event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => report("未处理的异步错误", event.reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => { target.removeEventListener("error", onError); target.removeEventListener("unhandledrejection", onRejection); };
}
