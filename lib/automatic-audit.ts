import { getMeta, putMeta, getRun, type AssetRecord } from "./production-records.ts";
import { inspectVideo, MediaAuditFailure, type MediaAuditReport } from "./media-audit.ts";
import { getLocalVideoBlob } from "./local-video-store.ts";
import { withLock } from "./run-recovery.ts";
export interface AutomaticAudit {version:1;assetId:string;createdAt:number;state:"pass"|"failed"|"warning"|"unknown";errors:string[];warnings:string[];report?:MediaAuditReport}
export const auditKey=(id:string)=>"automatic-audit-v1:"+id;
export function judgeAudit(report:MediaAuditReport,expected:{seconds?:number;width?:number;height?:number;soundMode?:string;fps?:number}):Pick<AutomaticAudit,"state"|"errors"|"warnings">{
 const errors:string[]=[],warnings=[...report.warnings].filter(w=>!w.includes("没有解码到音频"));
 if(expected.seconds&&Math.abs(report.decodedDuration-expected.seconds)>Math.max(.15,2/(report.fps||24)))errors.push("时长不符："+report.decodedDuration+" / "+expected.seconds+" 秒");
 if(expected.width&&expected.height&&(report.width!==expected.width||report.height!==expected.height))errors.push("分辨率不符："+report.width+"×"+report.height+" / "+expected.width+"×"+expected.height);
 if(expected.fps&&Math.abs(report.fps-expected.fps)>.05)errors.push("帧率不符："+report.fps+" / "+expected.fps);
 if(expected.soundMode==="av"&&!report.hasAudio)errors.push("要求声音，但没有音轨");
 if(expected.soundMode==="silent"&&report.hasAudio)errors.push("要求静音，但存在音轨");
 if(report.freezeRanges?.length)warnings.push("疑似静止／卡帧："+report.freezeRanges.map(r=>r.join("–")+"秒").join("，")+"；静态镜头需人工确认");
 return {state:errors.length?"failed":warnings.length?"warning":"pass",errors,warnings};
}
export function auditAsset(asset:AssetRecord,force=false){return withLock("frameflow-auto-audit",async()=>{
 const prior=await getMeta<AutomaticAudit>(auditKey(asset.assetId));if(prior&&!force)return prior;
 let result:AutomaticAudit;
 try{
 const report=await inspectVideo(await getLocalVideoBlob(asset.storageReference));
 const run=asset.sourceRunId?await getRun(asset.sourceRunId):null,p=run?.parameters??{};
 const clip=p.clip as {duration?:number}|undefined,planned=p.plannedOutput as {width?:number;height?:number;fpsValue?:number;duration?:number;frames?:number}|undefined;
 const seconds=planned?.duration??(planned?.frames&&planned?.fpsValue?planned.frames/planned.fpsValue:undefined)??(p.outputIncludesOriginal?undefined:typeof clip?.duration==="number"?clip.duration:typeof p.duration==="number"?p.duration:typeof p.length==="number"&&typeof p.fps==="number"?p.length/p.fps:undefined);
 const judged=judgeAudit(report,{seconds,width:planned?.width||Number(p.outputWidth)||Number(p.width)||asset.width,height:planned?.height||Number(p.outputHeight)||Number(p.height)||asset.height,fps:planned?.fpsValue||Number(p.outputFps)||Number(p.fps)||undefined,soundMode:String(p.soundMode??"")});
 result={version:1,assetId:asset.assetId,createdAt:Date.now(),...judged,report};
 }catch(e){const message=e instanceof Error?e.message:String(e),broken=e instanceof MediaAuditFailure&&e.status===422&&!/上限|目前只检查|超过/.test(message);result={version:1,assetId:asset.assetId,createdAt:Date.now(),state:broken?"failed":"unknown",errors:broken?["无法完成解码："+message]:[],warnings:broken?[]:["检查未完成："+message]};}
 await putMeta(auditKey(asset.assetId),result);window.dispatchEvent(new CustomEvent("frameflow-audit-changed",{detail:asset.assetId}));return result;
});}

