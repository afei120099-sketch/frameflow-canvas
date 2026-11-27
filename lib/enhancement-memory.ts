import {film60Plan} from './comfyui/film-workflow.ts';
import {planUpscaleSegments,type SegmentedUpscalePlan} from './segmented-upscale.ts';
/** Cap the interpolation OUTPUT tensor alone to 6 GiB. Other live tensors/cache still consume RAM. */
export const INTERPOLATION_OUTPUT_LIMIT=6*1024**3;
export function boundInterpolationPlan(plan:SegmentedUpscalePlan):SegmentedUpscalePlan {
  const {multiplier}=film60Plan(plan.fps),width=plan.outputWidth??plan.width*2,height=plan.outputHeight??plan.height*2;
  const maxInput=Math.floor((INTERPOLATION_OUTPUT_LIMIT/(width*height*3*4)-1)/Math.max(1,multiplier));
  if(maxInput<3)throw new Error('目标尺寸超出安全插帧预算，不会自动降分辨率');
  const context=Math.min(8,Math.floor((maxInput-1)/4));
  const seconds=Math.min(1,(maxInput-2*context)/plan.fps);
  return {...plan,segments:planUpscaleSegments(plan.frames,plan.fps,seconds,context)};
}
