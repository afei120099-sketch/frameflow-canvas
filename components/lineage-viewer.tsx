"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Crosshair, GitBranch, Image as ImageIcon, Mic2, Star, Video, X } from "lucide-react";
import { listAssets, listRuns, listShots } from "@/lib/production-records";
import { buildLineage, relationName, type Lineage, type LineageNode } from "@/lib/lineage";

export const OPEN_LINEAGE_EVENT = "frameflow-open-lineage";
/** Open the read-only lineage view for an Asset from anywhere (library, search, nodes). */
export const openLineage = (assetId: string) => window.dispatchEvent(new CustomEvent(OPEN_LINEAGE_EVENT, { detail: assetId }));

const KIND_ICON = { image: ImageIcon, video: Video, audio: Mic2 } as const;

function Row({ node, onLocate }: { node: LineageNode; onLocate: (assetId: string) => boolean }) {
  const [notice, setNotice] = useState("");
  const Icon = node.asset ? KIND_ICON[node.asset.kind] : GitBranch;
  return <li>
    <div className={`lineage-row ${node.truncated === "missing" ? "missing" : ""}`}>
      <Icon size={14} />
      <div className="lineage-main">
        <div className="lineage-title"><b title={node.asset?.filename}>{node.asset?.filename ?? `记录缺失（${node.assetId.slice(0, 8)}…）`}</b>{node.shot && (node.shot.adopted ? <span className="lineage-badge adopted"><Star size={10} />已采用 · 镜头 {String(node.shot.shot.shotNumber).padStart(2, "0")}</span> : <span className="lineage-badge">{node.shot.label ? `候选${node.shot.label}` : "镜头衍生版本"} · 镜头 {String(node.shot.shot.shotNumber).padStart(2, "0")}</span>)}</div>
        <div className="lineage-meta">
          {node.relation !== "result" && <span>作为：{relationName(node.relation)}</span>}
          {node.producedBy ? <span>来自 {node.producedBy.capability} · Run …{node.producedBy.run.runId.slice(-8)} · {node.producedBy.run.status === "completed" ? "已完成" : node.producedBy.run.status}</span> : node.derivation ? <span>{node.derivation}</span> : node.asset ? <span>{node.asset.origin === "imported" ? "导入素材（源头）" : "来源未记录"}</span> : null}
          {node.truncated === "cycle" && <span>（循环引用，已停止展开）</span>}{node.truncated === "depth" && <span>（层级过深，已停止展开）</span>}
        </div>
        {notice && <div className="lineage-notice">{notice}</div>}
      </div>
      {node.asset && <button type="button" title="在画布中定位" aria-label="在画布中定位" onClick={() => setNotice(onLocate(node.assetId) ? "" : "当前不在画布上")}><Crosshair size={13} /></button>}
    </div>
    {node.inputs.length > 0 && <ul>{node.inputs.map((child, index) => <Row key={`${child.assetId}-${index}`} node={child} onLocate={onLocate} />)}</ul>}
  </li>;
}

export function LineageViewer({ assetId, onClose, onLocate }: { assetId: string; onClose: () => void; onLocate: (assetId: string) => boolean }) {
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([listAssets(), listRuns(), listShots()]).then(([assets, runs, shots]) => { if (active) setLineage(buildLineage(assetId, { assets: new Map(assets.map((a) => [a.assetId, a])), runs: new Map(runs.map((r) => [r.runId, r])), shots: new Map(shots.map((s) => [s.shotId, s])) })); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "血缘读取失败"); });
    return () => { active = false; };
  }, [assetId]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true); }, [onClose]);
  return createPortal(<div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section className="generation-info-panel ff-panel lineage-panel" role="dialog" aria-modal="true" aria-label="血缘查看" onPointerDown={(event) => event.stopPropagation()}>
      <header><div><small>只读 · 不能在这里修改关系</small><h2>血缘查看</h2></div><button type="button" aria-label="关闭血缘查看" onClick={onClose}><X size={17} /></button></header>
      <div className="lineage-body">
        {error ? <p className="role-error">{error}</p> : !lineage ? <p className="backup-note">正在读取记录…</p> : <>
          
          <h3>它从哪里来</h3>
          <ul className="lineage-tree"><Row node={lineage.root} onLocate={onLocate} /></ul>
          <h3>由它生成</h3>
          {lineage.derived.length ? <ul className="lineage-tree">{lineage.derived.map((node) => <Row key={node.assetId} node={node} onLocate={onLocate} />)}</ul> : <p className="backup-note">暂无下游结果。</p>}
        </>}
      </div>
    </section>
  </div>, document.body);
}
