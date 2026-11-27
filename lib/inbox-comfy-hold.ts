export type HeldJob={sessionId:string;promptId:string;number:number;graph:Record<string,unknown>;extraData:unknown;state:'deleting'|'held'|'restoring'|'restored'|'uncertain'|'abandoned';deleteConfirmed?:boolean;reason:'pause'|'priority'|'skip';prioritySignature?:string;error?:string};
type Control={pauseSessions?:string[];stopSessions?:string[];priority?:string[];blockedPrompts?:string[];stop:boolean;effective:{submit:boolean;autoEnqueue:boolean}};
type Queue={queue_running:unknown[][];queue_pending:unknown[][]};
export class ComfyHoldNotSent extends Error{}
export async function reconcileComfyHolds(control:Control,owned:Map<string,string>,deps:{queue:()=>Promise<Queue>;history:(id:string)=>Promise<boolean>;load:()=>Promise<HeldJob[]>;save:(jobs:HeldJob[])=>Promise<void>;remove:(ids:string[])=>Promise<void>;restore:(job:HeldJob,priority:number)=>Promise<void>}){
 const jobs=await deps.load(),queue=await deps.queue();
 for(const item of queue.queue_pending){const id=String(item[1]),sessionId=owned.get(id),prior=jobs.filter(j=>j.promptId===id).at(-1),prioritySignature=JSON.stringify(control.priority??[]),pausing=!!sessionId&&control.pauseSessions?.includes(sessionId),reprioritizing=!!sessionId&&((control.priority??[]).includes(sessionId)||prior?.reason==='priority')&&prior?.prioritySignature!==prioritySignature;
  const skipping=control.blockedPrompts?.includes(id);if(!sessionId||!pausing&&!reprioritizing&&!skipping||control.stopSessions?.includes(sessionId)||prior&&prior.state!=='restored')continue;
  if(!item[2]||typeof item[2]!=='object')throw Error('等待队列缺少完整工作流，不移除任务');
  const job:HeldJob={sessionId,promptId:id,number:prior?.number??Number(item[0]),graph:item[2] as Record<string,unknown>,extraData:item[3],state:'deleting',reason:skipping?'skip':pausing?'pause':'priority',prioritySignature,};jobs.push(job);await deps.save(jobs);
  try{await deps.remove([id]);job.deleteConfirmed=true;await deps.save(jobs);}catch(error){job.state='uncertain';job.error=String(error);await deps.save(jobs);continue;}
  const after=await deps.queue();if(after.queue_running.some(j=>j[1]===id)||after.queue_pending.some(j=>j[1]===id)||await deps.history(id))job.state='restored';else job.state='held';await deps.save(jobs);
 }
 for(const job of jobs){
  if(!['held','deleting','restoring'].includes(job.state))continue;
  const current=await deps.queue();
  if(current.queue_running.some(j=>j[1]===job.promptId)||current.queue_pending.some(j=>j[1]===job.promptId)||await deps.history(job.promptId)){job.state='restored';await deps.save(jobs);continue;}
  if(job.state!=='held'){job.state='uncertain';job.error='中断窗口缺少可核实回执，不自动重提';await deps.save(jobs);continue;}
  if(control.stopSessions?.includes(job.sessionId)){job.state='abandoned';await deps.save(jobs);continue;}
  if(control.stop||!control.effective.submit||!control.effective.autoEnqueue||control.pauseSessions?.includes(job.sessionId)||control.blockedPrompts?.includes(job.promptId))continue;
  job.state='restoring';await deps.save(jobs);
  try{const rank=control.priority?.indexOf(job.sessionId)??-1;await deps.restore(job,rank);job.state='restored';}catch(error){job.state=error instanceof ComfyHoldNotSent?'held':'uncertain';job.error=String(error);}await deps.save(jobs);
 }
 return jobs.map(({graph,extraData,...job})=>job);
}
