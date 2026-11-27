import { H3_FPS, H3_MAX_LENGTH, H3_MAX_MEGAPIXELS, H3_MIN_LENGTH, H3_MIN_MEGAPIXELS } from "./comfyui/h3-parameters.ts";
import { H3_TASK_LABELS, H3_TASK_STATUS, type H3TaskMode } from "./h3-task-mode.ts";
import { isOfficialFormat, officialSubjects } from "./official-format.ts";
/** 官方格式正文自己定义了几个 <Subject>（最大编号）；不是官方格式返回 null。没定义的编号由 h3q [官方·Subject] 报。 */
export const officialSubjectLimit = (prompt: string) => isOfficialFormat(prompt) ? Math.max(0, ...officialSubjects(prompt).map((subject) => subject.index)) : null;

/**
 * H3 Reference Preflight: runs after "生成" is clicked and before anything is uploaded, recorded or
 * queued. Errors block the submission (no Run, no GPU time); warnings are shown and allowed.
 * Pure — the canvas supplies counts from the same Reference Manifest that orders the payload.
 */

export const H3_LIMITS = { pictures: 9, videos: 3, standaloneAudios: 3 } as const;
/** ComfyUI core MAX_PIXELS (768 × 1344): the trained canvas area. Larger canvases run but are unverified. */
export const H3_TRAINED_PIXEL_AREA = 768 * 1344;
export const H3_REFERENCE_VIDEO_SECONDS = { min: 2, max: 15 } as const;
export const ZERO_BASED_MESSAGE = "【H3参考编号从1开始】";

export interface H3MediaCounts {
  /** Every <Picture N> the model will see (first/last frame count as pictures in I2VA / FL2VA / Hybrid). */
  pictures: number;
  videos: number;
  /** Every <Audio N> label, including reference-video soundtracks. */
  audios: number;
  standaloneAudios: number;
  /** <Subject N> labels (bound roles in the official-structure prompt mode). */
  subjects: number;
}

export interface H3PreflightInput {
  mode: H3TaskMode | null;
  modeProblem?: string | null;
  /** Exactly what will be submitted. */
  prompt: string;
  /** The user's own text (zero-based wording is reported against it); defaults to prompt. */
  rawPrompt?: string;
  counts: H3MediaCounts;
  referenceVideos?: { name: string; durationSeconds: number | null; fps?: number | null }[];
  length: number;
  megapixels: number;
  /** Canvas size when known in advance (T2VA / I2VA / FL2VA). */
  dimensions?: { width: number; height: number } | null;
}

export interface H3PreflightIssue { level: "error" | "warning"; code: string; message: string }
export interface H3PreflightResult { ok: boolean; errors: H3PreflightIssue[]; warnings: H3PreflightIssue[] }

type Kind = "picture" | "video" | "audio" | "subject";
const KIND_NAMES: Record<Kind, string> = { picture: "Picture", video: "Video", audio: "Audio", subject: "Subject" };
const CHINESE_KIND: Record<string, Kind> = { 图: "picture", 图片: "picture", 图像: "picture", 视频: "video", 音频: "audio", 声音: "audio" };
const ANGLE_TAG = /<\s*(Picture|Image|Video|Audio|Subject)\s*(\d+)\s*>/gi;
const BARE_TAG = /(?<![<\w])(Picture|Image|Video|Audio)\s*#?\s*(\d+)(?!\d)(?!\s*>)/gi;
const CHINESE_TAG = /参考(图片|图像|图|视频|音频|声音)\s*(\d+)/g;

const kindOf = (word: string): Kind => { const lower = word.toLowerCase(); return lower === "image" || lower === "picture" ? "picture" : lower as Kind; };
const available = (kind: Kind, counts: H3MediaCounts) => kind === "picture" ? counts.pictures : kind === "video" ? counts.videos : kind === "audio" ? counts.audios : counts.subjects;

/** Every media reference written in a prompt, in three spellings, with its 1-based-or-not number. */
export function findMediaReferences(prompt: string) {
  const found: { text: string; kind: Kind; ordinal: number; style: "tag" | "bare" | "chinese" }[] = [];
  for (const match of prompt.matchAll(ANGLE_TAG)) found.push({ text: match[0], kind: kindOf(match[1]), ordinal: Number(match[2]), style: "tag" });
  for (const match of prompt.matchAll(BARE_TAG)) found.push({ text: match[0], kind: kindOf(match[1]), ordinal: Number(match[2]), style: "bare" });
  for (const match of prompt.matchAll(CHINESE_TAG)) found.push({ text: match[0], kind: CHINESE_KIND[match[1]], ordinal: Number(match[2]), style: "chinese" });
  return found;
}

export function runH3Preflight(input: H3PreflightInput): H3PreflightResult {
  const errors: H3PreflightIssue[] = [];
  const warnings: H3PreflightIssue[] = [];
  const error = (code: string, message: string) => { if (!errors.some((item) => item.message === message)) errors.push({ level: "error", code, message }); };
  const warn = (code: string, message: string) => { if (!warnings.some((item) => item.message === message)) warnings.push({ level: "warning", code, message }); };
  const { counts } = input;

  // Mode
  if (!input.mode) error("mode", input.modeProblem ?? "无法判断生成模式");
  else if (!H3_TASK_STATUS[input.mode].enabled) error("mode_disabled", `${H3_TASK_LABELS[input.mode]}：${H3_TASK_STATUS[input.mode].note}`);

  // 1–3. Reference counts
  if (counts.pictures > H3_LIMITS.pictures) error("picture_limit", `参考图片共 ${counts.pictures} 张，H3 最多 ${H3_LIMITS.pictures} 张（含首帧 / 尾帧 / 角色外观）`);
  if (counts.videos > H3_LIMITS.videos) error("video_limit", `参考视频共 ${counts.videos} 个，H3 最多 ${H3_LIMITS.videos} 个`);
  if (counts.standaloneAudios > H3_LIMITS.standaloneAudios) error("audio_limit", `参考声音共 ${counts.standaloneAudios} 条，H3 最多 ${H3_LIMITS.standaloneAudios} 条（参考视频自带声轨不计入）`);

  // 4. Reference video duration (official guidance 2–15 s at 24 fps)
  for (const video of input.referenceVideos ?? []) {
    if (video.durationSeconds === null || !Number.isFinite(video.durationSeconds)) warn("ref_video_unknown", `参考视频“${video.name}”无法确认时长`);
    else if (video.durationSeconds < H3_REFERENCE_VIDEO_SECONDS.min) error("ref_video_short", `参考视频“${video.name}”只有 ${video.durationSeconds.toFixed(2)} 秒，H3 参考视频至少 ${H3_REFERENCE_VIDEO_SECONDS.min} 秒`);
    else if (video.durationSeconds > H3_REFERENCE_VIDEO_SECONDS.max) warn("ref_video_long", `参考视频“${video.name}”${video.durationSeconds.toFixed(1)} 秒，超过官方建议的 ${H3_REFERENCE_VIDEO_SECONDS.max} 秒；超出生成时长的部分会被截断`);
    if (typeof video.fps === "number" && Number.isFinite(video.fps) && Math.abs(video.fps - H3_FPS) > 0.5) warn("ref_video_fps", `参考视频“${video.name}”是 ${Number(video.fps.toFixed(2))} FPS，H3 按 24 FPS 读取，动作快慢会变化`);
  }

  // 5. Frame count 17n+5 within the trained range
  if (!Number.isInteger(input.length) || (input.length - 5) % 17 !== 0) error("length_grid", `帧数 ${input.length} 不是 H3 合法的 17n+5`);
  else if (input.length < H3_MIN_LENGTH || input.length > H3_MAX_LENGTH) error("length_range", `帧数 ${input.length} 超出 H3 范围 ${H3_MIN_LENGTH}–${H3_MAX_LENGTH}`);

  // 6. Pixel budget / canvas
  if (!(input.megapixels >= H3_MIN_MEGAPIXELS && input.megapixels <= H3_MAX_MEGAPIXELS)) error("megapixels", `像素预算 ${input.megapixels} MP 超出 ${H3_MIN_MEGAPIXELS.toFixed(2)}–${H3_MAX_MEGAPIXELS.toFixed(2)} MP`);
  if (input.dimensions) {
    const { width, height } = input.dimensions;
    if (width % 32 || height % 32) {
      if (input.mode === "t2va") error("dimensions", `画面尺寸 ${width}×${height} 不是 32 的倍数`);
      else warn("dimensions", `画面尺寸 ${width}×${height} 不是 32 的倍数（建议分辨率步进 32）`);
    }
    if (width * height > H3_TRAINED_PIXEL_AREA) warn("pixel_area", `画面 ${width}×${height} 超过 H3 训练面积 768×1344，显存与效果未验证`);
  }

  // 7. Media references in the prompt must exist; numbering starts at 1
  // 官方 Ref2VA 六段式：<Subject N> 由正文 subject_definitions 自己定义（场景也占一个编号），不按角色数算。
  const ownSubjects = officialSubjectLimit(input.rawPrompt ?? input.prompt);
  const references = [...findMediaReferences(input.rawPrompt ?? input.prompt), ...(input.rawPrompt !== undefined && input.rawPrompt !== input.prompt ? findMediaReferences(input.prompt) : [])];
  for (const reference of references) {
    const name = KIND_NAMES[reference.kind];
    if (reference.ordinal === 0) {
      error("zero_based", `${ZERO_BASED_MESSAGE}Prompt 中的“${reference.text}”：第一个${reference.kind === "picture" ? "参考图" : reference.kind === "audio" ? "参考声音" : reference.kind === "video" ? "参考视频" : "主体"}是 ${name} 1`);
      continue;
    }
    // 取「正文定义的」和「角色数」大的那个：以前能载入 / 提交的不会因为认了官方格式反而被拒；没定义的编号由 h3q [官方·Subject] 按单镜拦。
    const limit = reference.kind === "subject" && ownSubjects !== null ? Math.max(ownSubjects, counts.subjects) : available(reference.kind, counts);
    if (reference.ordinal <= limit) continue;
    const message = limit
      ? `Prompt 中的“${reference.text}”不存在：当前只有 ${limit} 个 ${name}`
      : `Prompt 中的“${reference.text}”不存在：当前没有 ${name}${input.mode === "t2va" ? "（文生视频不带图片 / 声音 / 视频）" : ""}`;
    if (reference.style === "bare") warn("tag_missing", `${message}（如果这是普通文字可以忽略）`);
    else error("tag_missing", message);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Media counts the model sees for the non-reference modes (first/last frames are Picture 1 / 2). */
export const frameModeCounts = (mode: "t2va" | "i2va" | "fl2va"): H3MediaCounts => ({ pictures: mode === "t2va" ? 0 : mode === "i2va" ? 1 : 2, videos: 0, audios: 0, standaloneAudios: 0, subjects: 0 });

export const formatPreflight = (result: H3PreflightResult) => [...result.errors.map((item) => `✕ ${item.message}`), ...result.warnings.map((item) => `△ ${item.message}`)].join("\n");
