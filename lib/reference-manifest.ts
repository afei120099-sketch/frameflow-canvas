import type { H3SoundMode } from "./comfyui/h3-prompt.ts";
import type { RoleRecord } from "./role-records.ts";
import { parseH3Dialogue, DIALOGUE_AUDIO_PREFIX, type H3DialogueLine } from './h3-dialogue.ts';

/**
 * Reference Manifest V1 for H3 Ref2VA.
 *
 * The manifest is the only ordering source for the Ref2VA payload. Label numbers follow
 * ComfyUI's MiniMaxH3ReferenceToVideo presentation order: images, then reference videos
 * (an enabled soundtrack takes its <Audio j> before its <Video k>), then standalone audio.
 * Ordinals are 1-based per type. Canvas position, Role order and Asset IDs never decide numbers.
 */

export type PictureSource = "first_frame" | "connected_reference" | "reference_image" | "role_appearance";
export type AudioSource = "reference_audio" | "role_voice";

export interface ExplicitReference { assetId: string; storageReference: string; filename: string; withAudio?: boolean }

export interface PictureRef { index: number; label: string; assetId: string; storageReference: string; filename: string; sources: PictureSource[]; roleIds: string[] }
export interface VideoRef { index: number; label: string; assetId: string; storageReference: string; filename: string; withAudio: boolean; audioIndex: number | null }
export interface AudioRef {
  index: number;
  label: string;
  kind: "video_soundtrack" | "standalone";
  assetId: string;
  storageReference: string;
  filename: string;
  /** Set for a soundtrack: the <Video k> it comes from. */
  videoIndex: number | null;
  sources: AudioSource[];
  roleIds: string[];
}

export interface RoleBinding {
  roleId: string;
  roleName: string;
  description: string;
  appearanceAssetIds: string[];
  voiceAssetIds: string[];
  selectedAppearanceAssetId: string | null;
  appearanceSource: "explicit_reference" | "role_primary" | "offscreen";
  offscreen?: boolean;
  selectedVoiceAssetId: string | null;
  voiceSource: "explicit_reference" | "role_primary" | null;
  pictureRefIndex: number | null;
  audioRefIndex: number | null;
  subjectIndex: number;
  subjectAlias: string;
  speakerAlias: string | null;
}

export interface SpeakerBinding { speakerId: string; roleId: string; subjectIndex: number; audioRefIndex: number | null }
export interface DialogueEntry { order: number; speakerId: string; roleId: string; text: string; speaker?: string; voice?: string; audioRefIndex?: number | null }

export interface ReferenceManifest {
  schemaVersion: 1;
  manifestId: string;
  createdAt: number;
  capability: "h3_ref2va";
  shotId: string | null;
  runId: string | null;
  soundMode: H3SoundMode;
  pictureRefs: PictureRef[];
  videoRefs: VideoRef[];
  audioRefs: AudioRef[];
  roleBindings: RoleBinding[];
  speakers: SpeakerBinding[];
  dialogue: DialogueEntry[];
  /** Voice-only binding: spoken text/timing remains in the user's prompt. */
  voiceRoleId?: string;
  /** 🧪 plain 声音路：说话角色按开口顺序，每人主声音一条（lib/voice-roles.ts）。 */
  voiceRoleIds?: string[];
  offscreenRoleIds?: string[];
  /** Asset IDs in the exact order uploaded into ref_images / ref_videos / ref_audios. */
  submissionOrder: { images: string[]; videos: string[]; audios: string[] };
}

export type RoleSnapshotInput = Pick<RoleRecord, "roleId" | "displayName" | "description" | "appearanceAssetIds" | "voiceAssetIds" | "primaryAppearanceAssetId" | "primaryVoiceAssetId">;
export interface RoleAssetInput { assetId: string; kind: "image" | "video" | "audio"; storageReference: string; filename: string }

export interface BuildManifestInput {
  images: (ExplicitReference & { source: Exclude<PictureSource, "role_appearance"> })[];
  /** Captured keyframes appended after role appearances, preserving existing Picture indices. */
  trailingImages?: (ExplicitReference & { source: Exclude<PictureSource, "role_appearance"> })[];
  videos: ExplicitReference[];
  audios: ExplicitReference[];
  /** Roles selected on the H3 node, in selection order. */
  roles: RoleSnapshotInput[];
  /** Selected Role IDs that no longer exist. */
  missingRoleIds?: string[];
  /** Records for Role primary assets; null means the record could not be found. */
  roleAssets: Record<string, RoleAssetInput | null>;
  /** Dialogue in target-video playback order. */
  dialogue: H3DialogueLine[];
  offscreenRoleIds?: string[];
  voiceRoleId?: string;
  /** 🧪 plain 声音路：说话角色按对白行开口顺序，每人送主声音（最多 3 个）。 */
  voiceRoleIds?: string[];
  soundMode: H3SoundMode;
  manifestId?: string;
  createdAt?: number;
  /** Image-only workflows keep dialogue but do not submit Role voice references. */
  includeRoleVoices?: boolean;
  /** Explicit opt-in for a community T2VA run; ordinary reference workflows still require media. */
  allowEmptyForTextGeneration?: boolean;
}

export const H3_REF_LIMITS = { images: 9, videos: 3, audios: 3 } as const;
export const pictureLabel = (index: number) => `<Picture ${index}>`;
export const videoLabel = (index: number) => `<Video ${index}>`;
export const audioLabel = (index: number) => `<Audio ${index}>`;
export const subjectLabel = (index: number) => `<Subject ${index}>`;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const quote = (name: string) => `“${name}”`;

export function buildReferenceManifest(input: BuildManifestInput): ReferenceManifest {
  if (input.missingRoleIds?.length) throw new Error("所选角色已不存在（可能已被删除），请从 H3 节点中移除该角色");
  const roles: RoleSnapshotInput[] = [];
  for (const role of input.roles) if (!roles.some((item) => item.roleId === role.roleId)) roles.push(role);
  const roleById = new Map(roles.map((role) => [role.roleId, role]));

  // Speakers: assigned once, in the order of actual vocal events.
  const dialogue: DialogueEntry[] = [];
  const speakerOrder: string[] = [];
  const inputDialogue = parseH3Dialogue(input.dialogue, [...roleById.keys()], '台词');
  inputDialogue.forEach((line, index) => {
    if (!line.roleId) {
      dialogue.push({order:index+1,speakerId:`G${index+1}`,roleId:'',speaker:line.speaker,voice:line.voice??'none',text:line.text});
      return;
    }
    const role = roleById.get(line.roleId);
    if (!role) throw new Error(`第 ${index + 1} 条台词的说话角色未加入本节点，请重新选择说话角色`);
    const text = line.text.trim();
    if (!text) throw new Error(`第 ${index + 1} 条台词（${role.displayName}）为空`);
    if (!speakerOrder.includes(role.roleId)) speakerOrder.push(role.roleId);
    dialogue.push({ order: index + 1, speakerId: `S${speakerOrder.indexOf(role.roleId) + 1}`, roleId: role.roleId, text });
  });
  if (dialogue.length && input.soundMode !== "av") throw new Error(`当前声音模式为${input.soundMode === "silent" ? "静音" : "仅环境音"}，不能包含角色台词；请移除台词或切换到“视听生成”`);
  if (input.voiceRoleId) {
    if (!roleById.has(input.voiceRoleId)) throw new Error("指定的说话角色未加入本节点，请在角色／更多中重新选择");
    if (input.soundMode !== "av") throw new Error("提交角色主声音需要“视听生成”模式；无对白镜头请关闭主声音绑定");
    if (input.includeRoleVoices === false) throw new Error("当前路径不支持提交角色主声音");
    if (!speakerOrder.includes(input.voiceRoleId)) speakerOrder.push(input.voiceRoleId);
  }
  const voiceRoleIds = input.voiceRoleIds?.length ? [...input.voiceRoleIds] : [];
  if (voiceRoleIds.length) {
    if (input.voiceRoleId || dialogue.length) throw new Error("voiceRoleIds 不能和 voiceRoleId 或 dialogue 同时用");
    if (new Set(voiceRoleIds).size !== voiceRoleIds.length) throw new Error("voiceRoleIds 不能重复");
    if (voiceRoleIds.length > H3_REF_LIMITS.audios) throw new Error(`voiceRoleIds 最多 ${H3_REF_LIMITS.audios} 个说话角色`);
    const outside = voiceRoleIds.find((id) => !roleById.has(id));
    if (outside) throw new Error(`voiceRoleIds 里的说话角色没加入本节点：${outside}`);
    if (input.soundMode !== "av") throw new Error("提交角色主声音需要“视听生成”模式");
    if (input.includeRoleVoices === false) throw new Error("当前路径不支持提交角色主声音");
    for (const id of voiceRoleIds) if (!speakerOrder.includes(id)) speakerOrder.push(id);
  }
  const primaryOnly = (roleId: string) => roleId === input.voiceRoleId || voiceRoleIds.includes(roleId);

  // Pictures: explicit references first (existing order), then Role appearances. Same Asset once.
  const pictures: Omit<PictureRef, "index" | "label">[] = [];
  const addPicture = (ref: { assetId: string; storageReference: string; filename: string }, source: PictureSource, roleId?: string) => {
    let item = pictures.find((candidate) => candidate.assetId === ref.assetId);
    if (!item) { item = { assetId: ref.assetId, storageReference: ref.storageReference, filename: ref.filename, sources: [], roleIds: [] }; pictures.push(item); }
    if (!item.sources.includes(source)) item.sources.push(source);
    if (roleId && !item.roleIds.includes(roleId)) item.roleIds.push(roleId);
    return pictures.indexOf(item) + 1;
  };
  for (const image of input.images) addPicture(image, image.source);

  const videos: Omit<VideoRef, "index" | "label" | "audioIndex">[] = [];
  for (const video of input.videos) {
    const existing = videos.find((candidate) => candidate.assetId === video.assetId);
    if (existing) existing.withAudio = existing.withAudio || Boolean(video.withAudio);
    else videos.push({ assetId: video.assetId, storageReference: video.storageReference, filename: video.filename, withAudio: Boolean(video.withAudio) });
  }

  const standalone: Omit<AudioRef, "index" | "label" | "kind" | "videoIndex">[] = [];
  const addAudio = (ref: { assetId: string; storageReference: string; filename: string }, source: AudioSource, roleId?: string) => {
    let item = standalone.find((candidate) => candidate.assetId === ref.assetId);
    if (!item) { item = { assetId: ref.assetId, storageReference: ref.storageReference, filename: ref.filename, sources: [], roleIds: [] }; standalone.push(item); }
    if (!item.sources.includes(source)) item.sources.push(source);
    if (roleId && !item.roleIds.includes(roleId)) item.roleIds.push(roleId);
    return item;
  };
  for (const audio of input.audios) addAudio(audio, "reference_audio");
  for (const line of dialogue.filter(line=>!line.roleId && line.voice?.startsWith('audio:'))) {
    const id=line.voice!.slice(DIALOGUE_AUDIO_PREFIX.length), asset=input.roleAssets[id];
    if(!asset || asset.kind!=='audio' || !asset.storageReference) throw Error(`第${line.order}句「${line.speaker}」声音素材缺失或不是音频：${id}`);
    addAudio(asset,'reference_audio');
  }

  // An explicitly chosen reference that belongs to a selected Role wins over the Role primary.
  const explicitOwner = (assetId: string, key: "appearanceAssetIds" | "voiceAssetIds") => roles.filter((role) => role[key].includes(assetId));
  const explicitFor = (role: RoleSnapshotInput, refs: ExplicitReference[], key: "appearanceAssetIds" | "voiceAssetIds", noun: string) => {
    const matches = refs.filter((ref, index) => role[key].includes(ref.assetId) && refs.findIndex((other) => other.assetId === ref.assetId) === index);
    for (const ref of matches) {
      const owners = explicitOwner(ref.assetId, key);
      if (owners.length > 1) throw new Error(`${noun}${quote(ref.filename)}同时属于角色${owners.map((owner) => quote(owner.displayName)).join("和")}，无法确定归属；请只保留其中一个角色，或改用各自的主素材`);
    }
    if (matches.length > 1) throw new Error(`角色${quote(role.displayName)}同时对应多个已选${noun}（${matches.map((ref) => ref.filename).join("、")}），请只保留一个`);
    return matches[0] ?? null;
  };
  const roleAsset = (role: RoleSnapshotInput, assetId: string, kind: "image" | "audio") => {
    const asset = input.roleAssets[assetId];
    if (!asset || asset.kind !== kind || !asset.storageReference) throw new Error(`引用素材已失效：角色${quote(role.displayName)}的${kind === "image" ? "主外观" : "主声音"}记录不存在或类型错误，请在角色库重新指定`);
    return asset;
  };

  if (input.offscreenRoleIds?.some(id => !roleById.has(id))) throw new Error("画外音角色未加入本节点");
  const partialBindings = roles.map((role, index) => {
    if (input.offscreenRoleIds?.includes(role.roleId)) {
      if ([...input.images,...(input.trailingImages ?? [])].some(image => role.appearanceAssetIds.includes(image.assetId))) throw new Error(`画外音角色“${role.displayName}”的外观图被显式加入参考图，请移除以免误出镜`);
      return {role, subjectIndex:index+1, appearance:null, appearanceSource:"offscreen" as const, pictureRefIndex:null};
    }
    const explicit = explicitFor(role, input.images, "appearanceAssetIds", "参考图");
    let appearance: { assetId: string; storageReference: string; filename: string };
    if (explicit) appearance = explicit;
    else {
      if (!role.primaryAppearanceAssetId) throw new Error(`角色${quote(role.displayName)}没有可用主外观`);
      appearance = roleAsset(role, role.primaryAppearanceAssetId, "image");
    }
    const pictureRefIndex = addPicture(appearance, explicit ? (input.images.find((image) => image.assetId === explicit.assetId)!.source) : "role_appearance", role.roleId);
    return { role, subjectIndex: index + 1, appearance, appearanceSource: explicit ? "explicit_reference" as const : "role_primary" as const, pictureRefIndex };
  });

  // Voices: structured dialogue or an explicit voiceRoleId opt-in, never every selected Role.
  const voiceByRole = new Map<string, { asset: { assetId: string; storageReference: string; filename: string }; source: "explicit_reference" | "role_primary" }>();
  for (const roleId of input.includeRoleVoices === false ? [] : speakerOrder) {
    const role = roleById.get(roleId)!;
    const explicit = explicitFor(role, input.audios, "voiceAssetIds", "参考声音");
    if (primaryOnly(roleId)) {
      if (!role.primaryVoiceAssetId) throw new Error(`角色${quote(role.displayName)}没有可用主声音；请在角色库设置主声音后再生成`);
      if (explicit && explicit.assetId !== role.primaryVoiceAssetId) throw new Error(`角色${quote(role.displayName)}的参考声音与指定主声音冲突，请移除其它声音或修改主声音`);
    }
    let voice: { assetId: string; storageReference: string; filename: string };
    if (primaryOnly(roleId)) voice = roleAsset(role, role.primaryVoiceAssetId!, "audio");
    else if (explicit) voice = explicit;
    else {
      if (!role.primaryVoiceAssetId) throw new Error(`角色${quote(role.displayName)}没有可用主声音`);
      voice = roleAsset(role, role.primaryVoiceAssetId, "audio");
    }
    addAudio(voice, explicit ? "reference_audio" : "role_voice", role.roleId);
    voiceByRole.set(roleId, { asset: voice, source: explicit ? "explicit_reference" : "role_primary" });
  }

  for (const image of input.trailingImages ?? []) addPicture(image, image.source);
  if (pictures.length > H3_REF_LIMITS.images) throw new Error(`参考图共 ${pictures.length} 张（含角色主外观），超过 H3 上限 ${H3_REF_LIMITS.images} 张`);
  if (videos.length > H3_REF_LIMITS.videos) throw new Error(`参考视频超过 H3 上限 ${H3_REF_LIMITS.videos} 个`);
  if (standalone.length > H3_REF_LIMITS.audios) throw new Error(`参考声音共 ${standalone.length} 条（含角色主声音），超过 H3 上限 ${H3_REF_LIMITS.audios} 条`);
  if (!pictures.length && !videos.length && !standalone.length && !input.allowEmptyForTextGeneration) throw new Error("多参考生成至少需要一项参考素材");

  const pictureRefs: PictureRef[] = pictures.map((item, index) => ({ ...item, index: index + 1, label: pictureLabel(index + 1) }));
  const audioRefs: AudioRef[] = [];
  const videoRefs: VideoRef[] = videos.map((item, index) => {
    let audioIndex: number | null = null;
    if (item.withAudio) {
      audioIndex = audioRefs.length + 1;
      audioRefs.push({ index: audioIndex, label: audioLabel(audioIndex), kind: "video_soundtrack", assetId: item.assetId, storageReference: item.storageReference, filename: item.filename, videoIndex: index + 1, sources: [], roleIds: [] });
    }
    return { ...item, index: index + 1, label: videoLabel(index + 1), audioIndex };
  });
  for (const item of standalone) {
    const index = audioRefs.length + 1;
    audioRefs.push({ ...item, index, label: audioLabel(index), kind: "standalone", videoIndex: null });
  }
  const audioIndexOf = (assetId: string) => audioRefs.find((ref) => ref.kind === "standalone" && ref.assetId === assetId)!.index;
  for (const line of dialogue.filter(line=>!line.roleId)) line.audioRefIndex=line.voice?.startsWith(DIALOGUE_AUDIO_PREFIX) ? audioIndexOf(line.voice.slice(DIALOGUE_AUDIO_PREFIX.length)) : null;

  const speakers: SpeakerBinding[] = speakerOrder.map((roleId, index) => {
    const voice = voiceByRole.get(roleId);
    return { speakerId: `S${index + 1}`, roleId, subjectIndex: partialBindings.find((item) => item.role.roleId === roleId)!.subjectIndex, audioRefIndex: voice ? audioIndexOf(voice.asset.assetId) : null };
  });
  const roleBindings: RoleBinding[] = partialBindings.map(({ role, subjectIndex, appearance, appearanceSource, pictureRefIndex }) => {
    const voice = voiceByRole.get(role.roleId);
    return {
      roleId: role.roleId,
      roleName: role.displayName,
      description: role.description,
      appearanceAssetIds: [...role.appearanceAssetIds],
      voiceAssetIds: [...role.voiceAssetIds],
      selectedAppearanceAssetId: appearance?.assetId ?? null,
      ...(appearanceSource === "offscreen" ? {offscreen:true} : {}),
      appearanceSource,
      selectedVoiceAssetId: voice?.asset.assetId ?? null,
      voiceSource: voice?.source ?? null,
      pictureRefIndex,
      audioRefIndex: voice ? audioIndexOf(voice.asset.assetId) : null,
      subjectIndex,
      subjectAlias: subjectLabel(subjectIndex),
      speakerAlias: speakers.find((speaker) => speaker.roleId === role.roleId)?.speakerId ?? null,
    };
  });

  const manifest: ReferenceManifest = {
    schemaVersion: 1,
    manifestId: input.manifestId ?? crypto.randomUUID(),
    createdAt: input.createdAt ?? Date.now(),
    capability: "h3_ref2va",
    shotId: null,
    runId: null,
    soundMode: input.soundMode,
    pictureRefs,
    videoRefs,
    audioRefs,
    roleBindings,
    speakers,
    dialogue,
    ...(input.voiceRoleId ? { voiceRoleId: input.voiceRoleId } : {}),
    ...(voiceRoleIds.length ? { voiceRoleIds } : {}),
    ...(input.offscreenRoleIds?.length ? {offscreenRoleIds:[...input.offscreenRoleIds]} : {}),
    submissionOrder: { images: pictureRefs.map((ref) => ref.assetId), videos: videoRefs.map((ref) => ref.assetId), audios: audioRefs.filter((ref) => ref.kind === "standalone").map((ref) => ref.assetId) },
  };
  // Detached from every input object: later Role / node edits cannot reach this snapshot.
  return deepFreeze(structuredClone(manifest));
}

/** The ordered upload lists for ref_images / ref_videos (+ soundtrack flag) / ref_audios. */
export function manifestPayload(manifest: ReferenceManifest) {
  return {
    images: manifest.pictureRefs.map((ref) => ({ assetId: ref.assetId, storageReference: ref.storageReference, filename: ref.filename })),
    videos: manifest.videoRefs.map((ref) => ({ assetId: ref.assetId, storageReference: ref.storageReference, filename: ref.filename, withAudio: ref.withAudio })),
    audios: manifest.audioRefs.filter((ref) => ref.kind === "standalone").map((ref) => ({ assetId: ref.assetId, storageReference: ref.storageReference, filename: ref.filename })),
  };
}

export async function loadManifestRoles(roleIds: string[], getRole: (roleId: string) => Promise<RoleRecord | null>, getAsset: (assetId: string) => Promise<RoleAssetInput | null>) {
  const records = await Promise.all(roleIds.map(async (roleId) => ({ roleId, role: await getRole(roleId) })));
  const roles = records.flatMap((item) => item.role ? [item.role] : []);
  const missingRoleIds = records.filter((item) => !item.role).map((item) => item.roleId);
  const ids = [...new Set(roles.flatMap((role) => [role.primaryAppearanceAssetId, role.primaryVoiceAssetId]).filter((id): id is string => Boolean(id)))];
  const assets = await Promise.all(ids.map(async (id) => [id, await getAsset(id)] as const));
  return { roles, missingRoleIds, roleAssets: Object.fromEntries(assets) as Record<string, RoleAssetInput | null> };
}
