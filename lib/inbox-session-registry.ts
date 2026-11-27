import {listCleanupMetadata,getMeta,patchMeta} from './production-records.ts';
import {queueSessionKey,type QueueSession} from './shot-queue-session.ts';
export const fileSessionKey=(id:string)=>'shot-queue-file-v2:'+id;
export function collectFileSessions(rows:{key:string;value:unknown}[]){
 const result=new Map<string,QueueSession>();
 const rank=(key:string)=>key.startsWith('shot-queue-file-v2:')?2:key.startsWith('shot-queue-session-v1:')?3:1;
 for(const row of [...rows].filter(r=>!!r&&typeof r.key==='string'&&/^shot-queue-(session-v1:|session-archive-v1:|file-v2:)/.test(r.key)).sort((a,b)=>((a.value as QueueSession)?.revision??0)-((b.value as QueueSession)?.revision??0)||rank(a.key)-rank(b.key))){
  const s=row.value as QueueSession|null;if(!s||s.version!==1||!s.id||!Array.isArray(s.entries))continue;
  const prior=result.get(s.id),next=structuredClone(s);
  if(prior){if(prior.stoppedAt){next.stoppedAt=prior.stoppedAt;next.stopSource=prior.stopSource;next.stopReason=prior.stopReason;next.autoContinueFrames=false;}for(const e of next.entries){const tomb=prior.entries.find(p=>p.chapter===e.chapter&&p.shot===e.shot);if(tomb){e.removedAt??=tomb.removedAt;e.cancelledAt??=tomb.cancelledAt;e.cancelRequestedAt??=tomb.cancelRequestedAt;}}}
  result.set(s.id,next);
 }
 return [...result.values()];
}
export async function allFileSessions(){return collectFileSessions(await listCleanupMetadata());}
export async function rememberFileSession(session:QueueSession){await patchMeta<QueueSession>(fileSessionKey(session.id),current=>collectFileSessions([{key:fileSessionKey(session.id),value:current},{key:queueSessionKey(session.pageId),value:session}]).find(s=>s.id===session.id)??session);}
export async function fileSessionIsCurrent(session:QueueSession){return (await getMeta<QueueSession>(queueSessionKey(session.pageId)))?.id===session.id;}
