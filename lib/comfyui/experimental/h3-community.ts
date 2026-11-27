import ultimateTemplate from "./h3-community-ultimate.json" with { type: "json" };
import dialogueTemplate from "./h3-community-dialogue.json" with { type: "json" };
import type { H3GenerationSettings } from "../../ai-adapter.ts";
import { communityInputProblem, type CommunityWorkflowId } from "../../h3-workflow-options.ts";
import { calculateH3Dimensions, H3_MIN_LENGTH, H3_MAX_LENGTH, H3_MIN_MEGAPIXELS, H3_MAX_MEGAPIXELS } from "../h3-parameters.ts";
import { referenceAudioTrim, type Workflow } from "../extra-workflows.ts";
import { parseCommunityValues, applyCommunityValues } from './h3-community-controls.ts';
import { checkTimeAnchors, insertTimeAnchorChain, type TimeAnchorFrame } from './h3-ultimate-guide.ts';

export const COMMUNITY_SAVE_NODE_ID = "148";

/** Generation size node 136 receives; time-anchor images are cropped to it before upload. */
export function communityDimensions(settings: Pick<H3GenerationSettings, "aspect" | "megapixels" | "communityParameters">, sourceWidth = 0, sourceHeight = 0) {
  const overrides = parseCommunityValues(settings.communityParameters);
  return calculateH3Dimensions(sourceWidth, sourceHeight, settings.aspect, settings.megapixels, Number(overrides['115.multiple'] ?? 32));
}
export const COMMUNITY_SAMPLER_NODE_ID = "125";
export function communityTemplate(id: CommunityWorkflowId) {
  if (id === "community-ultimate") return { template: ultimateTemplate, file: "experimental/h3-community-ultimate.json" };
  if (id === "community-dialogue") return { template: dialogueTemplate, file: "experimental/h3-community-dialogue.json" };
  throw new Error("社区工作流无法识别；不会自动切换模型");
}

/** Only substitute user media/prompt/seed/output settings; all model and sampling choices stay frozen. */
export function buildCommunityWorkflow(id: CommunityWorkflowId, images: string[], prompt: string, seed: number, settings: H3GenerationSettings, sourceWidth = 0, sourceHeight = 0, keyframes?: { first?: number; last?: number }, audios: string[] = [], anchors: readonly TimeAnchorFrame[] = []) {
  const indices = [keyframes?.first, keyframes?.last].filter((n): n is number => n !== undefined);
  if (keyframes && (!indices.length || !indices.every((n) => Number.isInteger(n) && n >= 1 && n <= images.length) || new Set(indices).size !== indices.length || (keyframes.first !== undefined && keyframes.first !== 1) || (keyframes.last !== undefined && keyframes.last !== (keyframes.first ? 2 : 1)))) throw new Error("首尾帧必须排在参考图之前，且不能重复");
  const problem = communityInputProblem({ pictures: images.length, audios: audios.length, keyframeCount: indices.length, guides: anchors.length });
  if (problem) throw new Error(problem);
  // Validate before anything is built; spacing warnings are surfaced by the caller's review, not here.
  const checkedAnchors = anchors.length ? checkTimeAnchors(anchors, settings.length, { first: Boolean(keyframes?.first), last: Boolean(keyframes?.last) }).anchors : [];
  if (!images.every((name) => name.trim())) throw new Error("参考图文件名不能为空");
  if (!audios.every((name) => name.trim())) throw new Error("参考声音文件名不能为空");
  if (!prompt.trim()) throw new Error("请先填写 Prompt");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Seed 必须是非负安全整数");
  if (!Number.isInteger(settings.length) || settings.length < H3_MIN_LENGTH || settings.length > H3_MAX_LENGTH || (settings.length - 5) % 17) throw new Error("H3 时长不是合法的17k+5帧数");
  if (!Number.isFinite(settings.megapixels) || settings.megapixels < H3_MIN_MEGAPIXELS || settings.megapixels > H3_MAX_MEGAPIXELS) throw new Error("像素预算必须在0.30MP到1.00MP之间");
  if (settings.fps !== 24 || settings.resolutionSteps !== 32) throw new Error("这两个工作流固定24 FPS、32像素步进");
  const overrides = parseCommunityValues(settings.communityParameters);
  const dimensions = calculateH3Dimensions(sourceWidth, sourceHeight, settings.aspect, settings.megapixels, Number(overrides['115.multiple'] ?? 32));
  if (!dimensions || !Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) || dimensions.width < 32 || dimensions.height < 32) throw new Error("无法确定参考图比例，请选择明确比例或等待图片尺寸加载");
  const workflow = structuredClone(communityTemplate(id).template) as Workflow;
  workflow["138"].inputs.value = prompt;
  workflow["129"].inputs.noise_seed = seed;
  workflow["132"].inputs.value = settings.length / 24;
  workflow["136"].inputs.length = settings.length;
  workflow["136"].inputs.width = dimensions.width;
  workflow["136"].inputs.height = dimensions.height;
  workflow["115"].inputs.megapixels = settings.megapixels;
  workflow["150"].inputs.preview_frames = settings.length;
  for (const key of Object.keys(workflow["136"].inputs)) if (key.startsWith("ref_images.")) delete workflow["136"].inputs[key];
  for (const nodeId of ["137", "139", "167", "173"]) delete workflow[nodeId];
  images.forEach((name, index) => {
    const nodeId = `ff-community-image-${index}`;
    workflow[nodeId] = { class_type: "LoadImage", inputs: { image: name } };
    workflow["136"].inputs[`ref_images.ref_image_${index}`] = [nodeId, 0];
  });
  if (keyframes || images.length === 0) {
    const refs = images.map((_, index) => index + 1).filter((index) => !indices.includes(index));
    const inputs: Record<string, unknown> = {
      clip: ["128", 0], video_vae: ["119", 0], audio_vae: ["120", 0], prompt,
      width: dimensions.width, height: dimensions.height, length: settings.length,
      task_type: !keyframes ? audios.length ? "Ref2VA" : "T2VA" : refs.length || audios.length ? "Hybrid" : keyframes.first ? keyframes.last ? "FL2VA" : "I2VA" : "L2VA",
      audio_mode: "native", audio_denoise_strength: 1, add_source_as_reference: false,
      prompt_primary_audio_ordinal: 0, strict_prompt_tags: true, ref_image_size: "match",
      reference_video_policy: "official_2_to_15s",
    };
    if (keyframes?.first) inputs.first_frame = [`ff-community-image-${keyframes.first - 1}`, 0];
    if (keyframes?.last) inputs.last_frame = [`ff-community-image-${keyframes.last - 1}`, 0];
    refs.forEach((picture, index) => { inputs[`ref_images.ref_image_${index}`] = [`ff-community-image-${picture - 1}`, 0]; });
    workflow["136"] = { class_type: "MiniMaxH3AudioConditioningT8", inputs };
  }
  // Optional experimental voice route: preserve the frozen model / LoRA / sampler graph.
  for (const key of Object.keys(workflow["136"].inputs)) if (key.startsWith("ref_audios.")) delete workflow["136"].inputs[key];
  const trim = referenceAudioTrim(settings);
  audios.forEach((name, index) => {
    const nodeId = `ff-community-audio-${index}`;
    workflow[nodeId] = { class_type: "LoadAudio", inputs: { audio: name } };
    if (trim) workflow[`${nodeId}-trim`] = { class_type: "TrimAudioDuration", inputs: { audio: [nodeId, 0], start_index: 0, duration: trim } };
    workflow["136"].inputs[`ref_audios.ref_audio_${index}`] = [trim ? `${nodeId}-trim` : nodeId, 0];
  });
  workflow["148"].inputs.filename_prefix = `video/Frameflow_H3_${id === "community-ultimate" ? "ultimate" : "dialogue"}`;
  applyCommunityValues(id, workflow, overrides);
  if (settings.soundMode === "silent") delete workflow["148"].inputs.audio;
  // 🧪 h3_ultimate_guide: AddGuide chain between 136 and BasicGuider 126; model / LoRA / sampler untouched.
  if (checkedAnchors.length) insertTimeAnchorChain(workflow as Parameters<typeof insertTimeAnchorChain>[0], checkedAnchors);
  return workflow;
}
