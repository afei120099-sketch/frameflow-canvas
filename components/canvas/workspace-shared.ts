import type React from "react";
import { H3_NEW_LAYOUT_META, H3_NEW_NODE_HEIGHT, H3_NEW_NODE_WIDTH } from "@/lib/h3-node-layout-policy";
import { type CapturedVideoFrame, videoFrameHandoffPatch } from "@/lib/video-frame-handoff";
import { resolveCandidatePreview } from "@/lib/candidate-preview";
import { type AssetRecord, type ShotRecord, createShot, ensureLegacyAsset, getAsset, getAssetBySource, getShot, getShotAssetVersions, getShotCandidates, linkShotToH3Node } from "@/lib/production-records";
import { type H3DialogueLine } from "@/lib/h3-dialogue";
import { parseCommunityValues } from "@/lib/comfyui/experimental/h3-community-controls";
import { communitySettings, isCommunityWorkflow } from "@/lib/h3-workflow-options";
import { Editor, TLArrowShape, TLBaseShape, type TLShape, createShapeId, getArrowBindings } from "tldraw";
import { type TimeAnchorProp } from "@/components/canvas/time-anchor-editor";
import { type StoryboardGuide } from "@/lib/storyboard-guides";
import { showCanvasToast } from "@/components/canvas/canvas-events";
import { customTypes } from "@/lib/canvas-node-types";
import { runTailFrameHD } from "@/components/canvas/tail-frame-hd-inline";
import { originalTailPNG } from "@/lib/tail-frame-hd-job";
import { type DirectorNodeContext } from "@/lib/director-stage/h3-handoff";
import { acquireMediaUrl, extractVideoFirstFrame, extractVideoLastFrame, getLocalAudioBlob, getLocalImageBlob, getLocalVideoBlob, readVideoDurationSeconds, releaseMediaUrl, storeLocalImage } from "@/lib/local-video-store";
import { downloadSavedMedia } from "@/lib/media-download";
import { videoNodeSize } from "@/lib/media-node-layout";
import { type H3TaskMode } from "@/lib/h3-task-mode";
import { type H3SoundMode } from "@/lib/comfyui/h3-prompt";
import { type H3GenerationSettings } from "@/lib/ai-adapter";
import { tailVideoBindings } from "@/lib/video-continuation";
import { type FluxImageNode } from "@/components/canvas/flux-image-node";
import { H3_FPS, H3_LORA_STRENGTH, H3_MAX_MEGAPIXELS, H3_MEGAPIXELS, H3_MIN_MEGAPIXELS, H3_NON_TURBO_STEPS, H3_RESOLUTION_STEPS, H3_STEPS, H3_TURBO, H3_UPSCALE_METHOD, getActualDuration, isH3Aspect, lengthToSeconds } from "@/lib/comfyui/h3-parameters";

export type ImageNode = TLBaseShape<"image-node", { w: number; h: number; src: string; name: string; originalPath: string; naturalWidth?: number; naturalHeight?: number; assetId?: string }>;
export type H3Node = TLBaseShape<"h3-node", {
  w: number;
  h: number;
  prompt: string;
  promptHeight?: number;
  mode: string;
  duration: string;
  seedMode: string;
  generationCount?: number;
  workflowOptionId?: string;
  /** Set by the shot queue. Idle migration must not replace this node's stable Ref2VA route. */
  workflowLock?: string;
  communityParameters?: string;
  allReferenceMode?: boolean;
  extensionSourceVideo?: { src: string; name: string };
  seed: string;
  megapixels?: number;
  turbo?: boolean;
  steps?: number;
  fps?: number;
  loraStrength?: number;
  upscaleMethod?: string;
  resolutionSteps?: number;
  collapsed?: boolean;
  videoFirstFrame?: CapturedVideoFrame;
  videoLastFrame?: CapturedVideoFrame;
  inheritedLastFrame?: {src: string; name: string};
  inheritedVideo?: { src: string; name: string; assetId: string; runId?: string; width?: number; height?: number };
  sourceFrameSrc?: string;
  sourceFrameName?: string;
  sourceH3Id?: string;
  previewAssetId?: string;
  previewWidth?: number;
  previewHeight?: number;
  soundMode?: H3SoundMode;
  referenceImages?: { src: string; name: string }[];
  referenceImageOrder?: string[];
  referenceVideos?: { src: string; name: string; withAudio?: boolean }[];
  referenceAudios?: { src: string; name: string }[];
  storyboardGuides?: StoryboardGuide[];
  /** 🧪 h3_ultimate_guide: node time anchors (ultimate / fast only). Separate from storyboardGuides on purpose. */
  timeAnchors?: TimeAnchorProp[];
  lastSubmittedPrompt?: string;
  lockedRunId?: string;
  lockedAssetId?: string;
  lastSubmittedSeed?: number;
  shotId?: string;
  /** Ref2VA: Roles chosen on this node (selection order = Subject order) and minimal dialogue. */
  roleIds?: string[];
  dialogueLines?: H3DialogueLine[];
  voiceRoleId?: string;
  /** 🧪 plain 声音路：说话角色按开口顺序，每人送主声音（lib/voice-roles.ts）。 */
  voiceRoleIds?: string[];
  autoVoiceDisabled?: boolean;
  offscreenRoleIds?: string[];
  noBackgroundMusic?: boolean;
  /** 出片后自动去配乐 (default on). Recorded on each Run at submission; only new outputs are processed. */
  autoRemoveMusic?: boolean;
  roleSnapshot?: string;
  shotTitle?: string;
  promptMode?: string;
  /** 🧪 Hybrid: lock the first frame exactly while also using references (interface only). */
  hybridLock?: boolean;
  ultimateKeyframes?: boolean;
  /** Set when 导演台 → 发送到 H3 created this node; copied into each Run as Run.directorContext. */
  directorContext?: DirectorNodeContext;
  /** 正本版本号（队列入队时读的）；提交时写进 Run.zhengbenVersion。手建的节点没有，提交时现读。 */
  zhengbenVersion?: string;
}>;
export type VideoNode = TLBaseShape<"video-node", { w: number; h: number; src: string; name: string; size: string; duration: string; originalPath: string; sceneNumber?: number; fps?: number; origin?: "smooth" | "rough"; assetId?: string; runId?: string; shotId?: string }>;
export type AudioNode = TLBaseShape<"audio-node", { w: number; h: number; src: string; name: string; duration: number; assetId: string; sourceVideoAssetId?: string; sourceAudioAssetId?: string; trimOpen?: boolean }>;
export type UpscaleNode = TLBaseShape<"upscale-node", { w: number; h: number; clipMode: "whole" | "clip" | "segmented"; start: number; duration: number; collapsed?: boolean; autoHeight?: boolean; targetResolution?: string; withInterpolation?: boolean; upscaleProfile?: "safe" | "quality"; autoStart?: boolean }>;
export type SmoothNode = TLBaseShape<"smooth-node", { w: number; h: number; autoHeight?: boolean }>;
export type CustomNode = ImageNode | H3Node | VideoNode | AudioNode | UpscaleNode | SmoothNode | FluxImageNode;
export type Point = { x: number; y: number };

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    "image-node": ImageNode["props"];
    "h3-node": H3Node["props"];
    "video-node": VideoNode["props"];
    "audio-node": AudioNode["props"];
    "upscale-node": UpscaleNode["props"];
    "smooth-node": SmoothNode["props"];
  }
}

export const H3_DEFAULT_HEIGHT = H3_NEW_NODE_HEIGHT;
export const H3_NODE_WIDTH = H3_NEW_NODE_WIDTH;

export const fittedVideoSize = (editor: Editor, width: number, height: number) => videoNodeSize(width, height, Math.max(300, editor.getViewportPageBounds().h - 130));
export const H3_INPUT_ANCHORS = { first: 0.16, last: 0.25, reference: 0.34 } as const;
export type H3FrameRole = keyof typeof H3_INPUT_ANCHORS;
export const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation();

export const downloadNodeMedia = (source: string, name: string, kind: "image" | "video" | "audio") => { void downloadSavedMedia(source, name, kind).catch((cause) => showCanvasToast(cause instanceof Error ? cause.message : "媒体下载失败")); };

export async function assetForSource(source: string, kind: "image" | "video" | "audio", name: string, details: Partial<Pick<AssetRecord, "width" | "height" | "duration" | "fps" | "fileSize">> = {},signal?:AbortSignal) {
  const existing = source.startsWith("data:") ? null : await getAssetBySource(source);
  signal?.throwIfAborted();if (existing) return existing;
  const blob = kind === "image" ? await getLocalImageBlob(source) : kind === "audio" && source.startsWith("audio:") ? await getLocalAudioBlob(source) : await getLocalVideoBlob(source);
  return ensureLegacyAsset(source, kind, name, { fileSize: blob.size, ...details }, blob.type,signal);
}
export async function referenceBlob(source: string, kind: "image" | "video" | "audio", filename: string) {
  try { return kind === "image" ? await getLocalImageBlob(source) : kind === "audio" && source.startsWith("audio:") ? await getLocalAudioBlob(source) : await getLocalVideoBlob(source); }
  catch { throw new Error(`引用素材已失效：${filename}`); }
}

export function displayVideoAsset(editor: Editor, video: VideoNode, asset: AssetRecord) {
  const fitted = asset.width && asset.height ? fittedVideoSize(editor, asset.width, asset.height) : { w: video.props.w, h: video.props.h };
  editor.updateShape({ id: video.id, type: "video-node", x: video.x + (video.props.w - fitted.w) / 2, y: video.y + (video.props.h - fitted.h) / 2, props: { ...fitted, src: asset.storageReference, name: asset.filename, size: formatBytes(asset.fileSize ?? 0), duration: asset.duration ? `${asset.duration.toFixed(1)} 秒` : video.props.duration, originalPath: asset.filename, fps: asset.fps, assetId: asset.assetId, runId: asset.sourceRunId ?? undefined, shotId: asset.shotId } });
}
export function findShotDisplay(editor: Editor, shotId: string, h3Id?: H3Node["id"]) {
  const linked = h3Id ? getOutgoingTargets(editor, h3Id, "video-node") as VideoNode[] : [];
  return linked.find((video) => video.props.shotId === shotId) ?? editor.getCurrentPageShapes().find((candidate): candidate is VideoNode => candidate.type === "video-node" && candidate.props.shotId === shotId && (!h3Id || getIncomingSource(editor, candidate.id, "h3-node")?.id === h3Id));
}

export function sourceH3ForDerived(editor: Editor, start: TLShape["id"], seen = new Set<string>()): H3Node | undefined {
  if (seen.has(start)) return;
  seen.add(start);
  const shape = editor.getShape(start);
  if (shape?.type === "h3-node") return shape as H3Node;
  for (const arrow of editor.getCurrentPageShapes()) {
    if (arrow.type !== "arrow") continue;
    const bindings = getArrowBindings(editor, arrow as TLArrowShape);
    if (bindings.end?.toId !== start || !bindings.start) continue;
    const source = sourceH3ForDerived(editor, bindings.start.toId, seen);
    if (source) return source;
  }
}
/** Upgrade an existing HD/interpolation result in place. Media/Run ownership stays untouched. */

export function getWorkflowMidpoint(fromShape: CustomNode, toShape: CustomNode) {
  const horizontalGap = toShape.x - (fromShape.x + fromShape.props.w);
  if (horizontalGap < 90) return 0.42;
  if (horizontalGap > 420) return 0.56;
  return 0.5;
}

export function referenceImageOf(shape: TLShape | undefined): ImageNode | undefined {
  if (shape?.type === "image-node") return shape as ImageNode;
  if (shape?.type !== "flux-image-node") return;
  const flux = shape as FluxImageNode;
  if (!flux.props.src) return;
  const adopted = flux.props.candidates?.find(c => c.assetId && c.assetId === flux.props.adoptedAssetId);
  const [width, height] = flux.props.size.split("x").map(Number);
  return { ...flux, type: "image-node", props: { w: flux.props.w, h: flux.props.h, src: adopted?.src ?? flux.props.src, assetId: adopted?.assetId ?? flux.props.assetId, name: adopted?.filename ?? flux.props.filename, originalPath: adopted?.filename ?? flux.props.filename, naturalWidth: adopted?.width ?? flux.props.resultWidth ?? width, naturalHeight: adopted?.height ?? flux.props.resultHeight ?? height } } as ImageNode;
}

export function isCompatibleConnection(source: TLShape | undefined, target: TLShape | undefined) {
  if (!source || !target || source.id === target.id) return false;
  if (referenceImageOf(source)) return target.type === "h3-node" || target.type === "flux-image-node";
  if (source.type === "h3-node") return target.type === "video-node" || target.type === "h3-node" || target.type === "upscale-node" || target.type === "smooth-node";
  if (source.type === "video-node") return target.type === "h3-node" || target.type === "upscale-node" || target.type === "smooth-node" || target.type === "audio-node";
  if (source.type === "audio-node") return target.type === "audio-node";
  if (source.type === "upscale-node") return target.type === "video-node" || (target.type === "h3-node" && Boolean(target.props.inheritedVideo));
  if (source.type === "smooth-node") return target.type === "video-node" || (target.type === "h3-node" && Boolean(target.props.inheritedVideo));
  return false;
}

export function createBoundArrow(editor: Editor, fromShape: CustomNode, toShape: CustomNode, frameRole: H3FrameRole = "first") {
  if (!isCompatibleConnection(fromShape, toShape)) throw new Error("节点连接类型不兼容");
  const arrowId = createShapeId();
  if (toShape.type === "flux-image-node") {
    editor.deleteShapes(editor.getBindingsToShape(toShape.id, "arrow").filter(b => b.props.terminal === "end").map(b => b.fromId));
    editor.updateShape({ id: toShape.id, type: "flux-image-node", props: { imageMode: true } });
  }
  if (toShape.type === "h3-node" && fromShape.type === "image-node" && frameRole !== "reference") editor.updateShape({ id: toShape.id, type: "h3-node", props: frameRole === "first" ? { videoFirstFrame: undefined, sourceFrameSrc: "", sourceFrameName: "" } : { videoLastFrame: undefined, inheritedLastFrame: undefined } });
  const startX = fromShape.x + fromShape.props.w;
  const startY = fromShape.y + fromShape.props.h / 2;
  const endX = toShape.x;
  const endY = toShape.y + toShape.props.h / 2;
  if (toShape.type === "h3-node" && frameRole !== "reference" && (fromShape.type === "image-node" || fromShape.type === "video-node")) removeExistingFrameConnection(editor, toShape.id, frameRole, arrowId);
  editor.createShape({ id: arrowId, type: "arrow", x: startX, y: startY, props: { start: { x: 0, y: 0 }, end: { x: endX - startX, y: endY - startY }, kind: "elbow", elbowMidPoint: getWorkflowMidpoint(fromShape, toShape), color: "grey", size: "s", dash: "solid", arrowheadEnd: "arrow" } });
  const endAnchorY = toShape.type === "h3-node" && (fromShape.type === "image-node" || fromShape.type === "video-node") ? H3_INPUT_ANCHORS[frameRole] : 0.5;
  editor.createBindings([
    { type: "arrow", fromId: arrowId, toId: fromShape.id, props: { terminal: "start", normalizedAnchor: { x: 1, y: 0.5 }, isExact: false, isPrecise: true, snap: "edge" } },
    { type: "arrow", fromId: arrowId, toId: toShape.id, props: { terminal: "end", normalizedAnchor: { x: 0, y: endAnchorY }, isExact: false, isPrecise: true, snap: "edge" } },
  ]);
  return arrowId;
}

export function arrowFrameRole(arrow: TLShape, anchorY: number): string {
  return typeof arrow.meta.frameRole === "string" ? arrow.meta.frameRole : Math.abs(anchorY - H3_INPUT_ANCHORS.reference) < 0.035 ? "reference" : Math.abs(anchorY - H3_INPUT_ANCHORS.last) < 0.035 ? "last" : "first";
}

export function getIncomingFrameSource(editor: Editor, shapeId: H3Node["id"], role: H3FrameRole) {
  const candidates: { source: ImageNode; role: string }[] = [];
  for (const candidate of editor.getCurrentPageShapes()) {
    if (candidate.type !== "arrow") continue;
    const bindings = getArrowBindings(editor, candidate as TLArrowShape);
    if (bindings.end?.toId !== shapeId || !bindings.start) continue;
    const source = referenceImageOf(editor.getShape(bindings.start.toId));
    if (!source) continue;
    candidates.push({ source: source as ImageNode, role: arrowFrameRole(candidate, bindings.end.props.normalizedAnchor.y) });
  }
  return candidates.find((candidate) => candidate.role === role)?.source ?? null;
}

export function getIncomingReferenceImages(editor: Editor, shapeId: H3Node["id"]) {
  const images: ImageNode[] = [];
  for (const candidate of editor.getCurrentPageShapes()) {
    if (candidate.type !== "arrow") continue;
    const bindings = getArrowBindings(editor, candidate as TLArrowShape);
    if (bindings.end?.toId !== shapeId || !bindings.start || arrowFrameRole(candidate, bindings.end.props.normalizedAnchor.y) !== "reference") continue;
    const source = referenceImageOf(editor.getShape(bindings.start.toId));
    if (source) images.push(source);
  }
  return images;
}

export function removeExistingFrameConnection(editor: Editor, shapeId: H3Node["id"], role: H3FrameRole, exceptId: TLArrowShape["id"]) {
  const remove: TLArrowShape["id"][] = [];
  for (const candidate of editor.getCurrentPageShapes()) {
    if (candidate.type !== "arrow" || candidate.id === exceptId) continue;
    const bindings = getArrowBindings(editor, candidate as TLArrowShape);
    if (bindings.end?.toId !== shapeId || !bindings.start) continue;
    const source = editor.getShape(bindings.start.toId);
    if (!referenceImageOf(source) && source?.type !== "video-node" && source?.type !== "h3-node") continue;
    const anchor = bindings.end.props.normalizedAnchor.y;
    const existingRole = arrowFrameRole(candidate, anchor);
    if (existingRole === role) remove.push(candidate.id);
  }
  if (remove.length) editor.deleteShapes(remove);
}

export function getOutgoingTargets(editor: Editor, shapeId: CustomNode["id"], type?: CustomNode["type"]) {
  const targets: CustomNode[] = [];
  for (const candidate of editor.getCurrentPageShapes()) {
    if (candidate.type !== "arrow") continue;
    const bindings = getArrowBindings(editor, candidate as TLArrowShape);
    if (bindings.start?.toId !== shapeId || !bindings.end) continue;
    const target = editor.getShape(bindings.end.toId);
    if (target && customTypes.has(target.type) && (!type || target.type === type)) targets.push(target as CustomNode);
  }
  return targets;
}

export function getIncomingSource(editor: Editor, shapeId: CustomNode["id"], type?: CustomNode["type"]) {
  const arrows = editor.getCurrentPageShapes().filter((shape): shape is TLArrowShape => shape.type === "arrow").sort((a, b) => String(b.index).localeCompare(String(a.index)));
  for (const arrow of arrows) {
    const bindings = getArrowBindings(editor, arrow);
    if (bindings.end?.toId !== shapeId || !bindings.start) continue;
    const source = editor.getShape(bindings.start.toId);
    if (source && customTypes.has(source.type) && (!type || source.type === type)) return source as CustomNode;
  }
  return null;
}

export function getH3Settings(shape: H3Node): H3GenerationSettings {
  const megapixels = Math.min(H3_MAX_MEGAPIXELS, Math.max(H3_MIN_MEGAPIXELS, Number(shape.props.megapixels ?? H3_MEGAPIXELS)));
  const turbo = shape.props.turbo ?? H3_TURBO;
  const steps = turbo ? H3_STEPS : H3_NON_TURBO_STEPS;
  const fps = H3_FPS;
  const loraStrength = H3_LORA_STRENGTH;
  const resolutionSteps = H3_RESOLUTION_STEPS;
  const upscaleMethod = H3_UPSCALE_METHOD;
  const community = isCommunityWorkflow(shape.props.workflowOptionId) ? communitySettings(shape.props.workflowOptionId) : null;
  const values = community ? parseCommunityValues(shape.props.communityParameters, shape.props.workflowOptionId as 'community-ultimate'|'community-dialogue') : {};
  return { length: getActualDuration(shape.props.duration).length, aspect: isH3Aspect(shape.props.mode) ? shape.props.mode : "follow", megapixels, turbo: community ? true : turbo, steps: community?.steps ?? steps, fps, loraStrength: Number(values['145.strength_model'] ?? community?.loraStrength ?? loraStrength), upscaleMethod, resolutionSteps: Number(values['115.multiple'] ?? resolutionSteps), communityParameters: community ? JSON.stringify(values) : undefined, soundMode: shape.props.soundMode ?? "av", noBackgroundMusic: shape.props.noBackgroundMusic ?? false };
}

/** `existingShotId` (Shot System V0.1): a Shot planned in 导演台 is linked to the new node instead of creating one. */
export async function createH3Node(editor: Editor, point: Point, props: Partial<H3Node["props"]> = {}, existingShotId?: string,signal?:AbortSignal) {
  const id = createShapeId();
  const shot = existingShotId ? await linkShotToH3Node(existingShotId, id) : await createShot(props.shotTitle ?? "", id,undefined,signal);
  signal?.throwIfAborted();editor.createShape({ id, type: "h3-node", x: point.x, y: point.y, meta: { ...H3_NEW_LAYOUT_META }, props: { w: H3_NODE_WIDTH, h: H3_DEFAULT_HEIGHT, ...props, shotId: shot.shotId } });
  return editor.getShape(id) as H3Node | undefined;
}

export type PortAction = "create-h3" | "continue-from-last-frame";
export const portActions: Partial<Record<CustomNode["type"], PortAction>> = { "image-node": "create-h3", "video-node": "continue-from-last-frame", "h3-node": "continue-from-last-frame" };

export function selectedReferenceImages(editor: Editor): ImageNode[] {
  const images = new Map<string, ImageNode>();
  const visit = (id: TLShape["id"]) => {
    const item = editor.getShape(id);
    const image = referenceImageOf(item);
    if (image) images.set(image.id, image);
    else if (item?.type === "group") for (const child of editor.getSortedChildIdsForParent(item.id)) visit(child);
  };
  for (const id of editor.getSelectedShapeIds()) visit(id);
  return [...images.values()].sort((a, b) => {
    const aa = editor.getShapePageBounds(a), bb = editor.getShapePageBounds(b);
    return (aa?.x ?? a.x) - (bb?.x ?? b.x) || (aa?.y ?? a.y) - (bb?.y ?? b.y) || a.id.localeCompare(b.id);
  });
}

/** Capture the displayed candidate, and update only the existing target's selected keyframe slot. */
export async function handoffVideoFrame(editor: Editor, sourceId: TLShape["id"], targetId: TLShape["id"], role: "first" | "last") {
  const source = editor.getShape(sourceId) as H3Node | VideoNode | undefined;
  let target = editor.getShape(targetId);
  if (target?.type === "video-node") {
    const shot = target.props.shotId ? await getShot(target.props.shotId) : null;
    target = shot?.sourceH3NodeId ? editor.getShape(shot.sourceH3NodeId as TLShape["id"]) : getIncomingSource(editor, target.id, "h3-node") ?? undefined;
  }
  if (!source || !["h3-node", "video-node"].includes(source.type) || target?.type !== "h3-node" || source.id === target.id) throw new Error("请选择已有的另一个视频生成节点，不会创建新节点");
  if (target.isLocked) throw new Error("目标节点已锁定");
  if (target.props.workflowOptionId === "h3-extend") throw new Error("视频延长节点不能直接改成首尾帧；请连接普通 H3 视频节点");
  const capture = role === "first" ? "last" : "first";
  const candidates = source.type === "h3-node" && source.props.shotId ? await getShotCandidates(source.props.shotId) : [];
  const shot = source.type === "h3-node" && source.props.shotId ? await getShot(source.props.shotId) : null;
  const shown = source.type === "h3-node" ? source.props.previewAssetId || shot?.adoptedAssetId || source.props.inheritedVideo?.assetId : undefined;
  const chosen = (shown ? await getAsset(shown) : null) ?? candidates.at(-1)?.asset;
  const legacy = source.type === "h3-node" && source.props.shotId ? findShotDisplay(editor, source.props.shotId, source.id) : undefined;
  const src = source.type === "video-node" ? source.props.src : chosen?.storageReference ?? legacy?.props.src ?? (source.type === "h3-node" ? source.props.inheritedVideo?.src : undefined);
  const name = source.type === "video-node" ? source.props.name : chosen?.filename ?? legacy?.props.name ?? (source.type === "h3-node" ? source.props.inheritedVideo?.name : undefined) ?? "视频";
  if (!src) throw new Error("来源节点还没有可用视频，请先生成或选择候选");
  const targetIdResolved = target.id;
  showCanvasToast(capture === "last" ? "正在提取上一段尾帧…" : "正在提取下一段首帧…");
  const frame = capture === "last" ? await extractVideoLastFrame(src) : await extractVideoFirstFrame(src);
  const filename = `${name}-${capture === "last" ? "尾帧" : "首帧"}.jpg`;
  const imageSrc = await storeLocalImage(await getLocalImageBlob(frame.dataUrl), filename);
  const current = editor.getShape(targetIdResolved);
  const freshSource = editor.getShape(sourceId);
  if (current?.type !== "h3-node" || !freshSource || current.isLocked) throw new Error("来源或目标节点已删除或锁定，未改变节点");
  editor.markHistoryStoppingPoint("before video keyframe handoff");
  editor.run(() => {
    removeExistingFrameConnection(editor, current.id, role, createShapeId());
    editor.updateShape({ id: current.id, type: "h3-node", props: videoFrameHandoffPatch(role, { src: imageSrc, name: filename, sourceNodeId: source.id }) });
    const arrowId = createBoundArrow(editor, freshSource as CustomNode, editor.getShape(current.id) as H3Node, role);
    editor.updateShape({ id: arrowId, type: "arrow", meta: { frameRole: role, capturedVideoFrame: true } });
    const bindings = getArrowBindings(editor, editor.getShape(arrowId) as TLArrowShape);
    for (const [binding, x] of [[bindings.start, role === "last" ? 0 : 1], [bindings.end, role === "last" ? 1 : 0]] as const) {
      if (binding) editor.updateBinding({ id: binding.id, type: "arrow", props: { normalizedAnchor: { x, y: 0.5 } } });
    }
    editor.select(current.id);
  });
  editor.markHistoryStoppingPoint("after video keyframe handoff");
  showCanvasToast(`已给原节点添加${role === "first" ? "首帧" : "尾帧"}，提示词、参考图和角色保留；仅用于下次生成，当前任务不变`);
}

export async function runPortAction(editor: Editor, source: CustomNode, point?: Point, videoAction: "last-frame" | "last-frame-hd" = "last-frame", referenceIds?: ImageNode["id"][], preparedFrame?:{src:string;name:string}) {
  source = referenceImageOf(source) ?? source;
  const action = portActions[source.type];
  if (action === "create-h3") {
    const selectedImages = referenceIds ? referenceIds.map((id) => referenceImageOf(editor.getShape(id))).filter((item): item is ImageNode => !!item) : selectedReferenceImages(editor);
    if (selectedImages.length > 1 && selectedImages.some((image) => image.id === source.id)) {
      const references = selectedImages;
      const referenceBounds = references.map((image) => editor.getShapePageBounds(image)).filter((bounds) => bounds !== undefined);
      const width = source.type === "image-node" ? source.props.naturalWidth ?? 0 : 0;
      const height = source.type === "image-node" ? source.props.naturalHeight ?? 0 : 0;
      const aspect = width && height ? (width / height < 0.85 ? "9:16" : width / height > 1.15 ? "16:9" : "1:1") : "16:9";
      const h3 = await createH3Node(editor, point ?? { x: Math.max(...referenceBounds.map((bounds) => bounds.x + bounds.w)) + 130, y: Math.min(...referenceBounds.map((bounds) => bounds.y)) }, { workflowOptionId: "community-ultimate", allReferenceMode: true, mode: aspect });
      if (h3) {
        for (const image of references) if (referenceImageOf(editor.getShape(image.id))) createBoundArrow(editor, image, h3, "reference");
        editor.select(h3.id);
        showCanvasToast(`已将选中的 ${references.length} 张图片加入同一个视频节点的全能参考；填写提示词后生成`);
      }
      return;
    }
    const h3 = await createH3Node(editor, point ?? { x: source.x + source.props.w + 130, y: source.y + Math.max(0, (source.props.h - H3_DEFAULT_HEIGHT) / 2) });
    if (h3) { createBoundArrow(editor, source, h3); editor.select(h3.id); }
    return;
  }
  if (action === "continue-from-last-frame" && (source.type === "video-node" || source.type === "h3-node")) {
    const sourcePage=editor.getCurrentPageId();
    let upstream = source.type === "h3-node" ? source : sourceH3ForDerived(editor, source.id);
    if(!upstream && source.props.shotId){
      const owner=await getShot(source.props.shotId);
      const node=owner?.sourceH3NodeId?editor.getShape(owner.sourceH3NodeId as TLShape["id"]):null;
      if(node?.type==="h3-node"&&editor.getCurrentPageShapes().some(s=>s.id===node.id))upstream=node as H3Node;
    }
    const candidates = source.type === "h3-node" && source.props.shotId ? await getShotCandidates(source.props.shotId) : [];
    const shot = source.type === "h3-node" && source.props.shotId ? await getShot(source.props.shotId) : null;
    const shown = source.type === "h3-node" ? source.props.previewAssetId || shot?.adoptedAssetId || source.props.inheritedVideo?.assetId : undefined;
    const chosen = (shown ? await getAsset(shown) : null) ?? candidates.at(-1)?.asset;
    const legacyResult = source.type === "h3-node" && source.props.shotId ? findShotDisplay(editor, source.props.shotId, source.id) : undefined;
    const mediaSource = source.type === "video-node" ? source.props.src : chosen?.storageReference ?? legacyResult?.props.src ?? (source.type === "h3-node" ? source.props.inheritedVideo?.src : undefined);
    const mediaName = source.type === "video-node" ? source.props.name : chosen?.filename ?? legacyResult?.props.name ?? (source.type === "h3-node" ? source.props.inheritedVideo?.name : undefined) ?? "上一段视频";
    if (!mediaSource) throw new Error("请先生成视频，再选择尾帧做视频");
    showCanvasToast(videoAction==="last-frame-hd"?"正在创建尾帧视频节点，将自动高清…":"正在提取视频尾帧…");
    const hdSource=videoAction==="last-frame-hd"?await resolveCanvasCutSource(source):null;
    const original=hdSource?await originalTailPNG(hdSource.asset,hdSource.duration):null;
    const frameName=original?.filename??preparedFrame?.name??`${mediaName}-尾帧.jpg`;
    // Store the extracted tail as an image so the new node keeps an `image:` reference, not inline base64.
    const frame = original?{dataUrl:original.storageReference}:preparedFrame?{dataUrl:preparedFrame.src}:{dataUrl:await storeLocalImage(await getLocalImageBlob((await extractVideoLastFrame(mediaSource)).dataUrl), frameName)};
    if (!editor.getShape(source.id)||editor.getCurrentPageId()!==sourcePage) return;
    const inherited = upstream ? getH3Settings(upstream) : null;
    const order=upstream?.props.referenceImageOrder??[];
    const references=upstream?[
      ...getIncomingReferenceImages(editor,upstream.id).map(i=>({src:i.props.src,name:i.props.name,key:`node:${i.id}`})),
      ...(upstream.props.referenceImages??[]).map(i=>({...i,key:`file:${JSON.stringify([i.src,i.name])}`})),
    ].sort((a,b)=>(order.indexOf(a.key)<0?order.length:order.indexOf(a.key))-(order.indexOf(b.key)<0?order.length:order.indexOf(b.key))).map(({src,name})=>({src,name})):[];
    const continuation=tailVideoBindings(upstream?.props??{},references,{src:frame.dataUrl,name:frameName,sourceNodeId:source.id});
    const h3 = await createH3Node(editor, point ?? { x: source.x + source.props.w + 130, y: source.y - 80 }, {
      prompt: "", mode: inherited?.aspect ?? "follow", duration: String(upstream ? getActualDuration(upstream.props.duration).requestedSeconds : lengthToSeconds(141)), seedMode: "随机", seed: "", megapixels: inherited?.megapixels ?? H3_MEGAPIXELS, turbo: inherited?.turbo ?? H3_TURBO, steps: inherited?.steps ?? H3_STEPS, fps: inherited?.fps ?? H3_FPS, loraStrength: inherited?.loraStrength ?? H3_LORA_STRENGTH, upscaleMethod: inherited?.upscaleMethod ?? H3_UPSCALE_METHOD, resolutionSteps: inherited?.resolutionSteps ?? H3_RESOLUTION_STEPS, sourceFrameSrc: frame.dataUrl, sourceFrameName: frameName, sourceH3Id: upstream?.id ?? "",
    });
    if (h3) {
      editor.updateShape({ id: h3.id, type: "h3-node", props: continuation,...(original?{meta:{...h3.meta,tailFrameHD:{originalAssetId:original.assetId,expectedSrc:original.storageReference,sourceNodeId:source.id,status:'pending',stage:'尾帧 AI 高清准备中…'}}}:{}) });
      const arrowId=createBoundArrow(editor, source, h3,"first");
      editor.updateShape({id:arrowId,type:"arrow",meta:{frameRole:"first",capturedVideoFrame:true}});
      editor.select(h3.id);
      showCanvasToast("已创建尾帧做视频节点：继承参考图、角色与主声音绑定，只需填写新提示词；输出仅包含新片段");
      if(original)await runTailFrameHD(editor,h3.id,true);
    }
  }
}

export function createUpscaleNode(editor: Editor, point: Point, source?: VideoNode | H3Node, targetResolution = "1080p", withInterpolation = false) {
  const id = createShapeId();
  editor.createShape({ id, type: "upscale-node", x: point.x, y: point.y, props: { w: 350, h: 310, clipMode: "whole", start: 0, duration: 2, collapsed: false, autoHeight: true, targetResolution, withInterpolation, autoStart: false } });
  const node = editor.getShape(id) as UpscaleNode | undefined;
  if (node && source) createBoundArrow(editor, source, node);
  if (node) editor.select(node.id);
  return node;
}

export function createSmoothNode(editor: Editor, point: Point, source?: VideoNode | H3Node) {
  const id = createShapeId();
  editor.createShape({ id, type: "smooth-node", x: point.x, y: point.y, props: { w: 350, h: 264, autoHeight: true } });
  const node = editor.getShape(id) as SmoothNode | undefined;
  if (node && source) createBoundArrow(editor, source, node);
  if (node) editor.select(node.id);
  return node;
}

export function formatElapsed(seconds: number) { const minutes = Math.floor(seconds / 60); const remainder = seconds % 60; return minutes ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${remainder}秒`; }

export const RUN_MODE_FROM_PARAMETERS: Record<string, H3TaskMode> = { text: "t2va", first: "i2va", "first-last": "fl2va", reference: "ref2va" };

export const shotName = (shot: ShotRecord) => `镜头${String(shot.shotNumber).padStart(2, "0")}`;

/** Resolve inline H3 results without creating a duplicate video node. */
export function processingVideoFromH3(current:H3Node,asset:AssetRecord):VideoNode{
  // In-memory input adapter only. Never insert a second copy of the original into the canvas.
  return {...current,type:'video-node',props:{w:current.props.w,h:current.props.h,src:asset.storageReference,name:asset.filename,size:asset.fileSize?formatBytes(asset.fileSize):'—',duration:asset.duration?`${asset.duration.toFixed(1)} 秒`:'—',originalPath:'',assetId:asset.assetId,runId:asset.sourceRunId??undefined,shotId:asset.shotId,fps:asset.fps}};
}

export const getImageSize = (src: string) => new Promise<{ width: number; height: number }>((resolve) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => resolve({ width: 800, height: 600 }); image.src = src; });
export async function getLocalImageSize(src: string) {
  const acquired = await acquireMediaUrl(src);
  try { return await getImageSize(acquired.url); }
  finally { releaseMediaUrl(acquired.key); if (acquired.revoke) URL.revokeObjectURL(acquired.url); }
}
export const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function resolveCanvasCutSource(shape: TLShape): Promise<{asset:AssetRecord;duration:number}> {
  const p=shape.props as {src?:string;name?:string;assetId?:string;previewAssetId?:string;shotId?:string;inheritedVideo?:{src:string;name:string;assetId?:string}};
  let asset:AssetRecord|null|undefined;
  if(shape.type==="h3-node"){
    const [shot,versions,inherited]=await Promise.all([p.shotId?getShot(p.shotId):null,p.shotId?getShotAssetVersions(p.shotId):[],p.inheritedVideo?.assetId?getAsset(p.inheritedVideo.assetId):null]);
    asset=resolveCandidatePreview(inherited?[...versions,inherited]:versions,[p.previewAssetId,shot?.adoptedAssetId,p.inheritedVideo?.assetId]);
    if(!asset&&p.inheritedVideo)asset=await assetForSource(p.inheritedVideo.src,"video",p.inheritedVideo.name);
  } else if(p.src) asset=await assetForSource(p.src,"video",p.name||"视频.mp4");
  if(!asset||asset.kind!=="video")throw Error("选中的镜头还没有可粗剪的视频，请先生成或选择候选");
  const blob=await getLocalVideoBlob(asset.storageReference);
  const duration=await readVideoDurationSeconds(blob);
  if(typeof duration!=="number"||!Number.isFinite(duration)||duration<=0)throw Error("无法确认视频时长："+asset.filename);
  return {asset:{...asset,duration},duration};
}
