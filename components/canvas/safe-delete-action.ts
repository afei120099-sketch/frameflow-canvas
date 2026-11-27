import type { Editor, TLShapeId } from 'tldraw';
import { safeDeleteNodes, type DeleteIntent } from '@/lib/safe-delete';
import { offerDeleteUndo } from '@/lib/canvas-delete-events';
import { showCanvasToast } from './canvas-events';
/** A separate, explicit confirmation panel is opened for unresolved history; never window.confirm twice. */
export function deleteCanvasNodes(editor: Editor, ids: readonly TLShapeId[], intent: DeleteIntent = 'cancel-and-recycle') {
  showCanvasToast('正在删除节点；同时尽量取消关联任务…');
  void safeDeleteNodes(editor, ids, intent).then(result => {
    // One toast: clear the "正在删除…" line, then show the outcome with its 撤销 button.
    if (result.ok) { if (result.undo) { showCanvasToast(''); offerDeleteUndo(result.undo, result.message, result.commitRecycle); } else if (result.message) showCanvasToast(result.message); }
    else if (result.canForce && result.confirmationKey) window.dispatchEvent(new CustomEvent('canvas-delete-unconfirmed', { detail: { ids: [...ids], intent, confirmationKey: result.confirmationKey, message: result.message } }));
    else showCanvasToast(result.message);
  }).catch(cause => showCanvasToast('删除未完成：' + (cause instanceof Error ? cause.message : String(cause))));
}
