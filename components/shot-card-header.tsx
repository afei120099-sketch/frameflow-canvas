"use client";

/**
 * 镜头卡片的「一行顶栏」和顶栏下面的折叠条（用户 2026-11-11：「置顶的内容占了整个页面太多了，下面能滑动观看的页面太少了」）。
 * - 顶栏只有一行：队列名 + 紧凑状态 + 按钮（「从 JSON 导入台词」「复制写错 / 漏写」收进「更多」）。按钮一律深底细边白字，不用白底块。
 * - 正本 h3q、已入队过、完整度汇总是 ScFoldBar 里并排的小卡片（标题 + 一句摘要 + 箭头），跟着镜头一起滚动；点开在这一排下面展开详情。有错时卡片醒目（红，不用紫）。
 * 样式单独放这里（SC_HEADER_STYLE），shot-card-board.tsx 只挂载，方便和其他窗口的改动合并。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SC_LAYOUT_STYLE } from "@/components/shot-card-layout";
import { COMPLETENESS_STYLE } from "@/components/shot-card-completeness";

export type FoldTone = "bad" | "warn" | "plain";

export interface FoldItem { id: string; label: string; tone: FoldTone; summary: string; content: ReactNode }
const OPEN_EVENT = "frameflow:shot-card-open-fold";

/** 一排并排的小卡片，每张一句摘要；点一张在这排下面展开它的详情，再点收起。默认都收起。 */
export function ScFoldBar({ items }: { items: FoldItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onOpen = (event: Event) => { setOpen((event as CustomEvent<string>).detail); requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" })); };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  const current = items.find((item) => item.id === open);
  return <div className="scf-bar" ref={ref}>
    <div className="scf-cards">{items.map((item) => <button type="button" key={item.id} className={`scf-card ${item.tone} ${open === item.id ? "on" : ""}`} aria-expanded={open === item.id} title={`${item.label}：${item.summary}`} onClick={() => setOpen((value) => value === item.id ? null : item.id)}>
      <b>{item.label}</b><span>{item.summary}</span><i aria-hidden="true">{open === item.id ? "▴" : "▾"}</i>
    </button>)}</div>
    {current && <div className="scf-detail" role="region" aria-label={current.label}>{current.content}</div>}
  </div>;
}

/** 「更多」下拉：点外面、按 Esc、点了里面的按钮都会收起。 */
export function ScMoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", away, true); window.removeEventListener("keydown", key, true); };
  }, [open]);
  return <div className="scf-more" ref={ref}>
    <button type="button" className="sc-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>更多 <span aria-hidden="true">▾</span></button>
    {open && <div className="scf-menu" role="menu" onClick={(event) => { if ((event.target as HTMLElement).closest("button:not([disabled])")) setOpen(false); }}>{children}</div>}
  </div>;
}

/** 展开并滚到那排小卡片里的某一张（顶栏里点「h3q」时用）。 */
export function openFold(id: string) { window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id })); }

export const SC_HEADER_STYLE = `
/* 一行顶栏（覆盖 .sc-slate-head 原来的两行大标题） */
.sc-slate-head.scf-head{align-items:center;gap:12px;height:48px;padding:0 16px;box-sizing:border-box;flex:none}
.scf-head h2{flex:0 1 auto;min-width:80px;max-width:32%;margin:0;font:600 15px/1.2 var(--display);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scf-stats{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:2px;overflow:hidden;white-space:nowrap;font:12.5px var(--mono);color:var(--muted)}
.scf-stats>*{flex:none;padding:3px 7px;border:1px solid transparent;border-radius:6px;background:transparent;font:inherit;color:inherit}
.scf-stats>*+*::before{content:"·";margin-right:7px;color:var(--dim)}
.scf-stats b{font-weight:600;color:var(--paper)}
.scf-stats button{cursor:pointer}.scf-stats button:hover{border-color:var(--line-2);color:var(--paper)}
.scf-stats button.on{border-color:var(--muted);background:var(--panel-2);color:var(--paper)}
.scf-stats .bad b,.scf-stats .bad{color:var(--stop)}.scf-stats .warn b{color:var(--warn)}
.scf-head .sc-head-actions{flex:none;display:flex;align-items:center;gap:6px}
.scf-head .sc-btn{padding:5px 11px;font-size:12.5px}
.scf-head .sc-btn small{opacity:.7}
.scf-head .sc-close{width:32px;height:32px;border-radius:8px}
.scf-copied{font-size:12px;color:var(--muted);white-space:nowrap}
.scf-head .scf-undo{position:absolute;right:16px;top:54px;z-index:20;padding:5px 12px;border:1px solid var(--line-2);border-radius:8px;background:var(--panel-2);color:var(--paper);box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none}
.scf-more{position:relative}
.scf-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:30;min-width:220px;display:flex;flex-direction:column;padding:6px;border:1px solid var(--line-2);border-radius:10px;background:var(--panel);box-shadow:0 12px 32px rgba(0,0,0,.45)}
.scf-menu>button{display:block;width:100%;padding:7px 10px;border:0;border-radius:6px;background:transparent;text-align:left;font-size:13px;color:var(--paper)}
.scf-menu>button:hover:not([disabled]){background:var(--panel-2)}
.scf-menu>button[disabled]{color:var(--dim);cursor:default}
.scf-menu>hr{margin:4px 2px;border:0;border-top:1px solid var(--line)}

/* 顶栏下面、跟着镜头一起滚动的区域：一排并排小卡片，点开在下面展开 */
.scf-top{display:flex;flex-direction:column;gap:6px;padding-top:10px}
.scf-top .sc-bulk,.scf-top .sc-jump{margin:0}
.scf-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px}
.scf-card{display:flex;align-items:center;gap:8px;min-width:0;height:34px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:12.5px;color:var(--muted);text-align:left;cursor:pointer}
.scf-card b{flex:none;font-weight:600;color:var(--paper)}
.scf-card span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scf-card i{flex:none;font-style:normal;color:var(--dim)}
.scf-card:hover{border-color:var(--line-2);background:var(--panel-2)}
.scf-card.on{border-color:var(--muted);background:var(--panel-2)}
.scf-card.bad{border-color:rgba(220,138,124,.6)}.scf-card.bad b,.scf-card.bad span{color:var(--stop)}
.scf-card.warn b{color:var(--warn)}.scf-card.warn span{color:var(--paper)}
.scf-detail{margin-top:6px;padding:10px 12px;border:1px solid var(--line-2);border-radius:8px;background:var(--panel)}
.scf-detail>.sc-bulk{margin:0;border:0;padding:0;background:transparent}

/* 按钮一律深底、细边、白字；主次靠文字亮度和粗细，不用白底块（用户 2026-11-11） */
.sc-root .sc-btn.primary,.sc-root .sc-render-btn,.sc-root .sc-slate .sc-render-btn{background:var(--panel-2);border-color:var(--muted);color:var(--paper);font-weight:600;filter:none}
.sc-root .sc-btn.primary:hover:not(:disabled),.sc-root .sc-slate .sc-render-btn:hover:not(:disabled){background:var(--ff-raised);border-color:var(--paper);filter:none}
.sc-root .sc-slate .sc-render-btn:disabled{background:transparent;border-color:var(--line-2);color:var(--dim);font-weight:400}
.sc-root .sc-versions button.on{background:var(--panel-2);border-color:var(--paper);color:var(--paper)}
.sc-root .sc-kf-acts button.ok:hover,.sc-root .sc-kf-go:hover:not(:disabled),.sc-root .sc-checks li button.fix:hover,.sc-root .sc-move button:hover{background:var(--panel-2);border-color:var(--paper);color:var(--paper)}
.sc-root .sc-video>button:hover svg{background:rgba(12,12,12,.9);color:var(--paper)}
/* 顶栏两行（2026-11-12）：第一行 队列名 · 镜数时长 · 「全部入队」主按钮 + 操作；第二行 检查状态和整集开关。
   抽屉「JSON / 进度」贴着顶栏下沿：高度写在 --sc-head-h（useHeadHeight）。 */
.sc-slate-head.scf-head{flex-direction:column;align-items:stretch;gap:2px;height:auto;padding:6px 16px 6px}
.scf-line1{display:flex;align-items:center;gap:12px;min-height:38px;min-width:0}
.scf-line1 h2{flex:0 1 auto}
.scf-meta{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:12.5px var(--mono);color:var(--muted)}
.scf-meta b{font-weight:600;color:var(--sc-value,var(--paper))}
.scf-head>.scf-stats{min-height:26px;margin-left:-7px}
.sc-empty-head.scf-head>.scf-line1{min-height:36px}
/* 「全部入队（N 镜）」：顶栏里唯一的亮按钮——亮边框 + 粗字 + 近白字，不用白底块（用户不要白底、不要紫色） */
.sc-root .scf-head .sc-btn.sc-enqueue{padding:6px 16px;border-color:var(--sc-strong,#f5f5f5);background:var(--panel-2);color:var(--sc-strong,#f5f5f5);font-size:13px;font-weight:600}
.sc-root .scf-head .sc-btn.sc-enqueue:hover:not(:disabled){background:var(--ff-raised);box-shadow:0 0 0 1px var(--sc-strong,#f5f5f5)}
.sc-root .scf-head .sc-btn.sc-enqueue:disabled{border-color:var(--line-2);color:var(--muted);font-weight:400}
.scf-head .scf-undo{top:calc(100% + 6px)}
@media (max-width:1600px){.scf-head .sc-btn{padding:5px 8px}.scf-head .sc-btn.primary small{display:none}.scf-head .sc-head-actions{gap:4px}.scf-stats>*{padding:3px 5px}.scf-stats>*+*::before{margin-right:5px}}
@media (max-width:1080px){.scf-head h2{max-width:24%}}
` + SC_LAYOUT_STYLE + COMPLETENESS_STYLE();
