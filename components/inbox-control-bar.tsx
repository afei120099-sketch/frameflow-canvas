"use client";
// 收件箱开关：自动入队 开/关、急停、本页是不是执行页。
// The switches write the same `autoEnqueue` in 收件箱/_control.json and the same STOP file a person
// edits by hand — there is no second state. The page label only observes which canvas page
// picked up inbox work; it never changes who runs.
import { useEffect, useState, type CSSProperties } from "react";
import { readInboxRootSnapshot, subscribeInboxRootControl, switchInboxRootControl, type InboxRootControl } from "@/lib/inbox-root-control";
import { lastInboxSchedulerTick, startPresence, type ExecutorView } from "@/lib/inbox-executor-presence";
import { askConfirm } from "@/components/in-page-dialog";

/** Plain words for what the switches currently do. Exported for the test. */
export function inboxSwitchState(control: InboxRootControl) {
  const known = !control.error || control.stop;
  const auto = control.effective.autoEnqueue && control.effective.submit;
  const why = control.stop ? "急停中：收件箱里有 STOP 文件，一切新提交都暂停（已在 ComfyUI 里跑的不会被取消）"
    : control.error ? control.error
    : !control.submit ? "_control.json 里 submit 是关的：开了自动入队也不会提交 GPU"
    : control.autoEnqueue ? "放进收件箱的 _queue.json 会自动入队、提交 GPU"
    : "收件箱的新队列只做检查，不自动提交";
  return { known, auto, fileAutoEnqueue: control.autoEnqueue, stop: control.stop, canToggle: !control.error, why,
    pill: control.stop ? "急停中" : !known ? "总控未确认" : auto ? "自动入队 开" : "自动入队 关" };
}

const wrap: CSSProperties = { position: "fixed", left: 12, bottom: 12, zIndex: 350, fontSize: 12, color: "var(--ff-text,#ededed)", pointerEvents: "auto" };
const pillStyle: CSSProperties = { display: "flex", gap: 6, alignItems: "center", padding: "5px 10px", border: "1px solid var(--ff-border,#2e2e2e)", borderRadius: 999, background: "var(--ff-surface,#151515)", color: "inherit", cursor: "pointer", fontSize: 12 };
const card: CSSProperties = { width: 300, marginBottom: 8, padding: 12, border: "1px solid var(--ff-border-strong,#3a3a3a)", borderRadius: 10, background: "var(--ff-raised,#1b1b1b)", boxShadow: "0 8px 30px rgba(0,0,0,.5)", lineHeight: 1.6 };
const btn: CSSProperties = { padding: "5px 10px", border: "1px solid var(--ff-border-strong,#3a3a3a)", borderRadius: 7, background: "var(--ff-control,#232323)", color: "var(--ff-text,#ededed)", cursor: "pointer", fontSize: 12 };
const on: CSSProperties = { ...btn, background: "var(--ff-white,#f5f5f5)", color: "var(--ff-ink,#0c0c0c)", borderColor: "var(--ff-white,#f5f5f5)" };
const muted: CSSProperties = { color: "var(--ff-text-2,#a8a8a8)", margin: "4px 0 0" };

let sharedView: ExecutorView | null = null;
const viewListeners = new Set<(view: ExecutorView | null) => void>();
const embeddedCard: CSSProperties = { padding: 10, border: "1px solid var(--ff-border-soft,#242424)", borderRadius: 8, background: "var(--ff-raised,#1b1b1b)", lineHeight: 1.6, fontSize: 12, color: "var(--ff-text,#ededed)" };

/** embedded：卡片「JSON / 进度」抽屉里的同一套开关（同一个 _control.json / STOP），常开、不浮动。 */
export function InboxControlBar({ embedded = false }: { embedded?: boolean } = {}) {
  const [control, setControl] = useState<InboxRootControl>(readInboxRootSnapshot());
  const [view, setView] = useState<ExecutorView | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => subscribeInboxRootControl(setControl), []);
  // Only the floating bar heartbeats; the embedded copy reads its view (a second heartbeat would look like a second page).
  useEffect(() => {
    if (embedded) { setView(sharedView); viewListeners.add(setView); return () => { viewListeners.delete(setView); }; }
    return startPresence((next) => { sharedView = next; viewListeners.forEach((listener) => listener(next)); setView(next); }, lastInboxSchedulerTick);
  }, [embedded]);
  const state = inboxSwitchState(control);
  const send = async (patch: { autoEnqueue?: boolean; stop?: boolean }) => {
    if (busy) return;
    setBusy(true); setError("");
    try { setControl(await switchInboxRootControl(patch)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const setAuto = async (value: boolean) => {
    if (value === state.fileAutoEnqueue) return;
    if (value && !await askConfirm({ title: "打开自动入队？", message: "打开后，放进收件箱的 _queue.json 会自动入队、提交 GPU 渲染（_control.json 里 submit 也要是开的）。\n改的是收件箱 _control.json 里的 autoEnqueue，和手改文件一样。", confirmLabel: "打开自动入队" })) return;
    await send({ autoEnqueue: value });
  };
  const stopNow = () => void send({ stop: true }); // 急停 never asks: it must work in one click
  const release = async () => { if (await askConfirm({ title: "解除急停？", message: "会删掉收件箱里的 STOP 文件。之后按 _control.json 的开关继续：自动入队开着的话，等着的队列会开始提交 GPU。", confirmLabel: "解除急停" })) await send({ stop: false }); };
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const panel = <section style={embedded ? embeddedCard : card} role={embedded ? "group" : "dialog"} aria-label="收件箱开关">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><b>收件箱开关</b>{!embedded && <button type="button" style={btn} onClick={() => setOpen(false)}>收起</button>}</div>
      <p style={{ margin: "8px 0 0" }}><b>{view?.label ?? "正在确认执行页…"}</b></p>
      {view && <p style={muted}>{view.detail}</p>}
      <div style={{ marginTop: 10 }}>自动入队
        <span style={{ display: "inline-flex", gap: 4, marginLeft: 8 }}>
          <button type="button" style={state.fileAutoEnqueue ? on : btn} aria-pressed={state.fileAutoEnqueue} disabled={busy || !state.canToggle} onClick={() => void setAuto(true)}>开</button>
          <button type="button" style={!state.fileAutoEnqueue ? on : btn} aria-pressed={!state.fileAutoEnqueue} disabled={busy || !state.canToggle} onClick={() => void setAuto(false)}>关</button>
        </span>
      </div>
      <p style={muted}>{state.why}</p>
      <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
        {state.stop
          ? <button type="button" style={btn} disabled={busy} onClick={() => void release()}>解除急停</button>
          : <button type="button" style={{ ...btn, fontWeight: 700, borderColor: "var(--ff-text-2,#a8a8a8)" }} disabled={busy} onClick={stopNow}>急停</button>}
        <span style={{ color: "var(--ff-text-3,#858585)" }}>{state.stop ? "收件箱里有 STOP 文件" : "停住所有新提交，不取消已在跑的"}</span>
      </div>
      {error && <p role="alert" style={{ ...muted, color: "var(--ff-text,#ededed)" }}>没改成：{error}</p>}
      <p style={{ ...muted, color: "var(--ff-text-3,#858585)" }}>这两个开关改的就是收件箱里的 _control.json（autoEnqueue）和 STOP 文件，手改文件效果一样。</p>
    </section>;
  if (embedded) return <div data-inbox-control-bar="embedded">{panel}</div>;
  return <div style={wrap} data-inbox-control-bar="" onPointerDown={stop} onPointerUp={stop} onClick={stop} onWheel={stop} onKeyDown={stop}>
    {open && panel}
    <button type="button" style={pillStyle} aria-expanded={open} title={state.why} onClick={() => setOpen((value) => !value)}>
      <span>收件箱 · {state.pill}</span><span style={{ color: "var(--ff-text-3,#858585)" }}>·</span><span>{view ? (view.kind === "only" ? "本页是执行页" : `执行页不固定（${view.pages} 页）`) : "…"}</span>
    </button>
  </div>;
}
