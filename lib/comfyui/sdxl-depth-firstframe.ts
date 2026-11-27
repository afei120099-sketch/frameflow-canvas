import template from "./sdxl-depth-firstframe-workflow.json" with { type: "json" };
import { COMFYUI_PROXY_PATH } from "./config.ts";

/**
 * SDXL_DEPTH_FIRSTFRAME_V0.1 — Blender depth.png → SDXL (Juggernaut XL v9 + ControlNet Union v1, type "depth")
 * → a photorealistic still with the white-box layout, used as an ordinary first frame for the existing H3 I2VA.
 *
 * The template file is frozen (sha256 checked in scripts/test-sdxl-depth-firstframe.mjs). The builder only
 * fills the depth image name, the prompt (fixed photo prefix + the user's description), the seed and the size
 * (720×1280 / 1280×720 = exactly the Blender depth pixels). Conservative defaults, no tuning: control strength
 * 0.8 over the first 80 % of the steps, 30 steps, CFG 5.5, dpmpp_2m karras. Nothing here touches H3.
 */

export const SDXL_DEPTH_FIRSTFRAME = "SDXL_DEPTH_FIRSTFRAME_V0.1" as const;
export const SDXL_DEPTH_TEMPLATE_FILE = "sdxl-depth-firstframe-workflow.json";
export const SDXL_DEPTH_TEMPLATE = template;
export const SDXL_DEPTH_SAVE_NODE = "15";
export const SDXL_DEPTH_PROMPT_PREFIX = "RAW photo, photorealistic interior photograph, natural soft daylight, realistic materials and textures, 35mm lens, sharp focus, high detail";
export const SDXL_DEPTH_DEFAULT_SUBJECT = "an empty room with simple furniture";
export const SDXL_DEPTH_SIZES = [[720, 1280], [1280, 720]] as const;
export const SDXL_DEPTH_MAX_PROMPT = 600;

type Node = { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } };
type Workflow = Record<string, Node>;
const NODES = { positive: "2", depth: "4", latent: "8", sampler: "9" } as const;

export interface SdxlDepthInput { depthImageName: string; prompt: string; seed: number; width: number; height: number }

/** The fixed settings of the frozen template, recorded with every result. */
export function sdxlDepthSettings() {
  const workflow = template as Workflow;
  const control = workflow["7"].inputs, sampler = workflow[NODES.sampler].inputs;
  return {
    template: SDXL_DEPTH_FIRSTFRAME, templateFile: SDXL_DEPTH_TEMPLATE_FILE,
    checkpoint: String(workflow["1"].inputs.ckpt_name), controlNet: String(workflow["5"].inputs.control_net_name), controlType: String(workflow["6"].inputs.type),
    controlStrength: Number(control.strength), endPercent: Number(control.end_percent),
    steps: Number(sampler.steps), cfg: Number(sampler.cfg), sampler: `${sampler.sampler_name} ${sampler.scheduler}`,
  };
}

export function sdxlDepthPrompt(description: string) {
  const subject = description.trim().replace(/\s+/g, " ");
  if (subject.length > SDXL_DEPTH_MAX_PROMPT) throw new Error(`写实描述最多 ${SDXL_DEPTH_MAX_PROMPT} 个字符`);
  return `${SDXL_DEPTH_PROMPT_PREFIX}, ${subject || SDXL_DEPTH_DEFAULT_SUBJECT}`;
}

export function buildSdxlDepthWorkflow(input: SdxlDepthInput): Workflow {
  if (!SDXL_DEPTH_SIZES.some(([width, height]) => width === input.width && height === input.height)) throw new Error(`写实首帧尺寸只支持 ${SDXL_DEPTH_SIZES.map(([w, h]) => `${w}×${h}`).join(" / ")}`);
  if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2 ** 31 - 1) throw new Error("种子无效");
  if (!input.depthImageName) throw new Error("缺少深度图");
  const workflow = structuredClone(template) as Workflow;
  workflow[NODES.depth].inputs.image = input.depthImageName;
  workflow[NODES.positive].inputs.text = sdxlDepthPrompt(input.prompt);
  workflow[NODES.latent].inputs.width = input.width;
  workflow[NODES.latent].inputs.height = input.height;
  workflow[NODES.sampler].inputs.seed = input.seed;
  return workflow;
}

export async function sdxlDepthTemplateSha() {
  const bytes = new TextEncoder().encode(JSON.stringify(template));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type SdxlDepthOptions = { baseUrl?: string; fetch?: typeof fetch; pollMs?: number; timeoutMs?: number; onStage?: (stage: string) => void };
export type SdxlDepthResult = { image: Blob; promptId: string; seed: number; prompt: string; templateSha: string; filename: string };

function historyError(entry: Record<string, unknown>) {
  const status = entry.status as { status_str?: string; messages?: [string, Record<string, unknown>][] } | undefined;
  if (status?.status_str !== "error") return null;
  const failure = status.messages?.find(([kind]) => kind === "execution_error")?.[1];
  return String(failure?.exception_message ?? "ComfyUI 执行失败").trim();
}

/** Upload depth → queue the frozen workflow → wait for SaveImage → download the PNG. */
export async function runSdxlDepthFirstFrame(depth: Blob, input: Omit<SdxlDepthInput, "depthImageName">, options: SdxlDepthOptions = {}): Promise<SdxlDepthResult> {
  const call = async (path: string, init?: RequestInit) => {
    let response: Response;
    try { response = await (options.fetch ?? fetch)(`${options.baseUrl ?? COMFYUI_PROXY_PATH}${path}`, init); }
    catch { throw new Error("无法连接 ComfyUI（请确认 8188 已启动）"); }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } | string; node_errors?: Record<string, unknown> } | null;
      const message = typeof body?.error === "string" ? body.error : body?.error?.message;
      throw new Error(`ComfyUI 请求失败（HTTP ${response.status}）${message ? `：${message}` : ""}${body?.node_errors && Object.keys(body.node_errors).length ? `（节点：${Object.keys(body.node_errors).join("、")}）` : ""}`);
    }
    return response;
  };
  options.onStage?.("上传深度图");
  const form = new FormData();
  form.append("image", new File([depth], `frameflow_depth_${crypto.randomUUID()}.png`, { type: "image/png" }));
  form.append("type", "input"); form.append("overwrite", "true");
  const uploaded = await (await call("/upload/image", { method: "POST", body: form })).json() as { name?: string; subfolder?: string };
  if (!uploaded.name) throw new Error("深度图上传成功，但 ComfyUI 未返回文件名");
  const depthImageName = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;

  const workflow = buildSdxlDepthWorkflow({ ...input, depthImageName });
  options.onStage?.("提交 SDXL");
  const queued = await (await call("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: `frameflow-sdxl-${crypto.randomUUID()}` }) })).json() as { prompt_id?: string };
  if (!queued.prompt_id) throw new Error("ComfyUI 未返回任务 ID");
  const promptId = queued.prompt_id;

  options.onStage?.("SDXL 生成中");
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);
  for (;;) {
    const history = await (await call(`/history/${encodeURIComponent(promptId)}`, { cache: "no-store" })).json() as Record<string, Record<string, unknown>>;
    const entry = history[promptId];
    if (entry) {
      const error = historyError(entry);
      if (error) throw new Error(`SDXL 生成失败：${error}`);
      const images = ((entry.outputs as Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }> | undefined)?.[SDXL_DEPTH_SAVE_NODE]?.images) ?? [];
      const file = images[0];
      if (!file) throw new Error("ComfyUI 已结束，但没有找到 SaveImage 的输出");
      options.onStage?.("下载写实首帧");
      const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
      const bytes = await (await call(`/view?${query}`, { cache: "no-store" })).arrayBuffer();
      return { image: new Blob([bytes], { type: "image/png" }), promptId, seed: input.seed, prompt: String(workflow[NODES.positive].inputs.text), templateSha: await sdxlDepthTemplateSha(), filename: file.filename };
    }
    if (Date.now() > deadline) throw new Error("SDXL 生成超时（任务仍可能在 ComfyUI 中运行）");
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1500));
  }
}
