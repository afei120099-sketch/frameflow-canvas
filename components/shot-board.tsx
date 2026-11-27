"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Clapperboard, Crosshair, GitBranch, GripVertical, Star, X } from "lucide-react";
import { getMeta, listAssets, listRuns, listShots, putMeta, type AssetRecord } from "@/lib/production-records";
import { boardFromRows, boardTotals, buildBoardRows, emptyBoard, formatSeconds, moveRow, setInOut, SHOT_BOARD_KEY, updateItem, type ShotBoardRow, type ShotBoardState } from "@/lib/shot-board";
import { getPoster } from "@/lib/poster-cache";
import { openLineage } from "@/components/lineage-viewer";
import { isTypingTarget } from "@/lib/keyboard-guards";

const load = async () => {
  const [board, shots, assets, runs] = await Promise.all([getMeta<ShotBoardState>(SHOT_BOARD_KEY), listShots(), listAssets("video"), listRuns()]);
  return buildBoardRows(board ?? emptyBoard(), shots, new Map(assets.map((asset) => [asset.assetId, asset])), new Map(runs.map((run) => [run.runId, run])));
};
const parseSeconds = (value: string) => value.trim() === "" ? null : Number(value);

export function ShotBoard({ onClose, onLocate }: { onClose: () => void; onLocate: (asset: AssetRecord) => boolean }) {
  const [rows, setRows] = useState<ShotBoardRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { in: string; out: string }>>({});

  useEffect(() => {
    let active = true;
    const refresh = () => void load().then((next) => { if (active) { setRows(next); setLoaded(true); } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "镜头板读取失败"); });
    refresh();
    window.addEventListener("frameflow-shot-changed", refresh);
    return () => { active = false; window.removeEventListener("frameflow-shot-changed", refresh); };
  }, []);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing && !isTypingTarget(event.target)) { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true); }, [onClose]);

  /** Every edit is saved immediately; the board only stores its own metadata. */
  const commit = useCallback((change: () => ShotBoardRow[], message = "") => {
    try {
      const next = change();
      setRows(next); setError(""); setNotice(message);
      void putMeta(SHOT_BOARD_KEY, boardFromRows(next)).catch((cause) => setError(cause instanceof Error ? `保存失败：${cause.message}` : "保存失败"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
  }, []);
  const totals = useMemo(() => boardTotals(rows), [rows]);
  const draftFor = (row: ShotBoardRow) => drafts[row.shot.shotId] ?? { in: row.item.inPoint?.toString() ?? "", out: row.item.outPoint?.toString() ?? "" };
  /** Reads the values from the inputs themselves (not React state), so a fast type-then-blur is never lost. */
  const saveInOut = (row: ShotBoardRow, field: HTMLInputElement) => {
    const inputs = field.closest(".shot-board-inout")?.querySelectorAll("input");
    const [inValue, outValue] = inputs ? [inputs[0].value, inputs[1].value] : [draftFor(row).in, draftFor(row).out];
    commit(() => setInOut(rows, row.shot.shotId, parseSeconds(inValue), parseSeconds(outValue)));
    setDrafts((current) => { const next = { ...current }; delete next[row.shot.shotId]; return next; });
  };

  return createPortal(<aside className="asset-library-drawer ff-panel shot-board" role="dialog" aria-label="镜头板" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <header><div><small className="ff-hint">★ 采用版本 · 镜头管理（最终剪辑顺序在“成片序列”）</small><h2>镜头板</h2></div><button type="button" aria-label="关闭镜头板" onClick={onClose}><X size={17} /></button></header>
    <div className="shot-board-summary"><span>纳入 <b>{totals.included}</b> / 已采用 {totals.adopted} / 镜头 {totals.shots}</span><span>总时长 <b>{formatSeconds(totals.seconds)}</b>{totals.unknownDurations ? `（${totals.unknownDurations} 个时长未知）` : ""}</span></div>
    <div className="asset-library-list shot-board-list">
      {!loaded ? <p className="backup-note">正在读取镜头…</p> : rows.length ? rows.map((row, index) => {
        const draft = draftFor(row);
        const poster = row.adopted ? getPoster(row.adopted.storageReference) : undefined;
        return <div key={row.shot.shotId} className={`shot-board-row ${row.item.included ? "included" : ""} ${dragIndex === index ? "dragging" : ""}`} draggable onDragStart={(event) => { setDragIndex(index); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDragIndex(null)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); if (dragIndex !== null && dragIndex !== index) commit(() => moveRow(rows, dragIndex, index)); setDragIndex(null); }}>
          <span className="shot-board-grip" title="拖动排序"><GripVertical size={14} /></span>
          <span className="shot-board-thumb">{poster ? <img src={poster} alt="" draggable={false} /> : <Clapperboard size={18} />}</span>
          <div className="shot-board-main">
            <div className="shot-board-title"><b>镜头 {String(row.shot.shotNumber).padStart(2, "0")}</b><span title={row.shot.title}>{row.shot.title}</span></div>
            <div className="shot-board-meta">{row.adopted ? <><Star size={11} /> <span title={row.adopted.filename}>{row.adopted.filename}</span> · {row.source} · {formatSeconds(row.duration)}{row.effectiveDuration !== null && row.effectiveDuration !== row.duration ? ` → ${formatSeconds(row.effectiveDuration)}` : ""}</> : <span className="shot-board-pending">尚未 ★ 采用版本</span>}</div>
            {row.adopted && <div className="shot-board-inout"><label>入点<input inputMode="decimal" value={draft.in} placeholder="0" onChange={(event) => setDrafts((current) => ({ ...current, [row.shot.shotId]: { ...draft, in: event.target.value } }))} onBlur={(event) => saveInOut(row, event.currentTarget)} /></label><label>出点<input inputMode="decimal" value={draft.out} placeholder={row.duration?.toFixed(1) ?? "结尾"} onChange={(event) => setDrafts((current) => ({ ...current, [row.shot.shotId]: { ...draft, out: event.target.value } }))} onBlur={(event) => saveInOut(row, event.currentTarget)} /></label><small>秒 · 仅记录，不裁切</small></div>}
            <textarea className="shot-board-note" rows={1} value={row.item.note} placeholder="备注" onChange={(event) => setRows(updateItem(rows, row.shot.shotId, { note: event.target.value }))} onBlur={(event) => { const note = event.currentTarget.value; commit(() => updateItem(rows, row.shot.shotId, { note })); }} />
          </div>
          <div className="shot-board-actions">
            <label className="shot-board-include" title={row.canInclude ? "纳入成片" : "需要先 ★ 采用一个版本"}><input type="checkbox" checked={row.item.included} disabled={!row.canInclude} onChange={(event) => commit(() => updateItem(rows, row.shot.shotId, { included: event.target.checked }))} />纳入</label>
            <button type="button" title="上移" aria-label="上移" disabled={index === 0} onClick={() => commit(() => moveRow(rows, index, index - 1))}><ArrowUp size={13} /></button>
            <button type="button" title="下移" aria-label="下移" disabled={index === rows.length - 1} onClick={() => commit(() => moveRow(rows, index, index + 1))}><ArrowDown size={13} /></button>
            {row.adopted && <button type="button" title="血缘查看" aria-label="血缘查看" onClick={() => openLineage(row.adopted!.assetId)}><GitBranch size={13} /></button>}{row.adopted && <button type="button" title="在画布中定位" aria-label="在画布中定位" onClick={() => { if (!onLocate(row.adopted!)) setNotice("该版本当前不在画布上（记录仍在，可从素材库放回画布）"); }}><Crosshair size={13} /></button>}
          </div>
        </div>;
      }) : <div className="role-empty"><Clapperboard size={20} />还没有镜头。H3 生成后会自动出现在这里。</div>}
    </div>
    <p className="ff-hint backup-note shot-board-foot">入点 / 出点当前只保存为元数据，不做裁切或拼接。</p>
    {(error || notice) && <p className={error ? "role-error" : "role-notice"} role="status">{error || notice}</p>}
  </aside>, document.body);
}
