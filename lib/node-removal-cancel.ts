import type {Editor, TLShapeId, TLShape} from 'tldraw';
import {getMeta, listRuns, updateRun, type RunRecord} from './production-records.ts';
import {removalShapes, type RemovalDependencies} from './node-removal-guard.ts';
import {cancelRegisteredNodeTask, cancelQueueForRemoval, hasNodeTask, fenceNodeRemoval} from './node-task-activity.ts';
import {probeRemovalTask, probeVoiceDesignRemoval} from './node-task-probe.ts';
import {saveNodeForRun, isNodeClaimed} from './run-recovery.ts';
import {coverKey, type CoverDoc} from './cover-model.ts';

type Task = {id:string;kind:'image'|'audio'|'video';save?:string;run?:RunRecord;nodeId:string;legacy?:boolean};
export type CancelRemovalDependencies = {
  runs: RemovalDependencies['runs']; update: typeof updateRun; cover: RemovalDependencies['cover'];
  probe: typeof probeRemovalTask; voice: typeof probeVoiceDesignRemoval;
  local: typeof cancelRegisteredNodeTask; queue: typeof cancelQueueForRemoval;
  request: typeof fetch; busy:(id:string)=>boolean; wait:(ms:number)=>Promise<void>;
  frames?:(pageId:string,ids:readonly string[])=>Promise<{id:string;nodeId:string}[]>;
};
const defaults:CancelRemovalDependencies={runs:listRuns,update:updateRun,cover:id=>getMeta<CoverDoc>(coverKey(id)),
  probe:probeRemovalTask,voice:probeVoiceDesignRemoval,local:cancelRegisteredNodeTask,queue:cancelQueueForRemoval,
  request:(...args)=>fetch(...args),busy:id=>hasNodeTask(id)||isNodeClaimed(id),wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  frames:async(pageId,ids)=>{
    const batch=await getMeta<{entries:{nodeId?:string;frameInputs?:Record<string,{enhancement?:{promptId?:string}}> }[]}>('shot-queue-session-v1:'+pageId);
    const tasks=(batch?.entries??[]).flatMap(entry=>Object.values(entry.frameInputs??{}).flatMap(frame=>frame.enhancement?.promptId&&entry.nodeId?[{id:frame.enhancement.promptId,nodeId:entry.nodeId}]:[]));
    const selected=tasks.filter(task=>ids.includes(task.nodeId));
    if(selected.some(task=>tasks.some(other=>other.id===task.id&&!ids.includes(other.nodeId))))throw Error('高清任务被其他续段共用，未取消或删除；请先核实共享任务');
    return selected;
  }};

/** Explicit deletion only. Cancel by exact prompt ID; never clear/interrupt the global queue. */
export async function cancelTasksBeforeNodeRemoval(editor:Editor, ids:readonly TLShapeId[], deps=defaults) {
  const shapes=removalShapes(editor,ids);
  if(!shapes.length||ids.some(id=>!shapes.some(s=>s.id===id))||shapes.some(s=>s.isLocked))throw Error('节点不存在或被锁定，未取消或删除');
  if(shapes.some(s=>s.parentId!==editor.getCurrentPageId()&&!shapes.some(p=>p.id===s.parentId)))throw Error('节点不在当前画布，未取消或删除');
  const owned=new Set(shapes.map(s=>s.id));
  const release=fenceNodeRemoval([...owned]);
  try {
    const before=await deps.runs();
    // Start pausing the submission controller immediately, while local aborts
    // also release an enqueue that may still be preparing/uploading inputs.
    const pause=deps.queue(editor.getCurrentPageId(),[...owned]);
    const stopped=await Promise.allSettled([pause,...shapes.map(s=>deps.local(s.id))]);
    const rejected=stopped.find(result=>result.status==='rejected');
    if(rejected?.status==='rejected')throw rejected.reason;
    const runs=await deps.runs();
    const tasks:Task[]=[];
    for(const run of [...before,...runs]){
      if(!run.ownerNodeId||!owned.has(run.ownerNodeId as TLShapeId)||!['queued','running'].includes(run.status))continue;
      if(!run.comfyPromptId)throw Error('提交状态不明，不能确认取消；节点保留');
      if(!tasks.some(task=>task.id===run.comfyPromptId))tasks.push({id:run.comfyPromptId,kind:run.capabilityId==='cover_generation'?'image':'video',save:run.capabilityId==='cover_generation'?undefined:saveNodeForRun(run),run,nodeId:run.ownerNodeId});
    }
    for(const shape of shapes){
      const props=shape.props as Record<string,unknown>;
      if(typeof props.pendingDesignId==='string'&&props.pendingDesignId){
        const voice=await deps.voice(props.pendingDesignId);
        if(voice==='queued'||voice==='running')throw Error('AI音色设计服务暂无安全取消接口，不能假装已取消；节点保留');
      }
      if(['tts-node','music-node','flux-image-node','audio-video-node'].includes(shape.type)&&typeof props.pendingId==='string'&&props.pendingId){
        tasks.push({id:props.pendingId,nodeId:shape.id,legacy:true,kind:shape.type==='flux-image-node'?'image':shape.type==='audio-video-node'?'video':'audio',save:shape.type==='flux-image-node'?'7':shape.type==='tts-node'?'4':shape.type==='music-node'?'9':'16'});
      }
      if(shape.type==='cover-node'&&typeof props.docId==='string'){
        const doc=await deps.cover(props.docId);
        if(doc?.work?.pendingId)tasks.push({id:doc.work.pendingId,nodeId:shape.id,kind:'image'});
      }
      const hd=shape.meta.tailFrameHD as {status?:string;promptId?:string}|undefined;
      if(hd?.promptId&&hd.status!=='completed'&&hd.status!=='detached')tasks.push({id:hd.promptId,nodeId:shape.id,kind:'image'});
    }
    for(const frame of await deps.frames?.(editor.getCurrentPageId(),[...owned])??[])tasks.push({...frame,kind:'image'});
    const otherShapes=editor.store.allRecords().filter((record):record is TLShape=>record.typeName==='shape'&&!owned.has(record.id as TLShapeId));
    if(tasks.some(task=>otherShapes.some(shape=>{
      const props=shape.props as Record<string,unknown>,hd=shape.meta.tailFrameHD as {promptId?:string}|undefined;
      return props.pendingId===task.id||hd?.promptId===task.id;
    })))throw Error('任务被其他节点共用，未取消或删除；不会误停其他节点');
    for(const task of tasks){
      let state=await deps.probe(task.id,task.kind,task.save);
      let cancelled=false;
      if(state==='running'||state==='queued'){
        const response=await deps.request('/comfyui/api/jobs/'+encodeURIComponent(task.id)+'/cancel',{method:'POST',signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw Error(`取消任务失败（HTTP ${response.status}），节点保留；未中断其他任务`);
        cancelled=true;
        for(let attempt=0;attempt<50;attempt++){
          state=await deps.probe(task.id,task.kind,task.save);
          if(state!=='running'&&state!=='queued')break;
          await deps.wait(200);
        }
      }
      if(state==='queued'||state==='running'||state==='uncertain')throw Error('后台尚未确认停止，节点保留，请稍后重试删除');
      if(state==='not_found'&&!cancelled&&task.run?.submission==='reserved')throw Error('原提交状态不明，节点保留；不会以找不到历史冒充取消成功');
      if(task.run&&state!=='completed')await deps.update(task.run.runId,{status:'cancelled',completedAt:Date.now(),error:'用户删除节点，已核实任务停止'});
      if(task.legacy&&cancelled&&state!=='completed'){
        const current=editor.getShape(task.nodeId as TLShapeId);
        if(current&&(current.props as Record<string,unknown>).pendingId===task.id)editor.updateShape({id:current.id,type:current.type,props:{pendingId:''}} as never);
      }
    }
    // Give existing component finally/abort handlers time to release their locks.
    for(let attempt=0;attempt<50&&[...owned].some(deps.busy);attempt++)await deps.wait(200);
    if([...owned].some(deps.busy))throw Error('本地处理尚未结束，节点保留；不会强制释放仍在执行的任务');
    return release;
  }catch(cause){release();throw cause;}
}
