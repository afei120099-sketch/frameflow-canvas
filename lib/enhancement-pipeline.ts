import type { H3GenerationOutput, H3GenerationOptions } from './ai-adapter.ts';
import type { ComfyFile } from './comfyui/h3-adapter.ts';
import type { SegmentedUpscalePlan, UpscaleSegment } from './segmented-upscale.ts';

export type EnhancementStage = 'upscale' | 'interpolate';
export interface EnhancementStep {
  key: string; stage: EnhancementStage; segment: UpscaleSegment;
  promptId: string; state: 'ready' | 'reserved' | 'accepted' | 'completed';
  source?: string; filename?: string;
  timing?: import("./execution-timing.ts").ExecutionTiming;
}
export interface EnhancementCheckpoint {
  version: 1; runId: string; plan: SegmentedUpscalePlan; steps: EnhancementStep[];
  combined: boolean; interpolationOnly?: boolean; profile: 'safe' | 'quality';
  originalSource: string; originalName: string;
  clip?: { start: number; duration: number }; finalSource?: string; finalName?: string;
}
export function newEnhancementCheckpoint(input: Omit<EnhancementCheckpoint,'version'|'steps'>): EnhancementCheckpoint {
  const stages: EnhancementStage[] = input.interpolationOnly ? ['interpolate'] : input.combined ? ['upscale','interpolate'] : ['upscale'];
  return {...input,version:1,steps:stages.flatMap(stage=>input.plan.segments.map(segment=>({
    key:`${stage}-${segment.index}`,stage,segment,promptId:crypto.randomUUID(),state:'ready' as const,
  })))};
}
export interface EnhancementIO {
  save(checkpoint: EnhancementCheckpoint): Promise<void>;
  load(source: string): Promise<Blob>;
  store(blob: Blob, name: string): Promise<string>;
  cut(original: Blob, checkpoint: EnhancementCheckpoint, segment: UpscaleSegment, signal?: AbortSignal): Promise<Blob>;
  render(stage: EnhancementStage, blob: Blob, name: string, options: H3GenerationOptions): Promise<H3GenerationOutput>;
  recover(promptId: string, stage: EnhancementStage, signal?: AbortSignal): Promise<H3GenerationOutput>;
  merge(checkpoint: EnhancementCheckpoint, original: Blob, outputs: {step: EnhancementStep;blob: Blob}[], signal?: AbortSignal): Promise<Blob>;
}
/** Reserve/checkpoint BEFORE POST; an interrupted reserved step is only queried, NEVER resubmitted. */
export async function executeEnhancement(checkpoint: EnhancementCheckpoint, io: EnhancementIO, options: H3GenerationOptions = {}) {
  const c = structuredClone(checkpoint);
  const check = () => options.signal?.throwIfAborted();
  check();
  if(c.finalSource && c.finalName) return {video:await io.load(c.finalSource),filename:c.finalName,promptId:c.runId};
  const original = await io.load(c.originalSource);
  for(const step of c.steps) {
    check();
    if(step.state==='completed') {
      if(!step.source || !step.filename) throw new Error('分段检查点缺少输出，停止以免重复生成');
      continue;
    }
    options.onUpdate?.({status:'preparing',stage:`${step.stage==='upscale'?'高清':'60 FPS插帧'}：第${step.segment.index+1}/${c.plan.segments.length}段`});
    let output: H3GenerationOutput;
    if(step.state!=='ready') output = await io.recover(step.promptId,step.stage,options.signal);
    else {
      const previous = c.steps.find(s=>s.stage==='upscale' && s.segment.index===step.segment.index);
      const blob = step.stage==='interpolate' && !c.interpolationOnly
        ? await io.load(previous!.source!) : await io.cut(original,c,step.segment,options.signal);
      check(); step.state='reserved'; await io.save(c); check();
      output = await io.render(step.stage,blob,`segment-${step.segment.index+1}.mp4`,{
        ...options,promptId:step.promptId,upscaleProfile:c.profile,onTiming:timing=>{step.timing=timing;},
        onJobId: id=>{ options.onJobId?.(id); },
      });
      if(output.promptId!==step.promptId) throw new Error('分段任务ID与检查点不一致，请查询原任务，不会重提');
    }
    check();
    step.source=await io.store(output.video,output.filename); step.filename=output.filename; step.state='completed';
    await io.save(c);
  }
  check();
  options.onUpdate?.({status:'fetching',stage:'合并最终视频与连续原音轨（中间段不加入画布）'});
  const stage=c.combined || c.interpolationOnly?'interpolate':'upscale';
  const outputs=[];
  for(const step of c.steps.filter(s=>s.stage===stage)) outputs.push({step,blob:await io.load(step.source!)});
  const video=await io.merge(c,original,outputs,options.signal);
  check(); c.finalName=`Frameflow_${c.combined?'1080P_60FPS':c.interpolationOnly?'60FPS':'HD'}_${c.runId}.mp4`;
  c.finalSource=await io.store(video,c.finalName); await io.save(c);
  return {video,filename:c.finalName,promptId:c.runId};
}

/** Peak for the interpolation output tensor alone, not total RAM: never label this total usage. */
export function interpolationTensorBytes(frames: number, width: number, height: number, multiplier: number) {
  return ((frames-1)*multiplier+1)*width*height*3*4;
}
export type EnhancementFile = ComfyFile;
