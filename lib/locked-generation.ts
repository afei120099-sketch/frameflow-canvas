import type {RunRecord} from './production-records.ts';
import type {Workflow} from './comfyui/extra-workflows.ts';
export interface SubmittedWorkflow { graph: Workflow; saveNodeId: string; capturedAt: number; digest: string }
export async function captureWorkflow(graph:Workflow,saveNodeId:string):Promise<SubmittedWorkflow> {
  const frozen=structuredClone(graph),bytes=new TextEncoder().encode(JSON.stringify(frozen));
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  return {graph:frozen,saveNodeId,capturedAt:Date.now(),digest};
}
/** No recompilation, seed randomisation or reordering references on this path. */
export async function lockedWorkflow(run:RunRecord) {
  if(!run.submissionSnapshot || run.seed===null || !run.finalPrompt || run.status!=='completed') throw new Error('该旧候选缺少完整提交快照，不能保证原样复用；请勿用当前表单冒充原参数');
  const checked=await captureWorkflow(run.submissionSnapshot.graph,run.submissionSnapshot.saveNodeId);
  if(checked.digest!==run.submissionSnapshot.digest)throw new Error('锁定快照校验失败，请停止重渲');
  return structuredClone(run.submissionSnapshot);
}
