import { executeEnhancement, type EnhancementCheckpoint } from './enhancement-pipeline.ts';
import { assembleMedia } from './segmented-upscale.ts';
import { getAsset, getMeta, putMeta, type RunRecord } from './production-records.ts';
import { getLocalVideoBlob, storeLocalVideo, readVideoMetadata } from './local-video-store.ts';
import { comfyUIH3Adapter } from './comfyui/h3-adapter.ts';
import { withLock, watchRun } from './run-recovery.ts';
import { SubmissionUncertainError, type H3GenerationOptions } from './ai-adapter.ts';
import { readMp4VideoFps } from './video-fps.ts';

export const enhancementKey=(id:string)=>`enhancement-v1:${id}`;
export const saveEnhancement=(c:EnhancementCheckpoint)=>putMeta(enhancementKey(c.runId),c);
export async function activeEnhancementPrompt(runId:string) {
  const checkpoint=await getMeta<EnhancementCheckpoint>(enhancementKey(runId));
  return checkpoint?.steps.find(step=>step.state==="reserved" || step.state==="accepted")?.promptId??null;
}
export function resumeEnhancement(run: RunRecord, options: H3GenerationOptions={}) {
  return withLock(`frameflow-enhancement-${run.runId}`,()=>resumeLocked(run,options));
}
async function resumeLocked(run: RunRecord, options: H3GenerationOptions) {
  const c = await getMeta<EnhancementCheckpoint>(enhancementKey(run.runId));
  if(!c || c.version!==1 || c.runId!==run.runId) throw new Error('没有可恢复的分段检查点；不会自动重提旧任务');
  const input=await getAsset(run.inputAssetIds[0]);
  if(!input || input.storageReference!==c.originalSource) throw new Error('检查点原视频不匹配，停止恢复');
  const {plan}=c;
  const result=await executeEnhancement(c,{
    save:saveEnhancement,load:getLocalVideoBlob,store:storeLocalVideo,
    cut:async(original,checkpoint,segment,signal)=>{
      const offset=checkpoint.clip?.start??0;
      return assembleMedia([{key:'original',inPoint:offset+segment.inputStartFrame/plan.fps,outPoint:offset+(segment.inputStartFrame+segment.inputFrames)/plan.fps,title:'内部处理段',filename:c.originalName}],new Map([['original',original]]),signal,{frames:segment.inputFrames,fps:plan.fps,width:plan.width,height:plan.height});
    },
    render:(stage,video,name,opts)=>stage==='upscale'
      ? comfyUIH3Adapter.upscale(video,name,undefined,{...opts,upscaleDimensions:{width:plan.outputWidth!,height:plan.outputHeight!}})
      : comfyUIH3Adapter.interpolate(video,name,opts),
    recover:async(promptId,stage,signal)=>{
      const watched=await watchRun({runId:run.runId,capabilityId:stage==='upscale'?'seedvr2_upscale':'film_interpolation',comfyPromptId:promptId,submission:'reserved'},comfyUIH3Adapter,{signal,onPhase:(phase,text)=>options.onUpdate?.({status:phase==='queued'?'queued':phase==='running'?'running':'preparing',stage:text})});
      if(watched.phase==='failed') throw new Error(watched.error);
      if(watched.phase!=='completed') throw new SubmissionUncertainError(watched.phase==='unconfirmed'?watched.reason:'恢复查询已暂停');
      return {...await comfyUIH3Adapter.fetchOutputFile(watched.file),promptId};
    },
    merge:async(checkpoint,original,outputs,signal)=>{
      const outputFps=checkpoint.combined || checkpoint.interpolationOnly?60:plan.fps;
      const sources=new Map<string,Blob>([['original',original]]);
      const clips=outputs.map(({step,blob})=>{
        const s=step.segment,key=step.key;sources.set(key,blob);
        // Round cumulative boundaries, not each duration, to prevent cumulative drift.
        const frames=Math.round((s.startFrame+s.frames)/plan.fps*outputFps)-Math.round(s.startFrame/plan.fps*outputFps);
        const start=s.trimFrames/plan.fps;
        return {key,inPoint:start,outPoint:start+frames/outputFps,title:key,filename:step.filename!,audioSourceKey:'original',audioInPoint:(checkpoint.clip?.start??0)+s.startFrame/plan.fps};
      });
      return assembleMedia(clips,sources,signal,{frames:Math.round(plan.frames/plan.fps*outputFps),fps:outputFps,width:plan.outputWidth??plan.width*2,height:plan.outputHeight??plan.height*2});
    },
  },{...options,onTiming:undefined});
  const saved=await getMeta<EnhancementCheckpoint>(enhancementKey(run.runId));
  const timings=saved?.steps.flatMap(step=>step.timing?[step.timing]:[])??[];
  if(timings.length) {
    const starts=timings.flatMap(t=>t.startedAt?[t.startedAt]:[]),ends=timings.flatMap(t=>t.completedAt?[t.completedAt]:[]);
    const stages:Record<string,number>={};
    for(const t of timings)for(const [key,ms] of Object.entries(t.stages))stages[key]=(stages[key]??0)+ms;
    const executionMs=timings.reduce((sum,t)=>sum+(t.executionMs??(t.startedAt&&t.completedAt?Math.max(0,t.completedAt-t.startedAt):0)),0);
    options.onTiming?.({executionMs,...(starts.length?{startedAt:Math.min(...starts)}:{}),...(ends.length?{completedAt:Math.max(...ends)}:{}),stages});
  }
  const metadata=await readVideoMetadata(result.video),fps=await readMp4VideoFps(result.video);
  const wanted=c.combined || c.interpolationOnly?60:plan.fps;
  if(fps===null || Math.abs(fps-wanted)>.01 || metadata.width!==(plan.outputWidth??plan.width*2) || metadata.height!==(plan.outputHeight??plan.height*2)) throw new Error('分段输出尺寸或帧率校验失败，未加入画布');
  return result;
}
