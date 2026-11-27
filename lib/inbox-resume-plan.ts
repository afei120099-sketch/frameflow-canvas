import type {QueueSession} from './shot-queue-session.ts';
import {queueEntryUncertain,queueRowKey} from './shot-queue-session.ts';
import type {RunRecord} from './production-records.ts';
import {provenPreparationNotSent} from './preparation-not-sent.ts';

export function planInboxResume(session:QueueSession,runs:RunRecord[],shapes:ReadonlyMap<string,{meta:Record<string,unknown>}>,skipUncertain=false) {
  const eligible:string[]=[];
  for(const entry of session.entries){
    if(entry.removedAt||entry.cancelRequestedAt||entry.cancelledAt)continue;
    const shape=entry.nodeId?shapes.get(entry.nodeId):undefined;
    if(!entry.nodeId||!shape)throw Error("原会话节点缺失；禁止恢复时新建节点");
    if(shape.meta.shotQueueSessionId!==session.id||shape.meta.shotQueueEntry!==queueRowKey(entry))throw Error("节点会话标记不符，禁止恢复");
    if(queueEntryUncertain(entry,runs)) { if(skipUncertain)continue; throw Error("存在提交状态不明的镜头，请先核对原prompt_id/history"); }
    if(runs.some(run=>run.ownerNodeId===entry.nodeId&&!provenPreparationNotSent(run)))continue; // Only documented pre-/prompt failures may retry.
    if(entry.submissionState==="pending"&&!entry.outcome&&!entry.error)eligible.push(entry.nodeId);
  }
  return eligible;
}
