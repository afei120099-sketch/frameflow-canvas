import { queueRowKey, type QueueSession, type QueueEntry } from './shot-queue-session.ts';
export type EntryPhase = 'accepted_intent' | 'waiting_source' | 'extracting' | 'waiting_hd' | 'ready_to_submit' | 'submitting' | 'queued' | 'completed' | 'blocked' | 'retry_wait';
export type EntryExecution = {
    attemptId: string;
    phase: EntryPhase;
    startedAt: number;
    lastProgressAt: number;
    nextRetryAt?: number;
    leaseUntil: number;
    lockName: string;
    reason?: string;
    requestId?: string;
};
export class SessionConflict extends Error {
    override name = 'SessionConflict';
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Apply ONLY fields changed by this writer, against the transaction's latest entry. */
export type MergeOptions = {
    /** 仅「用户点继续未完成」传入：允许清除停止标记。收件箱 stopSessions 的停止不可清。 */
    explicitResume?: boolean;
};
export function mergeSessionDelta(current: QueueSession, proposed: QueueSession, before: QueueSession, options: MergeOptions = {}): QueueSession {
    const resuming = !!options.explicitResume;
    if (resuming && current.stopSource === 'root_stopSessions' && !proposed.stoppedAt)
        throw new SessionConflict('批次被收件箱 stopSessions 停止，不能由界面恢复');
    const stopClearBlocked = (c: QueueSession, p: QueueSession) => !resuming && !!((c.stoppedAt && !p.stoppedAt) || (c.autoContinueFrames === false && p.autoContinueFrames !== false));
    if (current.id !== proposed.id || before.id !== proposed.id)
        throw new SessionConflict('原会话已变化，拒绝迟到回写');
    const signature = (s: QueueSession) => s.entries.map(e => [e.chapter, e.shot]);
    if (!equal(signature(proposed), signature(before))) {
        // Explicit list edits can reindex entries. Require a full compare-and-swap,
        // never transplant indices onto a concurrently progressing session.
        if (equal(proposed.queue, before.queue) || !equal(current, before))
            throw new SessionConflict('镜头列表发生并发修改，请重新读取原队列');
        return { ...structuredClone(proposed), revision: (current.revision ?? 0) + 1 };
    }
    const result = structuredClone(current);
    for (const next of proposed.entries) {
        const old = before.entries.find(e => queueRowKey(e) === queueRowKey(next));
        const fresh = result.entries.find(e => queueRowKey(e) === queueRowKey(next));
        if (!old || !fresh)
            throw new SessionConflict('原镜头已变化');
        const changed = Object.keys({ ...old, ...next }).filter(k => !equal(old[k as keyof QueueEntry], next[k as keyof QueueEntry]));
        if (!changed.length)
            continue;
        if (stopClearBlocked(current, proposed))
            throw new SessionConflict('批次已停止，拒绝旧尝试回写');
        if (fresh.removedAt || fresh.cancelledAt || fresh.cancelRequestedAt) {
            if (!next.removedAt && !next.cancelledAt && !next.cancelRequestedAt)
                throw new SessionConflict('镜头已删除或取消，旧尝试不能回写');
        }
        if (fresh.execution?.attemptId !== old.execution?.attemptId)
            throw new SessionConflict('attemptId 已变化，旧尝试不能回写');
        for (const key of changed) {
            const k = key as keyof QueueEntry;
            if (!equal(fresh[k], old[k]) && !equal(fresh[k], next[k]))
                throw new SessionConflict('镜头字段发生并发修改：' + key);
            if (next[k] === undefined)
                delete (fresh as unknown as Record<string, unknown>)[key];
            else
                (fresh as unknown as Record<string, unknown>)[key] = structuredClone(next[k]);
        }
    }
    // Stop/deletion decisions are monotonic, even if another writer started earlier.
    for (const key of ['autoContinueFrames', 'stoppedAt', 'stopSource', 'stopReason'] as const) {
        if (equal(proposed[key], before[key]))
            continue;
        if (stopClearBlocked(current, proposed))
            throw new SessionConflict('文件停止标记不可被旧执行器清除');
        if (!equal(current[key], before[key]) && !equal(current[key], proposed[key]))
            throw new SessionConflict('批次控制发生并发修改');
        (result as unknown as Record<string, unknown>)[key] = proposed[key];
    }
    if (!equal(proposed.queue, before.queue)) {
        if (!equal(current.queue, before.queue) && !equal(current.queue, proposed.queue))
            throw new SessionConflict('队列配置发生并发修改');
        result.queue = structuredClone(proposed.queue);
    }
    result.revision = (current.revision ?? 0) + 1;
    return result;
}
export function entryDue(entry: QueueEntry, now = Date.now()) {
    return !(entry.execution && entry.execution.leaseUntil > now) && entry.execution?.phase !== 'blocked' && !entry.removedAt && !entry.cancelledAt && !entry.cancelRequestedAt && (entry.execution?.phase === 'waiting_source' || !entry.execution?.nextRetryAt || entry.execution.nextRetryAt <= now);
}
/** Preserve references held by the current for-of iteration while adopting fresh fields. */
export function adoptSessionSnapshot(target: QueueSession, snapshot: QueueSession) {
    const entries = snapshot.entries.map(next => {
        const existing = target.entries.find(e => queueRowKey(e) === queueRowKey(next));
        if (!existing)
            return structuredClone(next);
        for (const key of Object.keys(existing))
            delete (existing as unknown as Record<string, unknown>)[key];
        Object.assign(existing, structuredClone(next));
        return existing;
    });
    Object.assign(target, snapshot, { entries });
    return target;
}
