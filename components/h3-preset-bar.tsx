"use client";

import { useEffect, useState } from "react";
import { Check, Plus, Trash2, X } from "lucide-react";
import { getMeta, putMeta } from "@/lib/production-records";
import { BUILTIN_PRESETS, deleteUserPreset, loadUserPresets, matchingPreset, presetFromNode, presetToNodeProps, saveUserPreset, stepsFor, USER_PRESETS_KEY, type H3Preset, type PresetStore } from "@/lib/h3-presets";
import { askConfirm } from "@/components/in-page-dialog";

const store: PresetStore = { load: () => getMeta<H3Preset[]>(USER_PRESETS_KEY), save: (presets) => putMeta(USER_PRESETS_KEY, presets) };
const CHANGED = "frameflow-presets-changed";
type NodeSettings = { mode?: string; megapixels?: number; turbo?: boolean; soundMode?: string; promptMode?: string };
const SOUND = { av: "视听", ambient: "环境声", silent: "静音" } as const;
export const presetSummary = (preset: H3Preset) => `${preset.mode === "ref2va" ? "多参考" : "首帧"} · ${preset.aspect === "follow" ? "跟随原图" : preset.aspect} · ${preset.megapixels.toFixed(2)}MP · ${preset.turbo ? "Turbo" : "Full"} ${stepsFor(preset.mode, preset.turbo)} 步 · ${preset.fps}FPS · ${SOUND[preset.soundMode]}${preset.mode === "ref2va" ? ` · ${preset.promptMode === "official_structured" ? "官方结构（实验）" : "普通 Prompt"}` : ""}`;

/** One fixed-height row, so the H3 node's automatic height is not disturbed. */
export function H3PresetBar({ node, isReference, onApply }: { node: NodeSettings; isReference: boolean; onApply: (props: ReturnType<typeof presetToNodeProps>) => void }) {
  const [userPresets, setUserPresets] = useState<H3Preset[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [readError, setReadError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => void loadUserPresets(store).then((items) => { if (active) { setUserPresets(items); setReadError(""); } }).catch((cause) => { if (active) setReadError(cause instanceof Error ? `预设读取失败：${cause.message}` : "预设读取失败，请稍后重试"); });
    refresh();
    window.addEventListener(CHANGED, refresh);
    return () => { active = false; window.removeEventListener(CHANGED, refresh); };
  }, []);
  const all = [...BUILTIN_PRESETS, ...userPresets];
  const current = matchingPreset(all, node, isReference);
  const nodeMode = isReference ? "ref2va" : "fl2va";
  const apply = (id: string) => {
    const preset = all.find((item) => item.id === id);
    if (!preset) return;
    onApply(presetToNodeProps(preset));
    setMessage(preset.mode !== nodeMode ? `已套用；该预设适用于${preset.mode === "ref2va" ? "多参考" : "首帧"}模式` : preset.verified === false ? "已套用（未真人验证的参数）" : "已套用");
  };
  const save = async () => {
    try {
      const preset = presetFromNode(name, node, isReference);
      setUserPresets(await saveUserPreset(store, preset));
      window.dispatchEvent(new Event(CHANGED));
      setNaming(false); setName(""); setMessage(`已保存“${preset.name}”`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "保存失败"); }
  };
  const remove = async (preset: H3Preset) => {
    if (!await askConfirm({ message: `删除预设“${preset.name}”？只删除预设，不影响任何节点。`, confirmLabel: "删除", danger: true })) return;
    try { setUserPresets(await deleteUserPreset(store, preset.id)); window.dispatchEvent(new Event(CHANGED)); setMessage("预设已删除"); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "删除失败"); }
  };

  return <div className="h3-preset-bar" title={current ? presetSummary(current) + (current.note ? `\n${current.note}` : "") : "当前参数不对应任何预设"}>
    <span className="h3-preset-label">预设</span>
    {naming ? <>
      <input autoFocus value={name} maxLength={24} placeholder="新预设名称" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void save(); if (event.key === "Escape") setNaming(false); }} />
      <button type="button" title="保存预设" aria-label="保存预设" onClick={() => void save()}><Check size={12} /></button>
      <button type="button" title="取消" aria-label="取消" onClick={() => setNaming(false)}><X size={12} /></button>
    </> : <>
      <select value={current?.id ?? ""} onChange={(event) => apply(event.target.value)}>
        <option value="">{current ? current.name : "自定义参数"}</option>
        <optgroup label="内置预设（冻结）">{BUILTIN_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}{preset.verified === false ? " · 未验证" : ""}{preset.mode !== nodeMode ? ` · ${preset.mode === "ref2va" ? "多参考" : "首帧"}` : ""}</option>)}</optgroup>
        {userPresets.length > 0 && <optgroup label="我的预设">{userPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}{preset.mode !== nodeMode ? ` · ${preset.mode === "ref2va" ? "多参考" : "首帧"}` : ""}</option>)}</optgroup>}
      </select>
      <button type="button" title="把当前参数另存为预设" aria-label="另存为预设" onClick={() => { setNaming(true); setMessage(""); }}><Plus size={12} /></button>
      {current && !current.builtIn && <button type="button" title="删除这个预设" aria-label="删除预设" onClick={() => void remove(current)}><Trash2 size={12} /></button>}
    </>}
    {readError ? <em role="alert" title={readError}>{readError}</em> : message ? <em title={message}>{message}</em> : current?.builtIn && current.verified === false ? <em className="unverified">未验证</em> : null}
  </div>;
}
