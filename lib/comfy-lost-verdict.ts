import type { RunRecord } from './production-records.ts';
import { queueFramePlan } from './shot-queue-frames.ts';
import { latestQueueRun, queueRowKey, type QueueSession } from './shot-queue-session.ts';

/** Counted only while ComfyUI answers. A connection error is not a miss and must not advance this. */
export const COMFY_LOST_MIN_MISSES = 3;
export const COMFY_LOST_MIN_GAP_MS = 10_000;
export const VERIFIED_COMFY_LOSS_ERROR = '已核实丢失：ComfyUI 可达，该 promptId 连续至少 3 次、每次间隔不少于 10 秒，既不在队列也不在历史中；提交状态待确认，禁止仅凭历史缺失重提';
const RELEASABLE_SOURCE_ERRORS = ['原任务在队列与历史中无法确认', '来源任务状态不明'];

export type ComfyLostStreak = { promptId: string; misses: number; lastAt: number; verified: boolean };
export type ComfyLostObservation = 'not_found' | 'present';

export function isVerifiedComfyLoss(run: { status?: string; error?: string | null }) {
  return run.status === 'failed' && typeof run.error === 'string' && run.error.startsWith('已核实丢失：');
}

/** Submit-time connection failures, including the legacy preparation wording. */
export function isComfyConnectionFailure(error?: string | null) {
  return typeof error === 'string' && (error.includes('无法连接本地 ComfyUI') || error.includes('ComfyUI 未启动或无法连接'));
}

export const VERIFIED_CONNECTION_LOSS_ERROR = '已核实丢失：无法连接本地 ComfyUI 之后已恢复可达，该 promptId 连续至少 3 次、每次间隔不少于 10 秒，既不在队列也不在历史中；提交状态待确认，禁止仅凭历史缺失重提';

export function verifiedLossError(previous?: string | null) {
  return isComfyConnectionFailure(previous) ? VERIFIED_CONNECTION_LOSS_ERROR : VERIFIED_COMFY_LOSS_ERROR;
}

/**
 * History `failed` is the normal auto-retry. A connection failure becomes eligible only after the
 * same 3-miss verdict, and only while that verdict text still records the connection cause.
 * Queued, running, and ordinary not_found prompts stay closed.
 */
export function autoRetryAcceptsProbe(run: { status?: string; error?: string | null } | undefined, probeState: string) {
  if (!run || run.status !== 'failed') return false;
  if (probeState === 'failed') return true;
  return false;
}

/**
 * `present` (queue, history, success, or a real failure) clears the streak.
 * `not_found` counts only when this sample is at least `gapMs` after the previous counted miss.
 */
export function nextComfyLostStreak(previous: ComfyLostStreak | null | undefined, promptId: string, observation: ComfyLostObservation, at: number, gapMs = COMFY_LOST_MIN_GAP_MS, minMisses = COMFY_LOST_MIN_MISSES): ComfyLostStreak {
  if (!promptId || observation === 'present') return { promptId, misses: 0, lastAt: at, verified: false };
  const same = previous?.promptId === promptId ? previous : undefined;
  if (same?.verified) return same;
  if (same && at - same.lastAt < gapMs) return same;
  const misses = (same?.misses ?? 0) + 1;
  return { promptId, misses, lastAt: at, verified: misses >= minMisses };
}

/** A verified-lost prompt is a terminal failure for rerun. Anything still queued or running is not. */
export function rerunProbeAllows(run: { status?: string; error?: string | null } | undefined, probeState: string) {
  if (!run) return false;
  if (probeState === 'queued' || probeState === 'running') return false;
  if (probeState === 'completed' || probeState === 'failed') return true;
  return false;
}

/**
 * Tail-frame shots stuck on "source prompt cannot be found" return to the normal
 * wait → extract → submit path once every source run is terminal. This does not
 * create frame inputs and does not make a continuation runnable without them.
 */
export function releaseSettledSourceContinuations(batch: QueueSession, runs: RunRecord[]) {
  let plan: ReturnType<typeof queueFramePlan>;
  try { plan = queueFramePlan(batch.queue); }
  catch { return 0; }
  let released = 0;
  for (const entry of batch.entries) {
    if (entry.removedAt || entry.cancelledAt || entry.cancelRequestedAt) continue;
    if (entry.outcome !== 'uncertain' || !RELEASABLE_SOURCE_ERRORS.some(text => entry.error?.includes(text))) continue;
    const shot = batch.queue.chapters[entry.chapter]?.shots[entry.shot];
    if (!shot?.firstFrameFrom && !shot?.lastFrameFrom) continue;
    const own = latestQueueRun(entry, runs);
    if (own && (own.status === 'queued' || own.status === 'running' || own.status === 'completed' || isVerifiedComfyLoss(own))) continue;
    const key = queueRowKey(entry);
    let deps: string[];
    try { deps = [shot.firstFrameFrom, shot.lastFrameFrom].filter(source => !!source).map(source => plan.sourceKey(source!, key)); }
    catch { continue; }
    const settled = deps.every(depKey => {
      const source = batch.entries.find(item => queueRowKey(item) === depKey);
      if (!source || source.outcome === 'uncertain') return false;
      const run = latestQueueRun(source, runs);
      if (!run) return source.outcome === 'failed';
      return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
    });
    if (!settled) continue;
    entry.outcome = undefined;
    entry.error = undefined;
    entry.submissionState = 'pending';
    entry.waitingReason = '来源已重新结算，等待截取继承帧后再提交；没有继承首帧不会生成视频';
    released++;
  }
  return released;
}

/**
 * A verified-lost chain shot has no video of its own. Keeping submissionState accepted
 * blocks file resume forever after the original rerun receipt was consumed.
 * Rearm only shots that inherit a frame, have no output, and whose latest run is the lost one.
 * Queued, running, completed, and in-flight started rows stay untouched. No prompt is posted here.
 */
export function rearmVerifiedChainContinuations(_batch: QueueSession, _runs: RunRecord[]) {
  // An empty/pruned history is not proof of non-submission. Explicit retry requires
  // terminal history or persisted evidence that no POST was ever sent.
  return 0;
}
