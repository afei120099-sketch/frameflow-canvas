import { COMFYUI_PROXY_PATH } from "./config.ts";

export const FLUX_CHECKPOINT = "flux1-schnell-fp8.safetensors";
export type FluxInput = { prompt: string; width: number; height: number; seed: number; steps?: number; cfg?: number; sampler?: string; scheduler?: string; denoise?: number; imageName?: string };
export function buildFluxSchnell(input: FluxInput) {
  if (!input.prompt.trim()) throw new Error("请填写图片提示词");
  if (![input.width, input.height].every(n => Number.isInteger(n) && n >= 256 && n <= 1536 && n % 16 === 0)) throw new Error("宽高需为 256–1536 之间的 16 倍数");
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) throw new Error("种子需为非负安全整数");
  const steps = input.steps ?? 4, cfg = input.cfg ?? 1, denoise = input.denoise ?? 1;
  if (!Number.isInteger(steps) || steps < 1 || steps > 10000) throw new Error("采样步数需为 1–10000 的整数");
  if (!Number.isFinite(cfg) || cfg < 0 || cfg > 100) throw new Error("CFG 需为 0–100");
  if (!Number.isFinite(denoise) || denoise < 0 || denoise > 1) throw new Error("去噪需为 0–1");
  const workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: FLUX_CHECKPOINT } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: input.prompt.trim(), clip: ["1", 1] } },
    "3": { class_type: "EmptySD3LatentImage", inputs: { width: input.width, height: input.height, batch_size: 1 } },
    "4": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["2", 0] } },
    "5": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["4", 0], latent_image: ["3", 0], seed: input.seed, steps, cfg, sampler_name: input.sampler ?? "euler", scheduler: input.scheduler ?? "simple", denoise } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "Frameflow_Flux_Schnell" } },
  };
  if (input.imageName) {
    workflow["8"] = { class_type: "LoadImage", inputs: { image: input.imageName } };
    workflow["9"] = { class_type: "ImageScale", inputs: { image: ["8", 0], upscale_method: "lanczos", width: input.width, height: input.height, crop: "disabled" } };
    workflow["3"] = { class_type: "VAEEncode", inputs: { pixels: ["9", 0], vae: ["1", 2] } };
  }
  return workflow;
}

export async function runFluxSchnell(input: FluxInput, options: { fetch?: typeof fetch; pollMs?: number; onStage?: (text: string) => void; onSubmitted?: (id: string) => void; sourceImage?: Blob } = {}) {
  let workflow = buildFluxSchnell(input);
  const request = async (path: string, init?: RequestInit) => {
    const response = await (options.fetch ?? fetch)(`${COMFYUI_PROXY_PATH}${path}`, init);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ComfyUI HTTP ${response.status}：${body.slice(0, 600)}`);
    }
    return response;
  };
  options.onStage?.("检查模型与队列");
  const info = await (await request("/object_info/CheckpointLoaderSimple")).json() as { CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: string[][] } } } };
  if (!info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]?.includes(FLUX_CHECKPOINT)) throw new Error("ComfyUI 未识别 Flux FP8 模型，请刷新模型列表");
  const queue = await (await request("/queue")).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  if (queue.queue_running?.length || queue.queue_pending?.length) throw new Error("ComfyUI 还有任务，请等当前任务完成后再生成图片");
  if (options.sourceImage) {
    if (!options.sourceImage.size) throw new Error("输入图片为空");
    options.onStage?.("上传图生图原图");
    const extension = options.sourceImage.type === "image/jpeg" ? "jpg" : options.sourceImage.type === "image/webp" ? "webp" : "png";
    const form = new FormData();
    form.append("image", options.sourceImage, `frameflow_flux_${crypto.randomUUID()}.${extension}`);
    form.append("type", "input"); form.append("overwrite", "false");
    const uploaded = await (await request("/upload/image", { method: "POST", body: form })).json() as { name?: string; subfolder?: string };
    if (!uploaded.name) throw new Error("ComfyUI 未返回原图上传路径");
    workflow = buildFluxSchnell({ ...input, imageName: [uploaded.subfolder, uploaded.name].filter(Boolean).join("/") });
  }
  options.onStage?.(`提交 Flux ${input.steps ?? 4} 步生图`);
  let promptId: string;
  try {
    const queued = await (await request("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: `frameflow-flux-${crypto.randomUUID()}` }) })).json() as { prompt_id?: string };
    if (!queued.prompt_id) throw new Error("未返回任务 ID");
    promptId = queued.prompt_id;
  } catch (cause) {
    // Never blindly resubmit a POST whose acceptance is unknown.
    throw new Error(`提交状态待确认，请先检查 ComfyUI 队列，不要重复生成：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  options.onSubmitted?.(promptId);
  return waitForFluxSchnell(promptId, input.seed, options);
}

export async function waitForFluxSchnell(promptId: string, seed: number, options: { fetch?: typeof fetch; pollMs?: number; onStage?: (text: string) => void } = {}) {
  let missingRounds = 0;
  const request = async (path: string, init?: RequestInit) => {
    const response = await (options.fetch ?? fetch)(`${COMFYUI_PROXY_PATH}${path}`, init);
    if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}`);
    return response;
  };
  for (;;) {
    options.onStage?.(`Flux 生成中 · 任务 ${promptId}`);
    type Entry = { status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string }][] }; outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }> };
    let entry: Entry | undefined;
    try { entry = (await (await request(`/history/${encodeURIComponent(promptId)}`, { cache: "no-store" })).json() as Record<string, Entry>)[promptId]; }
    catch { options.onStage?.(`连接中断，正在重连原任务 ${promptId}（不会重复提交）`); }
    if (entry?.status?.status_str === "error") {
      const failure = entry.status.messages?.find(([kind]) => kind === "execution_error" || kind === "execution_interrupted");
      throw new Error(`Flux 生成失败：${failure?.[1]?.exception_message ?? "任务失败或被中断"}`);
    }
    if (entry?.status?.completed || entry?.outputs?.["7"]?.images?.length) {
      const file = entry.outputs?.["7"]?.images?.[0];
      if (!file) throw new Error("任务结束，但没有图片输出");
      options.onStage?.("保存图片到画布");
      const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
      const image = await (await request(`/view?${query}`)).blob();
      if (!image.size) throw new Error("输出图片为空");
      return { image, filename: String(file.filename), promptId, seed };
    }
    if (!entry) {
      try {
        const queue = await (await request("/queue", { cache: "no-store" })).json() as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
        if ([...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].some(item => item[1] === promptId)) missingRounds = 0;
        else if (++missingRounds >= 2) {
          throw new Error(`原任务 ${promptId} 不在队列或历史中，请检查 ComfyUI；不会自动重新生成`);
        }
      } catch (cause) { if (cause instanceof Error && cause.message.startsWith("原任务")) throw cause; }
    }
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 1500));
  }
}
