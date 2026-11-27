"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, CircleX, ClipboardCopy, Crosshair, Info, ListChecks, Trash2, X } from "lucide-react";
import { CATEGORY_LABELS, clearRead, entryDetails, getLogVersion, listEntries, markAllRead, resolveRunEntries, subscribeLog, type LogEntry, type LogLevel } from "@/lib/error-log";
import { abandonUnconfirmedRun, recheckUnconfirmedRun, UNCONFIRMED_RUN_TITLE, type UnconfirmedRunDeps } from "@/lib/unconfirmed-run-actions";
import { getRun, updateRun } from "@/lib/production-records";
import { comfyUIH3Adapter } from "@/lib/comfyui/h3-adapter";
import { activeEnhancementPrompt } from "@/lib/resume-enhancement";
import { askConfirm, showNotice } from "./in-page-dialog";

type Filter = "all" | LogLevel;
const FILTERS: { value: Filter; label: string }[] = [{ value: "all", label: "全部" }, { value: "error", label: "错误" }, { value: "warning", label: "警告" }, { value: "info", label: "信息" }];
const ICONS = { error: CircleX, warning: CircleAlert, info: Info } as const;
const shortId = (id?: string) => id ? id.replace(/^shape:/, "").slice(-8) : "";

// Read-only toward ComfyUI (queue/history). Never submits, never cancels.
const runActionDeps: UnconfirmedRunDeps = {
  getRun, updateRun: (runId, changes) => updateRun(runId, changes),
  isAvailable: () => comfyUIH3Adapter.isAvailable(), probeJob: (jobId, saveNodeId) => comfyUIH3Adapter.probeJob(jobId, saveNodeId),
  activeEnhancementPrompt, resolveRunEntries,
};
const needsRunAction = (entry: LogEntry) => Boolean(entry.runId && entry.title === UNCONFIRMED_RUN_TITLE && !entry.resolvedAt);

export function useLogVersion() { return useSyncExternalStore(subscribeLog, getLogVersion, () => 0); }

export function ErrorCenter({ onClose, onLocateNode }: { onClose: () => void; onLocateNode: (nodeId: string) => boolean }) {
  const version = useLogVersion();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [notice, setNotice] = useState("");
  useEffect(() => { let active = true; void listEntries().then((next) => { if (active) setEntries(next); }); return () => { active = false; }; }, [version]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true); }, [onClose]);
  const shown = useMemo(() => entries.filter((entry) => filter === "all" || entry.level === filter), [entries, filter]);
  const count = (level: LogLevel) => entries.filter((entry) => entry.level === level).length;
  const [busyRun, setBusyRun] = useState("");
  const recheck = async (entry: LogEntry) => {
    if (busyRun) return; setBusyRun(entry.runId!);
    try { const result = await recheckUnconfirmedRun(entry.runId!, runActionDeps);
      if (result.kind === "lost" || result.kind === "no_job_id" || result.kind === "offline") { if (await askConfirm({ title: "查询结果", message: `${result.message}\n\n要把它标记为已放弃吗？只改本地记录：不会重新提交，也不会取消 ComfyUI 里的任何任务。`, confirmLabel: "标记为已放弃", cancelLabel: "先不处理" })) await showNotice({ title: "处理结果", message: (await abandonUnconfirmedRun(entry.runId!, runActionDeps)).message }); }
      else await showNotice({ title: "查询结果", message: result.message });
    } catch (cause) { await showNotice({ title: "查询失败", message: cause instanceof Error ? cause.message : String(cause) }); }
    finally { setBusyRun(""); }
  };
  const abandon = async (entry: LogEntry) => {
    if (busyRun) return;
    if (!await askConfirm({ title: "标记为已放弃？", message: "会先只读查一次 ComfyUI：任务如果还在跑或已经做完，就不放弃。\n确认找不到时，只把这条本地记录改成「已放弃」：不会重新提交，也不会取消 ComfyUI 里的任何任务。之后要出片请在节点上手动重新生成。", confirmLabel: "标记为已放弃", cancelLabel: "取消", danger: true })) return;
    setBusyRun(entry.runId!);
    try { await showNotice({ title: "处理结果", message: (await abandonUnconfirmedRun(entry.runId!, runActionDeps)).message }); }
    catch (cause) { await showNotice({ title: "处理失败", message: cause instanceof Error ? cause.message : String(cause) }); }
    finally { setBusyRun(""); }
  };
  const copy = async (entry: LogEntry) => { try { await navigator.clipboard.writeText(entryDetails(entry)); setNotice("高级信息已复制"); } catch { setNotice("复制失败：浏览器未允许访问剪贴板"); } };

  return createPortal(<aside className="asset-library-drawer ff-panel error-center" role="dialog" aria-label="错误中心" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <header><div><small>本地任务日志 · 仅本项目</small><h2>错误中心</h2></div><button type="button" aria-label="关闭错误中心" onClick={onClose}><X size={17} /></button></header>
    <div className="asset-library-toolbar">
      <div className="asset-library-tabs">{FILTERS.map((item) => <button type="button" key={item.value} className={filter === item.value ? "active" : ""} onClick={() => setFilter(item.value)}>{item.label}{item.value !== "all" ? ` ${count(item.value)}` : ` ${entries.length}`}</button>)}</div>
      <div className="error-center-actions"><button type="button" className="backup-secondary" disabled={!entries.some((entry) => !entry.read)} onClick={() => void markAllRead()}><ListChecks size={14} />全部标为已读</button><button type="button" className="backup-secondary" disabled={!entries.some((entry) => entry.read)} onClick={() => void clearRead()}><Trash2 size={14} />清除已读</button></div>
    </div>
    <div className="asset-library-list">
      {shown.length ? shown.map((entry) => { const Icon = ICONS[entry.level]; return <div key={entry.id} className={`error-entry level-${entry.level} ${entry.read ? "read" : "unread"}`}>
        <Icon size={15} />
        <div className="error-entry-main">
          <div className="error-entry-head"><b>{entry.title}</b>{entry.repeat && entry.repeat > 1 ? <em>×{entry.repeat}</em> : null}</div>
          <div className="error-entry-meta">{new Date(entry.time).toLocaleString("zh-CN")} · {CATEGORY_LABELS[entry.category]}{entry.runId ? ` · Run …${shortId(entry.runId)}` : ""}{entry.shotId ? ` · Shot …${shortId(entry.shotId)}` : ""}{entry.nodeId ? ` · 节点 …${shortId(entry.nodeId)}` : ""}</div>
          <details><summary>详细信息</summary><pre>{entry.detail}</pre></details>
          {entry.resolvedAt ? <div className="error-entry-meta">已处理：{entry.resolution}</div> : null}
          {needsRunAction(entry) && <div className="error-entry-run-actions"><button type="button" disabled={Boolean(busyRun)} onClick={() => void recheck(entry)}>重新查询一次</button><button type="button" disabled={Boolean(busyRun)} onClick={() => void abandon(entry)}>标记为已放弃</button></div>}
        </div>
        <div className="error-entry-actions">
          <button type="button" title="复制高级信息" aria-label="复制高级信息" onClick={() => void copy(entry)}><ClipboardCopy size={13} /></button>
          {entry.nodeId && <button type="button" title="定位节点" aria-label="定位节点" onClick={() => { if (!onLocateNode(entry.nodeId!)) setNotice("该节点已不在画布上"); }}><Crosshair size={13} /></button>}
        </div>
      </div>; }) : <div className="role-empty"><ListChecks size={20} />{entries.length ? "当前筛选下没有记录" : "还没有记录。任务失败、恢复、音频与备份问题会记录在这里。"}</div>}
    </div>
    {notice && <p className={notice.startsWith("复制失败") || notice.includes("不在") ? "role-error" : "role-notice"} role="status">{notice}</p>}
  </aside>, document.body);
}
