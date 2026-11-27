import type {RunRecord} from './production-records.ts';
export const LEGACY_PREPARATION_CONNECTION_ERROR='ComfyUI 未启动或无法连接（127.0.0.1:8188）';
export function legacyPreparationNotSentCandidate(run:RunRecord){
  return run.status==='failed' && run.submission==='reserved' && run.error===LEGACY_PREPARATION_CONNECTION_ERROR && !run.submissionSnapshot && !run.startedAt && run.outputAssetIds.length===0;
}
export function provenPreparationNotSent(run:RunRecord){
  return run.status==='failed'&&run.submission==='reserved'&&!run.submissionSnapshot&&!run.startedAt&&!run.outputAssetIds.length&&run.preparationNotSent?.workflowCaptureAbsent===true&&run.preparationNotSent.promptId===run.comfyPromptId;
}
