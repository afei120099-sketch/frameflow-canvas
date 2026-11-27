import type { H3GenerationSettings } from "../ai-adapter.ts";
import { buildFluxDev } from "../comfyui/flux-dev.ts";
import { COMMUNITY_SAVE_NODE_ID } from "../comfyui/experimental/h3-community.ts";
import { UNDERSTANDING_VALUES } from "../comfyui/experimental/h3-community-controls.ts";
import { planH3Submission } from "../comfyui/h3-adapter.ts";
import { prepareH3ReferenceSubmission } from "../h3-reference-submission.ts";
import { resolveH3Speaker } from "../h3-speaker-policy.ts";
import { H3_FPS, H3_RESOLUTION_STEPS, H3_UPSCALE_METHOD, secondsToH3Length } from "../comfyui/h3-parameters.ts";
import { buildStoryboardPrompt, STORYBOARD_FLUX, STORYBOARD_SIZES } from "../keyframe-storyboard.ts";
import type { Episode, ShotSpec, Task } from "./types.ts";

/**
 * ComfyUI graphs for production tasks, built with the same builders the canvas uses, so a production
 * keyframe or video is the same request the canvas would send for the same inputs.
 * Uploaded file names are passed in; the worker uploads first and then builds.
 */

export const KEYFRAME_SAVE_NODE = "7";
export const KEYFRAME_DEPTH_NODE = "45";
export const VIDEO_SAVE_NODE = COMMUNITY_SAVE_NODE_ID;

export function keyframeInputs(episode: Episode, shot: ShotSpec) {
  const role = shot.faceRole ? episode.roles.find((item) => item.key === shot.faceRole) ?? null : null;
  return { storyboard: shot.storyboard, face: role?.face ?? null };
}

export function buildKeyframeGraph(episode: Episode, shot: ShotSpec, task: Task, uploaded: { storyboard: string | null; face: string | null }) {
  const size = STORYBOARD_SIZES[episode.aspect];
  return buildFluxDev({
    prompt: buildStoryboardPrompt(episode.keyframe.look, shot.keyframePrompt),
    width: size.width, height: size.height, seed: task.seed,
    steps: STORYBOARD_FLUX.steps, guidance: 10, sampler: "euler", scheduler: "simple",
    extraLora: true, denoise: 1,
    // No storyboard: plain Flux text-to-image (+ face lock), composition from keyframePrompt.
    ...(uploaded.storyboard ? { depthImageName: uploaded.storyboard, depthStrength: episode.keyframe.depthStrength } : {}),
    ...(uploaded.face ? { faceImageName: uploaded.face, faceWeight: shot.faceWeight } : {}),
  });
}

export const KEYFRAME_REF = "production:keyframe";
const inputRef = (name: string) => `production:input:${name}`;
/** Turns a storage key from the manifest back into what the worker uploads. */
export function refTarget(key: string): { kind: "keyframe" } | { kind: "input"; name: string } {
  if (key === KEYFRAME_REF) return { kind: "keyframe" };
  if (key.startsWith("production:input:")) return { kind: "input", name: key.slice("production:input:".length) };
  throw new Error(`未知的素材引用：${key}`);
}

/**
 * The canvas's own reference manifest + prompt compiler: approved keyframe = Picture 1 / first frame,
 * then each on-screen role's primary appearance, role voices for dialogue — the same <Subject>,
 * <Picture N>, <Audio N> and dialogue compilation a canvas H3 node with these roles would submit.
 */
export function planVideoSubmission(episode: Episode, shot: ShotSpec) {
  const roles = shot.roles.map((key) => episode.roles.find((role) => role.key === key)!).filter(Boolean);
  const roleAssets: Record<string, { assetId: string; kind: "image" | "audio"; storageReference: string; filename: string }> = {};
  const asset = (name: string, kind: "image" | "audio") => { const id = `${kind}:${name}`; roleAssets[id] = { assetId: id, kind, storageReference: inputRef(name), filename: name }; return id; };
  const snapshots = roles.map((role) => {
    const appearance = role.appearance[0] ? asset(role.appearance[0], "image") : null;
    const voice = role.voice ? asset(role.voice, "audio") : null;
    return { roleId: role.key, displayName: role.name, description: role.description, appearanceAssetIds: appearance ? [appearance] : [], voiceAssetIds: voice ? [voice] : [], primaryAppearanceAssetId: appearance, primaryVoiceAssetId: voice };
  });
  const dialogue = shot.dialogue.map((line) => line.voice && line.voice !== "none" ? { ...line, voice: `audio:${asset(line.voice.slice("audio:".length), "audio")}` } : line);
  const speaker = resolveH3Speaker({ prompt: shot.videoPrompt, roleIds: shot.roles, voiceRoleId: shot.voiceRole ?? undefined, dialogue, autoVoiceEnabled: true, soundMode: episode.video.soundMode });
  if (speaker.errors.length) throw new Error(speaker.errors.join("；"));
  const { manifest, compiled, payload, communityKeyframes } = prepareH3ReferenceSubmission(
    { images: [{ assetId: "production-keyframe", storageReference: KEYFRAME_REF, filename: "keyframe.png", source: "first_frame" }], videos: [], audios: [], roles: snapshots, roleAssets, dialogue, offscreenRoleIds: shot.offscreen, voiceRoleId: speaker.voiceRoleId, soundMode: episode.video.soundMode, includeRoleVoices: true },
    { prompt: shot.videoPrompt, promptMode: "plain", community: true, keyframes: { first: KEYFRAME_REF } },
  );
  return { prompt: compiled.prompt, notes: compiled.notes, images: payload.images.map((item) => item.storageReference), audios: payload.audios.map((item) => item.storageReference), frames: communityKeyframes, pictures: manifest.pictureRefs.length };
}

/** Media a video task needs from the episode inputs (for the "missing media" check). */
export function videoReferenceInputs(episode: Episode, shot: ShotSpec) {
  const plan = planVideoSubmission(episode, shot);
  return [...plan.images, ...plan.audios].filter((key) => key !== KEYFRAME_REF).map((key) => (refTarget(key) as { name: string }).name);
}

export function videoSettings(episode: Episode, shot: ShotSpec): H3GenerationSettings {
  const understanding = episode.video.tuning === "understanding";
  return {
    length: secondsToH3Length(shot.seconds),
    aspect: episode.aspect,
    megapixels: episode.video.megapixels,
    turbo: true,
    steps: understanding ? Number(UNDERSTANDING_VALUES["160.steps"]) : 10,
    fps: H3_FPS,
    loraStrength: understanding ? 0 : 0.75,
    upscaleMethod: H3_UPSCALE_METHOD,
    resolutionSteps: H3_RESOLUTION_STEPS,
    soundMode: episode.video.soundMode,
    noBackgroundMusic: false,
    ...(understanding ? { communityParameters: JSON.stringify({ ...UNDERSTANDING_VALUES }) } : {}),
  };
}

/** Ultimate workflow from a planVideoSubmission result; `uploaded` holds ComfyUI names in the plan's order. */
export function buildVideoGraph(episode: Episode, shot: ShotSpec, task: Task, plan: ReturnType<typeof planVideoSubmission>, uploaded: { images: string[]; audios: string[] }, keyframeSize: { width: number; height: number }) {
  if (uploaded.images.length !== plan.images.length || uploaded.audios.length !== plan.audios.length) throw new Error("上传的素材数量和提交清单不一致");
  const submission = planH3Submission(
    { workflowOptionId: "community-ultimate", communityKeyframes: plan.frames, prompt: shot.videoPrompt, compiledPrompt: plan.prompt, seed: task.seed, settings: videoSettings(episode, shot), sourceWidth: keyframeSize.width, sourceHeight: keyframeSize.height },
    { references: { images: uploaded.images, videos: [], audios: uploaded.audios } },
  );
  return submission.workflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
}
