/** Inbox handoff receipts are not ComfyUI acceptance. Keep the request scoped to one page and batch. */
export type InboxPhase = "preparing" | "session_created" | "submitting" | "running" | "blocked";
export type InboxRequest = {
  id: string; pageId: string; queueJson: string; phase: InboxPhase;
  sessionId?: string; error?: string;
};
type Host = { __frameflowInboxRequest?: InboxRequest };
const host = () => window as unknown as Host;
export function beginInboxRequest(request: InboxRequest) { host().__frameflowInboxRequest = request; }
export function readInboxRequest() { return host().__frameflowInboxRequest; }
export function matchingInboxRequest(pageId: string, queue: unknown) {
  const request = readInboxRequest();
  return request?.pageId === pageId && request.queueJson === JSON.stringify(queue) ? request : undefined;
}
export function reportInboxRequest(pageId: string, queue: unknown, phase: InboxPhase, detail: {sessionId?: string; error?: string} = {}) {
  const request = matchingInboxRequest(pageId, queue);
  if (request && request.phase !== "blocked") Object.assign(request, { phase }, detail);
}
export function blockInboxRequest(id: string, error: string) {
  const request = readInboxRequest();
  if (request?.id === id) Object.assign(request, { phase: "blocked", error });
}
// Wall-clock delay is not proof that a background tab failed to create a session.
export const INBOX_HANDOFF_TIMEOUT_MS = 10 * 60_000;
export function inboxHandoffExpired(at: string, now = Date.now()) {
  const started = Date.parse(at);
  return !Number.isFinite(started) || now - started >= INBOX_HANDOFF_TIMEOUT_MS;
}
export type InboxResumeTarget = {requestId:string;sessionId:string;pageId:string;allowPreparationRepair?:boolean};
export type InboxVoiceNoneTarget = InboxResumeTarget & {nodeId:string;lineIndex:number;expectedRoleId:string;expectedText:string};
export type InboxShotTarget = InboxResumeTarget & {nodeId:string;action:'retry_failed'|'cancel_shot'};
export type InboxRecoveryController = {recoverTail?:(target:{sessionId:string;pageId:string;nodeId:string;edge:'first'|'last';output:import('./tail-frame-output-recovery.ts').TailOutputRecovery})=>Promise<unknown>;activateFileSession?:(session:import('./shot-queue-session.ts').QueueSession,signal?:AbortSignal)=>Promise<boolean>;fileResume?:(sessionId:string,signal?:AbortSignal)=>Promise<unknown>;fileRerun?:(selector:import('./inbox-file-policy.ts').ShotSelector,requestId:string,signal?:AbortSignal)=>Promise<unknown>;yield?:(signal?:AbortSignal)=>Promise<boolean>;diagnose:(sessionId:string)=>Promise<unknown>;resume:(target:InboxResumeTarget)=>Promise<void>;voiceNone:(target:InboxVoiceNoneTarget)=>Promise<unknown>;shotAction:(target:InboxShotTarget)=>Promise<unknown>};
const recoveryControllers=new Map<string,InboxRecoveryController>();
export function registerInboxRecovery(pageId:string,controller:InboxRecoveryController){
  recoveryControllers.set(pageId,controller);
  return ()=>{if(recoveryControllers.get(pageId)===controller)recoveryControllers.delete(pageId);};
}
export function readInboxRecovery(pageId:string){return recoveryControllers.get(pageId);}
