import type { QueueSession } from './shot-queue-session.ts';
import type { RunRecord } from './production-records.ts';

/** Only for explicit retry of a handoff that never established a session. No task mutation. */
export function assertInboxHandoffNotStarted(receipt:{sessionId?:string;queueJson?:string;at:string;result:string},sessions:readonly QueueSession[],runs:readonly RunRecord[],ack?:{sessionId?:string},boot?:{status:string},runGate?:boolean) {
  if(!['blocked','awaiting_session'].includes(receipt.result)||receipt.sessionId||ack?.sessionId||boot?.status==='loading'||runGate)throw Error('已有会话或控制器仍可能在提交，禁止重新交接；请使用原会话核对/恢复');
  if(!receipt.queueJson||sessions.some(s=>JSON.stringify(s.queue)===receipt.queueJson))throw Error('找到匹配原会话或缺少原队列，不能按未启动处理');
  const queue=JSON.parse(receipt.queueJson) as {chapters:{shots:{prompt:string}[]}[]};
  const prompts=new Set(queue.chapters.flatMap(c=>c.shots.map(s=>s.prompt)));
  const at=Date.parse(receipt.at);
  if(!Number.isFinite(at)||runs.some(run=>!!run.rawPrompt&&prompts.has(run.rawPrompt)&&(!Number.isFinite(run.createdAt)||run.createdAt>=at)))throw Error('交接之后存在同提示词Run或时间不明，须核对原prompt_id/history，不能重新交接');
}
