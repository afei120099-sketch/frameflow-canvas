/**
 * In-page replacement for window.confirm / alert. A native dialog freezes the whole page
 * (inbox heartbeat, queue polling, render progress). This keeps the page running and asks
 * inside it instead.
 *
 * Rules kept from window.confirm:
 * - the caller acts only after an explicit 「确认」; closing, Escape or a crash answers false;
 * - one question at a time. A second ask while one is open answers false at once, so a
 *   double click can never open two dialogs and run the action twice.
 */
export type DialogRequest = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Only an OK button (alert). */
  noticeOnly?: boolean;
  danger?: boolean;
};
export type OpenDialog = DialogRequest & { id: number; answer: (ok: boolean) => void };

export function createDialogQueue() {
  let open: OpenDialog | null = null, seq = 0;
  const listeners = new Set<(dialog: OpenDialog | null) => void>();
  const emit = () => { for (const listener of listeners) listener(open); };
  return {
    ask(request: DialogRequest): Promise<boolean> {
      if (open) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const id = ++seq;
        open = { ...request, id, answer: (ok) => { if (open?.id !== id) return; open = null; emit(); resolve(ok); } };
        emit();
      });
    },
    current: () => open,
    subscribe(listener: (dialog: OpenDialog | null) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Unmount / page teardown: anything still waiting is answered 「取消」. */
    cancelAll() { open?.answer(false); },
  };
}
