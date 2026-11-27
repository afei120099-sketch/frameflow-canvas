/**
 * 「停止后续排队」的纯逻辑：卡片锁不锁、等待点能不能被停止打断、停完给用户的那句话。
 *
 * 2026-11-12 根因：卡片锁 = 「提交循环在跑」或「有镜头行是 排队/生成/状态待确认」。状态待确认（unconfirmed）
 * 是落盘的记录，不会自己消失，也不是 ComfyUI 里真的有任务——循环早退出了，卡片还一直显示「排队中 1/28」，
 * 点停止也解不开。现在：只有提交循环真的在跑，或者本批没被停止且 ComfyUI 里真有排队/生成的镜头，才锁。
 */
export type QueueRowStatus = "pending" | "submitting" | "queued" | "running" | "completed" | "failed" | "stopped" | "unconfirmed";

export function queueLockState(rows: Record<string, { status: string } | undefined>, loopRunning: boolean, stopped: boolean) {
  const list = Object.values(rows);
  const live = list.filter((row) => row?.status === "queued" || row?.status === "running").length;
  const unconfirmed = list.filter((row) => row?.status === "unconfirmed").length;
  // 停止过的批次：ComfyUI 里剩下的（正在跑的那一镜）照常跑完，但卡片不再锁着等它。
  const locked = loopRunning || (live > 0 && !stopped);
  return { locked, live, unconfirmed, loopRunning };
}

/** 让一个可能永远不返回的等待在用户停止时立刻放手。原来的 promise 照常结束，它的报错被吞掉（不会变成未处理的拒绝）。 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("已停止", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("已停止", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

/** 每 step 毫秒看一次 done()，最多等 ms 毫秒。返回是否等到了。 */
export async function waitUntil(done: () => boolean, ms: number, step = 100, sleep = (t: number) => new Promise<void>((resolve) => setTimeout(resolve, t))) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await sleep(step);
  }
  return true;
}

export type StopShotState = "completed" | "running" | "queued" | "cancelled" | "unconfirmed" | "failed" | "pending" | "removed";
export const STOP_EXIT_MS = 6000;
export const FORCE_UNLOCK_NOTE = "强制解锁：卡在后台的那次提交直接作废，它之后每一步都会先检查停止，不会再往 ComfyUI 提交新镜头；已经在 ComfyUI 里的任务不动（正在跑的会跑完）。如果它正卡在写本地记录，那一镜可能显示「状态待确认」——别直接重提，先核实。再入队前建议刷新一次页面。";

/** 停完告诉用户：停了几镜、有没有镜头已经进了 ComfyUI、卡片解没解锁。 */
export function describeStop(input: { states: StopShotState[]; cancelledNow: number; exited: boolean; wasRunning: boolean; notes?: string[] }) {
  const count = (state: StopShotState) => input.states.filter((item) => item === state).length;
  const total = input.states.filter((state) => state !== "removed").length;
  const running = count("running"), queued = count("queued"), unconfirmed = count("unconfirmed"), pending = count("pending");
  const parts = [
    `已出片 ${count("completed")}`,
    `正在 ComfyUI 生成 ${running}${running ? "（保留，会跑完）" : ""}`,
    queued ? `还在 ComfyUI 排队 ${queued}（没撤下来，会照常生成）` : "",
    `这次从 ComfyUI 排队里撤下 ${input.cancelledNow}`,
    unconfirmed ? `状态待确认 ${unconfirmed}（不会自动重提，先核实）` : "",
    count("failed") ? `失败 ${count("failed")}` : "",
    `没提交、不会再提交 ${pending}`,
  ].filter(Boolean);
  if (total === 0) return `已停止：这一批还没建节点，没有任何镜头提交到 ComfyUI。${input.exited ? "卡片已解锁，可以改。" : `提交循环 ${STOP_EXIT_MS / 1000} 秒内没退出，卡片还锁着：可以点「强制解锁」。`}${input.notes?.length ? input.notes.join("；") + "。" : ""}`;
  const head = input.wasRunning ? "已停止后续排队。" : "提交循环本来就没在跑（之前已经停了或结束了），已把本批标成停止。";
  const inComfy = running + queued > 0 ? `ComfyUI 里还有本批 ${running + queued} 镜，不会被取消。` : "ComfyUI 里已经没有本批的任务。";
  const tail = input.exited ? "卡片已解锁，可以改。" : `提交循环 ${STOP_EXIT_MS / 1000} 秒内没退出，卡片还锁着：可以点「强制解锁」。`;
  return `${head}本批 ${total} 镜：${parts.join("；")}。${inComfy}${tail}${input.notes?.length ? input.notes.join("；") + "。" : ""}`;
}
