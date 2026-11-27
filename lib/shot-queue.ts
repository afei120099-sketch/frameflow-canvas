import { UNDERSTANDING_VALUES } from "./comfyui/experimental/h3-community-controls.ts";
import { h3PromptHealth } from "./h3-prompt-health.ts";
import { resolveH3Speaker, readAutoVoicePreference } from './h3-speaker-policy.ts';
import { hasReferenceLine } from './voice-roles.ts';
import { parseH3Dialogue, dialogueAudioIds, type H3DialogueLine } from './h3-dialogue.ts';
import { promptTagErrors, shotPromptWarnings, durationAlignmentWarning } from "./shot-prompt-checks.ts";
import { H3_ASPECT_DIMENSIONS, H3_MIN_MEGAPIXELS, H3_MAX_MEGAPIXELS, H3_ASPECTS, getActualDuration, type H3Aspect } from "./comfyui/h3-parameters.ts";
import { H3_REF_LIMITS } from "./reference-manifest.ts";
import { compileQueueShotPictures, queuePictureSlotCount, type QueuePictureAsset } from "./queue-picture-order.ts";
import type { RoleRecord } from "./role-records.ts";
import { hasQueueFrameSources, parseQueueFrameSource, queueFramePlan, type QueueFrameSource } from './shot-queue-frames.ts';
import { checkTimeAnchors, timeAnchorFrame, timeAnchorPromptProblem, H3_TIME_ANCHOR_MAX } from './comfyui/experimental/h3-ultimate-guide.ts';
import { parseKeyframeDefaults, parseShotKeyframe, type KeyframeDefaults, type ShotKeyframe } from './shot-queue-keyframe.ts';
import { parseEpisodeSettings, expandEpisode, hasPlaceholder, episodeWarnings, usesEpisode, episodeResidue, episodeMarkPaths, type EpisodeSettings } from './episode-settings.ts';
import { isOfficialFormat } from './official-format.ts';

/** Old JSON keeps ultimate as the default; v2 node lock permits explicit workflow/mode choices. */
export const SHOT_QUEUE_VERSION = "shot-queue-v1" as const;
export const SHOT_QUEUE_WORKFLOW = "community-ultimate" as const;
export const SHOT_QUEUE_LOCK = "ultimate-ref2va" as const;
/** Queue nodes created before the ultimate switch. Idle migration upgrades them instead of leaving them on stable. */
export const SHOT_QUEUE_LEGACY_LOCK = "stable-ref2va" as const;

const ASPECTS = H3_ASPECTS.filter((aspect): aspect is Exclude<H3Aspect, "follow"> => aspect !== "follow");
const SOUND = ["av", "ambient", "silent"] as const;
export type ShotQueueSound = (typeof SOUND)[number];

export interface ShotQueueQuality {
  resolution?: "480p" | "720p";
  megapixels?: number;
}
export type QueueWorkflow = "fast" | "ultimate";
export type QueueGenerationMode = "auto" | "first-last" | "extend";
/** 🧪 "understanding": ultimate only — no DMAD LoRA, 25 steps res_multistep/simple, dense attention (see UNDERSTANDING_VALUES). */
export type QueueTuning = "default" | "understanding";
export interface QueueGenerationOptions { workflow?: QueueWorkflow; generationMode?: QueueGenerationMode; seed?: number | "random"; tuning?: QueueTuning }
export interface ShotQueueDefaults extends ShotQueueQuality, QueueGenerationOptions { noBackgroundMusic?: boolean; /** 出片后自动去配乐；不写 = 开 */ autoRemoveMusic?: boolean; /** 先出关键帧：全集共用画风等，见 shot-queue-keyframe.ts */ keyframe?: KeyframeDefaults }
function parseGeneration(value: QueueGenerationOptions, where: string): QueueGenerationOptions {
  const errors:string[]=[];
  if (value.workflow !== undefined && !["fast","ultimate"].includes(value.workflow)) errors.push(where+".workflow 只能为 fast / ultimate");
  if (value.generationMode !== undefined && !["auto","first-last","extend"].includes(value.generationMode)) errors.push(where+".generationMode 只能为 auto / first-last");
  else if (value.generationMode === "extend") errors.push(where+'.generationMode:"extend"（视频延长）已停用，队列不再接受。请改用接尾帧：generationMode 写 "first-last"，加 firstFrameFrom: {"shot":"previous","frame":"last"}（或写上一镜标题），并删掉 sourceShot / sourceVideoAssetId');
  if (value.seed !== undefined && value.seed !== "random" && (!Number.isSafeInteger(value.seed) || Number(value.seed)<0)) errors.push(where+".seed 必须为非负安全整数或 random");
  if (value.tuning !== undefined && !["default","understanding"].includes(value.tuning)) errors.push(where+".tuning 只能为 default / understanding");
  if(errors.length)throw Error(errors.join('\n'));
  return {...(value.workflow !== undefined?{workflow:value.workflow}:{}),...(value.generationMode !== undefined?{generationMode:value.generationMode}:{}),...(value.seed !== undefined?{seed:value.seed}:{}),...(value.tuning !== undefined?{tuning:value.tuning}:{})};
}
export function queueGeneration(shot: QueueGenerationOptions, defaults?: QueueGenerationOptions) {
  return {workflow:shot.workflow??defaults?.workflow??"ultimate",generationMode:shot.generationMode??defaults?.generationMode??"auto",seed:shot.seed??defaults?.seed??"random",tuning:shot.tuning??defaults?.tuning??"default"} as const;
}
/** 🧪 h3_ultimate_guide time anchor: a still image (assetId) or a frame of another queue shot (frameFrom). */
export interface QueueTimeAnchor { atSeconds: number; assetId?: string; frameFrom?: QueueFrameSource; asReference?: boolean }
export interface ShotQueueShot extends ShotQueueQuality, QueueGenerationOptions {
  /** Stable queue-local identity, independent of the display title. */
  shotId?: string;
  timeAnchors?: QueueTimeAnchor[];
  firstFrameFrom?: QueueFrameSource;
  lastFrameFrom?: QueueFrameSource;
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
  sourceVideoAssetId?: string;
  /** Earlier unique shot title, or previous. */
  sourceShot?: string;
  title: string;
  /** 模型收到的正文：本集设定的占位已换回原句（lib/episode-settings.ts）。 */
  prompt: string;
  /** 带 {{本集.…}} 占位的原文；只有用了占位的镜头才有。写回 JSON 用 shotQueueJson。 */
  promptTemplate?: string;
  roleIds: string[];
  sceneAssetIds: string[];
  seconds: number;
  aspect: Exclude<H3Aspect, "follow">;
  soundMode: ShotQueueSound;
  /** Submit this selected Role's primary voice; speech stays in prompt. */
  voiceRoleId?: string;
  /** 🧪 说话角色按对白行第一次开口的顺序（最多 3 个，都在 roleIds 里），每人送主声音；正文只在参考说明末尾加一句（lib/voice-roles.ts）。 */
  voiceRoleIds?: string[];
  dialogue?: H3DialogueLine[];
  autoVoiceDisabled?: boolean;
  /** 单镜覆盖队列的「出片后自动去配乐」 */
  autoRemoveMusic?: boolean;
  autoVoiceAssigned?: boolean;
  offscreenRoleIds?: string[];
  /** 先出关键帧再出视频（原生产线做法）。通过的关键帧写进 firstFrameAssetId。 */
  keyframe?: ShotKeyframe;
}

export interface ShotQueueChapter {
  title: string;
  shots: ShotQueueShot[];
}

export interface ShotQueue {
  autoSwitchPage?:boolean;
  version: typeof SHOT_QUEUE_VERSION;
  title: string;
  chapters: ShotQueueChapter[];
  defaults?: ShotQueueDefaults;
  /** 本集设定：风格、各场景光线句、画面要求、各场景环境底声。 */
  episode?: EpisodeSettings;
}

export interface NamedImage {
  assetId: string;
  src: string;
  name: string;
}

export interface ShotReferencePlan {
  appearances: NamedImage[];
  scenes: NamedImage[];
  pictures: { label: string; name: string }[];
  /** 🧪 Static time anchors (assetId) resolved to local images; frameFrom anchors arrive after their source renders. */
  anchors?: (NamedImage & { atSeconds: number; asReference: boolean })[];
}

const text = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`${label}需要 1–${max} 个字符`);
  return value.trim();
};

const idList = (value: unknown, label: string, min: number, max: number) => {
  if (!Array.isArray(value)) throw new Error(`${label}需要 ${min}–${max} 个`);
  const errors:string[]=[];
  if(value.length < min || value.length > max)errors.push(`${label}需要 ${min}–${max} 个`);
  const ids = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) { errors.push(`${label}第 ${index + 1} 项不是有效 ID`); return ''; }
    return item.trim();
  });
  if (new Set(ids).size !== ids.length) errors.push(`${label}不能重复`);
  if(errors.length)throw Error(errors.join('\n'));
  return ids;
};

function parseQuality(value: unknown, where: string): ShotQueueQuality {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where}必须是对象`);
  const record = value as Record<string, unknown>;
  const errors:string[]=[];
  if (record.resolution !== undefined && record.resolution !== "480p" && record.resolution !== "720p") errors.push(`${where}.resolution 只能是 "480p" 或 "720p"`);
  if (record.megapixels !== undefined && (typeof record.megapixels !== "number" || !Number.isFinite(record.megapixels) || record.megapixels < H3_MIN_MEGAPIXELS || record.megapixels > H3_MAX_MEGAPIXELS)) errors.push(`${where}.megapixels 必须是 0.30～1.00 的数字`);
  if(errors.length)throw Error(errors.join('\n'));
  return {
    ...(record.resolution !== undefined ? {resolution: record.resolution as "480p" | "720p"} : {}),
    ...(record.megapixels !== undefined ? {megapixels: record.megapixels as number} : {}),
  };
}

/** Structure only; frame range, duplicates and the last-frame collision are checked with the shot length. */
function parseQueueTimeAnchors(value: unknown, where: string): QueueTimeAnchor[] {
  if (!Array.isArray(value)) throw new Error(`${where}.timeAnchors 必须是数组`);
  const errors: string[] = [];
  if (value.length > H3_TIME_ANCHOR_MAX) errors.push(`${where}.timeAnchors 最多 ${H3_TIME_ANCHOR_MAX} 项`);
  const anchors = value.map((item, index): QueueTimeAnchor | null => {
    const at = `${where}.timeAnchors[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) { errors.push(`${at} 必须是对象`); return null; }
    const record = item as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) => !["atSeconds", "assetId", "frameFrom", "asReference"].includes(key));
    if (unknown.length) errors.push(`${at} 只支持 atSeconds / assetId / frameFrom / asReference，多出：${unknown.join("、")}`);
    if (typeof record.atSeconds !== "number" || !Number.isFinite(record.atSeconds) || record.atSeconds < 0) errors.push(`${at}.atSeconds 必须是非负数字（秒）`);
    if ((record.assetId === undefined) === (record.frameFrom === undefined)) errors.push(`${at} 必须且只能指定 assetId 或 frameFrom 之一`);
    if (record.assetId !== undefined && (typeof record.assetId !== "string" || !record.assetId.trim())) errors.push(`${at}.assetId 需要图片素材 ID`);
    if (record.asReference !== undefined && typeof record.asReference !== "boolean") errors.push(`${at}.asReference 必须是 true 或 false`);
    let frameFrom: QueueFrameSource | undefined;
    if (record.frameFrom !== undefined) { try { frameFrom = parseQueueFrameSource(record.frameFrom, `${at}.frameFrom`); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } }
    return { atSeconds: record.atSeconds as number, ...(typeof record.assetId === "string" ? { assetId: record.assetId.trim() } : {}), ...(frameFrom ? { frameFrom } : {}), ...(record.asReference === true ? { asReference: true } : {}) };
  });
  if (errors.length) throw new Error(errors.join("\n"));
  return anchors.filter((anchor): anchor is QueueTimeAnchor => !!anchor);
}

/** Per-shot quality overrides queue defaults; within either level an explicit budget wins. */
export function shotQueueMegapixels(shot: Pick<ShotQueueShot, "aspect" | "resolution" | "megapixels">, defaults?: ShotQueueQuality): number {
  const quality = shot.megapixels !== undefined || shot.resolution !== undefined ? shot : defaults;
  if (quality?.megapixels !== undefined) return quality.megapixels;
  if (!quality?.resolution) return 0.50;
  const edge = quality.resolution === "720p" ? 720 : 480;
  const [width, height] = H3_ASPECT_DIMENSIONS[shot.aspect];
  const requested = edge * edge * Math.max(width, height) / Math.min(width, height) / (1024 * 1024);
  return Math.max(H3_MIN_MEGAPIXELS, Math.min(H3_MAX_MEGAPIXELS, requested));
}

export function parseShotQueue(raw: string, autoVoiceEnabled = readAutoVoicePreference()): ShotQueue {
  if (raw.length > 1_500_000) throw new Error("镜头表过大");
  const value = JSON.parse(raw) as Partial<ShotQueue>;
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('镜头表必须是对象');
  const issues: string[] = [];
  const check = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch (error) { issues.push(...(error instanceof Error ? error.message : String(error)).split('\n')); return fallback; } };
  const requireValid = (condition: unknown, message: string) => { if (!condition) issues.push(message); };
  requireValid(value.version===SHOT_QUEUE_VERSION, `镜头表版本必须是 ${SHOT_QUEUE_VERSION}`);
  const title = check(() => text(value.title, "队列标题", 80), "未命名队列");
  const defaults = value.defaults === undefined ? undefined : { ...check(() => parseQuality(value.defaults, "defaults"), {}), ...check(() => parseGeneration(value.defaults!, "defaults"), {}), ...(value.defaults?.noBackgroundMusic !== undefined ? {noBackgroundMusic:value.defaults.noBackgroundMusic} : {}), ...(value.defaults?.autoRemoveMusic !== undefined ? {autoRemoveMusic:value.defaults.autoRemoveMusic} : {}), ...(value.defaults?.keyframe !== undefined ? {keyframe:check(() => parseKeyframeDefaults(value.defaults!.keyframe), {})} : {}) };
  requireValid(defaults?.noBackgroundMusic === undefined || typeof defaults.noBackgroundMusic === "boolean", "defaults.noBackgroundMusic 必须是 true 或 false");
  requireValid(defaults?.autoRemoveMusic === undefined || typeof defaults.autoRemoveMusic === "boolean", "defaults.autoRemoveMusic 必须是 true 或 false");
  const episodeParse = parseEpisodeSettings((value as Record<string, unknown>).episode);
  issues.push(...episodeParse.errors);
  const episode = episodeParse.episode;
  // 和 h3q 一样：队列有 episode，或哪里写了「本集.」，才按本集设定的规则查；旧队列一个字都不多查。
  const episodeMode = usesEpisode(value);
  if (episodeMode) for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (key === "chapters" || key === "episode") continue;
    for (const path of episodeMarkPaths(field, key)) issues.push(`${path} 里写了 {{本集.…}}；占位只能写在镜头的 prompt 里`);
  }
  requireValid(Array.isArray(value.chapters) && value.chapters.length >= 1 && value.chapters.length <= 40, "需要 1–40 章");
  const chapters = (Array.isArray(value.chapters) ? value.chapters : []).map((chapter, chapterIndex) => {
    const where = `第 ${chapterIndex + 1} 章`;
    if (!chapter || typeof chapter !== "object" || Array.isArray(chapter)) { issues.push(`${where}格式错误`); return {title:where,shots:[]}; }
    if (episodeMode && episodeMarkPaths(chapter.title, "title").length) issues.push(`${where}标题里写了 {{本集.…}}；占位只能写在镜头的 prompt 里`);
    const chapterTitle = check(() => text(chapter.title, `${where}标题`, 80), where);
    requireValid(Array.isArray(chapter.shots) && chapter.shots.length >= 1, `${where}需要至少 1 个镜头`);
    const shots = (Array.isArray(chapter.shots) ? chapter.shots : []).map((shot, shotIndex) => {
      const shotWhere = `${where}第 ${shotIndex + 1} 镜「${shot?.title ?? "未命名"}」`;
      if (!shot || typeof shot !== "object" || Array.isArray(shot)) { issues.push(`${shotWhere}格式错误`); shot = {} as ShotQueueShot; }
      const record = shot as Partial<ShotQueueShot> & { mode?: unknown; promptMode?: unknown };
      requireValid(record.mode === undefined || record.mode === "ref2va", `${shotWhere}只能使用多参考 ref2va`);
      requireValid(record.promptMode === undefined || record.promptMode === "plain", `${shotWhere}只能使用普通提示词`);
      const roleIds = check(() => idList(record.roleIds, `${shotWhere}角色`, 0, 6), []);
      const offscreenRoleIds = record.offscreenRoleIds === undefined ? [] : check(() => idList(record.offscreenRoleIds, `${shotWhere}.offscreenRoleIds`, 0, 6), []);
      requireValid(!offscreenRoleIds.some(id => !roleIds.includes(id)), `${shotWhere}.offscreenRoleIds 必须是 roleIds 中的角色`);
      const sceneAssetIds = check(() => idList(record.sceneAssetIds, `${shotWhere}场景图`, 0, 6), []);
      requireValid(roleIds.length - offscreenRoleIds.length + sceneAssetIds.length <= H3_REF_LIMITS.images, `${shotWhere}人物加场景超过 ${H3_REF_LIMITS.images} 张参考图`);
      const seconds = record.seconds;
      requireValid(typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 5 && seconds <= 15, `${shotWhere}时长 seconds 必须为 5 到 15 秒的数字`);
      const aspect = record.aspect ?? "9:16";
      requireValid(ASPECTS.includes(aspect as Exclude<H3Aspect, "follow">), `${shotWhere}比例只能是 ${ASPECTS.join(" / ")}`);
      const soundMode = record.soundMode ?? "av";
      requireValid(SOUND.includes(soundMode as ShotQueueSound), `${shotWhere}声音只能是 av / ambient / silent`);
      requireValid(record.autoVoiceDisabled === undefined || typeof record.autoVoiceDisabled === 'boolean', shotWhere+'.autoVoiceDisabled 必须是布尔值');
      requireValid(record.autoRemoveMusic === undefined || typeof record.autoRemoveMusic === 'boolean', shotWhere+'.autoRemoveMusic 必须是 true 或 false');
      const voiceRoleId = record.voiceRoleId === undefined ? undefined : check(() => text(record.voiceRoleId, `${shotWhere}.voiceRoleId`, 200), undefined);
      // 🧪 voiceRoleIds：数组可以是空的（等于没写）；重复、超 3 个、不在 roleIds 里等由 resolveH3Speaker 报。
      const voiceRoleIds = record.voiceRoleIds === undefined ? [] : check(() => idList(record.voiceRoleIds, `${shotWhere}.voiceRoleIds`, 0, 6), []);
      // 本集设定：先把占位换回原句，之后的检查、提交都只看换回后的正文（和逐字复制的写法一字不差）。
      const rawPrompt = (record as { prompt?: unknown }).prompt;
      const storedTemplate = (record as { promptTemplate?: unknown }).promptTemplate;
      let promptTemplate: string | undefined;
      let promptSource: unknown = rawPrompt;
      if (typeof rawPrompt === "string" && hasPlaceholder(rawPrompt)) {
        const expanded = expandEpisode(rawPrompt, episode);
        issues.push(...expanded.errors.map(error => `${shotWhere}：${error}`));
        promptTemplate = rawPrompt.trim(); promptSource = expanded.text;
      } else if (typeof rawPrompt === "string" && typeof storedTemplate === "string" && hasPlaceholder(storedTemplate) && episode) {
        // 解析结果被直接 JSON.stringify 过（会话记录等）：模板展开后和正文一样才认。
        const expanded = expandEpisode(storedTemplate, episode);
        if (!expanded.errors.length && expanded.text.trim() === rawPrompt.trim()) promptTemplate = storedTemplate.trim();
      }
      if (episodeMode && typeof promptSource === "string" && promptSource === rawPrompt) { // 有占位的已在 expandEpisode 里查过
        const residue = episodeResidue(promptSource);
        if (residue) issues.push(`${shotWhere}：展开后正文里还剩「${residue}」，占位写坏了（只认两层半角大括号，例如 {{本集.风格}}、{{本集.光线.办公室}}）`);
      }
      if (episodeMode) { const { prompt: _p, promptTemplate: _t, ...rest } = record as Record<string, unknown>; void _p; void _t; for (const path of episodeMarkPaths(rest, "")) issues.push(`${shotWhere}：${path} 里写了 {{本集.…}}；占位只能写在 prompt 里（标题、关键帧描述、对白里不换，会原样发给模型）`); }
      const prompt = check(() => text(promptSource, `${shotWhere}提示词`, 12000), '');
      const dialogue = check(() => parseH3Dialogue(record.dialogue,roleIds,shotWhere+'.dialogue'), []);
      const speaker = resolveH3Speaker({prompt,roleIds,voiceRoleId,voiceRoleIds,dialogue,autoVoiceDisabled:record.autoVoiceDisabled,autoVoiceEnabled,soundMode});
      issues.push(...speaker.errors.map(error => shotWhere+'：'+error));
      const effectiveVoiceRoleId = speaker.voiceRoleId;
      requireValid(!voiceRoleId || roleIds.includes(voiceRoleId), `${shotWhere}.voiceRoleId 必须包含在本镜头 roleIds 中`);
      requireValid(!voiceRoleId || soundMode === "av", `${shotWhere}指定主声音时 soundMode 必须是 av；无对白镜头请省略 voiceRoleId`);
      requireValid(!voiceRoleIds.length || !prompt || hasReferenceLine(prompt) || isOfficialFormat(prompt), `${shotWhere}写了 voiceRoleIds，正文要有「参考说明」那一句（声音说明只接在它末尾）`);
      const generation = queueGeneration(record, defaults);
      const sources = Object.fromEntries(["firstFrameAssetId","lastFrameAssetId","sourceVideoAssetId","sourceShot"].filter(k => record[k as keyof ShotQueueShot] !== undefined).map(k => [k,check(() => text(record[k as keyof ShotQueueShot],shotWhere+"."+k,200), '')])) as Pick<ShotQueueShot,"firstFrameAssetId"|"lastFrameAssetId"|"sourceVideoAssetId"|"sourceShot">;
      const firstFrameFrom = check(() => parseQueueFrameSource(record.firstFrameFrom, shotWhere+'.firstFrameFrom'), undefined);
      const lastFrameFrom = check(() => parseQueueFrameSource(record.lastFrameFrom, shotWhere+'.lastFrameFrom'), undefined);
      requireValid(!(firstFrameFrom || lastFrameFrom) || generation.generationMode === 'first-last', shotWhere+' 自动截帧只适用于 first-last');
      requireValid(!((firstFrameFrom && sources.firstFrameAssetId) || (lastFrameFrom && sources.lastFrameAssetId)), shotWhere+' 同一端不能同时指定图片和视频截帧来源');
      requireValid(!(firstFrameFrom || lastFrameFrom) || roleIds.length-offscreenRoleIds.length+sceneAssetIds.length+Number(!!sources.firstFrameAssetId||!!firstFrameFrom)+Number(!!sources.lastFrameAssetId||!!lastFrameFrom) <= H3_REF_LIMITS.images, shotWhere+' 当前自动截帧链路的人物、场景和首尾帧合计最多9张，请减少参考图');
      requireValid(generation.generationMode !== "first-last" || sources.firstFrameAssetId || sources.lastFrameAssetId || firstFrameFrom || lastFrameFrom, shotWhere+" 首尾帧模式需要 firstFrameAssetId / lastFrameAssetId 或 firstFrameFrom / lastFrameFrom");
      requireValid(generation.generationMode === "first-last" || !(sources.firstFrameAssetId || sources.lastFrameAssetId), shotWhere+" 首尾帧素材只适用于 first-last");
      requireValid(!(sources.sourceShot || sources.sourceVideoAssetId), shotWhere+" sourceShot / sourceVideoAssetId 只属于已停用的视频延长，请删掉；接上一镜画面用 firstFrameFrom");
      const audioCount=dialogueAudioIds(dialogue).length+(record.autoVoiceDisabled?0:new Set(dialogue.filter(line=>line.roleId).map(line=>line.roleId)).size)+(effectiveVoiceRoleId?1:0)+voiceRoleIds.length;
      requireValid(dialogueAudioIds(dialogue).length<=H3_REF_LIMITS.audios, shotWhere+' 对白声音素材超过3条，请减少不同参考声音');
      const slotCount = queuePictureSlotCount({ sceneAssetIds, roleIds, offscreenRoleIds, firstFrameAssetId: sources.firstFrameAssetId, lastFrameAssetId: sources.lastFrameAssetId, firstFrameFrom, lastFrameFrom });
      // 🧪 h3_ultimate_guide: anchors take no Picture number unless asReference; absent field changes nothing.
      const timeAnchors = record.timeAnchors === undefined ? [] : check(() => parseQueueTimeAnchors(record.timeAnchors, shotWhere), []);
      const anchorReferences = timeAnchors.filter((anchor) => anchor.asReference).length;
      if (timeAnchors.length) {
        const hasFirst = !!sources.firstFrameAssetId || !!firstFrameFrom, hasLast = !!sources.lastFrameAssetId || !!lastFrameFrom;
        if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 5 && seconds <= 15) check(() => checkTimeAnchors(timeAnchors.map((anchor, i) => ({ imageName: `anchor-${i}`, frameIdx: timeAnchorFrame(anchor.atSeconds) })), getActualDuration(seconds).length, { first: hasFirst, last: hasLast }), undefined);
        requireValid(roleIds.length-offscreenRoleIds.length+sceneAssetIds.length+Number(hasFirst)+Number(hasLast)+anchorReferences <= H3_REF_LIMITS.images, shotWhere+' 人物、场景、首尾帧与“同时作为参考图”的锚点合计超过9张');
        const tagIssue = timeAnchorPromptProblem(prompt, slotCount.pictures + anchorReferences, timeAnchors.length);
        if (tagIssue) issues.push(`${shotWhere}：${tagIssue}`);
      }
      // 官方格式送声音：<Audio N> 和 voiceRoleIds 对不上在卡片画面检查里拦（officialVoiceProblem），载入时不按声音条数拒整份队列。
      const audioLimit = isOfficialFormat(prompt) ? Math.max(audioCount, H3_REF_LIMITS.audios) : audioCount;
      const errors = promptTagErrors(prompt, {subjects:roleIds.length,pictures:slotCount.pictures + anchorReferences,videos:0,audios:audioLimit,standaloneAudios:audioLimit});
      issues.push(...errors.map(error => `${shotWhere}：${error}`));
      return {
        ...check(() => parseQuality(record, shotWhere), {}), ...check(() => parseGeneration(record, shotWhere), {}), ...sources,
        ...(record.shotId !== undefined ? {shotId:check(() => text(record.shotId, shotWhere+'.shotId', 80), '')} : {}),
        ...(firstFrameFrom ? {firstFrameFrom} : {}), ...(lastFrameFrom ? {lastFrameFrom} : {}),
        ...(timeAnchors.length ? {timeAnchors} : {}),
        title: check(() => text(record.title, `${shotWhere}标题`, 80), '未命名'),
        prompt,
        ...(promptTemplate !== undefined ? { promptTemplate } : {}),
        roleIds,
        sceneAssetIds,
        seconds: seconds as number,
        aspect: aspect as Exclude<H3Aspect, "follow">,
        soundMode: soundMode as ShotQueueSound,
        ...(effectiveVoiceRoleId ? { voiceRoleId:effectiveVoiceRoleId } : {}),
        ...(voiceRoleIds.length ? { voiceRoleIds } : {}),
        ...(dialogue.length ? {dialogue} : {}),
        ...(record.autoVoiceDisabled ? {autoVoiceDisabled:true} : {}),
        ...(typeof record.autoRemoveMusic === 'boolean' ? {autoRemoveMusic:record.autoRemoveMusic} : {}),
        ...((!dialogue.length && (speaker.automatic || record.autoVoiceAssigned===true)) ? {autoVoiceAssigned:true} : {}),
        ...(offscreenRoleIds.length ? {offscreenRoleIds} : {}),
        ...(record.keyframe !== undefined ? {keyframe:check(() => parseShotKeyframe(record.keyframe, shotWhere, {roleIds, chained:!!firstFrameFrom}), {prompt:''})} : {}),
      };
    });
    return { title: chapterTitle, shots };
  });
  const flat = chapters.flatMap(chapter=>chapter.shots);
  const seenIds = new Set<string>();
  for (const shot of flat) if (shot.shotId) { requireValid(!seenIds.has(shot.shotId), 'shotId 重复：'+shot.shotId); seenIds.add(shot.shotId); }
  requireValid(value.autoSwitchPage===undefined||typeof value.autoSwitchPage==='boolean','autoSwitchPage必须是布尔值');
  const parsed = { version: SHOT_QUEUE_VERSION, title, chapters, ...(defaults ? {defaults} : {}), ...(episode ? {episode} : {}),...(value.autoSwitchPage===undefined?{}:{autoSwitchPage:value.autoSwitchPage}) };
  if (flat.some(hasQueueFrameSources)) check(() => queueFramePlan(parsed), undefined);
  if (issues.length) throw new ShotQueueValidationError([...new Set(issues)]);
  return parsed;
}

export class ShotQueueValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) { super(issues.join('\n')); this.issues=issues; this.name = 'ShotQueueValidationError'; }
}

export function shotQueueExample(): ShotQueue {
  return {
    version: SHOT_QUEUE_VERSION,
    title: "第一集",
    chapters: [{
      title: "雨夜门口",
      shots: [{
        title: "她推开门",
        prompt: "Picture 1 is the doorway and street, used as the location. Picture 2 is the woman, fully preserved. She pushes the door open and steps into the rain. One continuous shot, no cut.",
        roleIds: ["把角色库里的 roleId 贴在这里"],
        sceneAssetIds: ["把素材库里的场景图 assetId 贴在这里"],
        seconds: 6,
        aspect: "9:16",
        soundMode: "av",
      }],
    }],
  };
}

/** Format-only placeholders: invalid local Asset/Role IDs prevent accidental sample rendering. */
export function shotQueueFrameExample(): ShotQueue {
  const base = {prompt:'请填写本片段独立提示词；本示例不是正式剧本',roleIds:['请替换当前画布角色roleId'],sceneAssetIds:['请替换当前画布场景图assetId'],seconds:6,aspect:'9:16' as const,soundMode:'ambient' as const,autoVoiceDisabled:true};
  return {version:SHOT_QUEUE_VERSION,title:'主镜头＋独立续段／过渡段（请替换占位内容）',chapters:[{title:'第一阶段：主镜头',shots:[{...base,title:'镜头A'},{...base,title:'镜头B'}]},
    {title:'第二阶段：独立片段，不合并',shots:[
      {...base,title:'镜头A-续段1',generationMode:'first-last',firstFrameFrom:{shot:'镜头A',frame:'last'}},
      {...base,title:'镜头A到B-过渡',generationMode:'first-last',firstFrameFrom:{shot:'镜头A',frame:'last'},lastFrameFrom:{shot:'镜头B',frame:'first'}},
      {...base,title:'镜头A-续段2',generationMode:'first-last',firstFrameFrom:{shot:'镜头A-续段1',frame:'last'}},
    ]}]};
}

type ImageAsset = QueuePictureAsset;

/** Picture labels follow the same keyframe-first order as H3 submission. Role appearances stay off the node reference bar. */
export function planShotReferences(shot: ShotQueueShot, roles: readonly Pick<RoleRecord, "roleId" | "displayName" | "primaryAppearanceAssetId">[], assets: ReadonlyMap<string, ImageAsset>): ShotReferencePlan {
  const appearances: NamedImage[] = [];
  for (const roleId of shot.roleIds) {
    const role = roles.find((item) => item.roleId === roleId);
    if (!role) throw new Error(`角色不存在：${roleId}`);
    if (shot.offscreenRoleIds?.includes(roleId)) continue;
    if (!role.primaryAppearanceAssetId) throw new Error(`角色「${role.displayName}」没有主外观`);
    const asset = assets.get(role.primaryAppearanceAssetId);
    if (!asset || asset.kind !== "image") throw new Error(`角色「${role.displayName}」的主外观不是可用图片`);
    if (appearances.some((item) => item.assetId === asset.assetId)) throw new Error(`角色「${role.displayName}」与另一角色共用同一张主外观`);
    appearances.push({ assetId: asset.assetId, src: asset.storageReference, name: asset.filename });
  }
  const scenes: NamedImage[] = [];
  for (const assetId of shot.sceneAssetIds) {
    const asset = assets.get(assetId);
    if (!asset || asset.kind !== "image") throw new Error(`场景图不存在或不是图片：${assetId}`);
    if (appearances.some((item) => item.assetId === asset.assetId)) throw new Error(`场景图「${asset.filename}」与角色主外观是同一张，请换一张场景图`);
    scenes.push({ assetId: asset.assetId, src: asset.storageReference, name: asset.filename });
  }
  const selected = shot.roleIds.flatMap(id => roles.filter(role => role.roleId === id));
  const roleAssets = Object.fromEntries([...assets.values()].filter(asset => asset.kind === "image" || asset.kind === "audio" || asset.kind === "video").map(asset => [asset.assetId, { assetId: asset.assetId, kind: asset.kind as "image" | "audio" | "video", storageReference: asset.storageReference, filename: asset.filename }]));
  const pictures = compileQueueShotPictures({
    shot, scenes, assets, roleAssets, includeRoleVoices: false,
    roles: selected.map(role => ({ roleId: role.roleId, displayName: role.displayName, description: "", appearanceAssetIds: role.primaryAppearanceAssetId ? [role.primaryAppearanceAssetId] : [], voiceAssetIds: [], primaryAppearanceAssetId: role.primaryAppearanceAssetId, primaryVoiceAssetId: null })),
  }).pictures;
  const anchors = (shot.timeAnchors ?? []).flatMap((anchor) => {
    if (!anchor.assetId) return [];
    const asset = assets.get(anchor.assetId);
    if (!asset || asset.kind !== "image" || !asset.storageReference) throw new Error(`时间锚点图不存在或不是图片：${anchor.assetId}`);
    return [{ assetId: asset.assetId, src: asset.storageReference, name: asset.filename, atSeconds: anchor.atSeconds, asReference: Boolean(anchor.asReference) }];
  });
  return { appearances, scenes, pictures, ...(anchors.length ? { anchors } : {}) };
}

export function shotQueueH3Props(shot: ShotQueueShot, plan: ShotReferencePlan, defaults?: ShotQueueDefaults) {
  const option = queueGeneration(shot, defaults);
  // fast (dialogue) and extend use other graphs; the understanding preset only targets ultimate.
  const understanding = option.tuning === "understanding" && option.workflow === "ultimate" && option.generationMode !== "extend";
  return {
    workflowOptionId: option.generationMode === "extend" ? "h3-extend" : option.workflow === "fast" ? "community-dialogue" : SHOT_QUEUE_WORKFLOW,
    workflowLock: "queue-config-v2",
    allReferenceMode: option.generationMode !== "auto" || !!(shot.roleIds.length || shot.sceneAssetIds.length || shot.voiceRoleId || shot.voiceRoleIds?.length),
    promptMode: "plain" as const,
    prompt: shot.prompt,
    mode: shot.aspect,
    megapixels: shotQueueMegapixels(shot, defaults),
    duration: String(shot.seconds),
    soundMode: shot.soundMode,
    roleIds: [...shot.roleIds],
    ...(shot.voiceRoleId ? { voiceRoleId: shot.voiceRoleId } : {}),
    ...(shot.voiceRoleIds?.length ? { voiceRoleIds: [...shot.voiceRoleIds] } : {}),
    ...(shot.dialogue?.length ? {dialogueLines:structuredClone(shot.dialogue)} : {}),
    ...(shot.autoVoiceDisabled ? {autoVoiceDisabled:true} : {}),
    ...(shot.offscreenRoleIds?.length ? { offscreenRoleIds: [...shot.offscreenRoleIds] } : {}),
    ...(defaults?.noBackgroundMusic !== undefined ? { noBackgroundMusic: defaults.noBackgroundMusic } : {}),
    autoRemoveMusic: shot.autoRemoveMusic ?? defaults?.autoRemoveMusic ?? true,
    shotTitle: shot.title,
    referenceImages: plan.scenes.map(({ src, name }) => ({ src, name })),
    ...(plan.anchors?.length ? { timeAnchors: plan.anchors.map(({ assetId, src, name, atSeconds, asReference }) => ({ assetId, storageReference: src, filename: name, atSeconds, ...(asReference ? { asReference: true } : {}) })) } : {}),
    generationCount: 1,
    seedMode: option.seed === "random" ? "随机" : "固定",
    seed: option.seed === "random" ? "" : String(option.seed),
    hybridLock: false,
    ultimateKeyframes: option.generationMode === "first-last",
    steps: understanding ? Number(UNDERSTANDING_VALUES["160.steps"]) : option.workflow === "fast" ? 5 : 10,
    loraStrength: understanding ? 0 : option.workflow === "fast" ? 1 : 0.75,
    ...(understanding ? { communityParameters: JSON.stringify({ [SHOT_QUEUE_WORKFLOW]: { ...UNDERSTANDING_VALUES } }) } : {}),
  };
}

export interface QueueNodeState {
  busy: boolean;
  status: string;
  error: string;
  taskMode?: string;
  preflight: { ok: boolean; errors: { message: string }[] };
  generate: () => Promise<void>;
}

export type ShotRunStatus = "pending" | "running" | "completed" | "failed" | "stopped";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function poll<T>(read: () => T | null, accept: (value: T) => boolean, timeoutMs: number, signal: AbortSignal, refocus: () => void, wait: (ms: number) => Promise<void>) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal.aborted) throw new DOMException("已停止", "AbortError");
    const value = read();
    if (!value) refocus();
    else if (accept(value)) return value;
    await wait(250);
  }
  return null;
}

export type ChapterRunResult = "completed" | "failed" | "stopped";

/** Submit one chapter serially. A failed shot or a stop ends the chapter and reports that result. */
export async function runChapterShots(plans: { props: ReturnType<typeof shotQueueH3Props> }[], deps: {
  create: (props: ReturnType<typeof shotQueueH3Props>, index: number) => Promise<{ id: string }>;
  read: (id: string) => QueueNodeState | null;
  focus: (id: string) => void;
  signal: AbortSignal;
  onUpdate: (index: number, status: ShotRunStatus, detail: string) => void;
  wait?: (ms: number) => Promise<void>;
}): Promise<ChapterRunResult> {
  const wait = deps.wait ?? sleep;
  const stopRest = (from: number, detail: string) => {
    for (let rest = from; rest < plans.length; rest++) deps.onUpdate(rest, "stopped", detail);
  };
  for (let index = 0; index < plans.length; index++) {
    if (deps.signal.aborted) {
      stopRest(index, "本章已停止，这一镜没有提交");
      return "stopped";
    }
    deps.onUpdate(index, "running", "正在创建稳定多参考节点");
    try {
      const node = await deps.create(plans[index].props, index);
      deps.focus(node.id);
      const ready = await poll<QueueNodeState>(() => deps.read(node.id), (state) => state.taskMode === "ref2va" && !state.busy, 12_000, deps.signal, () => deps.focus(node.id), wait);
      if (!ready) {
        deps.onUpdate(index, "failed", "节点没有进入稳定多参考，本章后面的镜头不再提交");
        stopRest(index + 1, "前面的镜头没有提交成功，本章不再继续");
        return "failed";
      }
      await ready.generate();
      const done = await poll<QueueNodeState>(
        () => deps.read(node.id),
        (state) => !state.busy && (state.status === "completed" || state.status === "failed" || state.status === "cancelled"),
        20_000,
        new AbortController().signal,
        () => deps.focus(node.id),
        wait,
      );
      if (!done || done.status !== "completed") {
        deps.onUpdate(index, "failed", done?.error || done?.status || "生成没有完成，本章后面的镜头不再提交");
        stopRest(index + 1, "前面的镜头没有生成完成，本章不再继续");
        return "failed";
      }
      deps.onUpdate(index, "completed", "已写入镜头板，请审核后再采用");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        deps.onUpdate(index, "stopped", "已停止，这一镜没有提交");
        stopRest(index + 1, "本章已停止，这一镜没有提交");
        return "stopped";
      }
      deps.onUpdate(index, "failed", error instanceof Error ? error.message : "提交失败");
      stopRest(index + 1, "前面的镜头没有提交成功，本章不再继续");
      return "failed";
    }
  }
  return "completed";
}

/** Spacing under one second is a warning only; parseShotQueue already rejected invalid frames. */
export function timeAnchorWarnings(shot: ShotQueueShot) {
  if (!shot.timeAnchors?.length) return [];
  try { return checkTimeAnchors(shot.timeAnchors.map((anchor, i) => ({ imageName: `anchor-${i}`, frameIdx: timeAnchorFrame(anchor.atSeconds) })), getActualDuration(shot.seconds).length, { first: !!(shot.firstFrameAssetId || shot.firstFrameFrom), last: !!(shot.lastFrameAssetId || shot.lastFrameFrom) }).warnings.map((warning) => `🧪 ${warning}`); }
  catch { return []; }
}

/** H3 提示词体检 on the raw queue prompt (hints only). */
export function shotHealth(shot: ShotQueueShot, defaults?: ShotQueueDefaults) {
  return shotHealthHints(shot, defaults).map((hint) => `体检：${hint.message}`);
}
/** Same hints with their codes (镜头卡片 merges the ones h3q / the card already say). */
export function shotHealthHints(shot: ShotQueueShot, defaults?: ShotQueueDefaults) {
  const option = queueGeneration(shot, defaults);
  return h3PromptHealth(shot.prompt, {
    seconds: shot.seconds,
    firstFrame: option.generationMode === "first-last" || Boolean(shot.firstFrameAssetId || shot.firstFrameFrom),
    soundMode: shot.soundMode, hasDialogue: Boolean(shot.dialogue?.length), offscreen: Boolean(shot.offscreenRoleIds?.length),
    tuning: option.tuning === "understanding" && option.workflow === "ultimate" && option.generationMode !== "extend" ? "understanding" : "default",
  });
}

export function shotQueueWarnings(queue: ShotQueue) {
  return [...episodeWarnings(queue), ...queue.chapters.flatMap(chapter => chapter.shots.flatMap(shot => [
    ...(shot.autoVoiceAssigned ? ['检测到台词且未指定 voiceRoleId，已自动使用本镜头第一个角色的主声音；请核对角色和 Audio 编号'] : []),
    ...(shot.dialogue??[]).flatMap((line,index)=>line.roleId?[]:[`第${index+1}句「${line.speaker}」${line.voice?.startsWith('audio:')?'使用指定声音素材，不带角色主声音':'该句不带角色声音（无声音参考）'}；请在提示词里明确此人的身份、外观及声音特征${shot.prompt.includes(line.speaker??'')?'':'；当前提示词未找到该说话者名称'}`]),
    ...shotPromptWarnings(shot.prompt,shot.seconds,shot.dialogue), durationAlignmentWarning(shot.seconds),
    ...shotHealth(shot, queue.defaults),
    ...timeAnchorWarnings(shot),
  ].filter((warning): warning is string => Boolean(warning)).map(message => `「${shot.title}」${message}`)))];
}
