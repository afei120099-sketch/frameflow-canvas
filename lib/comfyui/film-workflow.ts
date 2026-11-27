import template from "./film-workflow.json" with { type: "json" };
import type { Workflow } from "./extra-workflows.ts";

export const FILM_SAVE_NODE_ID = "7";
export const FILM_INTERPOLATE_NODE_ID = "16:2";

export const FILM_TARGET_FPS = 60;
export function film60Plan(inputFps: number) {
  if (!Number.isFinite(inputFps) || inputFps < 1 || inputFps > 240 || Math.abs(inputFps - Math.round(inputFps)) > 0.0001) throw new Error("60 FPS 插帧目前需要已识别的整数源帧率；不会直接改播放速度");
  const fps = Math.round(inputFps);
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(fps, FILM_TARGET_FPS);
  const multiplier = FILM_TARGET_FPS / divisor;
  const selectEvery = fps / divisor;
  if (multiplier > 16) throw new Error("源帧率转换到60 FPS所需倍率超过插帧模型限制");
  return { inputFps: fps, outputFps: FILM_TARGET_FPS, multiplier, selectEvery, intermediateFps: fps * multiplier };
}

export function buildFilmWorkflow(videoName: string, inputFps = 24): Workflow {
  if (!videoName.trim()) throw new Error("输入视频不可用");
  const workflow = structuredClone(template) as Workflow;
  const expected: Record<string, string> = { "4": "LoadVideo", "7": "SaveVideo", "16:1": "FrameInterpolationModelLoader", "16:2": "FrameInterpolate", "16:3": "GetVideoComponents", "16:5": "CreateVideo", "16:9": "PrimitiveInt", "16:10": "ComfySwitchNode", "16:11": "ComfyMathExpression", "16:13": "PrimitiveBoolean" };
  for (const [id, classType] of Object.entries(expected)) if (workflow[id]?.class_type !== classType) throw new Error(`插帧 API Workflow 缺少节点 ${id}`);
  if (workflow["16:1"].inputs.model_name !== "film_net_fp16.safetensors" || workflow["16:9"].inputs.value !== 2 || workflow["16:13"].inputs.value !== true) throw new Error("插帧 API Workflow 的已验证参数发生变化");
  const plan = film60Plan(inputFps);
  workflow["4"].inputs.file = videoName;
  workflow["16:9"].inputs.value = Math.max(2, plan.multiplier);
  // FILM returns (N-1)*multiplier+1. Duplicate only the terminal frame, then trim
  // to round(N*60/sourceFPS), so the last interval and original audio duration survive.
  if(plan.multiplier > 1) {
    workflow["ff-film-last"] = {class_type:"ImageFromBatch",inputs:{image:["16:3",0],batch_index:-1,length:1}};
    workflow["ff-film-pad"] = {class_type:"ImageBatch",inputs:{image1:["16:3",0],image2:["ff-film-last",0]}};
    workflow["16:2"].inputs.images = ["ff-film-pad",0];
  }
  const interpolated = plan.multiplier === 1 ? ["16:3", 0] : ["16:2", 0];
  workflow["ff-film-60"] = {class_type:"VHS_SelectEveryNthImage", inputs:{images:interpolated,select_every_nth:plan.selectEvery,skip_first_images:0}};
  workflow["ff-film-count"]={class_type:"GetImageSize",inputs:{image:["16:3",0]}};
  workflow["ff-film-length"]={class_type:"ComfyMathExpression",inputs:{expression:`round(a * 60 / ${plan.inputFps})`,"values.a":["ff-film-count",2]}};
  workflow["ff-film-trim"]={class_type:"ImageFromBatch",inputs:{image:["ff-film-60",0],batch_index:0,length:["ff-film-length",1]}};
  workflow["16:5"].inputs.images = ["ff-film-trim", 0];
  workflow["16:5"].inputs.fps = FILM_TARGET_FPS;
  workflow["7"].inputs.filename_prefix = "video/Frameflow_60FPS";
  return workflow;
}
