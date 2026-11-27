/**
 * 🧪 H3 time anchors for the ultimate / fast community workflows (capability `h3_ultimate_guide`).
 *
 * Same wiring as ComfyUI's official `video_minimax_h3_multiframe_reference` template (0.39.0):
 * conditioning node 136 → MiniMaxH3AddGuide × N (chained by frame order) → BasicGuider 126.
 * Every AddGuide reads the AV latent [136,1], video VAE 119 and audio VAE 120; the sampler keeps
 * latent_image [136,1] because AddGuide only outputs `positive`. The frozen templates are never
 * written: the chain is inserted into the in-memory copy built by buildCommunityWorkflow.
 *
 * Anchor images are not shown to the text encoder, so they never get a <Picture N> label unless
 * the user also adds the same image as a reference.
 */

export const H3_ULTIMATE_GUIDE = "h3_ultimate_guide" as const;
export const H3_TIME_ANCHOR_MAX = 4;
export const H3_TIME_ANCHOR_FPS = 24;
/** Anchors closer than this to each other or to the first / last frame only raise a warning. */
export const H3_TIME_ANCHOR_MIN_GAP = 24;
export const H3_TIME_ANCHOR_NOTE = "锚点表示最晚在这一时间附近达到该画面，变化通常提前发生，不保证精确时刻。";

const CONDITIONING = "136";
const GUIDER = "126";
const SAMPLER = "125";
const VIDEO_VAE = "119";
const AUDIO_VAE = "120";

type Node = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
type Workflow = Record<string, Node>;

export interface TimeAnchorFrame { imageName: string; frameIdx: number }
export interface TimeAnchorCheck { anchors: TimeAnchorFrame[]; warnings: string[] }

/** Seconds → pixel frame at the fixed 24 FPS generation rate, as in the official template (round(a * 24)). */
export const timeAnchorFrame = (atSeconds: number) => Math.round(atSeconds * H3_TIME_ANCHOR_FPS);
export const timeAnchorSeconds = (frameIdx: number) => frameIdx / H3_TIME_ANCHOR_FPS;
const label = (frameIdx: number) => `${timeAnchorSeconds(frameIdx).toFixed(2)} 秒（第 ${frameIdx} 帧）`;

/**
 * Sorted, validated anchors for a request of `length` frames (17k+5). Errors throw together;
 * spacing under one second is returned as warnings and never blocks submission.
 */
export function checkTimeAnchors(anchors: readonly TimeAnchorFrame[], length: number, edges: { first?: boolean; last?: boolean } = {}): TimeAnchorCheck {
  const errors: string[] = [];
  if (anchors.length > H3_TIME_ANCHOR_MAX) errors.push(`时间锚点最多 ${H3_TIME_ANCHOR_MAX} 个`);
  const sorted = [...anchors].sort((a, b) => a.frameIdx - b.frameIdx);
  for (const [index, anchor] of sorted.entries()) {
    if (!anchor.imageName?.trim()) errors.push("时间锚点缺少图片");
    if (!Number.isInteger(anchor.frameIdx) || anchor.frameIdx < 1 || anchor.frameIdx > length - 1) { errors.push(`时间锚点 ${Number.isFinite(anchor.frameIdx) ? label(anchor.frameIdx) : "时间无效"} 超出本次视频范围（第 1–${length - 1} 帧）`); continue; }
    if (index > 0 && sorted[index - 1].frameIdx === anchor.frameIdx) errors.push(`两个时间锚点落在同一帧：${label(anchor.frameIdx)}`);
    if (edges.last && anchor.frameIdx === length - 1) errors.push(`时间锚点 ${label(anchor.frameIdx)} 与尾帧同帧，请改用尾帧或换个时间`);
  }
  if (errors.length) throw new Error([...new Set(errors)].join("\n"));
  const warnings: string[] = [];
  const near = (gap: number) => gap > 0 && gap < H3_TIME_ANCHOR_MIN_GAP;
  if (edges.first && sorted[0] && near(sorted[0].frameIdx)) warnings.push(`时间锚点 ${label(sorted[0].frameIdx)} 距首帧不足 1 秒，变化可能过急`);
  for (let index = 1; index < sorted.length; index++) if (near(sorted[index].frameIdx - sorted[index - 1].frameIdx)) warnings.push(`时间锚点 ${label(sorted[index - 1].frameIdx)} 与 ${label(sorted[index].frameIdx)} 间隔不足 1 秒，变化可能过急`);
  const lastAnchor = sorted.at(-1);
  if (edges.last && lastAnchor && near(length - 1 - lastAnchor.frameIdx)) warnings.push(`时间锚点 ${label(lastAnchor.frameIdx)} 距尾帧不足 1 秒，变化可能过急`);
  return { anchors: sorted, warnings };
}

/** Insert LoadImage → MiniMaxH3AddGuide pairs between node 136 and BasicGuider 126 (in place). */
export function insertTimeAnchorChain(workflow: Workflow, anchors: readonly TimeAnchorFrame[]) {
  if (!anchors.length) return workflow;
  if (JSON.stringify(workflow[GUIDER]?.inputs.conditioning) !== JSON.stringify([CONDITIONING, 0])) throw new Error("工作流的 BasicGuider 连线与时间锚点接法不一致，未提交");
  if (JSON.stringify(workflow[SAMPLER]?.inputs.latent_image) !== JSON.stringify([CONDITIONING, 1])) throw new Error("工作流的采样器 latent 连线与时间锚点接法不一致，未提交");
  if (workflow[VIDEO_VAE]?.class_type !== "VAELoader" || workflow[AUDIO_VAE]?.class_type !== "VAELoader") throw new Error("工作流缺少视频或音频 VAE，无法接入时间锚点");
  let positive: unknown = [CONDITIONING, 0];
  [...anchors].sort((a, b) => a.frameIdx - b.frameIdx).forEach((anchor, index) => {
    const loadId = `ff-anchor-${index}-load`, guideId = `ff-anchor-${index}`;
    workflow[loadId] = { class_type: "LoadImage", inputs: { image: anchor.imageName }, _meta: { title: `时间锚点 ${index + 1}` } };
    workflow[guideId] = { class_type: "MiniMaxH3AddGuide", inputs: { positive, latent: [CONDITIONING, 1], vae: [VIDEO_VAE, 0], audio_vae: [AUDIO_VAE, 0], image: [loadId, 0], frame_idx: anchor.frameIdx }, _meta: { title: `时间锚点 ${index + 1} · ${label(anchor.frameIdx)}` } };
    positive = [guideId, 0];
  });
  workflow[GUIDER].inputs.conditioning = positive;
  return workflow;
}

/** Centre crop of a source to the target aspect, the same "center" rule AddGuide applies internally. */
export function centerCropRect(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) {
  if (![sourceWidth, sourceHeight, targetWidth, targetHeight].every((n) => Number.isFinite(n) && n > 0)) throw new Error("锚点图或生成尺寸无效");
  const target = targetWidth / targetHeight;
  if (sourceWidth / sourceHeight > target) {
    const width = Math.round(sourceHeight * target);
    return { x: Math.floor((sourceWidth - width) / 2), y: 0, width, height: sourceHeight };
  }
  const height = Math.round(sourceWidth / target);
  return { x: 0, y: Math.floor((sourceHeight - height) / 2), width: sourceWidth, height };
}

/** <Picture N> tags in the prompt with no presented picture behind them (anchor images are never presented). */
export function unboundPictureTags(prompt: string, presentedPictures: number) {
  const tags = [...prompt.matchAll(/<\s*Picture\s+(\d+)\s*>/gi)].map((match) => Number(match[1]));
  return [...new Set(tags.filter((n) => n < 1 || n > presentedPictures))].sort((a, b) => a - b);
}

/** Blocking message when time anchors are present and the prompt points at a picture that only exists as an anchor. */
export function timeAnchorPromptProblem(prompt: string, presentedPictures: number, anchorCount: number) {
  if (!anchorCount) return null;
  const unbound = unboundPictureTags(prompt, presentedPictures);
  if (!unbound.length) return null;
  return `提示词引用了 ${unbound.map((n) => `<Picture ${n}>`).join("、")}，但本次只有 ${presentedPictures} 张参考图。时间锚点图不占 Picture 编号：请删掉这些编号改用文字描述，或对该锚点勾选“同时作为参考图”`;
}
