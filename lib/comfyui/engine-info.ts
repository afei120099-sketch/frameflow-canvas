/**
 * What actually ran a Run: ComfyUI / Python / PyTorch versions and, for every H3-related node class
 * the workflow uses, which module provides it. Core nodes carry the ComfyUI version; a custom node
 * pack is identified by its folder, with a version only when ComfyUI-Manager reports one (packs
 * installed by hand have none). Unknown values stay null — never guessed. Read-only GET requests.
 */

export interface EngineNodeInfo {
  classType: string;
  /** e.g. "comfy_extras.nodes_minimax_h3" or "custom_nodes.ComfyUI-MiniMax-H3-Turbo-main"; null when the node is missing. */
  module: string | null;
  /** "ComfyUI core" or the custom-node folder name. */
  pack: string | null;
  version: string | null;
}

export interface EngineInfo {
  comfyuiVersion: string | null;
  pythonVersion: string | null;
  pytorchVersion: string | null;
  /** comfy-kitchen, frontend, templates…: exactly as /system_stats lists them. */
  packages: { name: string; version: string }[];
  nodes: EngineNodeInfo[];
  checkedAt: number;
  /** Set when some information could not be read; the Run still records what was known. */
  note?: string;
}

type SystemStats = { system?: { comfyui_version?: string; python_version?: string; pytorch_version?: string; comfy_package_versions?: { name: string; installed?: string }[] } };
type ObjectInfo = Record<string, { python_module?: string } | undefined>;
type ManagerList = Record<string, { ver?: string; version?: string; cnr_id?: string; aux_id?: string } | undefined>;

const CORE_MODULE = /^(comfy_extras\.|comfy_api_nodes\.|nodes$)/;

export function packForModule(module: string | null | undefined): string | null {
  if (!module) return null;
  if (CORE_MODULE.test(module)) return "ComfyUI core";
  const match = /^custom_nodes\.([^.]+)/.exec(module);
  return match ? match[1] : module;
}

function managerVersion(pack: string, list: ManagerList | null) {
  if (!list) return null;
  const wanted = pack.toLowerCase();
  for (const [key, value] of Object.entries(list)) {
    const names = [key, value?.cnr_id, value?.aux_id?.split("/").pop()].filter(Boolean).map((name) => String(name).toLowerCase());
    if (names.includes(wanted)) return value?.ver ?? value?.version ?? null;
  }
  return null;
}

/** Pure assembly from already-fetched responses (tested without a server). */
export function buildEngineInfo(stats: SystemStats | null, objectInfo: ObjectInfo, classTypes: readonly string[], manager: ManagerList | null, checkedAt = Date.now()): EngineInfo {
  const system = stats?.system;
  const comfyuiVersion = system?.comfyui_version ?? null;
  const nodes = [...new Set(classTypes)].map((classType) => {
    const pythonModule = objectInfo[classType]?.python_module ?? null;
    const pack = packForModule(pythonModule);
    return { classType, module: pythonModule, pack, version: pack === "ComfyUI core" ? comfyuiVersion : pack ? managerVersion(pack, manager) : null };
  });
  const missing = nodes.filter((node) => !node.module).map((node) => node.classType);
  return {
    comfyuiVersion,
    pythonVersion: system?.python_version?.split(" ")[0] ?? null,
    pytorchVersion: system?.pytorch_version ?? null,
    packages: (system?.comfy_package_versions ?? []).filter((item) => item.installed).map((item) => ({ name: item.name, version: item.installed! })),
    nodes,
    checkedAt,
    ...(stats ? {} : { note: "无法读取 ComfyUI 版本" }),
    ...(missing.length ? { note: `ComfyUI 未找到节点：${missing.join("、")}` } : {}),
  };
}

/** Fetch with any GET-JSON function (the adapter passes its proxied fetch). Failures degrade to nulls. */
export async function describeEngine(getJson: (path: string) => Promise<unknown>, classTypes: readonly string[]): Promise<EngineInfo> {
  const safe = <T>(path: string) => getJson(path).then((value) => value as T).catch(() => null);
  const [stats, manager, ...infos] = await Promise.all([
    safe<SystemStats>("/system_stats"),
    safe<ManagerList>("/v2/customnode/installed"),
    ...[...new Set(classTypes)].map((classType) => safe<ObjectInfo>(`/object_info/${encodeURIComponent(classType)}`)),
  ]);
  const objectInfo: ObjectInfo = Object.assign({}, ...infos.filter(Boolean) as ObjectInfo[]);
  return buildEngineInfo(stats as SystemStats | null, objectInfo, classTypes, manager as ManagerList | null);
}

/** H3-relevant node classes of a workflow (model / conditioning / LoRA / sampler), in first-use order. */
export function h3EngineClassTypes(workflow: Record<string, { class_type: string }>) {
  const relevant = /MiniMax|UNETLoader|CLIPLoader|Lora|Sampler|VAELoader/;
  return [...new Set(Object.values(workflow).map((node) => node.class_type).filter((type) => relevant.test(type)))];
}
