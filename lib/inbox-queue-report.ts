import { parseShotQueue, planShotReferences, ShotQueueValidationError, type ShotQueue } from './shot-queue.ts';
import { queueFramePlan, type QueueFrameSource } from './shot-queue-frames.ts';
import { latestQueueRun, queueEntryUncertain, type QueueSession } from './shot-queue-session.ts';
import { compileQueueShotPictures } from './queue-picture-order.ts';
import { timeAnchorFrame } from './comfyui/experimental/h3-ultimate-guide.ts';
import type { AssetRecord, RunRecord } from './production-records.ts';
import type { RoleRecord } from './role-records.ts';
import { expandEpisode } from './episode-settings.ts';

export type AssetResolution = {chapter:number;shot:number;title:string;field:string;input:unknown;resolvedId?:string;status:'resolved'|'missing'|'deferred'|'invalid';detail?:unknown};
/** 🧪 One time anchor in a dry-run report: frame from round(seconds × 24), image resolved or deferred until its source renders. */
export type InboxTimeAnchorReport = {atSeconds:number;frameIdx:number;status:'resolved'|'deferred';asReference:boolean;assetId?:string;filename?:string;frameFrom?:QueueFrameSource;pictureNumber:false|'as_reference'};
export type InboxCompiledShot = {timeAnchors?:InboxTimeAnchorReport[];chapter:number;shot:number;title:string;shotId?:string;state:'compiled'|'deferred'|'error';prompt?:string;compilerVersion?:string;notes?:string[];references?:{label:string;assetId:string;filename:string}[];subjects?:import('./reference-manifest.ts').RoleBinding[];offscreenRoleIds?:string[];error?:string};
export type InboxValidation = {ok:boolean;validateOnly:boolean;checkedAt:string;errors:string[];assets:AssetResolution[];compiledShots:InboxCompiledShot[];over12000?:{chapter:number;shot:number;title:string;characters:number}[];queue?:ShotQueue;gpuSubmitted:false};

/** No IDB writes, node creation, claim-gate access, HTTP generation or primary-role mutation. */
export function validateInboxQueue(raw: unknown, map: Record<string,string>, assets: readonly AssetRecord[], roles: readonly RoleRecord[], validateOnly=false): InboxValidation {
  const report:InboxValidation={ok:false,validateOnly,checkedAt:new Date().toISOString(),errors:[],assets:[],compiledShots:[],gpuSubmitted:false};
  const data=structuredClone(raw) as Record<string,unknown>;
  const available=new Map(assets.filter(a=>!a.recycled).map(a=>[a.assetId,a]));
  const chapters=data && Array.isArray(data.chapters)?data.chapters:[];
  const frames:{chapter:number;shot:number;field:string;source:unknown}[]=[];
  chapters.forEach((chapter,c)=>{
    if(!chapter || !Array.isArray(chapter.shots))return;
    chapter.shots.forEach((shot:Record<string,unknown>,s:number)=>{
      if(!shot || typeof shot!=='object' || Array.isArray(shot))return;
      const add=(field:string,input:unknown,status:AssetResolution['status'],resolvedId?:string,detail?:unknown)=>report.assets.push({chapter:c+1,shot:s+1,title:String(shot.title??''),field,input,status,resolvedId,detail});
      const asset=(field:string,input:unknown,kind:AssetRecord['kind'])=>{
        const id=typeof input==='string'?(map[input]??input):'';
        const record=available.get(id);
        const ok=!!record && record.kind===kind && !!record.storageReference;
        add(field,input,ok?'resolved':'missing',id,record?{filename:record.filename,kind:record.kind,storageReference:record.storageReference}:null);
        if(!ok)report.errors.push(`第${c+1}章第${s+1}镜 ${field}：找不到可用${kind}素材 ${String(input)}（解析ID：${id}）`);
        return id;
      };
      if(Array.isArray(shot.sceneAssetIds))shot.sceneAssetIds=shot.sceneAssetIds.map((id,i)=>asset(`sceneAssetIds[${i}]`,id,'image'));
      for(const field of ['firstFrameAssetId','lastFrameAssetId','sourceVideoAssetId'])if(shot[field]!==undefined)shot[field]=asset(field,shot[field],field==='sourceVideoAssetId'?'video':'image');
      if(Array.isArray(shot.roleIds))for(const input of shot.roleIds){
        const role=roles.find(r=>r.roleId===input);
        add('roleIds',input,role?'resolved':'missing',role?.roleId,role?{name:role.displayName,primaryAppearanceAssetId:role.primaryAppearanceAssetId,primaryVoiceAssetId:role.primaryVoiceAssetId}:null);
        if(!role){report.errors.push(`第${c+1}章第${s+1}镜 角色不存在：${input}`);continue;}
        if(!(Array.isArray(shot.offscreenRoleIds)&&shot.offscreenRoleIds.includes(input)))asset('role.primaryAppearanceAssetId',role.primaryAppearanceAssetId,'image');
        const speaks=shot.voiceRoleId===input || (Array.isArray(shot.dialogue)&&shot.dialogue.some(line=>line?.roleId===input));
        if(speaks&&shot.autoVoiceDisabled!==true)asset('role.primaryVoiceAssetId',role.primaryVoiceAssetId,'audio');
      }
      if(Array.isArray(shot.dialogue))shot.dialogue=shot.dialogue.map((line,i)=>{
        if(line&&typeof line==='object'&&typeof line.voice==='string'&&line.voice.startsWith('audio:')){
          return {...line,voice:'audio:'+asset(`dialogue[${i}].voice`,line.voice.slice(6),'audio')};
        }
        return line;
      });
      for(const field of ['firstFrameFrom','lastFrameFrom'])if(shot[field]!==undefined)frames.push({chapter:c,shot:s,field,source:shot[field]});
      // 🧪 timeAnchors: static images must exist; frameFrom sources join the same dependency check and stay deferred.
      if(Array.isArray(shot.timeAnchors))shot.timeAnchors=shot.timeAnchors.map((anchor,i)=>{
        if(!anchor||typeof anchor!=='object')return anchor;
        if(anchor.frameFrom!==undefined)frames.push({chapter:c,shot:s,field:`timeAnchors[${i}].frameFrom`,source:anchor.frameFrom});
        return anchor.assetId!==undefined?{...anchor,assetId:asset(`timeAnchors[${i}].assetId`,anchor.assetId,'image')}:anchor;
      });
    });
  });
  try{report.queue=parseShotQueue(JSON.stringify(data));}
  catch(error){report.errors.push(...(error instanceof ShotQueueValidationError?error.issues:[error instanceof Error?error.message:String(error)]));}
  if(report.queue){
    const queue=report.queue,plan=queueFramePlan(queue);
    for(const f of frames){
      try{
        const key=plan.sourceKey(f.source as QueueFrameSource,`${f.chapter}:${f.shot}`);
        const [c,s]=key.split(':').map(Number),shot=queue.chapters[c].shots[s];
        report.assets.push({chapter:f.chapter+1,shot:f.shot+1,title:queue.chapters[f.chapter].shots[f.shot].title,field:f.field,input:f.source,status:'deferred',detail:{sourceKey:key,shotId:shot.shotId,title:shot.title,note:'依赖视频完成后才能截帧；干跑不生成高清帧或视频'}});
      }catch(error){report.errors.push(String(error));}
    }
    queue.chapters.forEach((chapter,c)=>chapter.shots.forEach((shot,s)=>{
      try{
        planShotReferences(shot,roles,available);
        const selected=shot.roleIds.flatMap(id=>roles.filter(role=>role.roleId===id));
        const roleAssets=Object.fromEntries([...available].filter(([,asset])=>asset.kind==='image'||asset.kind==='audio'||asset.kind==='video').map(([,asset])=>[asset.assetId,{assetId:asset.assetId,kind:asset.kind as 'image'|'audio'|'video',storageReference:asset.storageReference,filename:asset.filename}]));
        const prepared=compileQueueShotPictures({shot,scenes:shot.sceneAssetIds.flatMap(id=>{const asset=available.get(id);return asset?[{assetId:asset.assetId,src:asset.storageReference,name:asset.filename}]:[];}),roles:selected,assets:available,roleAssets,includeRoleVoices:shot.autoVoiceDisabled!==true,noBackgroundMusic:queue.defaults?.noBackgroundMusic,chapter:c,shotIndex:s}).prepared;
        const deferred=!!shot.firstFrameFrom||!!shot.lastFrameFrom||!!shot.sourceShot||!!shot.timeAnchors?.some(anchor=>anchor.frameFrom);
        report.compiledShots.push({chapter:c+1,shot:s+1,title:shot.title,shotId:shot.shotId,state:deferred?'deferred':'compiled',prompt:prepared.compiled.prompt,compilerVersion:prepared.compiled.compilerVersion,notes:[...prepared.compiled.notes,...(deferred?['依赖帧尚未产生：这是占位素材编译预览，实际提交时需按真实帧重新编译']:[])],references:prepared.manifest.pictureRefs.map(ref=>({label:ref.label,assetId:ref.assetId,filename:ref.filename})),offscreenRoleIds:shot.offscreenRoleIds});
        report.compiledShots[report.compiledShots.length-1].subjects=prepared.manifest.roleBindings;
        if(shot.promptTemplate){const used=[...new Set(expandEpisode(shot.promptTemplate,queue.episode).used)];if(used.length)report.compiledShots[report.compiledShots.length-1].notes?.push(`用了本集设定：${used.join('、')}（上面的 prompt 已换回原句，就是模型收到的）`);}
        if(shot.timeAnchors?.length)report.compiledShots[report.compiledShots.length-1].timeAnchors=[...shot.timeAnchors].sort((a,b)=>a.atSeconds-b.atSeconds).map(anchor=>{const record=anchor.assetId?available.get(anchor.assetId):undefined;return {atSeconds:anchor.atSeconds,frameIdx:timeAnchorFrame(anchor.atSeconds),status:anchor.frameFrom?'deferred' as const:'resolved' as const,asReference:Boolean(anchor.asReference),pictureNumber:anchor.asReference?'as_reference' as const:false as const,...(record?{assetId:record.assetId,filename:record.filename}:{}),...(anchor.frameFrom?{frameFrom:anchor.frameFrom}:{})};});
      }catch(error){const detail=error instanceof Error?error.message:String(error);report.errors.push(`第${c+1}章第${s+1}镜：${detail}`);report.compiledShots.push({chapter:c+1,shot:s+1,title:shot.title,shotId:shot.shotId,state:'error',error:detail});}
    }));
  }else{
    for(const f of frames)report.assets.push({chapter:f.chapter+1,shot:f.shot+1,title:'',field:f.field,input:f.source,status:'invalid',detail:'结构校验失败，依赖暂未解析'});
  }
  report.over12000=chapters.flatMap((chapter,c)=>Array.isArray(chapter?.shots)?chapter.shots.flatMap((shot:Record<string,unknown>,s:number)=>typeof shot?.prompt==='string'&&shot.prompt.length>12000?[{chapter:c+1,shot:s+1,title:String(shot.title??''),characters:shot.prompt.length}]:[]):[]);
  report.errors=[...new Set(report.errors)];report.ok=report.errors.length===0;return report;
}

export function inboxProgress(session:QueueSession,runs:RunRecord[],assets:readonly AssetRecord[]){
  const total=session.queue.chapters.reduce((n,c)=>n+c.shots.length,0);
  const shots=session.entries.map((entry,index)=>{
    const shot=session.queue.chapters[entry.chapter]?.shots[entry.shot];
    const run=latestQueueRun(entry,runs);
    const outputs=(run?.outputAssetIds??[]).flatMap(id=>{const asset=assets.find(a=>a.assetId===id&&a.kind==='video');return asset?[{assetId:id,filename:asset.filename,storageReference:asset.storageReference,available:!!asset.storageReference&&!asset.recycled}]:[];});
    const state=entry.removedAt?'cancelled':run?.status==='completed'?'completed':entry.cancelledAt?'cancelled':entry.cancelRequestedAt?'cancelling':queueEntryUncertain(entry,runs)?'uncertain':run?.status??entry.outcome??(entry.waitingReason?'waiting_frame':entry.submissionState??'pending');
    return {index:index+1,chapter:entry.chapter+1,shot:entry.shot+1,title:shot?.title,shotId:shot?.shotId,nodeId:entry.nodeId,runId:run?.runId,promptId:run?.comfyPromptId,state,reason:run?.error??entry.error??entry.waitingReason??null,outputs};
  });
  const counts=shots.reduce<Record<string,number>>((m,s)=>{m[s.state]=(m[s.state]??0)+1;return m;},{});
  const allTerminal=shots.length===total&&total>0&&shots.every(s=>['completed','failed','cancelled','uncertain'].includes(s.state));
  const allSuccess=allTerminal&&shots.every(s=>s.state==='completed');
  const missingOutputs=allSuccess&&shots.some(s=>!s.outputs.length||s.outputs.some(o=>!o.available));
  const active=shots.some(s=>s.state==='running'||s.state==='queued');
  const state=allSuccess&&!missingOutputs?'completed':missingOutputs?'blocked':allTerminal?'finished_with_errors':active?'running':session.stoppedAt||session.autoContinueFrames!==true?'stopped':'submitting';
  return {state,counts,total,completed:counts.completed??0,current:shots.filter(s=>s.state==='running').map(s=>s.index),shots,
    outputs:shots.map(s=>({index:s.index,title:s.title,shotId:s.shotId,nodeId:s.nodeId,runId:s.runId,outputs:s.outputs})),
    outputVerification:'asset_metadata_only',...(missingOutputs?{error:'Run已完成，但视频产物记录缺失；不标记全部完成'}:{})};
}
