/**
 * Phase 11: project diagnostics (read-only). Every check reports what it actually observed;
 * nothing is repaired, submitted, uploaded or decoded. A check that cannot run says so.
 */

export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckResult { id: string; label: string; status: CheckStatus; detail: string; items?: string[] }

type Row = Record<string, unknown>;
export interface DiagnosticsDeps {
  /** GET /comfyui/system_stats through the dev proxy; returns HTTP status and parsed JSON (or throws on network error). */
  systemStats: () => Promise<{ status: number; body: unknown }>;
  /** The 4 frozen templates as bundled into the app, plus their builders (throw if a required node is missing). */
  templates: { name: string; template: unknown; build: () => unknown; requiredNodes: Record<string, string> }[];
  adapterConfig: { serverUrl: string; proxyPath: string; saveNodes: Record<string, string>; webSocketUrl: string };
  /** Metadata and store keys (no Blob bytes are read). */
  records: () => Promise<{ assets: Row[]; runs: Row[]; shots: Row[]; roles: Row[] }>;
  mediaKeys: () => Promise<{ images: string[]; videos: string[]; audios: string[] }>;
  /** POST /__audio_extract?operation=diagnostic (an invalid operation: rejected before any work). */
  audioEndpoint: () => Promise<{ status: number; body: string }>;
  browser: { directoryPicker: boolean; folderInput: boolean; indexedDB: boolean };
  databases: () => Promise<{ name: string; ok: boolean; detail: string }[]>;
}

const pass = (id: string, label: string, detail: string, items?: string[]): CheckResult => ({ id, label, status: "pass", detail, ...(items?.length ? { items } : {}) });
const warn = (id: string, label: string, detail: string, items?: string[]): CheckResult => ({ id, label, status: "warn", detail, ...(items?.length ? { items } : {}) });
const fail = (id: string, label: string, detail: string, items?: string[]): CheckResult => ({ id, label, status: "fail", detail, ...(items?.length ? { items } : {}) });
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const LIST_LIMIT = 12;
const short = (items: string[]) => items.length > LIST_LIMIT ? [...items.slice(0, LIST_LIMIT), `…另外 ${items.length - LIST_LIMIT} 项`] : items;
const str = (value: unknown) => typeof value === "string" ? value : "";

async function comfy(deps: DiagnosticsDeps): Promise<CheckResult[]> {
  try {
    const { status, body } = await deps.systemStats();
    if (status !== 200) return [fail("comfy-online", "ComfyUI 在线状态", `代理返回 HTTP ${status}：ComfyUI 未启动或不可达（127.0.0.1:8188）`), fail("comfy-stats", "/comfyui/system_stats", `HTTP ${status}`)];
    const devices = (body as { devices?: { name?: string; vram_total?: number; vram_free?: number }[] })?.devices ?? [];
    const system = (body as { system?: { comfyui_version?: string; python_version?: string } })?.system ?? {};
    const gpu = devices[0];
    const gpuText = gpu ? `${gpu.name ?? "GPU"} · 显存 ${gpu.vram_total ? (gpu.vram_total / 1024 ** 3).toFixed(1) : "?"} GB（空闲 ${gpu.vram_free ? (gpu.vram_free / 1024 ** 3).toFixed(1) : "?"} GB）` : "未报告 GPU 设备";
    return [pass("comfy-online", "ComfyUI 在线状态", "已连接"), (gpu ? pass : warn)("comfy-stats", "/comfyui/system_stats", `可访问 · ComfyUI ${system.comfyui_version ?? "版本未报告"} · ${gpuText}`)];
  } catch (cause) {
    return [fail("comfy-online", "ComfyUI 在线状态", `无法连接：${message(cause)}`), fail("comfy-stats", "/comfyui/system_stats", "请求未能发出或没有响应")];
  }
}

function templates(deps: DiagnosticsDeps): CheckResult {
  const problems: string[] = [];
  for (const entry of deps.templates) {
    if (!entry.template || typeof entry.template !== "object") { problems.push(`${entry.name}：模板缺失`); continue; }
    const nodes = entry.template as Record<string, { class_type?: string }>;
    for (const [id, classType] of Object.entries(entry.requiredNodes)) if (nodes[id]?.class_type !== classType) problems.push(`${entry.name}：节点 ${id} 应为 ${classType}，实际 ${nodes[id]?.class_type ?? "缺失"}`);
    try { entry.build(); } catch (cause) { problems.push(`${entry.name}：构建任务副本失败 · ${message(cause)}`); }
  }
  return problems.length ? fail("templates", "4 个冻结 Workflow 模板", `${problems.length} 个问题`, short(problems)) : pass("templates", "4 个冻结 Workflow 模板", `${deps.templates.map((entry) => entry.name).join("、")} 均存在，关键节点齐全，可构建任务副本（未提交）`);
}

function adapter(deps: DiagnosticsDeps): CheckResult {
  const { serverUrl, proxyPath, saveNodes, webSocketUrl } = deps.adapterConfig;
  const problems: string[] = [];
  try { const url = new URL(serverUrl); if (!["127.0.0.1", "localhost"].includes(url.hostname)) problems.push(`ComfyUI 地址不是本机：${serverUrl}`); } catch { problems.push(`ComfyUI 地址无效：${serverUrl}`); }
  if (!proxyPath.startsWith("/")) problems.push(`代理路径无效：${proxyPath}`);
  if (!/^wss?:\/\/.+\/ws$/.test(webSocketUrl)) problems.push(`进度 WebSocket 地址无效：${webSocketUrl}`);
  for (const capability of ["h3_fl2va", "h3_ref2va", "seedvr2_upscale", "film_interpolation"]) if (!saveNodes[capability]) problems.push(`${capability} 没有输出节点映射`);
  return problems.length ? fail("adapter", "H3 / SeedVR2 / FILM 适配配置", `${problems.length} 个问题`, problems) : pass("adapter", "H3 / SeedVR2 / FILM 适配配置", `${serverUrl} · 代理 ${proxyPath} · 输出节点 ${Object.entries(saveNodes).map(([key, value]) => `${key}=${value}`).join(" / ")}`);
}

const MEDIA_PREFIX: [string, "images" | "videos" | "audios"][] = [["image:", "images"], ["media:", "videos"], ["audio:", "audios"]];
async function recordChecks(deps: DiagnosticsDeps): Promise<CheckResult[]> {
  let data: Awaited<ReturnType<DiagnosticsDeps["records"]>>; let keys: Awaited<ReturnType<DiagnosticsDeps["mediaKeys"]>>;
  try { [data, keys] = await Promise.all([deps.records(), deps.mediaKeys()]); }
  catch (cause) { const detail = `读取失败：${message(cause)}`; return [fail("blobs", "Asset 媒体文件", detail), fail("roles", "角色引用", detail), fail("lineage", "Shot / Run / Asset 血缘", detail)]; }
  const stores = { images: new Set(keys.images), videos: new Set(keys.videos), audios: new Set(keys.audios) };
  const assetIds = new Set(data.assets.map((asset) => str(asset.assetId)));
  const runIds = new Set(data.runs.map((run) => str(run.runId)));
  const shotIds = new Set(data.shots.map((shot) => str(shot.shotId)));
  const name = (asset: Row) => `${str(asset.filename) || str(asset.assetId)}`;

  const missing: string[] = []; let legacy = 0;
  for (const asset of data.assets) {
    const ref = str(asset.storageReference);
    if (ref.startsWith("legacy-inline:") || ref.startsWith("data:")) { legacy += 1; continue; }
    const match = MEDIA_PREFIX.find(([prefix]) => ref.startsWith(prefix));
    if (match && !stores[match[1]].has(ref.slice(match[0].length))) missing.push(`${name(asset)}（${ref}）`);
  }
  const blobs = missing.length ? fail("blobs", "Asset 媒体文件", `${missing.length} / ${data.assets.length} 个 Asset 找不到媒体文件`, short(missing))
    : legacy ? warn("blobs", "Asset 媒体文件", `${data.assets.length - legacy} 个均可定位；${legacy} 个旧版内联素材没有独立媒体文件`) : pass("blobs", "Asset 媒体文件", `${data.assets.length} 个 Asset 的媒体文件均存在（只检查存在性，未解码）`);

  const roleProblems: string[] = [];
  for (const role of data.roles) {
    const display = str(role.displayName) || str(role.roleId);
    for (const key of ["appearanceAssetIds", "voiceAssetIds"] as const) for (const id of (role[key] as string[] | undefined) ?? []) if (!assetIds.has(id)) roleProblems.push(`角色“${display}”引用了不存在的 Asset ${id}`);
    for (const [key, list] of [["primaryAppearanceAssetId", "appearanceAssetIds"], ["primaryVoiceAssetId", "voiceAssetIds"]] as const) {
      const id = role[key] as string | null | undefined;
      if (id && !((role[list] as string[] | undefined) ?? []).includes(id)) roleProblems.push(`角色“${display}”的${key === "primaryAppearanceAssetId" ? "主外观" : "主声音"}不在其素材列表中`);
    }
  }
  const roles = roleProblems.length ? fail("roles", "角色引用", `${roleProblems.length} 处失效引用`, short(roleProblems)) : pass("roles", "角色引用", `${data.roles.length} 个角色的外观 / 声音引用均有效`);

  const breaks: string[] = [];
  for (const shot of data.shots) {
    const label = `镜头 ${String(shot.shotNumber ?? "?")}`;
    for (const id of (shot.runIds as string[] | undefined) ?? []) if (!runIds.has(id)) breaks.push(`${label} 引用了不存在的 Run ${id}`);
    if (shot.adoptedAssetId && !assetIds.has(str(shot.adoptedAssetId))) breaks.push(`${label} 的 ★采用版本 Asset 不存在`);
    if (shot.adoptedRunId && !runIds.has(str(shot.adoptedRunId))) breaks.push(`${label} 的 ★采用 Run 不存在`);
  }
  for (const run of data.runs) for (const id of (run.outputAssetIds as string[] | undefined) ?? []) if (!assetIds.has(id)) breaks.push(`Run ${str(run.runId).slice(-8)} 的输出 Asset ${id} 不存在`);
  for (const asset of data.assets) {
    if (asset.sourceRunId && !runIds.has(str(asset.sourceRunId))) breaks.push(`${name(asset)} 的来源 Run 不存在`);
    if (asset.shotId && !shotIds.has(str(asset.shotId))) breaks.push(`${name(asset)} 所属镜头不存在`);
    for (const key of ["sourceVideoAssetId", "sourceAudioAssetId"] as const) if (asset[key] && !assetIds.has(str(asset[key]))) breaks.push(`${name(asset)} 的上游素材（${key}）不存在`);
  }
  const lineage = breaks.length ? warn("lineage", "Shot / Run / Asset 血缘", `${breaks.length} 处断链（记录保留，未修改）`, short(breaks)) : pass("lineage", "Shot / Run / Asset 血缘", `${data.shots.length} 个镜头 · ${data.runs.length} 个 Run · ${data.assets.length} 个 Asset，未发现断链`);
  return [blobs, roles, lineage];
}

async function audio(deps: DiagnosticsDeps): Promise<CheckResult> {
  try {
    const { status, body } = await deps.audioEndpoint();
    if (status === 400 && body.includes("INVALID_OPERATION")) return pass("audio", "本地音频提取接口", "接口已注册并响应（未执行 PyAV；实际提取需用真实有声视频验证）");
    if (status === 403) return warn("audio", "本地音频提取接口", "接口存在但拒绝了请求：只接受 localhost / 127.0.0.1 访问");
    return fail("audio", "本地音频提取接口", `接口不可用（HTTP ${status}）：只在 pnpm dev 本地开发服务器中提供`);
  } catch (cause) { return fail("audio", "本地音频提取接口", `请求失败：${message(cause)}`); }
}

function backup(deps: DiagnosticsDeps): CheckResult {
  const { directoryPicker, folderInput, indexedDB } = deps.browser;
  if (!indexedDB) return fail("backup", "项目备份导入 / 导出", "浏览器不支持 IndexedDB");
  if (!directoryPicker && !folderInput) return fail("backup", "项目备份导入 / 导出", "当前浏览器既不能导出到文件夹，也不能选择备份文件夹");
  if (!directoryPicker) return warn("backup", "项目备份导入 / 导出", "可以从备份文件夹恢复，但当前浏览器不支持导出到文件夹（请用 Chrome / Edge）");
  return pass("backup", "项目备份导入 / 导出", "支持导出到文件夹与从备份文件夹恢复（未实际读写文件）");
}

async function databases(deps: DiagnosticsDeps): Promise<CheckResult> {
  try {
    const results = await deps.databases();
    const bad = results.filter((item) => !item.ok);
    const items = results.map((item) => `${item.name}：${item.detail}`);
    return bad.length ? fail("indexeddb", "IndexedDB 主要库", `${bad.length} 个库无法读取`, items) : pass("indexeddb", "IndexedDB 主要库", `${results.length} 个库均可读取`, items);
  } catch (cause) { return fail("indexeddb", "IndexedDB 主要库", `检查失败：${message(cause)}`); }
}

export async function runDiagnostics(deps: DiagnosticsDeps): Promise<CheckResult[]> {
  const [comfyResults, recordResults, audioResult, databaseResult] = await Promise.all([comfy(deps), recordChecks(deps), audio(deps), databases(deps)]);
  return [...comfyResults, templates(deps), adapter(deps), ...recordResults, audioResult, backup(deps), databaseResult];
}

export function diagnosticsReport(results: CheckResult[], now = Date.now()) {
  const icon = { pass: "✓", warn: "!", fail: "✗" } as const;
  return [`Frameflow 诊断报告 · ${new Date(now).toLocaleString("zh-CN")}`, ...results.flatMap((result) => [`${icon[result.status]} ${result.label}：${result.detail}`, ...(result.items ?? []).map((item) => `    - ${item}`)])].join("\n");
}
