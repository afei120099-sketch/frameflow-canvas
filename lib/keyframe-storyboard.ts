import { KEYFRAME_BATCH_LIMIT, KEYFRAME_INPUT_MASTER, type KeyframeStepPlan } from "./keyframe-batch.ts";

/**
 * keyframe-batch-v3: one storyboard image per frame. Its depth map (Depth Anything V2) fixes the
 * composition, camera and pose, PuLID fixes the face, and the text only describes the look.
 * Flux Dev's text encoders (CLIP-L + T5) read English; negations ("no …", "not …") tend to add the
 * very thing they name, so the prompt is built only from positive descriptions.
 */
export const KEYFRAME_STORYBOARD_VERSION = "keyframe-batch-v3" as const;
export const STORYBOARD_SIZES = { "9:16": { width: 864, height: 1536 }, "16:9": { width: 1536, height: 864 } } as const;
export const STORYBOARD_FLUX = { steps: 24, faceWeight: 0.85, depthStrength: 1 } as const;
export type StoryboardAspect = keyof typeof STORYBOARD_SIZES;

export interface StoryboardFrame {
  shotId: string;
  storyboardAssetId: string;
  prompt: string;
  /** null = no identity lock (empty shot or extras only). Falls back to the document face. */
  faceReferenceAssetId: string | null;
  faceWeight: number;
  seed: number | null;
}

export interface KeyframeStoryboardDocument {
  version: typeof KEYFRAME_STORYBOARD_VERSION;
  aspect: StoryboardAspect;
  faceReferenceAssetId: string;
  look: string;
  depthStrength: number;
  frames: StoryboardFrame[];
}

export interface StoryboardStep extends KeyframeStepPlan {
  shotId: string;
  storyboardAssetId: string;
  faceReferenceAssetId: string;
  faceWeight: number;
  seed: number | null;
}

const PICTURE_TAG = /<\s*picture\b|＜\s*picture\b|\bpicture\s*(?:\d+|k)\b/i;
const CJK = /[㐀-鿿豈-﫿]/;
const NEGATION = /\b(?:no|not|never|without|don't|do not|avoid)\b|不要|不能|没有|禁止|别/i;

function oneLine(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function text(value: unknown, where: string, max: number, allowEmpty = false) {
  if (typeof value !== "string") throw new Error(`${where}必须是字符串`);
  const line = oneLine(value);
  if ((!line && !allowEmpty) || line.length > max) throw new Error(`${where}需要 ${allowEmpty ? 0 : 1}–${max} 个字符`);
  if (PICTURE_TAG.test(line)) throw new Error(`${where}不要写 Picture 编号`);
  return line;
}

function number(value: unknown, where: string, min: number, max: number, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${where}需在 ${min}–${max} 之间`);
  return value;
}

/** Problems that make Flux misread the text. Returned as hints; they do not block the batch. */
export function storyboardPromptWarnings(prompt: string) {
  const warnings: string[] = [];
  if (CJK.test(prompt)) warnings.push("含中文：Flux Dev 基本读不懂中文，请写英文");
  if (NEGATION.test(prompt)) warnings.push("含否定词（no/not/不要…）：Flux 会把被否定的东西画出来，请只写要什么");
  return warnings;
}

export function buildStoryboardPrompt(look: string, framePrompt: string) {
  // Camera, framing and pose come from the storyboard depth map; the text describes appearance only.
  return [oneLine(framePrompt), oneLine(look), "photorealistic film still, natural skin texture"].map(part => part.replace(/[.。\s]+$/, "")).filter(Boolean).join(". ") + ".";
}

const DOCUMENT_FIELDS = new Set(["version", "aspect", "faceReferenceAssetId", "look", "depthStrength", "frames"]);
const FRAME_FIELDS = new Set(["shotId", "storyboardAssetId", "prompt", "faceReferenceAssetId", "faceWeight", "seed"]);

export function parseKeyframeStoryboard(raw: string): KeyframeStoryboardDocument {
  if (raw.length > 200_000) throw new Error("关键帧表过大");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("关键帧表不是合法 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("关键帧表必须是对象");
  const record = value as Record<string, unknown>;
  if (record.version !== KEYFRAME_STORYBOARD_VERSION) throw new Error(`分镜关键帧表版本必须是 ${KEYFRAME_STORYBOARD_VERSION}`);
  const extra = Object.keys(record).filter(key => !DOCUMENT_FIELDS.has(key));
  if (extra.length) throw new Error(`${extra[0]} 不属于分镜关键帧表。只写 ${[...DOCUMENT_FIELDS].join("、")}`);
  const aspect = record.aspect === undefined ? "9:16" : record.aspect;
  if (aspect !== "9:16" && aspect !== "16:9") throw new Error("aspect 只能是 9:16 或 16:9");
  const faceReferenceAssetId = text(record.faceReferenceAssetId ?? "", "faceReferenceAssetId", 80, true);
  const look = text(record.look ?? "", "look", 600, true);
  const depthStrength = number(record.depthStrength, "depthStrength", 0.3, 1.5, STORYBOARD_FLUX.depthStrength);
  if (!Array.isArray(record.frames) || record.frames.length < 1 || record.frames.length > KEYFRAME_BATCH_LIMIT) throw new Error(`frames 需要 1–${KEYFRAME_BATCH_LIMIT} 张`);
  const seen = new Set<string>();
  const frames = record.frames.map((frame, index): StoryboardFrame => {
    const where = `第 ${index + 1} 张`;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error(`${where}必须是对象`);
    const item = frame as Record<string, unknown>;
    const unexpected = Object.keys(item).filter(key => !FRAME_FIELDS.has(key));
    if (unexpected.length) throw new Error(`${where}的 ${unexpected[0]} 不属于这一张。只写 ${[...FRAME_FIELDS].join("、")}`);
    const shotId = text(item.shotId, `${where}的 shotId`, 80);
    if (seen.has(shotId)) throw new Error(`${where}的 shotId 和前面重复`);
    seen.add(shotId);
    let seed: number | null = null;
    if (item.seed !== undefined && item.seed !== null) {
      if (!Number.isSafeInteger(item.seed) || (item.seed as number) < 0) throw new Error(`${where}的 seed 需为非负整数`);
      seed = item.seed as number;
    }
    const ownFace = item.faceReferenceAssetId;
    if (ownFace !== undefined && ownFace !== null && typeof ownFace !== "string") throw new Error(`${where}的 faceReferenceAssetId 必须是字符串或 null`);
    const face = ownFace === null ? null : ownFace === undefined || ownFace === "" ? (faceReferenceAssetId || null) : text(ownFace, `${where}的 faceReferenceAssetId`, 80);
    return {
      shotId,
      storyboardAssetId: text(item.storyboardAssetId, `${where}的 storyboardAssetId`, 80),
      prompt: text(item.prompt ?? "", `${where}的 prompt`, 800, true),
      faceReferenceAssetId: face,
      faceWeight: number(item.faceWeight, `${where}的 faceWeight`, 0, 1.5, STORYBOARD_FLUX.faceWeight),
      seed,
    };
  });
  if (!look && frames.some(frame => !frame.prompt)) throw new Error("look 和每张的 prompt 至少要有一个写了画面描述");
  return { version: KEYFRAME_STORYBOARD_VERSION, aspect, faceReferenceAssetId, look, depthStrength, frames };
}

export function planStoryboardBatch(doc: KeyframeStoryboardDocument): StoryboardStep[] {
  return doc.frames.map((frame, index) => ({
    index,
    camera: "分镜图",
    pose: "分镜图",
    prompt: buildStoryboardPrompt(doc.look, frame.prompt),
    mode: KEYFRAME_INPUT_MASTER,
    source: "master",
    shotId: frame.shotId,
    storyboardAssetId: frame.storyboardAssetId,
    faceReferenceAssetId: frame.faceReferenceAssetId ?? "",
    faceWeight: frame.faceWeight,
    seed: frame.seed,
  }));
}

export function isStoryboardDocument(raw: string) {
  try { return (JSON.parse(raw) as { version?: unknown })?.version === KEYFRAME_STORYBOARD_VERSION; }
  catch { return false; }
}

export function keyframeStoryboardExample() {
  return `${JSON.stringify({
    version: KEYFRAME_STORYBOARD_VERSION,
    aspect: "9:16",
    faceReferenceAssetId: "主角脸部参考图的 Asset ID",
    look: "a mature East Asian man, short black hair, black long-sleeve shirt with sleeves rolled up, black trousers, soft window light, muted film colors",
    depthStrength: 1,
    frames: [
      { shotId: "S01", storyboardAssetId: "分镜图1的 Asset ID", prompt: "he stands by the office window at dusk" },
      { shotId: "S02", storyboardAssetId: "分镜图2的 Asset ID", prompt: "low angle, he looks down at the desk", faceWeight: 0.6 },
      { shotId: "S03", storyboardAssetId: "分镜图3的 Asset ID", prompt: "empty corridor, cold fluorescent light", faceReferenceAssetId: null },
    ],
  }, null, 2)}\n`;
}
