"use client";

import { Component, createContext, useContext, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { copyPlainText } from "@/lib/copy-plain-text";
import { errorDetails, reportUiError, saveStateExplanation } from "@/lib/ui-error-report";

export const CanvasSaveStatusContext = createContext("自动保存已开启");

function ErrorSummary({ error, stack = "" }: { error: unknown; stack?: string }) {
  const [copied, setCopied] = useState(false);
  return <><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>{errorDetails(error, stack)}</pre><button type="button" onClick={() => { void copyPlainText(errorDetails(error, stack)).then(setCopied).catch(() => setCopied(false)); }}>{copied ? "已复制" : "复制错误详情"}</button></>;
}

/** No editor/GPU dependency. Retrying resets presentation only, at most three times. */
export class CanvasPanelBoundary extends Component<{ name: string; onClose: () => void; children: ReactNode }, { error: unknown; stack: string; attempts: number; failed: boolean }> {
  state = { error: null as unknown, stack: "", attempts: 0, failed: false };
  static getDerivedStateFromError(error: unknown) { return { error, failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportUiError(`${this.props.name}面板显示失败`, error, info.componentStack ?? "");
    this.setState({ stack: info.componentStack ?? "" });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <aside className="asset-library-drawer ff-panel" role="alert" aria-label={`${this.props.name}面板错误`} style={{ padding: 24, overflow: "auto" }} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <h2>{this.props.name}面板出错了</h2><p>画布和已提交的任务不受此显示错误影响。重试不会重新提交生成任务。</p>
      <ErrorSummary error={this.state.error} stack={this.state.stack} />
      <button type="button" disabled={this.state.attempts >= 3} onClick={() => this.setState(state => ({ failed: false, error: null, stack: "", attempts: state.attempts + 1 }))}>重试显示（{this.state.attempts}/3）</button>
      <button type="button" onClick={this.props.onClose}>关闭面板</button>
      {this.state.attempts >= 3 && <p>重试次数已用完，请先保存或备份，再考虑重新加载页面。</p>}
    </aside>;
  }
}

/** Stable child identity. Render callbacks run below the boundary, not in its execution owner. */
export function GuardedPanelRender({ render }: { render: () => ReactNode }) { return render(); }

export function CanvasShapeErrorFallback({ error }: { error: unknown }) {
  useEffect(() => { reportUiError("节点显示失败", error); }, [error]);
  return <div className="ff-shape-error-fallback" role="alert" style={{ width: "100%", height: "100%", boxSizing: "border-box", padding: 12, background: "var(--ff-raised)", color: "var(--ff-bad)", overflow: "auto", pointerEvents: "auto" }}><b>这个节点暂时无法显示</b><p>其他节点可继续使用。请先保存或备份，再检查该节点的数据。</p><ErrorSummary error={error} /></div>;
}

/** tldraw 5.4.2 exposes error, not a reset callback. Never fake a retry by remounting the editor. */
export function CanvasErrorFallback({ error }: { error: unknown }) {
  const label = useContext(CanvasSaveStatusContext);
  useEffect(() => { reportUiError("画布显示失败", error); }, [error]);
  return <div role="alert" style={{ position: "absolute", inset: 0, padding: 32, background: "var(--ff-raised)", color: "var(--ff-text)", overflow: "auto" }}><h2>画布暂时无法显示</h2><ErrorSummary error={error} /><p>保存状态：{label}</p><p>{saveStateExplanation(label)}</p><p>本版本画布引擎没有安全的边界重试接口，未自动重新挂载画布或重新提交任务。</p><button type="button" onClick={() => window.location.reload()}>重新加载页面</button></div>;
}
