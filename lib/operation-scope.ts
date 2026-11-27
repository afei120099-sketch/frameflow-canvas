/** A deadline aborts the underlying operation and fences all subsequent side effects. */
export class OperationTimeout extends Error {
    override name = 'OperationTimeout';
}
export type OperationScope = {
    signal: AbortSignal;
    check: () => void;
    close: () => void;
};
export function operationScope(ms: number, parent?: AbortSignal, label = '操作'): OperationScope {
    const controller = new AbortController();
    let closed = false;
    const stop = () => controller.abort(parent?.reason ?? new DOMException('操作已取消', 'AbortError'));
    if (parent?.aborted)
        stop();
    else
        parent?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => controller.abort(new OperationTimeout(label + '超时')), ms);
    return { signal: controller.signal, check() { controller.signal.throwIfAborted(); if (closed)
            throw new DOMException('旧尝试已结束', 'AbortError'); }, close() { if (closed)
            return; closed = true; clearTimeout(timer); parent?.removeEventListener('abort', stop); controller.abort(new DOMException('尝试已结束', 'AbortError')); } };
}
export async function bounded<T>(work: (scope: OperationScope) => Promise<T>, ms: number, parent?: AbortSignal, label?: string): Promise<T> {
    const scope = operationScope(ms, parent, label);
    let abort: () => void = () => { };
    try {
        return await Promise.race([Promise.resolve().then(() => { scope.check(); return work(scope); }), new Promise<never>((_, reject) => { abort = () => reject(scope.signal.reason); scope.signal.addEventListener('abort', abort, { once: true }); if (scope.signal.aborted)
                abort(); })]);
    }
    finally {
        scope.signal.removeEventListener('abort', abort);
        scope.close();
    }
}
/** Keep the deadline alive through headers AND body consumption. */
export function fetchBody<T>(url: string, init: RequestInit, read: (response: Response) => Promise<T>, ms = 12000, request: typeof fetch = fetch, parent?: AbortSignal) {
    return bounded(async (scope) => { const response = await request(url, { ...init, signal: scope.signal }); scope.check(); if (!response.ok)
        throw Error(`HTTP ${response.status}: ${url}`); const value = await read(response); scope.check(); return value; }, ms, parent ?? init.signal ?? undefined, '读取响应');
}
const localLockTails = new Map<string, Promise<unknown>>();
export async function boundedLock<T>(name: string, action: (scope: OperationScope) => Promise<T>, options: {
    signal?: AbortSignal;
    waitMs?: number;
    workMs?: number;
    ifAvailable?: boolean;
} = {}): Promise<T | undefined> {
    const run = () => bounded(action, options.workMs ?? 30000, options.signal, name);
    if (typeof navigator === 'undefined' || !navigator.locks) {
        if (options.ifAvailable && localLockTails.has(name))
            return undefined;
        const previous = localLockTails.get(name) ?? Promise.resolve();
        const turn = bounded(async (waiting) => { await previous.catch(() => { }); waiting.check(); }, options.waitMs ?? 5000, options.signal, name + '锁等待');
        const job = turn.then(run);
        localLockTails.set(name, job);
        try {
            return await job;
        }
        finally {
            if (localLockTails.get(name) === job)
                localLockTails.delete(name);
        }
    }
    if (options.ifAvailable)
        return navigator.locks.request(name, { ifAvailable: true }, lock => lock ? run() : undefined);
    const waiting = operationScope(options.waitMs ?? 5000, options.signal, name + '锁等待');
    try {
        return await navigator.locks.request(name, { signal: waiting.signal }, () => { waiting.close(); return run(); });
    }
    finally {
        waiting.close();
    }
}
/** Reject an overdue IDB operation and abort its transaction before releasing the caller. */
export function idbDeadline<T>(tx: IDBTransaction, work: (resolve: (value: T) => void, reject: (reason: unknown) => void) => void, ms = 15000, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let done = false;
        const finish = (error: unknown, value?: T) => { if (done)
            return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error)
            reject(error);
        else
            resolve(value as T); };
        const abort = () => { try {
            tx.abort();
        }
        catch { } finish(signal?.reason ?? new OperationTimeout('本地事务超时')); };
        const timer = setTimeout(abort, ms);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) {
            abort();
            return;
        }
        try {
            work(value => finish(null, value), error => finish(error));
        }
        catch (error) {
            try {
                tx.abort();
            }
            catch { }
            finish(error);
        }
    });
}
export function armIdbRead(request: IDBRequest, reject: (reason: unknown) => void, ms = 15000) {
    // Legacy in-memory test doubles are not EventTargets; real IDBRequest always is.
    if (typeof request.addEventListener !== 'function')
        return;
    const timer = setTimeout(() => { try {
        request.transaction?.abort();
    }
    catch { } reject(new OperationTimeout('本地读取超时')); }, ms);
    const clear = () => clearTimeout(timer);
    request.addEventListener('success', clear, { once: true });
    request.addEventListener('error', clear, { once: true });
    request.transaction?.addEventListener('abort', () => { clear(); reject(request.transaction?.error ?? Error('本地读取已中止')); }, { once: true });
}
