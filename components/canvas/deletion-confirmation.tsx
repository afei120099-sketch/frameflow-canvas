'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor, TLShapeId } from 'tldraw';
import { safeDeleteNodes,type DeleteIntent } from '@/lib/safe-delete';
import { offerDeleteUndo } from '@/lib/canvas-delete-events';
type Request = { ids: TLShapeId[]; confirmationKey: string; message: string;intent?:DeleteIntent };
export function DeletionConfirmation({ editor }: { editor: Editor }) {
  const [request, setRequest] = useState<Request | null>(null), [armed, setArmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const receive = (event: Event) => { setRequest((event as CustomEvent<Request>).detail); setArmed(false); setError(''); };
    window.addEventListener('canvas-delete-unconfirmed', receive);
    return () => window.removeEventListener('canvas-delete-unconfirmed', receive);
  }, []);
  useEffect(() => {
    if (!request) return;
    const key = (event: KeyboardEvent) => { event.stopImmediatePropagation(); if (event.key === 'Escape' && !busy) setRequest(null); if (['Escape', 'Delete', 'Backspace'].includes(event.key) || event.ctrlKey || event.metaKey) event.preventDefault(); };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [request, busy]);
  if (!request) return null;
  const confirm = async () => {
    if (!armed || busy) return;
    setBusy(true);
    try {
      // Unknown-history confirmation is still a node-only escape hatch: it
      // must never be used as evidence authorizing an unverified file recycle.
      const result = await safeDeleteNodes(editor, request.ids, 'canvas-only', request.confirmationKey);
      if (result.ok) { if (result.undo) offerDeleteUndo(result.undo, result.message); setRequest(null); }
      else { setError(result.message); setArmed(false); if (result.canForce && result.confirmationKey) setRequest({ ...request, confirmationKey: result.confirmationKey }); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '删除失败，节点保留'); }
    finally { setBusy(false); }
  };
  return createPortal(<div className="media-trash-backdrop" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}><section className="media-trash-dialog" role="dialog" aria-modal="true" aria-label="确认放弃不明任务恢复">
    <h2>原任务状态不明</h2><p>{request.message}</p><p>此操作只移除画布节点，保留所有素材文件；不会停止、重新提交或重试任何后台任务。请确认后台工作确已结束。</p>
    {error && <p role="alert">{error}</p>}<footer><button autoFocus disabled={busy} onClick={() => setRequest(null)}>保留节点，返回核实</button>{!armed ? <button disabled={busy} onClick={() => setArmed(true)}>我已核实，放弃恢复原任务</button> : <button disabled={busy} onClick={() => void confirm()}>{busy ? '重新核实中…' : '再次确认：仅删除节点'}</button>}</footer>
  </section></div>, document.body);
}
