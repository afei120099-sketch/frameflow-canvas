import type { H3GenerationSettings } from "../ai-adapter.ts";
import t2vaTemplate from "./h3-t2va-workflow.json" with { type: "json" };
import { calculateH3Dimensions, H3_ASPECTS, H3_LORA_STRENGTH, H3_MAX_LENGTH, H3_MAX_MEGAPIXELS, H3_MIN_LENGTH, H3_MIN_MEGAPIXELS, H3_STEPS, H3_UPSCALE_METHODS, type H3Aspect } from "./h3-parameters.ts";

/**
 * T2VA (text → audio+video) on ComfyUI's own MiniMaxH3ImageToVideo node with no first/last frame.
 * Separate template (h3-t2va-workflow.json): the frozen FL2VA template minus its image nodes
 * (20 LoadImage, 21 ImageScaleToTotalPixels, 22 GetImageSize), with fixed width/height.
 * Same model / text encoder / VAEs / Turbo LoRA / sampler / node IDs as FL2VA (SaveVideo stays "15",
 * so progress parsing and refresh recovery are unchanged). The frozen FL2VA template is not modified.
 */

type Workflow = Record<string, { inputs: Record<string, unknown>; class_type: string; _meta?: { title?: string } }>;
export const H3_T2VA_TEMPLATE_FILE = "h3-t2va-workflow.json";
export const H3_T2VA_TEMPLATE = t2vaTemplate;
const REQUIRED_NODES = ["5", "6", "10", "11", "14", "15", "25", "27", "28"] as const;
/** With no picture there is nothing to follow; "跟随原图" falls back to this aspect. */
export const H3_T2VA_DEFAULT_ASPECT: Exclude<H3Aspect, "follow"> = "16:9";

export const t2vaAspect = (aspect: H3Aspect): Exclude<H3Aspect, "follow"> => aspect === "follow" ? H3_T2VA_DEFAULT_ASPECT : aspect;

/** Canvas size for T2VA: the chosen aspect at the pixel budget, rounded to the resolution step (32 by default). */
export function t2vaDimensions(settings: Pick<H3GenerationSettings, "aspect" | "megapixels" | "resolutionSteps">) {
  const dimensions = calculateH3Dimensions(0, 0, t2vaAspect(settings.aspect), settings.megapixels, settings.resolutionSteps);
  if (!dimensions) throw new Error("无法计算文生视频画面尺寸");
  return dimensions;
}

export function buildH3T2vaWorkflow(prompt: string, seed: number, settings: H3GenerationSettings) {
  if (!prompt.trim()) throw new Error("文生视频需要 Prompt");
  if (settings.length < H3_MIN_LENGTH || settings.length > H3_MAX_LENGTH || (settings.length - 5) % 17 !== 0) throw new Error("H3 时长不是合法的 17k+5 帧数");
  if (!(H3_ASPECTS as readonly string[]).includes(settings.aspect)) throw new Error("H3 比例不受支持");
  if (settings.megapixels < H3_MIN_MEGAPIXELS || settings.megapixels > H3_MAX_MEGAPIXELS) throw new Error("像素预算必须在 0.30MP 到 1.00MP 之间");
  if (!Number.isInteger(settings.steps) || settings.steps < 1 || settings.steps > 10_000) throw new Error("Steps 必须是 1 到 10000 的整数");
  if (settings.fps < 1 || settings.fps > 120) throw new Error("FPS 必须在 1 到 120 之间");
  if (settings.loraStrength < -10 || settings.loraStrength > 10) throw new Error("Turbo LoRA 强度必须在 -10 到 10 之间");
  if (!(H3_UPSCALE_METHODS as readonly string[]).includes(settings.upscaleMethod)) throw new Error("图片缩放算法不受支持");
  if (!Number.isInteger(settings.resolutionSteps) || settings.resolutionSteps < 1 || settings.resolutionSteps > 256) throw new Error("分辨率步进必须是 1 到 256 的整数");
  const { width, height } = t2vaDimensions(settings);
  if (width % 32 || height % 32) throw new Error(`文生视频画面尺寸 ${width}×${height} 不是 32 的倍数，请把分辨率步进设为 32`);

  const workflow = structuredClone(t2vaTemplate) as Workflow;
  for (const id of REQUIRED_NODES) if (!workflow[id]) throw new Error(`H3 T2VA Workflow 缺少节点 ${id}`);
  workflow["6"].inputs.prompt = prompt;
  workflow["6"].inputs.length = settings.length;
  workflow["6"].inputs.width = width;
  workflow["6"].inputs.height = height;
  workflow["10"].inputs.noise_seed = seed;
  workflow["5"].inputs.strength = settings.loraStrength ?? H3_LORA_STRENGTH;
  workflow["25"].inputs.value = settings.turbo;
  workflow["27"].inputs.value = H3_STEPS;
  workflow["28"].inputs.value = 20;
  workflow["14"].inputs.fps = settings.fps;
  if (settings.soundMode === "silent") delete workflow["14"].inputs.audio;
  return workflow;
}
