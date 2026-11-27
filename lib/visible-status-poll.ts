/** Status-only polling, not the shared Run clock, Telegram bridge or GPU task recovery. */
export function startVisibleStatusPoll(task: () => Promise<boolean>, options: {
  document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  delays: readonly number[];
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clear?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const schedule = options.schedule ?? setTimeout, clear = options.clear ?? clearTimeout;
  let live = true, pending = false, failures = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { if (timer !== undefined) clear(timer); timer = undefined; };
  const refresh = async () => {
    if (!live || pending || options.document.hidden) return;
    clearTimer(); pending = true;
    try { failures = await task() ? 0 : failures + 1; }
    catch { failures++; }
    finally {
      pending = false;
      if (live && !options.document.hidden) timer = schedule(() => { void refresh(); }, options.delays[Math.min(failures, options.delays.length - 1)]);
    }
  };
  const wake = () => { clearTimer(); if (!options.document.hidden) void refresh(); };
  options.document.addEventListener("visibilitychange", wake);
  options.window.addEventListener("focus", wake);
  void refresh();
  return { refresh: () => { void refresh(); }, stop: () => { live = false; clearTimer(); options.document.removeEventListener("visibilitychange", wake); options.window.removeEventListener("focus", wake); } };
}
