"use client";
// Shared in-page confirm / notice. Use instead of window.confirm / alert: a native dialog pauses
// the whole page, inbox heartbeat included. Call askConfirm(...) and act only when it resolves true.
// The host mounts itself into document.body on first use, so no page has to render it.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { createDialogQueue, type DialogRequest, type OpenDialog } from "@/lib/in-page-dialog-queue";

const queue = createDialogQueue();
let mounted = false;
// Registered when this module loads, i.e. before any panel's own keydown listener, so while a
// dialog is open no key reaches the canvas or a panel (Escape would also close the panel,
// Delete/Backspace would delete shapes).
if (typeof window !== "undefined") window.addEventListener("keydown", (event) => {
  const open = queue.current();
  if (!open) return;
  event.stopImmediatePropagation();
  if (event.key === "Escape") { event.preventDefault(); open.answer(false); }
  else if (["Delete", "Backspace"].includes(event.key) || event.ctrlKey || event.metaKey) event.preventDefault();
}, true);
/** True while an in-page question is waiting for an answer. */
export const inPageDialogOpen = () => queue.current() !== null;
function ensureHost() {
  if (mounted || typeof document === "undefined") return;
  mounted = true;
  const node = document.createElement("div");
  node.dataset.frameflowDialogHost = "";
  document.body.appendChild(node);
  createRoot(node).render(<DialogHost />);
}

/** Ask inside the page. Resolves true only after 「确认」; Escape, 取消 or a second concurrent ask → false. */
export function askConfirm(request: DialogRequest | string): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);
  ensureHost();
  return queue.ask(typeof request === "string" ? { message: request } : request);
}
/** In-page replacement for alert(): one 「知道了」 button. */
export function showNotice(request: Omit<DialogRequest, "noticeOnly"> | string): Promise<void> {
  return askConfirm({ ...(typeof request === "string" ? { message: request } : request), noticeOnly: true }).then(() => undefined);
}

const backdrop: CSSProperties = { position: "fixed", inset: 0, zIndex: 100001, display: "grid", placeItems: "center", background: "rgba(0,0,0,.55)", pointerEvents: "auto" };
const panel: CSSProperties = { width: "min(520px,92vw)", maxHeight: "80vh", overflow: "auto", padding: 20, border: "1px solid var(--ff-border-strong,#3a3a3a)", borderRadius: 12, background: "var(--ff-raised,#1b1b1b)", color: "var(--ff-text,#ededed)", boxShadow: "0 16px 60px rgba(0,0,0,.6)", fontSize: 14, lineHeight: 1.7 };
const button: CSSProperties = { padding: "8px 14px", border: "1px solid var(--ff-border-strong,#3a3a3a)", borderRadius: 8, background: "var(--ff-control,#232323)", color: "var(--ff-text,#ededed)", cursor: "pointer", fontSize: 14 };
const primary: CSSProperties = { ...button, background: "var(--ff-white,#f5f5f5)", color: "var(--ff-ink,#0c0c0c)", borderColor: "var(--ff-white,#f5f5f5)" };

function DialogHost() {
  const [dialog, setDialog] = useState<OpenDialog | null>(queue.current());
  const ok = useRef<HTMLButtonElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => queue.subscribe(setDialog), []);
  useEffect(() => {
    if (!dialog) return;
    // Focus the safe answer: Enter on a question means 取消, never 确认.
    (dialog.noticeOnly ? ok.current : cancel.current)?.focus();
  }, [dialog]);
  if (!dialog) return null;
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return <div style={backdrop} onPointerDown={stop} onPointerUp={stop} onClick={stop} onWheel={stop}>
    <section role="alertdialog" aria-modal="true" aria-label={dialog.title ?? "请确认"} style={panel}>
      {dialog.title && <h2 style={{ margin: "0 0 10px", fontSize: 16 }}>{dialog.title}</h2>}
      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{dialog.message}</p>
      <footer style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 18 }}>
        {!dialog.noticeOnly && <button ref={cancel} type="button" style={button} onClick={() => dialog.answer(false)}>{dialog.cancelLabel ?? "取消"}</button>}
        <button ref={ok} type="button" style={dialog.danger ? { ...button, color: "var(--ff-bad,#dc8a7c)", borderColor: "var(--ff-bad,#dc8a7c)" } : primary} onClick={() => dialog.answer(true)}>{dialog.confirmLabel ?? (dialog.noticeOnly ? "知道了" : "确认")}</button>
      </footer>
    </section>
  </div>;
}
