import type { Editor, TLShapeId } from 'tldraw';
import { deleteWithRestore } from './canvas-delete-undo.ts';
import { requestNodeDeletion,recycleUnsharedNodeMedia } from './media-trash-client.ts';
import { updateRun } from './production-records.ts';
import { inspectNodeRemoval, removalShapes, removalFingerprint, type RemovalRefusal } from './node-removal-guard.ts';
import { cancelTasksBeforeNodeRemoval } from './node-removal-cancel.ts';
export type DeleteIntent = 'cancel-and-recycle' | 'canvas-only' | 'canvas-and-media';
export type DeleteOutcome = RemovalRefusal | { ok: true; undo?: () => boolean; commitRecycle?: () => Promise<string | void>; dialogOpened?: boolean; message?: string };

/** The single line shown after a delete: what happened to the files, in plain words.
 * Kept files are counted once each, under their highest-priority reason (order below). Self-contained on purpose:
 * tests run this body in isolation, so reason texts are matched by keyword instead of importing TRASH_REASON. */
export function deleteSummary(nodes: number, r: { recycled: string[]; browserCopies: string[]; kept: { assetId: string; reasons?: string[] }[] }, error = '') {
  const originals = r.recycled.length - r.browserCopies.length;
  const parts = [`已删除 ${nodes} 个节点`];
  if (originals > 0) parts.push(`${originals} 份原文件已进 Windows 回收站`);
  if (r.browserCopies.length) parts.push(`${r.browserCopies.length} 份没找到磁盘原文件（只清了画布里的副本）`);
  if (r.kept.length) {
    const categories: [string, string][] = [
      ['角色', '角色在用'], ['已采用', '是已采用版本'], ['其他节点', '其他节点在用'], ['其他画布的素材库', '其他画布素材库在用'],
      ['未完成的队列', '未完成的队列在用'], ['未结束的生成任务', '未结束的生成任务在用'], ['成片序列', '成片序列或导演资料在用'],
      ['衍生素材', '其他衍生素材在用'], ['同一生成任务', '与同任务其他素材共用原文件'], ['尚未结清', '生成记录未结清'], ['不支持', '存储来源不支持回收'],
    ];
    const counts = new Map<string, number>();
    for (const row of r.kept) {
      const reasons = row.reasons ?? [];
      if (!reasons.length) continue;
      const label = categories.find(([keyword]) => reasons.some(reason => reason.includes(keyword)))?.[1] ?? '其他原因';
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const order = [...categories.map(([, label]) => label), '其他原因'];
    const detail = [...counts].sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0])).map(([label, count]) => `${count} 份${label}`).join('，');
    parts.push(`${r.kept.length} 份保留${detail ? `（${detail}）` : ''}`);
  }
  if (!r.recycled.length && !r.kept.length && !error) parts.push('这个节点没有登记生成素材，没有删除文件');
  return parts.join('，') + '。' + (error ? `（${error}）` : '');
}

/** User delete is authoritative: nodes always leave the canvas except locked/missing. Cancel + recycle are best-effort. */
export async function safeDeleteNodes(editor: Editor, ids: readonly TLShapeId[], intent: DeleteIntent='cancel-and-recycle', confirmationKey?: string): Promise<DeleteOutcome> {
  let release: (()=>void)|undefined;
  const notes: string[] = [];
  try {
  try { release=await cancelTasksBeforeNodeRemoval(editor,ids); }
  catch (cause) { notes.push('取消未完全确认：'+(cause instanceof Error?cause.message:String(cause))); }

  const shapes = removalShapes(editor, ids);
  if (!shapes.length || ids.some(id => !shapes.some(s => s.id === id)) || shapes.some(s => s.isLocked)) {
    return { ok: false, reason: 'blocked', message: '节点不存在或被锁定，未删除' };
  }
  if (shapes.some(s => s.parentId !== editor.getCurrentPageId() && !shapes.some(p => p.id === s.parentId))) {
    return { ok: false, reason: 'blocked', message: '节点不在当前画布，未删除' };
  }

  let checked = await inspectNodeRemoval(editor, ids, confirmationKey);
  if (!checked.ok) {
    if (checked.reason === 'blocked') return checked;
    notes.push(checked.message);
    checked = { ok: true, ids: shapes.map(s => s.id), fingerprint: removalFingerprint(editor, ids), abandonedRunIds: [] };
  }
  if (intent === 'canvas-and-media') { requestNodeDeletion(checked.ids); return { ok: true, dialogOpened: true }; }
  for (const runId of checked.abandonedRunIds) await updateRun(runId, { status: 'cancelled', completedAt: Date.now(), error: '用户确认移除，未核实 ComfyUI 历史' });

  if(intent==='cancel-and-recycle'){
    const detachedShapes = [...shapes];
    const rawUndo = deleteWithRestore(editor, checked.ids);
    let undone = false;
    let committed = false;
    const undo = () => {
      const restored = rawUndo();
      if (restored) undone = true;
      return restored;
    };
    const commitRecycle = async () => {
      if (undone || committed) return;
      committed = true;
      let recycled={removableIds:checked.ids,recycled:[] as string[],browserCopies:[] as string[],kept:[] as {assetId:string;reasons:string[]}[],failures:[] as {assetId:string;error:string}[]};
      try { recycled=await recycleUnsharedNodeMedia(editor,checked.ids,detachedShapes); }
      catch (cause) { recycled.failures=[{assetId:'',error:cause instanceof Error?cause.message:String(cause)}]; }
      const error=[...recycled.failures.map(row=>row.error),...notes].filter(Boolean).join('；');
      return deleteSummary(checked.ids.length,recycled,error);
    };
    const suffix = notes.length ? `（${notes.join('；')}）` : '';
    return { ok: true, undo, commitRecycle, message: `已删除 ${checked.ids.length} 个节点（撤销窗口结束后再回收未共用原文件）${suffix}` };
  }
  const suffix=notes.length?`（${notes.join('；')}）`:'';
  return { ok: true, undo: deleteWithRestore(editor, checked.ids), message: `已删除 ${checked.ids.length} 个节点${suffix}` };
  } catch(cause) {
    // Last resort: still remove what is on the current page if shapes still exist.
    const fallback=removalShapes(editor,ids).filter(s=>!s.isLocked).map(s=>s.id);
    if(fallback.length){
      const note=cause instanceof Error?cause.message:String(cause);
      return {ok:true,undo:deleteWithRestore(editor,fallback),message:`已删除 ${fallback.length} 个节点（强制删除；${note}）`};
    }
    return {ok:false,reason:'uncertain',message:'取消并删除未完成：'+(cause instanceof Error?cause.message:String(cause))};
  }
  finally {release?.();}
}
