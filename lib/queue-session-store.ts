import { mutateSessionRows } from './production-records.ts';
import { mergeSessionDelta, SessionConflict } from './queue-entry-state.ts';
import { queueSessionKey, type QueueSession } from './shot-queue-session.ts';
export async function saveSessionDelta(next: QueueSession, before: QueueSession | null, options: {
    signal?: AbortSignal;
    activate?: boolean;
    expectedPageId?: string | null;
    /** 用户明确点「继续未完成」时才传：允许清除停止标记（收件箱 stopSessions 除外）。 */
    explicitResume?: boolean;
} = {}) {
    return mutateSessionRows<QueueSession>(queueSessionKey(next.pageId), 'shot-queue-file-v2:' + next.id, (page, file) => {
        const pageMatch = page?.id === next.id ? page : null;
        const candidates = [pageMatch, file].filter((s): s is QueueSession => !!s);
        const current = candidates.sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0))[0];
        if (current) {
            for (const other of candidates) {
                if (other.stoppedAt && !(options.explicitResume && other.stopSource !== 'root_stopSessions')) {
                    current.stoppedAt = other.stoppedAt;
                    current.autoContinueFrames = false;
                    current.stopReason = other.stopReason;
                    current.stopSource = other.stopSource;
                }
                for (const tomb of other.entries) {
                    const e = current.entries.find(e => e.chapter === tomb.chapter && e.shot === tomb.shot);
                    if (e) {
                        e.removedAt ??= tomb.removedAt;
                        e.cancelledAt ??= tomb.cancelledAt;
                        e.cancelRequestedAt ??= tomb.cancelRequestedAt;
                    }
                }
            }
        }
        let merged: QueueSession;
        if (current) {
            if (!before || before.id !== next.id)
                throw new SessionConflict('缺少原会话版本');
            merged = mergeSessionDelta(current, next, before, { explicitResume: options.explicitResume });
        }
        else {
            if (before?.id === next.id)
                throw new SessionConflict('原会话记录已变化，不自动重建');
            merged = structuredClone(next);
            merged.revision = 1;
        }
        if (page?.id === next.id)
            return { page: merged, file: merged };
        if (options.activate) {
            if (page && options.expectedPageId !== page.id)
                throw new SessionConflict('另一个批次已占用画布页');
            return { page: merged, file: merged };
        }
        return { file: merged };
    }, options.signal);
}
