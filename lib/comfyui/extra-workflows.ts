import referenceTemplate from "./h3-reference-workflow.json" with { type: "json" };
import upscaleTemplate from "./seedvr2-workflow.json" with { type: "json" };
import type { H3GenerationSettings } from "@/lib/ai-adapter";
import { H3_MAX_LENGTH, H3_MIN_LENGTH } from "./h3-parameters.ts";

/** 🧪 voiceRoleIds：参考声音截前 N 秒（ComfyUI 自带 TrimAudioDuration）。没设 = 不截，和以前一样。 */
export function referenceAudioTrim(settings: Pick<H3GenerationSettings, "referenceAudioTrimSeconds">) {
  const value = settings.referenceAudioTrimSeconds;
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 1 || value > 30) throw new Error("参考声音截取秒数必须在 1～30 秒之间");
  return value;
}

export type WorkflowNode = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
export type Workflow = Record<string, WorkflowNode>;
const clone = (template: unknown) => structuredClone(template) as Workflow;
const required = (workflow: Workflow, ids: string[]) => { for (const id of ids) if (!workflow[id]) throw new Error(`API Workflow 缺少节点 ${id}`); };

export interface ReferenceNames { images: string[]; videos: string[]; audios: string[]; videoAudioFlags?: boolean[] }

export function buildReferenceWorkflow(names: ReferenceNames, prompt: string, seed: number, settings: H3GenerationSettings) {
  const workflow = clone(referenceTemplate);
  required(workflow, ["92", "115", "129", "130", "136", "138", "141", "142", "143", "144", "146"]);
  if (names.images.length > 9 || names.videos.length > 3 || names.audios.length > 3) throw new Error("参考素材超过 H3 支持的数量");
  if (!names.images.length && !names.videos.length && !names.audios.length) throw new Error("多参考生成至少需要一项参考素材");
  if (settings.length < H3_MIN_LENGTH || settings.length > H3_MAX_LENGTH || (settings.length - 5) % 17 !== 0) throw new Error("H3 时长不合法");
  workflow["138"].inputs.value = prompt;
  workflow["136"].inputs.length = settings.length;
  workflow["129"].inputs.noise_seed = seed;
  workflow["146"].inputs.value = settings.turbo;
  workflow["144"].inputs.value = 4;
  workflow["143"].inputs.value = 20;
  workflow["115"].inputs.megapixels = settings.megapixels;
  workflow["115"].inputs.multiple = settings.resolutionSteps;
  if (settings.aspect === "follow") throw new Error("多参考模式请明确选择画面比例；当前模板不支持自动跟随参考图");
  workflow["115"].inputs.aspect_ratio = ({ "16:9": "16:9 (Widescreen)", "9:16": "9:16 (Portrait Widescreen)", "1:1": "1:1 (Square)", "4:3": "4:3 (Standard)", "3:4": "3:4 (Portrait Standard)" } as Record<string, string>)[settings.aspect];
  // Keep the proven model, sampler, LoRA, VAEs and 24 FPS unchanged.
  for (const key of Object.keys(workflow["136"].inputs)) if (key.startsWith("ref_images.") || key.startsWith("ref_videos.") || key.startsWith("ref_video_audios.") || key.startsWith("ref_audios.")) delete workflow["136"].inputs[key];
  names.images.forEach((name, index) => {
    const id = `ff-image-${index}`;
    workflow[id] = { class_type: "LoadImage", inputs: { image: name } };
    workflow["136"].inputs[`ref_images.ref_image_${index}`] = [id, 0];
  });
  names.videos.forEach((name, index) => {
    const loadId = `ff-video-${index}`;
    const componentsId = `ff-video-components-${index}`;
    workflow[loadId] = { class_type: "LoadVideo", inputs: { file: name } };
    workflow[componentsId] = { class_type: "GetVideoComponents", inputs: { video: [loadId, 0] } };
    workflow["136"].inputs[`ref_videos.ref_video_${index}`] = [componentsId, 0];
    if (names.videoAudioFlags?.[index]) workflow["136"].inputs[`ref_video_audios.ref_video_audio_${index}`] = [componentsId, 1];
  });
  const trim = referenceAudioTrim(settings);
  names.audios.forEach((name, index) => {
    const id = `ff-audio-${index}`;
    workflow[id] = { class_type: "LoadAudio", inputs: { audio: name } };
    if (trim) workflow[`${id}-trim`] = { class_type: "TrimAudioDuration", inputs: { audio: [id, 0], start_index: 0, duration: trim } };
    workflow["136"].inputs[`ref_audios.ref_audio_${index}`] = [trim ? `${id}-trim` : id, 0];
  });
  if (settings.soundMode === "silent") delete workflow["130"].inputs.audio;
  // Remove unused sample inputs from the exported workflow. The actual references are injected above.
  for (const id of ["137", "148", "149", "150"]) delete workflow[id];
  return workflow;
}

export function buildSeedVR2Workflow(videoName: string, options: { profile?: "safe" | "quality"; clip?: { start: number; duration: number }; dimensions?: { width: number; height: number } } = {}) {
  const workflow = clone(upscaleTemplate);
  required(workflow, ["73", "76", "66:52", "66:51", "66:57", "66:79", "66:81", "66:105", "66:75"]);
  workflow["73"].inputs.file = videoName;
  workflow["66:57"].inputs["resize_type.multiplier"] = 2;
  // 2026-11-21 A/B：7B sharp 比 3B 更清晰自然且更快（16GB 实测 185s vs 260s，4 秒 1080×1920）。只改视频高清；单帧高清仍用模板 3B。
  workflow["66:52"].inputs.unet_name = "seedvr2_7b_sharp_int8_convrot.safetensors";
  if (options.dimensions) {
    const { width, height } = options.dimensions;
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 4096 && value % 2 === 0)) throw new Error("高清输出尺寸无效或超过4096限制");
    workflow["66:57"].inputs = { input: workflow["66:57"].inputs.input, resize_type: "scale dimensions", "resize_type.width": Math.ceil(width / 32) * 32, "resize_type.height": Math.ceil(height / 32) * 32, "resize_type.crop": "center", scale_method: "lanczos" };
    // SeedVR2 works at aligned dimensions; trim the decoded result to the exact delivery size.
    workflow["ff-1080-output"] = { class_type: "ResizeImageMaskNode", inputs: { input: workflow["66:75"].inputs.images, resize_type: "scale dimensions", "resize_type.width": width, "resize_type.height": height, "resize_type.crop": "center", scale_method: "lanczos" } };
    workflow["66:75"].inputs.images = ["ff-1080-output", 0];
    workflow["76"].inputs.filename_prefix = `video/Frameflow_${Math.min(width, height)}P`;
  }
  // Native SeedVR2 uses a dynamic manual combo (not the numz custom-node API).
  const quality = options.profile === "quality";
  workflow["66:99"].inputs.chunking_mode = "manual";
  workflow["66:99"].inputs["chunking_mode.frames_per_chunk"] = quality ? 21 : 9;
  workflow["66:99"].inputs.temporal_overlap = quality ? 1 : 0;
  for (const id of ["66:48", "66:55"]) {
    workflow[id].inputs.tile_size = 512;
    workflow[id].inputs.overlap = 128;
    workflow[id].inputs.temporal_size = quality ? 32 : 16;
    workflow[id].inputs.temporal_overlap = quality ? 8 : 4;
  }
  workflow["66:105"].inputs.value = true;
  workflow["66:81"].inputs.switch = Boolean(options.clip);
  if (options.clip) {
    if (options.clip.start < 0 || options.clip.duration <= 0) throw new Error("截取范围不合法");
    workflow["66:79"].inputs.start_time = options.clip.start;
    workflow["66:79"].inputs.duration = options.clip.duration;
  }
  return workflow;
}
