"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Command, CornerDownLeft, Search } from "lucide-react";
import { rankCommands, type PaletteCommand } from "@/lib/command-palette";

export interface PaletteAction extends PaletteCommand { run: () => void | Promise<void> }
/** Search results supplied by the canvas (Stage H); each one knows how to open / locate itself. */
export interface PaletteResult { id: string; group: string; label: string; detail?: string; icon?: ReactNode; run: () => void }

export function CommandPalette({ commands, search, initialQuery = "", placeholder = "输入命令或搜索节点、镜头、素材、角色…", onClose }: { commands: PaletteAction[]; search?: (query: string) => Promise<PaletteResult[]>; initialQuery?: string; placeholder?: string; onClose: () => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<PaletteResult[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    let alive = true;
    if (!search || !query.trim()) { queueMicrotask(() => { if (alive) setResults([]); }); return () => { alive = false; }; }
    const timer = window.setTimeout(() => void search(query).then((next) => { if (alive) setResults(next); }).catch(() => { if (alive) setResults([]); }), 90);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query, search]);
  const ranked = useMemo(() => rankCommands(commands.filter((command) => !command.disabled), query).slice(0, query.trim() ? 8 : 20), [commands, query]);
  const items = useMemo(() => [...ranked.map((command) => ({ key: `c:${command.id}`, group: command.group, label: command.label, detail: command.hint, icon: <Command size={14} />, run: command.run })), ...results.map((result) => ({ key: `r:${result.id}`, group: result.group, label: result.label, detail: result.detail, icon: result.icon ?? <Search size={14} />, run: result.run }))], [ranked, results]);
  const selected = Math.min(active, Math.max(0, items.length - 1));
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" }); }, [selected]);
  const choose = (index: number) => { const item = items[index]; if (!item) return; onClose(); void item.run(); };
  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setActive((selected + 1) % Math.max(1, items.length)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((selected - 1 + items.length) % Math.max(1, items.length)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(selected); }
  };
  let lastGroup = "";
  return createPortal(<div className="generation-info-backdrop palette-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section className="ff-panel command-palette" role="dialog" aria-modal="true" aria-label="命令面板" onPointerDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
      <div className="palette-input"><Search size={16} /><input ref={input} value={query} placeholder={placeholder} aria-label="命令或搜索" onChange={(event) => { setQuery(event.target.value); setActive(0); }} /><kbd>Esc</kbd></div>
      <div className="palette-list" ref={listRef} role="listbox">
        {items.length ? items.map((item, index) => { const header = item.group !== lastGroup ? item.group : ""; lastGroup = item.group; return <div key={item.key}>
          {header && <div className="palette-group">{header}</div>}
          <button type="button" role="option" aria-selected={index === selected} data-index={index} className={index === selected ? "active" : ""} onMouseEnter={() => setActive(index)} onClick={() => choose(index)}>
            <span className="palette-icon">{item.icon}</span><span className="palette-label">{item.label}</span>{item.detail && <span className="palette-detail">{item.detail}</span>}{index === selected && <CornerDownLeft size={13} className="palette-enter" />}
          </button>
        </div>; }) : <div className="role-empty palette-empty">没有匹配的命令{search ? "或内容" : ""}</div>}
      </div>
      <div className="palette-foot"><span>↑↓ 选择 · Enter 执行 · Esc 关闭</span><span>Ctrl / ⌘ + K</span></div>
    </section>
  </div>, document.body);
}
