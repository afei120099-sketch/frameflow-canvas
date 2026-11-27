/** Serial stills for one scene. Master mode edits the original still every time. Chain mode edits the previous result. */

export const KEYFRAME_BATCH_VERSION = "keyframe-batch-v1" as const;
export const KEYFRAME_STILL = { width: 864, height: 1536 } as const;
export const KEYFRAME_FLUX = { steps: 24, guidance: 3.5, denoise: 0.8, sampler: "euler", scheduler: "simple" } as const;
export const KEYFRAME_BATCH_LIMIT = 24;
export const KEYFRAME_INPUT_MASTER = "master" as const;
export const KEYFRAME_INPUT_CHAIN = "chain" as const;

export type KeyframeInputMode = typeof KEYFRAME_INPUT_MASTER | typeof KEYFRAME_INPUT_CHAIN;
export type KeyframeEdit = { camera: string; pose: string };
export type KeyframeRunStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "unconfirmed";
export type KeyframeBatchResult = "completed" | "failed" | "stopped" | "unconfirmed";
export interface KeyframeSource { assetId: string; src: string }
export interface KeyframeStill extends KeyframeSource { filename: string; promptId: string }
export interface KeyframeStepPlan { index: number; prompt: string; source: "master" | "previous"; camera: string; pose: string; mode: KeyframeInputMode }
export interface KeyframeReceipt { onReserved?: (promptId: string) => void; onAccepted: (promptId: string) => void }

const PICTURE_TAG = /<\s*picture\b|＜\s*picture\b|\bpicture\s*(?:\d+|k)\b/i;

function oneLine(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function rejectPicture(text: string) {
  if (PICTURE_TAG.test(text)) throw new Error("关键帧提示词写机位和姿态即可，不要写 Picture 编号");
}

export function buildKeyframePrompt(edit: KeyframeEdit) {
  const camera = oneLine(edit.camera);
  const pose = oneLine(edit.pose);
  if (!camera || !pose) throw new Error("每一张都要写机位高低和身体姿态");
  if (camera.length > 200 || pose.length > 200) throw new Error("机位和姿态各写成一句短话");
  const prompt = `同一场静帧，画幅 9:16。只冻结动作开始前的那一瞬间，人物保持静止，不要画出动作过程。只改这一镜的机位高低和身体姿态：机位${camera}；姿态${pose}。房间、人物左右站位、衣服、道具保持原图，不要更换，不要增删。`;
  rejectPicture(prompt);
  return prompt;
}

export function planKeyframeChain(edits: readonly KeyframeEdit[], mode: KeyframeInputMode = KEYFRAME_INPUT_MASTER): KeyframeStepPlan[] {
  if (mode !== KEYFRAME_INPUT_MASTER && mode !== KEYFRAME_INPUT_CHAIN) throw new Error("mode 只能是 master 或 chain");
  if (!edits.length) throw new Error("至少写一张关键帧要改什么");
  if (edits.length > KEYFRAME_BATCH_LIMIT) throw new Error(`一次最多 ${KEYFRAME_BATCH_LIMIT} 张，出完可以把最后一张再当母版`);
  return edits.map((edit, index) => ({
    index,
    camera: oneLine(edit.camera),
    pose: oneLine(edit.pose),
    prompt: buildKeyframePrompt(edit),
    mode,
    source: mode === KEYFRAME_INPUT_CHAIN && index > 0 ? "previous" : "master",
  }));
}

let chainOpen = false;

/** Submit one still, wait for its receipt, then the next. A failure or a stop does not start the rest. */
export async function runKeyframeBatch(plans: readonly KeyframeStepPlan[], deps: {
  signal: AbortSignal;
  master: KeyframeSource;
  submit: (step: KeyframeStepPlan, source: KeyframeSource, receipt: KeyframeReceipt) => Promise<KeyframeStill>;
  onUpdate: (index: number, status: KeyframeRunStatus, detail: string, still?: KeyframeStill) => void;
}): Promise<KeyframeBatchResult> {
  if (!plans.length) throw new Error("至少写一张关键帧要改什么");
  const mode = plans[0].mode;
  if (mode !== KEYFRAME_INPUT_MASTER && mode !== KEYFRAME_INPUT_CHAIN) throw new Error("mode 只能是 master 或 chain");
  for (const plan of plans) {
    if (plan.mode !== mode) throw new Error("同一批关键帧只能使用一种输入模式");
    if (plan.index !== plans.indexOf(plan)) throw new Error("关键帧序号要按出图顺序从 0 递增");
    if (mode === KEYFRAME_INPUT_MASTER) {
      if (plan.source !== "master") throw new Error("原始母版模式的每一张都直接改最初的母版");
    } else if ((plan.source === "master") !== (plan.index === 0)) {
      throw new Error("连续递进模式第 1 张改母版，后面每一张改上一张的结果");
    }
    rejectPicture(plan.prompt);
  }
  if (!deps.master.assetId || !deps.master.src) throw new Error("母版还没有 Asset ID");
  if (chainOpen) throw new Error("已有一批关键帧在出图，等这一批停下再出下一批");
  chainOpen = true;
  const stopRest = (from: number, detail: string) => {
    for (let rest = from; rest < plans.length; rest++) deps.onUpdate(rest, "stopped", detail);
  };
  try {
    let previous = deps.master;
    const seen = new Set<string>([deps.master.assetId]);
    for (let index = 0; index < plans.length; index++) {
      if (deps.signal.aborted) {
        stopRest(index, "已停止，这一张没有提交");
        return "stopped";
      }
      const plan = plans[index];
      const source = mode === KEYFRAME_INPUT_CHAIN && index > 0 ? previous : deps.master;
      if (mode === KEYFRAME_INPUT_MASTER && source.assetId !== deps.master.assetId) throw new Error("原始母版模式的每一张都直接改最初的母版");
      if (mode === KEYFRAME_INPUT_CHAIN && index > 0 && (plan.source !== "previous" || source.assetId === deps.master.assetId)) throw new Error("连续递进模式第 1 张改母版，后面每一张改上一张的结果");
      let reserved = "";
      let accepted = "";
      deps.onUpdate(index, "running", "正在入队");
      try {
        const still = await deps.submit(plan, source, {
          onReserved(promptId) {
            if (!promptId.trim()) throw new Error("没有入队回执");
            if (reserved) throw new Error("一张关键帧只能预留一次");
            reserved = promptId.trim();
          },
          onAccepted(promptId) {
            if (!promptId.trim()) throw new Error("没有入队回执");
            if (accepted) throw new Error("一张关键帧只能有一张回执");
            accepted = promptId.trim();
          },
        });
        if (!accepted) throw new Error("静帧没有入队回执，不会当作完成");
        if (reserved && reserved !== accepted) throw new Error("回执和预留任务不一致");
        if (still.promptId !== accepted || !still.assetId || !still.src) throw new Error("回执和成图不一致");
        if (seen.has(still.assetId)) throw new Error("成图要有自己的 Asset ID");
        seen.add(still.assetId);
        if (mode === KEYFRAME_INPUT_CHAIN) previous = { assetId: still.assetId, src: still.src };
        deps.onUpdate(index, "completed", still.assetId, still);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "提交失败";
        const aborted = deps.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        if (!reserved && !accepted) {
          deps.onUpdate(index, aborted ? "stopped" : "failed", aborted ? "已停止，这一张没有提交" : detail);
          stopRest(index + 1, aborted ? "已停止，这一张没有提交" : "前面的关键帧没有入队，后面不再提交");
          return aborted ? "stopped" : "failed";
        }
        deps.onUpdate(index, "unconfirmed", aborted ? "已停止。这一张已入队，结果未确认，不会自动重提" : `${detail}。回执已记下，不会自动重提`);
        stopRest(index + 1, "前面的关键帧结果未确认，后面不再提交");
        return "unconfirmed";
      }
    }
    return "completed";
  } finally {
    chainOpen = false;
  }
}

export interface KeyframeBatchDocument {
  version: typeof KEYFRAME_BATCH_VERSION;
  masterAssetId: string;
  denoise: number;
  mode: KeyframeInputMode;
  frames: KeyframeEdit[];
}

const DOCUMENT_FIELDS = new Set(["version", "masterAssetId", "denoise", "mode", "frames"]);
const FRAME_FIELDS = new Set(["camera", "pose"]);

function plainText(value: unknown, where: string, max: number) {
  if (typeof value !== "string") throw new Error(`${where}必须是字符串`);
  const text = oneLine(value);
  if (!text || text.length > max) throw new Error(`${where}需要 1–${max} 个字符`);
  return text;
}

/** One scene of stills. This is not a video shot queue. */
export function parseKeyframeBatch(raw: string): KeyframeBatchDocument {
  if (raw.length > 200_000) throw new Error("关键帧表过大");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("关键帧表不是合法 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("关键帧表必须是对象");
  const record = value as Record<string, unknown>;
  if (record.version === "shot-queue-v1") throw new Error("这是视频镜头队列。静帧表的 version 用 keyframe-batch-v1，只写母版和每一张的机位、姿态");
  if (record.version !== KEYFRAME_BATCH_VERSION) throw new Error(`关键帧表版本必须是 ${KEYFRAME_BATCH_VERSION}`);
  const extra = Object.keys(record).filter(key => !DOCUMENT_FIELDS.has(key));
  if (extra.length) throw new Error(`${extra[0]} 不属于静帧表。只写 version、masterAssetId、denoise、mode、frames`);
  const masterAssetId = plainText(record.masterAssetId, "masterAssetId", 80);
  const mode = record.mode === undefined ? KEYFRAME_INPUT_MASTER : record.mode;
  if (mode !== KEYFRAME_INPUT_MASTER && mode !== KEYFRAME_INPUT_CHAIN) throw new Error("mode 只能是 master 或 chain。省略时使用原始母版");
  const denoise = record.denoise === undefined ? KEYFRAME_FLUX.denoise : record.denoise;
  if (typeof denoise !== "number" || !Number.isFinite(denoise) || denoise <= 0 || denoise > 1) throw new Error("denoise 需大于 0 且不超过 1");
  if (!Array.isArray(record.frames) || record.frames.length < 1 || record.frames.length > KEYFRAME_BATCH_LIMIT) throw new Error(`frames 需要 1–${KEYFRAME_BATCH_LIMIT} 张`);
  const frames = record.frames.map((frame, index) => {
    const where = `第 ${index + 1} 张`;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error(`${where}必须是对象`);
    const item = frame as Record<string, unknown>;
    const unexpected = Object.keys(item).filter(key => !FRAME_FIELDS.has(key));
    if (unexpected.length) throw new Error(`${where}的 ${unexpected[0]} 不属于静帧。只写 camera 和 pose`);
    const edit = { camera: plainText(item.camera, `${where}的 camera`, 200), pose: plainText(item.pose, `${where}的 pose`, 200) };
    buildKeyframePrompt(edit);
    return edit;
  });
  return { version: KEYFRAME_BATCH_VERSION, masterAssetId, denoise, mode, frames };
}

export function keyframeBatchExample(masterAssetId = "母版图片的 Asset ID") {
  return `${JSON.stringify({
    version: KEYFRAME_BATCH_VERSION,
    masterAssetId,
    mode: KEYFRAME_INPUT_MASTER,
    denoise: KEYFRAME_FLUX.denoise,
    frames: [
      { camera: "略俯，齐胸", pose: "双手自然下垂" },
      { camera: "平视", pose: "重心在右脚" },
    ],
  }, null, 2)}\n`;
}
