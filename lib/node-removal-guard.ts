import type { Editor, TLShapeId } from 'tldraw';
import { getMeta, listRuns, type RunRecord } from './production-records.ts';
import { isNodeClaimed, saveNodeForRun } from './run-recovery.ts';
import { hasNodeTask } from './node-task-activity.ts';
import { probeRemovalTask, probeVoiceDesignRemoval, type RemovalTaskState } from './node-task-probe.ts';
import { coverKey, type CoverDoc } from './cover-model.ts';

export type RemovalRefusal = { ok: false; reason: 'busy' | 'queued' | 'uncertain' | 'has-result' | 'blocked'; message: string; confirmationKey?: string; canForce?: boolean };
export type RemovalAllowed = { ok: true; ids: TLShapeId[]; fingerprint: string; abandonedRunIds: string[] };
export type RemovalDependencies = {
  runs: () => Promise<RunRecord[]>;
  cover: (id: string) => Promise<CoverDoc | null>;
  busy: (id: string) => boolean;
  probe: typeof probeRemovalTask;
  voice: typeof probeVoiceDesignRemoval;
};
export const nodeRemovalBusy = (id: string) => hasNodeTask(id) || isNodeClaimed(id);
const defaults: RemovalDependencies = { runs: listRuns, cover: id => getMeta<CoverDoc>(coverKey(id)), busy: nodeRemovalBusy, probe: probeRemovalTask, voice: probeVoiceDesignRemoval };
export function removalShapes(editor: Editor, ids: readonly TLShapeId[]) {
  const shapes = editor.store.allRecords().filter(record => record.typeName === 'shape');
  const selected = new Set<string>(ids);
  let changed = true;
  while (changed) { changed = false; for (const shape of shapes) if (selected.has(shape.parentId) && !selected.has(shape.id)) { selected.add(shape.id); changed = true; } }
  return shapes.filter(shape => selected.has(shape.id)).sort((a, b) => a.id.localeCompare(b.id));
}
export const removalFingerprint = (editor: Editor, ids: readonly TLShapeId[]) => JSON.stringify({ pageId: editor.getCurrentPageId(), shapes: removalShapes(editor, ids) });
const deny = (reason: RemovalRefusal['reason'], message: string): RemovalRefusal => ({ ok: false, reason, message });
const activeRuns = (runs: RunRecord[], ids: Set<string>) => runs.filter(run => !!run.ownerNodeId && ids.has(run.ownerNodeId) && ['queued', 'running'].includes(run.status)).sort((a, b) => a.runId.localeCompare(b.runId));

/** Inspect every selected descendant before any shape or file mutation. */
export async function inspectNodeRemoval(editor: Editor, requested: readonly TLShapeId[], confirmationKey?: string, deps: RemovalDependencies = defaults): Promise<RemovalAllowed | RemovalRefusal> {
  try {
    const ids = [...new Set(requested)], shapes = removalShapes(editor, ids), fingerprint = removalFingerprint(editor, ids);
    if (!ids.length || ids.some(id => !shapes.some(shape => shape.id === id)) || shapes.some(shape => shape.isLocked || shape.parentId !== editor.getCurrentPageId() && !shapes.some(parent => parent.id === shape.parentId))) return deny('blocked', '节点不存在、被锁定或不在当前画布，未删除');
    if (shapes.some(shape => deps.busy(shape.id))) return deny('busy', '节点仍有本地任务，请先在节点上结束或等待完成');
    const owned = new Set(shapes.map(shape => shape.id)), runs = activeRuns(await deps.runs(), owned);
    const runSnapshot = JSON.stringify(runs), coverSnapshots: unknown[] = [], uncertain: string[] = [], abandonedRunIds: string[] = [];
    const observed = new Map<string, RemovalTaskState>();
    const inspect = async (promptId: string, kind: 'image' | 'audio' | 'video', saveId?: string) => {
      const key = JSON.stringify([promptId, kind, saveId]);
      let state = observed.get(key);
      if (!state) { state = await deps.probe(promptId, kind, saveId); if (state === 'not_found') state = await deps.probe(promptId, kind, saveId); observed.set(key, state); }
      return state;
    };
    const refusal = (state: RemovalTaskState): RemovalRefusal | undefined => {
      if (state === 'queued') return deny('queued', '任务仍在后台排队，请先在节点上取消');
      if (state === 'running') return deny('busy', '任务正在执行，请先等待完成或在节点上取消');
      if (state === 'completed') return deny('has-result', '任务已有结果，请先在节点上恢复结果，再移除节点');
      if (state === 'uncertain') return deny('uncertain', '无法可靠核实任务或输出，请先在节点上查询；未删除');
    };
    for (const run of runs) {
      if (!run.comfyPromptId) return deny('uncertain', '存在未核实的提交，请先在节点上查询或放弃任务');
      const state = await inspect(run.comfyPromptId, run.capabilityId === 'cover_generation' ? 'image' : 'video', run.capabilityId === 'cover_generation' ? undefined : saveNodeForRun(run));
      const blocked = refusal(state); if (blocked) return blocked;
      if (state === 'not_found') {
        if (run.submission === 'reserved' || /待确认|unconfirmed|uncertain|结果不明/i.test(run.error ?? '')) return deny('uncertain', '提交结果不明，请先查询原任务；不会因历史暂时找不到就删除');
        if (run.startedAt || run.executionTiming?.startedAt || run.status === 'running') { uncertain.push(run.runId); abandonedRunIds.push(run.runId); }
      }
    }
    for (const shape of shapes) {
      const props = shape.props as Record<string, unknown>;
      if (shape.type === 'tts-node' && typeof props.pendingDesignId === 'string' && props.pendingDesignId) {
        const state = await deps.voice(props.pendingDesignId), blocked = refusal(state); if (blocked) return blocked;
        if (state !== 'failed') return deny('uncertain', '无法核实AI音色设计任务，请先在节点上查询');
      }
      if (['tts-node', 'flux-image-node', 'music-node', 'audio-video-node'].includes(shape.type) && typeof props.pendingId === 'string' && props.pendingId) {
        const kind = shape.type === 'flux-image-node' ? 'image' : shape.type === 'audio-video-node' ? 'video' : 'audio';
        const saveId = shape.type === 'flux-image-node' ? '7' : shape.type === 'tts-node' ? '4' : shape.type === 'music-node' ? '9' : '16';
        const state = await inspect(props.pendingId, kind, saveId), blocked = refusal(state); if (blocked) return blocked;
        if (state === 'not_found') uncertain.push(shape.id + ':' + props.pendingId);
      }
      if (shape.type === 'cover-node' && typeof props.docId === 'string' && props.docId) {
        const doc = await deps.cover(props.docId); coverSnapshots.push([props.docId, doc]);
        if (doc && doc.ownerNodeId !== shape.id) return deny('uncertain', '封面归属尚未核实，请先打开封面节点');
        if (doc?.work) {
          if (!doc.work.pendingId) return deny('uncertain', '封面仍有CPU处理或未结束的工作记录，请先在节点上核实');
          const state = await inspect(doc.work.pendingId, 'image'), blocked = refusal(state); if (blocked) return blocked;
          if (state === 'not_found') uncertain.push(shape.id + ':' + doc.work.pendingId);
        }
      }
    }
    if (removalFingerprint(editor, ids) !== fingerprint || shapes.some(shape => deps.busy(shape.id)) || JSON.stringify(activeRuns(await deps.runs(), owned)) !== runSnapshot) return deny('uncertain', '核实期间节点或任务发生变化，请重新检查后删除');
    for (const snapshot of coverSnapshots) { const [id, doc] = snapshot as [string, CoverDoc | null]; if (JSON.stringify(await deps.cover(id)) !== JSON.stringify(doc)) return deny('uncertain', '封面工作记录已变化，未删除'); }
    if (uncertain.length) {
      const key = JSON.stringify({ fingerprint, runs, covers: coverSnapshots, uncertain });
      if (confirmationKey !== key) return { ok: false, reason: 'uncertain', canForce: true, confirmationKey: key, message: '队列和历史均找不到原任务，不能证明它未执行过。请先核实结果；只有确认任务已结束并放弃恢复，才可再次确认删除节点。' };
    }
    return { ok: true, ids: shapes.map(shape => shape.id), fingerprint, abandonedRunIds };
  } catch (cause) { return deny('uncertain', '无法核实任务状态，未删除：' + (cause instanceof Error ? cause.message : String(cause))); }
}
