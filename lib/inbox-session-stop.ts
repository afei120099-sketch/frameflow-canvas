import type {QueueSession} from './shot-queue-session.ts';
export const ROOT_SESSION_STOP_REASON='用户通过_control.json stopSessions停止本批；已接单任务继续，未提交镜头取消，禁止自动续接';
/** Idempotent and batch-scoped. No Run, asset, /queue or /interrupt mutation. */
export function applyRootSessionStop(session:QueueSession,ids:readonly string[],now=Date.now()){
  if(!ids.includes(session.id)||session.stopSource==='root_stopSessions'&&session.stoppedAt&&session.autoContinueFrames===false)return false;
  session.autoContinueFrames=false;session.stoppedAt??=now;session.stopSource='root_stopSessions';session.stopReason=ROOT_SESSION_STOP_REASON;
  return true;
}
