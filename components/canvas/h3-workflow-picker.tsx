"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { H3_WORKFLOW_OPTIONS, workflowOption, isCommunityWorkflow } from "@/lib/h3-workflow-options";

export function H3WorkflowPicker({ value, disabled, onChange, nodeId }: { value?: string; disabled: boolean; onChange: (id: string) => void; nodeId?: string }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return;
    const close = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setPosition(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setPosition(null); button.current?.focus(); } };
    const resize = () => setPosition(null);
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", key); window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", key); window.removeEventListener("resize", resize); };
  }, [position]);
  return <>
    <button ref={button} type="button" className="creative-workflow-button" disabled={disabled} aria-label="选择视频工作流" aria-haspopup="dialog" aria-expanded={!!position} onClick={(event) => {
      event.stopPropagation(); if (position) { setPosition(null); return; }
      const rect = event.currentTarget.getBoundingClientRect(); setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 338)), top: Math.max(8, Math.min(rect.top - 330, window.innerHeight - 338)) });
    }}>{workflowOption(value)?.label ?? "未知工作流"} <span>⌄</span></button>
    {position && createPortal(<div ref={panel} className="h3-workflow-menu" data-node-id={nodeId} style={{ ...position, maxHeight: window.innerHeight - position.top - 8 }} role="dialog" aria-label="视频工作流选择" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <header>选择工作流<button type="button" aria-label="关闭工作流选择" onClick={() => setPosition(null)}>×</button></header>
      {H3_WORKFLOW_OPTIONS.filter(option => isCommunityWorkflow(option.id)).map((option) => <button key={option.id} type="button" disabled={disabled} aria-pressed={(value ?? "community-ultimate") === option.id} onClick={() => { if (!disabled) { onChange(option.id); setPosition(null); } }}><b>{option.label}</b><small>{option.detail}</small></button>)}
      <p className="ff-hint">两套工作流最多9张图片参考；首尾帧和音色参考为未试渲实验。专业参数默认沿用原配置，可单独调整并恢复默认。</p>
    </div>, document.body)}
  </>;
}
