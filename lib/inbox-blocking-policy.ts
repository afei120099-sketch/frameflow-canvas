import type { RunRecord } from './production-records.ts';
import type { QueueSession } from './shot-queue-session.ts';
import { latestQueueRun, queueEntryUncertain } from './shot-queue-session.ts';

type Receipt = {result:string;sessionId?:string;pageId?:string;details?:Record<string,unknown>};
/** Page slot still has work that a new handoff would archive. Completed runs do not count. */
export function pageSlotHasWork(slot: QueueSession | undefined, runs: readonly RunRecord[]) {
  if (!slot || slot.stoppedAt || slot.autoContinueFrames !== true) return false;
  return slot.entries.some(entry => {
    if (entry.removedAt || entry.cancelledAt || entry.cancelRequestedAt) return false;
    const run = latestQueueRun(entry, runs);
    if (run && (run.status === 'queued' || run.status === 'running')) return true;
    if (queueEntryUncertain(entry, runs)) return true;
    if (entry.waitingReason) return true;
    if (!run && !entry.outcome && entry.submissionState === 'pending') return true;
    return false;
  });
}
/** Scheduling only: does not cancel, resume, delete or rewrite a historical receipt. */
export function inboxReceiptBlocks(receipt:Receipt, sourcePresent:boolean, protectedQueue:boolean, sessions:readonly QueueSession[], runs:RunRecord[]) {
  if (!['awaiting_session','preparing','session_created','submitting','running','submitted','blocked'].includes(receipt.result)) return false;
  // A page-session handshake with no sessionId is not a GPU owner. Keep observing it,
  // but do not park later queues behind confirmationPending / background-tab delay.
  if (receipt.result==='awaiting_session' && !receipt.sessionId) return false;
  const session = sessions.find(s=>s.id===receipt.sessionId && s.pageId===receipt.pageId);
  // File-registry session that no longer owns the page slot. Its accepted Run stays in Comfy.
  // Later inbox files may line up; the scheduler must not hand them onto a busy page slot.
  if (receipt.details?.pageSlotDisplaced === true && !session) return false;
  if (session?.entries.some(entry=>{
    const run=latestQueueRun(entry,runs);
    return !!run && ['running','queued'].includes(run.status) || queueEntryUncertain(entry,runs);
  })) return true;
  // Keep a cached original owner visible even after its session moved out of the page slot.
  const shots=Array.isArray(receipt.details?.shots)?receipt.details.shots as {nodeId?:string;promptId?:string;state?:string}[]:[];
  if (shots.some(shot=>{
    const owned=runs.filter(run=>!!shot.nodeId&&run.ownerNodeId===shot.nodeId || !!shot.promptId&&run.comfyPromptId===shot.promptId);
    if(owned.some(run=>['running','queued'].includes(run.status)))return true;
    return !owned.length && ['uncertain','unconfirmed','queued','running','started','accepted','submitting'].includes(shot.state??'');
  })) return true;
  if (receipt.result==='blocked' && (protectedQueue || !sourcePresent)) return false;
  // Missing source never interrupts an in-progress handoff/controller; only blocked history is released.
  return true;
}
