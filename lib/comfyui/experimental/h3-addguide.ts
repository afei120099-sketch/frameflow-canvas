import addGuideTemplate from "./h3-i2va-addguide-workflow.json" with { type: "json" };
import productionTemplate from "../h3-workflow.json" with { type: "json" };
import type { H3GenerationSettings } from "../../ai-adapter.ts";
import { buildH3Workflow } from "../h3-adapter.ts";

/**
 * 🧪 H3 AddGuide (experimental capability, verified on real GPU 2026-10-02, see
 * an internal experiment, not included in this repository).
 *
 * I2VA + mid-video image anchors via the core MiniMaxH3AddGuide node. The frozen production I2VA
 * workflow is built by the unchanged production builder; the frozen experimental template only
 * contributes the guide node pair (LoadImage "40" → MiniMaxH3AddGuide "41" → BasicGuider "7"),
 * copied once per anchor and chained in anchor order. Neither template file is ever written.
 *
 * Semantics (measured): an anchor means the target picture is reached by about that frame; the
 * change usually happens EARLIER (−9 … −65 frames). Exact timing is not promised.
 */

export const H3_ADDGUIDE_EXPERIMENTAL = "h3_addguide_experimental" as const;
export const H3_ADDGUIDE_TEMPLATE_FILE = "experimental/h3-i2va-addguide-workflow.json";
export const H3_ADDGUIDE_TEMPLATE = addGuideTemplate;
export const H3_ADDGUIDE_MAX_GUIDES = 4;
export const H3_ADDGUIDE_NOTE = "锚点表示最晚在这一帧附近达到目标画面，不保证动作在该帧发生。";

const GUIDE_LOAD = "40";
const GUIDE_NODE = "41";
const GUIDER = "7";
const CONDITIONING = "6";

type Node = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
type Workflow = Record<string, Node>;

export interface H3GuideInput { imageName: string; frameIdx: number }

/** The experimental template must stay "production I2VA + one guide pair"; anything else is refused at load. */
function assertTemplateShape() {
  const template = structuredClone(addGuideTemplate) as Workflow;
  const load = template[GUIDE_LOAD], guide = template[GUIDE_NODE];
  if (load?.class_type !== "LoadImage" || guide?.class_type !== "MiniMaxH3AddGuide") throw new Error("AddGuide 实验模板缺少引导节点");
  if (JSON.stringify(template[GUIDER]?.inputs.conditioning) !== JSON.stringify([GUIDE_NODE, 0])) throw new Error("AddGuide 实验模板的 BasicGuider 连线不正确");
  delete template[GUIDE_LOAD]; delete template[GUIDE_NODE];
  template[GUIDER].inputs.conditioning = [CONDITIONING, 0];
  if (JSON.stringify(template) !== JSON.stringify(productionTemplate)) throw new Error("AddGuide 实验模板与生产 I2VA 模板不一致");
  return { load, guide };
}
const GUIDE_PAIR = assertTemplateShape();

/** Sorted, validated anchors. `length` is the H3 frame count of this request (17k+5). */
export function normalizeGuides(guides: H3GuideInput[], length: number): H3GuideInput[] {
  if (!guides.length) throw new Error("至少需要一个引导锚点");
  if (guides.length > H3_ADDGUIDE_MAX_GUIDES) throw new Error(`引导锚点最多 ${H3_ADDGUIDE_MAX_GUIDES} 个`);
  const sorted = [...guides].sort((a, b) => a.frameIdx - b.frameIdx);
  for (const [index, guide] of sorted.entries()) {
    if (!Number.isInteger(guide.frameIdx) || guide.frameIdx < 1 || guide.frameIdx > length - 1) throw new Error(`引导锚点帧 ${guide.frameIdx} 超出本次视频范围（1–${length - 1} 帧）`);
    if (index > 0 && sorted[index - 1].frameIdx === guide.frameIdx) throw new Error(`两个引导锚点使用了同一帧 ${guide.frameIdx}`);
    if (!guide.imageName) throw new Error("引导锚点缺少图片");
  }
  return sorted;
}

/** Production I2VA workflow + one frozen guide pair per anchor, chained in frame order. No last frame. */
export function buildH3AddGuideWorkflow(imageName: string, prompt: string, seed: number, settings: H3GenerationSettings, guides: H3GuideInput[]) {
  const workflow = buildH3Workflow(imageName, prompt, seed, settings) as unknown as Workflow;
  if (JSON.stringify(workflow[GUIDER].inputs.conditioning) !== JSON.stringify([CONDITIONING, 0])) throw new Error("生产 I2VA 工作流的 BasicGuider 连线与实验模板不一致");
  let positive: unknown = [CONDITIONING, 0];
  normalizeGuides(guides, settings.length).forEach((guide, index) => {
    const loadId = index === 0 ? GUIDE_LOAD : `ff-guide-${index}-load`;
    const guideId = index === 0 ? GUIDE_NODE : `ff-guide-${index}`;
    workflow[loadId] = { ...structuredClone(GUIDE_PAIR.load), inputs: { ...GUIDE_PAIR.load.inputs, image: guide.imageName } };
    workflow[guideId] = { ...structuredClone(GUIDE_PAIR.guide), inputs: { ...GUIDE_PAIR.guide.inputs, positive, image: [loadId, 0], frame_idx: guide.frameIdx } };
    positive = [guideId, 0];
  });
  workflow[GUIDER].inputs.conditioning = positive;
  return workflow;
}
