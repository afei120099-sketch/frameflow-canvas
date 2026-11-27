import { createMediaAssemblyJob, uploadRoughCutSource, planRoughCutJob, startRoughCutJob, roughCutJobStatus, roughCutJobResult, cancelRoughCutJob, disposeRoughCutJob, type MediaAssemblyClip } from './rough-cut-client.ts';
import type { H3GenerationOptions, H3GenerationOutput } from './ai-adapter.ts';

export interface UpscaleSegment { index:number; startFrame:number; frames:number; inputStartFrame:number; inputFrames:number; trimFrames:number; promptId:string }
export interface SegmentedUpscalePlan { fps:number; frames:number; width:number; height:number; outputWidth?:number; outputHeight?:number; segments:UpscaleSegment[] }
export function planUpscaleSegments(frames:number,fps:number,seconds=3,contextFrames=8):UpscaleSegment[] {
  if(!Number.isInteger(frames)||frames<1||!Number.isFinite(fps)||fps<=0||fps>120||!Number.isFinite(seconds)||seconds<.01||seconds>5||!Number.isInteger(contextFrames)||contextFrames<0) throw new Error('分段高清帧数或时长无效');
  const count=Math.max(1,Math.round(seconds*fps));
  if(Math.ceil(frames/count)>500) throw new Error('分段数量超过500，请缩短视频');
  const parts:UpscaleSegment[]=[];
  for(let start=0;start<frames;start+=count) {
    const keep=Math.min(count,frames-start), begin=Math.max(0,start-contextFrames), end=Math.min(frames,start+keep+contextFrames);
    parts.push({index:parts.length,startFrame:start,frames:keep,inputStartFrame:begin,inputFrames:end-begin,trimFrames:start-begin,promptId:crypto.randomUUID()});
  }
  return parts;
}
const aborted=(signal?:AbortSignal)=>{if(signal?.aborted) throw new DOMException('分段高清已取消','AbortError');};
const wait=(signal?:AbortSignal)=>new Promise<void>(resolve=>{
  const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
  const timer=setTimeout(done,500);signal?.addEventListener('abort',done,{once:true});
});
async function withMediaJob<T>(clips:MediaAssemblyClip[],sources:Map<string,Blob>,signal:AbortSignal|undefined,work:(id:string)=>Promise<T>):Promise<T> {
  aborted(signal);
  const job=await createMediaAssemblyJob(clips);
  const cancel=()=>{void cancelRoughCutJob(job.id);};
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    for(const key of job.sources){aborted(signal);const blob=sources.get(key);if(!blob)throw new Error('分段素材缺失');await uploadRoughCutSource(job.id,key,blob,signal);}
    aborted(signal);return await work(job.id);
  }finally{signal?.removeEventListener('abort',cancel);await disposeRoughCutJob(job.id);}
}
export async function prepareSegmentedUpscale(video:Blob,name:string,duration:number,signal?:AbortSignal,dimensions?:{width:number;height:number},options:{seconds?:number;contextFrames?:number;clip?:{start:number;duration:number}}={}):Promise<SegmentedUpscalePlan> {
  if(!Number.isFinite(duration)||duration<=0)throw new Error('无法读取原视频时长');
  // The UI rounds durations to 0.1s. A small overrun is clamped to the real media end by the existing probe.
  return withMediaJob([{key:'original',inPoint:options.clip?.start??0,outPoint:options.clip?options.clip.start+options.clip.duration:duration+.15,title:name,filename:name}],new Map([['original',video]]),signal,async id=>{
    const plan=await planRoughCutJob(id,'first');
    const source = plan.clips[0];
    const outputWidth=dimensions?.width??source.width*2,outputHeight=dimensions?.height??source.height*2;
    if(plan.output.width!==source.width || plan.output.height!==source.height || Math.max(outputWidth,outputHeight)>4096) throw new Error(`分段合并不支持原视频或目标尺寸（原始 ${source.width}×${source.height} → 目标 ${outputWidth}×${outputHeight}，最长边上限4096）。未提交渲染，也不会自动降低分辨率。`);
    return {fps:plan.output.fpsValue,frames:plan.output.frames,width:plan.output.width,height:plan.output.height,outputWidth,outputHeight,segments:planUpscaleSegments(plan.output.frames,plan.output.fpsValue,options.seconds??3,options.contextFrames??8)};
  });
}
export async function assembleMedia(clips:MediaAssemblyClip[],sources:Map<string,Blob>,signal?:AbortSignal,expected?:{frames:number;fps:number;width:number;height:number}) {
  return withMediaJob(clips,sources,signal,async id=>{
    const plan=await planRoughCutJob(id,'first');
    if(expected && (plan.output.frames!==expected.frames || Math.abs(plan.output.fpsValue-expected.fps)>.01 || plan.output.width!==expected.width || plan.output.height!==expected.height)) throw new Error('分段输出帧数、帧率或尺寸不匹配，停止合并，避免缺帧或改变时长');
    aborted(signal);await startRoughCutJob(id,'first');
    while(true){aborted(signal);const status=await roughCutJobStatus(id);if(status.state==='done')return roughCutJobResult(id);if(status.state==='failed'){
      const error=status.error;
      const stage=error?.stage??status.stage?.stage;
      const label=stage==='clip'?'片段转码':stage==='finalize'?'封装输出':stage==='probe'?'读取视频':stage??'视频处理';
      throw new Error([error?.message??'视频合并失败',`${label}${error?.clip?` · 第${error.clip}段`:''}${error?.filename?` · ${error.filename}`:''}`,error?.logPath?`崩溃日志：${error.logPath}`:error?.detail?.slice(0,600)].filter(Boolean).join('；'));
    }if(status.state==='cancelled')throw new DOMException('分段高清已取消','AbortError');await wait(signal);}
  });
}
type Upscale=(video:Blob,name:string,clip:undefined,options:H3GenerationOptions)=>Promise<H3GenerationOutput>;
export async function runSegmentedUpscale(video:Blob,name:string,plan:SegmentedUpscalePlan,upscale:Upscale,options:H3GenerationOptions & {beforeSegment:(segment:UpscaleSegment)=>Promise<void>}) :Promise<H3GenerationOutput> {
  const sources=new Map<string,Blob>([['original',video]]), clips:MediaAssemblyClip[]=[];
  for(const segment of plan.segments){
    aborted(options.signal);
    const label=`第${segment.index+1}/${plan.segments.length}段`;
    options.onUpdate?.({status:'preparing',stage:`分段高清：剪切${label}`});
    const cut=await assembleMedia([{key:'original',inPoint:segment.inputStartFrame/plan.fps,outPoint:(segment.inputStartFrame+segment.inputFrames)/plan.fps,title:label,filename:name}],new Map([['original',video]]),options.signal,{frames:segment.inputFrames,fps:plan.fps,width:plan.width,height:plan.height});
    aborted(options.signal);await options.beforeSegment(segment);
    // Only the physically cut short video reaches ComfyUI. Original full-size tensors never enter its VAE.
    const result=await upscale(cut,`segment-${segment.index+1}.mp4`,undefined,{...options,promptId:segment.promptId,onUpdate:update=>options.onUpdate?.({...update,stage:`分段高清 ${label}：${update.stage}`})});
    aborted(options.signal);
    const key=`segment_${segment.index}`;sources.set(key,result.video);
    clips.push({key,inPoint:segment.trimFrames/plan.fps,outPoint:(segment.trimFrames+segment.frames)/plan.fps,title:label,filename:result.filename,audioSourceKey:'original',audioInPoint:segment.startFrame/plan.fps});
  }
  options.onUpdate?.({status:'fetching',stage:'所有段已完成，正在合并完整高清视频及原音轨'});
  const merged=await assembleMedia(clips,sources,options.signal,{frames:plan.frames,fps:plan.fps,width:plan.outputWidth??plan.width*2,height:plan.outputHeight??plan.height*2});
  aborted(options.signal);
  return {video:merged,filename:`分段高清_${crypto.randomUUID()}.mp4`,promptId:options.promptId??''};
}
