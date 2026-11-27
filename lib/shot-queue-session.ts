import type { ShotQueue } from "./shot-queue.ts";
import type { RunRecord } from "./production-records.ts";
import { H3_NEW_NODE_WIDTH, H3_NEW_NODE_HEIGHT } from "./h3-node-layout-policy.ts";
import type { QueueFrameInput } from './shot-queue-frames.ts';

export type QueueEntry = {
  execution?:import('./queue-entry-state.ts').EntryExecution;
  rerun?:{requestId:string;previousRunId:string;requestedAt:number};
  cancelRequestedAt?: number;
  cancelledAt?: number;
  /** User deletion cancels this entry permanently; undo restores shapes, not GPU jobs. */
  removedAt?: number;
  chapter: number; shot: number; nodeId?: string; error?: string;
  outcome?: "failed" | "uncertain";
  /** Persist started BEFORE enqueue: a closed tab cannot erase the uncertain acceptance window. */
  submissionState?: "pending" | "started" | "accepted";
  waitingReason?: string;
  /** Manual 入队 chose「跳过」: this entry adopted an existing same-title, same-prompt node instead of creating one. */
  reusedNode?: "done" | "busy";
  /** Frozen source Run/Asset and decoded inputs. Resume cannot silently choose a newer candidate. */
  /** first / last plus 🧪 `anchor:N` time-anchor frames, each frozen once extracted. */
  frameInputs?: {first?: QueueFrameInput; last?: QueueFrameInput} & {[edge: `anchor:${number}`]: QueueFrameInput | undefined};
  frameToken?: string;
};
export type QueueSession = { version: 1; revision?:number; id: string; pageId: string; queue: ShotQueue; entries: QueueEntry[]; origin: { x: number; y: number }; autoContinueFrames?: boolean; stoppedAt?: number; stopReason?:string; stopSource?:'root_stopSessions';
  /** 正本版本号，入队时读一次（读不到是「未知」），写进这批每个节点和 Run。不放进 queue 本身：会话靠 queue 的 JSON 比对认队列。 */
  zhengbenVersion?: string };
export const queueSessionKey = (pageId: string) => `shot-queue-session-v1:${pageId}`;
export const queueRowKey = (entry: QueueEntry) => `${entry.chapter}:${entry.shot}`;
export const QUEUE_ROW_LIMIT = 10;
export const QUEUE_GAP_X = 100;
export const QUEUE_GAP_Y = 300;
export type QueueNodeLayout = {
  chapter: number;
  shot: number;
  chapterSizes: readonly number[];
  perRow?: number;
  height?: number;
  gapX?: number;
  gapY?: number;
};
// Position only newly created cards; persisted nodes are never re-laid out on resume.
export const queueNodePosition = (
  origin: { x: number; y: number },
  index: number,
  width = H3_NEW_NODE_WIDTH,
  layout?: QueueNodeLayout,
) => {
  const perRow = Math.max(1, layout?.perRow ?? QUEUE_ROW_LIMIT);
  const gapX = layout?.gapX ?? QUEUE_GAP_X;
  const height = layout?.height ?? H3_NEW_NODE_HEIGHT;
  const gapY = layout?.gapY ?? QUEUE_GAP_Y;
  const rowStep = height + gapY;
  if (layout) {
    let baseRow = 0;
    for (let c = 0; c < layout.chapter; c++) {
      const count = layout.chapterSizes[c] ?? 0;
      if (count > 0) baseRow += Math.ceil(count / perRow) + 1;
    }
    const col = layout.shot % perRow;
    const row = baseRow + Math.floor(layout.shot / perRow);
    return { x: origin.x + col * (width + gapX), y: origin.y + row * rowStep };
  }
  const col = index % perRow;
  const row = Math.floor(index / perRow);
  return { x: origin.x + col * (width + gapX), y: origin.y + row * rowStep };
};
export function latestQueueRun(entry: QueueEntry, runs: readonly RunRecord[]) {
  if (!entry.nodeId) return undefined;
  return runs.filter(run => run.ownerNodeId === entry.nodeId).sort((a, b) => b.createdAt - a.createdAt)[0];
}
export function queueEntryUncertain(entry: QueueEntry, runs: readonly RunRecord[]) {
  if (entry.removedAt || entry.cancelledAt) return false;
  const run = latestQueueRun(entry, runs);
  if (run && ["running", "completed"].includes(run.status)) return false;
  if (run?.status === "queued") return run.submission === "reserved";
  return entry.outcome === "uncertain" || entry.submissionState === "started" || (!run && (entry.submissionState === "accepted" || (!!entry.nodeId && entry.submissionState === undefined && entry.outcome === undefined)));
}
/** Legacy errors/unknown prebuilt nodes are not proof of non-submission. Never auto-retry them. */
export function maySubmitQueueEntry(entry: QueueEntry, runs: readonly RunRecord[], retryOnly = false) {
  if (entry.removedAt || entry.cancelRequestedAt || entry.cancelledAt) return false;
  const run = latestQueueRun(entry, runs);
  if(entry.rerun&&run?.runId===entry.rerun.previousRunId&&['completed','failed'].includes(run.status)&&entry.submissionState==='pending')return true;
  if(run?.error?.startsWith('已核实丢失：')&&!run.preparationNotSent)return false;
  if (run && run.status !== "failed") return false;
  if (entry.outcome === "uncertain" || entry.submissionState === "started" || entry.submissionState === "accepted") return false;
  if (retryOnly) return entry.outcome === "failed";
  if (entry.outcome === "failed") return true;
  if (run || entry.error) return false;
  return entry.submissionState === "pending" || !entry.nodeId;
}
export function newQueueSession(pageId: string, queue: ShotQueue, origin: { x: number; y: number }): QueueSession {
  return { version: 1, id: crypto.randomUUID(), pageId, queue: structuredClone(queue), origin, autoContinueFrames:true,
    entries: queue.chapters.flatMap((chapter, chapterIndex) => chapter.shots.map((_, shot) => ({ chapter: chapterIndex, shot, submissionState: "pending" as const }))) };
}

type PowerLossProbe = { state: string; error?: string };
/**
 * Explicit「继续未完成」only: after power loss / Comfy restart, ghost running runs and
 * accepted/started entries block resubmit forever. Heal only when Comfy confirms the job is gone
 * or the local run is already terminal. Never touch completed outputs or live queue/running jobs.
 */
export async function healPowerLossQueueEntries(
  batch: QueueSession,
  runs: readonly RunRecord[],
  deps: {
    probe: (run: RunRecord) => Promise<PowerLossProbe>;
    failRun: (run: RunRecord, error: string) => Promise<void>;
  },
) {
  let healed = 0;
  for (const entry of batch.entries) {
    if (entry.removedAt || entry.cancelledAt || entry.cancelRequestedAt) continue;
    const run = latestQueueRun(entry, runs);
    const stuckEntry = entry.outcome === "uncertain" || entry.submissionState === "started" || entry.submissionState === "accepted";
    if (!run) {
      if (!stuckEntry) continue;
      entry.outcome = "uncertain";
      entry.error = entry.error ?? "没有原Run，无法证明未提交；保留核实，不自动重提";
      continue;
    }
    if (run.status === "completed" || run.status === "cancelled") continue;
    if(run.error?.startsWith("已核实丢失：")&&!run.preparationNotSent)continue;
    if (run.status === "failed") {
      if (!stuckEntry && entry.outcome === "failed" && entry.submissionState === "pending") continue;
      if (!stuckEntry && entry.outcome === "failed") {
        entry.submissionState = "pending";
        healed++;
        continue;
      }
      if (stuckEntry) {
        entry.outcome = "failed";
        entry.submissionState = "pending";
        entry.error = run.error ?? "原任务已结束，用户继续未完成时允许重提";
        healed++;
      }
      continue;
    }
    if (!run.comfyPromptId) {
      entry.outcome = "uncertain";entry.error = "缺少原promptId，无法核实；不会自动重提";continue;
    }
    const probe = await deps.probe(run);
    if (probe.state === "queued" || probe.state === "running" || probe.state === "completed") continue;
    if (probe.state !== "not_found" && probe.state !== "failed") continue;
    if(probe.state==='not_found')continue; // Missing/pruned history never grants retry permission.
    const error = probe.state === "failed"
      ? (probe.error ?? "ComfyUI 确认原任务失败")
      : "断电/重启后 ComfyUI 队列与历史中找不到原任务，用户继续未完成时按失败重提";
    await deps.failRun(run, error);
    entry.outcome = "failed";
    entry.submissionState = "pending";
    entry.error = error;
    healed++;
  }
  return healed;
}
