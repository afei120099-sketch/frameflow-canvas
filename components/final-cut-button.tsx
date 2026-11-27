"use client";
// 当前无活跃画布入口；scripts/test-final-cut-toggle.mjs 按文本读取，保留本文件及其 final-cut-actions 依赖。

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ListChecks, ListPlus, ListVideo, Undo2, Plus } from "lucide-react";
import { assetMembership, finalCutToggleAction } from "@/lib/final-cut-list";
import { getFinalCutSnapshot, subscribeFinalCut } from "@/lib/final-cut-store";
import { addToFinalCut, cancelFinalCut, openFinalCut } from "@/components/final-cut-actions";
import { showCanvasToast } from "@/components/canvas/canvas-events";

/**
 * Phase 18.1: state-aware "加入成片" button shared by the video node, Asset Library, Shot Board and
 * lineage view. Not in the sequence → 加入成片; once → 已加入成片 (click cancels it); several times →
 * a small menu (view the sequence / cancel the most recent addition / add once more) — never a
 * one-click delete of every use. Membership comes from one shared snapshot, so all entries agree.
 */
type Variant = "node" | "icon" | "labeled";

export function FinalCutButton({ assetId, variant, shotId, onMessage, onError }: {
  assetId: string;
  variant: Variant;
  /** Provenance hint for the add (Shot Board). */
  shotId?: string;
  /** Where to show results; defaults to the canvas toast. */
  onMessage?: (message: string) => void;
  onError?: (message: string) => void;
}) {
  const list = useSyncExternalStore(subscribeFinalCut, getFinalCutSnapshot, () => null);
  const { count } = assetMembership(list, assetId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const holder = useRef<HTMLSpanElement>(null);
  const say = (message: string) => (onMessage ?? showCanvasToast)(message);
  const fail = (cause: unknown) => (onError ?? showCanvasToast)(cause instanceof Error ? cause.message : "成片操作失败");

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => { if (!holder.current?.contains(event.target as Node)) setMenuOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setMenuOpen(false); } };
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", onKey, true); };
  }, [menuOpen]);

  const run = async (action: () => Promise<string>) => {
    if (working) return;
    setWorking(true); setMenuOpen(false);
    try { say(await action()); } catch (cause) { fail(cause); } finally { setWorking(false); }
  };
  const click = () => {
    const action = finalCutToggleAction(list, assetId);
    if (action.kind === "add") void run(() => addToFinalCut(assetId, shotId ? { shotId } : {}));
    else if (action.kind === "remove") void run(() => cancelFinalCut(assetId, "only"));
    else setMenuOpen((open) => !open);
  };

  const state = count === 0 ? "out" : count === 1 ? "in" : "multi";
  const label = state === "out" ? "加入成片" : state === "in" ? "已加入成片" : `已加入 ×${count}`;
  const title = state === "out" ? "加入成片序列（任何视频都可以，不需要 ★采用）" : state === "in" ? "已在成片序列中 · 再点一次取消这一条" : `该素材在成片序列中出现 ${count} 次 · 点击选择操作`;
  const Icon = state === "out" ? ListPlus : ListChecks;
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const className = variant === "node" ? `node-header-button final-cut-toggle is-${state}` : variant === "icon" ? `final-cut-toggle is-${state}` : `final-cut-toggle labeled is-${state}`;

  return <span ref={holder} className={`final-cut-toggle-holder variant-${variant}`} onPointerDown={stop} onPointerUp={stop} onDoubleClick={stop}>
    <button type="button" className={className} style={variant==='node'?{width:'auto',minWidth:96,minHeight:38,height:38,padding:'0 10px',gap:6,border:'1px solid var(--ff-border-hover)',borderRadius:8,background:'var(--ff-hover)',fontSize:12,cursor:'pointer',touchAction:'manipulation',flexShrink:0}:undefined} title={title} aria-label={label} aria-pressed={state !== "out"} aria-haspopup={state === "multi" ? "menu" : undefined} aria-expanded={state === "multi" ? menuOpen : undefined} disabled={working} data-final-cut-state={state} onPointerDown={stop} onPointerUp={stop} onClick={(event) => { event.stopPropagation(); click(); }}>
      <Icon size={variant==='node'?16:13} />{variant !== "icon" && <span>{label}</span>}{variant === "icon" && state === "multi" && <b className="final-cut-count">{count}</b>}
    </button>
    {menuOpen && <span className="final-cut-menu" role="menu" onPointerDown={stop} onClick={stop}>
      <small>该素材在成片序列中出现 {count} 次</small>
      <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); openFinalCut(); }}><ListVideo size={13} />查看成片序列</button>
      <button type="button" role="menuitem" onClick={() => void run(() => cancelFinalCut(assetId, "latest"))}><Undo2 size={13} />取消最近一次加入</button>
      <button type="button" role="menuitem" onClick={() => void run(() => addToFinalCut(assetId, shotId ? { shotId } : {}))}><Plus size={13} />再加入一次</button>
    </span>}
  </span>;
}
