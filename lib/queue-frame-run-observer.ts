import type {RunRecord} from './production-records.ts';
import {ComfyConnectionError} from './ai-adapter.ts';

export type QueueFrameRunObservation = 'queued' | 'running' | 'completed' | 'failed' | 'not_found' | 'checking' | 'waiting_connection' | 'unconfirmed';
type Probe = (run: RunRecord) => Promise<{state: 'queued' | 'running' | 'completed' | 'failed' | 'not_found'}>;

/** Read-only, per-controller observations of the ORIGINAL prompt ID. Elapsed time
 * is only a polling throttle, never evidence that a queued/running job failed.
 * Two consecutive successful queue/history misses are required; a network error
 * is not a miss. The normal Run watcher remains responsible for saving outputs.
 */
export function createQueueFrameRunObserver(probe: Probe, {now = Date.now, pollMs = 5000}: {now?: () => number; pollMs?: number} = {}) {
  const cache = new Map<string, {at: number; state: QueueFrameRunObservation; misses: number}>();
  return async (run: RunRecord): Promise<QueueFrameRunObservation> => {
    if (run.status === 'cancelled' || run.status === 'failed') return 'failed';
    if (!run.comfyPromptId || run.submission === 'reserved') return 'unconfirmed';
    const key = `${run.runId}:${run.comfyPromptId}`;
    const previous = cache.get(key);
    if (previous && now() - previous.at < pollMs) return previous.state;
    let state: QueueFrameRunObservation;
    let misses = 0;
    try {
      const result = await probe(run);
      if (result.state === 'not_found') {
        misses = (previous?.misses ?? 0) + 1;
        state = misses >= 2 ? 'not_found' : 'checking';
      } else state = result.state;
    } catch (cause) {
      // Parse/HTTP/programming failures must still reach the existing fail-closed
      // path. Only a real transport outage is a reconnectable waiting state.
      if (!(cause instanceof ComfyConnectionError)) throw cause;
      state = 'waiting_connection';
    }
    cache.set(key, {at: now(), state, misses});
    return state;
  };
}
