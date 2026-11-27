import type {InboxRootControl} from './inbox-root-control.ts';
type Batch={sessionId:string;stopped:boolean;comfyPending:number|null};
export function inboxControlFieldStatus(control:InboxRootControl,batches:Batch[],effects:Record<string,unknown>){
 const fields:Record<string,unknown>={};
 for(const key of ['autoEnqueue','autoChain','submit'] as const)fields[key]={value:control[key],state:control.error?'invalid':control.effective[key]?'enabled':'disabled'};
 const scoped=(ids:readonly string[]|undefined,mode:string)=>(ids??[]).map(sessionId=>{const batch=batches.find(b=>b.sessionId===sessionId);return{sessionId,state:!batch?'not_found':mode==='stop'?batch.stopped?'applied':'pending':batch.stopped?'blocked_by_stop':mode==='pause'?batch.comfyPending===null?'backend_unverified':batch.comfyPending>0?'local_paused_waiting_backend_hold':'applied':mode};});
 fields.stopSessions={value:control.stopSessions??[],sessions:scoped(control.stopSessions,'stop')};
 fields.pauseSessions={value:control.pauseSessions??[],sessions:scoped(control.pauseSessions,'pause')};
 fields.priority={value:control.priority??[],sessions:scoped(control.priority,'active_for_new_submissions'),backend:effects.pauseSessions??'pending_reconciliation'};
 fields.interruptRunning={value:control.interruptRunning??[],sessions:(control.interruptRunning??[]).map(id=>({sessionId:id,receipt:effects['interrupt:'+id]??{state:'pending'}}))};
 fields.rerunShots={value:control.rerunShots??[],receipts:Object.entries(effects).filter(([key])=>key.startsWith('inbox-file-rerun:')).map(([key,result])=>({key,result}))};
 fields.skipShots={value:control.skipShots??[],sessions:scoped(control.skipShots?.map(s=>s.sessionId),'gated_with_upstream_wait').map(session=>({...session,...(effects['skip:'+session.sessionId]?{state:'rejected',receipt:effects['skip:'+session.sessionId]}:{})})),backend:effects.pauseSessions??'pending_reconciliation'};
 fields.retry={value:control.retry??{maxRetries:1},state:control.retry?.maxRetries===0?'disabled':'enabled_for_new_verified_failures',note:'仅history明确失败才自动重试；连接失败或历史缺失不证明未发送；取消/删除/停止/状态不明均不重提'};
 return fields;
}
