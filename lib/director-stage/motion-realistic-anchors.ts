import { H3_MIN_LENGTH, H3_MAX_LENGTH, H3_LENGTH_GRID, H3_LENGTH_OFFSET } from "../comfyui/h3-parameters.ts";
import { sdxlDepthPrompt } from "../comfyui/sdxl-depth-firstframe.ts";
import { drivingMotion, sampleMotion } from "./motion-anim.ts";
import type { Camera, Motion, Prop, Scene } from "./schema.ts";
import { listMotions } from "./store.ts";
import { buildRenderJob, loadJob } from "./whitebox-firstframe.ts";
import { generateDepthFirstFrame, type DepthFirstFrameDeps, type DepthFirstFrameResult } from "./depth-firstframe.ts";

/** Resolve all scene tracks exactly as the 3D preview, preferring the selected Motion on its target. */
export function motionPoseSnapshot(scene: Scene, props: Prop[], cameras: Camera[], motions: Motion[], motionId: string, frame: number, cameraId: string) {
  const own = motions.filter((motion) => motion.sceneId === scene.id);
  const selected = own.find((motion) => motion.id === motionId);
  if (!selected) throw new Error("所选 Motion 不属于当前场景或已删除");
  if (selected.targetType === "camera" && selected.targetId !== cameraId) throw new Error("摄影机 Motion 请使用它对应的渲染机位");
  const keyframe = selected.keyframes.find((key) => key.frame === frame);
  if (!keyframe?.transform) throw new Error(`f${frame} 没有空间 transform，文字关键帧不能生成写实锚点`);
  if (!(selected.targetType === "prop" ? props : cameras).some((target) => target.id === selected.targetId && target.sceneId === scene.id)) throw new Error("Motion 的目标已不存在");
  const pose = <T extends Prop | Camera>(target: T, kind: "prop" | "camera"): T => {
    const track = drivingMotion(own.filter((motion) => motion.targetType === kind), target.id, motionId);
    const transform = track ? sampleMotion(track.keyframes, frame) : null;
    return structuredClone(transform ? { ...target, transform: { ...transform, ...(kind === "camera" ? { scale: [1, 1, 1] } : {}) } } : target) as T;
  };
  return { scene: structuredClone(scene), job: buildRenderJob(structuredClone(scene), props.map((prop) => pose(prop, "prop")), cameras.map((camera) => pose(camera, "camera")), cameraId) };
}

export function validateMotionGuideFrames(motion: Motion, frames: number[], length: number) {
  if (!Number.isInteger(length) || length < H3_MIN_LENGTH || length > H3_MAX_LENGTH || (length - H3_LENGTH_OFFSET) % H3_LENGTH_GRID) throw new Error("请选择合法的 H3 生成长度");
  if (!frames.length || frames.length > 4 || new Set(frames).size !== frames.length) throw new Error("请选择 1–4 个不重复的空间关键帧");
  for (const frame of frames) {
    if (frame === 0) throw new Error("f0 用于首帧，不能创建 guide");
    if (!Number.isInteger(frame) || frame < 1 || frame >= length) throw new Error(`f${frame} 越界：guide 须位于 1–${length - 1}`);
    if (!motion.keyframes.find((key) => key.frame === frame)?.transform) throw new Error(`f${frame} 没有空间 transform，文字关键帧不能生成写实锚点`);
  }
  return [...frames].sort((a, b) => a - b);
}

/** Validate and freeze the entire batch before any render/upload; run sequentially on the single GPU. */
export async function generateMotionRealisticAnchors(input: { sceneId: string; cameraId: string; motionId: string; frames: number[]; length: number; prompt: string }, deps: DepthFirstFrameDeps & { onResult?: (result: DepthFirstFrameResult) => void }) {
  if (!input.prompt.trim()) throw new Error("请填写写实画面描述");
  sdxlDepthPrompt(input.prompt); // Validate before any source render / asset registration.
  const { scene, job } = await loadJob(input.sceneId, input.cameraId);
  const motions = await listMotions(input.sceneId);
  const motion = motions.find((item) => item.id === input.motionId);
  if (!motion) throw new Error("Motion 已删除，请重新选择");
  const frames = validateMotionGuideFrames(motion, input.frames, input.length);
  const snapshots = frames.map((frame) => motionPoseSnapshot(scene, job.director.props, job.director.cameras, motions, motion.id, frame, input.cameraId));
  const batchId = crypto.randomUUID();
  const results: DepthFirstFrameResult[] = [];
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    try {
      const result = await generateDepthFirstFrame(input.sceneId, input.cameraId, input.prompt, {
        ...deps, snapshot: snapshots[index], guideSource: { motionId: motion.id, frame, generationLength: input.length, batchId },
        comfy: { ...deps.comfy, onStage: (stage) => deps.comfy?.onStage?.(`f${frame}（${index + 1}/${frames.length}）· ${stage}`) },
      });
      results.push(result); deps.onResult?.(result);
    } catch (cause) {
      throw new Error(`f${frame} 失败；已完成 ${results.length} 个锚点及已登记素材保留：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return results;
}
