import {boundedLock,fetchBody} from './operation-scope.ts';
import {getMeta,putMeta,patchMeta,listRuns} from './production-records.ts';
import {getLocalImageBlob} from './local-video-store.ts';
import {refreshInboxRootControl} from './inbox-root-control.ts';
import type {HeldJob} from './inbox-comfy-hold.ts';
export type HeldRetirement={sessionId:string;nodeId:string;promptId:string;originalGraphSha256:string;badInputSha256:string;recognizedOutputSha256:string;deleteConfirmed:true;notInQueue:true;notInHistory:true;at:string};
const hash=async(bytes:ArrayBuffer)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const graphHash=(graph:unknown)=>hash(new TextEncoder().encode(JSON.stringify(graph)).buffer);
export async function retiredHeldAllows(sessionId:string,nodeId:string,promptId:string){
 const proof=await getMeta<HeldRetirement>('inbox-held-retired:'+promptId),jobs=await getMeta<HeldJob[]>('inbox-file-held-comfy');
 const job=jobs?.find(j=>j.promptId===promptId&&j.sessionId===sessionId);
 return !!proof&&proof.sessionId===sessionId&&proof.nodeId===nodeId&&proof.promptId===promptId&&proof.deleteConfirmed===true&&proof.notInQueue===true&&proof.notInHistory===true&&job?.state==='abandoned'&&job.deleteConfirmed===true&&proof.originalGraphSha256===await graphHash(job.graph);
}
/** Retire only an explicitly selected, positively dequeued, unexecuted job with proven all-zero input. No GPU POST. */
export async function retireInvalidHeldTail(target:{sessionId:string;nodeId:string;edge:'first'|'last';oldSrc:string;recognizedOutputSha256:string},signal?:AbortSignal){
 const result=await boundedLock('frameflow-inbox-file-service-v2',async scope=>{
  const control=await refreshInboxRootControl();scope.check();
  if(!control.pauseSessions?.includes(target.sessionId)||control.stopSessions?.includes(target.sessionId))throw Error('修复原领取任务需要本批暂停且未停止');
  const run=(await listRuns()).filter(r=>r.ownerNodeId===target.nodeId).sort((a,b)=>b.createdAt-a.createdAt)[0];scope.check();
  if(!run?.comfyPromptId||run.status==='cancelled'||run.status==='completed')throw Error('没有匹配的可核实原任务');
  if(await retiredHeldAllows(target.sessionId,target.nodeId,run.comfyPromptId))return await getMeta<HeldRetirement>('inbox-held-retired:'+run.comfyPromptId);
  const jobs=await getMeta<HeldJob[]>('inbox-file-held-comfy'),job=jobs?.find(j=>j.sessionId===target.sessionId&&j.promptId===run.comfyPromptId);scope.check();
  if(!job||job.state!=='held'||job.deleteConfirmed!==true)throw Error('没有明确移出等待队列的凭证，禁止重提');
  const graph=job.graph as Record<string,{class_type:string;inputs:Record<string,unknown>}>;
  const links=Object.values(graph).filter(n=>n?.class_type==='MiniMaxH3AudioConditioningT8').map(n=>n.inputs[target.edge==='first'?'first_frame':'last_frame']);
  if(links.length!==1||!Array.isArray(links[0]))throw Error('原首尾帧连接不唯一');
  const node=graph[String(links[0][0])];if(node?.class_type!=='LoadImage'||typeof node.inputs.image!=='string')throw Error('原图片连接无法核实');
  const local=new Uint8Array(await (await getLocalImageBlob(target.oldSrc)).arrayBuffer());scope.check();
  if(!local.length||local.some(b=>b!==0))throw Error('此入口只处理已证明全零的旧缓存，不废弃有效排队任务');
  const path=node.inputs.image.split('/'),filename=path.pop()!;
  const remote=await fetchBody('/comfyui/view?'+new URLSearchParams({filename,subfolder:path.join('/'),type:'input'}),{cache:'no-store'},r=>r.arrayBuffer(),12000,fetch,scope.signal);scope.check();
  if(await hash(local.buffer)!==await hash(remote))throw Error('原任务实际接收图片与坏缓存不符');
  const queue=await fetchBody('/comfyui/queue',{cache:'no-store'},r=>r.json(),12000,fetch,scope.signal) as {queue_running:unknown[][];queue_pending:unknown[][]};
  const history=await fetchBody('/comfyui/history/'+encodeURIComponent(job.promptId),{cache:'no-store'},r=>r.json(),12000,fetch,scope.signal) as Record<string,unknown>;scope.check();
  if([...queue.queue_running,...queue.queue_pending].some(j=>j[1]===job.promptId)||history[job.promptId])throw Error('原任务仍在队列或历史中，禁止废弃或补交');
  const proof:HeldRetirement={sessionId:target.sessionId,nodeId:target.nodeId,promptId:job.promptId,originalGraphSha256:await graphHash(job.graph),badInputSha256:await hash(local.buffer),recognizedOutputSha256:target.recognizedOutputSha256,deleteConfirmed:true,notInQueue:true,notInHistory:true,at:new Date().toISOString()};scope.check();
  await putMeta('inbox-held-retired:'+job.promptId,proof,scope.signal);scope.check();
  await patchMeta<HeldJob[]>('inbox-file-held-comfy',current=>{
   const fresh=current?.find(j=>j.promptId===job.promptId&&j.sessionId===target.sessionId);
   if(!fresh||fresh.state!=='held'||fresh.deleteConfirmed!==true||JSON.stringify(fresh.graph)!==JSON.stringify(job.graph))throw Error('领取记录并发变化，不废弃');
   fresh.state='abandoned';fresh.error='受控修复：原等待任务已明确移出且从未执行，旧输入全零；保留原图和工作流，等待指定镜头重渲';return current;
  },scope.signal);
  return proof;
 },{signal,waitMs:2000,workMs:25000});
 if(!result)throw Error('文件执行器忙，未改变原任务');return result;
}
