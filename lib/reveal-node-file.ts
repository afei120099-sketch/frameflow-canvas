/**
 * 右键「打开所在文件夹」：从节点当前显示的素材记录拼出「这个文件在本机哪」的线索，交给开发服务器
 * （scripts/reveal-file-vite-plugin.mjs）在资源管理器里打开并选中。这里不读文件、不导出、不改素材。
 */
import type { AssetRecord, RunRecord } from "./production-records.ts";

export const REVEAL_FILE_ROUTE = "/__file/reveal";
/** 只查不开（scripts/reveal-file-vite-plugin.mjs 的 LOCATE_FILE_ROUTE），一次最多 LOCATE_MAX_ITEMS 条。 */
export const LOCATE_FILE_ROUTE = "/__file/locate";
export const LOCATE_MAX_ITEMS = 500;
/** 和 scripts/reveal-file-vite-plugin.mjs 的 DEFAULT_COMFYUI_ROOT 同一个值；只在开发服务器还没有查路径接口时拿来拼路径。 */
export const DEFAULT_COMFYUI_ROOT = "C:\\ComfyUI_windows_portable\\ComfyUI";
export const OPEN_REVEAL_FILE_EVENT = "frameflow-open-reveal-file";
export const NO_LOCAL_PATH = "这个文件只存在画布里，没有本机路径";
export const EXPORT_HINT = "需要本机文件的话，点节点右上角的「下载媒体」另存一份。";

export type ComfyFileHint = { filename: string; subfolder?: string; type?: string };
export type RevealRequest = { path: string } | { files: ComfyFileHint[]; fileSize?: number };
export type RevealResult = { ok: true; path: string } | { ok: false; error: string };

/** 能右键打开文件夹的节点。h3-node 有镜头或继承视频才有文件。 */
export function isRevealableNode(shape: { type: string; props: object }) {
  const p = shape.props as { src?: string; shotId?: string; inheritedVideo?: { src?: string } };
  if (shape.type === "video-node" || shape.type === "image-node" || shape.type === "audio-node") return !!p.src;
  return shape.type === "h3-node" && !!(p.shotId || p.inheritedVideo?.src);
}

const ABSOLUTE = /^[A-Za-z]:[\\/]/;
const BROWSER_ONLY = /^(blob:|data:|https?:|media:|audio:|video:|image:|idb:|legacy-inline:)/i;

/** "video/Frameflow_Demix_x_00001.mp4" → {filename, subfolder:"video", type:"output"}；ComfyUI 的相对 output 路径。 */
export function comfyHintFromRelative(relative: string, type = "output"): ComfyFileHint | null {
  const parts = relative.replace(/\\/g, "/").split("/").filter(Boolean);
  const filename = parts.pop();
  if (!filename || parts.some((part) => part === "..")) return null;
  return { filename, subfolder: parts.join("/"), type };
}

/** 去配乐版：磁盘上的文件叫 Frameflow_Demix_…，画布里叫「xxx-去配乐.mp4」，要从 Run 记的 output 还原。 */
function demixOutput(run: RunRecord | null | undefined): string | undefined {
  const removal = run?.musicRemoval;
  if (!removal) return undefined;
  const passes = removal.passes ?? [];
  const last = passes[passes.length - 1];
  if (last?.outputFile?.filename) return [last.outputFile.subfolder, last.outputFile.filename].filter(Boolean).join("/");
  return removal.output ?? last?.output;
}

/**
 * 当前显示的那一版 → 请求体。返回 null 表示没有任何能在本机找的线索（只存在画布里）。
 * 顺序：节点上记的完整本机路径 → 去配乐版的 ComfyUI output → 素材文件名（服务器在 output / input 里按名找）。
 */
export function revealRequestFor(input: { asset?: AssetRecord | null; run?: RunRecord | null; name?: string; originalPath?: string; src?: string }): RevealRequest | null {
  const { asset, run } = input;
  for (const candidate of [input.originalPath, asset?.filename, input.name]) {
    if (candidate && ABSOLUTE.test(candidate.trim())) return { path: candidate.trim() };
  }
  const files: ComfyFileHint[] = [];
  const add = (hint: ComfyFileHint | null) => {
    if (!hint || !hint.filename || BROWSER_ONLY.test(hint.filename)) return;
    const key = `${hint.subfolder ?? "?"}/${hint.filename}`.toLowerCase();
    if (!files.some((file) => `${file.subfolder ?? "?"}/${file.filename}`.toLowerCase() === key)) files.push(hint);
  };
  const named = (value: string | undefined) => {
    if (!value) return;
    const v = value.trim();
    if (!v || BROWSER_ONLY.test(v)) return;
    if (/[\\/]/.test(v)) add(comfyHintFromRelative(v));
    else add({ filename: v });
  };
  if (asset?.derivationType === "music_removal") {
    const output = demixOutput(run);
    if (output) add(comfyHintFromRelative(output));
  }
  named(asset?.filename);
  if (!asset) { named(input.originalPath); named(input.name); }
  if (!files.length) return null;
  return asset?.fileSize ? { files, fileSize: asset.fileSize } : { files };
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;
const SAFE_PART = /^[^\\/:*?"<>|\x00-\x1f]+$/;

/**
 * 开发服务器没有查路径接口时（旧服务器、还没重启），不核实地拼一个最可能的路径：
 * - 节点记着的完整本机路径 → 原样用；
 * - ComfyUI 文件名 {filename, subfolder} → <ComfyUI>\output（或 input）\<subfolder>\<filename>；
 *   subfolder 没记时，视频按 Frameflow 的出片位置 output\video 拼，其他放 output 根目录；
 * - 其他（没有线索）→ null。
 */
export function guessLocalPath(request: RevealRequest | null): string | null {
  if (!request) return null;
  if ("path" in request) return ABSOLUTE.test(request.path.trim()) ? request.path.trim().replace(/\//g, "\\") : null;
  const file = request.files[0];
  if (!file || !SAFE_PART.test(file.filename) || file.filename === "." || file.filename === "..") return null;
  const type = file.type ?? "output";
  if (type !== "output" && type !== "input") return null;
  const subfolder = file.subfolder ?? (type === "output" && VIDEO_EXT.test(file.filename) ? "video" : "");
  const parts = subfolder.split(/[\\/]/).filter(Boolean);
  if (parts.some((part) => part === ".." || part === "." || !SAFE_PART.test(part))) return null;
  return [DEFAULT_COMFYUI_ROOT, type, ...parts, file.filename].join("\\");
}

export type LocateResult = { paths: (string | null)[]; verified: boolean };

/**
 * 一次查一批文件的本机路径（右键「复制视频清单」用）：只查不开，不会弹资源管理器。
 * requests 里的 null（没有线索）直接是 null，不发给服务器。返回的 paths 和 requests 一一对应。
 * 接口不在（404：开发服务器还没重启）或连不上时，退回 guessLocalPath 拼路径，verified=false。
 */
export async function locateLocalFiles(requests: readonly (RevealRequest | null)[], options: { fetch?: typeof fetch } = {}): Promise<LocateResult> {
  const call = options.fetch ?? fetch;
  const paths: (string | null)[] = requests.map(() => null);
  const wanted = requests.flatMap((request, index) => (request ? [{ request, index }] : []));
  try {
    for (let start = 0; start < wanted.length; start += LOCATE_MAX_ITEMS) {
      const chunk = wanted.slice(start, start + LOCATE_MAX_ITEMS);
      const response = await call(LOCATE_FILE_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: chunk.map((entry) => entry.request) }), cache: "no-store", signal: AbortSignal.timeout(60000) });
      let body: { ok?: unknown; paths?: unknown } = {};
      try { body = JSON.parse(await response.text()); } catch { /* not JSON */ }
      if (!response.ok || body.ok !== true || !Array.isArray(body.paths)) throw new Error(`locate ${response.status}`);
      const found = body.paths as unknown[];
      chunk.forEach((entry, i) => { const value = found[i]; paths[entry.index] = typeof value === "string" && value ? value : null; });
    }
    return { paths, verified: true };
  } catch {
    return { paths: requests.map(guessLocalPath), verified: false };
  }
}

/** 发请求。服务器出错时把它的中文原因带回来；导入的素材找不到时说「只存在画布里」。 */
export async function revealLocalFile(request: RevealRequest, options: { imported?: boolean; fetch?: typeof fetch } = {}): Promise<RevealResult> {
  const call = options.fetch ?? fetch;
  try {
    const response = await call(REVEAL_FILE_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), cache: "no-store", signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (response.ok && body.ok === true && typeof body.path === "string") return { ok: true, path: body.path };
    if (typeof body.error === "string") {
      if (response.status === 404 && options.imported) return { ok: false, error: `${NO_LOCAL_PATH}（导入时浏览器只拿到了文件内容，没拿到它原来的位置）。${EXPORT_HINT}` };
      return { ok: false, error: response.status === 404 ? `${body.error}\n${EXPORT_HINT}` : body.error };
    }
    if (response.status === 404) return { ok: false, error: "开发服务器还没有「打开所在文件夹」接口：请重启画布（关掉后双击桌面「AI视频创作无限画布」）" };
    return { ok: false, error: `打开所在文件夹失败（${response.status}）` };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error && cause.name === "TimeoutError" ? "找文件超时了，等一下再试" : "连不上开发服务器，打开所在文件夹用不了" };
  }
}
