import { resolveH3Speaker } from './h3-speaker-policy.ts';
import { VOICE_SAMPLE_SECONDS } from './voice-roles.ts';
import type { H3DialogueLine } from './h3-dialogue.ts';
import { readH3Roles } from "./h3-role-snapshot.ts";
import { shotPromptWarnings } from "./shot-prompt-checks.ts";
import { h3PromptHealthMessages, tuningOfParameters } from "./h3-prompt-health.ts";
import type { H3GenerationSettings } from './ai-adapter.ts';
import type { H3TaskMode } from './h3-task-mode.ts';
import type { H3PromptMode } from './h3-prompt-compiler.ts';
import type { AssetRecord } from './production-records.ts';
import type { RoleRecord } from './role-records.ts';
import { type ReferenceManifest } from './reference-manifest.ts';
import { prepareH3ReferenceSubmission, h3ReferenceLayout } from './h3-reference-submission.ts';
import { snapshotH3 } from './production-snapshots.ts';
import { compileH3Prompt } from './comfyui/h3-prompt.ts';
import { communityInputMode, communityInputProblem } from './h3-workflow-options.ts';
import { runH3Preflight, type H3MediaCounts } from './h3-preflight.ts';
import { checkTimeAnchors, timeAnchorFrame, timeAnchorPromptProblem, H3_TIME_ANCHOR_NOTE } from './comfyui/experimental/h3-ultimate-guide.ts';

type Media = { src: string; name: string; withAudio?: boolean };
export interface H3ReviewSpec {
  prompt: string; promptMode: H3PromptMode; settings: H3GenerationSettings;
  workflowOptionId?: string; referenceMode: boolean; community: boolean;
  keyframes?: { first?: string; last?: string }; mode: H3TaskMode | null;
  layout: ReturnType<typeof h3ReferenceLayout>; videos: Media[]; audios: Media[];
  roleIds: string[]; voiceRoleId?: string; voiceRoleIds?: string[]; autoVoiceDisabled?: boolean; autoVoiceEnabled?: boolean; offscreenRoleIds?: string[]; roleSnapshot?: string; dialogue: H3DialogueLine[];
  primary?: Media | null; last?: Media | null; extension?: Media;
  guides: {storageReference: string; filename: string; anchorFrame: number}[];
  /** 🧪 Community time anchors (node + Director Stage). Those with asReference are also in layout as pictures. */
  timeAnchors?: {storageReference: string; filename: string; atSeconds: number; asReference?: boolean; source?: 'node' | 'director'}[];
  seed?: number; problems: string[];
}
export interface H3SubmissionReview {
  errors: string[]; warnings: string[]; inputs: { label: string; name: string; src: string; kind: 'image' | 'video' | 'audio' }[];
  manifest?: ReferenceManifest; finalPrompt?: string; promptMode?: H3PromptMode; notes: string[];
  parameters?: Record<string, unknown>; workflow?: string; mode: H3TaskMode | null;
}
/** Injected read-only access. No asset registration, Run creation, uploads, or generation. */
export interface H3ReviewReaders {
  assetBySource(src: string): Promise<AssetRecord | null>;
  asset(id: string): Promise<AssetRecord | null>;
  role(id: string): Promise<RoleRecord | null>;
  imageSize(src: string): Promise<{width: number; height: number}>;
  checkMedia(src: string, kind: 'image' | 'video' | 'audio', name: string): Promise<void>;
}

export async function inspectH3Submission(spec: H3ReviewSpec, read: H3ReviewReaders): Promise<H3SubmissionReview> {
  const anchors = spec.community ? spec.timeAnchors ?? [] : [];
  const speaker = resolveH3Speaker({...spec,soundMode:spec.settings.soundMode});
  spec = {...spec,voiceRoleId:speaker.voiceRoleId,voiceRoleIds:speaker.voiceRoleIds};
  const review: H3SubmissionReview = { errors: [...spec.problems,...speaker.errors], warnings: [], inputs: [], notes: [], mode: spec.mode };
  const problem = (cause: unknown) => { const message = cause instanceof Error ? cause.message : String(cause); if (!review.errors.includes(message)) review.errors.push(message); };
  if (!spec.prompt.trim()) problem('缺少提示词，请先填写 Prompt');
  spec.dialogue.filter(line=>!line.roleId).forEach(line=>{
    review.warnings.push(`「${line.speaker}」该句不带角色声音${line.voice?.startsWith('audio:')?'，使用指定声音素材':'，由模型生成人声'}；请在提示词明确身份、外观和声音特征${spec.prompt.includes(line.speaker??'')?'':'（当前未找到此名称）'}`);
  });
  if (spec.seed !== undefined && (!Number.isSafeInteger(spec.seed) || spec.seed < 0)) problem('固定 Seed 必须是非负安全整数');
  const add = (media: Media, kind: 'image' | 'video' | 'audio', label: string) => review.inputs.push({ ...media, kind, label });
  if (spec.extension) add(spec.extension, 'video', '延长原视频（含原声上下文，不占参考 Video / Audio 编号）');
  let source = spec.primary?.src;
  let communityKeyframes: {first?: number; last?: number} | undefined;
  let counts: H3MediaCounts = {pictures:0,videos:0,audios:0,standaloneAudios:0,subjects:0};
  let referenceCounts = {images:0,videos:0,audios:0,videoAudioFlags:[] as boolean[]};
  let compiled = false;
  const videoChecks: {name: string; durationSeconds: number | null; fps: number | null}[] = [];
  try {
    if (spec.referenceMode) {
      // Retain requested filenames if a missing role/voice prevents a trustworthy numbering plan.
      [...spec.layout.images, ...spec.layout.trailingImages].forEach(item => add(item, 'image', '图片（编号待核对）'));
      spec.videos.forEach(item => add(item, 'video', '参考视频（编号待核对）'));
      spec.audios.forEach(item => add(item, 'audio', '参考声音（编号待核对）'));
      const explicit = async (item: Media) => {
        const asset = await read.assetBySource(item.src);
        return {assetId:asset?.assetId ?? `preview:${item.src}`, storageReference:item.src, filename:item.name, withAudio:item.withAudio};
      };
      const [images, trailingImages, videos, audios, roles] = await Promise.all([
        Promise.all(spec.layout.images.map(async item => ({...await explicit(item),source:item.source}))),
        Promise.all(spec.layout.trailingImages.map(async item => ({...await explicit(item),source:item.source}))),
        Promise.all(spec.videos.map(explicit)), Promise.all(spec.audios.map(explicit)),
        readH3Roles(spec, spec.roleSnapshot, read.role, read.asset),
      ]);
      const plan = prepareH3ReferenceSubmission({images,trailingImages,videos,audios,...roles,dialogue:spec.dialogue,voiceRoleId:spec.voiceRoleId,voiceRoleIds:spec.voiceRoleIds,offscreenRoleIds:spec.offscreenRoleIds,
        soundMode:spec.settings.soundMode ?? 'av',includeRoleVoices:!speaker.disabled,allowEmptyForTextGeneration:spec.community && !spec.keyframes},
      {prompt:spec.prompt.trim(),promptMode:spec.promptMode,community:spec.community,keyframes:spec.keyframes,noBackgroundMusic:spec.settings.noBackgroundMusic});
      const {manifest,payload} = plan;
      review.manifest = manifest; review.finalPrompt = plan.compiled.prompt; review.promptMode = plan.compiled.mode; review.notes = plan.compiled.notes;
      communityKeyframes = plan.communityKeyframes;
      review.inputs = review.inputs.filter(item => item.label.startsWith('延长原视频'));
      manifest.pictureRefs.forEach(ref => add({src:ref.storageReference,name:ref.filename},'image',`Picture ${ref.index}${communityKeyframes?.first === ref.index ? ' · 首帧' : communityKeyframes?.last === ref.index ? ' · 尾帧' : ''}`));
      manifest.videoRefs.forEach(ref => add({src:ref.storageReference,name:ref.filename},'video',`Video ${ref.index}${ref.audioIndex ? ` · 原声 Audio ${ref.audioIndex}` : ''}`));
      manifest.audioRefs.filter(ref => ref.kind === 'standalone').forEach(ref => add({src:ref.storageReference,name:ref.filename},'audio',`Audio ${ref.index}`));
      counts = {pictures:manifest.pictureRefs.length,videos:manifest.videoRefs.length,audios:manifest.audioRefs.length,standaloneAudios:payload.audios.length,subjects:manifest.roleBindings.length};
      referenceCounts = {images:payload.images.length,videos:payload.videos.length,audios:payload.audios.length,videoAudioFlags:payload.videos.map(item => item.withAudio)};
      if (spec.community) {
        review.mode = communityInputMode(counts,Boolean(spec.keyframes));
        const issue = communityInputProblem({pictures:counts.pictures,videos:counts.videos,audios:counts.standaloneAudios,keyframeCount:Object.values(communityKeyframes ?? {}).filter(value => value !== undefined).length,guides:anchors.length});
        if (issue) problem(issue);
        if (anchors.length) {
          // Listed apart from Picture numbering: anchors are placed by frame, not shown to the text encoder.
          anchors.forEach(anchor => {
            const ref = anchor.asReference ? manifest.pictureRefs.find(item => item.storageReference === anchor.storageReference) : undefined;
            add({src:anchor.storageReference,name:anchor.filename},'image',`🧪 时间锚点 · ${anchor.atSeconds.toFixed(2)} 秒 · 第 ${timeAnchorFrame(anchor.atSeconds)} 帧${anchor.source === 'director' ? ' · 导演台' : ''}${ref ? ` · 同时作为 Picture ${ref.index}` : '（不占 Picture 编号）'}`);
          });
          try { review.warnings.push(...checkTimeAnchors(anchors.map((anchor, i) => ({imageName:`anchor-${i}`,frameIdx:timeAnchorFrame(anchor.atSeconds)})), spec.settings.length, {first:Boolean(communityKeyframes?.first),last:Boolean(communityKeyframes?.last)}).warnings); } catch (cause) { problem(cause); }
          const tagIssue = timeAnchorPromptProblem(plan.compiled.prompt, counts.pictures, anchors.length);
          if (tagIssue) problem(tagIssue);
          review.notes.push(H3_TIME_ANCHOR_NOTE);
        }
      }
      if (!spec.community && spec.workflowOptionId !== 'h3-extend' && spec.settings.aspect === 'follow') problem('多参考模式请先选择明确的画面比例');
      source = spec.community && spec.settings.aspect === 'follow' ? payload.images[0]?.storageReference : undefined;
      for (const ref of manifest.videoRefs) {
        const asset = await read.asset(ref.assetId);
        videoChecks.push({name:ref.filename,durationSeconds:asset?.duration ?? null,fps:asset?.fps ?? null});
      }
    } else {
      if (spec.primary?.src) add(spec.primary,'image','Picture 1 · 首帧');
      if (spec.last?.src) add(spec.last,'image','Picture 2 · 尾帧');
      spec.guides.forEach(item => add({src:item.storageReference,name:item.filename},'image',`引导锚点 · 第 ${item.anchorFrame} 帧（不占 Picture 编号）`));
      counts.pictures = (spec.primary?.src ? 1 : 0) + (spec.last?.src ? 1 : 0);
      referenceCounts.images = spec.primary?.src ? 1 : 0;
      review.finalPrompt = compileH3Prompt(spec.prompt.trim(),spec.settings.soundMode,spec.settings.noBackgroundMusic); review.promptMode = 'plain';
    }
    compiled = true;
  } catch (cause) { problem(cause); }

  // Only when the user opens the inspection. Sequential reads avoid retaining multiple video blobs.
  const checked = new Set<string>();
  for (const item of review.inputs) {
    const key = `${item.kind}:${item.src}`;
    if (checked.has(key)) continue;
    checked.add(key);
    try { await read.checkMedia(item.src,item.kind,item.name); }
    catch { problem(`${item.label} · ${item.name}：素材不可读取，请重新绑定`); }
  }
  if (compiled) {
    try {
      const size = source ? await read.imageSize(source) : null;
      const snapshot = await snapshotH3({workflowOptionId:spec.referenceMode ? spec.workflowOptionId : undefined,communityKeyframes,
        referenceMode:spec.referenceMode,prompt:review.finalPrompt!,seed:spec.seed ?? 0,settings:review.manifest?.voiceRoleIds?.length ? {...spec.settings,referenceAudioTrimSeconds:VOICE_SAMPLE_SECONDS} : spec.settings,
        sourceWidth:size?.width ?? 0,sourceHeight:size?.height ?? 0,hasLastFrame:!spec.referenceMode && Boolean(spec.last),referenceCounts,
        ...(!spec.referenceMode && review.mode === 't2va' ? {taskMode:'t2va' as const} : {}),
        ...(!spec.referenceMode && spec.guides.length ? {guides:spec.guides.map(item => ({frameIdx:item.anchorFrame}))} : {}),
        ...(anchors.length ? {timeAnchors:anchors.map(anchor => ({atSeconds:anchor.atSeconds,frameIdx:timeAnchorFrame(anchor.atSeconds),filename:anchor.filename,asReference:Boolean(anchor.asReference),source:anchor.source ?? 'node'}))} : {})});
      review.parameters = snapshot.parameters; review.workflow = snapshot.workflowIdentity.templateFile;
      if (snapshot.parameters.acceptance === 'not_render_tested') review.warnings.push('当前工作流组合标记为未试渲，需实际生成后验收效果');
    } catch (cause) { problem(cause); }
    const preflight = runH3Preflight({mode:review.mode,prompt:review.finalPrompt!,rawPrompt:spec.prompt,counts,referenceVideos:videoChecks,length:spec.settings.length,megapixels:spec.settings.megapixels,
      ...(typeof review.parameters?.width === 'number' && typeof review.parameters?.height === 'number' ? {dimensions:{width:review.parameters.width,height:review.parameters.height}} : {})});
    preflight.errors.forEach(issue => problem(issue.message));
    review.warnings.push(...preflight.warnings.map(issue => issue.message));
    if (review.mode === 't2va' && spec.settings.aspect === 'follow') problem('文生视频没有原图可跟随，请选择明确画面比例');
    if (speaker.hasDialogue && !spec.dialogue.length && !speaker.disabled && !review.manifest?.roleBindings.some(role => role.audioRefIndex)) problem('有台词但没有可提交的角色主声音，请绑定主声音后再生成');
  }
  review.warnings.push(...shotPromptWarnings(review.finalPrompt ?? spec.prompt, spec.settings.length / spec.settings.fps));
  // Raw prompt only: the compiled text carries the compiler's own fixed sentences.
  review.warnings.push(...h3PromptHealthMessages(spec.prompt, { seconds: spec.settings.length / spec.settings.fps, firstFrame: Boolean(spec.keyframes?.first), soundMode: spec.settings.soundMode, hasDialogue: spec.dialogue.length > 0, offscreen: Boolean(spec.offscreenRoleIds?.length), tuning: spec.community ? tuningOfParameters(spec.settings.communityParameters) : "default" }));
  return review;
}
