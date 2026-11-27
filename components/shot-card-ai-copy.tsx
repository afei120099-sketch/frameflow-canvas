"use client";
/**
 * 「复制给 AI 修改」：复制后轻提示「已复制 N 镜的问题」；剪贴板不让写（浏览器权限）时弹一个文本框，手动全选复制。
 * 文字由 lib/shot-card-ai-copy.ts 的 aiFixText 生成。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ClipboardCopy, X } from "lucide-react";
import { copyPlainText } from "@/lib/copy-plain-text";
import { aiFixText, type AiCopyInput } from "@/lib/shot-card-ai-copy";

export function useAiCopy() {
  const [note, setNote] = useState("");
  const [fallback, setFallback] = useState("");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = (input: AiCopyInput) => {
    const { text, count } = aiFixText(input);
    // 成功：右下角轻提示（lib/copy-toast.ts，约 1.5 秒）；剪贴板不让写：弹文本框手动复制。
    void copyPlainText(text, count ? `已复制 ${count} 镜的问题，贴给 AI 就行` : "没有问题，已复制一句说明").then((ok) => { if (!ok) setFallback(text); });
  };
  /** note 放顶栏；dialog 放在卡片最外层（盖住整张卡片）。 */
  const note_: ReactNode = note ? <span className="scf-copied" role="status">{note}</span> : null;
  const dialog: ReactNode = fallback ? <AiCopyFallback text={fallback} onClose={() => setFallback("")} /> : null;
  return { copy, note: note_, dialog };
}

/** 顶栏 / 展开区里的「复制给 AI 修改」按钮。 */
export function AiCopyButton({ onCopy, label = "复制给 AI 修改", title }: { onCopy: () => void; label?: string; title: string }) {
  return <button type="button" className="sc-btn sca-btn" title={title} onClick={(event) => { event.stopPropagation(); onCopy(); }}><ClipboardCopy size={13} aria-hidden="true" />{label}</button>;
}

function AiCopyFallback({ text, onClose }: { text: string; onClose: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { area.current?.focus(); area.current?.select(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return <div className="sca-shade" role="dialog" aria-modal="true" aria-label="手动复制" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="sca-box">
      <header><b>浏览器不让自动复制，请手动复制</b><button type="button" className="scv-close" aria-label="关闭" onClick={onClose}><X size={16} /></button></header>
      <p>文字已经全选好了，按 Ctrl+C 复制，再贴给 AI。</p>
      <textarea ref={area} readOnly value={text} spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
      <footer><button type="button" className="sc-btn" onClick={() => { area.current?.focus(); area.current?.select(); }}>全选</button><button type="button" className="sc-btn" onClick={onClose}>关闭</button></footer>
    </div>
  </div>;
}

export const AI_COPY_STYLE = `
.sca-btn{display:inline-flex;align-items:center;gap:5px}
.sca-shade{position:absolute;inset:0;z-index:40;display:grid;place-items:center;padding:16px;background:rgba(12,12,12,.7)}
.sca-box{display:flex;flex-direction:column;gap:8px;width:min(760px,100%);max-height:86vh;padding:14px 16px;border:1px solid var(--ff-border-strong);border-radius:var(--ff-r-lg);background:var(--ff-raised);color:var(--ff-text)}
.sca-box header,.sca-box footer{display:flex;align-items:center;gap:8px}.sca-box header b{flex:1}.sca-box footer{justify-content:flex-end}
.sca-box p{margin:0;color:var(--ff-text-2);font-size:12px}
.sca-box textarea{flex:1;min-height:320px;resize:vertical;padding:10px;border:1px solid var(--ff-border);border-radius:var(--ff-r);background:var(--ff-sunken);color:var(--ff-text);font:12.5px/1.6 var(--ff-mono)}
.sc-row-tools .sca-one{color:var(--ff-text-2)}
.sca-row{display:flex;justify-content:flex-end;margin:0 0 6px}
.scf-stats>.scf-ai{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;margin-left:-2px;border:1px solid var(--ff-border-strong);border-radius:6px;font-size:12px;color:var(--ff-text-2)}
.scf-stats>.scf-ai::before{content:none}
.scf-stats>.scf-ai:hover{color:var(--ff-text)}
`;
