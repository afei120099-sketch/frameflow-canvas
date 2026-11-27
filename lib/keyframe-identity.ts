import { KEYFRAME_BATCH_LIMIT, KEYFRAME_BATCH_VERSION, KEYFRAME_INPUT_CHAIN, KEYFRAME_INPUT_MASTER, type KeyframeInputMode, type KeyframeStepPlan } from "./keyframe-batch.ts";

export const KEYFRAME_IDENTITY_VERSION = "keyframe-batch-v2" as const;
export const KEYFRAME_CAMERA_ANGLES = ["正面平视", "左侧45度", "右侧45度", "低机位仰拍", "高机位俯拍"] as const;
export const KEYFRAME_SHOT_SIZES = ["全景", "中景", "近景", "特写"] as const;
const PICTURE_TAG = /<\s*picture\b|＜\s*picture\b|\bpicture\s*(?:\d+|k)\b/i;

export interface IdentityFrame {
  shotId: string;
  cameraAngle: string;
  shotSize: string;
  pose: string;
  composition: string;
  prompt: string;
  seed: number | null;
}

export interface KeyframeIdentityDocument {
  version: typeof KEYFRAME_IDENTITY_VERSION;
  characterId: string;
  faceReferenceAssetId: string;
  bodyReferenceAssetId: string;
  sourceSheetAssetId: string;
  cropsConfirmed: boolean;
  character: string;
  clothing: string;
  hair: string;
  mode: KeyframeInputMode;
  frames: IdentityFrame[];
}

export interface IdentityStep extends KeyframeStepPlan {
  shotId: string;
  cameraAngle: string;
  shotSize: string;
  composition: string;
  seed: number | null;
  characterId: string;
  faceReferenceAssetId: string;
  bodyReferenceAssetId: string;
}

export interface IdentitySessionFrame {
  index: number;
  shotId: string;
  promptId: string;
  assetId: string;
  seed: number;
  status: string;
}

function oneLine(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function text(value: unknown, where: string, max: number, allowEmpty = false) {
  if (typeof value !== "string") throw new Error(`${where}必须是字符串`);
  const line = oneLine(value);
  if (PICTURE_TAG.test(line)) throw new Error("关键帧不要写 Picture 编号");
  if ((!line && !allowEmpty) || line.length > max) throw new Error(`${where}需要 1–${max} 个字符`);
  return line;
}

const VISUAL_PHRASES: [string, string][] = [
  ["东亚成年男性，方下颌，眉眼沉稳", "a mature East Asian man with a square jaw and steady eyes"],
  ["黑色长袖衬衫", "a black long-sleeve button-up shirt"],
  ["领口解开一颗扣", "one collar button undone"],
  ["袖子挽到前臂", "sleeves rolled to the forearm"],
  ["黑色长裤", "black trousers"],
  ["黑色皮带", "a black belt"],
  ["短黑发，发际线整齐", "short black hair with a neat hairline"],
  ["短黑发", "short black hair"],
  ["发际线整齐", "a neat hairline"],
  ["正面平视", "front view, camera at eye level, both eyes equally visible"],
  ["左侧45度", "three-quarter view from the person's left, about 45 degrees"],
  ["右侧45度", "three-quarter view from the person's right, about 45 degrees"],
  ["低机位仰拍", "the camera is on the floor pointing up, the underside of his chin and his nostrils are visible"],
  ["高机位俯拍", "the camera is above him looking straight down, the top of his head and the floor around his shoes are visible"],
  ["全景", "full-body shot, head and shoes both inside the frame"],
  ["中景", "medium shot from the waist up"],
  ["近景", "close shot from the chest up"],
  ["特写", "facial close-up"],
  ["自然站立", "standing naturally, both arms hanging at his sides, hands empty and not in pockets"],
  ["双手自然下垂", "both arms hanging naturally at his sides"],
  ["重心放在右脚", "weight on his right foot"],
  ["微微抬头", "chin slightly raised"],
  ["单人居中，头顶和脚都在画面内", "one person centered, head and feet inside the frame"],
  ["单人居中，镜头在胸口以下", "one person centered, camera below the chest"],
  ["单人居中，镜头在头顶上方", "one person centered, camera above the head"],
  ["单人居中", "one person centered"],
  ["灰色摄影棚，一个镜头", "gray seamless photo studio, one photograph"],
];

function visualEnglish(value: string) {
  let line = oneLine(value);
  for (const [zh, en] of VISUAL_PHRASES) line = line.replaceAll(zh, en);
  return line;
}

const ELEVATION_LEAD: Record<string, string> = {
  "低机位仰拍": "Low camera at knee height, looking up at a man who is standing. Both feet are flat on the floor, shoes point forward, and the soles are not visible. His chin is slightly raised. He is not sitting, not kneeling, and not lying down.",
  "高机位俯拍": "Extreme high-angle photograph. The camera is above him looking straight down. The top of his head and the floor around his shoes are visible.",
};

/** Elevation shots need a lighter face weight or the frontal face reference pulls the camera back to eye level. */
export function identityFaceWeight(cameraAngle: string) {
  if (cameraAngle === "高机位俯拍") return 0.75;
  if (cameraAngle === "低机位仰拍") return 0.5;
  return 0.85;
}

/** Elevation keeps an empty latent. Other master frames encode the standing body reference. */
export function identityBodyDenoise(cameraAngle: string) {
  return cameraAngle === "低机位仰拍" || cameraAngle === "高机位俯拍" ? 1 : 0.72;
}

export function buildIdentityPrompt(doc: Pick<KeyframeIdentityDocument, "character" | "clothing" | "hair">, frame: Pick<IdentityFrame, "cameraAngle" | "shotSize" | "pose" | "composition" | "prompt">) {
  const prompt = [
    ELEVATION_LEAD[frame.cameraAngle] ?? "",
    `A photorealistic studio photograph of exactly one person: ${visualEnglish(doc.character)}.`,
    `Clothing: ${visualEnglish(doc.clothing)}.`,
    `Hair: ${visualEnglish(doc.hair)}.`,
    `Camera: ${visualEnglish(frame.cameraAngle)}.`,
    `Shot: ${visualEnglish(frame.shotSize)}.`,
    `Pose: ${visualEnglish(frame.pose)}.`,
    `Composition: ${visualEnglish(frame.composition)}.`,
    frame.prompt ? `Scene: ${visualEnglish(frame.prompt)}.` : "",
    "One person only, one photograph, not a collage.",
    "单人摄影静帧，竖幅 9:16。画面里只有一个人物，只有一个构图。",
    "不要四格分镜，不要角色设定表，不要多视角拼图，不要拼贴，不要分栏，不要留白格子。",
    `人物：${oneLine(doc.character)}。`,
    `固定服装：${oneLine(doc.clothing)}。`,
    `发型：${oneLine(doc.hair)}。`,
    `机位：${oneLine(frame.cameraAngle)}。`,
    `景别：${oneLine(frame.shotSize)}。`,
    `姿态：${oneLine(frame.pose)}。`,
    `构图：${oneLine(frame.composition)}。`,
    frame.prompt ? `镜头：${oneLine(frame.prompt)}。` : "",
    "人物保持静止，停在动作开始之前。",
  ].filter(Boolean).join(" ");
  if (PICTURE_TAG.test(prompt)) throw new Error("关键帧不要写 Picture 编号");
  return prompt;
}

export function planIdentityBatch(doc: KeyframeIdentityDocument): IdentityStep[] {
  if (!doc.cropsConfirmed) throw new Error("先确认脸部裁切和全身裁切，再出图");
  if (!doc.faceReferenceAssetId || !doc.bodyReferenceAssetId) throw new Error("先准备脸部参考和单人全身参考");
  if (doc.faceReferenceAssetId === doc.bodyReferenceAssetId) throw new Error("脸部参考和全身参考要是两张图，不要把同一张四格同时当作两张");
  if (doc.sourceSheetAssetId && (doc.faceReferenceAssetId === doc.sourceSheetAssetId || doc.bodyReferenceAssetId === doc.sourceSheetAssetId)) {
    throw new Error("四格设定图不能当作生成底图，请使用裁切后的脸和全身");
  }
  return doc.frames.map((frame, index) => ({
    index,
    camera: frame.cameraAngle,
    pose: frame.pose,
    prompt: buildIdentityPrompt(doc, frame),
    mode: doc.mode,
    source: doc.mode === KEYFRAME_INPUT_CHAIN && index > 0 ? "previous" : "master",
    shotId: frame.shotId,
    cameraAngle: frame.cameraAngle,
    shotSize: frame.shotSize,
    composition: frame.composition,
    seed: frame.seed,
    characterId: doc.characterId,
    faceReferenceAssetId: doc.faceReferenceAssetId,
    bodyReferenceAssetId: doc.bodyReferenceAssetId,
  }));
}

const DOCUMENT_FIELDS = new Set(["version", "characterId", "faceReferenceAssetId", "bodyReferenceAssetId", "sourceSheetAssetId", "cropsConfirmed", "character", "clothing", "hair", "mode", "frames"]);
const FRAME_FIELDS = new Set(["shotId", "cameraAngle", "shotSize", "pose", "composition", "prompt", "seed"]);

export function parseKeyframeIdentity(raw: string): KeyframeIdentityDocument {
  if (raw.length > 200_000) throw new Error("关键帧表过大");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("关键帧表不是合法 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("关键帧表必须是对象");
  const record = value as Record<string, unknown>;
  if (record.version === "shot-queue-v1") throw new Error("这是视频镜头队列。静帧表的 version 用 keyframe-batch-v2");
  if (record.version !== KEYFRAME_IDENTITY_VERSION) throw new Error(`身份关键帧表版本必须是 ${KEYFRAME_IDENTITY_VERSION}`);
  const extra = Object.keys(record).filter(key => !DOCUMENT_FIELDS.has(key));
  if (extra.length) throw new Error(`${extra[0]} 不属于身份关键帧表`);
  const mode = record.mode === undefined ? KEYFRAME_INPUT_MASTER : record.mode;
  if (mode !== KEYFRAME_INPUT_MASTER && mode !== KEYFRAME_INPUT_CHAIN) throw new Error("mode 只能是 master 或 chain。省略时使用原始母版");
  if (typeof record.cropsConfirmed !== "boolean") throw new Error("cropsConfirmed 必须是 true 或 false");
  if (!Array.isArray(record.frames) || record.frames.length < 1 || record.frames.length > KEYFRAME_BATCH_LIMIT) throw new Error(`frames 需要 1–${KEYFRAME_BATCH_LIMIT} 张`);
  const seenShots = new Set<string>();
  const frames = record.frames.map((frame, index) => {
    const where = `第 ${index + 1} 张`;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error(`${where}必须是对象`);
    const item = frame as Record<string, unknown>;
    const unexpected = Object.keys(item).filter(key => !FRAME_FIELDS.has(key));
    if (unexpected.length) throw new Error(`${where}的 ${unexpected[0]} 不属于这一镜`);
    const shotId = text(item.shotId, `${where}的 shotId`, 80);
    if (seenShots.has(shotId)) throw new Error(`${where}的 shotId 和前面重复`);
    seenShots.add(shotId);
    let seed: number | null = null;
    if (item.seed !== undefined && item.seed !== null) {
      if (!Number.isSafeInteger(item.seed) || (item.seed as number) < 0) throw new Error(`${where}的 seed 需为非负整数`);
      seed = item.seed as number;
    }
    const parsed = {
      shotId,
      cameraAngle: text(item.cameraAngle, `${where}的 cameraAngle`, 80),
      shotSize: text(item.shotSize, `${where}的 shotSize`, 40),
      pose: text(item.pose, `${where}的 pose`, 200),
      composition: text(item.composition, `${where}的 composition`, 200),
      prompt: text(item.prompt ?? "", `${where}的 prompt`, 400, true),
      seed,
    };
    buildIdentityPrompt({ character: "人物", clothing: "服装", hair: "发型" }, parsed);
    return parsed;
  });
  return {
    version: KEYFRAME_IDENTITY_VERSION,
    characterId: text(record.characterId, "characterId", 80),
    faceReferenceAssetId: text(record.faceReferenceAssetId ?? "", "faceReferenceAssetId", 80, true),
    bodyReferenceAssetId: text(record.bodyReferenceAssetId ?? "", "bodyReferenceAssetId", 80, true),
    sourceSheetAssetId: text(record.sourceSheetAssetId ?? "", "sourceSheetAssetId", 80, true),
    cropsConfirmed: record.cropsConfirmed,
    character: text(record.character, "character", 400),
    clothing: text(record.clothing, "clothing", 400),
    hair: text(record.hair, "hair", 200),
    mode,
    frames,
  };
}

export function keyframeIdentityExample(sourceSheetAssetId = "四格设定图的 Asset ID", characterId = "角色 ID") {
  return `${JSON.stringify({
    version: KEYFRAME_IDENTITY_VERSION,
    characterId,
    sourceSheetAssetId,
    faceReferenceAssetId: "",
    bodyReferenceAssetId: "",
    cropsConfirmed: false,
    character: "东亚成年男性，方下颌，眉眼沉稳",
    clothing: "黑色长袖衬衫，领口解开一颗扣，袖子挽到前臂，黑色长裤，黑色皮带",
    hair: "短黑发，发际线整齐",
    mode: KEYFRAME_INPUT_MASTER,
    frames: [
      { shotId: "shot-front", cameraAngle: "正面平视", shotSize: "全景", pose: "自然站立", composition: "单人居中，头顶和脚都在画面内", prompt: "灰色摄影棚，一个镜头" },
      { shotId: "shot-left", cameraAngle: "左侧45度", shotSize: "中景", pose: "双手自然下垂", composition: "单人居中", prompt: "灰色摄影棚，一个镜头" },
      { shotId: "shot-right", cameraAngle: "右侧45度", shotSize: "中景", pose: "重心放在右脚", composition: "单人居中", prompt: "灰色摄影棚，一个镜头" },
      { shotId: "shot-low", cameraAngle: "低机位仰拍", shotSize: "中景", pose: "微微抬头", composition: "单人居中，镜头在胸口以下", prompt: "灰色摄影棚，一个镜头" },
      { shotId: "shot-high", cameraAngle: "高机位俯拍", shotSize: "全景", pose: "自然站立", composition: "单人居中，镜头在头顶上方", prompt: "灰色摄影棚，一个镜头" },
    ],
  }, null, 2)}\n`;
}

/** A frame that already has a Comfy prompt id is polled, never submitted again. */
export function identityDispatch(frame: Pick<IdentitySessionFrame, "promptId" | "assetId">, attempt: number, maxAttempts: number) {
  if (frame.assetId) return "done" as const;
  if (frame.promptId) return "poll" as const;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("重试次数无效");
  if (attempt < maxAttempts) return "submit" as const;
  return "stop" as const;
}

export function isIdentityDocument(raw: string) {
  try {
    const value = JSON.parse(raw) as { version?: unknown };
    return value?.version === KEYFRAME_IDENTITY_VERSION;
  } catch {
    return false;
  }
}

export function isLegacyKeyframe(raw: string) {
  try {
    const value = JSON.parse(raw) as { version?: unknown };
    return value?.version === KEYFRAME_BATCH_VERSION;
  } catch {
    return false;
  }
}
