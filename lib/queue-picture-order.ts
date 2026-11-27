import type { H3DialogueLine } from './h3-dialogue.ts';
import type { H3SoundMode } from './comfyui/h3-prompt.ts';
import { h3ReferenceLayout, prepareH3ReferenceSubmission } from './h3-reference-submission.ts';
import type { PictureRef, RoleAssetInput, RoleSnapshotInput } from './reference-manifest.ts';

/** Minimal shot fields. This module must not import shot-queue.ts. */
export type QueuePictureShot = {
  title: string;
  shotId?: string;
  prompt: string;
  roleIds: string[];
  sceneAssetIds: string[];
  offscreenRoleIds?: string[];
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
  firstFrameFrom?: unknown;
  lastFrameFrom?: unknown;
  sourceShot?: string;
  sourceVideoAssetId?: string;
  soundMode: H3SoundMode;
  voiceRoleId?: string;
  voiceRoleIds?: string[];
  dialogue?: H3DialogueLine[];
  autoVoiceDisabled?: boolean;
};

export type QueuePictureAsset = { assetId: string; kind: string; storageReference: string; filename: string };

export type QueuePictureScene = { assetId: string; src: string; name: string };

/** Structural slot count shared by parse checks and submission. Frames occupy picture slots. */
export function queuePictureSlotCount(shot: Pick<QueuePictureShot, 'sceneAssetIds' | 'roleIds' | 'offscreenRoleIds' | 'firstFrameAssetId' | 'lastFrameAssetId' | 'firstFrameFrom' | 'lastFrameFrom'>) {
  const frames = Number(!!shot.firstFrameAssetId || !!shot.firstFrameFrom) + Number(!!shot.lastFrameAssetId || !!shot.lastFrameFrom);
  const onScreen = shot.roleIds.length - (shot.offscreenRoleIds?.length ?? 0);
  return { frames, pictures: shot.sceneAssetIds.length + onScreen + frames };
}

function frameImage(shot: QueuePictureShot, assets: ReadonlyMap<string, QueuePictureAsset>, edge: 'first' | 'last', chapter?: number, shotIndex?: number) {
  const from = edge === 'first' ? shot.firstFrameFrom : shot.lastFrameFrom;
  const assetId = edge === 'first' ? shot.firstFrameAssetId : shot.lastFrameAssetId;
  const token = `${chapter ?? 'shot'}:${shotIndex ?? shot.shotId ?? shot.title}:${edge}`;
  if (from) return { assetId: `deferred:${token}`, storageReference: `deferred:${token}`, filename: '待来源完成后截帧', source: edge === 'first' ? 'first_frame' as const : 'connected_reference' as const };
  if (!assetId) return null;
  const asset = assets.get(assetId);
  if (!asset || asset.kind !== 'image' || !asset.storageReference) throw new Error(`${edge === 'first' ? '首帧' : '尾帧'}图片不存在或不是图片：${assetId}`);
  return { assetId: asset.assetId, storageReference: asset.storageReference, filename: asset.filename, source: edge === 'first' ? 'first_frame' as const : 'connected_reference' as const };
}

function pictureName(ref: PictureRef, roles: readonly Pick<RoleSnapshotInput, 'roleId' | 'displayName'>[]) {
  if (ref.sources.includes('first_frame')) return `首帧 ${ref.filename}`;
  if (ref.sources.includes('connected_reference') && !ref.sources.includes('reference_image') && ref.roleIds.length === 0) return `尾帧 ${ref.filename}`;
  const role = roles.find(item => ref.roleIds.includes(item.roleId));
  if (role) return `角色 ${role.displayName}`;
  return `场景 ${ref.filename}`;
}

/**
 * Same order as an H3 queue node: videoFirstFrame/videoLastFrame are captured,
 * so prepareH3ReferenceSubmission moves them ahead of scenes and role appearances.
 */
export function compileQueueShotPictures(input: {
  shot: QueuePictureShot;
  scenes: readonly QueuePictureScene[];
  roles: readonly RoleSnapshotInput[];
  assets: ReadonlyMap<string, QueuePictureAsset>;
  roleAssets: Record<string, RoleAssetInput | null>;
  includeRoleVoices: boolean;
  noBackgroundMusic?: boolean;
  chapter?: number;
  shotIndex?: number;
}) {
  const { shot } = input;
  const first = frameImage(shot, input.assets, 'first', input.chapter, input.shotIndex);
  const last = frameImage(shot, input.assets, 'last', input.chapter, input.shotIndex);
  const layout = h3ReferenceLayout({
    first: first ? { src: first.storageReference, name: first.filename } : null,
    last: last ? { src: last.storageReference, name: last.filename } : null,
    capturedFirst: !!first,
    capturedLast: !!last,
    extension: !!shot.sourceShot || !!shot.sourceVideoAssetId,
    keyframes: !!first || !!last,
    references: input.scenes.map(scene => ({ src: scene.src, name: scene.name, source: 'reference_image' as const })),
    guides: [],
  });
  const known = [...(first ? [first] : []), ...(last ? [last] : []), ...input.scenes.map(scene => ({ assetId: scene.assetId, storageReference: scene.src, filename: scene.name }))];
  const reference = (image: { src: string; name: string; source: 'first_frame' | 'connected_reference' | 'reference_image' }) => {
    const match = known.find(item => item.storageReference === image.src);
    return { assetId: match?.assetId ?? image.src, storageReference: image.src, filename: image.name, source: image.source };
  };
  const images = layout.images.map(reference);
  const trailingImages = layout.trailingImages.map(reference);
  const prepared = prepareH3ReferenceSubmission({
    images,
    trailingImages,
    videos: [],
    audios: [],
    roles: [...input.roles],
    roleAssets: input.roleAssets,
    dialogue: input.includeRoleVoices ? (shot.dialogue ?? []) : [],
    offscreenRoleIds: shot.offscreenRoleIds,
    voiceRoleId: input.includeRoleVoices ? shot.voiceRoleId : undefined,
    voiceRoleIds: input.includeRoleVoices ? shot.voiceRoleIds : undefined,
    soundMode: shot.soundMode,
    includeRoleVoices: input.includeRoleVoices,
    allowEmptyForTextGeneration: !images.length && !trailingImages.length && !input.roles.some(role => !shot.offscreenRoleIds?.includes(role.roleId)),
  }, {
    prompt: shot.prompt,
    promptMode: 'plain',
    community: true,
    noBackgroundMusic: input.noBackgroundMusic,
    ...(first || last ? { keyframes: { first: first?.storageReference, last: last?.storageReference } } : {}),
  });
  const pictures = prepared.manifest.pictureRefs.map(ref => ({ label: `Picture ${ref.index}`, name: pictureName(ref, input.roles) }));
  return { prepared, pictures };
}
