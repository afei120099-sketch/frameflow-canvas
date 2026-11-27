import { buildReferenceManifest, manifestPayload, type BuildManifestInput, type PictureSource } from './reference-manifest.ts';
import { prepareKeyframeSubmission } from './video-frame-handoff.ts';
import { compileH3Ref2vaPrompt, type H3PromptMode } from './h3-prompt-compiler.ts';
import { compileH3Prompt, suppressBackgroundMusic } from './comfyui/h3-prompt.ts';
import { isOfficialFormat, OFFICIAL_MUSIC_NOTE } from './official-format.ts';

type ImageInput = { src: string; name: string; source: Exclude<PictureSource, 'role_appearance'> };
/** Shared by read-only inspection and generation. Captured frames keep editor indices until compilation. */
export function h3ReferenceLayout(input: {
  first?: { src: string; name: string } | null; last?: { src: string; name: string } | null;
  capturedFirst: boolean; capturedLast: boolean; extension: boolean; keyframes: boolean;
  references: ImageInput[]; guides: { storageReference: string; filename: string }[];
}) {
  const { first, last } = input;
  const images: ImageInput[] = [
    ...(!input.capturedFirst && !input.extension && first ? [{ ...first, source: 'first_frame' as const }] : []),
    ...(!input.capturedLast && input.keyframes && last ? [{ ...last, source: 'connected_reference' as const }] : []),
    ...input.references,
    ...input.guides.map(g => ({ src: g.storageReference, name: g.filename, source: 'connected_reference' as const })),
  ];
  const trailingImages: ImageInput[] = [
    ...(input.capturedFirst && first ? [{ ...first, source: 'first_frame' as const }] : []),
    ...(input.capturedLast && last ? [{ ...last, source: 'connected_reference' as const }] : []),
  ];
  return { images, trailingImages };
}

/** The exact manifest, remapped prompt and upload order, with no storage writes or uploads. */
export function prepareH3ReferenceSubmission(input: BuildManifestInput, options: {
  noBackgroundMusic?: boolean;
  prompt: string; promptMode: H3PromptMode; community: boolean;
  keyframes?: { first?: string; last?: string };
}) {
  const initial = buildReferenceManifest(input);
  const frames = options.keyframes ? {
    first: initial.pictureRefs.find(ref => ref.storageReference === options.keyframes?.first)?.index,
    last: initial.pictureRefs.find(ref => ref.storageReference === options.keyframes?.last)?.index,
  } : undefined;
  const adapted = prepareKeyframeSubmission(initial, options.prompt, frames);
  const manifest = adapted.manifest;
  const modelPrompt = options.noBackgroundMusic ? suppressBackgroundMusic(adapted.prompt, input.soundMode) : adapted.prompt;
  const compiled = options.community && !manifest.pictureRefs.length && !manifest.audioRefs.length
    ? { prompt: compileH3Prompt(modelPrompt, input.soundMode), mode: 'plain' as const, compilerVersion: 'community-text-v1', notes: ['文生实验未试渲'] }
    : compileH3Ref2vaPrompt({ rawPrompt: modelPrompt, soundMode: input.soundMode, mode: options.promptMode, manifest });
  if (options.noBackgroundMusic) compiled.notes.push(isOfficialFormat(options.prompt) ? `${OFFICIAL_MUSIC_NOTE}（勾着禁背景乐也不往正文加句子）` : "已添加禁止背景音乐约束；需试听确认");
  if (adapted.prompt !== options.prompt && options.keyframes) compiled.notes.push('视频衔接：原提示词未改；提交时按 H3 首尾帧优先顺序适配 Picture 编号，实际清单如下');
  return { manifest, compiled, payload: manifestPayload(manifest), communityKeyframes: adapted.frames };
}
