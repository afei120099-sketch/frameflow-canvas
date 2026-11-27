"use client";
// 3D white-box stage: room box, box / plane Props, Cameras, move / rotate / scale, camera view (V0.1-A),
// plus Motion V0.2 spatial animation: posed keyframes, a timeline that plays / scrubs them (linear
// interpolation, see lib/director-stage/motion-anim.ts) and keyframe editing in the preview.
// three.js is loaded with dynamic import() only when this panel opens (type-only imports below).
// Everything persists into the existing Director Stage records (Scene.room, Prop.geometry/transform,
// Camera.transform/focalLength/aspect, Motion.keyframes[].transform). No H3 / ComfyUI / Blender.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, Crosshair, Eye, Maximize2, Move, Pause, Play, Plus, RotateCw, SkipBack, Square, Video, X } from "lucide-react";
import type * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { TransformControls } from "three/addons/controls/TransformControls.js";
import { CAMERA_ASPECTS, MOTION_FRAME_RANGE, MOTION_NOTE, type Camera, type CameraAspect, type Motion, type MotionKeyframe, type Prop, type PropGeometry, type Room, type Scene, type Transform } from "@/lib/director-stage/schema";
import { createCamera, createMotion, createProp, getScene, listCameras, listMotions, listProps, updateCamera, updateMotion, updateProp, updateScene } from "@/lib/director-stage/store";
import { aspectRatio, DEFAULT_CAMERA_ASPECT, DEFAULT_FOCAL_LENGTH, DEFAULT_ROOM, defaultCameraTransform, defaultPropTransform, degToRad, fitAspect, focalToVerticalFov, normalizeTransform, radToDeg } from "@/lib/director-stage/whitebox";
import { drivingMotion, isSpatialMotion, MOTION_FPS, motionEndFrame, sampleMotion, upsertKeyframe } from "@/lib/director-stage/motion-anim";

type ThreeModule = typeof import("three");
type Selection = { kind: "prop" | "camera"; id: string } | null;
type Data = { scene: Scene; props: Prop[]; cameras: Camera[]; motions: Motion[] };
type Runtime = {
  T: ThreeModule; renderer: THREE.WebGLRenderer; world: THREE.Scene; orbitCamera: THREE.PerspectiveCamera;
  orbit: OrbitControls; gizmo: TransformControls; content: THREE.Group; objects: Map<string, THREE.Object3D>;
  cameras: Map<string, THREE.PerspectiveCamera>; helpers: THREE.CameraHelper[]; raf: number; dragging: boolean;
  /** Objects currently show Motion poses (not their saved placement). */
  posed: boolean;
  /** Keeps a just-dragged object where it was released until the re-read records arrive. */
  holdId: string | null;
  /** Pose when the gizmo was grabbed: a release without any change writes nothing. */
  dragStart: string | null;
  /** Releases the ResizeObserver and every listener this runtime added. */
  stop?: () => void;
};

const PANEL_STYLE: React.CSSProperties = { width: "min(1320px, 97vw)", height: "92vh", maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden" };
const BODY_STYLE: React.CSSProperties = { flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "250px minmax(0,1fr) 290px" };
const SIDE_STYLE: React.CSSProperties = { overflow: "auto", alignContent: "start" };
const TOOLBAR_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "8px 10px", borderBottom: "1px solid var(--ff-border-strong)" };
// Longhand border (no `border` shorthand): ACTIVE_BUTTON swaps only borderColor, which React must not mix with a shorthand.
const SMALL_BUTTON: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 8px", borderWidth: 1, borderStyle: "solid", borderColor: "var(--ff-border-strong)", borderRadius: 6, color: "var(--ff-text)", background: "var(--ff-control)", cursor: "pointer", fontSize: 12 };
const ACTIVE_BUTTON: React.CSSProperties = { ...SMALL_BUTTON, borderColor: "var(--ff-text-3)", background: "var(--ff-hover)", color: "#fff" };
const TINY_BUTTON: React.CSSProperties = { ...SMALL_BUTTON, padding: "2px 6px", fontSize: 11, width: "auto", height: "auto" };
const AXES = ["X", "Y", "Z"] as const;
const TRIPLE: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 4 };

async function loadData(sceneId: string): Promise<Data> {
  const scene = await getScene(sceneId);
  if (!scene) throw new Error("场景不存在");
  const [props, cameras, motions] = await Promise.all([listProps(sceneId), listCameras(sceneId), listMotions(sceneId)]);
  return { scene, props, cameras, motions };
}

function readTransform(object: THREE.Object3D, keepScale: boolean): Transform {
  return normalizeTransform({
    position: [object.position.x, object.position.y, object.position.z],
    rotation: [radToDeg(object.rotation.x), radToDeg(object.rotation.y), radToDeg(object.rotation.z)],
    scale: keepScale ? [object.scale.x, object.scale.y, object.scale.z] : [1, 1, 1],
  });
}

function applyTransform(object: THREE.Object3D, transform: Transform) {
  object.position.set(...transform.position);
  object.rotation.set(degToRad(transform.rotation[0]), degToRad(transform.rotation[1]), degToRad(transform.rotation[2]));
  object.scale.set(...transform.scale);
}

const parseFrame = (text: string) => { const value = Number(text); return text.trim() && Number.isInteger(value) && value >= MOTION_FRAME_RANGE.min && value <= MOTION_FRAME_RANGE.max ? value : null; };
const seconds = (frame: number) => (frame / MOTION_FPS).toFixed(2);

/** Numeric editor for one transform; commits on Enter / blur. Re-mounted (key) whenever the saved transform changes. */
function TransformFields({ transform, showScale, onCommit }: { transform: Transform; showScale: boolean; onCommit: (next: Transform) => void }) {
  const [draft, setDraft] = useState(transform);
  const rows: [keyof Transform, string][] = [["position", "位置 (m)"], ["rotation", "旋转 (°)"], ...(showScale ? [["scale", "尺寸 / 缩放"] as [keyof Transform, string]] : [])];
  const commit = () => { try { const next = normalizeTransform(draft); if (JSON.stringify(next) !== JSON.stringify(transform)) onCommit(next); else setDraft(transform); } catch { setDraft(transform); } };
  return <>{rows.map(([key, label]) => <label key={key}>{label}<span style={TRIPLE}>
    {AXES.map((axis, index) => <input key={axis} type="number" step={key === "rotation" ? 5 : 0.05} aria-label={`${label} ${axis}`} title={axis} value={draft[key][index]} onChange={(event) => { const values = [...draft[key]] as Transform[typeof key]; values[index] = Number(event.target.value); setDraft({ ...draft, [key]: values }); }} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />)}
  </span></label>)}</>;
}

/** One vec3 of a keyframe pose (位置 or 旋转): Enter / blur saves, Esc cancels. */
function PoseField({ label, values, step, onCommit, onCancel }: { label: string; values: [number, number, number]; step: number; onCommit: (next: [number, number, number]) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(values.map(String));
  const commit = () => { const next = draft.map(Number); if (next.every(Number.isFinite)) onCommit(next as [number, number, number]); else onCancel(); };
  return <span style={{ ...TRIPLE, paddingLeft: 12 }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(); }}>
    {AXES.map((axis, index) => <input key={axis} autoFocus={index === 0} type="number" step={step} aria-label={`${label} ${axis}`} title={`${label} ${axis}`} value={draft[index]} onChange={(event) => setDraft(draft.map((value, at) => at === index ? event.target.value : value))} onKeyDown={(event) => { if (event.key === "Enter") commit(); if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }} />)}
  </span>;
}

/**
 * Motion V0.2 editor for the selected Prop / Camera: choose the Motion, jump to a keyframe, edit its
 * position / rotation, record the object's current pose, or clear the pose (back to text-only).
 */
function MotionEditor({ targetName, motions, active, frame, disabled, readPose, onActivate, onCreate, onSave, onSeek }: {
  targetName: string; motions: Motion[]; active: Motion | null; frame: number | null; disabled: boolean;
  readPose: () => Transform | null; onActivate: (id: string) => void; onCreate: (name: string) => void;
  onSave: (motion: Motion, keyframes: MotionKeyframe[], done: string) => void; onSeek: (frame: number) => void;
}) {
  const [name, setName] = useState("");
  const [draft, setDraft] = useState({ frame: "", description: "" });
  const [editing, setEditing] = useState<{ frame: number; field: "position" | "rotation" } | null>(null);
  const poseOf = (keyframe: MotionKeyframe) => keyframe.transform ?? readPose();
  const record = () => {
    if (!active) return;
    const at = draft.frame.trim() ? parseFrame(draft.frame) : frame ?? 0;
    const pose = readPose();
    if (at === null || !pose) return;
    onSave(active, upsertKeyframe(active.keyframes, at, { description: draft.description, transform: pose }), `已在 f${at} 记录“${targetName}”的姿态`);
    setDraft({ frame: "", description: "" });
  };
  return <>
    {motions.length > 1 && <select aria-label="当前动作" value={active?.id ?? ""} onChange={(event) => onActivate(event.target.value)} style={{ ...SMALL_BUTTON, width: "100%" }}>{motions.map((motion) => <option key={motion.id} value={motion.id}>{motion.name}（{isSpatialMotion(motion) ? "空间动画" : "文字"}）</option>)}</select>}
    {active && <>
      <p className="role-hint" style={{ margin: 0 }}><b style={{ color: "var(--ff-text)" }}>{active.name}</b> · {isSpatialMotion(active) ? "空间动画" : "文字规划（还没有带位置的关键帧）"}</p>
      {active.keyframes.length ? active.keyframes.map((keyframe) => <div key={keyframe.frame}>
        <div className="role-asset-row" style={{ flexWrap: "wrap", gap: 4 }}>
          <span className="role-asset-name" title={keyframe.description} style={{ flexBasis: "100%" }}>{keyframe.transform ? "📍" : "📝"} f{keyframe.frame}（{seconds(keyframe.frame)} 秒）· {keyframe.description || "（无描述）"}</span>
          <button type="button" style={TINY_BUTTON} disabled={disabled} aria-label={`跳到 f${keyframe.frame}`} onClick={() => onSeek(keyframe.frame)}>跳到</button>
          <button type="button" style={TINY_BUTTON} disabled={disabled} aria-label={`编辑 f${keyframe.frame} 位置`} onClick={() => setEditing({ frame: keyframe.frame, field: "position" })}>位置</button>
          <button type="button" style={TINY_BUTTON} disabled={disabled} aria-label={`编辑 f${keyframe.frame} 旋转`} onClick={() => setEditing({ frame: keyframe.frame, field: "rotation" })}>旋转</button>
          <button type="button" style={TINY_BUTTON} disabled={disabled} aria-label={`f${keyframe.frame} 记录当前姿态`} title="把物体当前的位置 / 旋转 / 尺寸记到这一帧" onClick={() => { const pose = readPose(); if (pose) onSave(active, upsertKeyframe(active.keyframes, keyframe.frame, { transform: pose }), `f${keyframe.frame} 已记录当前姿态`); }}><Crosshair size={11} />记录</button>
          {keyframe.transform && <button type="button" style={TINY_BUTTON} disabled={disabled} aria-label={`清除 f${keyframe.frame} 空间数据`} title="只保留文字描述" onClick={() => onSave(active, upsertKeyframe(active.keyframes, keyframe.frame, { transform: null }), `f${keyframe.frame} 已改回文字关键帧`)}>清除</button>}
        </div>
        {editing?.frame === keyframe.frame && poseOf(keyframe) && <PoseField key={`${keyframe.frame}-${editing.field}`} label={`f${keyframe.frame} ${editing.field === "position" ? "位置 (m)" : "旋转 (°)"}`} step={editing.field === "rotation" ? 5 : 0.05} values={poseOf(keyframe)![editing.field]} onCancel={() => setEditing(null)} onCommit={(values) => {
          setEditing(null);
          const base = poseOf(keyframe)!;
          try { onSave(active, upsertKeyframe(active.keyframes, keyframe.frame, { transform: normalizeTransform({ ...base, [editing.field]: values }) }), `f${keyframe.frame} ${editing.field === "position" ? "位置" : "旋转"}已保存`); } catch { /* out of range: keep the saved pose */ }
        }} />}
      </div>) : <p className="role-hint">还没有关键帧。</p>}
      <div className="role-create" style={{ flexWrap: "wrap" }}>
        <input type="number" aria-label="新关键帧帧号" min={MOTION_FRAME_RANGE.min} max={MOTION_FRAME_RANGE.max} placeholder={`帧号（默认 ${frame ?? 0}）`} style={{ flex: "0 0 100px" }} value={draft.frame} onChange={(event) => setDraft({ ...draft, frame: event.target.value })} />
        <input aria-label="新关键帧描述" placeholder="描述，例如：开始倾斜" style={{ flex: "1 1 120px" }} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") record(); }} />
        <button type="button" className="role-main-action" disabled={disabled || (draft.frame.trim() !== "" && parseFrame(draft.frame) === null)} onClick={record}><Crosshair size={14} />记录当前姿态为关键帧</button>
      </div>
    </>}
    <div className="role-create">
      <input aria-label="新动作名称" placeholder={motions.length ? "再建一个动作…" : `动作名称，例如：${targetName}倒下`} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) { onCreate(name.trim()); setName(""); } }} />
      <button type="button" style={{ ...SMALL_BUTTON, width: "auto", flex: "none" }} disabled={disabled || !name.trim()} onClick={() => { onCreate(name.trim()); setName(""); }}><Plus size={13} />新建动作</button>
    </div>
  </>;
}

export function WhiteboxStage({ sceneId, onClose }: { sceneId: string; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [mode, setMode] = useState<"translate" | "rotate" | "scale">("translate");
  const [view, setView] = useState<string>("free");
  const [roomDraft, setRoomDraft] = useState({ width: "", depth: "", height: "" });
  /** Motion V0.2 preview: null = 布置 (saved placement); a frame = objects show their Motion poses at that frame. */
  const [animFrame, setAnimFrame] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [activeMotionId, setActiveMotionId] = useState<string | null>(null);
  /** Fractional playback position (the loop advances it in real time; animFrame is its rounded display). */
  const frameRef = useRef(0);
  const tickRef = useRef(0);

  const selectedMotions = selection ? data?.motions.filter((motion) => motion.targetId === selection.id) ?? [] : [];
  const activeMotion = selectedMotions.find((motion) => motion.id === activeMotionId) ?? selectedMotions.find(isSpatialMotion) ?? selectedMotions[0] ?? null;
  const endFrame = motionEndFrame(data?.motions ?? []);
  const timelineEnd = Math.max(120, ...(data?.motions ?? []).flatMap((motion) => motion.keyframes.map((keyframe) => keyframe.frame + 24)));
  const stateRef = useRef({ selection, view, data, animFrame, playing, endFrame, activeMotionId: activeMotion?.id ?? null });
  stateRef.current = { selection, view, data, animFrame, playing, endFrame, activeMotionId: activeMotion?.id ?? null };

  const reload = useCallback(async () => { const next = await loadData(sceneId); setData(next); return next; }, [sceneId]);
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  /** Every write goes through the existing store, then the stage re-reads it (what you see is what is saved). */
  const save = useCallback(async (action: () => Promise<unknown>, done: string) => {
    setError(""); setNotice("");
    try { await action(); await reload(); setNotice(done); } catch (cause) { fail(cause); await reload().catch(() => undefined); }
  }, [reload]);

  useEffect(() => {
    let alive = true;
    loadData(sceneId).then((next) => { if (!alive) return; setData(next); const room = next.scene.room ?? DEFAULT_ROOM; setRoomDraft({ width: String(room.width), depth: String(room.depth), height: String(room.height) }); }, (cause) => { if (alive) fail(cause); });
    return () => { alive = false; };
  }, [sceneId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !(event.target instanceof HTMLElement && event.target.closest("input, select, textarea"))) { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /** Gizmo released: in 布置 the placement is saved; in the preview the pose becomes a keyframe of the active Motion at the current frame. */
  const persistObject = useCallback((object: THREE.Object3D) => {
    const { selection: current, animFrame: frame, data: records, activeMotionId: motionId } = stateRef.current;
    if (!current) return;
    if (frame !== null) {
      const motion = records?.motions.find((item) => item.id === motionId && item.targetId === current.id);
      if (!motion) return;
      if (runtimeRef.current) runtimeRef.current.holdId = current.id;
      void save(() => updateMotion(motion.id, { keyframes: upsertKeyframe(motion.keyframes, frame, { transform: readTransform(object, current.kind === "prop") }) }), `已在 f${frame} 记录关键帧（${motion.name}）`);
      return;
    }
    if (current.kind === "prop") void save(() => updateProp(current.id, { transform: readTransform(object, true) }), "道具位置已保存");
    else void save(() => updateCamera(current.id, { transform: readTransform(object, false) }), "机位已保存");
  }, [save]);

  // three.js runtime: created once when the panel opens, disposed when it closes.
  useEffect(() => {
    let disposed = false;
    const container = containerRef.current;
    if (!container) return;
    (async () => {
      const [T, { OrbitControls: Orbit }, { TransformControls: Gizmo }] = await Promise.all([import("three"), import("three/addons/controls/OrbitControls.js"), import("three/addons/controls/TransformControls.js")]);
      if (disposed) return;
      const renderer = new T.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x101318);
      renderer.domElement.style.display = "block";
      renderer.domElement.style.margin = "0 auto";
      container.appendChild(renderer.domElement);
      const world = new T.Scene();
      world.add(new T.HemisphereLight(0xffffff, 0x445066, 1.6));
      const sun = new T.DirectionalLight(0xffffff, 1.2); sun.position.set(3, 6, 4); world.add(sun);
      const orbitCamera = new T.PerspectiveCamera(50, 1, 0.05, 500);
      orbitCamera.position.set(6, 5, 8);
      const orbit = new Orbit(orbitCamera, renderer.domElement);
      orbit.target.set(0, 1, 0); orbit.update();
      const gizmo = new Gizmo(orbitCamera, renderer.domElement);
      gizmo.setSize(0.8);
      world.add(gizmo.getHelper());
      const content = new T.Group(); world.add(content);
      const runtime: Runtime = { T, renderer, world, orbitCamera, orbit, gizmo, content, objects: new Map(), cameras: new Map(), helpers: [], raf: 0, dragging: false, posed: false, holdId: null, dragStart: null };
      const onDragging = (event: { value: unknown }) => {
        runtime.dragging = Boolean(event.value);
        orbit.enabled = !runtime.dragging && stateRef.current.view === "free";
        const pose = gizmo.object ? JSON.stringify(readTransform(gizmo.object, true)) : null;
        if (runtime.dragging) { runtime.dragStart = pose; return; }
        // A click on a handle without moving it must not write a placement / keyframe.
        if (gizmo.object && pose !== runtime.dragStart) persistObject(gizmo.object);
        runtime.dragStart = null;
      };
      gizmo.addEventListener("dragging-changed", onDragging);
      // Click (not drag) on a box / plane / camera body selects it.
      let down: { x: number; y: number } | null = null;
      const onPointerDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
      const onPointerUp = (event: PointerEvent) => {
        if (!down || runtime.dragging || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) { down = null; return; }
        down = null;
        const rect = renderer.domElement.getBoundingClientRect();
        const pointer = new T.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        const raycaster = new T.Raycaster();
        raycaster.setFromCamera(pointer, activeCamera(runtime));
        const hit = raycaster.intersectObjects([...runtime.objects.values()], true).find((item) => item.object.userData.pick);
        if (hit) setSelection(hit.object.userData.pick as Selection);
      };
      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointerup", onPointerUp);
      const resize = () => {
        const width = container.clientWidth, height = container.clientHeight;
        const viewCamera = stateRef.current.view !== "free" ? runtime.cameras.get(stateRef.current.view) : undefined;
        if (viewCamera) { const size = fitAspect(width, height, viewCamera.aspect); renderer.setSize(size.width, size.height); }
        else { renderer.setSize(width, height); orbitCamera.aspect = width / Math.max(1, height); orbitCamera.updateProjectionMatrix(); }
      };
      const observer = new ResizeObserver(resize); observer.observe(container);
      const loop = () => {
        advancePlayback();
        applyPoses(runtime);
        resize();
        for (const helper of runtime.helpers) helper.update();
        renderer.render(world, activeCamera(runtime));
        runtime.raf = requestAnimationFrame(loop);
      };
      runtimeRef.current = runtime;
      runtime.raf = requestAnimationFrame(loop);
      setReady(true);
      runtime.stop = () => {
        observer.disconnect();
        gizmo.removeEventListener("dragging-changed", onDragging);
        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        renderer.domElement.removeEventListener("pointerup", onPointerUp);
      };
    })().catch(fail);
    return () => {
      disposed = true;
      const runtime = runtimeRef.current;
      if (!runtime) return;
      cancelAnimationFrame(runtime.raf);
      runtime.stop?.();
      runtime.gizmo.detach(); runtime.gizmo.dispose(); runtime.orbit.dispose();
      runtime.world.traverse((object) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose?.(); const material = mesh.material as THREE.Material | THREE.Material[] | undefined; (Array.isArray(material) ? material : material ? [material] : []).forEach((item) => item.dispose()); });
      runtime.renderer.dispose(); runtime.renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, [persistObject]);

  function activeCamera(runtime: Runtime) {
    const view = stateRef.current.view;
    return (view !== "free" && runtime.cameras.get(view)) || runtime.orbitCamera;
  }

  /** Real-time playback at 24 FPS (frame time from the clock, so a throttled tab still plays at the right speed). */
  function advancePlayback() {
    const { playing: isPlaying, endFrame: end, animFrame: shown } = stateRef.current;
    if (!isPlaying) return;
    const now = performance.now();
    frameRef.current = Math.min(end, frameRef.current + ((now - tickRef.current) / 1000) * MOTION_FPS);
    tickRef.current = now;
    const rounded = Math.round(frameRef.current);
    if (rounded !== shown) setAnimFrame(rounded);
    if (frameRef.current >= end) setPlaying(false);
  }

  /** Preview: every object driven by a posed Motion shows its interpolated pose; 布置 restores the saved placement once. */
  function applyPoses(runtime: Runtime) {
    const { data: records, animFrame: shown, playing: isPlaying, selection: current, activeMotionId: motionId } = stateRef.current;
    if (!records) return;
    if (shown === null && !runtime.posed) return;
    const frame = shown === null ? null : isPlaying ? frameRef.current : shown;
    for (const [id, object] of runtime.objects) {
      if ((runtime.dragging && runtime.gizmo.object === object) || runtime.holdId === id) continue;
      const camera = runtime.cameras.has(id);
      const base = camera ? records.cameras.find((item) => item.id === id)?.transform : records.props.find((item) => item.id === id)?.transform;
      const motion = frame === null ? null : drivingMotion(records.motions, id, current?.id === id ? motionId : null);
      const pose = motion && frame !== null ? sampleMotion(motion.keyframes, frame) : null;
      const target = pose ?? base;
      if (target) applyTransform(object, camera ? { ...target, scale: [1, 1, 1] } : target);
    }
    runtime.posed = frame !== null;
  }

  // Rebuild the 3D content from the saved records whenever they change.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!ready || !runtime || !data) return;
    const { T, content, objects, cameras, gizmo } = runtime;
    gizmo.detach();
    runtime.holdId = null;
    runtime.posed = true; // re-apply poses / placement onto the fresh objects
    for (const helper of runtime.helpers) { runtime.world.remove(helper); helper.dispose(); }
    runtime.helpers = [];
    content.traverse((object) => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose?.(); const material = mesh.material as THREE.Material | undefined; material?.dispose?.(); });
    content.clear(); objects.clear(); cameras.clear();
    const edges = (geometry: THREE.BufferGeometry, color: number) => new T.LineSegments(new T.EdgesGeometry(geometry), new T.LineBasicMaterial({ color }));
    if (data.scene.room) {
      const { width, depth, height } = data.scene.room;
      const geometry = new T.BoxGeometry(width, height, depth);
      const room = new T.Mesh(geometry, new T.MeshLambertMaterial({ color: 0x8d929c, side: T.BackSide }));
      room.position.y = height / 2;
      room.add(edges(geometry, 0x5d6370));
      content.add(room);
      const grid = new T.GridHelper(Math.max(width, depth), Math.round(Math.max(width, depth) * 2), 0x6d7380, 0x4a505b);
      grid.position.y = 0.002;
      content.add(grid);
    }
    for (const prop of data.props) {
      if (!prop.geometry || !prop.transform) continue;
      // Box origin = bottom centre, so scaling keeps it standing on the floor (see defaultPropTransform).
      const geometry = prop.geometry === "plane" ? new T.PlaneGeometry(1, 1) : new T.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
      const selected = selection?.kind === "prop" && selection.id === prop.id;
      const mesh = new T.Mesh(geometry, new T.MeshLambertMaterial({ color: prop.geometry === "plane" ? 0xc9d2da : 0xdcd8cf, side: T.DoubleSide, emissive: selected ? 0x3b2f6b : 0x000000 }));
      mesh.add(edges(geometry, selected ? 0xb69cff : 0x30343c));
      mesh.userData.pick = { kind: "prop", id: prop.id };
      applyTransform(mesh, prop.transform);
      content.add(mesh); objects.set(prop.id, mesh);
    }
    for (const camera of data.cameras) {
      if (!camera.transform) continue;
      const aspect = aspectRatio(camera.aspect ?? DEFAULT_CAMERA_ASPECT);
      const lens = new T.PerspectiveCamera(focalToVerticalFov(camera.focalLength ?? DEFAULT_FOCAL_LENGTH), aspect, 0.05, 200);
      applyTransform(lens, camera.transform);
      const selected = selection?.kind === "camera" && selection.id === camera.id;
      const body = new T.Mesh(new T.BoxGeometry(0.18, 0.12, 0.24), new T.MeshLambertMaterial({ color: selected ? 0xb69cff : 0x5fb7ff }));
      body.position.z = 0.12;
      body.userData.pick = { kind: "camera", id: camera.id };
      lens.add(body);
      content.add(lens); objects.set(camera.id, lens); cameras.set(camera.id, lens);
      // The frustum marker uses a short display-only copy (1 m deep); the real lens keeps its far plane for the camera view.
      if (view !== camera.id) { const marker = new T.PerspectiveCamera(lens.fov, lens.aspect, 0.05, 1); lens.add(marker); const helper = new T.CameraHelper(marker); runtime.world.add(helper); runtime.helpers.push(helper); }
      body.visible = view !== camera.id;
    }
  }, [ready, data, selection, view]);

  // Gizmo mode / attachment, view camera and orbit follow the toolbar. In the preview the gizmo records
  // keyframes, so it only attaches to an object with a Motion, and never while playing.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!ready || !runtime) return;
    const cameraSelected = selection?.kind === "camera";
    runtime.gizmo.setMode(cameraSelected && mode === "scale" ? "translate" : mode);
    runtime.gizmo.camera = activeCamera(runtime);
    runtime.orbit.enabled = view === "free";
    const target = selection ? runtime.objects.get(selection.id) : undefined;
    const editable = target && !playing && (animFrame === null || Boolean(activeMotion));
    if (!editable) { if (runtime.gizmo.object) runtime.gizmo.detach(); }
    else if (runtime.gizmo.object !== target) runtime.gizmo.attach(target);
  });

  const scene = data?.scene;
  const selectedProp = selection?.kind === "prop" ? data?.props.find((prop) => prop.id === selection.id) : undefined;
  const selectedCamera = selection?.kind === "camera" ? data?.cameras.find((camera) => camera.id === selection.id) : undefined;
  const placedCameras = data?.cameras.filter((camera) => camera.transform) ?? [];
  const previewing = animFrame !== null;

  /* Timeline */
  const seek = (frame: number) => { setPlaying(false); frameRef.current = frame; setAnimFrame(frame); };
  const togglePlay = () => {
    if (playing) { setPlaying(false); return; }
    if (!endFrame) { setError(""); setNotice("还没有带位置的关键帧：先在右侧“动作”里记录姿态，再播放预览"); return; }
    const start = animFrame === null || animFrame >= endFrame ? 0 : animFrame;
    frameRef.current = start; tickRef.current = performance.now();
    setAnimFrame(start); setPlaying(true);
  };
  const exitPreview = () => { setPlaying(false); setAnimFrame(null); };
  const readPose = () => { const object = selection ? runtimeRef.current?.objects.get(selection.id) : undefined; return object ? readTransform(object, selection?.kind === "prop") : null; };

  const saveRoom = (room: Room | null) => {
    const next = room ?? { width: Number(roomDraft.width), depth: Number(roomDraft.depth), height: Number(roomDraft.height) };
    void save(() => updateScene(sceneId, { room: next }), scene?.room ? "房间尺寸已保存" : "已创建房间");
    setRoomDraft({ width: String(next.width), depth: String(next.depth), height: String(next.height) });
  };
  const addProp = (geometry: PropGeometry) => {
    if (!data) return;
    const count = data.props.filter((prop) => prop.geometry === geometry).length;
    const name = `${geometry === "plane" ? "平面" : "方盒"} ${count + 1}`;
    void save(async () => { const prop = await createProp({ sceneId, name, type: geometry, geometry, transform: defaultPropTransform(geometry, data.props.length) }); setSelection({ kind: "prop", id: prop.id }); }, `已添加${name}`);
  };
  const placeProp = (prop: Prop, geometry: PropGeometry) => void save(async () => { await updateProp(prop.id, { geometry, transform: defaultPropTransform(geometry, data?.props.indexOf(prop) ?? 0) }); setSelection({ kind: "prop", id: prop.id }); }, `已把“${prop.name}”放入白模`);
  const addCamera = () => {
    if (!data) return;
    const name = `机位 ${data.cameras.length + 1}`;
    void save(async () => { const camera = await createCamera({ sceneId, name, transform: defaultCameraTransform(scene?.room ?? DEFAULT_ROOM, data.cameras.length), focalLength: DEFAULT_FOCAL_LENGTH, aspect: DEFAULT_CAMERA_ASPECT }); setSelection({ kind: "camera", id: camera.id }); }, `已添加${name}`);
  };
  const placeCamera = (camera: Camera) => void save(async () => { await updateCamera(camera.id, { transform: defaultCameraTransform(scene?.room ?? DEFAULT_ROOM, data?.cameras.indexOf(camera) ?? 0), focalLength: camera.focalLength ?? DEFAULT_FOCAL_LENGTH, aspect: camera.aspect ?? DEFAULT_CAMERA_ASPECT }); setSelection({ kind: "camera", id: camera.id }); }, `已把“${camera.name}”放入白模`);
  const createTargetMotion = (name: string) => {
    if (!selection) return;
    void save(async () => { const motion = await createMotion({ sceneId, name, targetType: selection.kind, targetId: selection.id, keyframes: [] }); setActiveMotionId(motion.id); }, `已新建动作“${name}”`);
  };

  const objectRow = (kind: "prop" | "camera", item: Prop | Camera, placed: boolean, label: string, onPlace: () => void) => {
    const active = selection?.kind === kind && selection.id === item.id;
    const motions = data?.motions.filter((motion) => motion.targetId === item.id) ?? [];
    return <div className="role-asset-row" key={item.id} style={active ? { borderColor: "var(--ff-text-3)", background: "var(--ff-hover)" } : undefined}>
      <button type="button" style={{ flex: 1, minWidth: 0, width: "auto", height: "auto", display: "block", textAlign: "left", color: "inherit", background: "transparent", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} disabled={!placed} title={placed ? `选择“${item.name}”` : "尚未放入白模"} aria-label={`选择${kind === "camera" ? "摄影机" : "道具"}“${item.name}”`} onClick={() => setSelection({ kind, id: item.id })}>{item.name}</button>
      <small>{label}{motions.length ? ` · 动作 ${motions.length}${motions.some(isSpatialMotion) ? " 📍" : ""}` : ""}</small>
      {!placed && <button type="button" style={{ ...SMALL_BUTTON, width: "auto" }} onClick={onPlace}>放入白模</button>}
    </div>;
  };

  return createPortal(<div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onWheel={(event) => event.stopPropagation()}>
    <div className="generation-info-panel" role="dialog" aria-modal="true" aria-label="白模导演台" style={PANEL_STYLE} onPointerDown={(event) => event.stopPropagation()}>
      <header><div><small className="ff-hint">Director Stage · 3D 白模 · Motion V0.2 空间动画 · 空间 / 机位 / 构图 / 动作预览</small><h2>{scene ? `${scene.name} · 白模导演台` : "白模导演台"}</h2></div><button type="button" title="关闭" aria-label="关闭白模导演台" onClick={onClose}><X size={17} /></button></header>
      <div style={BODY_STYLE}>
        <div className="role-detail" style={SIDE_STYLE}>
          <div className="role-section-title"><b>房间（米）</b></div>
          <span style={TRIPLE}>
            {(["width", "depth", "height"] as const).map((key) => <input key={key} type="number" step={0.1} min={0.5} aria-label={`房间${({ width: "宽", depth: "深", height: "高" })[key]}`} title={({ width: "宽 X", depth: "深 Z", height: "高 Y" })[key]} value={roomDraft[key]} onChange={(event) => setRoomDraft({ ...roomDraft, [key]: event.target.value })} />)}
          </span>
          <button type="button" className="role-main-action" disabled={!data} onClick={() => saveRoom(null)}><Box size={15} />{scene?.room ? "更新房间尺寸" : "创建房间盒子"}</button>
          {!scene?.room && <p className="role-hint">宽 × 深 × 高，默认 {DEFAULT_ROOM.width} × {DEFAULT_ROOM.depth} × {DEFAULT_ROOM.height} 米，地面中心为原点。</p>}
          <div className="role-section-title"><b>道具 · {data?.props.length ?? 0}</b></div>
          <span style={{ display: "flex", gap: 6 }}><button type="button" style={{ ...SMALL_BUTTON, width: "auto" }} disabled={!data} onClick={() => addProp("box")}><Box size={13} />方盒</button><button type="button" style={{ ...SMALL_BUTTON, width: "auto" }} disabled={!data} onClick={() => addProp("plane")}><Square size={13} />平面</button></span>
          {data?.props.map((prop) => objectRow("prop", prop, Boolean(prop.geometry && prop.transform), prop.geometry === "plane" ? "平面" : prop.geometry === "box" ? "方盒" : "未放入", () => placeProp(prop, "box")))}
          <div className="role-section-title"><b>摄影机 · {data?.cameras.length ?? 0}</b></div>
          <button type="button" style={{ ...SMALL_BUTTON, width: "auto", justifySelf: "start" }} disabled={!data} onClick={addCamera}><Video size={13} />添加摄影机</button>
          {data?.cameras.map((camera) => objectRow("camera", camera, Boolean(camera.transform), camera.transform ? `${camera.focalLength ?? DEFAULT_FOCAL_LENGTH}mm · ${camera.aspect ?? DEFAULT_CAMERA_ASPECT}` : "未放入", () => placeCamera(camera)))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, borderLeft: "1px solid var(--ff-border-strong)", borderRight: "1px solid var(--ff-border-strong)" }}>
          <div style={TOOLBAR_STYLE}>
            <button type="button" style={mode === "translate" ? ACTIVE_BUTTON : SMALL_BUTTON} onClick={() => setMode("translate")}><Move size={13} />移动</button>
            <button type="button" style={mode === "rotate" ? ACTIVE_BUTTON : SMALL_BUTTON} onClick={() => setMode("rotate")}><RotateCw size={13} />旋转</button>
            <button type="button" style={mode === "scale" ? ACTIVE_BUTTON : SMALL_BUTTON} disabled={selection?.kind === "camera"} title={selection?.kind === "camera" ? "摄影机不缩放" : "缩放"} onClick={() => setMode("scale")}><Maximize2 size={13} />缩放</button>
            <span style={{ width: 1, height: 20, background: "#414141", margin: "0 4px" }} />
            <button type="button" style={view === "free" ? ACTIVE_BUTTON : SMALL_BUTTON} onClick={() => setView("free")}><Eye size={13} />自由视角</button>
            <select aria-label="机位视角" value={view === "free" ? "" : view} onChange={(event) => setView(event.target.value || "free")} style={{ ...SMALL_BUTTON, paddingRight: 4 }}>
              <option value="">机位视角…</option>
              {placedCameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}（{camera.focalLength ?? DEFAULT_FOCAL_LENGTH}mm · {camera.aspect ?? DEFAULT_CAMERA_ASPECT}）</option>)}
            </select>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ff-text-2)" }}>{previewing ? "动作预览：拖动手柄 = 在当前帧记录关键帧" : view === "free" ? "拖动旋转视角 · 滚轮缩放 · 点击物体选中" : "机位视角：画面即该机位构图"}</span>
          </div>
          <div ref={containerRef} data-testid="whitebox-viewport" style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--ff-bg)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
            {!ready && !error && <p className="role-hint" style={{ position: "absolute" }}>正在加载 3D…</p>}
          </div>
          <div style={{ ...TOOLBAR_STYLE, borderBottom: 0, borderTop: "1px solid var(--ff-border-strong)" }}>
            <button type="button" style={playing ? ACTIVE_BUTTON : SMALL_BUTTON} aria-label={playing ? "暂停" : "播放预览"} onClick={togglePlay}>{playing ? <><Pause size={13} />暂停</> : <><Play size={13} />播放预览</>}</button>
            <button type="button" style={SMALL_BUTTON} aria-label="回到第 0 帧" title="回到第 0 帧" onClick={() => seek(0)}><SkipBack size={13} /></button>
            <input type="range" aria-label="时间线帧号" min={0} max={timelineEnd} step={1} value={animFrame ?? 0} onChange={(event) => seek(Number(event.target.value))} style={{ flex: "1 1 160px", minWidth: 120, accentColor: "var(--ff-white)" }} />
            <span style={{ fontSize: 12, color: previewing ? "var(--ff-text)" : "var(--ff-text-2)", minWidth: 150 }} aria-label="当前帧">{previewing ? `f${animFrame} / ${endFrame} · ${seconds(animFrame!)} 秒` : `布置模式 · 动画共 ${endFrame} 帧`}</span>
            {previewing && <button type="button" style={SMALL_BUTTON} onClick={exitPreview}>退出预览</button>}
          </div>
        </div>
        <div className="role-detail" style={SIDE_STYLE}>
          <div className="role-section-title"><b>{selectedProp ? `道具：${selectedProp.name}` : selectedCamera ? `摄影机：${selectedCamera.name}` : "未选中"}</b></div>
          {!selectedProp && !selectedCamera && <p className="ff-hint role-hint">在左侧列表或 3D 视图里点击一个方盒 / 平面 / 机位。拖动手柄或直接改数字，松开 / 回车即保存。</p>}
          {previewing && (selectedProp || selectedCamera) && <p className="role-hint">动作预览中：上方数值是布置位置，已隐藏；请在下方关键帧里编辑位置 / 旋转，或拖动手柄记录当前帧。</p>}
          {!previewing && selectedProp?.transform && <TransformFields key={`${selectedProp.id}-${JSON.stringify(selectedProp.transform)}`} transform={selectedProp.transform} showScale onCommit={(transform) => void save(() => updateProp(selectedProp.id, { transform }), "道具位置已保存")} />}
          {selectedCamera?.transform && <>
            {!previewing && <TransformFields key={`${selectedCamera.id}-${JSON.stringify(selectedCamera.transform)}`} transform={selectedCamera.transform} showScale={false} onCommit={(transform) => void save(() => updateCamera(selectedCamera.id, { transform }), "机位已保存")} />}
            <label>焦距（mm，全画幅等效）<input type="number" min={8} max={300} step={1} aria-label="焦距" defaultValue={selectedCamera.focalLength ?? DEFAULT_FOCAL_LENGTH} key={`${selectedCamera.id}-${selectedCamera.focalLength}`} onBlur={(event) => { const value = Number(event.target.value); if (value !== (selectedCamera.focalLength ?? DEFAULT_FOCAL_LENGTH)) void save(() => updateCamera(selectedCamera.id, { focalLength: value }), "焦距已保存"); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
            <label>画幅<select aria-label="画幅" value={selectedCamera.aspect ?? DEFAULT_CAMERA_ASPECT} onChange={(event) => void save(() => updateCamera(selectedCamera.id, { aspect: event.target.value as CameraAspect }), "画幅已保存")} style={{ ...SMALL_BUTTON, width: "100%" }}>{CAMERA_ASPECTS.map((aspect) => <option key={aspect} value={aspect}>{aspect}</option>)}</select></label>
            <button type="button" className="role-main-action" onClick={() => setView(selectedCamera.id)}><Video size={15} />切到这个机位视角</button>
          </>}
          {(selectedProp?.transform || selectedCamera?.transform) && <>
            <div className="role-section-title"><b>动作 Motion · {selectedMotions.length}</b></div>
            <MotionEditor key={selection?.id} targetName={(selectedProp ?? selectedCamera)!.name} motions={selectedMotions} active={activeMotion} frame={animFrame} disabled={playing} readPose={readPose}
              onActivate={setActiveMotionId} onCreate={createTargetMotion} onSeek={seek}
              onSave={(motion, keyframes, done) => void save(() => updateMotion(motion.id, { keyframes }), done)} />
            <p className="role-hint">📍 带位置的关键帧参与播放（位置 / 尺寸线性插值，旋转走较近的方向）；📝 旧的文字关键帧保持文字规划。{MOTION_NOTE}</p>
          </>}
        </div>
      </div>
      {(error || notice) && <p className={error ? "role-error" : "role-notice"} role="status" style={{ margin: "8px 16px" }}>{error || notice}</p>}
    </div>
  </div>, document.body);
}
