"use client";
import { useEffect, useRef, useState } from "react";
import type { Editor } from "tldraw";
import { createPortal } from "react-dom";
import { acquireMediaUrl, releaseMediaUrl } from "@/lib/local-video-store";
import { showCanvasToast } from "./canvas-events";
import { trackImageSlotDragging } from "./slot-drop-feedback";
import {MediaTrashDialog} from './media-trash-dialog';
import {DeletionConfirmation} from './deletion-confirmation';
import {deleteCanvasNodes} from './safe-delete-action';
import {isTypingTarget} from '@/lib/keyboard-guards';
export {offerDeleteUndo} from '@/lib/canvas-delete-events';

export const previewMedia = (src: string, kind: "image" | "video" | "audio", name: string) => window.dispatchEvent(new CustomEvent("canvas-media-preview", { detail: { src, kind, name } }));
export const showDropFeedback = (detail: { x: number; y: number; label: string; valid: boolean } | null) => window.dispatchEvent(new CustomEvent("canvas-drop-feedback", { detail }));

export function CanvasInteractionUI({ editor }: { editor: Editor }) {
  useEffect(() => {
    const cleanupShortcut = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.key !== 'Delete' || event.isComposing || isTypingTarget(event.target) || document.querySelector('[aria-modal="true"]')) return;
      const selected = editor.getSelectedShapeIds(); if (!selected.length || !editor.getContainer().contains(document.activeElement)) return;
      event.preventDefault(); event.stopImmediatePropagation(); deleteCanvasNodes(editor, selected, 'canvas-and-media');
    };
    window.addEventListener('keydown', cleanupShortcut, true); return () => window.removeEventListener('keydown', cleanupShortcut, true);
  }, [editor]);
  useEffect(() => trackImageSlotDragging(editor), [editor]);
  const [undo, setUndo] = useState<{ restore: () => boolean; message?: string; onExpire?: () => Promise<string | void> | void } | null>(null);
  const pendingUndoRef = useRef<{ restore: () => boolean; message?: string; onExpire?: () => Promise<string | void> | void } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [feedback, setFeedback] = useState<{ x: number; y: number; label: string; valid: boolean } | null>(null);
  const [preview, setPreview] = useState<{ src: string; kind: "image" | "video" | "audio"; name: string } | null>(null);
  const [url, setUrl] = useState("");
  const view = useRef<{ camera: ReturnType<Editor["getCamera"]>; selected: ReturnType<Editor["getSelectedShapeIds"]> } | null>(null);
  const close = () => {
    setPreview(null); setUrl("");
    const saved = view.current; view.current = null;
    if (saved && !editor.isDisposed) {
      editor.setCamera(saved.camera);
      editor.select(...saved.selected.filter(id => editor.getShape(id)));
      editor.focus();
    }
  };
  useEffect(() => {
    const flushPending = (offer: { onExpire?: () => Promise<string | void> | void } | null) => {
      if (!offer?.onExpire) return;
      void Promise.resolve(offer.onExpire()).then(summary => {
        if (typeof summary === "string" && summary) showCanvasToast(summary);
      }).catch(() => {});
    };
    const onUndo = (event: Event) => {
      // Older callers dispatched the restore function itself; newer ones send { restore, message, onExpire }.
      const detail = (event as CustomEvent<(() => boolean) | { restore: () => boolean; message?: string; onExpire?: () => Promise<string | void> | void }>).detail;
      const offer = typeof detail === "function" ? { restore: detail } : detail;
      const previous = pendingUndoRef.current;
      pendingUndoRef.current = offer;
      clearTimeout(undoTimerRef.current);
      if (previous && previous !== offer) flushPending(previous);
      setUndo(offer);
      undoTimerRef.current = setTimeout(() => {
        if (pendingUndoRef.current === offer) pendingUndoRef.current = null;
        setUndo(current => (current === offer ? null : current));
        flushPending(offer);
      }, offer.message ? 9000 : 6500);
    };
    const onDrop = (event: Event) => setFeedback((event as CustomEvent).detail);
    const onPreview = (event: Event) => {
      view.current ??= { camera: { ...editor.getCamera() }, selected: [...editor.getSelectedShapeIds()] };
      setUrl(""); setPreview((event as CustomEvent).detail);
    };
    window.addEventListener("canvas-delete-undo", onUndo);
    window.addEventListener("canvas-drop-feedback", onDrop);
    window.addEventListener("canvas-media-preview", onPreview);
    return () => {
      clearTimeout(undoTimerRef.current);
      const leftover = pendingUndoRef.current;
      pendingUndoRef.current = null;
      flushPending(leftover);
      window.removeEventListener("canvas-delete-undo", onUndo);
      window.removeEventListener("canvas-drop-feedback", onDrop);
      window.removeEventListener("canvas-media-preview", onPreview);
    };
  }, [editor]);
  useEffect(() => {
    if (!preview) return;
    let alive = true, owned = "", releaseKey: string | null = null;
    void acquireMediaUrl(preview.src).then(result => {
      if (!alive) { releaseMediaUrl(result.key); if (result.revoke) URL.revokeObjectURL(result.url); return; }
      releaseKey = result.key;
      if (result.revoke) owned = result.url;
      setUrl(result.url);
    }).catch(() => showCanvasToast("预览读取失败，原素材未改动"));
    return () => { alive = false; releaseMediaUrl(releaseKey); if (owned) URL.revokeObjectURL(owned); };
  }, [preview]);
  useEffect(() => {
    if (!preview) return;
    const key = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "Tab") {
        const items = Array.from(document.querySelectorAll<HTMLElement>(".canvas-media-lightbox button, .canvas-media-lightbox video, .canvas-media-lightbox audio"));
        const index = items.indexOf(document.activeElement as HTMLElement);
        event.preventDefault(); items[(index + (event.shiftKey ? items.length - 1 : 1)) % items.length]?.focus();
      } else if (["Delete", "Backspace"].includes(event.key) || (event.ctrlKey && ["z", "y"].includes(event.key.toLowerCase()))) event.preventDefault();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [preview, editor]);
  return <>
    <MediaTrashDialog editor={editor} />
    <DeletionConfirmation editor={editor} />
    {undo && <div className="canvas-undo-toast" role="status"><span>{undo.message ?? "已从画布移除，原文件保留"}</span><button onClick={() => { clearTimeout(undoTimerRef.current); pendingUndoRef.current = null; const hasDeferred = !!undo.onExpire; const ok = undo.restore(); setUndo(null); showCanvasToast(ok ? (hasDeferred ? "已恢复节点，原文件未回收" : "已恢复节点（回收站里的文件需从 Windows 回收站还原）") : "相关内容已修改，未覆盖后续操作"); }}>撤销</button></div>}
    {feedback && createPortal(<div className={`canvas-drop-hint ${feedback.valid ? "is-valid" : "is-invalid"}`} style={{ left: Math.min(feedback.x + 18, window.innerWidth - 260), top: Math.min(feedback.y + 18, window.innerHeight - 48) }} role="status">{feedback.label}</div>, document.body)}
    {preview && createPortal(<div className="canvas-media-lightbox" role="dialog" aria-modal="true" aria-label={preview.name} onPointerDown={event => event.stopPropagation()} onClick={event => { if (event.target === event.currentTarget) close(); }}><header><span>{preview.name}</span><button autoFocus onClick={close} aria-label="关闭预览并返回画布">关闭 · Esc</button></header>{url ? preview.kind === "image" ? <img src={url} alt={preview.name} /> : preview.kind === "audio" ? <audio src={url} controls preload="metadata" /> : <video src={url} controls playsInline preload="metadata" /> : <span>正在读取预览…</span>}</div>, document.body)}
  </>;
}
