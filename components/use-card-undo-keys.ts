"use client";

/**
 * 镜头卡片开着时的 Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z（用户 2026-11-11）。
 * - 挂在 window 的捕获阶段、最先收到：这几个键一律不再往下传，不会撤销下面 tldraw 画布上的节点。卡片关掉（组件卸载）就摘掉，Ctrl+Z 照旧归画布。
 * - 焦点在文本框里、框里还有能撤销的字：只拦住不往下传，浏览器自己撤销正在打的字；撤到底了、或者是保存后新出来的框，就走卡片的修改历史。
 * - 焦点不在文本框：直接走卡片的修改历史（和顶栏「撤销 / 恢复」同一套）。
 */
import { useEffect, useRef } from "react";
import { countFieldInput, fieldOrCard, undoKeyIntent, type UndoIntent } from "@/lib/shot-card-undo";

const isTextField = (target: EventTarget | null): target is HTMLElement => target instanceof HTMLElement && (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(target.type)) || target.isContentEditable);

export function useCardUndoKeys(run: (intent: UndoIntent) => void) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const fields = new WeakMap<EventTarget, { typed: number; undone: number }>();
    const onInput = (event: Event) => {
      if (!isTextField(event.target)) return;
      fields.set(event.target, countFieldInput(fields.get(event.target) ?? { typed: 0, undone: 0 }, (event as InputEvent).inputType ?? ""));
    };
    const onKey = (event: KeyboardEvent) => {
      const intent = undoKeyIntent(event);
      if (!intent || event.isComposing) return;
      event.stopPropagation();
      if (isTextField(event.target) && fieldOrCard(intent, fields.get(event.target) ?? { typed: 0, undone: 0 }) === "field") return;
      event.preventDefault();
      latest.current(intent);
    };
    window.addEventListener("input", onInput, true);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("input", onInput, true); window.removeEventListener("keydown", onKey, true); };
  }, []);
}
