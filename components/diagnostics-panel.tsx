"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, CircleCheck, CircleX, ClipboardCopy, RefreshCw, Stethoscope, X } from "lucide-react";
import { diagnosticsReport, runDiagnostics, type CheckResult } from "@/lib/diagnostics";
import { browserDiagnosticsDeps } from "@/lib/diagnostics-browser";

const ICON = { pass: CircleCheck, warn: CircleAlert, fail: CircleX } as const;
const LABEL = { pass: "通过", warn: "警告", fail: "失败" } as const;

export function DiagnosticsPanel({ onClose }: { onClose: () => void }) {
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const [copied, setCopied] = useState("");
  const run = useCallback(async () => {
    setRunning(true); setCopied("");
    try { const next = await runDiagnostics(browserDiagnosticsDeps()); setResults(next); setCheckedAt(Date.now()); }
    finally { setRunning(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => void run()); }, [run]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true); }, [onClose]);
  const counts = results ? { pass: results.filter((item) => item.status === "pass").length, warn: results.filter((item) => item.status === "warn").length, fail: results.filter((item) => item.status === "fail").length } : null;
  const copy = async () => { if (!results) return; try { await navigator.clipboard.writeText(diagnosticsReport(results, checkedAt)); setCopied("报告已复制"); } catch { setCopied("复制失败：浏览器未允许访问剪贴板"); } };

  return createPortal(<div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section className="generation-info-panel ff-panel diagnostics-panel" role="dialog" aria-modal="true" aria-label="诊断中心" onPointerDown={(event) => event.stopPropagation()}>
      <header><div><small>只读体检 · 不自动修复</small><h2>诊断中心</h2></div><button type="button" aria-label="关闭诊断中心" onClick={onClose}><X size={17} /></button></header>
      <div className="diagnostics-toolbar">
        <span>{running ? "正在检查…" : counts ? <><b className="ok">{counts.pass} 通过</b> · <b className="warn">{counts.warn} 警告</b> · <b className="err">{counts.fail} 失败</b>{checkedAt ? ` · ${new Date(checkedAt).toLocaleTimeString("zh-CN")}` : ""}</> : "尚未检查"}</span>
        <div><button type="button" className="backup-secondary" disabled={running} onClick={() => void run()}><RefreshCw size={14} />重新检查</button><button type="button" className="backup-secondary" disabled={!results} onClick={() => void copy()}><ClipboardCopy size={14} />复制报告</button></div>
      </div>
      <ul className="diagnostics-list">
        {results ? results.map((result) => { const Icon = ICON[result.status]; return <li key={result.id} className={`status-${result.status}`}>
          <Icon size={16} aria-label={LABEL[result.status]} />
          <div><b>{result.label}</b><span>{result.detail}</span>{result.items && <details><summary>明细（{result.items.length}）</summary><ul>{result.items.map((item) => <li key={item}>{item}</li>)}</ul></details>}</div>
        </li>; }) : <li className="diagnostics-waiting"><Stethoscope size={16} /><div><b>准备检查</b><span>检查 ComfyUI、冻结模板、适配配置、媒体文件、角色、血缘、音频接口、备份能力和本地数据库。</span></div></li>}
      </ul>
      {copied && <p className={copied.startsWith("复制失败") ? "role-error" : "role-notice"} role="status">{copied}</p>}
    </section>
  </div>, document.body);
}
