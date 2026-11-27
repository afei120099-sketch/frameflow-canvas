import { H3_ASPECTS, H3_FPS, H3_MAX_MEGAPIXELS, H3_MEGAPIXELS, H3_MIN_MEGAPIXELS, H3_NON_TURBO_STEPS, H3_STEPS } from "./comfyui/h3-parameters.ts";
import type { H3PromptMode } from "./h3-prompt-compiler.ts";

/**
 * Phase 13: H3 presets. A preset only organises parameters the H3 node already has; it cannot
 * widen any frozen range. Steps and FPS are not free values: steps follow Turbo exactly like the
 * node does (FL2VA 6 / 20, Ref2VA 4 / 20) and FPS is always 24.
 * Built-in presets are read-only; user presets are stored under meta key "h3Presets".
 */

export type PresetMode = "fl2va" | "ref2va";
export type SoundMode = "av" | "ambient" | "silent";
export type PresetAspect = (typeof H3_ASPECTS)[number];
export interface H3Preset {
  id: string; name: string; mode: PresetMode; builtIn: boolean; note?: string; verified?: boolean;
  promptMode: H3PromptMode; aspect: PresetAspect; megapixels: number; turbo: boolean; fps: number; soundMode: SoundMode;
}
export const USER_PRESETS_KEY = "h3Presets";

export const stepsFor = (mode: PresetMode, turbo: boolean) => mode === "ref2va" ? (turbo ? 4 : 20) : (turbo ? H3_STEPS : H3_NON_TURBO_STEPS);

export const BUILTIN_PRESETS: readonly H3Preset[] = Object.freeze([
  { id: "builtin:fast", name: "快速测试", mode: "fl2va", builtIn: true, verified: true, note: "0.50MP · Turbo 6 步 · 本机已验证基线", promptMode: "plain", aspect: "follow", megapixels: H3_MEGAPIXELS, turbo: true, fps: H3_FPS, soundMode: "av" },
  { id: "builtin:quality", name: "高质量", mode: "fl2va", builtIn: true, verified: false, note: "≈1.00MP · 20 步 · 候选档，尚未真人验证", promptMode: "plain", aspect: "follow", megapixels: 1, turbo: false, fps: H3_FPS, soundMode: "av" },
  { id: "builtin:dialogue", name: "角色对话", mode: "ref2va", builtIn: true, verified: true, note: "多参考 · 16:9 · Turbo 4 步 · 普通 Prompt（官方结构仍为实验，需手动开启）", promptMode: "plain", aspect: "16:9", megapixels: H3_MEGAPIXELS, turbo: true, fps: H3_FPS, soundMode: "av" },
  { id: "builtin:silent", name: "静音镜头", mode: "fl2va", builtIn: true, verified: true, note: "0.50MP · Turbo · 输出无音轨", promptMode: "plain", aspect: "follow", megapixels: H3_MEGAPIXELS, turbo: true, fps: H3_FPS, soundMode: "silent" },
  { id: "builtin:ambient", name: "环境声镜头", mode: "fl2va", builtIn: true, verified: true, note: "0.50MP · Turbo · 只保留环境声与动作声", promptMode: "plain", aspect: "follow", megapixels: H3_MEGAPIXELS, turbo: true, fps: H3_FPS, soundMode: "ambient" },
].map((preset) => Object.freeze(preset as H3Preset)));

/** Same limits the H3 node and frozen workflows enforce; out-of-range values are rejected, never clamped. */
export function validatePreset(preset: Omit<H3Preset, "id" | "builtIn">) {
  const name = preset.name.trim();
  if (!name) throw new Error("请填写预设名称");
  if (name.length > 24) throw new Error("预设名称最多 24 个字");
  if (preset.mode !== "fl2va" && preset.mode !== "ref2va") throw new Error("未知的适用模式");
  if (!(H3_ASPECTS as readonly string[]).includes(preset.aspect)) throw new Error("画面比例不受支持");
  if (preset.mode === "ref2va" && preset.aspect === "follow") throw new Error("多参考预设必须选择明确的画面比例");
  if (!Number.isFinite(preset.megapixels) || preset.megapixels < H3_MIN_MEGAPIXELS || preset.megapixels > H3_MAX_MEGAPIXELS) throw new Error(`像素预算必须在 ${H3_MIN_MEGAPIXELS.toFixed(2)}–${H3_MAX_MEGAPIXELS.toFixed(2)} MP 之间`);
  if (preset.fps !== H3_FPS) throw new Error(`FPS 固定为 ${H3_FPS}`);
  if (!["av", "ambient", "silent"].includes(preset.soundMode)) throw new Error("声音模式不受支持");
  if (preset.promptMode !== "plain" && preset.promptMode !== "official_structured") throw new Error("Prompt 模式不受支持");
  if (preset.mode === "fl2va" && preset.promptMode !== "plain") throw new Error("首帧模式只有普通 Prompt");
  return { ...preset, name, megapixels: Number(preset.megapixels.toFixed(2)) };
}

/** Node props a preset sets. Prompt mode only matters in reference mode, so FL2VA presets leave it alone. */
export function presetToNodeProps(preset: H3Preset) {
  return { mode: preset.aspect, megapixels: preset.megapixels, turbo: preset.turbo, steps: preset.turbo ? H3_STEPS : H3_NON_TURBO_STEPS, fps: H3_FPS, soundMode: preset.soundMode, ...(preset.mode === "ref2va" ? { promptMode: preset.promptMode } : {}) };
}

export function presetFromNode(name: string, node: { mode?: string; megapixels?: number; turbo?: boolean; soundMode?: string; promptMode?: string }, isReference: boolean, id = `user:${Date.now().toString(36)}`): H3Preset {
  const mode: PresetMode = isReference ? "ref2va" : "fl2va";
  const valid = validatePreset({ name, mode, promptMode: isReference && node.promptMode === "official_structured" ? "official_structured" : "plain", aspect: ((H3_ASPECTS as readonly string[]).includes(node.mode ?? "") ? node.mode : "follow") as PresetAspect, megapixels: Number(node.megapixels ?? H3_MEGAPIXELS), turbo: node.turbo ?? true, fps: H3_FPS, soundMode: (["av", "ambient", "silent"].includes(node.soundMode ?? "") ? node.soundMode : "av") as SoundMode, note: undefined, verified: false });
  return { ...valid, id, builtIn: false };
}

/** Which preset (if any) the node currently matches exactly, for the selector. */
export function matchingPreset(presets: readonly H3Preset[], node: { mode?: string; megapixels?: number; turbo?: boolean; soundMode?: string; promptMode?: string }, isReference: boolean) {
  const mode: PresetMode = isReference ? "ref2va" : "fl2va";
  return presets.find((preset) => preset.mode === mode && preset.aspect === (node.mode ?? "follow") && preset.megapixels === Number(node.megapixels ?? H3_MEGAPIXELS) && preset.turbo === (node.turbo ?? true) && preset.soundMode === (node.soundMode ?? "av") && (mode === "fl2va" || preset.promptMode === (node.promptMode === "official_structured" ? "official_structured" : "plain"))) ?? null;
}

export interface PresetStore { load: () => Promise<H3Preset[] | null>; save: (presets: H3Preset[]) => Promise<void> }
export async function loadUserPresets(store: PresetStore) {
  const stored = await store.load();
  return (Array.isArray(stored) ? stored : []).filter((preset) => { try { validatePreset(preset); return !preset.builtIn && preset.id?.startsWith("user:"); } catch { return false; } });
}
export async function saveUserPreset(store: PresetStore, preset: H3Preset) {
  if (preset.builtIn) throw new Error("内置预设不能修改");
  const current = await loadUserPresets(store);
  if ([...BUILTIN_PRESETS, ...current].some((item) => item.name === preset.name.trim() && item.id !== preset.id)) throw new Error(`已存在名为“${preset.name.trim()}”的预设`);
  const next = [...current.filter((item) => item.id !== preset.id), { ...validatePreset(preset), id: preset.id, builtIn: false }];
  await store.save(next);
  return next;
}
export async function deleteUserPreset(store: PresetStore, id: string) {
  if (BUILTIN_PRESETS.some((preset) => preset.id === id)) throw new Error("内置预设不能删除");
  const next = (await loadUserPresets(store)).filter((preset) => preset.id !== id);
  await store.save(next);
  return next;
}
