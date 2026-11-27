"use client";
// Director Stage (导演台) V0.1: Scene / Prop / State / Camera / Control Package management with basic
// create, rename and delete. Reuses the existing dialog and Role-library styles (generation-info-*,
// role-*), so no CSS changes. All record rules live in lib/director-stage/store.ts (Scene binding,
// in-use refusal, cascade). Assets are only read (listAssets) and referenced by ID; nothing here
// writes Asset / Run / Shot records or touches H3, ComfyUI or the GPU.
import { useCallback, useEffect, useRef, useState } from "react";
import { CanvasPanelBoundary } from "@/components/canvas-error-boundary";
import { createPortal } from "react-dom";
import { ArrowLeft, Box, ImageIcon, Link2, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { DIRECTOR_STAGE_MODULE } from "@/lib/director-stage";
import { ANCHOR_FRAME_RANGE, CONTROL_PACKAGE_ASSET_RULES, CONTROL_PACKAGE_TYPES, controlPackageAssetProblem, MOTION_FRAME_RANGE, MOTION_NOTE, type Camera, type ControlPackage, type ControlPackageType, type Motion, type MotionKeyframe, type MotionTargetType, type Prop, type Scene, type SceneState } from "@/lib/director-stage/schema";
import {
  createCamera, createControlPackage, createMotion, createProp, createScene, createSceneState, deleteCamera, deleteControlPackage, deleteMotion, deleteProp, deleteScene, deleteSceneState,
  listCameras, listControlPackages, listMotions, listProps, listScenes, listSceneStates, updateCamera, updateControlPackage, updateMotion, updateProp, updateScene, updateSceneState,
} from "@/lib/director-stage/store";
import { planH3Handoff, shotHandoffRequest, type H3HandoffPlan, type HandoffAsset } from "@/lib/director-stage/h3-handoff";
import { WhiteboxStage } from "./whitebox-stage";
import { DirectorStageJsonTools } from "./director-stage-json-tools";
import { generateDepthFirstFrame } from "@/lib/director-stage/depth-firstframe";
import { generateMotionRealisticAnchors } from "@/lib/director-stage/motion-realistic-anchors";
import { getActualDuration, H3_MAX_REQUESTED_SECONDS, H3_MIN_LENGTH, H3_FPS } from "@/lib/comfyui/h3-parameters";
import { SDXL_DEPTH_DEFAULT_SUBJECT, SDXL_DEPTH_FIRSTFRAME } from "@/lib/comfyui/sdxl-depth-firstframe";
import { blenderStatus, generateWhiteboxControls, generateWhiteboxFirstFrame, placedCameras, WHITEBOX_FIRST_FRAME_LONG_SIDE, type ImportedImageAsset, type WhiteboxControlPass } from "@/lib/director-stage/whitebox-firstframe";
import { H3_ADDGUIDE_NOTE } from "@/lib/comfyui/experimental/h3-addguide";
import { createShot, getShotCandidates, listAssets, listShots, updateShotDirector, type AssetRecord, type ShotDirectorBinding, type ShotRecord } from "@/lib/production-records";
import { askConfirm } from "@/components/in-page-dialog";

type SceneSummary = { scene: Scene; props: Prop[]; states: SceneState[]; cameras: Camera[]; packages: ControlPackage[]; motions: Motion[] };

async function loadSummaries(): Promise<SceneSummary[]> {
  const scenes = await listScenes();
  return Promise.all(scenes.map(async (scene) => ({ scene, props: await listProps(scene.id), states: await listSceneStates(scene.id), cameras: await listCameras(scene.id), packages: await listControlPackages(scene.id), motions: await listMotions(scene.id) })));
}

/** Matches `.role-detail input` (a <select> has no rule there; inline keeps globals.css untouched). */
const SELECT_STYLE: React.CSSProperties = { flex: "none", width: 132, padding: "9px 8px", border: "1px solid var(--ff-border-strong)", borderRadius: 7, color: "var(--ff-text)", background: "var(--ff-surface)", font: "inherit" };
/** Width 0 + flex 1: shares the row instead of growing to its longest option (a long Asset filename widened the whole panel). */
const WIDE_SELECT_STYLE: React.CSSProperties = { ...SELECT_STYLE, flex: "1 1 0", width: 0, minWidth: 0 };
const NESTED: React.CSSProperties = { marginLeft: 18 };
const KIND_LABEL: Record<string, string> = { image: "图片", video: "视频", audio: "声音" };
const MODE_LABEL: Record<H3HandoffPlan["expectedMode"], string> = { i2va: "首帧图生视频（I2VA）", fl2va: "首尾帧生成（FL2VA）", ref2va: "多参考生成（Ref2VA）", i2va_guide: "🧪 首帧 + 引导锚点（I2VA + AddGuide 实验）" };
const parseAnchor = (text: string) => { const value = Number(text); return Number.isInteger(value) && value >= ANCHOR_FRAME_RANGE.min && value <= ANCHOR_FRAME_RANGE.max ? value : null; };
const ANCHOR_HINT = `锚点帧 ${ANCHOR_FRAME_RANGE.min}–${ANCHOR_FRAME_RANGE.max}（24 帧 = 1 秒，须小于视频总帧数）`;
/** Other packages keep creation order; 🧪 guide packages follow, sorted by anchor frame (unset last). */
const sortedPackages = (packages: ControlPackage[]) => [...packages.filter((pack) => pack.type !== "guide"), ...packages.filter((pack) => pack.type === "guide").sort((a, b) => (a.anchorFrame ?? Infinity) - (b.anchorFrame ?? Infinity))];

/** Creates the H3 node on the canvas; provided by the canvas, absent when no editor is mounted. */
export type SendToH3 = (plan: H3HandoffPlan) => Promise<void>;
/** Registers a PNG as an image Asset (the canvas' Asset Library import); used by 一键白模首帧. */
export type ImportImage = (file: File) => Promise<ImportedImageAsset>;

/** Header entry: owns its open state so the canvas only renders <DirectorStageEntry />. */
/** Shot System V0.1: creates (or locates) the H3 node of a 导演台 Shot; provided by the canvas. */
export type SendShotToH3 = (shotId: string, plan: H3HandoffPlan) => Promise<"created" | "located">;

export function DirectorStageEntry({ onSendToH3, onImportImage, onSendShotToH3 }: { onSendToH3?: SendToH3; onImportImage?: ImportImage; onSendShotToH3?: SendShotToH3 }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="role-entry" title="导演台：场景 / 道具 / 状态 / 摄影机 / 控制素材" aria-pressed={open} onClick={() => setOpen(true)}><Box size={14} />导演台</button>
    {open && <CanvasPanelBoundary name="导演台" onClose={() => setOpen(false)}><DirectorStagePanel onClose={() => setOpen(false)} onSendToH3={onSendToH3} onImportImage={onImportImage} onSendShotToH3={onSendShotToH3} /></CanvasPanelBoundary>}
  </>;
}

/** A row name that turns into an input: Enter / blur saves, Esc cancels. */
function EditableName({ value, label, onSave }: { value: string; label: string; onSave: (name: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) return <><span className="role-asset-name" title={value}>{value}</span><button type="button" title={`重命名${label}`} aria-label={`重命名${label}“${value}”`} onClick={() => setDraft(value)}><Pencil size={13} /></button></>;
  const commit = () => { const name = draft.trim(); setDraft(null); if (name && name !== value) void onSave(name); };
  return <input autoFocus aria-label={`${label}名称`} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setDraft(null); }} />;
}

/** A free-text note line (may be empty): same Enter / blur / Esc behaviour as EditableName. */
function EditableNote({ value, label, onSave }: { value: string; label: string; onSave: (note: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) return <div className="role-asset-row" style={NESTED}><span className="role-asset-name role-hint" title={value}>备注：{value || "（无）"}</span><button type="button" title={`编辑${label}备注`} aria-label={`编辑${label}备注`} onClick={() => setDraft(value)}><Pencil size={13} /></button></div>;
  const commit = () => { const note = draft.trim(); setDraft(null); if (note !== value) void onSave(note); };
  return <div className="role-asset-row" style={NESTED}><input autoFocus aria-label={`${label}备注`} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setDraft(null); }} /></div>;
}

/** 🧪 guide anchor frame of one package: Enter / blur saves a valid frame, Esc cancels. */
const parseMotionFrame = (text: string) => { if (!text.trim()) return null; const value = Number(text); return Number.isInteger(value) && value >= MOTION_FRAME_RANGE.min && value <= MOTION_FRAME_RANGE.max ? value : null; };
const MOTION_FRAME_HINT = `关键帧号必须是 ${MOTION_FRAME_RANGE.min}–${MOTION_FRAME_RANGE.max} 的整数（24 帧 = 1 秒）`;
const frameLabel = (frame: number) => `f${frame}（约 ${(frame / 24).toFixed(1)} 秒）`;

/** One Motion keyframe row: shows frame + description, ✎ edits both inline (Enter / blur saves, Esc cancels), × removes. */
function KeyframeRow({ keyframe, motionName, disabled, onSave, onRemove, onInvalid }: { keyframe: MotionKeyframe; motionName: string; disabled: boolean; onSave: (next: MotionKeyframe) => void; onRemove: () => void; onInvalid: (message: string) => void }) {
  const [draft, setDraft] = useState<{ frame: string; description: string } | null>(null);
  if (draft === null) return <div className="role-asset-row" style={NESTED}>
    <span className="role-asset-name" title={keyframe.transform ? `${keyframe.description}（带白模位置，可在白模导演台里播放 / 编辑）` : keyframe.description}>{keyframe.transform ? "📍 " : ""}{frameLabel(keyframe.frame)} · {keyframe.description || "（无描述）"}</span>
    <button type="button" title="修改关键帧" aria-label={`修改“${motionName}”的关键帧 f${keyframe.frame}`} disabled={disabled} onClick={() => setDraft({ frame: String(keyframe.frame), description: keyframe.description })}><Pencil size={13} /></button>
    <button type="button" title="删除关键帧" aria-label={`删除“${motionName}”的关键帧 f${keyframe.frame}`} disabled={disabled} onClick={onRemove}><X size={13} /></button>
  </div>;
  const commit = () => { const frame = parseMotionFrame(draft.frame); if (frame === null) { onInvalid(MOTION_FRAME_HINT); setDraft(null); return; } const next = { frame, description: draft.description.trim() }; setDraft(null); if (next.frame !== keyframe.frame || next.description !== keyframe.description) onSave(next); };
  const keys = (event: React.KeyboardEvent<HTMLInputElement>) => { if (event.key === "Enter") commit(); if (event.key === "Escape") setDraft(null); };
  return <div className="role-create" style={NESTED} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(); }}>
    <input autoFocus type="number" aria-label={`“${motionName}”关键帧帧号`} min={MOTION_FRAME_RANGE.min} max={MOTION_FRAME_RANGE.max} style={{ flex: "none", width: 92 }} value={draft.frame} onChange={(event) => setDraft({ ...draft, frame: event.target.value })} onKeyDown={keys} />
    <input aria-label={`“${motionName}”关键帧描述`} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} onKeyDown={keys} />
  </div>;
}

function EditableAnchor({ value, label, onSave, onInvalid }: { value: number | undefined; label: string; onSave: (anchorFrame: number) => Promise<void>; onInvalid: (message: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) return <div className="role-asset-row" style={NESTED}><span className="role-asset-name role-hint">🧪 锚点帧：{value !== undefined ? `f${value}（约 ${(value / 24).toFixed(1)} 秒）` : "未设置"}</span><button type="button" title="编辑锚点帧" aria-label={`编辑“${label}”的锚点帧`} onClick={() => setDraft(value !== undefined ? String(value) : "")}><Pencil size={13} /></button></div>;
  const commit = () => { const text = draft.trim(); setDraft(null); if (!text) return; const anchor = parseAnchor(text); if (anchor === null) { onInvalid(ANCHOR_HINT); return; } if (anchor !== value) void onSave(anchor); };
  return <div className="role-asset-row" style={NESTED}><input autoFocus type="number" aria-label={`“${label}”的锚点帧`} min={ANCHOR_FRAME_RANGE.min} max={ANCHOR_FRAME_RANGE.max} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setDraft(null); }} /></div>;
}

const usableAssets = (rows: AssetRecord[]) => rows.filter((asset) => !asset.storageReference.startsWith("legacy-inline:"));
const FIRST_FRAME_SIZE = `${WHITEBOX_FIRST_FRAME_LONG_SIDE * 9 / 16}×${WHITEBOX_FIRST_FRAME_LONG_SIDE} 或 ${WHITEBOX_FIRST_FRAME_LONG_SIDE}×${WHITEBOX_FIRST_FRAME_LONG_SIDE * 9 / 16}`;

/** Shot System V0.1 form: the binding being created / edited (IDs; "" = none). */
type ShotForm = { editingId: string | null; title: string; cameraId: string; stateId: string; motionIds: string[]; firstId: string; lastId: string; referenceId: string; guideIds: string[] };
const EMPTY_SHOT_FORM: ShotForm = { editingId: null, title: "", cameraId: "", stateId: "", motionIds: [], firstId: "", lastId: "", referenceId: "", guideIds: [] };
const SHOT_STATUS: Record<ShotRecord["status"], string> = { draft: "草稿", has_candidates: "有候选", adopted: "已采用" };
const shotLabel = (shot: ShotRecord) => { const number = `镜头 ${String(shot.shotNumber).padStart(2, "0")}`; return shot.title === number ? number : `${number} · ${shot.title}`; };
const toggle = (list: string[], id: string, on: boolean) => on ? [...list.filter((item) => item !== id), id] : list.filter((item) => item !== id);

export function DirectorStagePanel({ onClose, onSendToH3, onImportImage, onSendShotToH3 }: { onClose: () => void; onSendToH3?: SendToH3; onImportImage?: ImportImage; onSendShotToH3?: SendShotToH3 }) {
  const [summaries, setSummaries] = useState<SceneSummary[] | null>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [sceneName, setSceneName] = useState("");
  const [sceneNameDraft, setSceneNameDraft] = useState("");
  const [propForm, setPropForm] = useState({ name: "", type: "" });
  const [stateForm, setStateForm] = useState({ name: "", propId: "", description: "" });
  const [cameraForm, setCameraForm] = useState({ name: "", note: "" });
  const [packageForm, setPackageForm] = useState<{ name: string; type: ControlPackageType; assetId: string; anchorFrame: string }>({ name: "", type: "first_frame", assetId: "", anchorFrame: "70" });
  const [bindDraft, setBindDraft] = useState<Record<string, string>>({});
  const [motionForm, setMotionForm] = useState({ name: "", target: "" });
  /** 3D white-box stage of the open Scene (three.js loads only when it opens). */
  const [whiteboxOpen, setWhiteboxOpen] = useState(false);
  const whiteboxOpenRef = useRef(false);
  useEffect(() => { whiteboxOpenRef.current = whiteboxOpen; }, [whiteboxOpen]);
  /** JSON 导入 / 导出对话框打开时，Esc 只关对话框。 */
  const jsonOverlayRef = useRef(false);
  const setJsonOverlay = useCallback((open: boolean) => { jsonOverlayRef.current = open; }, []);
  const [keyframeDraft, setKeyframeDraft] = useState<Record<string, { frame: string; description: string }>>({});
  const [sendForm, setSendForm] = useState<{ firstId: string; lastId: string; referenceId: string; stateId: string; guideIds: string[] }>({ firstId: "", lastId: "", referenceId: "", stateId: "", guideIds: [] });
  /** 一键白模首帧: chosen camera, local Blender availability, the last result (its preview URL is revoked when replaced / on close). */
  const [frameCameraId, setFrameCameraId] = useState("");
  const [frameBusy, setFrameBusy] = useState(false);
  const [blender, setBlender] = useState<{ available: boolean; build: string | null; reachable: boolean } | null>(null);
  const [framePreview, setFramePreview] = useState<{ url: string; filename: string; packageName: string; size: string; seconds: number } | null>(null);
  /** Shot System V0.1: 导演台 Shots (the same Shot records as the canvas / 镜头板) and their candidate counts. */
  const [shots, setShots] = useState<ShotRecord[]>([]);
  const [candidateCounts, setCandidateCounts] = useState<Record<string, number>>({});
  const [shotForm, setShotForm] = useState<ShotForm>(EMPTY_SHOT_FORM);
  const loadShots = useCallback(async () => {
    const rows = (await listShots()).filter((shot) => shot.director).sort((a, b) => a.shotNumber - b.shotNumber);
    const counts = Object.fromEntries(await Promise.all(rows.map(async (shot) => [shot.shotId, (await getShotCandidates(shot.shotId)).length] as const)));
    return { rows, counts };
  }, []);
  const reloadShots = useCallback(async () => { const { rows, counts } = await loadShots(); setShots(rows); setCandidateCounts(counts); }, [loadShots]);
  useEffect(() => () => { if (framePreview) URL.revokeObjectURL(framePreview.url); }, [framePreview]);
  /** 高级控制素材 V0.1: previews of the last rgb / depth / mask / object-id batch (revoked when replaced / on close). */
  const [controlsPreview, setControlsPreview] = useState<{ items: { pass: WhiteboxControlPass; url: string; filename: string }[]; summary: string } | null>(null);
  useEffect(() => () => { controlsPreview?.items.forEach((item) => URL.revokeObjectURL(item.url)); }, [controlsPreview]);
  /** Depth 写实首帧 V0.1: description, live stage text, last result previews (revoked when replaced / on close). */
  const [realisticPrompt, setRealisticPrompt] = useState("");
  const [anchorMotionId, setAnchorMotionId] = useState("");
  const [anchorFrames, setAnchorFrames] = useState<number[]>([]);
  const [anchorSeconds, setAnchorSeconds] = useState("5.9");
  const [anchorPrompt, setAnchorPrompt] = useState("");
  const [anchorPreviews, setAnchorPreviews] = useState<{ frame: number; url: string }[]>([]);
  const anchorUrls = useRef<string[]>([]);
  useEffect(() => () => { anchorUrls.current.forEach((url) => URL.revokeObjectURL(url)); }, []);
  const [realisticStage, setRealisticStage] = useState("");
  const [realisticPreview, setRealisticPreview] = useState<{ depthUrl: string; imageUrl: string; filename: string; packageName: string; summary: string } | null>(null);
  useEffect(() => () => { if (realisticPreview) { URL.revokeObjectURL(realisticPreview.depthUrl); URL.revokeObjectURL(realisticPreview.imageUrl); } }, [realisticPreview]);

  const reload = useCallback(async () => { setSummaries(await loadSummaries()); }, []);
  useEffect(() => {
    let alive = true;
    loadSummaries().then((rows) => { if (alive) setSummaries(rows); }, (cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    // Read-only: existing Assets to reference. Legacy inline media has no Blob and is not offered.
    listAssets().then((rows) => { if (alive) setAssets(usableAssets(rows)); }, (cause) => { if (alive) setError(`素材读取失败：${cause instanceof Error ? cause.message : String(cause)}`); });
    if (onImportImage) void blenderStatus().then((status) => { if (alive) setBlender(status); });
    loadShots().then(({ rows, counts }) => { if (alive) { setShots(rows); setCandidateCounts(counts); } }, (cause) => { if (alive) setError(`镜头读取失败：${cause instanceof Error ? cause.message : String(cause)}`); });
    return () => { alive = false; };
  }, [onImportImage, loadShots]);
  useEffect(() => {
    // Esc inside a text field cancels that edit instead of closing the panel.
    // Esc inside the 3D stage closes only the stage (it has its own handler).
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !whiteboxOpenRef.current && !jsonOverlayRef.current && !(event.target instanceof HTMLElement && event.target.closest("input, select, textarea"))) onClose(); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /** Every write: one at a time, then re-read from the store; store errors are shown, never swallowed. */
  const run = async (action: () => Promise<unknown>, done: string) => {
    setWorking(true); setError(""); setNotice("");
    try { await action(); await reload(); setNotice(done); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await reload().catch(() => undefined); return false; }
    finally { setWorking(false); }
  };
  const refuse = (message: string) => { setNotice(""); setError(message); };

  const selected = summaries?.find((item) => item.scene.id === selectedId) ?? null;
  const propName = (propId: string) => selected?.props.find((prop) => prop.id === propId)?.name ?? "（道具已不存在）";
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset]));
  const assetsFor = (type: ControlPackageType) => assets.filter((asset) => (CONTROL_PACKAGE_ASSET_RULES[type].kinds as readonly string[]).includes(asset.kind));
  const assetLabel = (asset: AssetRecord) => `${asset.filename}（${KIND_LABEL[asset.kind] ?? asset.kind}）`;
  const assetProblem = (type: ControlPackageType, assetIds: string[]) => controlPackageAssetProblem(type, assetIds.map((assetId) => ({ assetId, kind: assetById.get(assetId)?.kind ?? null })));
  const openScene = (scene: Scene) => {
    setAnchorMotionId(""); setAnchorFrames([]); setAnchorPreviews([]);
    anchorUrls.current.forEach((url) => URL.revokeObjectURL(url)); anchorUrls.current = [];
    setSelectedId(scene.id); setSceneNameDraft(scene.name); setError(""); setNotice("");
    setPropForm({ name: "", type: "" }); setStateForm({ name: "", propId: "", description: "" }); setCameraForm({ name: "", note: "" }); setPackageForm({ name: "", type: "first_frame", assetId: "", anchorFrame: "70" }); setBindDraft({}); setSendForm({ firstId: "", lastId: "", referenceId: "", stateId: "", guideIds: [] }); setMotionForm({ name: "", target: "" }); setKeyframeDraft({}); setFrameCameraId(""); setFramePreview(null); setControlsPreview(null); setRealisticPreview(null); setRealisticStage(""); setShotForm(EMPTY_SHOT_FORM);
  };
  const enter = (action: () => void) => (event: React.KeyboardEvent) => { if (event.key === "Enter") action(); };

  /* Scene */
  const addScene = async () => { const name = sceneName.trim(); if (name && await run(() => createScene({ name }), `已新建场景“${name}”`)) setSceneName(""); };
  const saveSceneName = () => { const name = sceneNameDraft.trim(); if (!selected) return; if (!name) { setSceneNameDraft(selected.scene.name); return; } if (name !== selected.scene.name) void run(() => updateScene(selected.scene.id, { name }), "场景名称已保存"); };
  const removeScene = async () => {
    if (!selected) return;
    const { scene, props, states, cameras, packages, motions } = selected;
    const children = props.length + states.length + cameras.length + packages.length + motions.length;
    // Children are listed before deleting; Motions go with the Scene too, Assets never do.
    const message = children ? `删除场景“${scene.name}”？\n将同时删除其中的 ${props.length} 个道具、${states.length} 个状态、${cameras.length} 个摄影机、${packages.length} 个控制素材包和 ${motions.length} 个动作。\n素材（Asset）不会被删除。` : `删除场景“${scene.name}”？素材（Asset）不会被删除。`;
    if (!await askConfirm({ message, confirmLabel: "删除", danger: true })) return;
    void run(() => deleteScene(scene.id), `已删除场景“${scene.name}”`).then((ok) => { if (ok) setSelectedId(""); });
  };

  /* Prop */
  const addProp = async () => {
    if (!selected) return;
    const name = propForm.name.trim(); const type = propForm.type.trim();
    if (name && type && await run(() => createProp({ sceneId: selected.scene.id, name, type }), `已添加道具“${name}”`)) setPropForm({ name: "", type: "" });
  };
  const removeProp = async (prop: Prop) => {
    // Same rule as the store (which still enforces it): no confirm for a delete that would be refused.
    const users = selected?.states.filter((state) => state.propChanges.some((change) => change.propId === prop.id)) ?? [];
    if (users.length) { refuse(`道具“${prop.name}”仍被状态引用（${users.map((state) => `“${state.name}”`).join("、")}），请先删除或修改这些状态`); return; }
    if (await askConfirm({ message: `删除道具“${prop.name}”？`, confirmLabel: "删除", danger: true })) void run(() => deleteProp(prop.id), `已删除道具“${prop.name}”`);
  };

  /* SceneState */
  const addState = async () => {
    if (!selected) return;
    const name = stateForm.name.trim(); const description = stateForm.description.trim();
    if (!name) return;
    if (description && !stateForm.propId) { refuse("填写了变化描述时，请选择发生变化的道具"); return; }
    const propChanges = stateForm.propId ? [{ propId: stateForm.propId, description }] : [];
    if (await run(() => createSceneState({ sceneId: selected.scene.id, name, propChanges }), `已添加状态“${name}”`)) setStateForm({ name: "", propId: "", description: "" });
  };
  const removeState = async (state: SceneState) => { if (await askConfirm({ message: `删除状态“${state.name}”？`, confirmLabel: "删除", danger: true })) void run(() => deleteSceneState(state.id), `已删除状态“${state.name}”`); };

  /* Camera */
  const addCamera = async () => {
    if (!selected) return;
    const name = cameraForm.name.trim(); const note = cameraForm.note.trim();
    if (name && await run(() => createCamera({ sceneId: selected.scene.id, name, ...(note ? { note } : {}) }), `已添加摄影机“${name}”`)) setCameraForm({ name: "", note: "" });
  };
  /* Motion: director intent only; keyframes stay sorted by frame (the store sorts and refuses duplicates). */
  const motionTargetName = (motion: Pick<Motion, "targetType" | "targetId">) => (motion.targetType === "camera" ? selected?.cameras : selected?.props)?.find((item) => item.id === motion.targetId)?.name ?? "（目标已不存在）";
  const addMotion = async () => {
    if (!selected) return;
    const name = motionForm.name.trim();
    const [targetType, targetId] = motionForm.target.split(":") as [MotionTargetType, string];
    if (!name || !targetId) return;
    if (await run(() => createMotion({ sceneId: selected.scene.id, name, targetType, targetId, keyframes: [] }), `已新建动作“${name}”`)) setMotionForm({ name: "", target: motionForm.target });
  };
  const saveKeyframes = (motion: Motion, keyframes: MotionKeyframe[], done: string) => run(() => updateMotion(motion.id, { keyframes }), done);
  const addKeyframe = async (motion: Motion) => {
    const draft = keyframeDraft[motion.id] ?? { frame: "", description: "" };
    const frame = parseMotionFrame(draft.frame);
    if (frame === null) { refuse(MOTION_FRAME_HINT); return; }
    if (motion.keyframes.some((keyframe) => keyframe.frame === frame)) { refuse(`动作“${motion.name}”已有第 ${frame} 帧的关键帧，请修改那一条或换一个帧号`); return; }
    if (await saveKeyframes(motion, [...motion.keyframes, { frame, description: draft.description.trim() }], `已添加关键帧 f${frame}`)) setKeyframeDraft((all) => ({ ...all, [motion.id]: { frame: "", description: "" } }));
  };
  const editKeyframe = (motion: Motion, index: number, next: MotionKeyframe) => {
    if (motion.keyframes.some((keyframe, at) => at !== index && keyframe.frame === next.frame)) { refuse(`动作“${motion.name}”已有第 ${next.frame} 帧的关键帧`); return; }
    void saveKeyframes(motion, motion.keyframes.map((keyframe, at) => at === index ? { ...keyframe, ...next } : keyframe), "关键帧已保存"); // keeps a V0.2 pose
  };
  const removeKeyframe = (motion: Motion, index: number) => void saveKeyframes(motion, motion.keyframes.filter((_, at) => at !== index), `已删除关键帧 f${motion.keyframes[index].frame}`);
  const removeMotion = async (motion: Motion) => { if (await askConfirm({ message: `删除动作“${motion.name}”及其 ${motion.keyframes.length} 个关键帧？`, confirmLabel: "删除", danger: true })) void run(() => deleteMotion(motion.id), `已删除动作“${motion.name}”`); };

  const removeCamera = async (camera: Camera) => { if (await askConfirm({ message: `删除摄影机“${camera.name}”？`, confirmLabel: "删除", danger: true })) void run(() => deleteCamera(camera.id), `已删除摄影机“${camera.name}”`); };

  /* ControlPackage: Assets are referenced by ID only; the package never copies or deletes media. */
  const addPackage = async () => {
    if (!selected) return;
    const name = packageForm.name.trim();
    if (!name) return;
    const assetIds = packageForm.assetId ? [packageForm.assetId] : [];
    const problem = assetProblem(packageForm.type, assetIds);
    if (problem) { refuse(problem); return; }
    const anchorFrame = packageForm.type === "guide" ? parseAnchor(packageForm.anchorFrame) : undefined;
    if (anchorFrame === null) { refuse(ANCHOR_HINT); return; }
    if (await run(() => createControlPackage({ sceneId: selected.scene.id, name, type: packageForm.type, assetIds, ...(anchorFrame !== undefined ? { anchorFrame } : {}) }), `已添加控制素材包“${name}”`)) setPackageForm({ name: "", type: packageForm.type, assetId: "", anchorFrame: packageForm.anchorFrame });
  };
  const bindAsset = (pack: ControlPackage) => {
    const assetId = bindDraft[pack.id];
    if (!assetId) return;
    const assetIds = [...pack.assetIds, assetId];
    const problem = assetProblem(pack.type, assetIds);
    if (problem) { refuse(problem); return; }
    void run(() => updateControlPackage(pack.id, { assetIds }), "素材已绑定").then((ok) => { if (ok) setBindDraft((draft) => ({ ...draft, [pack.id]: "" })); });
  };
  const unbindAsset = (pack: ControlPackage, assetId: string) => void run(() => updateControlPackage(pack.id, { assetIds: pack.assetIds.filter((id) => id !== assetId) }), "已解除素材绑定（素材本身保留）");
  /* Director Stage → H3: the same plan is previewed while choosing and used when sending. */
  const toHandoffAsset = (assetId: string): HandoffAsset | null => { const asset = assetById.get(assetId); return asset ? { assetId: asset.assetId, kind: asset.kind, storageReference: asset.storageReference, filename: asset.filename, width: asset.width, height: asset.height } : null; };
  const buildHandoff = () => {
    if (!selected) throw new Error("请先打开一个场景");
    const pick = (id: string) => selected.packages.find((pack) => pack.id === id) ?? null;
    return planH3Handoff({ sceneId: selected.scene.id, sceneStateId: sendForm.stateId || null, firstFramePackage: pick(sendForm.firstId), lastFramePackage: pick(sendForm.lastId), referencePackage: pick(sendForm.referenceId), guidePackages: sendForm.guideIds.map(pick).filter((pack): pack is ControlPackage => Boolean(pack)) }, selected.states, toHandoffAsset);
  };
  let handoffPreview: { ok: boolean; text: string } | null = null;
  if (selected && (sendForm.firstId || sendForm.lastId || sendForm.referenceId || sendForm.guideIds.length)) {
    try { const plan = buildHandoff(); handoffPreview = { ok: true, text: `将创建 H3 节点：${MODE_LABEL[plan.expectedMode]}，连接 ${plan.context.assetIds.length} 个素材${plan.guides.length ? `，锚点 ${plan.guides.map((guide) => `f${guide.anchorFrame}`).join(" → ")}` : ""}` }; }
    catch (cause) { handoffPreview = { ok: false, text: cause instanceof Error ? cause.message : String(cause) }; }
  }
  const sendToH3 = async () => {
    if (!onSendToH3) return;
    let plan: H3HandoffPlan;
    try { plan = buildHandoff(); } catch (cause) { refuse(cause instanceof Error ? cause.message : String(cause)); return; }
    setWorking(true); setError(""); setNotice("");
    try { await onSendToH3(plan); onClose(); }
    catch (cause) { setError(`发送到 H3 失败：${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setWorking(false); }
  };
  const packageOptions = (type: ControlPackageType) => selected?.packages.filter((pack) => pack.type === type) ?? [];

  /* Shot System V0.1: a Shot binds Scene / State / Camera / Motions / Control Packages; H3 Runs attach to it as before. */
  const sceneShots = selected ? shots.filter((shot) => shot.director?.sceneId === selected.scene.id) : [];
  const shotBinding = (): ShotDirectorBinding | null => selected ? { sceneId: selected.scene.id, sceneStateId: shotForm.stateId || null, cameraId: shotForm.cameraId || null, motionIds: shotForm.motionIds, firstFramePackageId: shotForm.firstId || null, lastFramePackageId: shotForm.lastId || null, referencePackageId: shotForm.referenceId || null, guidePackageIds: shotForm.guideIds } : null;
  const planShot = (binding: ShotDirectorBinding) => {
    if (!selected) throw new Error("请先打开一个场景");
    return planH3Handoff(shotHandoffRequest(binding, selected), selected.states, toHandoffAsset);
  };
  let shotPreview: { ok: boolean; text: string } | null = null;
  const formBinding = shotBinding();
  if (formBinding && (formBinding.firstFramePackageId || formBinding.referencePackageId || formBinding.lastFramePackageId || formBinding.guidePackageIds.length)) {
    try { const plan = planShot(formBinding); shotPreview = { ok: true, text: `发送时将创建：${MODE_LABEL[plan.expectedMode]}，连接 ${plan.context.assetIds.length} 个素材` }; }
    catch (cause) { shotPreview = { ok: false, text: `暂不能发送到 H3：${cause instanceof Error ? cause.message : String(cause)}（镜头仍可保存为草稿）` }; }
  }
  const saveShot = async () => {
    const binding = shotBinding();
    if (!binding) return;
    const editing = shotForm.editingId;
    const title = shotForm.title.trim();
    if (await run(async () => { if (editing) await updateShotDirector(editing, binding, title); else await createShot(title, undefined, binding); await reloadShots(); }, editing ? "镜头绑定已保存" : "已新建镜头")) setShotForm(EMPTY_SHOT_FORM);
  };
  const editShot = (shot: ShotRecord) => {
    const binding = shot.director!;
    setShotForm({ editingId: shot.shotId, title: shot.title, cameraId: binding.cameraId ?? "", stateId: binding.sceneStateId ?? "", motionIds: [...binding.motionIds], firstId: binding.firstFramePackageId ?? "", lastId: binding.lastFramePackageId ?? "", referenceId: binding.referencePackageId ?? "", guideIds: [...binding.guidePackageIds] });
    setError(""); setNotice("");
  };
  const sendShot = async (shot: ShotRecord) => {
    if (!onSendShotToH3 || !shot.director) return;
    let plan: H3HandoffPlan;
    try { plan = planShot(shot.director); } catch (cause) { refuse(`${shotLabel(shot)} 暂不能发送到 H3：${cause instanceof Error ? cause.message : String(cause)}`); return; }
    setWorking(true); setError(""); setNotice("");
    try { await onSendShotToH3(shot.shotId, plan); onClose(); }
    catch (cause) { setError(`发送到 H3 失败：${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { setWorking(false); }
  };
  const bindingSummary = (binding: ShotDirectorBinding) => {
    const name = <T extends { id: string; name: string }>(rows: T[], id: string | null) => id ? rows.find((row) => row.id === id)?.name ?? "（已删除）" : null;
    const parts = [
      binding.cameraId && `机位：${name(selected?.cameras ?? [], binding.cameraId)}`,
      binding.sceneStateId && `状态：${name(selected?.states ?? [], binding.sceneStateId)}`,
      binding.motionIds.length && `动作：${binding.motionIds.map((id) => name(selected?.motions ?? [], id)).join("、")}`,
      binding.firstFramePackageId && `首帧：${name(selected?.packages ?? [], binding.firstFramePackageId)}`,
      binding.lastFramePackageId && `尾帧：${name(selected?.packages ?? [], binding.lastFramePackageId)}`,
      binding.referencePackageId && `参考：${name(selected?.packages ?? [], binding.referencePackageId)}`,
      binding.guidePackageIds.length && `🧪 引导：${binding.guidePackageIds.map((id) => name(selected?.packages ?? [], id)).join("、")}`,
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : "还没有绑定";
  };

  /* 一键白模首帧: Blender renders the chosen camera → image Asset → first_frame package, preselected for 发送到 H3. */
  const frameCameras = selected ? placedCameras(selected.cameras) : [];
  const frameCamera = frameCameras.find((camera) => camera.id === frameCameraId) ?? frameCameras[0];
  const generateFirstFrame = async () => {
    if (!selected || !onImportImage || !frameCamera) return;
    setFrameBusy(true); setWorking(true); setError(""); setNotice("");
    try {
      const result = await generateWhiteboxFirstFrame(selected.scene.id, frameCamera.id, { importImage: onImportImage });
      await reload();
      setAssets(usableAssets(await listAssets()));
      setSendForm((form) => ({ ...form, firstId: result.controlPackage.id }));
      setFramePreview({ url: URL.createObjectURL(result.file), filename: result.asset.filename, packageName: result.controlPackage.name, size: `${result.record.render.width}×${result.record.render.height}`, seconds: result.record.render.seconds });
      setNotice(`已生成白模首帧并登记为素材，已创建首帧包“${result.controlPackage.name}”，可直接【发送到 H3】`);
    } catch (cause) {
      setError(`生成白模首帧失败：${cause instanceof Error ? cause.message : String(cause)}`);
      await reload().catch(() => undefined);
    } finally { setFrameBusy(false); setWorking(false); }
  };

  /* 高级控制素材 V0.1: one Blender run → rgb / depth / mask / object-id Assets + four packages with render metadata (not sent to H3). */
  const generateControls = async () => {
    if (!selected || !onImportImage || !frameCamera) return;
    setFrameBusy(true); setWorking(true); setError(""); setNotice("");
    try {
      const result = await generateWhiteboxControls(selected.scene.id, frameCamera.id, { importImage: onImportImage });
      await reload();
      setAssets(usableAssets(await listAssets()));
      const depth = result.record.controls?.depth;
      const objects = result.record.controls?.objectId?.objects.filter((object) => object.pixels > 0).length ?? 0;
      setControlsPreview({ items: result.items.map((item) => ({ pass: item.pass, url: URL.createObjectURL(item.file), filename: item.asset.filename })), summary: `${result.record.render.width}×${result.record.render.height} · 深度 ${depth?.nearM.toFixed(2)}–${depth?.farM.toFixed(2)} m · 可见物体 ${objects} 个` });
      setNotice(`已生成控制素材组（RGB / 深度 / 遮罩 / 物体 ID），登记了 ${result.items.length} 张图片素材并创建了 ${result.items.length} 个控制素材包`);
    } catch (cause) {
      setError(`生成控制素材组失败：${cause instanceof Error ? cause.message : String(cause)}`);
      await reload().catch(() => undefined);
    } finally { setFrameBusy(false); setWorking(false); }
  };
  /* Depth 写实首帧 V0.1: Blender depth → SDXL (frozen template) → realistic first_frame package, preselected for 发送到 H3. */
  const generateRealistic = async () => {
    if (!selected || !onImportImage || !frameCamera) return;
    setFrameBusy(true); setWorking(true); setError(""); setNotice(""); setRealisticStage("准备中");
    try {
      const result = await generateDepthFirstFrame(selected.scene.id, frameCamera.id, realisticPrompt, { importImage: onImportImage, comfy: { onStage: setRealisticStage } });
      await reload();
      setAssets(usableAssets(await listAssets()));
      setSendForm((form) => ({ ...form, firstId: result.firstFrame.controlPackage.id }));
      setRealisticPreview({ depthUrl: URL.createObjectURL(result.depth.file), imageUrl: URL.createObjectURL(result.firstFrame.file), filename: result.firstFrame.asset.filename, packageName: result.firstFrame.controlPackage.name, summary: `${result.record.render.width}×${result.record.render.height} · seed ${result.seed} · 全程 ${result.seconds.toFixed(1)} 秒` });
      setNotice(`已生成写实首帧并登记为素材，已创建首帧包“${result.firstFrame.controlPackage.name}”（深度包“${result.depth.controlPackage.name}”记录来源），可直接【发送到 H3】`);
    } catch (cause) {
      setError(`生成写实首帧失败：${cause instanceof Error ? cause.message : String(cause)}`);
      await reload().catch(() => undefined);
    } finally { setFrameBusy(false); setWorking(false); setRealisticStage(""); }
  };
  const renderSummary = (pack: ControlPackage) => {
    const render = pack.render;
    if (!render) return null;
    const camera = selected?.cameras.find((item) => item.id === render.cameraId)?.name ?? "（机位已删除）";
    const sources = render.sourceObjects.map((object) => object.color ? `${object.name}（rgb ${object.color.join(",")}${object.pixels !== undefined ? ` · ${object.pixels}px` : ""}）` : object.name);
    if (render.generator) return `📷 ${render.generator.template} · 机位：${camera} · ${new Date(render.renderedAt).toLocaleString("zh-CN")} · ${render.width}×${render.height} · seed ${render.generator.seed} · 深度控制 ${render.generator.controlStrength} · 来源深度包：${selected?.packages.find((item) => item.id === render.generator!.sourceDepthPackageId)?.name ?? "（已删除）"}`;
    return `🧊 Blender · 机位：${camera} · ${new Date(render.renderedAt).toLocaleString("zh-CN")} · ${render.width}×${render.height}${render.depthRange ? ` · 深度 ${render.depthRange.nearM.toFixed(2)}–${render.depthRange.farM.toFixed(2)} m（越近越亮）` : ""} · 来源：${sources.length ? sources.join("、") : "（无可见物体）"}${render.includesRoom ? " + 房间" : ""}`;
  };

  const generateAnchors = async () => {
    if (!selected || !onImportImage || !frameCamera) return;
    setFrameBusy(true); setWorking(true); setError(""); setNotice(""); setRealisticStage("准备 Motion 锚点");
    setAnchorPreviews([]);
    anchorUrls.current.forEach((url) => URL.revokeObjectURL(url)); anchorUrls.current = [];
    const completed: number[] = [];
    try {
      const results = await generateMotionRealisticAnchors({ sceneId: selected.scene.id, cameraId: frameCamera.id, motionId: anchorMotionId, frames: anchorFrames, length: getActualDuration(anchorSeconds).length, prompt: anchorPrompt }, {
        importImage: onImportImage, comfy: { onStage: setRealisticStage },
        onResult: (result) => {
          const frame = result.firstFrame.controlPackage.anchorFrame!;
          completed.push(frame);
          const url = URL.createObjectURL(result.firstFrame.file); anchorUrls.current.push(url);
          setAnchorPreviews((previous) => [...previous, { frame, url }]);
          setSendForm((form) => ({ ...form, lastId: "", referenceId: "", guideIds: completed.length === 1 ? [result.firstFrame.controlPackage.id] : [...form.guideIds, result.firstFrame.controlPackage.id] }));
        },
      });
      setNotice(`已生成 ${results.length} 个写实锚点（${completed.map((frame) => `f${frame}`).join(" → ")}），已选入发送到 H3；仍需首帧包。锚点为引导，不保证动作精确按帧发生。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      try { await reload(); setAssets(usableAssets(await listAssets())); }
      catch (cause) { setError((current) => current || `素材列表刷新失败，请重新打开导演台：${cause instanceof Error ? cause.message : String(cause)}`); }
      finally { setFrameBusy(false); setWorking(false); setRealisticStage(""); }
    }
  };

  const removePackage = async (pack: ControlPackage) => { if (await askConfirm({ message: `删除控制素材包“${pack.name}”？引用的素材不会被删除。`, confirmLabel: "删除", danger: true })) void run(() => deleteControlPackage(pack.id), `已删除控制素材包“${pack.name}”`); };

  return createPortal(<div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <div className="generation-info-panel role-library-panel" role="dialog" aria-modal="true" aria-label="导演台" onPointerDown={(event) => event.stopPropagation()}>
      <header><div><small>Director Stage · V{DIRECTOR_STAGE_MODULE.version}</small><h2>{selected ? selected.scene.name : "导演台"}</h2></div><button type="button" title="关闭" aria-label="关闭导演台" onClick={onClose}><X size={17} /></button></header>
      <DirectorStageJsonTools scenes={summaries} currentSceneId={selected?.scene.id ?? null} assets={assets} shots={shots} disabled={working} onOverlayChange={setJsonOverlay} onChanged={async (done, openSceneId) => {
        const rows = await loadSummaries().catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); return null; });
        if (!rows) return;
        setSummaries(rows);
        const target = openSceneId ? rows.find((item) => item.scene.id === openSceneId) : undefined;
        if (target) openScene(target.scene);
        setError(""); setNotice(done);
      }} />
      {selected ? <div className="role-detail">
        <button className="role-back" type="button" onClick={() => { setSelectedId(""); setError(""); setNotice(""); }}><ArrowLeft size={15} />返回场景列表</button>
        <button type="button" className="role-main-action" style={{ justifySelf: "start" }} onClick={() => setWhiteboxOpen(true)}><Box size={15} />打开白模导演台（3D）</button>
        {whiteboxOpen && <WhiteboxStage sceneId={selected.scene.id} onClose={() => { setWhiteboxOpen(false); void reload(); }} />}
        <label>场景名称<input value={sceneNameDraft} onChange={(event) => setSceneNameDraft(event.target.value)} onBlur={saveSceneName} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>

        <div className="role-section-title"><b>道具 · {selected.props.length}</b></div>
        <div className="role-create">
          <input aria-label="道具名称" placeholder="道具名称，例如：椅子" value={propForm.name} onChange={(event) => setPropForm({ ...propForm, name: event.target.value })} onKeyDown={enter(() => void addProp())} />
          <input aria-label="道具类型" placeholder="类型，例如：chair" value={propForm.type} onChange={(event) => setPropForm({ ...propForm, type: event.target.value })} onKeyDown={enter(() => void addProp())} />
          <button type="button" className="role-main-action" disabled={working || !propForm.name.trim() || !propForm.type.trim()} onClick={() => void addProp()}><Plus size={15} />添加道具</button>
        </div>
        {selected.props.length ? selected.props.map((prop) => <div className="role-asset-row" key={prop.id}>
          <EditableName value={prop.name} label="道具" onSave={async (name) => { await run(() => updateProp(prop.id, { name }), "道具名称已保存"); }} />
          <small>{prop.type}</small>
          <button type="button" title="删除道具" aria-label={`删除道具“${prop.name}”`} disabled={working} onClick={() => removeProp(prop)}><Trash2 size={13} /></button>
        </div>) : <p className="role-hint">这个场景还没有道具</p>}

        <div className="role-section-title"><b>状态 · {selected.states.length}</b></div>
        <div className="role-create">
          <input aria-label="状态名称" placeholder="状态名称，例如：椅子倒地" value={stateForm.name} onChange={(event) => setStateForm({ ...stateForm, name: event.target.value })} onKeyDown={enter(() => void addState())} />
          <select aria-label="变化的道具" style={SELECT_STYLE} value={stateForm.propId} onChange={(event) => setStateForm({ ...stateForm, propId: event.target.value })}>
            <option value="">（不指定道具）</option>
            {selected.props.map((prop) => <option key={prop.id} value={prop.id}>{prop.name}</option>)}
          </select>
          <input aria-label="变化描述" placeholder="变化描述，例如：侧倒在地上" value={stateForm.description} onChange={(event) => setStateForm({ ...stateForm, description: event.target.value })} onKeyDown={enter(() => void addState())} />
          <button type="button" className="role-main-action" disabled={working || !stateForm.name.trim()} onClick={() => void addState()}><Plus size={15} />添加状态</button>
        </div>
        {selected.states.length ? selected.states.map((state) => <div key={state.id}>
          <div className="role-asset-row">
            <EditableName value={state.name} label="状态" onSave={async (name) => { await run(() => updateSceneState(state.id, { name }), "状态名称已保存"); }} />
            <small>{state.propChanges.length} 项道具变化</small>
            <button type="button" title="删除状态" aria-label={`删除状态“${state.name}”`} disabled={working} onClick={() => removeState(state)}><Trash2 size={13} /></button>
          </div>
          {state.propChanges.map((change) => <p className="role-hint" key={change.propId}>{propName(change.propId)}：{change.description || "（无描述）"}</p>)}
        </div>) : <p className="role-hint">这个场景还没有状态</p>}

        <div className="role-section-title"><b>摄影机 · {selected.cameras.length}</b></div>
        <div className="role-create">
          <input aria-label="摄影机名称" placeholder="摄影机名称，例如：主机位" value={cameraForm.name} onChange={(event) => setCameraForm({ ...cameraForm, name: event.target.value })} onKeyDown={enter(() => void addCamera())} />
          <input aria-label="摄影机备注" placeholder="备注（可选），例如：35mm 低机位" value={cameraForm.note} onChange={(event) => setCameraForm({ ...cameraForm, note: event.target.value })} onKeyDown={enter(() => void addCamera())} />
          <button type="button" className="role-main-action" disabled={working || !cameraForm.name.trim()} onClick={() => void addCamera()}><Plus size={15} />添加摄影机</button>
        </div>
        {selected.cameras.length ? selected.cameras.map((camera) => <div key={camera.id}>
          <div className="role-asset-row">
            <EditableName value={camera.name} label="摄影机" onSave={async (name) => { await run(() => updateCamera(camera.id, { name }), "摄影机名称已保存"); }} />
            <button type="button" title="删除摄影机" aria-label={`删除摄影机“${camera.name}”`} disabled={working} onClick={() => removeCamera(camera)}><Trash2 size={13} /></button>
          </div>
          <EditableNote value={camera.note ?? ""} label={`摄影机“${camera.name}”`} onSave={async (note) => { await run(() => updateCamera(camera.id, { note }), "摄影机备注已保存"); }} />
        </div>) : <p className="role-hint">这个场景还没有摄影机</p>}

        <div className="role-section-title"><b>动作 Motion · {selected.motions.length}</b></div>
        <p className="role-hint">{MOTION_NOTE} 帧号按 24 FPS 计（24 帧 = 1 秒），关键帧自动按帧号排序，同一动作内帧号不能重复。📍 表示关键帧带白模位置（在“打开白模导演台”里记录姿态、播放预览）；修改帧号 / 描述会保留位置。</p>
        <div className="role-create">
          <input aria-label="动作名称" placeholder="动作名称，例如：椅子倒下" value={motionForm.name} onChange={(event) => setMotionForm({ ...motionForm, name: event.target.value })} onKeyDown={enter(() => void addMotion())} />
          <select aria-label="动作目标" style={{ ...SELECT_STYLE, width: 196 }} value={motionForm.target} onChange={(event) => setMotionForm({ ...motionForm, target: event.target.value })}>
            <option value="">{selected.props.length + selected.cameras.length ? "选择目标（道具或摄影机）" : "先添加道具或摄影机"}</option>
            {selected.props.map((prop) => <option key={prop.id} value={`prop:${prop.id}`}>道具：{prop.name}</option>)}
            {selected.cameras.map((camera) => <option key={camera.id} value={`camera:${camera.id}`}>摄影机：{camera.name}</option>)}
          </select>
          <button type="button" className="role-main-action" disabled={working || !motionForm.name.trim() || !motionForm.target} onClick={() => void addMotion()}><Plus size={15} />新建动作</button>
        </div>
        {selected.motions.length ? selected.motions.map((motion) => {
          const draft = keyframeDraft[motion.id] ?? { frame: "", description: "" };
          return <div key={motion.id}>
            <div className="role-asset-row">
              <EditableName value={motion.name} label="动作" onSave={async (name) => { await run(() => updateMotion(motion.id, { name }), "动作名称已保存"); }} />
              <small>{motion.targetType === "camera" ? "摄影机" : "道具"} · {motionTargetName(motion)} · {motion.keyframes.length} 个关键帧</small>
              <button type="button" title="删除动作" aria-label={`删除动作“${motion.name}”`} disabled={working} onClick={() => removeMotion(motion)}><Trash2 size={13} /></button>
            </div>
            {motion.keyframes.map((keyframe, index) => <KeyframeRow key={keyframe.frame} keyframe={keyframe} motionName={motion.name} disabled={working} onInvalid={refuse} onSave={(next) => editKeyframe(motion, index, next)} onRemove={() => removeKeyframe(motion, index)} />)}
            <div className="role-create" style={NESTED}>
              <input type="number" aria-label={`为“${motion.name}”添加关键帧帧号`} min={MOTION_FRAME_RANGE.min} max={MOTION_FRAME_RANGE.max} placeholder="帧号" style={{ flex: "none", width: 92 }} value={draft.frame} onChange={(event) => setKeyframeDraft((all) => ({ ...all, [motion.id]: { ...draft, frame: event.target.value } }))} onKeyDown={enter(() => void addKeyframe(motion))} />
              <input aria-label={`为“${motion.name}”添加关键帧描述`} placeholder="这一帧的状态，例如：开始倾斜" value={draft.description} onChange={(event) => setKeyframeDraft((all) => ({ ...all, [motion.id]: { ...draft, description: event.target.value } }))} onKeyDown={enter(() => void addKeyframe(motion))} />
              <button type="button" className="role-main-action" disabled={working || !draft.frame.trim()} onClick={() => void addKeyframe(motion)}><Plus size={15} />关键帧</button>
            </div>
          </div>;
        }) : <p className="role-hint">这个场景还没有动作</p>}

        <div className="role-section-title"><b>控制素材包 · {selected.packages.length}</b></div>
        <div className="role-create">
          <input aria-label="控制素材包名称" placeholder="名称，例如：椅子首帧" value={packageForm.name} onChange={(event) => setPackageForm({ ...packageForm, name: event.target.value })} onKeyDown={enter(() => void addPackage())} />
          <select aria-label="控制素材包类型" style={{ ...SELECT_STYLE, width: 158 }} value={packageForm.type} onChange={(event) => { const type = event.target.value as ControlPackageType; setPackageForm({ ...packageForm, type, assetId: assetsFor(type).some((asset) => asset.assetId === packageForm.assetId) ? packageForm.assetId : "" }); }}>
            {CONTROL_PACKAGE_TYPES.map((type) => <option key={type} value={type}>{CONTROL_PACKAGE_ASSET_RULES[type].label}（{type}）</option>)}
          </select>
          <select aria-label="绑定素材" style={WIDE_SELECT_STYLE} value={packageForm.assetId} onChange={(event) => setPackageForm({ ...packageForm, assetId: event.target.value })}>
            <option value="">（暂不绑定素材）</option>
            {assetsFor(packageForm.type).map((asset) => <option key={asset.assetId} value={asset.assetId}>{assetLabel(asset)}</option>)}
          </select>
          {packageForm.type === "guide" && <input type="number" aria-label="锚点帧" title={ANCHOR_HINT} min={ANCHOR_FRAME_RANGE.min} max={ANCHOR_FRAME_RANGE.max} style={{ flex: "none", width: 88 }} placeholder="锚点帧" value={packageForm.anchorFrame} onChange={(event) => setPackageForm({ ...packageForm, anchorFrame: event.target.value })} />}
          <button type="button" className="role-main-action" disabled={working || !packageForm.name.trim()} onClick={() => void addPackage()}><Plus size={15} />添加</button>
        </div>
        <p className="role-hint">只引用当前项目里已有的素材（按 Asset ID），不复制、不修改、不删除素材。首帧 / 尾帧：1 张图片；参考：图片 / 视频 / 声音；🧪 引导锚点：1 张图片 + 锚点帧（实验能力）。{H3_ADDGUIDE_NOTE}</p>
        {selected.packages.length ? sortedPackages(selected.packages).map((pack) => {
          const rule = CONTROL_PACKAGE_ASSET_RULES[pack.type];
          const options = assetsFor(pack.type).filter((asset) => !pack.assetIds.includes(asset.assetId));
          return <div key={pack.id}>
            <div className="role-asset-row">
              <EditableName value={pack.name} label="控制素材包" onSave={async (name) => { await run(() => updateControlPackage(pack.id, { name }), "控制素材包名称已保存"); }} />
              <small>{rule.label}{pack.type === "guide" ? ` · ${pack.anchorFrame !== undefined ? `f${pack.anchorFrame}` : "未设锚点"}` : ""} · {pack.assetIds.length} 个素材</small>
              <button type="button" title="删除控制素材包" aria-label={`删除控制素材包“${pack.name}”`} disabled={working} onClick={() => removePackage(pack)}><Trash2 size={13} /></button>
            </div>
            {pack.render && <p className="role-hint" style={NESTED}>{renderSummary(pack)}</p>}
            {pack.type === "guide" && <EditableAnchor value={pack.anchorFrame} label={pack.name} onInvalid={refuse} onSave={async (anchorFrame) => { await run(() => updateControlPackage(pack.id, { anchorFrame }), "锚点帧已保存"); }} />}
            {pack.assetIds.map((assetId) => { const asset = assetById.get(assetId); return <div className="role-asset-row" style={NESTED} key={assetId}>
              <span className="role-asset-name" title={assetId}>{asset ? assetLabel(asset) : `（素材记录不存在：${assetId}）`}</span>
              <button type="button" title="解除绑定（素材保留）" aria-label={`从“${pack.name}”解除素材“${asset?.filename ?? assetId}”`} disabled={working} onClick={() => unbindAsset(pack, assetId)}><X size={13} /></button>
            </div>; })}
            {pack.assetIds.length < rule.max && <div className="role-create" style={NESTED}>
              <select aria-label={`为“${pack.name}”选择素材`} style={WIDE_SELECT_STYLE} value={bindDraft[pack.id] ?? ""} onChange={(event) => setBindDraft((draft) => ({ ...draft, [pack.id]: event.target.value }))}>
                <option value="">{options.length ? "选择要绑定的已有素材…" : "没有可绑定的素材"}</option>
                {options.map((asset) => <option key={asset.assetId} value={asset.assetId}>{assetLabel(asset)}</option>)}
              </select>
              <button type="button" className="role-main-action" disabled={working || !bindDraft[pack.id]} onClick={() => bindAsset(pack)}><Link2 size={15} />绑定</button>
            </div>}
          </div>;
        }) : <p className="role-hint">这个场景还没有控制素材包</p>}

        {onImportImage && <>
          <div className="role-section-title"><b>白模首帧（Blender）</b></div>
          <p className="role-hint">用所选机位在本机 Blender 后台渲染一张 RGB 白模图（{FIRST_FRAME_SIZE}），自动登记为图片素材，并创建首帧包。只渲染房间、方盒 / 平面和机位，不做 Depth / Mask / Motion。</p>
          <div className="role-create">
            <select aria-label="白模首帧机位" style={WIDE_SELECT_STYLE} value={frameCamera?.id ?? ""} disabled={!frameCameras.length} onChange={(event) => setFrameCameraId(event.target.value)}>
              {frameCameras.length ? frameCameras.map((camera) => <option key={camera.id} value={camera.id}>机位：{camera.name}（{camera.focalLength ?? 35}mm · {camera.aspect ?? "9:16"}）</option>) : <option value="">先在白模导演台（3D）里放入摄影机</option>}
            </select>
            <button type="button" className="role-main-action" disabled={working || !frameCamera || blender?.available === false} onClick={() => void generateFirstFrame()}><ImageIcon size={15} />{frameBusy ? "正在渲染…" : "生成白模首帧"}</button>
          </div>
          <div className="role-create">
            <button type="button" className="role-main-action" disabled={working || !frameCamera || blender?.available === false} title="同一机位一次渲染 RGB + 深度 + 物体遮罩 + 物体 ID，全部登记为素材并各建一个控制素材包（不发送到 H3）" onClick={() => void generateControls()}><ImageIcon size={15} />{frameBusy ? "正在渲染…" : "生成控制素材组（RGB + 深度 + 遮罩 + 物体 ID）"}</button>
          </div>
          <p className="ff-hint role-hint">控制素材组只做生成、登记和管理：深度 / 遮罩 / 物体 ID 现在不会发送到 H3。深度图越近越亮；遮罩里白色是全部道具；物体 ID 每个道具一种纯色（颜色对应关系记在控制素材包上）。</p>
          {blender && !blender.available && <p className="role-hint" style={{ color: "var(--ff-bad)" }}>{blender.reachable ? "本机没有找到便携版 Blender（设置 FRAMEFLOW_BLENDER），暂时不能生成白模首帧" : "白模渲染需要用本地开发服务器打开画布"}</p>}
          {frameBusy && !realisticStage && <p className="role-hint" role="status">正在用 Blender 渲染白模首帧…通常几秒钟</p>}
          {framePreview && !frameBusy && <div className="role-asset-row" style={{ alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- local blob: preview of the PNG just rendered */}
            <img src={framePreview.url} alt="白模首帧预览" style={{ height: 96, maxWidth: 170, objectFit: "contain", borderRadius: 4, background: "var(--ff-bg)" }} />
            <span className="role-asset-name" title={framePreview.filename}>{framePreview.filename}<br /><small>{framePreview.size} · Blender {framePreview.seconds.toFixed(1)} 秒 · 首帧包“{framePreview.packageName}”已选入下方首帧包</small></span>
          </div>}
          <div className="role-section-title"><b>Motion 写实锚点（实验）</b></div>
          <p className="ff-hint role-hint">沿用上方机位。选择 1–4 个 📍 空间关键帧，逐帧 Depth → SDXL → guide。f0 继续用首帧逻辑；文字帧不能生成，锚点不保证动作精确按帧发生。</p>
          <div className="role-create">
            <select aria-label="写实锚点 Motion" style={WIDE_SELECT_STYLE} disabled={working} value={anchorMotionId} onChange={(event) => { setAnchorMotionId(event.target.value); setAnchorFrames([]); }}>
              <option value="">选择 Motion…</option>
              {selected.motions.map((motion) => <option key={motion.id} value={motion.id}>{motion.name}</option>)}
            </select>
            <label>视频时长（秒）<input aria-label="写实锚点视频时长" type="number" min={H3_MIN_LENGTH / H3_FPS} max={H3_MAX_REQUESTED_SECONDS} step="0.1" disabled={working} value={anchorSeconds} onChange={(event) => setAnchorSeconds(event.target.value)} /></label>
          </div>
          <p className="role-hint">实际约 {getActualDuration(anchorSeconds).actualSeconds.toFixed(2)} 秒；发送时同步到新 H3 节点，之后缩短时长会重新校验锚点。</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {selected.motions.find((motion) => motion.id === anchorMotionId)?.keyframes.map((key) => <label key={key.frame} style={{ fontSize: 12 }}>
              <input type="checkbox" style={{ width: "auto" }} aria-label={`写实锚点 f${key.frame}`} disabled={working || !key.transform || key.frame === 0 || key.frame >= getActualDuration(anchorSeconds).length} checked={anchorFrames.includes(key.frame)} onChange={(event) => setAnchorFrames((frames) => event.target.checked ? [...frames, key.frame] : frames.filter((frame) => frame !== key.frame))} />
              {key.transform ? "📍" : "📝"} f{key.frame}{key.frame === 0 ? "（首帧）" : !key.transform ? "（仅文字）" : key.frame >= getActualDuration(anchorSeconds).length ? "（越界）" : ""}
            </label>)}
          </div>
          <div className="role-create">
            <input aria-label="写实锚点描述" maxLength={600} placeholder="描述同一场景的材质、物体和光照" disabled={working} value={anchorPrompt} onChange={(event) => setAnchorPrompt(event.target.value)} />
            <button type="button" className="role-main-action" disabled={working || !frameCamera || !anchorFrames.length || !anchorPrompt.trim() || blender?.available === false} onClick={() => void generateAnchors()}>生成写实锚点</button>
          </div>
          <div style={{ display: "flex", gap: 8 }} data-testid="motion-anchor-previews">{anchorPreviews.map((item) => <figure key={item.frame} style={{ margin: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- temporary generated Asset preview, released on close */}
            <img src={item.url} alt={`写实锚点 f${item.frame}`} style={{ height: 128, maxWidth: 160, objectFit: "contain" }} /><figcaption>f{item.frame}</figcaption>
          </figure>)}</div>
          <div className="role-section-title"><b>写实首帧（Depth → SDXL）</b></div>
          <p className="role-hint">用所选机位的 Blender 深度图控制 SDXL（{SDXL_DEPTH_FIRSTFRAME}：Juggernaut XL + ControlNet Union depth），生成保持白模空间关系的写实图，登记为素材并建首帧包，可直接发送到 H3。描述用英文效果更好；留空则按“{SDXL_DEPTH_DEFAULT_SUBJECT}”。需要本机 ComfyUI 8188 已启动。</p>
          <div className="role-create">
            <input aria-label="写实描述" placeholder="例如：a cozy study room, wooden desk and chair, warm evening light" value={realisticPrompt} maxLength={600} onChange={(event) => setRealisticPrompt(event.target.value)} />
            <button type="button" className="role-main-action" disabled={working || !frameCamera || blender?.available === false} onClick={() => void generateRealistic()}><ImageIcon size={15} />{realisticStage ? "正在生成…" : "生成写实首帧（Depth）"}</button>
          </div>
          {realisticStage && <p className="role-hint" role="status">{realisticStage}…（SDXL 首次加载模型可能需要一两分钟）</p>}
          {realisticPreview && !frameBusy && <div className="role-asset-row" style={{ alignItems: "flex-start", flexWrap: "wrap" }} data-testid="realistic-preview">
            {[["深度", realisticPreview.depthUrl], ["写实首帧", realisticPreview.imageUrl]].map(([label, url]) => <figure key={label} style={{ margin: 0, display: "grid", gap: 2, justifyItems: "center" }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- local blob: preview of the PNG just generated */}
              <img src={url} alt={`写实首帧预览 ${label}`} style={{ height: 128, maxWidth: 160, objectFit: "contain", borderRadius: 4, background: "var(--ff-bg)" }} />
              <small>{label}</small>
            </figure>)}
            <span className="role-hint" style={{ flexBasis: "100%" }} title={realisticPreview.filename}>{realisticPreview.summary} · 首帧包“{realisticPreview.packageName}”已选入下方首帧包</span>
          </div>}
          {controlsPreview && !frameBusy && <div className="role-asset-row" style={{ alignItems: "flex-start", flexWrap: "wrap" }} data-testid="controls-preview">
            {controlsPreview.items.map((item) => <figure key={item.pass} style={{ margin: 0, display: "grid", gap: 2, justifyItems: "center" }} title={item.filename}>
              {/* eslint-disable-next-line @next/next/no-img-element -- local blob: preview of the PNG just rendered */}
              <img src={item.url} alt={`控制素材预览 ${item.pass}`} style={{ height: 96, maxWidth: 120, objectFit: "contain", borderRadius: 4, background: "var(--ff-bg)" }} />
              <small>{({ rgb: "RGB", depth: "深度", mask: "遮罩", object_id: "物体 ID" } as const)[item.pass]}</small>
            </figure>)}
            <span className="role-hint" style={{ flexBasis: "100%" }}>{controlsPreview.summary}</span>
          </div>}
        </>}

        <div className="role-section-title"><b>镜头 Shot · {sceneShots.length}</b></div>
        <p className="ff-hint role-hint">镜头 = 一个生产单元：绑定状态 / 机位 / 动作 / 控制素材包，发送到 H3 后，生成的 Run 和候选视频都挂回这个镜头（和画布、镜头板用的是同一份镜头记录）。机位和动作目前只做记录，H3 只使用控制素材包。</p>
        <div className="role-create">
          <input aria-label="镜头标题" style={{ flex: "1 1 0", width: 0, minWidth: 0 }} placeholder={shotForm.editingId ? "镜头标题" : "镜头标题（留空自动编号）"} value={shotForm.title} onChange={(event) => setShotForm({ ...shotForm, title: event.target.value })} />
          <select aria-label="镜头机位" style={WIDE_SELECT_STYLE} value={shotForm.cameraId} onChange={(event) => setShotForm({ ...shotForm, cameraId: event.target.value })}>
            <option value="">机位：不绑定</option>
            {selected.cameras.map((camera) => <option key={camera.id} value={camera.id}>机位：{camera.name}</option>)}
          </select>
          <select aria-label="镜头状态" style={WIDE_SELECT_STYLE} value={shotForm.stateId} onChange={(event) => setShotForm({ ...shotForm, stateId: event.target.value })}>
            <option value="">状态：不绑定</option>
            {selected.states.map((state) => <option key={state.id} value={state.id}>状态：{state.name}</option>)}
          </select>
        </div>
        <div className="role-create">
          {([["firstId", "first_frame", "首帧包"], ["lastId", "last_frame", "尾帧包"], ["referenceId", "reference", "参考包"]] as const).map(([key, type, label]) => <select key={key} aria-label={`镜头${label}`} style={WIDE_SELECT_STYLE} value={shotForm[key]} onChange={(event) => setShotForm({ ...shotForm, [key]: event.target.value })}>
            <option value="">{label}：不使用</option>
            {packageOptions(type).map((pack) => <option key={pack.id} value={pack.id}>{label}：{pack.name}</option>)}
          </select>)}
        </div>
        {(selected.motions.length > 0 || packageOptions("guide").length > 0) && <div className="role-create" style={{ flexWrap: "wrap", gap: 12 }}>
          {selected.motions.map((motion) => <label key={motion.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ff-text-2)" }}><input type="checkbox" aria-label={`镜头动作“${motion.name}”`} style={{ width: "auto" }} checked={shotForm.motionIds.includes(motion.id)} onChange={(event) => setShotForm({ ...shotForm, motionIds: toggle(shotForm.motionIds, motion.id, event.target.checked) })} />动作：{motion.name}</label>)}
          {sortedPackages(packageOptions("guide")).map((pack) => <label key={pack.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ff-text-2)" }}><input type="checkbox" aria-label={`镜头引导锚点“${pack.name}”`} style={{ width: "auto" }} checked={shotForm.guideIds.includes(pack.id)} onChange={(event) => setShotForm({ ...shotForm, guideIds: toggle(shotForm.guideIds, pack.id, event.target.checked) })} />🧪 {pack.name}（{pack.anchorFrame !== undefined ? `f${pack.anchorFrame}` : "未设锚点"}）</label>)}
        </div>}
        <div className="role-create">
          <button type="button" className="role-main-action" disabled={working} onClick={() => void saveShot()}><Plus size={15} />{shotForm.editingId ? "保存镜头绑定" : "新建镜头"}</button>
          {shotForm.editingId && <button type="button" className="role-back" disabled={working} onClick={() => setShotForm(EMPTY_SHOT_FORM)}>取消编辑</button>}
        </div>
        {shotPreview && <p className="role-hint" style={shotPreview.ok ? undefined : { color: "var(--ff-bad)" }}>{shotPreview.text}</p>}
        {sceneShots.length ? sceneShots.map((shot) => <div key={shot.shotId}>
          <div className="role-asset-row" style={shotForm.editingId === shot.shotId ? { borderColor: "var(--ff-text-3)" } : undefined}>
            <span className="role-asset-name" title={shot.shotId}>{shotLabel(shot)}</span>
            <small>{SHOT_STATUS[shot.status]} · 生成 {shot.runIds.length} 次 · 候选 {candidateCounts[shot.shotId] ?? 0}</small>
            <button type="button" title="编辑镜头绑定" aria-label={`编辑${shotLabel(shot)}`} disabled={working} onClick={() => editShot(shot)}><Pencil size={13} /></button>
            {onSendShotToH3 && <button type="button" title={shot.sourceH3NodeId ? "打开这个镜头的 H3 节点（不存在时重新创建）" : "发送到 H3"} aria-label={`${shotLabel(shot)}发送到 H3`} disabled={working} onClick={() => void sendShot(shot)}><Send size={13} /></button>}
          </div>
          <p className="role-hint" style={NESTED}>{bindingSummary(shot.director!)}</p>
        </div>) : <p className="role-hint">这个场景还没有镜头</p>}

        {onSendToH3 && <>
          <div className="role-section-title"><b>发送到 H3</b></div>
          <p className="role-hint">在画布上新建一个 H3 节点，并把所选控制素材包里的已有素材连接为首帧 / 尾帧 / 参考；生成仍走现有 H3 流程（填写 Prompt 后点生成）。🧪 勾选的引导锚点会按锚点帧顺序串联为 AddGuide（实验能力，只支持“首帧 + 引导锚点”）。{H3_ADDGUIDE_NOTE}</p>
          <div className="role-create">
            {([["firstId", "first_frame", "首帧包"], ["lastId", "last_frame", "尾帧包"], ["referenceId", "reference", "参考包"]] as const).map(([key, type, label]) => <select key={key} aria-label={label} style={WIDE_SELECT_STYLE} value={sendForm[key]} onChange={(event) => setSendForm({ ...sendForm, [key]: event.target.value })}>
              <option value="">{label}：不使用</option>
              {packageOptions(type).map((pack) => <option key={pack.id} value={pack.id}>{label}：{pack.name}</option>)}
            </select>)}
          </div>
          {packageOptions("guide").length > 0 && <div className="role-create" style={{ flexWrap: "wrap", gap: 12 }}>
            {sortedPackages(packageOptions("guide")).map((pack) => <label key={pack.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ff-text-2)" }}><input type="checkbox" aria-label={`使用引导锚点“${pack.name}”`} style={{ width: "auto" }} checked={sendForm.guideIds.includes(pack.id)} onChange={(event) => setSendForm({ ...sendForm, guideIds: event.target.checked ? [...sendForm.guideIds, pack.id] : sendForm.guideIds.filter((id) => id !== pack.id) })} />🧪 {pack.name}（{pack.anchorFrame !== undefined ? `f${pack.anchorFrame}` : "未设锚点"}）</label>)}
          </div>}
          <div className="role-create">
            <select aria-label="场景状态" style={WIDE_SELECT_STYLE} value={sendForm.stateId} onChange={(event) => setSendForm({ ...sendForm, stateId: event.target.value })}>
              <option value="">场景状态：不记录</option>
              {selected.states.map((state) => <option key={state.id} value={state.id}>场景状态：{state.name}</option>)}
            </select>
            <button type="button" className="role-main-action" disabled={working || !handoffPreview?.ok} onClick={() => void sendToH3()}><Send size={15} />发送到 H3</button>
          </div>
          {handoffPreview && <p className="role-hint" style={handoffPreview.ok ? undefined : { color: "var(--ff-bad)" }} role="note">{handoffPreview.text}</p>}
        </>}

        <button type="button" className="role-delete" disabled={working} onClick={removeScene}><Trash2 size={14} />删除场景（素材不受影响）</button>
      </div> : <div className="role-list">
        <div className="role-create">
          <input aria-label="场景名称" placeholder="场景名称，例如：《示例项目》书房" value={sceneName} onChange={(event) => setSceneName(event.target.value)} onKeyDown={enter(() => void addScene())} />
          <button type="button" className="role-main-action" disabled={working || !sceneName.trim()} onClick={() => void addScene()}><Plus size={15} />新建场景</button>
        </div>
        {summaries === null && !error && <p className="role-hint">正在读取导演台数据…</p>}
        {summaries && (summaries.length ? <div className="role-card-grid">{summaries.map(({ scene, props, states, cameras, packages, motions }) => <button type="button" className="role-card" key={scene.id} onClick={() => openScene(scene)}><b>{scene.name}</b><small>道具 {props.length} · 状态 {states.length} · 摄影机 {cameras.length} · 动作 {motions.length} · 控制包 {packages.length}</small></button>)}</div>
          : <p className="role-hint">还没有场景。先新建一个场景，再在场景里添加道具、状态、摄影机和控制素材包。</p>)}
      </div>}
      {(error || notice) && <p className={error ? "role-error" : "role-notice"} role="status">{error || notice}</p>}
    </div>
  </div>, document.body);
}
