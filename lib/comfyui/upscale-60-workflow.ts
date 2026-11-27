import {buildSeedVR2Workflow, type Workflow} from "./extra-workflows.ts";
import {buildFilmWorkflow,film60Plan} from "./film-workflow.ts";
/** Same conservative CPU tensor budget as standalone FILM, applied at HD dimensions. */
export function assertWholeUpscale60Budget(frames:number,inputFps:number,dimensions:{width:number;height:number},clip?:{start:number;duration:number}){
  const count=clip?Math.min(frames,Math.ceil(clip.duration*inputFps)):frames;
  if(!Number.isFinite(count)||count<1)throw Error('整段高清插帧无法核实帧数，请选择分段高清');
  const plan=film60Plan(inputFps);
  const bytes=(count*plan.multiplier+1)*dimensions.width*dimensions.height*3*4;
  if(bytes>6*1024**3)throw Error(`整段内存预检未通过：插帧中间张量约${(bytes/1024**3).toFixed(1)} GiB，超过6 GiB安全预算；未提交渲染，请改分段或启用夜间容错`);
  return bytes;
}
/** One ComfyUI job, one SaveVideo: the HD stage never writes a visible intermediate file. */
export function buildUpscale60Workflow(videoName:string, inputFps:number, dimensions:{width:number;height:number}, clip?:{start:number;duration:number},profile:'safe'|'quality'='safe'):Workflow {
  const workflow = buildSeedVR2Workflow(videoName,{dimensions,clip,profile});
  const film = buildFilmWorkflow(videoName,inputFps);
  delete film["4"]; delete film["7"];
  for(const [id,node] of Object.entries(film)) {
    if(workflow[id]) throw new Error("高清插帧节点编号冲突");
    workflow[id]=node;
  }
  workflow["16:3"].inputs.video=["66:75",0];
  workflow["76"].inputs.video=["16:5",0];
  workflow["76"].inputs.filename_prefix="video/Frameflow_1080P_60FPS";
  return workflow;
}
