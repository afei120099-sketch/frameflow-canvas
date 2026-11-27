"use client";
import { useEffect, useMemo, useState } from "react";
import { useValue, type Editor } from "tldraw";
import { QueueDraftBook } from "@/lib/shot-queue-draft";
import { showCanvasToast } from "@/components/canvas/canvas-events";

export function useShotQueueDraft(editor: Editor, persistenceKey: string, autoSubmitText?: string | null) {
  const pageId = useValue("shot queue draft page", () => editor.getCurrentPageId(), [editor]);
  const book = useMemo(() => new QueueDraftBook(persistenceKey, () => window.localStorage, showCanvasToast), [persistenceKey]);
  const [view, setView] = useState({ pageId: "", raw: "" });
  const refresh = () => setView({ pageId, raw: book.read(pageId).raw });
  useEffect(() => {
    book.read(pageId);
    if (autoSubmitText) book.external(pageId, autoSubmitText);
    setView({ pageId, raw: book.read(pageId).raw });
    return () => book.flush(pageId);
  }, [book, pageId, autoSubmitText]);
  useEffect(() => {
    if (view.pageId !== pageId) return;
    const timer = setTimeout(() => book.flush(pageId), 500);
    return () => clearTimeout(timer);
  }, [book, view, pageId]);
  useEffect(() => {
    const flush = () => book.flushAll();
    window.addEventListener("beforeunload", flush);
    return () => { window.removeEventListener("beforeunload", flush); book.flushAll(); };
  }, [book]);
  return {
    pageId, raw: view.pageId === pageId ? view.raw : "",
    currentRaw: () => book.read(pageId).raw,
    setRaw: (raw: string) => { book.edit(pageId, raw); refresh(); },
    restoreSession: (raw: string) => { const restored = book.restoreSession(pageId, raw); if (restored) refresh(); return restored; },
    isExternalTarget: (raw: string) => book.isExternalTarget(pageId, raw),
    isUneditedExternal: (raw: string) => book.isUneditedExternal(pageId, raw),
    setExternalRaw: (raw: string) => { if (book.isUneditedExternal(pageId, raw)) refresh(); },
  };
}
