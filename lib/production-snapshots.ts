import { buildUpscale60Workflow } from "./comfyui/upscale-60-workflow.ts";
import type { CapabilityId, RunRecord } from "./production-records.ts";
import type { H3GenerationSettings } from "./ai-adapter.ts";
import { buildH3Workflow } from "./comfyui/h3-adapter.ts";
import { buildReferenceWorkflow, buildSeedVR2Workflow } from "./comfyui/extra-workflows.ts";
import { buildFilmWorkflow, film60Plan } from "./comfyui/film-workflow.ts";
import { calculateH3Dimensions } from "./comfyui/h3-parameters.ts";
import { buildH3T2vaWorkflow, H3_T2VA_TEMPLATE, H3_T2VA_TEMPLATE_FILE, t2vaAspect, t2vaDimensions } from "./comfyui/h3-t2va.ts";
import { h3EngineClassTypes } from "./comfyui/engine-info.ts";
import { buildH3AddGuideWorkflow, H3_ADDGUIDE_EXPERIMENTAL, H3_ADDGUIDE_TEMPLATE, H3_ADDGUIDE_TEMPLATE_FILE, normalizeGuides } from "./comfyui/experimental/h3-addguide.ts";
import { H3_ULTIMATE_GUIDE } from "./comfyui/experimental/h3-ultimate-guide.ts";

/** One time anchor as stored on the Run: what was requested and which frame / image it became. */
export interface TimeAnchorRecord { atSeconds: number; frameIdx: number; assetId?: string; filename?: string; asReference?: boolean; source?: "node" | "director" | "queue" }
import h3Template from "./comfyui/h3-workflow.json" with { type: "json" };
import referenceTemplate from "./comfyui/h3-reference-workflow.json" with { type: "json" };
import upscaleTemplate from "./comfyui/seedvr2-workflow.json" with { type: "json" };
import filmTemplate from "./comfyui/film-workflow.json" with { type: "json" };
import { isCommunityWorkflow, communityInputProblem, LEGACY_H3_RETIRED_MESSAGE } from "./h3-workflow-options.ts";
import { buildCommunityWorkflow, communityTemplate, COMMUNITY_SAVE_NODE_ID } from "./comfyui/experimental/h3-community.ts";
import { parseCommunityValues, communityActualSteps } from './comfyui/experimental/h3-community-controls.ts';

type Snapshot = Pick<RunRecord, "capabilityId" | "parameters" | "workflowIdentity">;
type WorkflowNode = { inputs: Record<string, unknown> };
type Workflow = Record<string, WorkflowNode>;
const field = (workflow: Workflow, node: string, name: string) => workflow[node]?.inputs[name];

async function identity(capabilityId: CapabilityId, templateFile: string, template: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(template));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { capabilityId, templateVersion: `sha256:${hex}`, templateFile };
}

/** Build from the same frozen builders used by the adapter, without submitting anything. */
export async function snapshotH3(input: {
  communityKeyframes?: { first?: number; last?: number };
  workflowOptionId?: string;
  referenceMode: boolean;
  prompt: string;
  seed: number;
  settings: H3GenerationSettings;
  sourceWidth: number;
  sourceHeight: number;
  hasLastFrame: boolean;
  referenceCounts: { images: number; videos: number; audios: number; videoAudioFlags: boolean[] };
  /** T2VA: separate template, same capability / model family as FL2VA. Other modes are unchanged. */
  taskMode?: "t2va";
  /** 🧪 AddGuide anchors (I2VA only): experimental capability and template. */
  guides?: { frameIdx: number }[];
  /** 🧪 h3_ultimate_guide: community time anchors, recorded on the Run (frame, seconds, image, reference flag). */
  timeAnchors?: TimeAnchorRecord[];
}): Promise<Snapshot> {
  const { settings, referenceMode } = input;
  // Retired video extension: never fall through to another graph.
  if (input.workflowOptionId === "h3-extend") throw new Error(LEGACY_H3_RETIRED_MESSAGE);
  if (isCommunityWorkflow(input.workflowOptionId)) {
    const anchors = input.timeAnchors ?? [];
    const problem = communityInputProblem({ pictures: input.referenceCounts.images, videos: input.referenceCounts.videos, audios: input.referenceCounts.audios, keyframeCount: Object.keys(input.communityKeyframes ?? {}).length, hasLastFrame: input.hasLastFrame, guides: anchors.length || input.guides?.length });
    if (problem) throw new Error(problem);
    const workflow = buildCommunityWorkflow(input.workflowOptionId, Array.from({ length: input.referenceCounts.images }, (_, i) => `image-${i}.png`), input.prompt, input.seed, settings, input.sourceWidth, input.sourceHeight, input.communityKeyframes, Array.from({ length: input.referenceCounts.audios }, (_, i) => `audio-${i}.wav`), anchors.map((anchor, i) => ({ imageName: `anchor-${i}.png`, frameIdx: anchor.frameIdx })));
    const { template, file } = communityTemplate(input.workflowOptionId);
    const values = parseCommunityValues(settings.communityParameters);
    const custom = Object.keys(values).length > 0;
    const capabilityId: CapabilityId = anchors.length ? H3_ULTIMATE_GUIDE : "h3_ref2va";
    const audioExperiment = input.referenceCounts.audios > 0;
    if (anchors.length) return { capabilityId, parameters: {
      workflowOptionId: input.workflowOptionId, mode: "community_time_anchors_experimental", experimental: true, acceptance: "not_render_tested", saveNodeId: COMMUNITY_SAVE_NODE_ID,
      timeAnchors: [...anchors].sort((a, b) => a.frameIdx - b.frameIdx).map((anchor) => ({ ...anchor })), anchorFrames: anchors.map((anchor) => anchor.frameIdx).sort((a, b) => a - b), anchorCrop: "center_to_generation_size",
      communityKeyframes: input.communityKeyframes ?? null, referenceAudioCount: input.referenceCounts.audios, ...(custom ? { communityParameters: values } : {}),
      steps: communityActualSteps(input.workflowOptionId, values), loraStrength: field(workflow, '145', 'strength_model'), sampler: field(workflow, '123', 'sampler_name'), sparseAttention: field(workflow, '165', 'selection'),
      seed: input.seed, fps: field(workflow, '148', 'frame_rate'), length: settings.length, duration: settings.length / Number(field(workflow, '148', 'frame_rate')), generationFps: 24,
      width: field(workflow, "136", "width"), height: field(workflow, "136", "height"), megapixels: settings.megapixels, aspectRatio: settings.aspect,
      soundMode: settings.soundMode ?? "av", model: field(workflow, "127", "unet_name"), textEncoder: field(workflow, "128", "clip_name"),
      lora: field(workflow, "145", "lora_name"), videoVae: field(workflow, "119", "vae_name"), audioVae: field(workflow, "120", "vae_name"),
    }, workflowIdentity: await identity(capabilityId, `experimental/h3-${input.workflowOptionId}-time-anchors${input.communityKeyframes || input.referenceCounts.images === 0 ? "-T8" : ""}`, workflow) };
    return { capabilityId, parameters: {
      workflowOptionId: input.workflowOptionId, mode: audioExperiment ? "community_voice_experimental" : input.communityKeyframes ? "community_keyframes_experimental" : input.referenceCounts.images === 0 ? "community_text_experimental" : "reference", communityKeyframes: input.communityKeyframes ?? null, referenceAudioCount: input.referenceCounts.audios, acceptance: audioExperiment || input.communityKeyframes || input.referenceCounts.images === 0 ? "not_render_tested" : "existing_reference_route", saveNodeId: COMMUNITY_SAVE_NODE_ID,
      ...(input.referenceCounts.images > 4 ? { acceptance: "not_render_tested", expandedReferenceCount: input.referenceCounts.images } : {}),
      ...(custom ? { acceptance: 'not_render_tested', communityParameters: values } : {}),
      steps: communityActualSteps(input.workflowOptionId, values), loraStrength: field(workflow, '145', 'strength_model'), sampler: field(workflow, '123', 'sampler_name'), sparseAttention: field(workflow, '165', 'selection'),
      seed: input.seed, fps: field(workflow, '148', 'frame_rate'), length: settings.length, duration: settings.length / Number(field(workflow, '148', 'frame_rate')), generationFps: 24,
      width: field(workflow, "136", "width"), height: field(workflow, "136", "height"), megapixels: settings.megapixels, aspectRatio: settings.aspect,
      soundMode: settings.soundMode ?? "av", model: field(workflow, "127", "unet_name"), textEncoder: field(workflow, "128", "clip_name"),
      lora: field(workflow, "145", "lora_name"), videoVae: field(workflow, "119", "vae_name"), audioVae: field(workflow, "120", "vae_name"),
    }, workflowIdentity: await identity(capabilityId, custom ? `experimental/h3-${input.workflowOptionId}-custom-parameters` : audioExperiment ? `experimental/h3-${input.workflowOptionId}-voice${input.communityKeyframes ? "-keyframes-T8" : ""}` : input.communityKeyframes ? `experimental/h3-${input.workflowOptionId}-keyframes-T8` : input.referenceCounts.images === 0 ? `experimental/h3-${input.workflowOptionId}-text-T8` : file, custom || audioExperiment || input.communityKeyframes || input.referenceCounts.images === 0 ? workflow : template) };
  }
  if (input.taskMode === "t2va") return snapshotH3T2va(input.prompt, input.seed, settings);
  const guides = input.guides?.length ? normalizeGuides(input.guides.map((guide, index) => ({ imageName: `guide-${index}.png`, frameIdx: guide.frameIdx })), settings.length) : null;
  if (guides && (referenceMode || input.hasLastFrame)) throw new Error("🧪 引导锚点只支持首帧图生视频（I2VA）");
  const workflow = guides ? buildH3AddGuideWorkflow("first.png", input.prompt, input.seed, settings, guides) : referenceMode
    ? buildReferenceWorkflow({ images: Array.from({ length: input.referenceCounts.images }, (_, i) => `image-${i}`), videos: Array.from({ length: input.referenceCounts.videos }, (_, i) => `video-${i}`), audios: Array.from({ length: input.referenceCounts.audios }, (_, i) => `audio-${i}`), videoAudioFlags: input.referenceCounts.videoAudioFlags }, input.prompt, input.seed, settings)
    : buildH3Workflow("first.png", input.prompt, input.seed, settings, input.hasLastFrame ? "last.png" : undefined);
  const capabilityId: CapabilityId = guides ? H3_ADDGUIDE_EXPERIMENTAL : referenceMode ? "h3_ref2va" : "h3_fl2va";
  const dimensions = calculateH3Dimensions(input.sourceWidth, input.sourceHeight, settings.aspect, settings.megapixels, settings.resolutionSteps);
  const parameters = referenceMode ? {
    mode: "reference", turbo: field(workflow, "146", "value"), steps: settings.turbo ? field(workflow, "144", "value") : field(workflow, "143", "value"),
    seed: field(workflow, "129", "noise_seed"), fps: field(workflow, "130", "fps"), length: field(workflow, "136", "length"), duration: settings.length / settings.fps,
    // ResolutionSelector resolves dimensions inside ComfyUI; the exact output is recorded on the resulting Asset.
    width: null, height: null, megapixels: field(workflow, "115", "megapixels"), aspectRatio: settings.aspect,
    soundMode: settings.soundMode ?? "av", sampler: settings.turbo ? "MiniMaxH3TurboSampler" : field(workflow, "123", "sampler_name"),
    lora: field(workflow, "145", "lora_name"), loraStrength: field(workflow, "145", "strength_model"), model: field(workflow, "127", "unet_name"),
    videoVae: field(workflow, "119", "vae_name"), audioVae: field(workflow, "120", "vae_name"), textEncoder: field(workflow, "128", "clip_name"),
  } : {
    mode: guides ? "first+guides" : input.hasLastFrame ? "first-last" : "first", ...(guides ? { anchorFrames: guides.map((guide) => guide.frameIdx), experimental: true } : {}), turbo: field(workflow, "25", "value"), steps: settings.turbo ? field(workflow, "27", "value") : field(workflow, "28", "value"),
    seed: field(workflow, "10", "noise_seed"), fps: field(workflow, "14", "fps"), length: field(workflow, "6", "length"), duration: settings.length / settings.fps,
    width: dimensions?.width ?? null, height: dimensions?.height ?? null, megapixels: field(workflow, "21", "megapixels"), aspectRatio: settings.aspect,
    soundMode: settings.soundMode ?? "av", sampler: settings.turbo ? "MiniMaxH3TurboSampler" : field(workflow, "26", "sampler_name"),
    lora: field(workflow, "5", "lora_name"), loraStrength: field(workflow, "5", "strength"), model: field(workflow, "1", "unet_name"),
    videoVae: field(workflow, "3", "vae_name"), audioVae: field(workflow, "4", "vae_name"), textEncoder: field(workflow, "2", "clip_name"),
  };
  if (guides) return { capabilityId, parameters, workflowIdentity: await identity(capabilityId, H3_ADDGUIDE_TEMPLATE_FILE, H3_ADDGUIDE_TEMPLATE) };
  return { capabilityId, parameters, workflowIdentity: await identity(capabilityId, referenceMode ? "h3-reference-workflow.json" : "h3-workflow.json", referenceMode ? referenceTemplate : h3Template) };
}

async function snapshotH3T2va(prompt: string, seed: number, settings: H3GenerationSettings): Promise<Snapshot> {
  const workflow = buildH3T2vaWorkflow(prompt, seed, settings) as Workflow;
  const { width, height } = t2vaDimensions(settings);
  const capabilityId: CapabilityId = "h3_fl2va";
  const parameters = {
    mode: "text", turbo: field(workflow, "25", "value"), steps: settings.turbo ? field(workflow, "27", "value") : field(workflow, "28", "value"),
    seed: field(workflow, "10", "noise_seed"), fps: field(workflow, "14", "fps"), length: field(workflow, "6", "length"), duration: settings.length / settings.fps,
    width, height, megapixels: settings.megapixels, aspectRatio: t2vaAspect(settings.aspect),
    soundMode: settings.soundMode ?? "av", sampler: settings.turbo ? "MiniMaxH3TurboSampler" : field(workflow, "26", "sampler_name"),
    lora: field(workflow, "5", "lora_name"), loraStrength: field(workflow, "5", "strength"), model: field(workflow, "1", "unet_name"),
    videoVae: field(workflow, "3", "vae_name"), audioVae: field(workflow, "4", "vae_name"), textEncoder: field(workflow, "2", "clip_name"),
  };
  return { capabilityId, parameters, workflowIdentity: await identity(capabilityId, H3_T2VA_TEMPLATE_FILE, H3_T2VA_TEMPLATE) };
}

/** H3 node classes a mode will run (for the Run engine record), read from the actual templates. */
export function h3ClassTypesFor(mode: "t2va" | "i2va" | "fl2va" | "ref2va" | "i2va_guide", workflowOptionId?: string) {
  if (isCommunityWorkflow(workflowOptionId)) return h3EngineClassTypes(communityTemplate(workflowOptionId).template);
  const template = (mode === "ref2va" ? referenceTemplate : mode === "t2va" ? H3_T2VA_TEMPLATE : mode === "i2va_guide" ? H3_ADDGUIDE_TEMPLATE : h3Template) as Record<string, { class_type: string }>;
  return h3EngineClassTypes(template);
}

export async function snapshotUpscale(clip: { start: number; duration: number } | undefined, inputWidth?: number, inputHeight?: number, dimensions?: { width: number; height: number },profile:'safe'|'quality'='safe'): Promise<Snapshot> {
  const workflow = buildSeedVR2Workflow("input.mp4", { clip, dimensions, profile });
  const capabilityId = "seedvr2_upscale";
  return { capabilityId, parameters: { upscaleProfile: profile, scale: dimensions && inputWidth ? dimensions.width / inputWidth : field(workflow, "66:57", "resize_type.multiplier"), targetResolution: dimensions ? `${Math.min(dimensions.width, dimensions.height)}p` : "2x", splitLatent: field(workflow, "66:105", "value"), inputWidth: inputWidth ?? null, inputHeight: inputHeight ?? null, outputWidth: dimensions?.width ?? (inputWidth ? inputWidth * 2 : null), outputHeight: dimensions?.height ?? (inputHeight ? inputHeight * 2 : null), clip: clip ?? null, model: field(workflow, "66:52", "unet_name"), vae: field(workflow, "66:51", "vae_name") }, workflowIdentity: await identity(capabilityId, "seedvr2-workflow.json", workflow) };
}

export async function snapshotFilm(inputFps: number | null): Promise<Snapshot> {
  if (inputFps === null) throw new Error("无法识别输入帧率，不能生成60 FPS");
  const plan = film60Plan(inputFps);
  const workflow = buildFilmWorkflow("input.mp4", inputFps);
  const capabilityId = "film_interpolation";
  const multiplier = plan.multiplier;
  return { capabilityId, parameters: { inputFps, multiplier, outputFps: plan.outputFps, selectEvery: plan.selectEvery, intermediateFps: plan.intermediateFps, applyMultiplierToFps: false, model: field(workflow, "16:1", "model_name") }, workflowIdentity: await identity(capabilityId, "film-workflow.json", workflow) };
}

export async function snapshotUpscale60(inputFps:number, inputWidth:number, inputHeight:number, dimensions:{width:number;height:number}, clip?:{start:number;duration:number},profile:'safe'|'quality'='safe'):Promise<Snapshot> {
  const snapshot=await snapshotUpscale(clip,inputWidth,inputHeight,dimensions,profile);
  const workflow=buildUpscale60Workflow("input.mp4",inputFps,dimensions,clip,profile);
  return {...snapshot,parameters:{...snapshot.parameters,combined1080p60:true,...film60Plan(inputFps),acceptance:"not_render_tested"},
    workflowIdentity:await identity("seedvr2_upscale","upscale-60-workflow.ts",workflow)};
}
