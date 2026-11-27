import { latestQueueRun, type QueueSession } from './shot-queue-session.ts';
import type { RunRecord } from './production-records.ts';
import { provenPreparationNotSent } from './preparation-not-sent.ts';

type Probe = {state:string;error?:string};
export function inboxShotTarget(batch:QueueSession,nodeId:string){
  const entry=batch.entries.find(e=>e.nodeId===nodeId);
  if(!entry||entry.removedAt)throw Error('原镜头缺失或已删除，不能恢复、新建或替换节点');
  return entry;
}
/** An explicit retry needs positive terminal evidence; not_found is not proof of failure. */
export async function prepareInboxShotRetry(batch:QueueSession,nodeId:string,runs:RunRecord[],probe:(run:RunRecord)=>Promise<Probe>){
  const entry=inboxShotTarget(batch,nodeId),run=latestQueueRun(entry,runs);
  if(entry.cancelRequestedAt||entry.cancelledAt||run?.status==='cancelled')throw Error('已取消镜头不能通过失败重试恢复');
  if(run){
    if(run.status!=='failed')throw Error('只能重试明确失败的镜头，运行、成功、等待与状态不明任务不重提');
    if(!run.comfyPromptId)throw Error('失败Run缺少原prompt_id，需人工核对');
    const result=await probe(run);
    if(result.state!=='failed' && !(result.state==='not_found'&&provenPreparationNotSent(run)))throw Error('原history没有明确失败或未发送凭证，禁止补交');
  }else if(entry.outcome!=='failed'||entry.submissionState!=='pending')throw Error('没有明确未发送的失败记录，禁止补交');
  entry.submissionState='pending';entry.outcome='failed';entry.error=undefined;
  return entry;
}

export async function cancelInboxShot(batch:QueueSession,nodeId:string,deps:{runs:()=>Promise<RunRecord[]>;probe:(run:RunRecord)=>Promise<Probe>;cancel:(promptId:string)=>Promise<void>;persist:()=>Promise<void>;update:(run:RunRecord)=>Promise<void>}){
  const entry=inboxShotTarget(batch,nodeId),run=latestQueueRun(entry,await deps.runs());
  if(run?.status==='completed')throw Error('此镜已成功，不取消或删除产物');
  entry.cancelRequestedAt=Date.now();await deps.persist(); // Persist intent before a remote side effect.
  if(!run&&entry.submissionState!=='pending')throw Error('原镜头提交去向不明，保留取消意图；不冒充后台已停止');
  if(run && run.status!=='cancelled'){
    if(!run.comfyPromptId)throw Error('提交状态不明，保留取消意图，需核对原prompt_id');
    let result=await deps.probe(run);
    if(result.state==='completed')throw Error('后台已成功，保留产物，不伪称取消成功');
    if(result.state==='queued'||result.state==='running'){
      await deps.cancel(run.comfyPromptId);result=await deps.probe(run);
      if(!['failed','not_found','cancelled'].includes(result.state))throw Error('后台未确认取消，保留现场；不会中断其他任务');
    }else if(result.state==='not_found'&&!provenPreparationNotSent(run))throw Error('原提交去向不明，不以查不到历史冒充取消成功');
    else if(!['failed','cancelled','not_found'].includes(result.state))throw Error('后台状态不明，未确认取消');
    if(run.status!=='failed')await deps.update(run);
  }
  entry.cancelledAt=Date.now();await deps.persist();return{nodeId,state:'cancelled',promptId:run?.comfyPromptId??null};
}
