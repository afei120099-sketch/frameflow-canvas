/** Reconnect a local optional integration. Never runs business actions or retries commands. */
export function connectionWatchdog(options: {
  ready: () => boolean;
  connect: (signal: AbortSignal) => Promise<(() => void) | null>;
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
  delayMs?: number;
}) {
  const schedule = options.schedule ?? setTimeout;
  const unschedule = options.unschedule ?? clearTimeout;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let dispose: (() => void) | null = null;
  const check = async () => {
    if (controller.signal.aborted || inFlight) return;
    if (timer !== undefined) { unschedule(timer); timer = undefined; }
    inFlight = true;
    try {
      if (!options.ready()) {
        dispose?.(); dispose = null;
        const next = await options.connect(controller.signal);
        if (controller.signal.aborted) next?.();
        else dispose = next;
      }
    } catch { /* Optional bridge failure must not disrupt the canvas. */ }
    finally {
      inFlight = false;
      if (!controller.signal.aborted) timer = schedule(() => { void check(); }, options.delayMs ?? 4000);
    }
  };
  void check();
  return {
    check,
    stop: () => {
      controller.abort();
      if (timer !== undefined) unschedule(timer);
      dispose?.(); dispose = null;
    },
  };
}
