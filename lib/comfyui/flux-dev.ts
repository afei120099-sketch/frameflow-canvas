import {scheduledPromptFetch} from "./submission-scheduler.ts";
import { COMFYUI_PROXY_PATH } from "./config.ts";
import { waitForFluxSchnell } from "./flux-schnell.ts";

export const FLUX_DEV_MODELS = { unet: "flux1-dev-fp8.safetensors", clip: "clip_l.safetensors", t5: "t5xxl_fp8_e4m3fn.safetensors", vae: "ae.safetensors" };
export const FLUX_PULID = { file: "pulid_flux_v0.9.1.safetensors", weight: 0.85, provider: "CPU" } as const;
/** Storyboard → depth → Flux Dev. BFL's official depth LoRA; guidance 10 is BFL's recommended value for Depth [dev]. */
export const FLUX_DEPTH = { lora: "flux1-depth-dev-lora.safetensors", strength: 1, guidance: 10, preprocessor: "depth_anything_v2_vitl.pth" } as const;
export type FluxDevInput = {
  prompt: string; width: number; height: number; seed: number; steps?: number;
  guidance?: number; sampler?: string; scheduler?: string; denoise?: number;
  imageName?: string; maskName?: string; maskGrow?: number; maskBlur?: number;
  faceImageName?: string; faceWeight?: number; bodyImageName?: string;
  /** Storyboard image: its depth map (Depth Anything V2) locks composition, camera and pose. Not combinable with img2img/mask/body. */
  depthImageName?: string; depthStrength?: number;
  extraLora?: boolean;
};
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export function buildFluxDev(input: FluxDevInput): Graph {
  if (!input.prompt.trim()) throw new Error("请填写图片提示词");
  if (![input.width, input.height].every(n => Number.isInteger(n) && n >= 256 && n <= 1536 && n % 16 === 0)) throw new Error("宽高需为256–1536之间的16倍数");
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) throw new Error("种子需为非负安全整数");
  const steps = input.steps ?? 24, guidance = input.guidance ?? 3.5;
  // Mask controls where to edit; denoise independently controls how much to change.
  const denoise = input.denoise ?? (input.imageName ? 0.5 : 1);
  const grow = input.maskGrow ?? 8, blur = input.maskBlur ?? 8;
  if (!Number.isInteger(steps) || steps < 1 || steps > 10000) throw new Error("采样步数需为1–10000的整数");
  if (!Number.isFinite(guidance) || guidance < 0 || guidance > 100) throw new Error("Flux引导强度需为0–100");
  if (!Number.isFinite(denoise) || denoise <= 0 || denoise > 1) throw new Error("重绘强度需大于0且不超过1");
  if (!Number.isInteger(grow) || grow < 0 || grow > 64 || !Number.isInteger(blur) || blur < 1 || blur > 31) throw new Error("遮罩扩展需为0–64像素，柔化需为1–31像素");
  if (input.maskName && !input.imageName) throw new Error("局部重绘必须有原图");
  if (input.depthImageName && (input.imageName || input.maskName || input.bodyImageName)) throw new Error("分镜深度出图不能同时用原图、遮罩或全身底图");
  const depthStrength = input.depthStrength ?? FLUX_DEPTH.strength;
  if (!Number.isFinite(depthStrength) || depthStrength < 0 || depthStrength > 2) throw new Error("分镜深度强度需在 0 到 2 之间");
  const graph: Graph = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: FLUX_DEV_MODELS.unet, weight_dtype: "fp8_e4m3fn" } },
    "10": { class_type: "DualCLIPLoader", inputs: { clip_name1: FLUX_DEV_MODELS.clip, clip_name2: FLUX_DEV_MODELS.t5, type: "flux", device: "cpu" } },
    "11": { class_type: "VAELoader", inputs: { vae_name: FLUX_DEV_MODELS.vae } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: input.prompt.trim(), clip: ["10", 0] } },
    "12": { class_type: "FluxGuidance", inputs: { conditioning: ["2", 0], guidance } },
    "3": { class_type: "EmptySD3LatentImage", inputs: { width: input.width, height: input.height, batch_size: 1 } },
    "4": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["2", 0] } },
    "5": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["12", 0], negative: ["4", 0], latent_image: ["3", 0], seed: input.seed, steps, cfg: 1, sampler_name: input.sampler ?? "euler", scheduler: input.scheduler ?? "simple", denoise } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["11", 0] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "Frameflow_Flux_Dev_Quality" } },
  };
  if (input.imageName) {
    graph["8"] = { class_type: "LoadImage", inputs: { image: input.imageName } };
    graph["9"] = { class_type: "ImageScale", inputs: { image: ["8", 0], upscale_method: "lanczos", width: input.width, height: input.height, crop: "disabled" } };
    graph["3"] = { class_type: "VAEEncode", inputs: { pixels: ["9", 0], vae: ["11", 0] } };
  } else if (input.bodyImageName) {
    graph["35"] = { class_type: "LoadImage", inputs: { image: input.bodyImageName } };
    graph["36"] = { class_type: "ImageScale", inputs: { image: ["35", 0], upscale_method: "lanczos", width: input.width, height: input.height, crop: "disabled" } };
    graph["3"] = { class_type: "VAEEncode", inputs: { pixels: ["36", 0], vae: ["11", 0] } };
  }
  if (input.maskName) {
    graph["15"] = { class_type: "LoadImage", inputs: { image: input.maskName } };
    graph["16"] = { class_type: "ImageToMask", inputs: { image: ["15", 0], channel: "red" } };
    graph["17"] = { class_type: "MaskToImage", inputs: { mask: ["16", 0] } };
    graph["18"] = { class_type: "ImageScale", inputs: { image: ["17", 0], upscale_method: "bilinear", width: input.width, height: input.height, crop: "disabled" } };
    graph["19"] = { class_type: "ImageToMask", inputs: { image: ["18", 0], channel: "red" } };
    graph["20"] = { class_type: "GrowMask", inputs: { mask: ["19", 0], expand: grow, tapered_corners: true } };
    graph["21"] = { class_type: "MaskToImage", inputs: { mask: ["20", 0] } };
    graph["22"] = { class_type: "ImageBlur", inputs: { image: ["21", 0], blur_radius: blur, sigma: Math.max(0.5, blur / 2) } };
    graph["23"] = { class_type: "ImageToMask", inputs: { image: ["22", 0], channel: "red" } };
    graph["24"] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["3", 0], mask: ["23", 0] } };
    graph["5"].inputs.latent_image = ["24", 0];
    graph["25"] = { class_type: "ImageCompositeMasked", inputs: { destination: ["9", 0], source: ["6", 0], x: 0, y: 0, resize_source: false, mask: ["23", 0] } };
    graph["7"].inputs.images = ["25", 0];
  }
  let identityBase: [string, number] = ["1", 0];
  if (input.depthImageName) {
    graph["40"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: FLUX_DEPTH.lora, strength_model: depthStrength } };
    graph["41"] = { class_type: "LoadImage", inputs: { image: input.depthImageName } };
    // Center-crop to the target ratio: stretching a storyboard would distort the composition it is meant to lock.
    graph["42"] = { class_type: "ImageScale", inputs: { image: ["41", 0], upscale_method: "lanczos", width: input.width, height: input.height, crop: "center" } };
    graph["43"] = { class_type: "DepthAnythingV2Preprocessor", inputs: { image: ["42", 0], ckpt_name: FLUX_DEPTH.preprocessor, resolution: Math.min(1024, Math.max(input.width, input.height)) } };
    graph["44"] = { class_type: "InstructPixToPixConditioning", inputs: { positive: ["12", 0], negative: ["4", 0], vae: ["11", 0], pixels: ["43", 0] } };
    graph["45"] = { class_type: "SaveImage", inputs: { images: ["43", 0], filename_prefix: "Frameflow_Flux_Depth_Map" } };
    Object.assign(graph["5"].inputs, { model: ["40", 0], positive: ["44", 0], negative: ["44", 1], latent_image: ["44", 2], denoise: 1 });
    graph["7"].inputs.filename_prefix = "Frameflow_Flux_Depth_Keyframe";
    delete graph["3"];
    identityBase = ["40", 0];
  }
  if (input.faceImageName) {
    const weight = input.faceWeight ?? FLUX_PULID.weight;
    if (!Number.isFinite(weight) || weight < -1 || weight > 5) throw new Error("脸部身份强度需在 -1 到 5 之间");
    graph["30"] = { class_type: "PulidFluxModelLoader", inputs: { pulid_file: FLUX_PULID.file } };
    graph["31"] = { class_type: "PulidFluxInsightFaceLoader", inputs: { provider: FLUX_PULID.provider } };
    graph["32"] = { class_type: "PulidFluxEvaClipLoader", inputs: {} };
    graph["33"] = { class_type: "LoadImage", inputs: { image: input.faceImageName } };
    graph["34"] = { class_type: "ApplyPulidFlux", inputs: { model: identityBase, pulid_flux: ["30", 0], eva_clip: ["32", 0], face_analysis: ["31", 0], image: ["33", 0], weight, start_at: 0, end_at: 1 } };
    graph["5"].inputs.model = ["34", 0];
  }
  return graph;
}

type RunOptions = { fetch?: typeof fetch; pollMs?: number; onStage?: (text: string) => void; onReserved?: (id:string,graph:Graph)=>Promise<void>; onSubmitted?: (id: string) => void; sourceImage?: Blob; maskImage?: Blob; faceImage?: Blob; bodyImage?: Blob; depthImage?: Blob };
export async function runFluxDev(input: FluxDevInput, options: RunOptions = {}) {
  if (options.maskImage && !options.sourceImage) throw new Error("局部重绘必须提供原图和遮罩");
  if (input.maskName && !options.maskImage && options.sourceImage) throw new Error("请提供与原图绑定的遮罩");
  let graph = buildFluxDev(input);
  const request = async (path: string, init?: RequestInit) => {
    const response = path==="/prompt" ? await scheduledPromptFetch(`${COMFYUI_PROXY_PATH}${path}`,init!,options.fetch??fetch) : await (options.fetch ?? fetch)(`${COMFYUI_PROXY_PATH}${path}`, init);
    if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}：${(await response.text()).slice(0, 600)}`);
    return response;
  };
  options.onStage?.("检查Flux Dev模型与队列");
  const loaders = [
    ["UNETLoader", "unet_name", FLUX_DEV_MODELS.unet],
    ["DualCLIPLoader", "clip_name1", FLUX_DEV_MODELS.clip],
    ["DualCLIPLoader", "clip_name2", FLUX_DEV_MODELS.t5],
    ["VAELoader", "vae_name", FLUX_DEV_MODELS.vae],
  ];
  type LoaderInfo = Record<string, { input?: { required?: Record<string, string[][]> } }>;
  const infos = await Promise.all(loaders.map(async ([node]) => (await (await request(`/object_info/${node}`)).json()) as LoaderInfo));
  loaders.forEach(([node, field, model], index) => {
    if (!infos[index][node]?.input?.required?.[field]?.[0]?.includes(model)) throw new Error(`ComfyUI未识别模型：${model}`);
  });
  if (input.maskName || options.maskImage) {
    for (const name of ["ImageToMask", "MaskToImage", "GrowMask", "ImageBlur", "SetLatentNoiseMask", "ImageCompositeMasked"]) {
      const info = await (await request(`/object_info/${name}`)).json() as LoaderInfo;
      if (!info[name]) throw new Error(`ComfyUI缺少原生节点：${name}`);
    }
  }
  if (options.faceImage || input.faceImageName) {
    for (const name of ["PulidFluxModelLoader", "PulidFluxInsightFaceLoader", "PulidFluxEvaClipLoader", "ApplyPulidFlux"]) {
      const info = await (await request(`/object_info/${name}`)).json() as LoaderInfo;
      if (!info[name]) throw new Error(`ComfyUI缺少人物身份节点：${name}`);
      if (name === "PulidFluxModelLoader" && !info[name]?.input?.required?.pulid_file?.[0]?.includes(FLUX_PULID.file)) throw new Error(`ComfyUI未识别身份权重：${FLUX_PULID.file}`);
    }
  }
  if (options.depthImage || input.depthImageName) {
    const lora = await (await request("/object_info/LoraLoaderModelOnly")).json() as LoaderInfo;
    if (!lora.LoraLoaderModelOnly?.input?.required?.lora_name?.[0]?.includes(FLUX_DEPTH.lora)) throw new Error(`ComfyUI未识别分镜深度模型：${FLUX_DEPTH.lora}，请确认已放进 models/loras 并重启 ComfyUI`);
    for (const name of ["DepthAnythingV2Preprocessor", "InstructPixToPixConditioning"]) {
      const info = await (await request(`/object_info/${name}`)).json() as LoaderInfo;
      if (!info[name]) throw new Error(`ComfyUI缺少分镜深度节点：${name}`);
    }
  }
  const queue = await (await request("/queue")).json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  if (queue.queue_running?.length || queue.queue_pending?.length) throw new Error("ComfyUI还有任务，请等当前任务完成后再生成图片");
  const upload = async (blob: Blob, role: string) => {
    if (!blob.size) throw new Error(`${role}为空`);
    const extension = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
    const form = new FormData();
    form.append("image", blob, `frameflow_flux_dev_${crypto.randomUUID()}.${extension}`);
    form.append("type", "input"); form.append("overwrite", "false");
    const file = await (await request("/upload/image", { method: "POST", body: form })).json() as { name?: string; subfolder?: string };
    if (!file.name) throw new Error(`ComfyUI未返回${role}上传路径`);
    return [file.subfolder, file.name].filter(Boolean).join("/");
  };
  if (options.sourceImage || options.faceImage || options.bodyImage || options.depthImage) {
    options.onStage?.(options.faceImage ? "上传脸部参考" : "上传原图与遮罩");
    const imageName = options.sourceImage ? await upload(options.sourceImage, "原图") : input.imageName;
    const faceImageName = options.faceImage ? await upload(options.faceImage, "脸部参考") : input.faceImageName;
    const bodyImageName = options.bodyImage ? await upload(options.bodyImage, "全身参考") : input.bodyImageName;
    const maskName = options.maskImage ? await upload(options.maskImage, "遮罩") : undefined;
    const depthImageName = options.depthImage ? await upload(options.depthImage, "分镜图") : input.depthImageName;
    graph = buildFluxDev({ ...input, imageName, faceImageName, bodyImageName, maskName, depthImageName });
  }
  options.onStage?.(`提交Flux Dev ${input.steps ?? 24}步${input.maskName || options.maskImage ? "局部重绘" : "生图"}`);
  let promptId: string;
  const reserved=options.onReserved?crypto.randomUUID():undefined;
  if(reserved)await options.onReserved!(reserved,graph);
  try {
    const result = await (await request("/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph, ...(reserved?{prompt_id:reserved}:{}),client_id: `frameflow-flux-dev-${crypto.randomUUID()}` }) })).json() as { prompt_id?: string };
    if (!result.prompt_id) throw new Error("未返回任务ID");
    promptId = result.prompt_id;
    if(reserved&&promptId!==reserved)throw Error('ComfyUI返回的任务ID与预留记录不一致');
  } catch (cause) {
    throw new Error(`提交状态待确认，请先检查ComfyUI队列，不要重复生成：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  options.onSubmitted?.(promptId);
  return waitForFluxDev(promptId, input.seed, options);
}

// Both adapters save from node 7. Keep recovery of pre-upgrade pending tasks intact.
export const waitForFluxDev = waitForFluxSchnell;
