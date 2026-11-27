"use client";

import {imageProof} from '@/lib/image-integrity';
import { gateOverrideFor } from "@/components/gate-confirm-store";
import {lockedWorkflow} from "@/lib/locked-generation";
import {boundInterpolationPlan} from "@/lib/enhancement-memory";
import {newEnhancementCheckpoint} from "@/lib/enhancement-pipeline";
import {saveEnhancement,resumeEnhancement} from "@/lib/resume-enhancement";
import { CopyPromptButton } from "@/components/canvas/copy-prompt-button";
import { canvasImageClipboardOptions } from "@/components/canvas/image-clipboard";
import { freezeH3Roles, readH3Roles } from "@/lib/h3-role-snapshot";
import { shotPromptWarnings } from "@/lib/shot-prompt-checks";
import { h3PromptHealthMessages, tuningOfParameters } from "@/lib/h3-prompt-health";
import { isTypingTarget } from "@/lib/keyboard-guards";
import { isDockPinned, pinDock, pinnedDockShapeId, unpinDock } from "@/lib/dock-pin";
import { inspectH3Submission, type H3ReviewSpec, type H3SubmissionReview } from "@/lib/h3-submission-review";
import { h3ReferenceLayout, prepareH3ReferenceSubmission } from "@/lib/h3-reference-submission";
import { voiceReferenceLabels } from "@/lib/voice-reference-status";
import { H3ResolutionPicker } from "@/components/h3-resolution-picker";
import { H3_NEW_NODE_WIDTH, H3_NEW_NODE_HEIGHT, H3_NEW_LAYOUT_META, usesWideH3Typography, h3AutoHeightPatch } from "@/lib/h3-node-layout-policy";
import { videoFrameHandoffPatch, videoHandoffEdges, type CapturedVideoFrame } from "@/lib/video-frame-handoff";
import { createMediaImportRow } from "@/lib/media-import-row";
import { video1080Dimensions } from "@/lib/video-resolution";

import { H3WorkflowPicker } from "@/components/canvas/h3-workflow-picker";
import { CanvasLibrary } from '@/components/canvas/canvas-library';
import { registerProcessing, runRegisteredProcessing, runSerialProcessing, type ProcessingResult } from '@/lib/postprocess-queue';
import {nightAttempts,runNightAttempts} from '@/lib/night-postprocess';
import {installResizeNoticeGuard} from '@/lib/resize-notice-guard';
import { COMFYUI_PROXY_PATH } from '@/lib/comfyui/config';
import { AudioVideoNodeUtil, MusicNodeUtil, createAudioVideoNode, createMusicNode } from "@/components/canvas/media-workshop-node";
import { TTSNodeUtil, createTTSNode } from "@/components/canvas/tts-node";
import { TranslationNodeUtil, createTranslationNode } from "@/components/canvas/translation-node";
import { resolveCandidatePreview } from '@/lib/candidate-preview';
import { prepareSegmentedUpscale } from '@/lib/segmented-upscale';
import { updateRun } from '@/lib/production-records';
import { fetchZhengbenVersion } from '@/lib/zhengben-client';
import { resolveH3Speaker, hasPromptDialogue } from '@/lib/h3-speaker-policy';
import { VOICE_SAMPLE_SECONDS } from '@/lib/voice-roles';
import { dialogueAudioIds, type H3DialogueLine } from '@/lib/h3-dialogue';
import { observeMediaGesture } from '@/lib/canvas-interaction';
import { batchOutputPosition, type BatchOutputBox } from '@/lib/batch-output-layout';
import { useAutoRoleVoice } from '@/components/use-auto-role-voice';
import { H3CommunityParameters } from '@/components/canvas/h3-community-parameters';
import { communityActualSteps, parseCommunityValues } from '@/lib/comfyui/experimental/h3-community-controls';
import { ReferenceHoverPreview } from "@/components/canvas/reference-hover-preview";
import { workflowBlockedReason, isCommunityWorkflow, communitySettings, communityInputProblem, communityInputMode, workflowOption } from "@/lib/h3-workflow-options";

import { Archive, Bug, Clapperboard, GitBranch, MoreHorizontal, Search as SearchIcon, Stethoscope, CircleAlert, CircleCheck, CircleX, ChevronDown, Download, FileText, Film, FolderOpen, Image as ImageIcon, Info, LayoutGrid, Link2, ListVideo, Mic2, Pencil, Plus, Scissors, Sparkles, Users, Video, WandSparkles, X } from "lucide-react";
import {
  BaseBoxShapeUtil,
  Rectangle2d,
  Editor,
  HTMLContainer,
  T,
  TLArrowShape,
  TLBaseShape,
  type TLComponents,
  type TLUiOverrides,
  type TLShape,
  type TLResizeInfo,
  Tldraw,
  createShapeId,
  getArrowBindings,
  getSnapshot,
  loadSnapshot,
  useEditor,
  useValue,
} from "tldraw";
import "tldraw/tldraw.css";
import { ChangeEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AssetPicker, RoleLibrary } from "@/components/role-library";
import { ImageRoleDialog } from "@/components/canvas/image-role-dialog";
import { StoryboardGuideEditor } from "@/components/canvas/storyboard-guide-editor";
import { TimeAnchorEditor, type TimeAnchorProp } from "@/components/canvas/time-anchor-editor";
import { checkTimeAnchors, timeAnchorFrame, timeAnchorPromptProblem, H3_TIME_ANCHOR_NOTE } from "@/lib/comfyui/experimental/h3-ultimate-guide";
import { WorkflowArrowUtil } from "@/components/canvas/workflow-arrow";
import { resolveOrderedStoryboardGuides, storyboardGuideProblem, type StoryboardGuide } from "@/lib/storyboard-guides";
import { announceShotChange, showCanvasToast } from "@/components/canvas/canvas-events";
import { customTypes } from "@/lib/canvas-node-types";
import { nearestFrameDropTarget } from "@/lib/frame-drop-target";
import { logTaskDone, logTaskFailure, logTaskUncertain, recordRunUpdate } from "@/components/canvas/task-log";
import { useAcquiredMediaUrl, useMediaActive, useVideoActive, useVideoPoster } from "@/components/canvas/media-hooks";
import { rememberVideoPosition, restoreVideoPosition, clearVideoPosition, pauseVideoOutsideViewport, queueVideoTap, cancelVideoTap } from "@/lib/video-playback";
import { generatedVideoAsset, isUncertainAfterSubmit, RecoveryStatus, runOutputStore, useGeneratingSignal, useRunRecovery, useRunTiming } from "@/components/canvas/run-recovery-view";
import { CameraDotBackground, CollapsibleStylePanel, ConnectionHighlightOverlay, CreativeToolbar } from "@/components/canvas/canvas-chrome";
import { InstanceChrome } from "@/components/canvas/instance-chrome";
import { AssetLibrary } from "@/components/asset-library";
import { ProjectBackupPanel } from "@/components/project-backup-panel";
import { runDailyBackup } from "@/lib/daily-backup";
import { DISK_SNAPSHOT_INTERVAL_MS, runDiskSnapshot } from "@/lib/disk-snapshot";
import { ensurePersistentStorage, isPersistent, persistenceLabel, type StoragePersistence } from "@/lib/storage-persistence";
import { ShotBoard } from "@/components/shot-board";
import { ShotQueuePanel } from "@/components/shot-queue-panel"; import { InboxAutorun } from "@/components/inbox-autorun";
import { askConfirm } from "@/components/in-page-dialog";
import { InboxControlBar } from "@/components/inbox-control-bar";
import { KeyframeBatchPanel } from "@/components/keyframe-batch-panel";
import { ShotQueueRecovery } from "@/components/canvas/shot-queue-recovery";
import { copyPlainText } from "@/lib/copy-plain-text";
import { SHOT_QUEUE_LEGACY_LOCK, SHOT_QUEUE_LOCK, SHOT_QUEUE_WORKFLOW } from "@/lib/shot-queue";
import { CanvasRoughCut } from "@/components/canvas/canvas-rough-cut";
import { CanvasDemix, DemixNodeControl } from "@/components/canvas/canvas-demix";
import { demixPassLabel, musicRemovalPassesOf } from "@/lib/music-removal";
import {VideoFrameCapture} from '@/components/canvas/video-frame-capture';
import {TailFrameHDStatus,runTailFrameHD} from '@/components/canvas/tail-frame-hd-inline';
import {originalTailPNG,tailHDBlocked} from '@/lib/tail-frame-hd-job';
import { CanvasTools, AuditBadge, openCanvasTools } from "@/components/canvas/canvas-tools";
import { OPEN_CANVAS_ROUGH_CUT } from "@/lib/canvas-rough-cut";
import { DiagnosticsPanel } from "@/components/diagnostics-panel";
import { DirectorStageEntry } from "@/components/director-stage/director-stage-panel";
import { CanvasPanelBoundary, CanvasSaveStatusContext, CanvasErrorFallback, CanvasShapeErrorFallback } from "@/components/canvas-error-boundary";
import { installUiErrorReporting } from "@/lib/ui-error-report";
import { startVisibleStatusPoll } from "@/lib/visible-status-poll";
import { CulledShape } from "@/components/canvas/culled-shape";
import { useImageThumbnail } from "@/components/canvas/use-image-thumbnail";
import { imagePixelSize } from "@/lib/image-thumbnail";
import { runDirectorContext, type DirectorNodeContext, type H3HandoffPlan } from "@/lib/director-stage/h3-handoff";
import { ErrorCenter, useLogVersion } from "@/components/error-center";
import { H3PresetBar } from "@/components/h3-preset-bar";
import { LineageViewer, OPEN_LINEAGE_EVENT, openLineage } from "@/components/lineage-viewer";
import { CommandPalette, type PaletteAction, type PaletteResult } from "@/components/command-palette";
import { searchAll, type CanvasNodeInfo, type SearchData, type SearchResult } from "@/lib/global-search";
import { listRoles as listRoleRecords } from "@/lib/role-records";
import { installCanvasLibraryScope } from "@/lib/canvas-library-migration";
import { isPaletteShortcut } from "@/lib/command-palette";
import { assetNodeProps } from "@/lib/asset-library";
import { acquireMediaUrl, extractVideoLastFrame, extractVideoFirstFrame, getLocalAudioBlob, getLocalImageBlob, getLocalVideoBlob, migrateVideoDataUrl, readVideoDurationSeconds, readVideoMetadata, releaseMediaUrl, resolveImageSource, resolveVideoSource, storeLocalAudio, storeLocalImage, storeLocalVideo } from "@/lib/local-video-store";
import { clipAudioBlob, extractVideoAudio, probeVideoAudio, type AudioProbe } from "@/lib/audio-extract";
import { calculateWaveformPeaks, formatAudioTime, MIN_AUDIO_CLIP_SECONDS, validAudioClip } from "@/lib/audio-waveform";
import { addRoleAsset, getRole, listRoles, setPrimaryRoleAsset, type RoleRecord } from "@/lib/role-records";
import { type ReferenceManifest } from "@/lib/reference-manifest";
import { OFFICIAL_MODE_WARNING, type H3PromptMode } from "@/lib/h3-prompt-compiler";
import { downloadSavedMedia } from "@/lib/media-download";
import { imageNodeSize, legacyImageNodeSize, videoNodeSize, h3PreviewSize } from "@/lib/media-node-layout";
import { formatFps, readMp4VideoFps } from "@/lib/video-fps";
import { deleteShotCandidate, restoreShotCandidate, isH3Capability, addRunToShot, adoptShotAsset, attachCompletedRunToShot, createRun, createShot, ensureLegacyAsset, linkShotToH3Node, getAsset, getAssetBySource, getRootCandidateLabel, getRun, getShot, getShotAssetLineage, getShotAssetVersions, getShotCandidates, listAssets, listRuns, listShots, markShotHasCandidates, registerAsset, renameAsset, type AssetOrigin, type AssetRecord, type RunRecord, type ShotRecord } from "@/lib/production-records";
import { announceAssetRenamed, ASSET_RENAMED_EVENT, normalizeAssetFilename } from "@/lib/asset-name";
import { h3ClassTypesFor, snapshotFilm, snapshotH3, snapshotUpscale, snapshotUpscale60 } from "@/lib/production-snapshots";
import { H3_ADDGUIDE_NOTE } from "@/lib/comfyui/experimental/h3-addguide";
import { assertH3ModeSubmittable, H3_TASK_LABELS, H3_TASK_STATUS, resolveH3TaskMode, type H3TaskMode } from "@/lib/h3-task-mode";
import { formatPreflight, frameModeCounts, runH3Preflight, type H3PreflightResult } from "@/lib/h3-preflight";
import { describeRunMedia, formatMediaLine } from "@/lib/run-media-map";
import { t2vaAspect, t2vaDimensions } from "@/lib/comfyui/h3-t2va";
import { comfyUIH3Adapter } from "@/lib/comfyui/h3-adapter";
import { compileH3Prompt, type H3SoundMode } from "@/lib/comfyui/h3-prompt";
import { isOfficialFormat, OFFICIAL_MUSIC_NOTE } from "@/lib/official-format";
import { SubmissionNotSentError, type AiGenerationStatus, type H3GenerationSettings, type H3GenerationUpdate, type H3GenerationOptions } from "@/lib/ai-adapter";
import { queueFrameNodeWaiting } from '@/lib/shot-queue-frames';

import { toastTone } from "@/lib/ui-tone";
import { categorize, logEvent, logToast, unreadCount } from "@/lib/error-log";
import { subscribeLinkedContent } from "@/components/canvas/linked-content";
import { watchCanvasSave } from "@/lib/canvas-save-status";
import {registerNodeTaskCancel} from '@/lib/node-task-activity';
import { startMediaMagnet, translateMediaMagnet, endMediaMagnet } from "@/components/canvas/media-magnet";
import { CanvasInteractionUI, previewMedia, offerDeleteUndo, showDropFeedback } from "@/components/canvas/interaction-ui";
import { currentImageSlotTarget, clearSlotFeedback, slotLabel } from "@/components/canvas/slot-drop-feedback";
import { deleteWithRestore } from "@/lib/canvas-delete-undo";
import {deleteCanvasNodes} from '@/components/canvas/safe-delete-action';
import { getGeneratingSnapshot, setNodeGenerating } from "@/lib/link-highlight";
import { ReferencePromptEditor } from "@/components/canvas/reference-prompt-editor";
import { RevealNodeFile } from "@/components/canvas/reveal-node-file";
import { CopyVideoList } from "@/components/canvas/copy-video-list";
import { FluxCanvasContextMenu, OPEN_FLUX_IMAGE_EVENT, OPEN_TTS_EVENT, OPEN_AUDIO_VIDEO_EVENT, OPEN_MUSIC_EVENT, OPEN_TAIL_VIDEO_EVENT } from "@/components/canvas/flux-image-entry";
import { tailVideoBindings } from "@/lib/video-continuation";
import { createFluxImageNode, FluxImageNodeUtil, type FluxImageNode } from "@/components/canvas/flux-image-node";
import {CoverNodeUtil,createCoverNode} from '@/components/canvas/cover-node';
import { TelegramCanvasBridge } from "@/components/canvas/telegram-bridge";
import { referencedLabels } from "@/lib/reference-mentions";
import { affectedArrowIds } from "@/lib/canvas-link-validation";
import { capturePoster, preparePosterFrame } from "@/lib/poster-cache";

import { claimNode, createRunExclusively, finalizeRunOutput, isNodeClaimed, recoveryPhaseLabels, releaseNodeClaim } from "@/lib/run-recovery";
import { candidateRunInput, generationSeeds, runSerialGenerations } from "@/lib/generation-batch";
import { maintainCanvasAutomation, registerH3Automation, type AutomationDeps, type H3AutomationState } from "@/lib/canvas-automation";
import { installProductionBridge } from "@/lib/production-bridge";
import {
  calculateH3Dimensions,
  formatRequestedSeconds,
  getActualDuration,
  H3_ASPECTS,
  H3_ASPECT_LABELS,
  H3_FPS,
  H3_LORA_STRENGTH,
  H3_MAX_REQUESTED_SECONDS,
  H3_MAX_MEGAPIXELS,
  H3_MEGAPIXELS,
  H3_MIN_LENGTH,
  H3_MIN_MEGAPIXELS,
  H3_NON_TURBO_STEPS,
  H3_RESOLUTION_STEPS,
  H3_STEPS,
  H3_TURBO,
  H3_UPSCALE_METHOD,
  isH3Aspect,
  lengthToSeconds,
  normalizeRequestedSeconds,
  type H3Aspect,
} from "@/lib/comfyui/h3-parameters";
import { type AudioNode, type CustomNode, type H3FrameRole, type H3Node, H3_DEFAULT_HEIGHT, H3_INPUT_ANCHORS, H3_NODE_WIDTH, type ImageNode, type Point, type SmoothNode, type UpscaleNode, type VideoNode, arrowFrameRole, assetForSource, createBoundArrow, createH3Node, createSmoothNode, createUpscaleNode, displayVideoAsset, downloadNodeMedia, findShotDisplay, fittedVideoSize, formatBytes, formatElapsed, getH3Settings, getImageSize, getIncomingFrameSource, getIncomingReferenceImages, getIncomingSource, getLocalImageSize, getOutgoingTargets, getWorkflowMidpoint, handoffVideoFrame, isCompatibleConnection, processingVideoFromH3, referenceBlob, referenceImageOf, removeExistingFrameConnection, resolveCanvasCutSource, runPortAction, shotName, sourceH3ForDerived, stopPropagation } from "@/components/canvas/workspace-shared";
import { LocalSystemStatus } from "@/components/canvas/local-system-status";
import { BatchReferenceAction, BatchVideoActions } from "@/components/canvas/batch-actions-bar";
import { WorkflowPort } from "@/components/canvas/workflow-port";
import { GenerationInfo, H3SubmissionInfo, ShotCandidatesPanel } from "@/components/canvas/media-info-modals";

const H3_PROMPT_HEIGHT = 104;
const VIDEO_NODE_WIDTH = 390;
const VIDEO_NODE_HEIGHT = 300;
/** Height (CSS px, unscaled) of Chromium's native <video controls> bar incl. timeline; presses there stay with the player. */
const NATIVE_VIDEO_CONTROLS_BAND = 72;
const stopWheelPropagation = (event: React.WheelEvent) => event.stopPropagation();
const durationSeconds = (value: string) => { const parsed = Number.parseFloat(value); return Number.isFinite(parsed) ? parsed : undefined; };
async function importedAsset(source: string, kind: "image" | "video" | "audio", file: File, details: Partial<Pick<AssetRecord, "width" | "height" | "duration" | "fps">> = {}) {
  return registerAsset({ kind, origin: "imported", filename: file.name, mimeType: file.type || (kind === "image" ? "image/*" : kind === "audio" ? "audio/*" : "video/mp4"), storageReference: source, sourceRunId: null, fileSize: file.size, ...details });
}
async function ensureH3Shot(editor: Editor, h3: H3Node,signal?:AbortSignal) {
  if (h3.props.shotId) {
    const existing = await getShot(h3.props.shotId);
    signal?.throwIfAborted();if (existing && (!existing.sourceH3NodeId || existing.sourceH3NodeId === h3.id)) return existing;
  }
  // An old H3 can be linked to Phase 1 runs. Only real completed H3 records are migrated.
  const outputs = getOutgoingTargets(editor, h3.id, "video-node") as VideoNode[];
  const completed = (await Promise.all(outputs.map(async (video) => video.props.runId ? getRun(video.props.runId) : null))).filter((run): run is RunRecord => Boolean(run && run.status === "completed" && isH3Capability(run.capabilityId) && !run.shotId));
  signal?.throwIfAborted();const shot = await createShot("", h3.id,undefined,signal);signal?.throwIfAborted();
  for (const run of completed) await attachCompletedRunToShot(shot.shotId, run.runId);
  editor.updateShape({ id: h3.id, type: "h3-node", props: { shotId: shot.shotId } });
  for (const video of outputs) {
    if (video.props.runId && completed.some((run) => run.runId === video.props.runId)) editor.updateShape({ id: video.id, type: "video-node", props: { shotId: shot.shotId } });
  }
  announceShotChange(shot.shotId);
  return (await getShot(shot.shotId)) ?? shot;
}

/** Walk only this page's actual input chain; never borrow another page's H3 parameters. */
async function restoreDerivedVideoControls(editor: Editor, id: TLShape["id"]) {
  const video = editor.getShape(id);
  if (video?.type !== "video-node" || video.isLocked) return;
  const run = video.props.runId ? await getRun(video.props.runId) : null;
  const upstream = getIncomingSource(editor, id);
  if (!["seedvr2_upscale", "film_interpolation"].includes(run?.capabilityId ?? "") &&
      upstream?.type !== "upscale-node" && upstream?.type !== "smooth-node") return;
  let source = sourceH3ForDerived(editor, id);
  if (!source && video.props.shotId) {
    const shot = await getShot(video.props.shotId);
    const candidate = shot?.sourceH3NodeId ? editor.getShape(shot.sourceH3NodeId as TLShape["id"]) : undefined;
    if (candidate?.type === "h3-node" && editor.getCurrentPageShapes().some(s => s.id === candidate.id)) source = candidate as H3Node;
  }
  if (!source) throw new Error("未找到这个结果的原视频节点，不能猜测提示词和参考图；请保留来源连线");
  const asset = video.props.assetId ? await getAsset(video.props.assetId) : await getAssetBySource(video.props.src);
  if (!asset) throw new Error("输出视频资产未找到，未改变节点");
  const first = getIncomingFrameSource(editor, source.id, "first");
  const last = getIncomingFrameSource(editor, source.id, "last");
  const order = source.props.referenceImageOrder ?? [];
  const references = [
    ...getIncomingReferenceImages(editor, source.id).map(image => ({src:image.props.src, name:image.props.name, key:`node:${image.id}`})),
    ...(source.props.referenceImages ?? []).map(image => ({...image, key:`file:${JSON.stringify([image.src,image.name])}`})),
  ].sort((a,b) => (order.indexOf(a.key)<0?order.length:order.indexOf(a.key)) - (order.indexOf(b.key)<0?order.length:order.indexOf(b.key)));
  const props = structuredClone(source.props);
  const shot = await createShot("高清 / 插帧结果再创作", id);
  const current = editor.getShape(id);
  if (current?.type !== "video-node" || current.props.src !== video.props.src || current.isLocked) return;
  const {shotId: _oldShot, previewAssetId: _oldPreview, ...inputs} = props;
  void _oldShot; void _oldPreview;
  editor.markHistoryStoppingPoint("before restoring derived video controls");
  editor.run(() => {
    // Same record ID retains all input/output bindings, location, selection and the output file.
    editor.store.put([{...current, type:"h3-node", props:{
      ...editor.getShapeUtil<H3Node>("h3-node").getDefaultProps(), ...inputs,
      w:current.props.w, h:current.props.h, shotId:shot.shotId,
      referenceImages:references.map(({src,name}) => ({src,name})), referenceImageOrder:[],
      ...(first ? {sourceFrameSrc:first.props.src,sourceFrameName:first.props.name,videoFirstFrame:undefined} : {}),
      ...(last ? {inheritedLastFrame:{src:last.props.src,name:last.props.name},videoLastFrame:undefined} : {}),
      inheritedVideo:{src:asset.storageReference,name:asset.filename,assetId:asset.assetId,runId:asset.sourceRunId ?? undefined,width:asset.width,height:asset.height},
    }} as H3Node]);
    editor.select(id);
  });
  editor.markHistoryStoppingPoint("after restoring derived video controls");
  showCanvasToast("已恢复视频参数，继承原提示词、参考图和角色；高清视频保留，修改后需手动生成");
}

/** Existing canvas node for this exact output Asset, if any (keeps recovery from duplicating nodes). */
const findVideoNodeForAsset = (editor: Editor, assetId: string) => editor.getCurrentPageShapes().find((candidate) => candidate.type === "video-node" && (candidate as VideoNode).props.assetId === assetId) as VideoNode | undefined;
function presentDerivedVideo(editor: Editor, owner: UpscaleNode | SmoothNode, asset: AssetRecord, origin?: "smooth") {
  const existing = findVideoNodeForAsset(editor, asset.assetId) ?? editor.getCurrentPageShapes().find(node => node.type === "h3-node" && node.props.inheritedVideo?.assetId === asset.assetId);
  if (existing) { editor.select(existing.id); return existing; }
  const currentOwner=editor.getShape(owner.id)??owner;
  const anchorId=typeof currentOwner.meta.batchOutputAnchorId==='string'?currentOwner.meta.batchOutputAnchorId:undefined;
  const anchorNode=anchorId?editor.getShape(anchorId as TLShape['id']):undefined;
  const anchorBounds=anchorNode&&anchorNode.parentId===currentOwner.parentId?editor.getShapePageBounds(anchorNode):undefined;
  const savedAnchor=currentOwner.meta.batchOutputAnchor as BatchOutputBox|undefined;
  const ownerBounds=currentOwner.meta.batchVerticalLayout===true?editor.getShapePageBounds(currentOwner):undefined;
  const anchor=ownerBounds?{x:ownerBounds.x,y:ownerBounds.y,w:ownerBounds.w,h:ownerBounds.h}:anchorBounds?{x:anchorBounds.x,y:anchorBounds.y,w:anchorBounds.w,h:anchorBounds.h}:savedAnchor;
  const size=fittedVideoSize(editor,asset.width??1280,asset.height??720);
  const prior=anchorId?editor.getCurrentPageShapes().filter(node=>node.meta.batchOutputFor===anchorId).flatMap(node=>{const box=editor.getShapePageBounds(node);return box?[{x:box.x,y:box.y,w:box.w,h:box.h}]:[];}):[];
  const point=anchorId&&anchor?batchOutputPosition(anchor,size,prior):{x:owner.x+owner.props.w+140,y:owner.y+nextVideoOffset(editor,owner.id)};
  const id = createShapeId();
  editor.createShape({ id, type: "video-node", ...point, ...(anchorId?{meta:{batchOutputFor:anchorId}}:{}), props: { ...size, src: asset.storageReference, name: asset.filename, size: asset.fileSize ? formatBytes(asset.fileSize) : "—", duration: asset.duration ? `${asset.duration.toFixed(1)} 秒` : "—", originalPath: asset.filename, ...(origin ? { origin } : {}), fps: asset.fps, assetId: asset.assetId, runId: asset.sourceRunId ?? undefined, shotId: asset.shotId } });
  const target = editor.getShape(id) as VideoNode | undefined;
  if (!target) throw new Error("输出视频已取得，但未能创建画布节点");
  createBoundArrow(editor, owner, target);
  editor.select(id);
  return target;
}

const canvasUiComponents: TLComponents = {
  ErrorFallback: CanvasErrorFallback,
  ShapeErrorFallback: CanvasShapeErrorFallback,
  Background: CameraDotBackground,
  InFrontOfTheCanvas: () => { const editor = useEditor(); return <><ConnectionHighlightOverlay /><BatchReferenceAction editor={editor} /><BatchVideoActions editor={editor} /><CanvasInteractionUI editor={editor} /><TelegramCanvasBridge /></>; },
  Toolbar: CreativeToolbar,
  ContextMenu: FluxCanvasContextMenu,
  StylePanel: CollapsibleStylePanel,
  PageMenu: null,
  HelpMenu: null,
  SharePanel: null,
  CursorChatBubble: null,
  PeopleMenu: null,
  UserPresenceEditor: null,
  DebugMenu: null,
  DebugPanel: null,
};

const canvasInteractionOverrides: TLUiOverrides = {
  // tldraw's Chinese pack names both clipboard copy and in-canvas duplicate "复制".
  translations: { 'zh-cn': { 'action.duplicate': '创建副本' }, en: { 'action.duplicate': '创建副本' } },
  actions: (editor, actions) => ({ ...actions, delete: { ...actions.delete, onSelect: source => {
    const ids = editor.getSelectedShapeIds();
    if (!ids.length) return;
    deleteCanvasNodes(editor, ids);
  } } }),
};
const tldrawOptions = { ...canvasImageClipboardOptions, maxPages: 100, actionShortcutsLocation: "menu" as const, camera: { wheelBehavior: "zoom" as const } };

// Early head guard handles boot; this path covers an already-open tab on hot update.
installResizeNoticeGuard();

function NodeShell({ icon, eyebrow, title, accent, actions, leadingActions, outputPort, inputPort, onDownload, onDelete, onInput, onRenameTitle, children, nodeId, preview, wideH3 = false }: { icon: React.ReactNode; eyebrow: string; title: string; accent: string; actions?: React.ReactNode; leadingActions?: React.ReactNode; outputPort?: React.ReactNode; inputPort?: React.ReactNode; onDownload?: () => unknown; onDelete: () => unknown; onInput?: () => void; onRenameTitle?: (name: string) => void; children: React.ReactNode; wideH3?: boolean; nodeId?: TLShape["id"]; preview?: { src: string; kind: "image" | "video" } }) {
  const editor = useEditor();
  const detail = useValue("frameflow semantic node zoom", () => {
    const zoom = editor.getZoomLevel();
    return zoom < 0.48 ? "far" : zoom < 0.72 ? "mid" : "near";
  }, [editor]);
  const selected = useValue("node header selection", () => !!nodeId && editor.getSelectedShapeIds().includes(nodeId), [editor, nodeId]);
  const [headerHeld,setHeaderHeld]=useState(false);
  const headerTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(headerTimer.current)clearTimeout(headerTimer.current);},[]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title);
  const titleCancel = useRef(false);
  useEffect(() => { if (!editingTitle) queueMicrotask(()=>setTitleDraft(title)); }, [title, editingTitle]);
  const commitTitle = () => {
    setEditingTitle(false);
    if (titleCancel.current) { titleCancel.current = false; setTitleDraft(title); return; }
    if (titleDraft !== title) onRenameTitle?.(titleDraft);
  };
  return <div className="node-shell" data-node-wide={wideH3 ? "true" : "false"} onPointerDownCapture={event=>{if((event.target as Element).closest(".final-cut-toggle-holder")){editor.markEventAsHandled(event);event.stopPropagation();if(headerTimer.current)clearTimeout(headerTimer.current);setHeaderHeld(true);}}} onPointerUpCapture={event=>{if((event.target as Element).closest(".final-cut-toggle-holder")){editor.markEventAsHandled(event);event.stopPropagation();}}} data-node-shell data-selected={selected} data-header-held={headerHeld} data-detail={detail} onPointerEnter={()=>{if(headerTimer.current)clearTimeout(headerTimer.current);setHeaderHeld(true);}} onPointerLeave={()=>{if(headerTimer.current)clearTimeout(headerTimer.current);headerTimer.current=setTimeout(()=>setHeaderHeld(false),500);}} style={{ "--node-accent": accent } as React.CSSProperties}>
    {inputPort ?? (onInput && <button type="button" className="workflow-port workflow-input-port" aria-label="添加输入素材" title="添加输入素材" onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={(event) => { event.stopPropagation(); onInput(); }}><Plus size={14} /></button>)}
    {outputPort}
    <div className="node-header"><div className="node-icon">{icon}</div><div className="node-heading"><div className="node-eyebrow">{eyebrow}</div>{editingTitle && onRenameTitle ? <input className="node-title-input" aria-label="图片名称" value={titleDraft} autoFocus onPointerDown={stopPropagation} onClick={stopPropagation} onChange={(event) => setTitleDraft(event.target.value)} onBlur={commitTitle} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } if (event.key === "Escape") { event.preventDefault(); titleCancel.current = true; event.currentTarget.blur(); } }} /> : <div className="node-title" title={onRenameTitle ? `${title}（双击重命名）` : title} onDoubleClick={onRenameTitle ? (event) => { event.stopPropagation(); setEditingTitle(true); } : undefined} onPointerDown={onRenameTitle ? stopPropagation : undefined}>{title}</div>}</div><div className="node-header-actions">{leadingActions}{onRenameTitle && <button type="button" className="node-header-button" title="重命名" aria-label="重命名" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); setTitleDraft(title); setEditingTitle(true); }}><Pencil size={13} /></button>}{actions}{onDownload && <button type="button" className="node-header-button node-quick-download" title="下载媒体" aria-label="下载媒体" onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={(event) => { event.stopPropagation(); void onDownload(); }}><Download size={13} /></button>}<button type="button" className="node-header-button node-quick-delete" title="删除节点" aria-label="删除节点" onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={(event) => { event.stopPropagation(); void onDelete(); }}><X size={13} /></button></div></div>
    {preview?.src && <button className="media-preview-open" type="button" aria-label="打开大预览" title="打开大预览" onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={event => { event.stopPropagation(); previewMedia(preview.src, preview.kind, title); }}>⤢</button>}
    {children}
  </div>;
}

function useAutoNodeHeight(editor: Editor, shape: UpscaleNode | SmoothNode, formRef: React.RefObject<HTMLDivElement | null>, legacyHeight: number) {
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    let frame = 0;
    const fit = () => {
      if (frame) return;
      // A shape update changes this element's layout. Never write it during
      // ResizeObserver delivery, or Chromium may report an undelivered loop.
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const current = editor.getShape(shape.id);
        if (!current || (current.type !== "upscale-node" && current.type !== "smooth-node")) return;
        if (current.props.autoHeight === false || (current.props.autoHeight === undefined && current.props.h !== legacyHeight)) return;
        const height = Math.ceil(52 + form.scrollHeight);
        if (Math.abs(current.props.h - height) <= 1) return;
        editor.updateShape({ id: current.id, type: current.type, props: { h: height, autoHeight: true } });
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(form);
    fit();
    return () => { observer.disconnect(); if (frame) window.cancelAnimationFrame(frame); };
  }, [editor, formRef, legacyHeight, shape.id]);
}

function deleteNodeWithHistory(editor: Editor, shapeId: TLShape["id"]) {
  deleteCanvasNodes(editor, [shapeId]);
}

function finishImageSlotDrop(editor: Editor, initial: ImageNode, current: ImageNode) {
  endMediaMagnet(editor);
  const drop = currentImageSlotTarget(editor);
  if (!drop) return;
  const target = editor.getShape(drop.target.id) as H3Node | undefined;
  if (!target || target.isLocked) return;
  if (drop.role === "guide") {
    const slot = Number(drop.card.dataset.guideSlot);
    if (!Number.isInteger(slot)) return;
    const guides = target.props.storyboardGuides ?? [];
    const previous = guides.find((g, index) => (g.slot ?? index) === slot);
    if (!previous && guides.length + (target.props.directorContext?.guides?.length ?? 0) >= 4) { showCanvasToast("引导锚点合计最多 4 个"); return; }
    const old = editor.getCurrentPageShapes().filter(a => a.type === "arrow" && a.meta.guideSlot === slot && getArrowBindings(editor, a as TLArrowShape).end?.toId === target.id);
    editor.deleteShapes(old.map(a => a.id));
    editor.updateShape({ id: target.id, type: "h3-node", props: { storyboardGuides: [...guides.filter((g, index) => (g.slot ?? index) !== slot), { assetId: current.props.assetId ?? "", storageReference: current.props.src, filename: current.props.name, sourceNodeId: current.id, slot, anchorFrame: previous?.anchorFrame ?? Math.round((getActualDuration(target.props.duration).length - 1) * (slot + 1) / 4), atEnd: previous?.atEnd ?? false }] } });
    const id = createBoundArrow(editor, current, target, "reference");
    editor.updateShape({ id, type: "arrow", meta: { frameRole: "guide", guideSlot: slot } });
  } else {
    const role = drop.role as H3FrameRole;
    const duplicate = editor.getCurrentPageShapes().some(a => a.type === "arrow" && arrowFrameRole(a, getArrowBindings(editor, a as TLArrowShape).end?.props.normalizedAnchor.y ?? 0.16) === role && getArrowBindings(editor, a as TLArrowShape).start?.toId === current.id && getArrowBindings(editor, a as TLArrowShape).end?.toId === target.id);
    if (!duplicate) { const id = createBoundArrow(editor, current, target, role); editor.updateShape({ id, type: "arrow", meta: { frameRole: role } }); }
  }
  showCanvasToast(`已加入${slotLabel(drop.role)}，原图片位置保留`);
  queueMicrotask(() => window.dispatchEvent(new CustomEvent("canvas-slot-attached", { detail: target.id })));
  return { id: current.id, type: "image-node" as const, x: initial.x, y: initial.y };
}

function inferVideoSceneNumber(editor: Editor, video: VideoNode, seen = new Set<string>()): number | undefined {
  if (video.props.sceneNumber) return video.props.sceneNumber;
  if (seen.has(video.id)) return undefined;
  seen.add(video.id);
  const upstreamH3 = getIncomingSource(editor, video.id, "h3-node") as H3Node | null;
  if (!upstreamH3) return undefined;
  const upstreamVideo = getIncomingSource(editor, upstreamH3.id, "video-node") as VideoNode | null;
  return upstreamVideo ? (inferVideoSceneNumber(editor, upstreamVideo, seen) ?? 1) + 1 : 1;
}

function nextVideoOffset(editor: Editor, shapeId: CustomNode["id"]) {
  return getOutgoingTargets(editor, shapeId, "video-node").reduce((offset, target) => offset + target.props.h + 34, 0);
}

const tailHDStarts=new Set<string>();

function useProcessingController(id:string,read:()=>{ready:boolean;generate:()=>Promise<ProcessingResult|undefined>}){
  const current=useRef(read);useEffect(()=>{current.current=read;});
  useEffect(()=>registerProcessing(id,()=>current.current()),[id]);
}

class ImageNodeUtil extends BaseBoxShapeUtil<ImageNode> {
  override onTranslateStart(shape: ImageNode) { startMediaMagnet(this.editor, shape); }
  override onTranslate(_initial: ImageNode, current: ImageNode) { return translateMediaMagnet(this.editor, current); }
  override onTranslateEnd(initial: ImageNode, current: ImageNode) { return finishImageSlotDrop(this.editor, initial, current); }
  override onTranslateCancel() { endMediaMagnet(this.editor); }
  static override type = "image-node" as const;
  static override props = { w: T.number, h: T.number, src: T.string, name: T.string, originalPath: T.string, naturalWidth: T.optional(T.number), naturalHeight: T.optional(T.number), assetId: T.optional(T.string) };
  override getDefaultProps(): ImageNode["props"] { return { w: 340, h: 290, src: "", name: "未命名图片", originalPath: "" }; }
  override component(shape: ImageNode) { return <CulledShape editor={this.editor} shapeId={shape.id}><ImageNodeContent shape={shape} editor={this.editor} /></CulledShape>; }
  override hideSelectionBoundsBg() { return true; }
  override hideSelectionBoundsFg() { return true; }
  override getIndicatorPath(): Path2D { return new Path2D(); }
}

async function renameImageNode(editor: Editor, shape: ImageNode, raw: string) {
  let filename: string;
  try { filename = normalizeAssetFilename(raw); }
  catch (cause) { showCanvasToast(cause instanceof Error ? cause.message : "名称无效"); return; }
  if (filename === shape.props.name) return;
  const previous = shape.props.name;
  editor.updateShape({ id: shape.id, type: "image-node", props: { name: filename } });
  const assetId = shape.props.assetId;
  if (!assetId) return;
  try {
    await renameAsset(assetId, filename);
    announceAssetRenamed(assetId, filename);
  } catch (cause) {
    if (editor.getShape(shape.id)?.type === "image-node") editor.updateShape({ id: shape.id, type: "image-node", props: { name: previous } });
    showCanvasToast(cause instanceof Error ? cause.message : "重命名失败");
  }
}

function applyRenamedAsset(editor: Editor, assetId: string, filename: string) {
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type === "image-node" && shape.props.assetId === assetId && shape.props.name !== filename) editor.updateShape({ id: shape.id, type: "image-node", props: { name: filename } });
  }
}

async function replaceImageFile(editor: Editor, shape: ImageNode, file: File) {
  const temp = URL.createObjectURL(file);
  try {
    const natural = await getImageSize(temp);
    const src = await storeLocalImage(file, file.name);
    const asset = await importedAsset(src, "image", file, { width: natural.width, height: natural.height });
    editor.updateShape({ id: shape.id, type: "image-node", props: { ...imageNodeSize(natural.width, natural.height), src, name: file.name, originalPath: file.webkitRelativePath || file.name, naturalWidth: natural.width, naturalHeight: natural.height, assetId: asset.assetId } });
  } finally { URL.revokeObjectURL(temp); }
}

function ImageNodeContent({ shape, editor }: { shape: ImageNode; editor: Editor }) {
  const input = useRef<HTMLInputElement>(null);
  const [idCopied, setIdCopied] = useState(false);
  const [rolePicker, setRolePicker] = useState(false);
  const mediaNear = useMediaActive(editor, shape.id);
  const imageRead = useImageThumbnail(mediaNear ? shape.props.src : "", 640, shape.id);
  const url = imageRead.url;
  const assetId = shape.props.assetId ?? "";
  const copyAssetId = () => {
    if (!assetId) return;
    void copyPlainText(assetId).then((ok) => {
      setIdCopied(ok);
      showCanvasToast(ok ? "已复制 Asset ID" : "复制失败，请手动选择图片节点上的 Asset ID");
    });
  };
  useEffect(() => { if (!shape.props.src) return; let active = true; void (async () => {
    const current = shape.props.assetId ? await getAsset(shape.props.assetId) : null;
    const liveName = () => { const live = editor.getShape(shape.id); return live?.type === "image-node" ? live.props.name : shape.props.name; };
    if (current?.storageReference === shape.props.src) {
      const name = liveName();
      if (name && name !== current.filename) await renameAsset(current.assetId, name);
      return;
    }
    const details = { width: shape.props.naturalWidth, height: shape.props.naturalHeight };
    if (shape.props.src.startsWith("data:")) {
      const blob = await getLocalImageBlob(shape.props.src);
      const src = await storeLocalImage(blob, shape.props.name);
      const asset = await ensureLegacyAsset(src, "image", shape.props.name, { ...details, fileSize: blob.size }, blob.type);
      const name = liveName();
      if (name && name !== asset.filename) await renameAsset(asset.assetId, name);
      if (active && editor.getShape(shape.id)?.type === "image-node") editor.updateShape({ id: shape.id, type: "image-node", props: { src, assetId: asset.assetId } });
      return;
    }
    const asset = await assetForSource(shape.props.src, "image", shape.props.name, details);
    const name = liveName();
    if (name && name !== asset.filename) await renameAsset(asset.assetId, name);
    if (active && editor.getShape(shape.id)?.type === "image-node") editor.updateShape({ id: shape.id, type: "image-node", props: { assetId: asset.assetId } });
  })().catch((cause) => showCanvasToast(cause instanceof Error ? cause.message : "旧图片资产登记失败")); return () => { active = false; }; }, [editor, shape.id, shape.props.src, shape.props.name, shape.props.assetId, shape.props.naturalWidth, shape.props.naturalHeight]);
  useEffect(() => {
    const { naturalWidth, naturalHeight } = shape.props;
    if (!naturalWidth || !naturalHeight) return;
    const previous = legacyImageNodeSize(naturalWidth, naturalHeight);
    if (Math.abs(shape.props.w - previous.w) > 1 || Math.abs(shape.props.h - previous.h) > 1) return;
    const fitted = imageNodeSize(naturalWidth, naturalHeight);
    if (Math.abs(shape.props.w - fitted.w) <= 1 && Math.abs(shape.props.h - fitted.h) <= 1) return;
    editor.updateShape({ id: shape.id, type: "image-node", props: fitted });
  }, [editor, shape.id, shape.props.naturalWidth, shape.props.naturalHeight, shape.props.w, shape.props.h]);
  return <><HTMLContainer className="node-container node-minimal image-media-node"><NodeShell nodeId={shape.id} preview={{src:shape.props.src,kind:"image"}} icon={<ImageIcon size={17} />} eyebrow="图片" title={shape.props.name} onRenameTitle={(name) => { void renameImageNode(editor, shape, name); }} accent="#858585" leadingActions={<button type="button" className="node-header-button" title="添加进角色" aria-label="添加进角色" disabled={!assetId} onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); setRolePicker(true); }}><Users size={13} /></button>} onDownload={() => downloadNodeMedia(shape.props.src, shape.props.name, "image")} onInput={() => input.current?.click()} onDelete={() => deleteNodeWithHistory(editor, shape.id)} actions={<><button type="button" className="node-header-button" title="更换图片" aria-label="更换图片" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); input.current?.click(); }}><ImageIcon size={14} /></button></>} outputPort={<WorkflowPort editor={editor} shape={shape} />}><div className="image-asset-id" onPointerDown={stopPropagation}><span>Asset ID</span><code title={assetId}>{assetId || "正在登记"}</code><button type="button" disabled={!assetId} aria-label="复制 Asset ID" onClick={(event) => { event.stopPropagation(); copyAssetId(); }}>{idCopied ? "已复制" : "复制"}</button></div><div className="image-stage">{url ? <img src={url} alt={shape.props.name} decoding="async" draggable={false} onError={() => imageRead.fail("图片解码失败，请重新选择原图")} /> : imageRead.error ? <button type="button" role="alert" title={imageRead.error} onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); input.current?.click(); }}>图片无法读取 · 重新选择</button> : mediaNear && shape.props.src ? <span>正在恢复图片…</span> : <ImageIcon size={28} />}</div><div className="node-meta"><span>源文件</span><b title={shape.props.originalPath}>{shape.props.originalPath}</b></div><input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onPointerDown={stopPropagation} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void replaceImageFile(editor, shape, file).catch((cause) => showCanvasToast(cause instanceof Error ? cause.message : "更换图片失败")); }} /></NodeShell></HTMLContainer>{rolePicker && assetId && <ImageRoleDialog assetId={assetId} onClose={() => setRolePicker(false)} onSaved={() => { setRolePicker(false); showCanvasToast("图片已加入角色外观参考，可在角色库里查看"); }} />}</>;
}

type CanvasPickerItem={id:TLShape["id"];kind:"image"|"video"|"audio";src:string;name:string};
function CanvasPickerCard({item,onChoose,disabled}:{item:CanvasPickerItem;onChoose:()=>void;disabled:boolean}){
  const url=useImageThumbnail(item.kind==="image"?item.src:"",160).url;
  return <button type="button" disabled={disabled} onClick={onChoose} style={{display:"flex",alignItems:"center",gap:12,textAlign:"left",padding:10,border:"1px solid var(--ff-border-strong)",borderRadius:9,background:"var(--ff-control)",color:"var(--ff-text)",minWidth:0}}>
    {url?<img src={url} alt="" decoding="async" style={{width:56,height:56,objectFit:"contain"}}/>:item.kind==="audio"?<Mic2 size={28}/>:<Video size={28}/>}
    <span style={{overflowWrap:"anywhere"}}>{item.name}</span>
  </button>;
}
function CanvasMediaPicker({items,title,ownerNodeId,onChoose,onClose}:{items:CanvasPickerItem[];title:string;ownerNodeId:TLShape["id"];onChoose:(id:TLShape["id"])=>Promise<void>;onClose:()=>void}){
  const [query,setQuery]=useState(""),[error,setError]=useState(""),[working,setWorking]=useState(false);
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.stopPropagation();onClose();}};window.addEventListener("keydown",escape,true);return()=>window.removeEventListener("keydown",escape,true);},[onClose]);
  const visible=items.filter(item=>item.name.toLowerCase().includes(query.toLowerCase()));
  return createPortal(<div className="generation-info-backdrop" data-h3-picker-for={ownerNodeId} onPointerDown={event=>{event.stopPropagation();if(event.target===event.currentTarget)onClose();}} onPointerUp={stopPropagation} onClick={stopPropagation}><section className="generation-info-panel asset-picker-panel" role="dialog" aria-label={title} aria-modal="true" style={{width:"min(680px,90vw)",maxHeight:"80vh",overflow:"auto",background:"var(--ff-raised)",color:"var(--ff-text)",border:"1px solid var(--ff-border-strong)",borderRadius:16,padding:20}} onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={stopPropagation} onKeyDown={stopPropagation}>
    <header style={{display:"flex",justifyContent:"space-between",marginBottom:12}}><b>{title}</b><button type="button" onClick={onClose}>关闭</button></header>
    <p style={{fontSize:13,color:"var(--ff-text-2)"}}>仅显示当前画布已有素材。不会复制文件或移动原节点。新素材请先从画布导入。</p>
    <input aria-label="搜索画布素材" placeholder="搜索素材名称…" value={query} onChange={e=>setQuery(e.target.value)} style={{width:"100%",marginBottom:14,padding:8}}/>
    <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10}}>{visible.map(item=><CanvasPickerCard key={item.id} item={item} disabled={working} onChoose={()=>{if(working)return;setWorking(true);setError("");void onChoose(item.id).catch(cause=>setError(cause instanceof Error?cause.message:"添加失败")).finally(()=>setWorking(false));}}/>)}</div>
    {!visible.length&&<p>画布里没有符合条件的素材，请先导入或生成。</p>}{error&&<p role="alert" style={{color:"var(--ff-bad)"}}>{error}</p>}
  </section></div>,document.body);
}
function Segmented({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }) { return <div className="segmented">{options.map((item) => <button type="button" key={item} className={value === item ? "active" : ""} onClick={() => onChange(item)}>{item}</button>)}</div>; }

function ReferenceSlot({ src, name, kind, label, onRemove, onReplace }: { src: string; name: string; kind: "image" | "video" | "audio"; label: string; onRemove: () => void; onReplace?: () => void }) {
  const imageUrl = useImageThumbnail(kind === "image" ? src : "", 256).url;
  return <div className="reference-item" data-frame-role={kind === "image" ? "reference" : undefined}><div className="reference-thumbnail">{kind === "image" && imageUrl ? <ReferenceHoverPreview key={imageUrl} url={imageUrl} name={name} label={label} /> : kind === "video" ? <Film size={16} /> : kind === "audio" ? "♪" : "·"}</div><span title={name}>{label} · {name}</span>{onReplace && <button type="button" title="更换" onClick={onReplace}>更换</button>}<button type="button" title="移除" onClick={onRemove}><X size={13} /></button></div>;
}

function RoleBindingChip({ role, order, speaking, appearanceOnly = false, offscreen = false, onRemove }: { role: RoleRecord | null; order: number; speaking: boolean; appearanceOnly?: boolean; offscreen?: boolean; onRemove: () => void }) {
  const [appearance, setAppearance] = useState<AssetRecord | null>(null);
  const [voice, setVoice] = useState<AssetRecord | null>(null);
  const appearanceId = offscreen ? null : role?.primaryAppearanceAssetId ?? null;
  const voiceId = appearanceOnly ? null : role?.primaryVoiceAssetId ?? null;
  useEffect(() => { let active = true; void Promise.all([appearanceId ? getAsset(appearanceId) : null, voiceId ? getAsset(voiceId) : null]).then(([nextAppearance, nextVoice]) => { if (active) { setAppearance(nextAppearance); setVoice(nextVoice); } }).catch(() => {}); return () => { active = false; }; }, [appearanceId, voiceId]);
  const imageUrl = useImageThumbnail(appearance?.storageReference ?? "", 160).url;
  if (!role) return <div className="reference-item role-chip missing"><div className="reference-thumbnail">?</div><span>角色 {order} · 角色不存在或已删除</span><button type="button" title="移除" onClick={onRemove}><X size={13} /></button></div>;
  const voiceStatus = appearanceOnly ? "仅外观参考，不提交主声音" : speaking ? (voice ? `主声音：${voice.filename}` : "⚠ 已指定说话但没有主声音") : voice ? "未指定说话角色或台词，不提交声音" : "无主声音";
  return <div className="reference-item role-chip"><div className="reference-thumbnail">{imageUrl ? <img src={imageUrl} alt="" decoding="async" draggable={false} /> : "·"}</div><span title={`${role.displayName} · ${offscreen ? "仅画外音，不提交主外观" : appearance ? `主外观：${appearance.filename}` : "没有主外观"} · ${voiceStatus}`}><b>{role.displayName}</b> · {offscreen ? "画外音 · 无角色图" : appearance ? "主外观 ✓" : "⚠ 无主外观"} · {voiceStatus}</span><button type="button" title="移除角色" onClick={onRemove}><X size={13} /></button></div>;
}

class H3NodeUtil extends BaseBoxShapeUtil<H3Node> {
  override onTranslateStart(shape: H3Node) { startMediaMagnet(this.editor, shape); }
  override onTranslate(_initial: H3Node, current: H3Node) { return translateMediaMagnet(this.editor, current); }
  override onTranslateEnd() { endMediaMagnet(this.editor); }
  override onTranslateCancel() { endMediaMagnet(this.editor); }
  static override type = "h3-node" as const;
  override hideSelectionBoundsBg() { return true; }
  override hideSelectionBoundsFg() { return true; }
  override hideResizeHandles() { return true; }
  // The composer is an interactive overlay, not part of the selectable media card.
  // Keep saved layout dimensions unchanged so toggling it cannot move bound arrows.
  override getGeometry(shape: H3Node) {
    const preview = shape.props.previewHeight ?? h3PreviewSize(16, 9, shape.props.w).h;
    return new Rectangle2d({ width: shape.props.w, height: 32 + preview, isFilled: true });
  }
static override props = { inheritedLastFrame: T.optional(T.object({src: T.string, name: T.string})), inheritedVideo: T.optional(T.object({ src: T.string, name: T.string, assetId: T.string, runId: T.optional(T.string), width: T.optional(T.number), height: T.optional(T.number) })), w: T.number, h: T.number, previewAssetId: T.optional(T.string), previewWidth: T.optional(T.number), previewHeight: T.optional(T.number), prompt: T.string, workflowOptionId: T.optional(T.string), workflowLock: T.optional(T.string), communityParameters: T.optional(T.string), allReferenceMode: T.optional(T.boolean), extensionSourceVideo: T.optional(T.object({ src: T.string, name: T.string })), generationCount: T.optional(T.number), storyboardGuides: T.optional(T.arrayOf(T.object({ assetId: T.string, storageReference: T.string, filename: T.string, anchorFrame: T.number, atEnd: T.boolean, slot: T.optional(T.number), sourceNodeId: T.optional(T.string) }))), timeAnchors: T.optional(T.arrayOf(T.object({ storageReference: T.string, filename: T.string, atSeconds: T.number, asReference: T.optional(T.boolean), assetId: T.optional(T.string) }))), promptHeight: T.optional(T.number), mode: T.string, duration: T.string, seedMode: T.string, seed: T.string, megapixels: T.optional(T.number), turbo: T.optional(T.boolean), steps: T.optional(T.number), fps: T.optional(T.number), loraStrength: T.optional(T.number), upscaleMethod: T.optional(T.string), resolutionSteps: T.optional(T.number), collapsed: T.optional(T.boolean), videoFirstFrame: T.optional(T.object({ src: T.string, name: T.string, sourceNodeId: T.string })), videoLastFrame: T.optional(T.object({ src: T.string, name: T.string, sourceNodeId: T.string })), sourceFrameSrc: T.optional(T.string), sourceFrameName: T.optional(T.string), sourceH3Id: T.optional(T.string), soundMode: T.optional(T.string), referenceImageOrder: T.optional(T.arrayOf(T.string)), referenceImages: T.optional(T.arrayOf(T.object({ src: T.string, name: T.string }))), referenceVideos: T.optional(T.arrayOf(T.object({ src: T.string, name: T.string, withAudio: T.optional(T.boolean) }))), referenceAudios: T.optional(T.arrayOf(T.object({ src: T.string, name: T.string }))), lastSubmittedPrompt: T.optional(T.string), lastSubmittedSeed: T.optional(T.number), lockedRunId:T.optional(T.string),lockedAssetId:T.optional(T.string), shotId: T.optional(T.string), roleIds: T.optional(T.arrayOf(T.string)), voiceRoleId: T.optional(T.string), voiceRoleIds: T.optional(T.arrayOf(T.string)), autoVoiceDisabled: T.optional(T.boolean), offscreenRoleIds: T.optional(T.arrayOf(T.string)), noBackgroundMusic: T.optional(T.boolean), autoRemoveMusic: T.optional(T.boolean), roleSnapshot: T.optional(T.string), shotTitle: T.optional(T.string), dialogueLines: T.optional(T.arrayOf(T.object({ roleId: T.string, text: T.string, speaker: T.optional(T.string), voice: T.optional(T.string) }))), promptMode: T.optional(T.string), hybridLock: T.optional(T.boolean), ultimateKeyframes: T.optional(T.boolean), directorContext: T.optional(T.object({ sceneId: T.string, sceneStateId: T.optional(T.string), controlPackageIds: T.arrayOf(T.string), assetIds: T.arrayOf(T.string), guides: T.optional(T.arrayOf(T.object({ packageId: T.string, assetId: T.string, storageReference: T.string, filename: T.string, anchorFrame: T.number }))), cameraId: T.optional(T.string), motionIds: T.optional(T.arrayOf(T.string)) })), zhengbenVersion: T.optional(T.string) };
  override getDefaultProps(): H3Node["props"] { return { workflowOptionId: "community-ultimate", w: H3_NODE_WIDTH, h: H3_DEFAULT_HEIGHT, prompt: "", mode: "follow", duration: "5.875", seedMode: "随机", seed: "", megapixels: H3_MEGAPIXELS, turbo: H3_TURBO, steps: H3_STEPS, fps: H3_FPS, loraStrength: H3_LORA_STRENGTH, upscaleMethod: H3_UPSCALE_METHOD, resolutionSteps: H3_RESOLUTION_STEPS, collapsed: false, sourceFrameSrc: "", sourceFrameName: "", sourceH3Id: "", soundMode: "av", referenceImages: [], referenceVideos: [], referenceAudios: [] }; }
  override component(shape: H3Node) { return <CulledShape editor={this.editor} shapeId={shape.id}><H3NodeContent shape={shape} editor={this.editor} /></CulledShape>; }
  override getIndicatorPath(): Path2D { return new Path2D(); }
}

const statusLabels: Record<AiGenerationStatus, string> = { disconnected: "未连接", connected: "已连接", preparing: "准备中", uploading: "上传首帧", queued: "排队中", loading: "加载模型", running: "生成中", decoding: "解码中", fetching: "获取视频", completed: "已完成", cancelled: "已取消", failed: "失败" };
const busyStatuses: AiGenerationStatus[] = ["preparing", "uploading", "queued", "loading", "running", "decoding", "fetching"];
class PreflightBlockedError extends Error { constructor() { super("生成前检查未通过"); this.name = "PreflightBlockedError"; } }

function humanizeGenerationError(cause: unknown) { const message = cause instanceof Error ? cause.message : "H3 生成失败"; if (/out of memory|cuda.*memory|allocation on device/i.test(message)) return "显存不足：请降低时长或像素预算后重试"; if (/AbortError|已取消/i.test(message)) return "生成已取消"; return message; }

/** A lazy view of the existing result Asset, not a second generated result. */
function H3ResultPreview({ editor, nodeId, source, firstPreview, stillSource = "", busy, caption, selected, size, onDimensions, onActivate }: { onActivate: () => void; size: { w: number; h: number }; onDimensions: (source: string, width: number, height: number) => void; editor: Editor; nodeId: H3Node["id"]; source: string; firstPreview: string; stillSource?: string; busy: boolean; caption: string; selected: boolean }) {
  const [requested, setRequested] = useState(false);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const near = useMediaActive(editor, nodeId);
  const cached = useVideoPoster(source);
  const playerActive = useVideoActive(Boolean(source) && near && (requested || playing), requested || playing, playing && near, source);
  const url = useAcquiredMediaUrl(source, playerActive);
  useEffect(() => {
    const video = videoRef.current;
    return () => { if (!video) return; video.pause(); video.removeAttribute("src"); video.load(); };
  }, [url]);
  const poster = cached.poster || firstPreview;
  useEffect(() => { queueMicrotask(() => { setRequested(false); setPlaying(false); }); }, [source]);
  useEffect(() => { if (!selected || !near) {
    document.querySelector<HTMLVideoElement>(`[data-node-id="${CSS.escape(nodeId)}"] video`)?.pause();
    queueMicrotask(() => { setRequested(false); setPlaying(false); });
  } }, [selected, near, nodeId]);
  useEffect(() => { const pauseHidden = () => { if (document.hidden) {
    document.querySelector<HTMLVideoElement>(`[data-node-id="${CSS.escape(nodeId)}"] video`)?.pause();
    setRequested(false); setPlaying(false);
  } }; document.addEventListener("visibilitychange", pauseHidden); return () => document.removeEventListener("visibilitychange", pauseHidden); }, [nodeId]);
  // Only the native control bar keeps the pointer; pressing the picture itself lets tldraw select / drag the node.
  const gesture = useRef<{ x: number; y: number; pointerId: number; controls: boolean; moved: boolean; rect: DOMRect } | null>(null);
  const dragged = useRef(false);
  const controlClick = useRef(false);
  const togglePlayback = () => {
    if (!source) { onActivate(); return; }
    editor.select(nodeId);
    const video = document.querySelector<HTMLVideoElement>(`[data-node-id="${CSS.escape(nodeId)}"] video`);
    if (!video) { setRequested(true); return; }
    setRequested(false);
    if (!video.paused && !video.ended) video.pause();
    else void video.play().catch(() => showCanvasToast("请再次点击播放"));
  };
  const pictureTap = (x: number, y: number) => {
    const preview = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"].h3-preview`);
    if (preview) queueVideoTap(preview, x, y, togglePlayback, onActivate);
  };
  // tldraw captures the pointer, so pointerup/click may no longer target the media.
  // Observe the real gesture in capture phase instead of relying on a media click.
  const gestureCleanup=useRef<(()=>void)|null>(null);
  useEffect(() => {
    const preview = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"].h3-preview`);
    return () => { gestureCleanup.current?.(); cancelVideoTap(preview); };
  }, [nodeId, source]);
  const observeGesture = () => {
    gestureCleanup.current?.();
    const move = (event: globalThis.PointerEvent) => {
      const start = gesture.current;
      if (start?.pointerId === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) start.moved = true;
    };
    const finish = (event: globalThis.PointerEvent) => {
      const start = gesture.current;
      if (!start || start.pointerId !== event.pointerId) return;
      gesture.current = null;
      dragged.current = start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4;
      const inside = event.clientX >= start.rect.left && event.clientX <= start.rect.right && event.clientY >= start.rect.top && event.clientY <= start.rect.bottom;
      if (!start.controls && !dragged.current && inside) { dragged.current = true; pictureTap(event.clientX, event.clientY); }
    };
    const cancel = () => { gesture.current = null; dragged.current = true; };
    if(gesture.current) gestureCleanup.current=observeMediaGesture(document,gesture.current.pointerId,move,finish,cancel);
  };
  const mediaPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const scale = element.offsetHeight ? rect.height / element.offsetHeight : 1;
    const controls = element instanceof HTMLVideoElement && event.clientY > rect.bottom - NATIVE_VIDEO_CONTROLS_BAND * scale;
    if (event.button !== 0) return;
    controlClick.current = controls;
    dragged.current = false;
    gesture.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, controls, moved: false, rect };
    observeGesture();
    if (controls) event.stopPropagation();
  };
  const mediaPointerUp = (event: React.PointerEvent<HTMLVideoElement | HTMLImageElement>) => { if (event.currentTarget instanceof HTMLVideoElement) event.stopPropagation(); };
  const mediaClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (controlClick.current) return;
    event.preventDefault();
    // A drag must neither open the composer nor toggle native video playback.
    if (dragged.current) { event.preventDefault(); return; }
    pictureTap(event.clientX, event.clientY);
  };
  return <div className={`h3-preview ${busy ? "is-busy" : ""}`} data-node-id={nodeId} data-result-source={source} title="单击暂停／继续，双击打开视频节点设置" style={{ width: size.w, height: size.h }} onPointerDown={(event) => { if (!(event.target instanceof HTMLVideoElement) && !(event.target instanceof HTMLImageElement) && !(event.target as HTMLElement).closest("button")) mediaPointerDown(event); }} onClick={mediaClick} onDoubleClick={event => { if (!controlClick.current) { event.preventDefault(); event.stopPropagation(); } }}>
    {url ? <video ref={videoRef} key={url} src={url} poster={poster} onPlay={() => { setRequested(false); setPlaying(true); }} onPause={event => { rememberVideoPosition(nodeId+source,event.currentTarget); setRequested(false); setPlaying(false); }} onEnded={() => { clearVideoPosition(nodeId+source); setRequested(false); setPlaying(false); }} controls playsInline preload="metadata" draggable={false} onPointerDown={mediaPointerDown} onPointerUp={mediaPointerUp} onClick={mediaClick} onTimeUpdate={event => { rememberVideoPosition(nodeId+source,event.currentTarget); pauseVideoOutsideViewport(event.currentTarget); }} onLoadedMetadata={(event) => { restoreVideoPosition(nodeId+source,event.currentTarget); onDimensions(source, event.currentTarget.videoWidth, event.currentTarget.videoHeight); if (!requested) preparePosterFrame(event.currentTarget); if(requested && selected && near) void event.currentTarget.play().catch(()=>setRequested(false)); }} onLoadedData={(event) => { capturePoster(source, event.currentTarget); }} onSeeked={(event) => capturePoster(source, event.currentTarget)} /> : <>
      {poster && near ? <img src={poster} alt={source ? "视频封面" : "首帧预览"} decoding="async" draggable={false} onPointerDown={mediaPointerDown} onPointerUp={mediaPointerUp} onClick={mediaClick} /> : <Video size={34} />}
      {source && <button type="button" className="h3-preview-play" aria-label="播放当前候选" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); togglePlayback(); }}><Video size={24} /><span>播放</span></button>}
    </>}
    {caption && (busy || !source) && <span>{caption}</span>}
    <button className="h3-preview-edit" type="button" aria-label="编辑视频节点" title="打开视频节点设置，不切换播放状态" onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={event => { event.stopPropagation(); onActivate(); }}><Pencil size={14} /><span>编辑视频节点</span></button>
    {(source || stillSource || firstPreview) && <button className="media-preview-open" type="button" aria-label="打开大预览" onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={event => { event.stopPropagation(); previewMedia(source || stillSource || firstPreview, source ? "video" : "image", "视频预览"); }}>⤢</button>}
  </div>;
}

function H3NodeContent({ shape, editor }: { shape: H3Node; editor: Editor }) {
  const selected = useValue("H3 creative dock selection", () => editor.getOnlySelectedShapeId() === shape.id, [editor, shape.id]);
  // A pinned dock reopens if this node is remounted (page switch, culling).
  const [dockOpen, setDockOpen] = useState(() => Boolean(shape.props.inheritedVideo) || isDockPinned(shape.id));
  const [referenceDragHold, setReferenceDragHold] = useState(false);
  const [framePicker, setFramePicker] = useState<"first" | "last" | null>(null);
  const [canvasReferencePicker,setCanvasReferencePicker]=useState<"referenceImages"|"referenceVideos"|"referenceAudios"|null>(null);
  const pickerOpen=!!framePicker||!!canvasReferencePicker;
  const activatePreview = () => { editor.select(shape.id); setDockOpen(true); };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState("basic");
  // The dock stays pinned once opened: clicking or panning empty canvas keeps it. Another shape taking the
  // selection, Esc (outside text fields) or the 收起 button closes it. Nodes created with dockOpen=true
  // (tail-frame continuations) still only show it after being selected, so a page load never pops docks open.
  // Shared pin (lib/dock-pin): the culling wrapper keeps a pinned node mounted through zoom and pan.
  const dockPinned = useValue("H3 creative dock pinned", () => pinnedDockShapeId.get() === shape.id, [shape.id]);
  const otherSelected = useValue("H3 creative dock: another shape selected", () => { const ids = editor.getSelectedShapeIds(); return ids.length > 0 && !(ids.length === 1 && ids[0] === shape.id); }, [editor, shape.id]);
  const closeDock = useCallback(() => { setDockOpen(false); setSettingsOpen(false); unpinDock(shape.id); }, [shape.id]);
  useEffect(() => { if (selected && dockOpen) queueMicrotask(() => pinDock(shape.id)); }, [selected, dockOpen, shape.id]);
  useEffect(() => () => { if (!editor.getShape(shape.id)) unpinDock(shape.id); }, [editor, shape.id]);
  useEffect(() => { if (otherSelected && !referenceDragHold && !pickerOpen) queueMicrotask(closeDock); }, [otherSelected, referenceDragHold, pickerOpen, closeDock]);
  useEffect(() => {
    if (!dockOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing && !isTypingTarget(event.target) && !pickerOpen) closeDock(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dockOpen, pickerOpen, closeDock]);
  useEffect(() => {
    const finish = () => setReferenceDragHold(false);
    const attached = (event: Event) => { if ((event as CustomEvent<string>).detail === shape.id) { editor.select(shape.id); setDockOpen(true); } };
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
    window.addEventListener("canvas-slot-attached", attached);
    return () => { document.removeEventListener("pointerup", finish); document.removeEventListener("pointercancel", finish); window.removeEventListener("canvas-slot-attached", attached); };
  }, [editor, shape.id]);
  const settingsAnchor = useRef<HTMLElement | null>(null);
  const settingsPanel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!dockOpen) return;
    const dismissDock = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if(target?.closest<HTMLElement>('[data-h3-picker-for]')?.dataset.h3PickerFor===shape.id)return;
      const surface = target?.closest<HTMLElement>(".h3-preview, .h3-inline-composer, .h3-workflow-menu");
      if (surface?.dataset.nodeId === shape.id || settingsPanel.current?.contains(target)) return;
      if (target?.closest(".tl-shape[data-shape-type='image-node'] .image-stage")) { setReferenceDragHold(true); return; }
      // Empty canvas, panning, toolbars and other panels keep the dock; only another node takes it over.
      const otherShape = target?.closest<HTMLElement>(".tl-shape");
      if (otherShape && otherShape.dataset.shapeId !== shape.id) closeDock();
    };
    document.addEventListener("pointerdown", dismissDock, true);
    return () => document.removeEventListener("pointerdown", dismissDock, true);
  }, [dockOpen, shape.id, closeDock]);
  const [popupPosition, setPopupPosition] = useState<{ left: number; top?: number; bottom?: number; height: number; maxHeight: number }>({ left: 8, top: 8, height: 440, maxHeight: 440 });
  const openSettings = (button: HTMLElement, view = "basic") => { editor.select(shape.id); if (settingsOpen && settingsAnchor.current === button) { setSettingsOpen(false); return; } settingsAnchor.current = button; setSettingsView(view); setSettingsOpen(true); };
  useEffect(() => {
    if (!settingsOpen) return;
    const position = () => {
      const rect = settingsAnchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 16);
      const above = rect.top - 16;
      const below = window.innerHeight - rect.bottom - 16;
      const height = Math.min(440, Math.max(above, below));
      const next = { left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), ...(above >= below ? { bottom: Math.max(8, window.innerHeight - rect.top + 8) } : { top: rect.bottom + 8 }), height: Math.max(100, height), maxHeight: Math.max(100, height) };
      setPopupPosition((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const dismiss = (event: globalThis.PointerEvent) => {
      if (!settingsPanel.current?.contains(event.target as Node) && !settingsAnchor.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setSettingsOpen(false); };
    position();
    const unlisten = editor.store.listen(position);
    window.addEventListener("resize", position);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    return () => { unlisten(); window.removeEventListener("resize", position); document.removeEventListener("pointerdown", dismiss, true); document.removeEventListener("keydown", escape); };
  }, [editor, settingsOpen]);
  const [videoDimensions, setVideoDimensions] = useState<{ source: string; width: number; height: number } | null>(null);
  const receiveVideoDimensions = useCallback((source: string, width: number, height: number) => { if (width > 0 && height > 0) setVideoDimensions({ source, width, height }); }, []);
  const [inputView, setInputView] = useState(shape.props.allReferenceMode ? "多参考" : "顺序图片");
  const [picturesExpanded, setPicturesExpanded] = useState(false);
  const [previewCandidateId, setPreviewCandidateId] = useState("");
  const [candidateOptions, setCandidateOptions] = useState<Awaited<ReturnType<typeof getShotCandidates>>>([]);
  const [candidateVersions, setCandidateVersions] = useState<AssetRecord[]>([]);
  const [status, setStatus] = useState<AiGenerationStatus>("disconnected");
  const [error, setError] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [shot, setShot] = useState<ShotRecord | null>(null);
  const [candidateCount, setCandidateCount] = useState(0);
  const [batchProgress, setBatchProgress] = useState<{ index: number; count: number } | null>(null);
  const batchStopRef = useRef(false);
  const stoppedRef = useRef(false);
  const [showCandidates, setShowCandidates] = useState(false);
  // Closed pickers must not subscribe every H3 node to the entire page's shapes.
  const canvasMedia=useValue("existing canvas reference media",()=>!(framePicker||canvasReferencePicker)?null:editor.getCurrentPageShapes().flatMap<CanvasPickerItem>(node=>{
    const image=referenceImageOf(node);
    if(image?.props.src)return [{id:node.id,kind:"image" as const,src:image.props.src,name:image.props.name}];
    if((node.type==="audio-node"||node.type==="tts-node"||node.type==="music-node")&&node.props.src)return [{id:node.id,kind:"audio" as const,src:node.props.src,name:node.props.name}];
    if(node.type==="video-node"&&node.props.src)return [{id:node.id,kind:"video" as const,src:node.props.src,name:node.props.name}];
    return [];
  }),[editor,framePicker,canvasReferencePicker])??[];
  const [revision, setRevision] = useState(0);
  const [progress, setProgress] = useState<H3GenerationUpdate>({ status: "disconnected" });
  const duration = getActualDuration(shape.props.duration);
  const [durationDraft, setDurationDraft] = useState(formatRequestedSeconds(duration.requestedSeconds));
  const communityWorkflow = isCommunityWorkflow(shape.props.workflowOptionId);
  const communityKeyframeMode = communityWorkflow && shape.props.ultimateKeyframes === true;
  const extensionWorkflow = shape.props.workflowOptionId === "h3-extend";
  const settings = extensionWorkflow ? { ...getH3Settings(shape), aspect: "follow" as const, soundMode: "av" as const, loraStrength: 1, fps: 24 } : getH3Settings(shape);
  const extensionVideoInput = useRef<HTMLInputElement>(null);
  const extensionSourceVideo = shape.props.extensionSourceVideo;
  const aspect: H3Aspect = settings.aspect;
  const busy = busyStatuses.includes(status) || batchProgress !== null;
  const timingVisible=useMediaActive(editor,shape.id);
  const timing = useRunTiming(shape.id, busy && timingVisible);
  const elapsed = timing.generationSeconds ?? 0;
  const abortRef = useRef<AbortController | null>(null);
  const jobIdRef = useRef("");
  const runIdRef = useRef("");
  const formRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const panelResize = useRef<{ pointerId: number; startY: number; startHeight: number; zoom: number } | null>(null);
  const referenceImageInput = useRef<HTMLInputElement>(null);
  const referenceVideoInput = useRef<HTMLInputElement>(null);
  const referenceAudioInput = useRef<HTMLInputElement>(null);
  const replacingReference = useRef<{ kind: "referenceImages" | "referenceVideos" | "referenceAudios"; index: number } | null>(null);
  const update = (props: Partial<H3Node["props"]>) => editor.updateShape({ id: shape.id, type: shape.type, props });

  useEffect(() => subscribeLinkedContent(editor, shape.id, () => setRevision((value) => value + 1)), [editor, shape.id]);
  useEffect(() => { let active = true; const refresh = () => { if (shape.props.shotId) void Promise.all([getShot(shape.props.shotId), getShotCandidates(shape.props.shotId), getShotAssetVersions(shape.props.shotId)]).then(([value, candidates, versions]) => { if (active) { setShot(value); setCandidateCount(candidates.length); setCandidateOptions(candidates); setCandidateVersions(versions); } }).catch(() => { if (active) showCanvasToast("候选结果读取失败"); }); }; refresh(); window.addEventListener("frameflow-shot-changed", refresh); return () => { active = false; window.removeEventListener("frameflow-shot-changed", refresh); }; }, [shape.props.shotId]);
  useEffect(() => { if (!shape.props.shotId) return; let active = true; void getShot(shape.props.shotId).then(async (saved) => { if (!active || !saved?.sourceH3NodeId || saved.sourceH3NodeId === shape.id) return; const fresh = await createShot("", shape.id); if (active && editor.getShape(shape.id)?.type === "h3-node") editor.updateShape({ id: shape.id, type: "h3-node", props: { shotId: fresh.shotId } }); }).catch((cause) => showCanvasToast(cause instanceof Error ? cause.message : "复制镜头记录失败")); return () => { active = false; }; }, [editor, shape.id, shape.props.shotId]);
  const incomingImage = useMemo(() => getIncomingFrameSource(editor, shape.id, "first"), [editor, shape.id, revision]);
  const incomingLastImage = useMemo(() => getIncomingFrameSource(editor, shape.id, "last"), [editor, shape.id, revision]);
  const incomingVideo = useMemo(() => getIncomingSource(editor, shape.id, "video-node") as VideoNode | null, [editor, shape.id, revision]);
  const continuedH3 = useMemo(() => getIncomingSource(editor, shape.id, "h3-node"), [editor, shape.id, revision]);
  const inputFrame = shape.props.videoFirstFrame ? { ...shape.props.videoFirstFrame, width: 0, height: 0 } : incomingImage ? { src: incomingImage.props.src, name: incomingImage.props.name, width: incomingImage.props.naturalWidth ?? 0, height: incomingImage.props.naturalHeight ?? 0 } : shape.props.sourceFrameSrc && (shape.props.inheritedVideo || incomingVideo || continuedH3?.id === shape.props.sourceH3Id) ? { src: shape.props.sourceFrameSrc, name: shape.props.sourceFrameName || "上一段视频尾帧", width: 0, height: 0 } : null;
  const legacyLastFrame = shape.props.videoLastFrame ?? shape.props.inheritedLastFrame ?? (incomingLastImage ? { src: incomingLastImage.props.src, name: incomingLastImage.props.name } : null);
  const frameSrc = timingVisible ? inputFrame?.src ?? "" : "";
  const firstPreview = useImageThumbnail(frameSrc, 512).url;
  const [measuredInput, setMeasuredInput] = useState<{ src: string; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!frameSrc) return;
    let active = true;
    void imagePixelSize(frameSrc).then((size) => { if (active && size.width > 0 && size.height > 0) setMeasuredInput({ src: frameSrc, width: size.width, height: size.height }); }).catch(() => {});
    return () => { active = false; };
  }, [frameSrc]);
  const loadedInputDimensions = measuredInput?.src === frameSrc ? measuredInput : null;
  const referenceImages = shape.props.referenceImages ?? [];
  const referenceVideos = shape.props.referenceVideos ?? [];
  const referenceAudios = shape.props.referenceAudios ?? [];
  const connectedReferenceImages = useMemo(() => getIncomingReferenceImages(editor, shape.id).map((image) => ({ src: image.props.src, name: image.props.name, nodeId: image.id })), [editor, shape.id, revision]);
  const imageOrder = shape.props.referenceImageOrder ?? [];
  const allReferenceImages = [
    ...connectedReferenceImages.map((item) => ({ ...item, orderKey: `node:${item.nodeId}`, localIndex: -1, source: "connected_reference" as const })),
    ...referenceImages.map((item, localIndex) => ({ ...item, nodeId: undefined, orderKey: `file:${JSON.stringify([item.src, item.name])}`, localIndex, source: "reference_image" as const })),
  ].sort((a, b) => {
    const aIndex = imageOrder.indexOf(a.orderKey), bIndex = imageOrder.indexOf(b.orderKey);
    return (aIndex < 0 ? imageOrder.length : aIndex) - (bIndex < 0 ? imageOrder.length : bIndex);
  });
  const referenceDrag = useRef<string | null>(null);
  const reorderReferenceImage = (from: string, to: string) => {
    if (busy || recovery.blocking || from === to) return;
    const order = allReferenceImages.map((item) => item.orderKey);
    const fromIndex = order.indexOf(from), toIndex = order.indexOf(to);
    if (fromIndex < 0 || toIndex < 0) return;
    order.splice(fromIndex, 1); order.splice(toIndex, 0, from);
    editor.markHistoryStoppingPoint("before reordering reference images");
    update({ referenceImageOrder: order });
    editor.markHistoryStoppingPoint("after reordering reference images");
    showCanvasToast("图片顺序已更新；提示词里的 Picture 编号请按新顺序核对");
  };
  const roleIds = shape.props.roleIds ?? [];
  const dialogueLines = shape.props.dialogueLines ?? [];
  const [autoVoiceEnabled] = useAutoRoleVoice();
  const speakerPolicy = resolveH3Speaker({prompt:shape.props.prompt,roleIds,voiceRoleId:shape.props.voiceRoleId,voiceRoleIds:shape.props.voiceRoleIds,dialogue:dialogueLines,autoVoiceDisabled:shape.props.autoVoiceDisabled,autoVoiceEnabled,soundMode:settings.soundMode});
  const voiceRoleId = speakerPolicy.voiceRoleId;
  const voiceRoleIds = speakerPolicy.voiceRoleIds;
  const offscreenRoleIds = shape.props.offscreenRoleIds ?? [];
  const roleSelection = {roleIds,voiceRoleId,...(voiceRoleIds ? {voiceRoleIds} : {}),offscreenRoleIds,dialogue:dialogueLines};
  const promptMode: H3PromptMode = shape.props.promptMode === "official_structured" ? "official_structured" : "plain";
  const [roleOptions, setRoleOptions] = useState<RoleRecord[]>([]);
  const refreshRoles = useCallback(() => { void listRoles().then(setRoleOptions).catch((cause) => showCanvasToast(cause instanceof Error ? cause.message : "角色读取失败")); }, []);
  useEffect(() => { if (selected) refreshRoles(); window.addEventListener("focus", refreshRoles); return () => window.removeEventListener("focus", refreshRoles); }, [refreshRoles, selected, settingsOpen]);
  const isReference = Boolean(voiceRoleId) || Boolean(voiceRoleIds?.length) || dialogueLines.length > 0 || extensionWorkflow || shape.props.allReferenceMode === true || communityWorkflow || allReferenceImages.length + referenceVideos.length + referenceAudios.length + roleIds.length > 0;
  useEffect(() => { if (isReference && !communityKeyframeMode) queueMicrotask(() => setInputView("多参考")); }, [isReference, communityKeyframeMode]);
  useEffect(() => { if (communityWorkflow) queueMicrotask(() => setInputView(communityKeyframeMode ? "顺序图片" : "多参考")); }, [communityWorkflow, communityKeyframeMode]);
  const hybridLock = Boolean(shape.props.hybridLock);
  /** 🧪 AddGuide anchors from 导演台 → 发送到 H3 (experimental, I2VA only), already in frame order. */
  const directorGuides = shape.props.directorContext?.guides ?? [];
  const savedStoryboardGuides = (shape.props.storyboardGuides ?? []).flatMap((g, index) => {
    if (!g.sourceNodeId) return [{ ...g, slot: g.slot ?? index }];
    const linked = editor.getCurrentPageShapes().some((a) => {
      if (a.type !== "arrow" || a.meta.guideSlot !== (g.slot ?? index)) return false;
      const bindings = getArrowBindings(editor, a as TLArrowShape);
      return bindings.end?.toId === shape.id && bindings.start?.toId === g.sourceNodeId;
    });
    const source = editor.getShape(g.sourceNodeId as ImageNode["id"]);
    return linked && source?.type === "image-node" ? [{ ...g, slot: g.slot ?? index, assetId: (source as ImageNode).props.assetId ?? g.assetId, storageReference: (source as ImageNode).props.src, filename: (source as ImageNode).props.name }] : [];
  });
  const legacySlot = [0, 1, 2, 3].find((slot) => slot > Math.max(-1, ...savedStoryboardGuides.map((g) => g.slot ?? 0))) ?? [0, 1, 2, 3].filter((slot) => !savedStoryboardGuides.some((g) => g.slot === slot)).at(-1);
  const storyboardGuides = resolveOrderedStoryboardGuides([...savedStoryboardGuides, ...(incomingLastImage && legacySlot !== undefined ? [{ assetId: incomingLastImage.props.assetId ?? "", storageReference: incomingLastImage.props.src, filename: incomingLastImage.props.name, sourceNodeId: incomingLastImage.id, slot: legacySlot, anchorFrame: duration.length - 1, atEnd: true }] : [])], duration.length);
  // Two pictures retain the existing native first/last workflow. More pictures use AddGuide.
  const sequenceTail = !isReference && !directorGuides.length && storyboardGuides.length === 1 ? storyboardGuides[0] : null;
  const lastFrame = communityKeyframeMode ? legacyLastFrame : communityWorkflow ? null : sequenceTail ? { src: sequenceTail.storageReference, name: sequenceTail.filename } : (isReference ? legacyLastFrame : null);
  const communityPictureGuides = communityWorkflow ? storyboardGuides.filter((guide) => !communityKeyframeMode || guide.sourceNodeId !== incomingLastImage?.id) : [];
  const nodeGuides = communityWorkflow ? [] : [...directorGuides, ...(sequenceTail ? [] : storyboardGuides)].sort((a, b) => a.anchorFrame - b.anchorFrame);
  // 🧪 h3_ultimate_guide: on ultimate / fast, node time anchors and Director Stage guides become AddGuide anchors.
  const nodeTimeAnchors = communityWorkflow && !extensionWorkflow ? shape.props.timeAnchors ?? [] : [];
  const communityTimeAnchors = communityWorkflow && !extensionWorkflow ? [
    ...nodeTimeAnchors.map((anchor) => ({ ...anchor, source: "node" as const })),
    ...directorGuides.map((guide) => ({ storageReference: guide.storageReference, filename: guide.filename, atSeconds: guide.anchorFrame / H3_FPS, asReference: false, assetId: guide.assetId, source: "director" as const })),
  ] : [];
  const anchorReferenceGuides = nodeTimeAnchors.filter((anchor) => anchor.asReference).map((anchor) => ({ storageReference: anchor.storageReference, filename: anchor.filename }));
  useEffect(() => {
    if (!communityWorkflow || extensionWorkflow || !directorGuides.length) return;
    try {
      if (localStorage.getItem("ff-director-anchor-notice-v1")) return;
      localStorage.setItem("ff-director-anchor-notice-v1", new Date().toISOString());
    } catch { return; }
    showCanvasToast(`🧪 导演台锚点在终极版 / 极速版下会作为时间锚点真正生效（未试渲）。${H3_TIME_ANCHOR_NOTE}`);
  }, [communityWorkflow, extensionWorkflow, directorGuides.length]);
  const taskResolution = communityKeyframeMode ? { mode: "ref2va" as const, problem: null } : resolveH3TaskMode({ hasFirstFrame: Boolean(inputFrame), hasLastFrame: Boolean(lastFrame), hasReferences: isReference, hybridLock: communityWorkflow ? false : hybridLock });
  // Keep old tail images and their arrows, but move the input into the unified picture strip.
  useEffect(() => {
    if (!incomingLastImage || legacySlot === undefined || busy || isReference || !shape.props.workflowOptionId || shape.props.workflowOptionId === 'stable') return;
    editor.run(() => {
      const next = [...savedStoryboardGuides, { assetId: incomingLastImage.props.assetId ?? "", storageReference: incomingLastImage.props.src, filename: incomingLastImage.props.name, sourceNodeId: incomingLastImage.id, slot: legacySlot, anchorFrame: duration.length - 1, atEnd: true }];
      for (const a of editor.getCurrentPageShapes()) {
        if (a.type !== "arrow") continue;
        const bindings = getArrowBindings(editor, a as TLArrowShape);
        if (bindings.end?.toId === shape.id && bindings.start?.toId === incomingLastImage.id && arrowFrameRole(a, bindings.end.props.normalizedAnchor.y) === "last") editor.updateShape({ id: a.id, type: "arrow", meta: { ...a.meta, frameRole: "guide", guideSlot: legacySlot } });
      }
      // Updating references must never resize an existing card, including legacy cards.
      editor.updateShape({ id: shape.id, type: "h3-node", props: { storyboardGuides: next } });
    }, { history: "ignore" });
  }, [editor, incomingLastImage, legacySlot, busy, isReference, shape.id, shape.props.w, shape.props.workflowOptionId, duration.length, savedStoryboardGuides]);
  // No mount-time width migration: saved widths belong to the user's canvas layout.
  // Bind to the actual picture card, independent of its height, zoom or page position.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const current = editor.getShape(shape.id) as H3Node | undefined;
      if (!current) return;
      editor.run(() => {
        for (const arrow of editor.getCurrentPageShapes()) {
          if (arrow.type !== "arrow") continue;
          const end = getArrowBindings(editor, arrow as TLArrowShape).end;
          if (end?.toId !== shape.id) continue;
          const role = arrowFrameRole(arrow, end.props.normalizedAnchor.y);
          if (role === "reference") continue;
          // Preserve the semantic input role independently of temporary UI expansion.
          if (arrow.meta.capturedVideoFrame) continue;
          const anchor = { x: 0, y: role === "guide" ? 0.4 + Number(arrow.meta.guideSlot ?? 0) * 0.12 : H3_INPUT_ANCHORS[role as H3FrameRole] };
          if (Math.abs(end.props.normalizedAnchor.x - anchor.x) + Math.abs(end.props.normalizedAnchor.y - anchor.y) < 0.0001 && end.props.isExact) continue;
          editor.updateShape({ id: arrow.id, type: "arrow", meta: { ...arrow.meta, frameRole: role } });
          editor.updateBinding({ id: end.id, type: "arrow", props: { normalizedAnchor: anchor, isExact: true, isPrecise: true, snap: "none" } });
        }
      }, { history: "ignore" });
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, shape.id, shape.props.h, shape.props.w, shape.props.collapsed, revision]);
  const taskMode = taskResolution.mode;
  const resultNode = shape.props.shotId ? findShotDisplay(editor, shape.props.shotId, shape.id) : undefined;
  const [inheritedAsset, setInheritedAsset] = useState<AssetRecord | null>(null);
  const [showInheritedInfo, setShowInheritedInfo] = useState(false);
  const [showSubmissionInfo, setShowSubmissionInfo] = useState(false);
  useEffect(() => { let active = true; const id = shape.props.inheritedVideo?.assetId; if (id) void getAsset(id).then(asset => { if (active) setInheritedAsset(asset); }); return () => { active = false; }; }, [shape.props.inheritedVideo?.assetId]);
  const previewAsset = resolveCandidatePreview(inheritedAsset ? [...candidateVersions, inheritedAsset] : candidateVersions, [shape.props.previewAssetId, previewCandidateId, shot?.adoptedAssetId, resultNode?.props.assetId, shape.props.inheritedVideo?.assetId]);
  const resultSource = previewAsset?.storageReference ?? resultNode?.props.src ?? shape.props.inheritedVideo?.src ?? "";
  const displayedAssetId = previewAsset?.assetId ?? resultNode?.props.assetId ?? shape.props.inheritedVideo?.assetId ?? "";
  const resultAsset = previewAsset ?? candidateVersions.find((asset) => asset.assetId === displayedAssetId);
  const measuredVideo = videoDimensions?.source === resultSource ? videoDimensions : null;
  const fallbackDimensions = calculateH3Dimensions(inputFrame?.width || loadedInputDimensions?.width || 0, inputFrame?.height || loadedInputDimensions?.height || 0, aspect, settings.megapixels, settings.resolutionSteps);
  const inputWidth = inputFrame?.width || loadedInputDimensions?.width || 0;
  const inputHeight = inputFrame?.height || loadedInputDimensions?.height || 0;
  const previewSize = h3PreviewSize(measuredVideo?.width || resultAsset?.width || shape.props.inheritedVideo?.width || (!resultSource && inputWidth) || fallbackDimensions?.width || 16, measuredVideo?.height || resultAsset?.height || shape.props.inheritedVideo?.height || (!resultSource && inputHeight) || fallbackDimensions?.height || 9, shape.props.w);
  const hasResult = useMemo(() => Boolean(shape.props.inheritedVideo) || candidateCount > 0 || getOutgoingTargets(editor, shape.id, "video-node").length > 0, [editor, shape.id, revision, candidateCount, shape.props.inheritedVideo]);

  useEffect(() => {
    const current = editor.getShape(shape.id) as H3Node | undefined;
    if (!current || current.type !== "h3-node") return;
    if (Math.abs((current.props.previewWidth ?? 0) - previewSize.w) < 0.01 && Math.abs((current.props.previewHeight ?? 0) - previewSize.h) < 0.01) return;
    editor.run(() => editor.updateShape({ id: current.id, type: "h3-node", props: { previewWidth: previewSize.w, previewHeight: previewSize.h } }), { history: "ignore" });
  }, [editor, shape.id, previewSize.w, previewSize.h]);

  useEffect(() => { queueMicrotask(() => setDurationDraft(formatRequestedSeconds(duration.requestedSeconds))); }, [shape.props.duration, duration.requestedSeconds]);
  useEffect(() => { let active = true; void comfyUIH3Adapter.isAvailable().then((available) => { if (active) { const next = available ? "connected" : "disconnected"; setStatus(next); setProgress({ status: next, stage: available ? "ComfyUI 已连接" : "ComfyUI 未连接" }); } }); return () => { active = false; }; }, []);
  useEffect(() => {
    const textarea = promptRef.current;
    const form = formRef.current;
    if (!textarea || !form) return;
    let frame = 0;
    const fit = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!textarea.offsetHeight) return; // Far LOD must not overwrite saved sizes.
        const current = editor.getShape(shape.id);
        if (current?.type !== "h3-node") return;
        const promptHeight = textarea.offsetHeight;
        const props: Partial<H3Node["props"]> = {};
        if (Math.abs((current.props.promptHeight ?? H3_PROMPT_HEIGHT) - promptHeight) > 1) props.promptHeight = promptHeight;
        const height = 32 + previewSize.h + form.scrollHeight + 10;
        Object.assign(props, h3AutoHeightPatch(current.meta, current.props.h, height));
        if (Object.keys(props).length) editor.run(() => editor.updateShape({ id: current.id, type: "h3-node", props }), { history: "ignore" });
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(textarea);
    observer.observe(form);
    fit();
    return () => { observer.disconnect(); if (frame) window.cancelAnimationFrame(frame); };
  }, [editor, shape.id, shape.props.collapsed, selected, picturesExpanded, previewSize.h]);
  useEffect(() => {
    const element = formRef.current;
    if (!element) return;
    const stopCanvasWheel = (event: WheelEvent) => event.stopPropagation();
    element.addEventListener("wheel", stopCanvasWheel, { passive: true });
    return () => element.removeEventListener("wheel", stopCanvasWheel);
  }, [shape.props.collapsed, selected]);

  /** Live generation and recovery display the saved candidate in the original creative node. */
  const presentH3Output = async (outputAsset: AssetRecord, shotId: string) => {
    const updatedShot = await markShotHasCandidates(shotId);
    const displayAsset = updatedShot.adoptedAssetId ? await getAsset(updatedShot.adoptedAssetId) : outputAsset;
    if (!displayAsset) throw new Error("已采用的视频记录无法读取");
    announceShotChange(shotId);
    // Existing output cards can have downstream connections; retain and update them,
    // but never create a duplicate output card automatically.
    const existingVideo = findShotDisplay(editor, shotId, shape.id);
    if (existingVideo && !updatedShot.adoptedAssetId) displayVideoAsset(editor, existingVideo, outputAsset);
    setShot(updatedShot);
    const candidates = await getShotCandidates(shotId);
    setCandidateOptions(candidates);
    setCandidateVersions(await getShotAssetVersions(shotId));
    setCandidateCount(candidates.length);
    setPreviewCandidateId(displayAsset.assetId);
    update({ previewAssetId: displayAsset.assetId });
    return updatedShot;
  };
  const recovery = useRunRecovery(shape.id, () => Boolean(runIdRef.current || abortRef.current), async (run, asset) => { if (run.shotId) { await presentH3Output(asset, run.shotId); showCanvasToast("H3 任务已完成，结果已恢复到画布"); } });
  useEffect(() => {
    if (runIdRef.current || abortRef.current || !recovery.view) return;
    const { phase, stage } = recovery.view;
    if (stoppedRef.current && (phase === "queued" || phase === "running" || phase === "submitting")) return;
    if (phase === "queued" || phase === "running" || phase === "completed" || phase === "failed" || phase === "cancelled") {
      queueMicrotask(()=>{setStatus(phase);
      setProgress({ status: phase, stage, ...(phase === "completed" ? { percent: 100 } : {}) });
      if (phase === "failed") setError(stage);});
    }
  }, [recovery.view]);
  useEffect(() => {
    if (busy || recovery.blocking) return;
    const current = editor.getShape(shape.id) as H3Node | undefined;
    if (!current) return;
    if (current.props.workflowLock === SHOT_QUEUE_LOCK || current.props.workflowLock === SHOT_QUEUE_LEGACY_LOCK) {
      if (current.props.workflowLock === SHOT_QUEUE_LOCK && current.props.workflowOptionId === SHOT_QUEUE_WORKFLOW && current.props.allReferenceMode === true && current.props.promptMode !== "official_structured" && !current.props.ultimateKeyframes && !current.props.hybridLock) return;
      editor.run(() => editor.updateShape({ id: shape.id, type: "h3-node", props: { workflowOptionId: SHOT_QUEUE_WORKFLOW, allReferenceMode: true, promptMode: "plain", ultimateKeyframes: false, hybridLock: false, workflowLock: SHOT_QUEUE_LOCK } }), { history: "ignore" });
      return;
    }
    if (current.props.workflowOptionId && current.props.workflowOptionId !== 'stable') return;
    editor.run(() => editor.updateShape({id:shape.id,type:'h3-node',props:{workflowOptionId:'community-ultimate',ultimateKeyframes: current.props.ultimateKeyframes ?? Boolean(incomingLastImage || (incomingImage && !current.props.allReferenceMode))}}),{history:'ignore'});
  }, [editor, shape.id, shape.props.workflowOptionId, shape.props.workflowLock, shape.props.allReferenceMode, shape.props.promptMode, shape.props.ultimateKeyframes, shape.props.hybridLock, incomingImage, incomingLastImage, busy, recovery.blocking]);
  useGeneratingSignal(shape.id, busy, recovery.view?.phase);
  const commitDuration = () => { const seconds = normalizeRequestedSeconds(durationDraft); update({ duration: String(seconds) }); setDurationDraft(formatRequestedSeconds(seconds)); };
  const addReference = async (kind: "referenceImages" | "referenceVideos" | "referenceAudios", file: File) => {
    const current = shape.props[kind] ?? [];
    const limit = kind === "referenceImages" ? Math.max(0, 9 - (inputFrame && !communityKeyframeMode ? 1 : 0) - connectedReferenceImages.length - (communityWorkflow ? communityPictureGuides.length + anchorReferenceGuides.length : 0)) : 3;
    const replacement = replacingReference.current;
    replacingReference.current = null;
    if (replacement === null && current.length >= limit) throw new Error(`此类参考素材最多 ${limit} 个`);
    const src = kind === "referenceImages" ? await storeLocalImage(file, file.name) : await storeLocalVideo(file, file.name);
    await importedAsset(src, kind === "referenceImages" ? "image" : kind === "referenceAudios" ? "audio" : "video", file);
    const next = [...current];
    if (replacement?.kind === kind) next[replacement.index] = { src, name: file.name };
    else next.push({ src, name: file.name });
    update({ [kind]: next });
  };
  const confirmReferenceRemoval = async () => !referencedLabels(shape.props.prompt).length || await askConfirm("提示词含素材引用。移除后编号可能变化，提示词不会自动改写。确认移除并自行核对引用吗？原素材文件会保留。");
  const removeReference = async (kind: "referenceImages" | "referenceVideos" | "referenceAudios", index: number) => { if (!await confirmReferenceRemoval()) return; const current = editor.getShape(shape.id) as typeof shape | undefined; if (current) update({ [kind]: (current.props[kind] ?? []).filter((_, at) => at !== index) }); };
  const replaceReference = (kind: "referenceImages" | "referenceVideos" | "referenceAudios", index: number) => { replacingReference.current = { kind, index };setCanvasReferencePicker(kind); };
  const returnFromCanvasPicker=()=>{
    replacingReference.current=null;setCanvasReferencePicker(null);setFramePicker(null);
    if(editor.getShape(shape.id)){editor.select(shape.id);setDockOpen(true);}
  };
  const chooseCanvasMedia=async(id:TLShape["id"],role:"first"|"last"|"referenceImages"|"referenceVideos"|"referenceAudios")=>{
    if(busy||recovery.blocking)throw Error("任务执行中，不能更换输入素材");
    const target=editor.getShape(shape.id);
    const source=editor.getShape(id);if(target?.type!=="h3-node"||!source)throw Error("素材或目标节点已不存在");
    const image=referenceImageOf(source);
    editor.markHistoryStoppingPoint("before choosing canvas reference");
    if(role==="first"||role==="last"){
      if(!image)throw Error("请选择画布里的图片");
      createBoundArrow(editor,image,target as H3Node,role);
    }else{
      const kind=role==="referenceImages"?"image":role==="referenceAudios"?"audio":"video";
      const item=canvasMedia.find(candidate=>candidate.id===id&&candidate.kind===kind);
      if(!item)throw Error("素材类型不匹配");
      const current=shape.props[role]??[];
      const replacement=replacingReference.current?.kind===role?replacingReference.current:null;
      if(role==="referenceImages"&&!replacement){
        if(allReferenceImages.some(reference=>reference.src===item.src))throw Error("这张图片已经是参考图");
        if(liveCounts.pictures>=9)throw Error("图片参考已达到9张上限（含角色和首尾帧）");
        if(!image)throw Error("图片无法读取");createBoundArrow(editor,image,target as H3Node,"reference");
      }else{
        if(!replacement&&current.some(reference=>reference.src===item.src))throw Error("素材已经加入");
        if(!replacement&&current.length>=3)throw Error("最多添加3条视频或声音参考");
        const next=[...current];const value={src:item.src,name:item.name};
        if(replacement)next[replacement.index]=value;else next.push(value);
        update({[role]:next});
      }
    }
    returnFromCanvasPicker();
    editor.markHistoryStoppingPoint("after choosing canvas reference");
    showCanvasToast("已引用画布素材，原素材和位置保留");
  };
  const removeConnectedReference = async (sourceId: string) => {
    if (!await confirmReferenceRemoval()) return false;
    const arrow = editor.getCurrentPageShapes().find((candidate) => { if (candidate.type !== "arrow") return false; const bindings = getArrowBindings(editor, candidate as TLArrowShape); return bindings.start?.toId === sourceId && bindings.end?.toId === shape.id && Math.abs(bindings.end.props.normalizedAnchor.y - H3_INPUT_ANCHORS.reference) < 0.035; });
    if (arrow) editor.deleteShape(arrow.id);
    return true;
  };
  const chooseFrameAsset = async (asset: AssetRecord, role: "first" | "last") => {
    const current = editor.getShape(shape.id);
    if (current?.type !== "h3-node") throw new Error("H3 节点已不存在");
    editor.markHistoryStoppingPoint("before choosing frame asset");
    const image = await createImageNodeForAsset(editor, asset, { x: current.x - 120, y: current.y + 95 });
    placeSelectedFrameImage(editor, image, current as H3Node, role);
    createBoundArrow(editor, image, current as H3Node, role);
    editor.markHistoryStoppingPoint("after choosing frame asset");
  };
  const uploadFrame = async (file: File, role: "first" | "last") => {
    const current = editor.getShape(shape.id);
    if (current?.type !== "h3-node") throw new Error("H3 节点已不存在");
    editor.markHistoryStoppingPoint("before uploading frame asset");
    const image = await addImageFile(editor, file, { x: current.x - 120, y: current.y + 95 });
    if (!image) throw new Error("图片节点创建失败");
    placeSelectedFrameImage(editor, image, current as H3Node, role);
    createBoundArrow(editor, image, current as H3Node, role);
    editor.markHistoryStoppingPoint("after uploading frame asset");
  };
  // eslint-disable-next-line react-hooks/purity -- Date.now() runs in the cancel click handler, never during render
  const cancel = async () => {
    stoppedRef.current = true; batchStopRef.current = true;
    const jobId = jobIdRef.current;
    try { if (jobId) await comfyUIH3Adapter.cancel(jobId); }
    catch (cause) { stoppedRef.current = false; batchStopRef.current = false; showCanvasToast(cause instanceof Error ? cause.message : "取消任务失败"); return false; }
    abortRef.current?.abort();
    const runId = runIdRef.current;
    if (runId) { try { await updateRun(runId, { status: "cancelled", completedAt: Date.now(), error: "用户取消" }); } catch (cause) { showCanvasToast(cause instanceof Error ? cause.message : "取消记录保存失败"); } }
    releaseNodeClaim(shape.id); setNodeGenerating(shape.id, false);
    setStatus("cancelled"); setProgress({ status: "cancelled", stage: "任务已取消" }); setError("");
    return true;
  };
  useEffect(()=>registerNodeTaskCancel(shape.id,async()=>busy?await cancel():true));
  const deleteNode = () => deleteNodeWithHistory(editor, shape.id);

  /** Errors block (shown on the node, nothing submitted); warnings are shown and the run continues. */
  const reportPreflight = (result: H3PreflightResult) => {
    if (!result.ok) { setStatus("failed"); setProgress({ status: "failed", stage: "生成前检查未通过" }); setError(formatPreflight({ ...result, warnings: [] })); showCanvasToast(`生成前检查未通过：${result.errors[0].message}`); return false; }
    if (result.warnings.length) showCanvasToast(`生成前检查：${result.warnings.length} 条提醒（已继续生成）`);
    return true;
  };
  const referenceLayout = (firstSource = inputFrame?.src) => h3ReferenceLayout({
    first: inputFrame && firstSource ? { src: firstSource, name: inputFrame.name } : null, last: lastFrame,
    capturedFirst: Boolean(shape.props.videoFirstFrame), capturedLast: Boolean(shape.props.videoLastFrame),
    extension: extensionWorkflow, keyframes: communityKeyframeMode, references: allReferenceImages, guides: [...communityPictureGuides, ...anchorReferenceGuides],
  });
  const submissionReviewSpec = (): H3ReviewSpec => ({
    prompt: shape.props.prompt, promptMode, settings, workflowOptionId: shape.props.workflowOptionId,
    referenceMode: isReference, community: communityWorkflow, mode: extensionWorkflow ? "ref2va" : taskMode,
    ...(communityKeyframeMode ? { keyframes: { first: inputFrame?.src, last: lastFrame?.src } } : {}),
    layout: referenceLayout(), videos: referenceVideos, audios: referenceAudios, roleIds, voiceRoleId, ...(voiceRoleIds ? { voiceRoleIds } : {}), autoVoiceDisabled: speakerPolicy.disabled, autoVoiceEnabled, offscreenRoleIds, roleSnapshot: shape.props.roleSnapshot, dialogue: dialogueLines,
    primary: inputFrame, last: lastFrame, ...(extensionWorkflow && extensionSourceVideo ? { extension: extensionSourceVideo } : {}),
    guides: nodeGuides, timeAnchors: communityTimeAnchors, ...(shape.props.seedMode === "固定" ? { seed: Number(shape.props.seed) } : {}),
    problems: [
      workflowBlockedReason(shape.props.workflowOptionId),
      !taskMode && !extensionWorkflow ? taskResolution.problem : null,
      extensionWorkflow && !extensionSourceVideo ? "缺少延长原视频" : null,
      extensionWorkflow && (legacyLastFrame || nodeGuides.length || hybridLock) ? "视频延长暂不支持尾帧锁定、时间锚点或 Hybrid" : null,
      communityKeyframeMode && !inputFrame && !lastFrame ? "请至少选择首帧或尾帧" : null,
      communityWorkflow ? communityInputProblem({ keyframeCount: communityKeyframeMode ? (inputFrame ? 1 : 0) + (lastFrame ? 1 : 0) : 0, pictures: (inputFrame && !extensionWorkflow ? 1 : 0) + (communityKeyframeMode && lastFrame ? 1 : 0) + allReferenceImages.length + communityPictureGuides.length + anchorReferenceGuides.length + roleIds.filter(id => !offscreenRoleIds.includes(id)).length, videos: referenceVideos.length, audios: referenceAudios.length, guides: communityWorkflow ? communityTimeAnchors.length : directorGuides.length }) : null,
      incomingLastImage && legacySlot === undefined ? "当前图片超过 5 张，请断开多余的旧尾帧连接" : storyboardGuideProblem(nodeGuides, duration.length, taskMode),
      !extensionWorkflow && shape.props.allReferenceMode && !inputFrame && !allReferenceImages.length && !referenceVideos.length && !referenceAudios.length && !roleIds.length && !communityPictureGuides.length ? "全能参考尚未添加任何素材" : null,
    ].filter((item): item is string => Boolean(item)),
  });
  const generate = async (enqueueOnly = false, submissionControl:'submit'|'automatic'|'chain'='submit',submissionSessionId?:string,parentSignal?:AbortSignal) => {
    if (busy || recovery.blocking || isNodeClaimed(shape.id)) return;
    if(tailHDBlocked(editor.getShape(shape.id)?.meta)){const message='尾帧高清尚未完成，请等待、查询原任务，或选择使用原尾帧';setError(message);showCanvasToast(message);if(enqueueOnly)throw new SubmissionNotSentError(message);return;}
    // Queue automation must wait for extracted source frames. Manual「生成视频」is user authority and proceeds with whatever frames/refs are on the node now.
    const frameWaiting = queueFrameNodeWaiting(editor.getShape(shape.id)?.meta, shape.meta.shotQueueFrameToken);
    if (frameWaiting && enqueueOnly) { setError(frameWaiting); showCanvasToast(frameWaiting); throw new SubmissionNotSentError(frameWaiting); }
    if (frameWaiting && !enqueueOnly) {
      const current = editor.getShape(shape.id);
      if (current) editor.updateShape({ id: shape.id, type: current.type, meta: { ...current.meta, shotQueueFrameWaiting: false } });
    }
    if (speakerPolicy.errors.length) { const message=speakerPolicy.errors.join('；'); setError(message); showCanvasToast(message); return; }
    const workflowProblem = workflowBlockedReason(shape.props.workflowOptionId);
    if (workflowProblem) { setError(workflowProblem); showCanvasToast(workflowProblem); return; }
    if (!extensionWorkflow && shape.props.allReferenceMode && !inputFrame && !allReferenceImages.length && !referenceVideos.length && !referenceAudios.length && !roleIds.length && !communityPictureGuides.length) { const message = "全能参考无需首帧，请先添加现场图、人物图、参考视频或声音。"; setError(message); showCanvasToast(message); return; }
    if (communityWorkflow) {
      if (communityKeyframeMode && !inputFrame && !lastFrame) { setError("请至少选择首帧或尾帧"); return; }
      const problem = communityInputProblem({ keyframeCount: communityKeyframeMode ? (inputFrame ? 1 : 0) + (lastFrame ? 1 : 0) : 0, pictures: (inputFrame && !extensionWorkflow ? 1 : 0) + (communityKeyframeMode && lastFrame ? 1 : 0) + allReferenceImages.length + communityPictureGuides.length + anchorReferenceGuides.length + roleIds.filter(id => !offscreenRoleIds.includes(id)).length, videos: referenceVideos.length, audios: referenceAudios.length, guides: communityWorkflow ? communityTimeAnchors.length : directorGuides.length });
      if (problem) { setError(problem); showCanvasToast(problem); return; }
    }
    const guideProblem = incomingLastImage && legacySlot === undefined ? "当前图片超过 5 张，请断开多余的旧尾帧连接。" : storyboardGuideProblem(nodeGuides, duration.length, taskMode);
    if (guideProblem) { setError(guideProblem); showCanvasToast(guideProblem); return; }
    setError(""); setProgress({ status: "preparing", stage: "准备任务" });
    const prompt = shape.props.prompt.trim();
    if (!prompt) { setStatus("failed"); setError("请先填写 Prompt"); return; }
    const mode = extensionWorkflow ? "ref2va" : taskMode;
    // 🧪 Hybrid (and any unresolvable connection) stops here: nothing is read, uploaded, recorded or queued.
    try { assertH3ModeSubmittable(mode); } catch (cause) { setStatus("failed"); setError(!mode ? taskResolution.problem ?? "无法判断生成模式" : cause instanceof Error ? cause.message : "当前模式不能生成"); return; }
    if (mode === "ref2va" && settings.aspect === "follow" && !communityWorkflow && !extensionWorkflow) { setStatus("failed"); setError("多参考模式请先选择明确的画面比例"); return; }
    if (mode !== "ref2va" && !reportPreflight(runH3Preflight({ mode, prompt: compileH3Prompt(prompt, settings.soundMode, settings.noBackgroundMusic), rawPrompt: prompt, counts: frameModeCounts(mode), length: settings.length, megapixels: settings.megapixels, dimensions: mode === "t2va" ? t2vaDimensions(settings) : actualDimensions }))) return;
    let seed: number;
    // Values are generated only inside the user's click handler, never during render.
    // eslint-disable-next-line react-hooks/purity -- Math.random() runs in the generate click handler, never during render
    if (shape.props.seedMode === "固定") { seed = Number(shape.props.seed); if (!Number.isSafeInteger(seed) || seed < 0) { setStatus("failed"); setError("固定 Seed 必须是 0 到 9,007,199,254,740,991 的整数"); return; } } else seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    let seeds: number[];
    try { seeds = generationSeeds(shape.props.generationCount ?? 1, shape.props.seedMode === "固定" ? seed : undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "生成次数无效"); return; }
    seed = seeds[0];
    const batchId = crypto.randomUUID();
    // Synchronous claim: a second click in the same tick cannot pass this point.
    const release = claimNode(shape.id);
    if (!release) return;
    stoppedRef.current = false;
    setBatchProgress({ index: 1, count: seeds.length });
    batchStopRef.current = false;
    let uncertain = false;
    // eslint-disable-next-line react-hooks/purity -- Date.now() runs in the generate click handler, never during render
    const controller = new AbortController(); abortRef.current = controller; jobIdRef.current = ""; runIdRef.current = ""; setStatus("preparing");
    const relay=()=>controller.abort(parentSignal?.reason);if(parentSignal?.aborted)relay();else parentSignal?.addEventListener('abort',relay,{once:true});
    try {
      controller.signal.throwIfAborted();let activeShot: ShotRecord;
      let run: RunRecord;
      let generationInput: Parameters<typeof comfyUIH3Adapter.generate>[0];
      if (!isReference) {
        if (nodeGuides.length && mode !== "i2va") throw new Error("🧪 引导锚点只支持首帧图生视频（I2VA）：请保留首帧、去掉尾帧和参考素材，或移除引导锚点");
        const primary = inputFrame ?? { src: allReferenceImages[0]?.src ?? "", name: allReferenceImages[0]?.name ?? "" };
        const image = primary.src ? await getLocalImageBlob(primary.src) : undefined;
        controller.signal.throwIfAborted();
        let lastImage: Blob | undefined;
        if (lastFrame) {
          lastImage = await getLocalImageBlob(lastFrame.src).catch(() => { throw new Error("无法读取尾帧图片"); });
          controller.signal.throwIfAborted();
        }
        const asReferenceFiles = async (items: { src: string; name: string; withAudio?: boolean }[], kind: "image" | "video") => Promise.all(items.map(async (item) => ({ blob: kind === "image" ? await getLocalImageBlob(item.src) : await getLocalVideoBlob(item.src), name: item.name, withAudio: item.withAudio })));
        const submittedImages = inputFrame ? allReferenceImages : allReferenceImages.slice(1);
        const [referenceImageFiles, referenceVideoFiles, referenceAudioFiles] = await Promise.all([asReferenceFiles(submittedImages, "image"), asReferenceFiles(referenceVideos, "video"), asReferenceFiles(referenceAudios, "video")]);
        const primaryAssetSource = primary.src.startsWith("data:") && image ? await storeLocalImage(image, primary.name,controller.signal) : primary.src;
        const lastAssetSource = lastFrame?.src.startsWith("data:") && lastImage ? await storeLocalImage(lastImage, lastFrame.name,controller.signal) : lastFrame?.src;
        if (primaryAssetSource !== primary.src && shape.props.sourceFrameSrc === primary.src) update({ sourceFrameSrc: primaryAssetSource });
        const inputs = [
          ...(primary.src ? [{ src: primaryAssetSource, name: primary.name, kind: "image" as const, role: "first_frame" }] : []),
          ...(lastFrame && lastAssetSource ? [{ src: lastAssetSource, name: lastFrame.name, kind: "image" as const, role: "last_frame" }] : []),
          ...submittedImages.map((item) => ({ ...item, kind: "image" as const, role: "reference_image" })),
          ...referenceVideos.map((item) => ({ ...item, kind: "video" as const, role: "reference_video" })),
          ...referenceAudios.map((item) => ({ ...item, kind: "audio" as const, role: "reference_audio" })),
          ...nodeGuides.map((guide) => ({ src: guide.storageReference, name: guide.filename, kind: "image" as const, role: `guide_frame_${guide.anchorFrame}` })),
        ];
        const inputAssets = await Promise.all(inputs.map((item) => assetForSource(item.src, item.kind, item.name,{},controller.signal)));
        const finalPrompt = compileH3Prompt(prompt, settings.soundMode, settings.noBackgroundMusic);
        const actualImageSize = image ? await imageProof(image,controller.signal) : null;
        const snapshot = await snapshotH3({ referenceMode: isReference, prompt: finalPrompt, seed, settings, sourceWidth: actualImageSize?.width ?? 0, sourceHeight: actualImageSize?.height ?? 0, hasLastFrame: Boolean(lastFrame), referenceCounts: { images: (primary.src ? 1 : 0) + submittedImages.length, videos: referenceVideos.length, audios: referenceAudios.length, videoAudioFlags: referenceVideos.map((item) => Boolean(item.withAudio)) }, ...(mode === "t2va" ? { taskMode: "t2va" as const } : {}), ...(nodeGuides.length ? { guides: nodeGuides.map((guide) => ({ frameIdx: guide.anchorFrame })) } : {}) });
        const engine = await comfyUIH3Adapter.describeEngine(h3ClassTypesFor(nodeGuides.length ? "i2va_guide" : mode));
        const zhengbenVersion = shape.props.zhengbenVersion || await fetchZhengbenVersion();
        snapshot.parameters.generationBatch = { id: batchId, index: 1, count: seeds.length };
        snapshot.parameters.noBackgroundMusic = settings.noBackgroundMusic ?? false;
        snapshot.parameters.autoRemoveMusic = shape.props.autoRemoveMusic ?? true; { const gateOverride = await gateOverrideFor(shape.props.shotTitle, shape.props.prompt); if (gateOverride) snapshot.parameters.gateOverride = gateOverride; }
        snapshot.parameters.autoVoiceDisabled = speakerPolicy.disabled;
        controller.signal.throwIfAborted();activeShot = await ensureH3Shot(editor, shape,controller.signal);controller.signal.throwIfAborted();
        run = await createRunExclusively(shape.id, listRuns, attemptSignal => createRun({ ...snapshot, taskMode: mode, engine, zhengbenVersion, ownerNodeId: shape.id, shotId: activeShot.shotId, inputAssetIds: inputAssets.map((asset) => asset.assetId), rawPrompt: prompt, finalPrompt, seed, referenceInputs: inputs.map((item, index) => ({ assetId: inputAssets[index].assetId, kind: item.kind, role: item.role, order: index, ...("withAudio" in item ? { withAudio: item.withAudio } : {}) })), ...(shape.props.directorContext ? { directorContext: runDirectorContext(shape.props.directorContext, inputAssets.map((asset) => asset.assetId)) } : {}) }, { reservePromptId: true,signal:attemptSignal??controller.signal }),controller.signal);
        runIdRef.current = run.runId;controller.signal.throwIfAborted();await addRunToShot(activeShot.shotId, run.runId);controller.signal.throwIfAborted();
        runIdRef.current = run.runId;
        update({ lastSubmittedPrompt: finalPrompt, lastSubmittedSeed: seed });
        generationInput = { taskMode: mode, image, imageName: primary.name, lastImage, lastImageName: lastFrame?.name, prompt, seed, settings, referenceMode: isReference, referenceImages: referenceImageFiles, referenceVideos: referenceVideoFiles, referenceAudios: referenceAudioFiles, ...(nodeGuides.length ? { guideImages: await Promise.all(nodeGuides.map(async (guide) => ({ blob: await getLocalImageBlob(guide.storageReference), name: guide.filename, frameIdx: guide.anchorFrame }))) } : {}) };
      } else {
        // Ref2VA: the frozen Reference Manifest is the only ordering source for the payload.
        const firstSource = inputFrame && inputFrame.src.startsWith("data:") ? await storeLocalImage(await getLocalImageBlob(inputFrame.src), inputFrame.name,controller.signal) : inputFrame?.src;
        if (inputFrame && firstSource && firstSource !== inputFrame.src && shape.props.sourceFrameSrc === inputFrame.src) update({ sourceFrameSrc: firstSource });
        const explicitRef = async (item: { src: string; name: string; withAudio?: boolean }, kind: "image" | "video" | "audio") => { const asset = await assetForSource(item.src, kind, item.name,{},controller.signal); return { assetId: asset.assetId, storageReference: item.src, filename: item.name, withAudio: item.withAudio }; };
        const layout = referenceLayout(firstSource);
        const [images, trailingImages, videos, audios, roleData] = await Promise.all([
          Promise.all(layout.images.map(async item => ({ ...await explicitRef(item, "image"), source: item.source }))),
          Promise.all(layout.trailingImages.map(async item => ({ ...await explicitRef(item, "image"), source: item.source }))),
          Promise.all(referenceVideos.map(item => explicitRef(item, "video"))),
          Promise.all(referenceAudios.map(item => explicitRef(item, "audio"))), readH3Roles(roleSelection, shape.props.roleSnapshot, getRole, getAsset),
        ]);
        const { manifest, compiled, payload, communityKeyframes } = prepareH3ReferenceSubmission(
          { images, trailingImages, videos, audios, ...roleData, dialogue: dialogueLines, voiceRoleId, voiceRoleIds, offscreenRoleIds, soundMode: settings.soundMode ?? "av", includeRoleVoices: !speakerPolicy.disabled, allowEmptyForTextGeneration: communityWorkflow && !communityKeyframeMode },
          { prompt, promptMode, noBackgroundMusic: settings.noBackgroundMusic, community: communityWorkflow, ...(communityKeyframeMode ? { keyframes: { first: firstSource, last: lastFrame?.src } } : {}) },
        );
        if (communityWorkflow) {
          const problem = communityInputProblem({ keyframeCount: communityKeyframeMode ? (inputFrame ? 1 : 0) + (lastFrame ? 1 : 0) : 0, pictures: payload.images.length, videos: payload.videos.length, audios: payload.audios.length, guides: communityTimeAnchors.length });
          if (problem) throw new Error(problem);
        }
        // 🧪 h3_ultimate_guide: frames, spacing and unbound <Picture N> tags are checked before any Run exists.
        const anchorCheck = communityTimeAnchors.length ? checkTimeAnchors(communityTimeAnchors.map((anchor, i) => ({ imageName: anchor.filename || `anchor-${i}`, frameIdx: timeAnchorFrame(anchor.atSeconds) })), settings.length, { first: Boolean(communityKeyframes?.first), last: Boolean(communityKeyframes?.last) }) : null;
        const anchorTagProblem = timeAnchorPromptProblem(compiled.prompt, manifest.pictureRefs.length, communityTimeAnchors.length);
        if (anchorTagProblem) throw new Error(anchorTagProblem);
        if (anchorCheck?.warnings.length) showCanvasToast(`时间锚点提醒：${anchorCheck.warnings[0]}${anchorCheck.warnings.length > 1 ? `（另有 ${anchorCheck.warnings.length - 1} 条）` : ""}`);
        const anchorAssets = await Promise.all(communityTimeAnchors.map(async (anchor) => ({ ...anchor, frameIdx: timeAnchorFrame(anchor.atSeconds), asset: await assetForSource(anchor.storageReference, "image", anchor.filename, {}, controller.signal) })));
        const files = (items: { storageReference: string; filename: string; withAudio?: boolean }[], kind: "image" | "video" | "audio") => Promise.all(items.map(async (item) => ({ blob: await referenceBlob(item.storageReference, kind, item.filename), name: item.filename, withAudio: item.withAudio })));
        const [referenceImageFiles, referenceVideoFiles, referenceAudioFiles] = await Promise.all([files(payload.images, "image"), files(payload.videos, "video"), files(payload.audios, "audio")]);
        const referenceVideoChecks = await Promise.all(manifest.videoRefs.map(async (ref, index) => { const asset = await getAsset(ref.assetId); const known = typeof asset?.duration === "number" && asset.duration > 0 ? asset.duration : null; return { name: ref.filename, durationSeconds: known ?? await readVideoDurationSeconds(referenceVideoFiles[index].blob).catch(() => null), fps: asset?.fps ?? null }; }));
        const counts = { pictures: manifest.pictureRefs.length, videos: manifest.videoRefs.length, audios: manifest.audioRefs.length, standaloneAudios: manifest.audioRefs.filter((ref) => ref.kind === "standalone").length, subjects: manifest.roleBindings.length };
        const submissionMode = communityWorkflow ? communityInputMode(counts,communityKeyframeMode) : mode;
        if(submissionMode === 't2va' && settings.aspect === 'follow') throw new Error('文生视频没有原图可跟随，请先选择16:9、9:16或其他明确画面比例');
        if (!reportPreflight(runH3Preflight({ mode:submissionMode, prompt: compiled.prompt, rawPrompt: prompt, counts, referenceVideos: referenceVideoChecks, length: settings.length, megapixels: settings.megapixels, dimensions: submissionMode === 't2va' ? t2vaDimensions(settings) : undefined }))) throw new PreflightBlockedError();
        const referenceSize = communityWorkflow && settings.aspect === "follow" && payload.images.length ? await getLocalImageSize(payload.images[0].storageReference) : null;
        // 🧪 voiceRoleIds：声音样本提交时只送前 VOICE_SAMPLE_SECONDS 秒（ComfyUI TrimAudioDuration）。
        const submitSettings = manifest.voiceRoleIds?.length ? { ...settings, referenceAudioTrimSeconds: VOICE_SAMPLE_SECONDS } : settings;
        const snapshot = await snapshotH3({ workflowOptionId: shape.props.workflowOptionId, communityKeyframes, referenceMode: true, prompt: compiled.prompt, seed, settings: submitSettings, sourceWidth: referenceSize?.width ?? 0, sourceHeight: referenceSize?.height ?? 0, hasLastFrame: false, referenceCounts: { images: payload.images.length, videos: payload.videos.length, audios: payload.audios.length, videoAudioFlags: payload.videos.map((item) => item.withAudio) }, ...(anchorAssets.length ? { timeAnchors: anchorAssets.map((anchor) => ({ atSeconds: anchor.atSeconds, frameIdx: anchor.frameIdx, assetId: anchor.asset.assetId, filename: anchor.filename, asReference: Boolean(anchor.asReference), source: anchor.source })) } : {}) });
        const engine = await comfyUIH3Adapter.describeEngine([...h3ClassTypesFor(mode, shape.props.workflowOptionId), ...(communityKeyframeMode ? ["MiniMaxH3AudioConditioningT8"] : []), ...(anchorAssets.length ? ["MiniMaxH3AddGuide"] : [])]);
        const refZhengben = shape.props.zhengbenVersion || await fetchZhengbenVersion();
        snapshot.parameters.generationBatch = { id: batchId, index: 1, count: seeds.length };
        snapshot.parameters.noBackgroundMusic = settings.noBackgroundMusic ?? false;
        snapshot.parameters.autoRemoveMusic = shape.props.autoRemoveMusic ?? true; { const gateOverride = await gateOverrideFor(shape.props.shotTitle, shape.props.prompt); if (gateOverride) snapshot.parameters.gateOverride = gateOverride; }
        controller.signal.throwIfAborted();activeShot = await ensureH3Shot(editor, shape,controller.signal);controller.signal.throwIfAborted();
        const extensionAsset = extensionWorkflow && extensionSourceVideo ? await assetForSource(extensionSourceVideo.src, "video", extensionSourceVideo.name,{},controller.signal) : null;
        const ordered = [...(extensionAsset ? [{ assetId: extensionAsset.assetId, kind: "video" as const, role: "extension_source", withAudio: true }] : []), ...manifest.pictureRefs.map((ref) => ({ assetId: ref.assetId, kind: "image" as const, role: ref.sources.join("+") })), ...manifest.videoRefs.map((ref) => ({ assetId: ref.assetId, kind: "video" as const, role: "reference_video", withAudio: ref.withAudio })), ...manifest.audioRefs.filter((ref) => ref.kind === "standalone").map((ref) => ({ assetId: ref.assetId, kind: "audio" as const, role: ref.sources.join("+") })), ...anchorAssets.map((anchor) => ({ assetId: anchor.asset.assetId, kind: "image" as const, role: `time_anchor@${anchor.frameIdx}${anchor.source === "director" ? "+director" : ""}` }))];
        run = await createRunExclusively(shape.id, listRuns, attemptSignal => createRun({ ...snapshot, ownerNodeId: shape.id, shotId: activeShot.shotId, inputAssetIds: ordered.map((item) => item.assetId), rawPrompt: prompt, finalPrompt: compiled.prompt, seed, referenceInputs: ordered.map((item, order) => ({ ...item, order })), referenceManifest: manifest, promptMode: compiled.mode, promptCompile: { compilerVersion: compiled.compilerVersion, notes: compiled.notes }, taskMode: submissionMode, engine, zhengbenVersion: refZhengben, ...(shape.props.directorContext ? { directorContext: runDirectorContext(shape.props.directorContext, ordered.map((item) => item.assetId)) } : {}) }, { reservePromptId: true,signal:attemptSignal??controller.signal }),controller.signal);
        runIdRef.current = run.runId;controller.signal.throwIfAborted();await addRunToShot(activeShot.shotId, run.runId);controller.signal.throwIfAborted();
        runIdRef.current = run.runId;
        update({ lastSubmittedPrompt: compiled.prompt, lastSubmittedSeed: seed, roleSnapshot: freezeH3Roles(roleSelection, roleData) });
        generationInput = { workflowOptionId: shape.props.workflowOptionId, communityKeyframes, ...(extensionWorkflow && extensionSourceVideo ? { extensionVideo: { blob: await referenceBlob(extensionSourceVideo.src, "video", extensionSourceVideo.name), name: extensionSourceVideo.name } } : {}), sourceWidth: referenceSize?.width, sourceHeight: referenceSize?.height, taskMode: submissionMode, prompt, compiledPrompt: compiled.prompt, seed, settings: submitSettings, referenceMode: true, referenceImages: referenceImageFiles, referenceVideos: referenceVideoFiles, referenceAudios: referenceAudioFiles, ...(anchorAssets.length ? { guideImages: await Promise.all(anchorAssets.map(async (anchor) => ({ blob: await referenceBlob(anchor.storageReference, "image", anchor.filename), name: anchor.filename, frameIdx: anchor.frameIdx }))) } : {}) };
      }
      controller.signal.throwIfAborted();if (enqueueOnly) {
        if (seeds.length !== 1) throw new Error("镜头队列每个节点只提交一次；多候选请在节点中单独生成");
        const job = await comfyUIH3Adapter.enqueue(generationInput, {
          signal: controller.signal, promptId: run.runId, submissionControl,submissionSessionId,
          onPrepared: snapshot=>updateRun(run.runId,{submissionSnapshot:snapshot},controller.signal).then(()=>{}),
          onJobId: (id) => { jobIdRef.current = id; },
        });
        await updateRun(run.runId, { comfyPromptId: job.promptId, submission: "accepted" });
        uncertain = true;
        setStatus("connected");
        setProgress({ status: "queued", stage: "已进入 ComfyUI 队列" });
        return { runId: run.runId, promptId: job.promptId };
      }
      const templateRun = structuredClone(run);
      await runSerialGenerations(seeds, controller.signal, async (candidateSeed, index) => {
      if (batchStopRef.current) throw new DOMException("用户取消后续生成", "AbortError");
      if (!editor.getShape(shape.id)) throw new DOMException("节点已删除", "AbortError");
      setBatchProgress({ index: index + 1, count: seeds.length });
      if (index > 0) {
        run = await createRunExclusively(shape.id, listRuns, attemptSignal => createRun(candidateRunInput(templateRun, candidateSeed, { id: batchId, index: index + 1, count: seeds.length }), { reservePromptId: true,signal:attemptSignal??controller.signal }),controller.signal);
        runIdRef.current = run.runId;controller.signal.throwIfAborted();await addRunToShot(activeShot.shotId, run.runId);controller.signal.throwIfAborted();
        runIdRef.current = run.runId;
      }
      controller.signal.throwIfAborted();
      jobIdRef.current = "";
      generationInput = { ...generationInput, seed: candidateSeed };
      update({ lastSubmittedSeed: candidateSeed });
      setStatus("preparing"); setProgress({ status: "preparing", stage: `准备第 ${index + 1}/${seeds.length} 次生成` });
      let markedRunning = false;
      const result = await comfyUIH3Adapter.generate(generationInput, { signal: controller.signal, promptId: run.runId, onPrepared:snapshot=>updateRun(run.runId,{submissionSnapshot:snapshot}).then(()=>{}), onTiming:timing=>recordRunUpdate(run.runId,{executionTiming:timing,...(timing.startedAt?{startedAt:timing.startedAt}:{}),...(timing.completedAt?{completedAt:timing.completedAt}:{})}), onJobId: (jobId) => { if (controller.signal.aborted || stoppedRef.current) return; jobIdRef.current = jobId; recordRunUpdate(run.runId, { comfyPromptId: jobId, submission: "accepted" }); }, onUpdate: (next) => { if (controller.signal.aborted || stoppedRef.current) return; setStatus(next.status); setProgress(next); if (["loading", "running", "decoding"].includes(next.status) && !markedRunning) { markedRunning = true; recordRunUpdate(run.runId, { status: "running", startedAt: Date.now() }); } } });
      // Idempotent: a second tab or a refresh-recovery pass cannot register this output twice.
      const finalized = await finalizeRunOutput(run.runId, runOutputStore, async () => { const metadata = await readVideoMetadata(result.video); const src = await storeLocalVideo(result.video, result.filename); const measuredFps = await readMp4VideoFps(result.video).catch(() => null); const outputFps = communityWorkflow ? Number(parseCommunityValues(settings.communityParameters)['148.frame_rate'] ?? 24) : settings.fps; return generatedVideoAsset(src, result, metadata, run.runId, measuredFps ?? outputFps, activeShot.shotId); });
      const updatedShot = await presentH3Output(finalized.asset, activeShot.shotId);
      setStatus("completed"); setProgress({ status: "completed", percent: 100, stage: "生成完成" }); logTaskDone(shape.type, shape.id, run.runId, activeShot.shotId); showCanvasToast(updatedShot.adoptedAssetId ? "新候选已保存；画布仍显示已采用版本" : "H3 视频已生成并加入画布");
      runIdRef.current = ""; jobIdRef.current = "";
      });
      setProgress({ status: "completed", percent: 100, stage: `${seeds.length} 次生成完成，结果已加入候选` });
    } catch (cause) {
      if (cause instanceof PreflightBlockedError) { setStatus("failed"); setProgress({ status: "failed", stage: "生成前检查未通过" }); return; }
      const cancelled = cause instanceof DOMException && cause.name === "AbortError" && !parentSignal?.aborted;
      uncertain = !!parentSignal?.aborted&&!!runIdRef.current || !cancelled && Boolean(runIdRef.current) && ((enqueueOnly && Boolean(jobIdRef.current)) || isUncertainAfterSubmit(cause, Boolean(jobIdRef.current)));
      if (uncertain) { setStatus("disconnected"); setProgress({ status: "disconnected", stage: "与 ComfyUI 的连接中断，任务状态待确认（不会重复提交）" }); logTaskUncertain(shape.type, shape.id, runIdRef.current); }
      else {
        // eslint-disable-next-line react-hooks/purity -- Date.now() runs after a failed generate click, never during render
        if (runIdRef.current) recordRunUpdate(runIdRef.current, { status: cancelled ? "cancelled" : "failed", completedAt: Date.now(), error: cancelled ? "用户取消" : cause instanceof Error ? cause.message : "生成失败" });
        if (cancelled) { setStatus("cancelled"); setProgress({ status: "cancelled", stage: "任务已取消" }); }
        else { const message = humanizeGenerationError(cause); setStatus("failed"); setProgress({ status: "failed", stage: "生成失败" }); setError(message); logTaskFailure(shape.type, shape.id, runIdRef.current, message, shape.props.shotId); showCanvasToast(message); }
      }
      if (enqueueOnly) throw cause; // Preserve the real submission error class for the queue's fail-closed policy.
    } finally { parentSignal?.removeEventListener('abort',relay);setBatchProgress(null); abortRef.current = null; jobIdRef.current = ""; runIdRef.current = ""; release(); if (uncertain) void recovery.recheck(); }
  };

  const lockCurrent = async () => {
    try {
      const asset=displayedAssetId?await getAsset(displayedAssetId):null;
      const run=asset?.sourceRunId?await getRun(asset.sourceRunId):null;
      if(!asset||!run||!isH3Capability(run.capabilityId))throw new Error("请锁定H3原始候选，而不是高清或插帧派生版");
      await lockedWorkflow(run);
      update({lockedRunId:run.runId,lockedAssetId:asset.assetId});
      showCanvasToast("已锁定当前候选的实际工作流、种子、提示词、参考图和声音。高清使用原片，不会重新抽卡。");
    } catch(cause) {showCanvasToast(cause instanceof Error?cause.message:"无法锁定");}
  };
  const replayLocked = async () => {
    if(busy||recovery.blocking||!shape.props.lockedRunId)return;
    const release=claimNode(shape.id);if(!release)return;
    const controller=new AbortController();abortRef.current=controller;
    let run:RunRecord|undefined;
    try {
      const original=await getRun(shape.props.lockedRunId);
      if(!original)throw new Error("锁定记录不存在");
      const snapshot=await lockedWorkflow(original);
      if(original.engine?.comfyuiVersion) {
        const engine=await comfyUIH3Adapter.describeEngine(Object.values(snapshot.graph).map(n=>n.class_type));
        if(engine.comfyuiVersion && original.engine.comfyuiVersion!==engine.comfyuiVersion)throw new Error("ComfyUI版本已变化，请先核对；不会冒充完全相同的重渲");
      }
      for(const assetId of original.inputAssetIds)if(!await getAsset(assetId))throw new Error("锁定输入素材缺失，请恢复原素材");
      run=await createRunExclusively(shape.id,listRuns,()=>createRun({...candidateRunInput(original,original.seed!,{id:crypto.randomUUID(),index:1,count:1}),ownerNodeId:shape.id},{reservePromptId:true}));
      runIdRef.current=run.runId;
      if(run.shotId)await addRunToShot(run.shotId,run.runId);
      setStatus("preparing");setError("");
      const id=run.runId;
      const output=await comfyUIH3Adapter.replay(snapshot,{signal:controller.signal,promptId:id,
        onPrepared:s=>updateRun(id,{submissionSnapshot:s}).then(()=>{}),
        onTiming:t=>recordRunUpdate(id,{executionTiming:t,...(t.startedAt?{startedAt:t.startedAt}:{}),...(t.completedAt?{completedAt:t.completedAt}:{})}),
        onJobId:jobId=>{jobIdRef.current=jobId;recordRunUpdate(id,{comfyPromptId:jobId,submission:"accepted"});},
        onUpdate:next=>{setStatus(next.status);setProgress(next);}
      });
      const finalized=await finalizeRunOutput(id,runOutputStore,async()=>{
        const metadata=await readVideoMetadata(output.video),src=await storeLocalVideo(output.video,output.filename);
        return generatedVideoAsset(src,output,metadata,id,Number(original.parameters.fps)||24,run!.shotId);
      });
      if(run.shotId)await presentH3Output(finalized.asset,run.shotId);
      setStatus("completed");showCanvasToast("已按锁定快照重渲；同种子仍不保证逐像素相同，原候选保留");
    } catch(cause) {
      if(run && isUncertainAfterSubmit(cause,!!jobIdRef.current)){setStatus("disconnected");}
      // eslint-disable-next-line react-hooks/purity -- Timestamp is taken in a user-initiated async retry handler, never during render.
      else {if(run)recordRunUpdate(run.runId,{status:controller.signal.aborted?"cancelled":"failed",completedAt:Date.now(),error:cause instanceof Error?cause.message:"锁定重渲失败"});setStatus("failed");}
      setError(cause instanceof Error?cause.message:"锁定重渲失败");
    } finally {runIdRef.current="";jobIdRef.current="";abortRef.current=null;release();void recovery.recheck();}
  };
  const upscaleLocked = async () => {
    const asset=shape.props.lockedAssetId?await getAsset(shape.props.lockedAssetId):displayedAssetId?await getAsset(displayedAssetId):null;
    if(!asset)return;
    // Pin this source explicitly: changing the displayed candidate later must not change this enhancement.
    const inputId=createShapeId();editor.createShape({id:inputId,type:"video-node",x:shape.x+shape.props.w+120,y:shape.y,props:{src:asset.storageReference,name:asset.filename,assetId:asset.assetId,shotId:asset.shotId}});
    const source=editor.getShape(inputId) as VideoNode;
    const node=createUpscaleNode(editor,{x:source.x+source.props.w+120,y:source.y},source,"1080p");
    if(node)editor.zoomToSelection({animation:{duration:180}});
  };

  const draftDuration = getActualDuration(durationDraft); const stageText = error || progress.stage || `${duration.actualSeconds.toFixed(2)}秒 · ${H3_ASPECT_LABELS[aspect]} · ${settings.megapixels.toFixed(2)}MP`;
  const actualDimensions = calculateH3Dimensions(inputFrame?.width || loadedInputDimensions?.width || 0, inputFrame?.height || loadedInputDimensions?.height || 0, aspect, settings.megapixels, settings.resolutionSteps);
  const modeDimensions = taskMode === "t2va" ? t2vaDimensions(settings) : actualDimensions;
  // Live hint while editing; the submission re-checks against the real Reference Manifest.
  const roleVoiceCount = speakerPolicy.disabled ? 0 : new Set([...(voiceRoleId ? [voiceRoleId] : []), ...(voiceRoleIds ?? []), ...dialogueLines.filter(line=>line.roleId).map(line => line.roleId)]).size;
  const liveCounts = taskMode === "t2va" || taskMode === "i2va" || taskMode === "fl2va" ? frameModeCounts(taskMode) : { pictures: (inputFrame && !extensionWorkflow ? 1 : 0) + ((taskMode === "hybrid" || communityKeyframeMode) && lastFrame ? 1 : 0) + allReferenceImages.length + communityPictureGuides.length + anchorReferenceGuides.length + roleIds.filter(id => !offscreenRoleIds.includes(id)).length, videos: referenceVideos.length, audios: dialogueAudioIds(dialogueLines).length + referenceAudios.length + referenceVideos.filter((item) => item.withAudio).length + roleVoiceCount, standaloneAudios: dialogueAudioIds(dialogueLines).length + referenceAudios.length + roleVoiceCount, subjects: roleIds.length };
  const livePreflightMode = communityWorkflow ? communityInputMode(liveCounts,communityKeyframeMode) : taskMode;
  const livePreflight = runH3Preflight({ mode: livePreflightMode, modeProblem: taskResolution.problem, prompt: livePreflightMode === "ref2va" || livePreflightMode === "hybrid" ? shape.props.prompt : compileH3Prompt(shape.props.prompt, settings.soundMode, settings.noBackgroundMusic), rawPrompt: shape.props.prompt, counts: liveCounts, length: duration.length, megapixels: settings.megapixels, dimensions: livePreflightMode === 't2va' ? t2vaDimensions(settings) : livePreflightMode === "ref2va" || livePreflightMode === "hybrid" ? null : modeDimensions });
  const guideProblem = incomingLastImage && legacySlot === undefined ? "当前图片超过 5 张，请断开多余的旧尾帧连接。" : storyboardGuideProblem(nodeGuides, duration.length, taskMode);
  if (guideProblem) { livePreflight.errors.push({ level: "error", code: "storyboard_guides", message: guideProblem }); livePreflight.ok = false; }
  const communityProblem = communityWorkflow ? communityInputProblem({ keyframeCount: communityKeyframeMode ? (inputFrame ? 1 : 0) + (lastFrame ? 1 : 0) : 0, pictures: liveCounts.pictures, videos: referenceVideos.length, audios: referenceAudios.length, guides: communityWorkflow ? communityTimeAnchors.length : directorGuides.length }) : null;
  if (communityProblem) { livePreflight.errors.push({ level: "error", code: "community_inputs", message: communityProblem }); livePreflight.ok = false; }
  for (const message of speakerPolicy.errors) { livePreflight.errors.push({level:'error',code:'speaker_required',message}); livePreflight.ok=false; }
  const modeEnabled = Boolean(taskMode && H3_TASK_STATUS[taskMode].enabled);
  const keyframeCount = (inputFrame ? 1 : 0) + (lastFrame ? 1 : 0);
  const modeDescription = extensionWorkflow ? "原视频作为动态 / 音频上下文，输出含原片；按像素预算沿用原比例、24fps。未试渲。" : communityKeyframeMode ? "🧪 首尾帧 + 最多9张参考图；T8 实验输入，未试渲" : communityWorkflow ? "1–9张图片作为参考，不锁定首尾帧；超过4张未试渲，可跟随第一参考图比例" : taskMode === "t2va" ? `没有连接图片：按 Prompt 直接生成（${H3_ASPECT_LABELS[t2vaAspect(aspect)]}${aspect === "follow" ? "，无原图可跟随" : ""}）` : taskMode === "i2va" ? "首帧用于锁定视频起始画面" : taskMode === "fl2va" ? "首帧和尾帧分别用于锁定起始与结束画面" : taskMode === "ref2va" ? "首帧当前作为参考图，不再严格锁定视频起始帧" : taskMode === "hybrid" ? `编号预案：${inputFrame ? "首帧 → Picture 1（精确锁定）" : ""}${inputFrame && lastFrame ? "，" : ""}${lastFrame ? `尾帧 → Picture ${keyframeCount}（精确锁定）` : ""}，参考图从 Picture ${keyframeCount + 1} 开始` : taskResolution.problem ?? "";
  const effectiveSteps = communityWorkflow ? communityActualSteps(shape.props.workflowOptionId as 'community-ultimate'|'community-dialogue', parseCommunityValues(settings.communityParameters)) ?? '由调度器实际计算' : isReference ? (settings.turbo ? 4 : 20) : (settings.turbo ? 6 : 20);
  const effectivePrompt = isReference && promptMode === "official_structured" ? "（官方结构：提交时根据 Reference Manifest 编译）" : compileH3Prompt(shape.props.prompt, settings.soundMode, settings.noBackgroundMusic);
  const chooseCandidate = (assetId: string) => { setPreviewCandidateId(assetId); update({ previewAssetId: assetId }); };
  const adoptPreview = async () => {
    if (!shape.props.shotId || !displayedAssetId) return;
    try { await adoptShotAsset(shape.props.shotId, displayedAssetId); const asset = await getAsset(displayedAssetId); if (asset && resultNode) displayVideoAsset(editor, resultNode, asset); announceShotChange(shape.props.shotId); showCanvasToast("已采用当前版本"); }
    catch (cause) { showCanvasToast(cause instanceof Error ? cause.message : "采用失败"); }
  };
  // Canvas automation V0.1: window.frameflow drives this node through the same generate / adopt as the buttons.
  const automation = useRef<H3AutomationState | null>(null);
  useEffect(() => { automation.current = { generate: async () => { await generate(); }, enqueue: async (submissionControl,submissionSessionId,signal) => { const receipt = await generate(true,submissionControl,submissionSessionId,signal); if (!receipt) throw new Error("节点未提交：请查看节点错误或确认是否已有进行中的任务"); return receipt; }, adopt: adoptPreview, choose: chooseCandidate, busy, status, stage: progress.stage, error, elapsed, taskMode: taskMode ?? undefined, queueFrameToken: typeof shape.meta.shotQueueFrameToken === 'string' ? shape.meta.shotQueueFrameToken : undefined, preflight: livePreflight, compiledPrompt: effectivePrompt, batch: batchProgress, candidateCount, displayedAssetId, adoptedAssetId: shot?.adoptedAssetId ?? undefined }; });
  useEffect(() => registerH3Automation(shape.id, () => automation.current as H3AutomationState), [shape.id]);
  return <HTMLContainer className="node-container interactive-node node-minimal h3-preview-node" style={{ "--h3-preview-width": `${previewSize.w}px`, "--h3-preview-middle": `${32 + previewSize.h / 2}px` } as React.CSSProperties}><NodeShell wideH3={usesWideH3Typography(shape.meta, shape.props.w)} nodeId={shape.id} inputPort={<WorkflowPort editor={editor} shape={shape} side="left" onClick={() => { editor.select(shape.id); setFramePicker("first"); }} />} icon={<Video size={15} />} eyebrow={shot ? `镜头${String(shot.shotNumber).padStart(2, "0")}` : "H3 视频"} title="视频" accent="#858585" onDelete={deleteNode} onInput={() => { editor.select(shape.id); setFramePicker("first"); }} onDownload={resultSource ? () => downloadNodeMedia(resultSource, previewAsset?.filename ?? resultNode?.props.name ?? shape.props.inheritedVideo?.name ?? "视频.mp4", "video") : undefined} actions={<><DemixNodeControl editor={editor} shapeId={shape.id} assetId={displayedAssetId || undefined} disabled={busy} /><button type="button" className="node-header-button" title="生成信息 · 提交前核对" aria-label="生成信息 · 提交前核对" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); setShowSubmissionInfo(true); }}><Info size={13} /></button>{!candidateCount && inheritedAsset && <><button type="button" className="node-header-button" title="高清结果生成信息" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); setShowInheritedInfo(true); }}><Info size={13} /></button></>}{candidateCount > 0 && <div className="creative-candidates-bar h3-header-candidates" onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={stopPropagation}>
          <select aria-label="当前候选" value={displayedAssetId} onChange={(event) => chooseCandidate(event.target.value)}>{inheritedAsset && displayedAssetId !== inheritedAsset.assetId && !candidateOptions.some(c=>c.asset.assetId === inheritedAsset.assetId) && <option value={inheritedAsset.assetId}>原高清 / 插帧结果</option>}{candidateVersions.filter(v=>v.derivationType==="music_removal"&&!candidateOptions.some(c=>c.asset.assetId===v.assetId)).map(v=><option key={v.assetId} value={v.assetId}>{(()=>{const root=candidateOptions.find(c=>c.asset.assetId===v.sourceVideoAssetId);return root?`候选 ${root.label} · ${demixPassLabel(musicRemovalPassesOf(v))}`:`${demixPassLabel(musicRemovalPassesOf(v))}版`;})()}{shot?.adoptedAssetId === v.assetId ? " · ★" : ""}</option>)}{previewAsset && previewAsset.derivationType !== "music_removal" && !candidateOptions.some(c=>c.asset.assetId === previewAsset.assetId) && <option value={previewAsset.assetId}>{shot?.adoptedAssetId === previewAsset.assetId ? "★ 已采用版本" : "当前处理版本"}</option>}{resultNode?.props.assetId && !candidateOptions.some((c) => c.asset.assetId === resultNode.props.assetId) && <option value={resultNode.props.assetId}>当前结果</option>}{candidateOptions.map((candidate) => <option key={candidate.asset.assetId} value={candidate.asset.assetId}>候选 {candidate.label}{shot?.adoptedAssetId === candidate.asset.assetId ? " · ★" : ""}</option>)}</select>
          <button type="button" onClick={() => void adoptPreview()} disabled={!displayedAssetId || shot?.adoptedAssetId === displayedAssetId || inheritedAsset?.assetId === displayedAssetId}>{shot?.adoptedAssetId === displayedAssetId ? "★ 已采用" : "☆ 采用"}</button>
          <button type="button" className="h3-candidates-link" onClick={() => setShowCandidates(true)}>候选 {candidateCount} · 查看全部</button>
          <button type="button" onClick={()=>openCanvasTools("compare",candidateOptions.map(c=>c.asset.assetId))}>并排对比</button><AuditBadge assetId={displayedAssetId}/>
        </div>}</>} outputPort={<WorkflowPort editor={editor} shape={shape} />}>
    <TailFrameHDStatus editor={editor} nodeId={shape.id}/>
    <H3ResultPreview editor={editor} nodeId={shape.id} source={resultSource} firstPreview={firstPreview} stillSource={frameSrc} busy={busy} selected={selected} size={previewSize} onActivate={activatePreview} onDimensions={receiveVideoDimensions} caption={busy ? `${statusLabels[status]} · ${timing.generationSeconds === null ? `排队 ${formatElapsed(timing.queueSeconds)}` : `生成 ${formatElapsed(elapsed)}`}` : typeof shape.meta.shotQueueFrameSources === 'string' ? `${shape.meta.shotQueueFrameWaiting ? '等待来源视频 · ' : '独立片段 · '}${shape.meta.shotQueueFrameSources}` : firstPreview || shape.props.prompt.trim() ? "" : extensionWorkflow ? "视频延长：描述接下来发生什么" : "放入图片，描述你想拍的画面"} />
    {(selected || referenceDragHold || dockPinned) && dockOpen && <section className={`h3-creative-dock h3-inline-composer ${picturesExpanded ? "pictures-expanded" : ""}`} data-drop-disabled={busy || recovery.blocking} data-node-id={shape.id} data-input-view={inputView} aria-label="视频创作面板" onPointerDown={(event) => { event.stopPropagation(); if (!selected) editor.select(shape.id); }} onPointerUp={stopPropagation} onKeyDown={stopPropagation} onKeyUp={stopPropagation} onWheel={stopWheelPropagation} onContextMenu={stopPropagation}>
      <div ref={formRef} className="h3-form h3-creative-form">
        <header className="creative-dock-header"><div className="creative-input-tabs">{(extensionWorkflow ? ["多参考"] : communityWorkflow ? ["文本", "多参考", "顺序图片"] : ["文本", "顺序图片", "多参考"]).map((view) => <button type="button" key={view} disabled={busy || recovery.blocking || (shape.props.workflowLock === SHOT_QUEUE_LOCK && view !== "多参考")} aria-pressed={communityWorkflow ? communityKeyframeMode ? view === "顺序图片" : inputView === view : inputView === view} onClick={() => { if (shape.props.workflowLock === SHOT_QUEUE_LOCK && view !== "多参考") return; setInputView(view); update({ allReferenceMode: view === "多参考", ...(communityWorkflow ? { ultimateKeyframes: view === "顺序图片" } : {}) }); }}>{communityWorkflow ? view === "多参考" ? "多参考图" : view === "顺序图片" ? "首尾帧图" : "文本" : view === "多参考" ? (extensionWorkflow ? "视频延长" : "全能参考") : view}</button>)}</div><span data-task-mode={taskMode ?? "none"} title={modeDescription}>{extensionWorkflow ? "视频延长 · 待试渲" : communityKeyframeMode ? "首尾帧 + 参考 · 未试渲" : communityWorkflow && !liveCounts.pictures ? "文生视频 · 未试渲" : taskMode ? H3_TASK_LABELS[taskMode] : "输入待检查"}</span><button type="button" className="creative-dock-close" title="收起面板（Esc）" aria-label="收起面板" onClick={closeDock}><X size={14} /></button></header>
        {communityKeyframeMode && <div className="creative-reference-strip" data-testid="ultimate-keyframes">
          <div data-frame-role="first">{inputFrame ? <ReferenceSlot kind="image" src={inputFrame.src} name={inputFrame.name} label={shape.props.videoFirstFrame ? "首帧 · 视频提取（提交时自动适配编号）" : "首帧 · Picture 1"} onReplace={() => setFramePicker("first")} onRemove={() => { if (!busy) { removeExistingFrameConnection(editor, shape.id, "first", createShapeId()); update({ videoFirstFrame: undefined, sourceFrameSrc: "", sourceFrameName: "" }); } }} /> : <button type="button" disabled={busy} onClick={() => setFramePicker("first")}>+ 首帧</button>}</div>
          <div data-frame-role="last">{lastFrame ? <ReferenceSlot kind="image" src={lastFrame.src} name={lastFrame.name} label={shape.props.videoLastFrame ? "尾帧 · 视频提取（提交时自动适配编号）" : "尾帧 · Picture 2"} onReplace={() => setFramePicker("last")} onRemove={() => { if (!busy) { removeExistingFrameConnection(editor, shape.id, "last", createShapeId()); update({ videoLastFrame: undefined, inheritedLastFrame: undefined }); } }} /> : <button type="button" disabled={busy} onClick={() => setFramePicker("last")}>+ 尾帧</button>}</div>
          <small className="ff-hint">首尾帧分别进入关键帧接口；其余图片作为参考。模型与当前工作流采样方案保持不变；GPU效果待你验收。</small>
        </div>}
        {extensionWorkflow && <div className="creative-reference-strip" data-testid="video-extension-source">{extensionSourceVideo && <ReferenceSlot kind="video" src={extensionSourceVideo.src} name={extensionSourceVideo.name} label="要延长的原视频" onRemove={() => update({ extensionSourceVideo: undefined })} />}<button type="button" disabled={busy || recovery.blocking} onClick={() => extensionVideoInput.current?.click()}>{extensionSourceVideo ? "更换原视频" : "+ 原视频"}</button><small className="creative-batch-note ff-hint">时长是新增时长；输出包含原片。沿用原视频比例，按像素预算缩放为24fps工作副本，原文件不改。声音连续性待你试渲验收。</small><input ref={extensionVideoInput} type="file" accept="video/mp4" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void storeLocalVideo(file, file.name).then(async (src) => { await importedAsset(src, "video", file); update({ extensionSourceVideo: { src, name: file.name } }); }).catch((cause) => showCanvasToast(String(cause))); }} /></div>}
        {communityWorkflow && inputView === "文本" && <small className="ff-hint">不添加图片时走文生视频实验，请选择明确比例；已有参考图仍会参与生成。锁定首尾帧请切换“首尾帧图”。</small>}
        {inputView === "顺序图片" && !communityKeyframeMode && <><StoryboardGuideEditor referenceSlots={allReferenceImages.map((item, index) => <div key={item.orderKey} className="reference-sortable" draggable={!busy && !recovery.blocking} title="按住图片拖动调整顺序" onPointerDown={stopPropagation} onDragStart={(event) => { event.stopPropagation(); referenceDrag.current = item.orderKey; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-frameflow-reference", item.orderKey); }} onDragOver={(event) => { if (referenceDrag.current) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (referenceDrag.current) reorderReferenceImage(referenceDrag.current, item.orderKey); referenceDrag.current = null; }} onDragEnd={() => { referenceDrag.current = null; }}><ReferenceSlot kind="image" src={item.src} name={item.name} label={`图片 ${index + (inputFrame && !extensionWorkflow ? 2 : 1)}`} onRemove={() => { if (item.nodeId) removeConnectedReference(item.nodeId); else removeReference("referenceImages", item.localIndex); }} /></div>)} hideFirstSlot={!inputFrame && allReferenceImages.length > 0} firstSlot={<button type="button" className={`h3-frame-slot ${inputFrame ? "has-image" : ""}`} data-frame-role="first" title="点击选择已有图片或上传；也可拖线连接" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); setFramePicker("first"); }}><span>{communityWorkflow ? "参考图 1" : "首帧"}</span>{inputFrame && firstPreview ? <><img src={firstPreview} alt="连接的首帧" draggable={false} /><b title={inputFrame.name}>{incomingImage ? inputFrame.name : "上一段视频尾帧"}</b></> : <><div className="h3-input-placeholder"><Link2 size={14} /></div><b>点击选择图片</b></>}</button>} guides={storyboardGuides} totalCount={nodeGuides.length} length={duration.length} disabled={busy || recovery.blocking} onChange={(guides) => { editor.markHistoryStoppingPoint("before editing storyboard guides"); editor.run(() => { const removed = storyboardGuides.filter((g) => !guides.some((next) => next.sourceNodeId === g.sourceNodeId && next.slot === g.slot)); for (const g of removed) { if (g.sourceNodeId) editor.deleteShapes(editor.getCurrentPageShapes().filter((a) => a.type === "arrow" && a.meta.guideSlot === g.slot && getArrowBindings(editor, a as TLArrowShape).end?.toId === shape.id).map((a) => a.id)); } update({ storyboardGuides: guides }); }); editor.markHistoryStoppingPoint("after editing storyboard guides"); }} onUpload={async (file) => { const src = await storeLocalImage(file, file.name); return importedAsset(src, "image", file); }} />
<button type="button" className="creative-picture-expand" aria-label="展开图片预览" aria-expanded={picturesExpanded} onClick={() => setPicturesExpanded(!picturesExpanded)}>{picturesExpanded ? "收起图片" : "放大图片"} <ChevronDown size={12} /></button></>}
        {(inputView === "多参考" || (communityKeyframeMode && inputView === "顺序图片")) && <div className="creative-reference-strip">
          {!extensionWorkflow && !communityKeyframeMode && inputFrame && <button type="button" className="creative-first-reference" data-frame-role="first" title={`第一参考图：${inputFrame.name}；点击更换`} onClick={() => setFramePicker("first")}>{firstPreview ? <img src={firstPreview} alt="第一参考图" decoding="async" draggable={false} /> : <ImageIcon size={18} />}</button>}
          {allReferenceImages.map((item, index) => <div key={item.orderKey} className="reference-sortable" draggable={!busy && !recovery.blocking} title="按住图片拖动调整顺序" onPointerDown={stopPropagation} onDragStart={(event) => { event.stopPropagation(); referenceDrag.current = item.orderKey; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-frameflow-reference", item.orderKey); }} onDragOver={(event) => { if (referenceDrag.current) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (referenceDrag.current) reorderReferenceImage(referenceDrag.current, item.orderKey); referenceDrag.current = null; }} onDragEnd={() => { referenceDrag.current = null; }}><ReferenceSlot kind="image" src={item.src} name={item.name} label={`图片 ${index + (inputFrame && !extensionWorkflow && !shape.props.videoFirstFrame ? 2 : 1) + (communityKeyframeMode && lastFrame && !shape.props.videoLastFrame ? 1 : 0)}`} onRemove={() => { if (item.nodeId) removeConnectedReference(item.nodeId); else removeReference("referenceImages", item.localIndex); }} /></div>)}
          {communityPictureGuides.map((item, index) => <ReferenceSlot key={`community-guide-${index}`} kind="image" src={item.storageReference} name={item.filename} label={`参考图 ${allReferenceImages.length + (inputFrame ? 1 : 0) + (communityKeyframeMode && lastFrame ? 1 : 0) + index + 1}`} onRemove={async () => { if (!await (item.sourceNodeId ? removeConnectedReference(item.sourceNodeId) : confirmReferenceRemoval())) return; update({ storyboardGuides: storyboardGuides.filter((guide) => guide.slot !== item.slot) }); }} />)}
          {referenceVideos.map((item, index) => <ReferenceSlot key={`mini-video-${index}`} kind="video" src={item.src} name={item.name} label={`视频 ${index + 1}`} onRemove={() => removeReference("referenceVideos", index)} />)}
          {referenceAudios.map((item, index) => <ReferenceSlot key={`mini-audio-${index}`} kind="audio" src={item.src} name={item.name} label={`声音 ${index + 1}`} onRemove={() => removeReference("referenceAudios", index)} />)}
          <button type="button" className="creative-add-reference" data-frame-role="reference" disabled={busy || recovery.blocking} onClick={() => {replacingReference.current=null;setCanvasReferencePicker("referenceImages");}}>+ 图片</button>
          <button type="button" disabled={busy || recovery.blocking || communityWorkflow} title={communityWorkflow ? "终极版和极速版暂未接入普通参考视频" : "选择画布里的参考视频"} onClick={() => {replacingReference.current=null;setCanvasReferencePicker("referenceVideos");}}>+ 视频</button>
          <button type="button" disabled={busy || recovery.blocking} title="选择画布里的声音参考" onClick={() => {replacingReference.current=null;setCanvasReferencePicker("referenceAudios");}}>+ 声音</button>
          <button type="button" onClick={(event) => openSettings(event.currentTarget, "references")}>角色 / 更多{roleIds.length ? ` · ${roleIds.length}` : ""}</button>
        </div>}
        {inputView === "多参考" && <small className="creative-batch-note ff-hint" data-testid="all-reference-hint">{extensionWorkflow ? "视频延长（未试渲）：原视频负责动作与声音上下文；下面可补人物 / 场景参考，不用首帧" : communityKeyframeMode ? "首帧、尾帧至少选择一项；另加最多9张参考图、3条声音。实验接口未试渲。" : communityWorkflow ? "无需首帧 · 最多9张参考图、3条参考声音（含角色主声音）；超过4张及音色参考未试渲，暂不接入普通参考视频" : "无需首帧 · 现场图 + 人物图 + 视频 / 声音 · 用提示词说明每个参考的用途；生成前选择画面比例"}</small>}
        {communityWorkflow && !extensionWorkflow && <TimeAnchorEditor anchors={nodeTimeAnchors} durationSeconds={duration.length / H3_FPS} length={duration.length} edges={{ first: communityKeyframeMode && Boolean(inputFrame), last: communityKeyframeMode && Boolean(lastFrame) }} reserved={directorGuides.length} disabled={busy || recovery.blocking} onChange={(next) => update({ timeAnchors: next })} onAddFile={async (file) => ({ storageReference: await storeLocalImage(file, file.name), filename: file.name })} />}
                  <input ref={referenceImageInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void addReference("referenceImages", file).catch((cause) => showCanvasToast(String(cause))); else replacingReference.current = null; }} />
          <input ref={referenceVideoInput} type="file" accept="video/mp4" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void addReference("referenceVideos", file).catch((cause) => showCanvasToast(String(cause))); else replacingReference.current = null; }} />
          <input ref={referenceAudioInput} type="file" accept="audio/*,.m4a" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void addReference("referenceAudios", file).catch((cause) => showCanvasToast(String(cause))); else replacingReference.current = null; }} />

        <ReferencePromptEditor nodeId={shape.id} textareaRef={promptRef} value={shape.props.prompt} height={Math.max(H3_PROMPT_HEIGHT, shape.props.promptHeight ?? H3_PROMPT_HEIGHT)} disabled={busy || recovery.blocking}
          spec={!extensionWorkflow && (taskMode === "ref2va" || taskMode === "hybrid") ? {
            images: [...(inputFrame ? [{ src: inputFrame.src, name: inputFrame.name, source: "first_frame" as const, nodeId: incomingImage?.id }] : []), ...(communityKeyframeMode && lastFrame ? [{ src: lastFrame.src, name: lastFrame.name, source: "connected_reference" as const, nodeId: incomingLastImage?.id }] : []), ...allReferenceImages, ...communityPictureGuides.map(item => ({ src: item.storageReference, name: item.filename, source: "connected_reference" as const, nodeId: item.sourceNodeId }))],
            videos: referenceVideos, audios: referenceAudios, roleIds, offscreenRoleIds, roleRevision: JSON.stringify(roleOptions.map(role => [role.roleId, role.updatedAt])), roleSnapshot: shape.props.roleSnapshot, dialogue: dialogueLines, voiceRoleId, voiceRoleIds, soundMode: settings.soundMode ?? "av", includeRoleVoices: !speakerPolicy.disabled,
          } : null}
          onChange={prompt => update({ prompt })}
          onInspect={item => { const node = item.nodeId && editor.getShape(item.nodeId as TLShape["id"]); if (node) { editor.select(node.id); editor.zoomToSelection({ animation: { duration: 220 } }); showCanvasToast(`已定位 ${item.label} · ${item.name}`); } else previewMedia(item.src, item.kind, `${item.label} · ${item.name}`); }} />
        {nodeGuides.length > 0 && <small className="creative-batch-note ff-hint">🧪 顺序引导：结束图是目标画面，不保证精确命中或硬锁定。</small>}
        {isReference && <small className="creative-batch-note ff-hint">{livePreflightMode === 't2va' ? '文生视频：填写提示词即可，无需添加素材' : <>{communityKeyframeMode ? "首尾帧实验 · 视频" : "多参考不锁定首尾帧 · 视频"} {referenceVideos.length} · 声音 {referenceAudios.length} · 角色 {roleIds.length}</>}</small>}
                <div className={`generation-status status-${status}`}><div className="status-copy"><span>{statusLabels[status]}</span><b>{stageText}</b>{busy && <em title={timing.syncWarning ?? "等待时间包含提交准备与排队；生成时间从 ComfyUI 开始执行工作流计算"}>排队 {formatElapsed(timing.queueSeconds)} · 生成 {timing.generationSeconds === null ? "尚未开始" : formatElapsed(elapsed)}{timing.syncWarning ? " · ⚠ 数据同步异常" : ""}</em>}</div>{busy && <div className={`progress-track ${progress.percent === undefined ? "indeterminate" : ""}`}><i style={progress.percent === undefined ? undefined : { width: `${progress.percent}%` }} /></div>}</div>
        <RecoveryStatus recovery={recovery} />
        {shotPromptWarnings(shape.props.prompt, duration.actualSeconds, dialogueLines).map(message => <small className="preflight-warning" key={message}>△ {message}</small>)}
        {h3PromptHealthMessages(shape.props.prompt, { seconds: duration.actualSeconds, firstFrame: communityKeyframeMode || Boolean(shape.props.videoFirstFrame), soundMode: settings.soundMode, hasDialogue: dialogueLines.length > 0, offscreen: offscreenRoleIds.length > 0, tuning: communityWorkflow ? tuningOfParameters(shape.props.communityParameters) : "default" }).map(message => <small className="preflight-warning" key={message}>△ {message}</small>)}
        {speakerPolicy.hasDialogue && speakerPolicy.official && <span className="creative-batch-note">{voiceRoleIds?.length ? `官方格式：正文原样提交；送 ${voiceRoleIds.length} 条角色声音（${voiceRoleIds.map((id, i) => `<Audio ${i + 1}> ${roleOptions.find((role) => role.roleId === id)?.displayName ?? id}`).join("、")}，各截前 8 秒）` : "官方格式：正文原样提交，没写 voiceRoleIds，不送角色声音"}</span>}{speakerPolicy.hasDialogue && !speakerPolicy.official && <label className="creative-batch-note"><input type="checkbox" checked={!speakerPolicy.disabled} disabled={busy || recovery.blocking} onChange={event=>update({autoVoiceDisabled:!event.target.checked})} />使用角色主声音{speakerPolicy.disabled ? ' · 已手动关闭' : dialogueLines.length ? ' · 按逐句台词配置，路人不借用角色声音' : voiceRoleId ? ` · ${roleOptions.find(role=>role.roleId===voiceRoleId)?.displayName ?? '角色'}${speakerPolicy.automatic ? '（自动选择）' : ''}` : ' · 缺少说话角色，提交前需补齐'}</label>}
        <button type="button" className="h3-submission-info-button" onClick={() => setShowSubmissionInfo(true)}><Info size={14} />生成信息 · 提交前核对</button>
        {!busy && (livePreflight.errors.length > 0 || livePreflight.warnings.length > 0) && <div className="h3-preflight" role="status"><b>生成前检查{taskMode === "ref2va" || taskMode === "hybrid" ? "（提交时按 Reference Manifest 复核）" : ""}</b>{livePreflight.errors.map((item) => <span key={item.message} className="preflight-error">✕ {item.message}</span>)}{livePreflight.warnings.map((item) => <span key={item.message} className="preflight-warning">△ {item.message}</span>)}</div>}

        <footer className="creative-dock-footer">
          <H3WorkflowPicker nodeId={shape.id} value={shape.props.workflowOptionId} disabled={busy || recovery.blocking || shape.props.workflowLock === SHOT_QUEUE_LOCK} onChange={(id) => { if (shape.props.workflowLock === SHOT_QUEUE_LOCK) return; update({ workflowOptionId: id }); }} />
          <button type="button" className="creative-settings-button" aria-expanded={settingsOpen} onClick={(event) => openSettings(event.currentTarget)} title="时长、比例、画质和声音">H3 · {settings.megapixels.toFixed(2)} MP · {duration.actualSeconds.toFixed(1)} 秒 <ChevronDown size={12} /></button>
          <button type="button" className="creative-more-settings" aria-label="专业设置" title="预设、Seed 和专业设置" onClick={(event) => openSettings(event.currentTarget, "advanced")}>⚙</button>
          <select className="creative-count-select" aria-label="生成次数" title="依次生成几个候选；批量期间保持画布打开" value={shape.props.generationCount ?? 1} disabled={busy || recovery.blocking} onChange={(event) => update({ generationCount: Number(event.target.value) })}>{Array.from({ length: 10 }, (_, i) => i + 1).map((count) => <option key={count} value={count}>{count} 次</option>)}</select>
                  <div className="generation-actions">{busy && <button type="button" className="cancel-button" onClick={() => void cancel()}><X size={14} />取消</button>}<button type="button" className="generate-button" disabled={tailHDBlocked(shape.meta) || busy || recovery.blocking || !modeEnabled || !!workflowBlockedReason(shape.props.workflowOptionId)} title={workflowBlockedReason(shape.props.workflowOptionId) ?? (taskMode && !modeEnabled ? H3_TASK_STATUS[taskMode].note : undefined)} onClick={() => void generate()}><Sparkles size={16} />{busy ? `${batchProgress ? `${batchProgress.index}/${batchProgress.count} · ` : ""}${statusLabels[status]}` : recovery.blocking && recovery.view ? recoveryPhaseLabels[recovery.view.phase] : workflowBlockedReason(shape.props.workflowOptionId) ? "工作流尚未接入" : taskMode && !modeEnabled ? "🧪 实验能力未启用" : !taskMode ? "无法生成" : (shape.props.generationCount ?? 1) > 1 ? `生成 ${shape.props.generationCount} 次` : extensionWorkflow ? (hasResult ? "重新延长" : "延长视频") : hasResult ? "重新生成" : "生成视频"}</button></div>

        </footer>
        {batchProgress && <small className="creative-batch-note">正在生成第 {batchProgress.index}/{batchProgress.count} 个候选</small>}
        {workflowBlockedReason(shape.props.workflowOptionId) && <small className="creative-workflow-warning" role="status">{workflowBlockedReason(shape.props.workflowOptionId)}</small>}
        {shape.props.seedMode === "固定" && (shape.props.generationCount ?? 1) > 1 && <small className="creative-batch-note ff-hint">固定 Seed 可能得到重复结果</small>}
        <div className="h3-panel-resize-handle" role="separator" aria-label="拖动调整提示词面板高度" aria-orientation="horizontal" tabIndex={0} title="按住向下拖动，展开提示词；向上拖动收起"
          onPointerDown={(event) => {
            event.preventDefault(); event.stopPropagation();
            if (event.button !== 0 || !promptRef.current) return;
            panelResize.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: promptRef.current.offsetHeight, zoom: Math.max(editor.getZoomLevel(), 0.01) };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            event.stopPropagation();
            const drag = panelResize.current;
            if (!drag || drag.pointerId !== event.pointerId || !promptRef.current) return;
            promptRef.current.style.height = `${Math.min(1600, Math.max(H3_PROMPT_HEIGHT, drag.startHeight + (event.clientY - drag.startY) / drag.zoom))}px`;
          }}
          onPointerUp={(event) => {
            event.stopPropagation();
            if (panelResize.current?.pointerId !== event.pointerId) return;
            panelResize.current = null;
            if (promptRef.current) update({ promptHeight: promptRef.current.offsetHeight });
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={(event) => { event.stopPropagation(); panelResize.current = null; if (promptRef.current) update({ promptHeight: promptRef.current.offsetHeight }); }}
          onLostPointerCapture={() => { panelResize.current = null; }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            update({ promptHeight: Math.min(1600, Math.max(H3_PROMPT_HEIGHT, (promptRef.current?.offsetHeight ?? H3_PROMPT_HEIGHT) + (event.key === "ArrowDown" ? 40 : -40))) });
          }}><i /></div>
      </div>
    </section>}
  </NodeShell>
  {settingsOpen && createPortal(
    <section ref={settingsPanel} className="h3-settings-panel h3-settings-popover" style={popupPosition} role="dialog" aria-label="视频参数" data-node-id={shape.id} data-settings-view={settingsView} onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={stopPropagation} onKeyDown={stopPropagation} onWheel={stopWheelPropagation}>
      <header><div className="creative-input-tabs">{[["basic", "画面"], ["references", "参考 / 角色"], ["advanced", "专业"]].map(([value, label]) => <button type="button" key={value} aria-pressed={settingsView === value} onClick={() => setSettingsView(value)}>{label}</button>)}</div><button type="button" aria-label="关闭视频参数" onClick={() => setSettingsOpen(false)}><X size={15} /></button></header>
      <div className="h3-settings-body h3-form">
                {settingsView === "advanced" && directorGuides.length > 0 && <section className="h3-common-section" data-testid="h3-guides"><div className="setting-title"><span>🧪 引导锚点（实验）</span><button type="button" className="h3-guide-remove" title="移除引导锚点，恢复普通首帧生成" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); if (shape.props.directorContext) update({ directorContext: { ...shape.props.directorContext, guides: [] } }); }}>移除</button></div>{directorGuides.map((guide) => <div key={guide.packageId} className="h3-guide-row" style={{ fontSize: 12, color: "var(--ff-text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={guide.filename}>f{guide.anchorFrame} · 约 {(guide.anchorFrame / H3_FPS).toFixed(1)} 秒 · {guide.filename}</div>)}<p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--ff-text-2)" }}>{communityWorkflow ? `终极版 / 极速版下作为 🧪 时间锚点生效（未试渲）。${H3_TIME_ANCHOR_NOTE}` : <>{H3_ADDGUIDE_NOTE}{taskMode !== "i2va" ? " 当前不是首帧图生视频，生成时会被拒绝。" : ""}</>}</p></section>}

                {settingsView === "advanced" && !communityWorkflow && !extensionWorkflow && <H3PresetBar node={shape.props} isReference={isReference} onApply={(props) => update(props)} />}
        {settingsView === "basic" && <><section className="h3-common-section"><div className="setting-title"><span>{extensionWorkflow ? "新增时长" : "生成时长"}</span><b>{formatRequestedSeconds(draftDuration.requestedSeconds)} 秒</b></div><div className="duration-control"><input type="range" min={lengthToSeconds(H3_MIN_LENGTH)} max={H3_MAX_REQUESTED_SECONDS} step="0.1" value={draftDuration.requestedSeconds} onChange={(event) => setDurationDraft(formatRequestedSeconds(Number(event.target.value)))} onPointerUp={commitDuration} onKeyUp={commitDuration} /><label><input type="number" min={lengthToSeconds(H3_MIN_LENGTH)} max={H3_MAX_REQUESTED_SECONDS} step="0.1" value={durationDraft} onChange={(event) => setDurationDraft(event.target.value)} onBlur={commitDuration} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><span>秒</span></label></div><p>实际约 {draftDuration.actualSeconds.toFixed(2)} 秒 · 已自动匹配 H3 合法帧数</p></section>
        {extensionWorkflow ? <section className="h3-common-section"><div className="setting-title"><span>画面比例</span><b>沿用原视频</b></div><p className="ff-hint">按像素预算等比例缩放，24 FPS；不修改原文件。</p></section> : <><section className="h3-common-section"><div className="setting-title"><span>画面比例</span><b>{H3_ASPECT_LABELS[aspect]}</b></div><div className="aspect-grid">{H3_ASPECTS.map((item) => <button type="button" key={item} className={aspect === item ? "active" : ""} onClick={() => update({ mode: item })}><i className={`ratio-icon ratio-${item.replace(":", "-")}`} /><span>{H3_ASPECT_LABELS[item]}</span></button>)}</div>{taskMode === "t2va" && aspect === "follow" && <p className="ff-hint">文生视频没有原图可跟随，将按 16:9 生成；也可直接选择比例。</p>}</section></>}
        <H3ResolutionPicker aspect={aspect} sourceWidth={inputFrame?.width || loadedInputDimensions?.width || 0} sourceHeight={inputFrame?.height || loadedInputDimensions?.height || 0} megapixels={settings.megapixels} multiple={settings.resolutionSteps} onChange={(megapixels) => update({ megapixels })} />
        {extensionWorkflow ? <section className="h3-common-section"><div className="setting-title"><span>声音</span><b>原视频声音上下文 + 续段音频</b></div><p>声音和音乐衔接尚未试渲，不保证无缝。</p></section> : <><section className="h3-common-section"><div className="setting-title"><span>声音模式</span><b>{settings.soundMode === "ambient" ? "仅环境音" : settings.soundMode === "silent" ? "静音" : "视听生成"}</b></div><Segmented value={settings.soundMode === "ambient" ? "仅环境音" : settings.soundMode === "silent" ? "静音" : "视听生成"} options={["视听生成", "仅环境音", "静音"]} onChange={(value) => update({ soundMode: value === "仅环境音" ? "ambient" : value === "静音" ? "silent" : "av" })} /></section></>}
        </>}
        {settingsView === "references" && <section className="h3-common-section">
          <div className={`reference-mode-status mode-${taskMode ?? "none"} ${isReference ? "is-reference" : ""}`} data-task-mode={taskMode ?? "none"}><b>{taskMode ? `当前：${taskMode === "i2va" ? "普通首帧生成" : H3_TASK_LABELS[taskMode]}` : "当前：无法生成"}</b><span>{modeDescription}</span>{taskMode && !H3_TASK_STATUS[taskMode].verified && <em className="experimental-note">{H3_TASK_STATUS[taskMode].note}</em>}</div>
          <div className="setting-title"><span>参考素材</span><b>{isReference ? "多参考生成" : "可选"}</b></div>
          <div className="reference-actions"><button data-frame-role="reference" type="button" onClick={() => {replacingReference.current=null;setCanvasReferencePicker("referenceImages");}}>+ 参考图</button>{!communityWorkflow && <><button type="button" onClick={() => {replacingReference.current=null;setCanvasReferencePicker("referenceVideos");}}>+ 参考视频</button><button type="button" onClick={() => {replacingReference.current=null;setCanvasReferencePicker("referenceAudios");}}>+ 参考声音</button></>}</div>
          {allReferenceImages.map((item, index) => <div key={item.orderKey} className="reference-sortable" draggable={!busy && !recovery.blocking} title="按住图片拖动调整顺序" onPointerDown={stopPropagation} onDragStart={(event) => { event.stopPropagation(); referenceDrag.current = item.orderKey; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-frameflow-reference", item.orderKey); }} onDragOver={(event) => { if (referenceDrag.current) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (referenceDrag.current) reorderReferenceImage(referenceDrag.current, item.orderKey); referenceDrag.current = null; }} onDragEnd={() => { referenceDrag.current = null; }}><ReferenceSlot kind="image" src={item.src} name={item.name} label={`图片 ${index + (inputFrame && !extensionWorkflow ? 2 : 1)}`} onReplace={item.nodeId ? undefined : () => replaceReference("referenceImages", item.localIndex)} onRemove={() => { if (item.nodeId) removeConnectedReference(item.nodeId); else removeReference("referenceImages", item.localIndex); }} /></div>)}

          {referenceVideos.map((item, index) => <div key={`video-${index}`}><ReferenceSlot kind="video" src={item.src} name={item.name} label={`参考视频 ${index + 1}`} onReplace={() => replaceReference("referenceVideos", index)} onRemove={() => removeReference("referenceVideos", index)} /><label className="reference-audio-toggle"><input type="checkbox" checked={Boolean(item.withAudio)} onChange={(event) => update({ referenceVideos: referenceVideos.map((candidate, at) => at === index ? { ...candidate, withAudio: event.target.checked } : candidate) })} />同时参考此视频的原声</label></div>)}
          {referenceAudios.map((item, index) => <ReferenceSlot key={`audio-${index}`} kind="audio" src={item.src} name={item.name} label={`参考声音 ${index + 1}`} onReplace={() => replaceReference("referenceAudios", index)} onRemove={() => removeReference("referenceAudios", index)} />)}
          {isReference && <p>{extensionWorkflow ? "原视频提供动作与声音上下文；额外参考图、视频和声音用于补充人物与场景，不需要首帧。" : communityKeyframeMode ? "首尾帧进入独立关键帧接口，其余图片与声音作为参考；实验模式未试渲，不保证锁帧或音色效果。" : communityWorkflow ? "最多9张外观 / 场景参考图、3条参考声音；说话角色自动提交主声音。超过4张及音色参考未试渲，不保证完全一致。" : "多参考模式：首帧作为第一参考图，不保证首帧锁定；请选择明确比例，暂不与尾帧锁定合用。参考视频需为 24 FPS、2–15 秒。"}</p>}
          {isReference && inputFrame && !communityWorkflow && !extensionWorkflow && <label className="reference-audio-toggle hybrid-toggle"><input type="checkbox" checked={hybridLock} onChange={(event) => update({ hybridLock: event.target.checked })} />🧪 Hybrid：精确锁定首帧 + 角色参考（实验能力｜当前后端尚未启用）</label>}
          <div className="setting-title"><span>角色</span><b>{roleIds.length ? `${roleIds.length} 个` : "可选"}</b></div>
          <select className="role-add-select" value="" onFocus={refreshRoles} onPointerDown={refreshRoles} onChange={(event) => { const roleId = event.target.value; if (roleId && !roleIds.includes(roleId)) update({ roleIds: [...roleIds, roleId] }); }}>
            <option value="">+ 角色</option>
            {roleOptions.filter((role) => !roleIds.includes(role.roleId)).map((role) => <option key={role.roleId} value={role.roleId}>{role.displayName}</option>)}
          </select>
          {communityWorkflow && <small className="creative-batch-note ff-hint">音色参考实验：角色外观计入最多9张图，指定说话角色或有台词的角色主声音计入最多3条声音；未试渲，不保证音色完全一致。</small>}
          {roleIds.map((roleId, index) => <RoleBindingChip key={`${roleId}-${communityWorkflow}`} role={roleOptions.find((role) => role.roleId === roleId) ?? null} order={index + 1} offscreen={offscreenRoleIds.includes(roleId)} speaking={!speakerPolicy.disabled && (voiceRoleId === roleId || Boolean(voiceRoleIds?.includes(roleId)) || dialogueLines.some((line) => line.roleId === roleId))} onRemove={() => update({ roleIds: roleIds.filter((id) => id !== roleId), offscreenRoleIds: offscreenRoleIds.filter(id => id !== roleId), voiceRoleId: shape.props.voiceRoleId === roleId ? undefined : shape.props.voiceRoleId, ...(shape.props.voiceRoleIds?.includes(roleId) ? { voiceRoleIds: shape.props.voiceRoleIds.filter(id => id !== roleId) } : {}), dialogueLines: dialogueLines.filter(line => line.roleId !== roleId) })} />)}
          {roleIds.map(id => <label key={id} style={{display:"block"}}><input type="checkbox" disabled={busy || recovery.blocking} checked={offscreenRoleIds.includes(id)} onChange={event => update({offscreenRoleIds:event.target.checked ? [...offscreenRoleIds,id] : offscreenRoleIds.filter(value=>value!==id)})} />{roleOptions.find(role=>role.roleId===id)?.displayName ?? id} 仅画外音（不提交外观图）</label>)}
          {shape.props.roleSnapshot && <small className="creative-batch-note">重渲已固定上次角色绑定；上方角色库资料可能已更新，实际使用的图片与声音以“生成信息”为准。</small>}
          <button type="button" disabled={busy || recovery.blocking} onClick={() => { update({roleSnapshot:undefined}); refreshRoles(); }}>重新读取角色库的外观 / 声音</button>
          <small className="ff-hint">重渲默认沿用上次角色素材；切换角色或点击上方按钮才重新读取角色库。参考图和像素设置保留，除非你手动修改。</small>
          <label><input type="checkbox" disabled={busy || recovery.blocking} checked={shape.props.noBackgroundMusic ?? false} onChange={event=>update({noBackgroundMusic:event.target.checked})} />禁止背景音乐（提示词约束，需试听确认）{isOfficialFormat(shape.props.prompt) ? `｜${OFFICIAL_MUSIC_NOTE}，勾着也原样提交` : ""}</label>
          <label title="出片完成后自动排一次去配乐（CDX23，只留台词和音效）。结果是新版本，原声版保留。只影响之后的出片"><input type="checkbox" disabled={busy || recovery.blocking} checked={shape.props.autoRemoveMusic ?? true} onChange={event=>update({autoRemoveMusic:event.target.checked})} />出片后自动去配乐</label>
          {roleIds.length > 0 && <>
            <label className="setting-title" htmlFor={`voice-role-${shape.id}`}>提示词中的说话角色</label>
            <select id={`voice-role-${shape.id}`} className="role-add-select" value={speakerPolicy.disabled ? "__off" : shape.props.voiceRoleId || ""} disabled={busy || recovery.blocking} onFocus={refreshRoles} onChange={event => update({ voiceRoleId: event.target.value === "__off" ? undefined : event.target.value, autoVoiceDisabled: event.target.value === "__off" })}>
              <option value="">自动：有台词时使用第一个角色主声音{autoVoiceEnabled ? "" : "（全局已关闭）"}</option><option value="__off">本节点关闭角色主声音（明确不使用参考音色）</option>
              {voiceRoleId && !roleIds.includes(voiceRoleId) && <option value={voiceRoleId}>角色已移除，请重新选择</option>}
              {roleIds.map(id => <option key={id} value={id}>{roleOptions.find(role => role.roleId === id)?.displayName ?? "已删除角色"} · 提交主声音</option>)}
            </select>
            <p>{speakerPolicy.disabled ? "本节点已明确关闭角色主声音。" : speakerPolicy.automatic ? `已自动选择：${roleOptions.find(role=>role.roleId===voiceRoleId)?.displayName ?? "第一个角色"} · 主声音（提交前核对 Audio 编号）` : "台词写在提示词中即可；没有台词时不自动附加声音。"}</p>
            <div className="setting-title"><span>台词</span><b>{dialogueLines.length ? `${dialogueLines.length} 条` : "无"}</b></div>
            {dialogueLines.map((line, index) => <div className="dialogue-line" key={index}>
              <select value={roleIds.includes(line.roleId) ? line.roleId : ""} onChange={(event) => update({ dialogueLines: dialogueLines.map((item, at) => at === index ? event.target.value ? { roleId: event.target.value, text:item.text } : {roleId:'',speaker:item.speaker || roleOptions.find(role=>role.roleId===item.roleId)?.displayName || '说话者',voice:'none',text:item.text} : item) })}>
                <option value="">{line.voice?.startsWith('audio:') ? `${line.speaker} · 声音素材` : '模型自出声（不使用参考声音）'}</option>
                {roleIds.map((roleId) => <option key={roleId} value={roleId}>{roleOptions.find((role) => role.roleId === roleId)?.displayName ?? "已删除的角色"}</option>)}
              </select>
              {!line.roleId && <input aria-label={`第${index+1}句说话者名称`} placeholder="说话者名称" value={line.speaker??''} onChange={event=>update({dialogueLines:dialogueLines.map((item,at)=>at===index?{...item,speaker:event.target.value}:item)})} />}
              <textarea value={line.text} placeholder="台词原文" rows={2} onChange={(event) => update({ dialogueLines: dialogueLines.map((item, at) => at === index ? { ...item, text: event.target.value } : item) })} />
              <button type="button" title="删除台词" aria-label="删除台词" onClick={() => update({ dialogueLines: dialogueLines.filter((_, at) => at !== index) })}><X size={13} /></button>
            </div>)}
            <div className="reference-actions dialogue-actions"><button type="button" onClick={() => update({ dialogueLines: [...dialogueLines, { roleId: roleIds[0], text: "" }] })}>+ 添加台词</button></div>
            <p className="ff-hint">可选：分角色填写台词；已在提示词中写好的对白无需重复填写，只需在上方指定说话角色。</p>
          </>}
          {isReference && <>
            <div className="setting-title"><span>Prompt 模式</span><b>{promptMode === "official_structured" ? "🧪 官方结构" : "普通"}</b></div>
            <Segmented value={promptMode === "official_structured" ? "🧪 官方结构 Prompt" : "普通 Prompt"} options={["普通 Prompt", "🧪 官方结构 Prompt"]} onChange={(value) => update({ promptMode: value === "普通 Prompt" ? "plain" : "official_structured" })} />
            {promptMode === "official_structured" ? <p className="experimental-note">🧪 官方结构 Prompt｜{OFFICIAL_MODE_WARNING}</p> : <p className="ff-hint">普通 Prompt：保留原提示词，并自动提交角色台词、外观与声音绑定。中文台词按普通话要求提交；对白效果待真人试听，不保证逐字准确。</p>}
          </>}
        </section>
        }
        {settingsView === "advanced" && <><div className="reference-actions"><button type="button" disabled={busy||recovery.blocking||!displayedAssetId} onClick={()=>void lockCurrent()}>锁定当前满意版本</button>{shape.props.lockedRunId&&<><button type="button" disabled={busy||recovery.blocking} onClick={()=>void replayLocked()}>按锁定快照重渲</button><button type="button" disabled={busy||recovery.blocking} onClick={()=>update({lockedRunId:"",lockedAssetId:""})}>解除锁定</button></>}<button type="button" disabled={busy||!displayedAssetId} onClick={()=>void upscaleLocked()}>原片高清 · 不重抽</button><small className="ff-hint">锁定重渲忽略当前表单改动；提升原生像素不是无损复刻，正式片一致优先选原片高清。旧候选无完整快照时不能锁定。</small></div><section className="h3-common-section seed-section"><div className="setting-title"><span>Seed</span><b>{shape.props.seedMode}</b></div><Segmented value={shape.props.seedMode} options={["随机", "固定"]} onChange={(seedMode) => update({ seedMode })} />{shape.props.seedMode === "固定" && <input className="seed-input" inputMode="numeric" value={shape.props.seed} placeholder="输入非负整数" onChange={(event) => update({ seed: event.target.value.replace(/\D/g, "") })} />}</section>
        <div className={`advanced-settings ${advancedOpen ? "open" : ""}`}>
          <button type="button" className="advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>专业参数 <span>真实写入 ComfyUI</span><ChevronDown size={13} /></button>
          {advancedOpen && <div className="advanced-content professional-grid">
            {communityWorkflow ? <><label><span>实际 Steps（由时间表决定）</span><input value={effectiveSteps} readOnly /></label><H3CommunityParameters id={shape.props.workflowOptionId as 'community-ultimate'|'community-dialogue'} value={shape.props.communityParameters} onChange={communityParameters=>update({communityParameters})} onMegapixels={megapixels=>update({megapixels})} disabled={busy || recovery.blocking}/></> : <>
            <label><span>Turbo</span><Segmented value={settings.turbo ? "开启" : "关闭"} options={["开启", "关闭"]} onChange={(value) => update({ turbo: value === "开启", steps: value === "开启" ? H3_STEPS : H3_NON_TURBO_STEPS })} /></label>
            <label><span>实际 Steps</span><input value={effectiveSteps} readOnly /></label>
            <label><span>{communityWorkflow ? "DMAD LoRA 强度" : "Turbo LoRA 强度"}</span><input type="number" value={settings.loraStrength} readOnly /></label>
            <label><span>输出 FPS</span><input type="number" value={isReference ? 24 : settings.fps} readOnly /></label>
            <label><span>图片缩放</span><input value={extensionWorkflow ? "按原视频比例缩放" : settings.upscaleMethod} readOnly /></label>
            <label><span>分辨率步进</span><input type="number" value={extensionWorkflow ? 32 : settings.resolutionSteps} readOnly /></label>
            </>}
            <details className="execution-info"><summary>真实执行信息 / 调试</summary><dl>
              <dt>工作流</dt><dd>{extensionWorkflow ? "视频延长 · Extender 3.0.8（未试渲）" : communityWorkflow ? workflowOption(shape.props.workflowOptionId)?.label : taskMode === "t2va" ? "T2VA（h3-t2va-workflow.json · 同 FL2VA 模型）" : taskMode === "hybrid" ? "🧪 Hybrid（后端未启用）" : isReference ? "Ref2VA" : "FL2VA"}</dd>
              <dt>基础模型</dt><dd>{communityWorkflow ? "minimax_h3_hybrid_int8_convrot.safetensors" : isReference ? "minimax_h3_ref2va_pruned_int8_convrot.safetensors" : "minimax_h3_fl2va_pruned_int8_convrot.safetensors"}</dd>
              <dt>Text Encoder</dt><dd>{communityWorkflow ? "qwen3vl_32b_minimax_h3_int8_convrot.safetensors" : "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"}</dd>
              <dt>LoRA</dt><dd>{communityWorkflow ? "minimax_h3_DMAD_4step_full_lora_avg_rank_39_bf16.safetensors" : isReference ? "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors" : "minimax_h3_turbo_v4_step600_ema.safetensors"}</dd>
              <dt>加速 / 强度</dt><dd>{communityWorkflow ? "DMAD + sol-attn" : settings.turbo ? "ON" : "OFF"} / {communityWorkflow ? settings.loraStrength : isReference ? "1.0" : settings.loraStrength}</dd>
              <dt>Steps / Sampler</dt><dd>{effectiveSteps} / {communityWorkflow ? String(parseCommunityValues(settings.communityParameters)['123.sampler_name'] ?? 'er_sde') : "res_multistep"}</dd>
              <dt>Seed</dt><dd>{shape.props.lastSubmittedSeed ?? (shape.props.seedMode === "固定" ? shape.props.seed : "生成时随机")}</dd>
              <dt>画面</dt><dd>{modeDimensions ? `${modeDimensions.width} × ${modeDimensions.height}` : "等待图片尺寸"} · {settings.megapixels.toFixed(2)}MP</dd>
              <dt>视频</dt><dd>{communityWorkflow ? Number(parseCommunityValues(settings.communityParameters)['148.frame_rate'] ?? 24) : 24} FPS · {duration.length} 帧 · 约 {(duration.length / (communityWorkflow ? Number(parseCommunityValues(settings.communityParameters)['148.frame_rate'] ?? 24) : 24)).toFixed(2)} 秒</dd>
              <dt>声音模式</dt><dd>{settings.soundMode === "ambient" ? "仅环境音" : settings.soundMode === "silent" ? "静音" : "视听生成"}</dd>
              <dt>用户原始 Prompt</dt><dd>{shape.props.prompt || "—"}</dd>
              <dt>最终提交 Prompt</dt><dd>{shape.props.lastSubmittedPrompt ?? effectivePrompt}</dd>
            </dl></details>
          </div>}
        </div></>}

      </div>
    </section>
  , document.body)}
  {showCandidates && shot && createPortal(<ShotCandidatesPanel shotId={shot.shotId} editor={editor} onClose={() => setShowCandidates(false)} />, document.body)}
  {showSubmissionInfo && createPortal(<H3SubmissionInfo spec={submissionReviewSpec()} zhengbenVersion={shape.props.zhengbenVersion} onClose={() => setShowSubmissionInfo(false)} />, document.body)}
  {showInheritedInfo && inheritedAsset && createPortal(<GenerationInfo runId={inheritedAsset.sourceRunId ?? undefined} assetId={inheritedAsset.assetId} fallbackName={inheritedAsset.filename} onClose={() => setShowInheritedInfo(false)} />, document.body)}
  {(framePicker||canvasReferencePicker)&&<CanvasMediaPicker ownerNodeId={shape.id} items={canvasMedia.filter(item=>item.kind===(framePicker||canvasReferencePicker==="referenceImages"?"image":canvasReferencePicker==="referenceAudios"?"audio":"video"))} title={framePicker==="first"?"选择画布首帧":framePicker==="last"?"选择画布尾帧":canvasReferencePicker==="referenceAudios"?"选择画布声音":"选择画布参考素材"} onChoose={id=>chooseCanvasMedia(id,framePicker??canvasReferencePicker!)} onClose={returnFromCanvasPicker}/>}</HTMLContainer>;
}

class VideoNodeUtil extends BaseBoxShapeUtil<VideoNode> {
  override onTranslateStart(shape: VideoNode) { startMediaMagnet(this.editor, shape); }
  override onTranslate(_initial: VideoNode, current: VideoNode) { return translateMediaMagnet(this.editor, current); }
  override onTranslateEnd() { endMediaMagnet(this.editor); }
  override onTranslateCancel() { endMediaMagnet(this.editor); }
  static override type = "video-node" as const;
  static override props = { w: T.number, h: T.number, src: T.string, name: T.string, size: T.string, duration: T.string, originalPath: T.string, sceneNumber: T.optional(T.number), fps: T.optional(T.number), origin: T.optional(T.string), assetId: T.optional(T.string), runId: T.optional(T.string), shotId: T.optional(T.string) };
  override getDefaultProps(): VideoNode["props"] { return { w: VIDEO_NODE_WIDTH, h: VIDEO_NODE_HEIGHT, src: "", name: "等待载入视频", size: "—", duration: "—", originalPath: "", sceneNumber: undefined }; }
  override component(shape: VideoNode) { return <CulledShape editor={this.editor} shapeId={shape.id}><VideoNodeContent shape={shape} editor={this.editor} /></CulledShape>; }
  override getIndicatorPath(shape: VideoNode): Path2D { const path = new Path2D(); path.rect(0, 0, shape.props.w, shape.props.h); return path; }
}

function VideoNodeContent({ shape, editor }: { shape: VideoNode; editor: Editor }) {
  const [playing, setPlaying] = useState(false);
  const [playRequested, setPlayRequested] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => { queueMicrotask(() => setPlayRequested(false)); }, [shape.props.src]);
  useEffect(() => { queueMicrotask(() => setPlaying(false)); }, [shape.props.src]);
  // Same as the H3 preview: only the native control bar keeps the pointer; pressing the picture lets tldraw select / drag the node.
  const gesture = useRef<{ x: number; y: number; controls: boolean } | null>(null);
  const videoPointerDown = (event: React.PointerEvent<HTMLVideoElement>) => {
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const scale = element.offsetHeight ? rect.height / element.offsetHeight : 1;
    const controls = event.clientY > rect.bottom - NATIVE_VIDEO_CONTROLS_BAND * scale;
    gesture.current = { x: event.clientX, y: event.clientY, controls };
    if (controls) event.stopPropagation();
  };
  const videoPointerUp = (event: React.PointerEvent) => { if (gesture.current?.controls) event.stopPropagation(); };
  const videoClick = (event: React.MouseEvent) => {
    const start = gesture.current;
    event.stopPropagation();
    if (start?.controls) return;
    event.preventDefault();
    // A drag that ends on the picture must not also toggle play / pause.
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    editor.select(shape.id);
    const video = videoRef.current;
    if (video) {
      setPlayRequested(false);
      if (!video.paused && !video.ended) video.pause();
      else void video.play().catch(() => showCanvasToast("请再次点击播放"));
    }
  };
  const near = useMediaActive(editor, shape.id);
  const selected = useValue("video selected", () => editor.getSelectedShapeIds().includes(shape.id), [editor,shape.id]);
  const cached = useVideoPoster(shape.props.src);
  const mediaActive = useVideoActive(near && (playing || playRequested), playing || playRequested, playing && near, shape.props.src);
  useEffect(() => { if (!near) queueMicrotask(() => { setPlaying(false); setPlayRequested(false); }); }, [near]);
  const playableUrl = useAcquiredMediaUrl(shape.props.src, mediaActive);
  useEffect(() => {
    const video = videoRef.current;
    return () => { if (!video) return; video.pause(); video.removeAttribute("src"); video.load(); };
  }, [playableUrl]);
  const [decodedPoster, setDecodedPoster] = useState<{ source: string; url: string } | null>(null);
  const poster = decodedPoster?.source === shape.props.src ? decodedPoster.url : cached.poster;
  const updatePoster = (video: HTMLVideoElement) => {
    const url = capturePoster(shape.props.src, video);
    if (url) setDecodedPoster((current) => current?.source === shape.props.src && current.url === url ? current : { source: shape.props.src, url });
  };
  const [revision, setRevision] = useState(0);
  const controlsRequested = useRef(false);
  useEffect(() => {
    if (!selected || controlsRequested.current || shape.props.origin === "rough") return;
    controlsRequested.current = true;
    void restoreDerivedVideoControls(editor, shape.id).catch(cause => {
      controlsRequested.current = false;
      showCanvasToast(cause instanceof Error ? cause.message : "视频参数恢复失败");
    });
  }, [editor, selected, shape.id, shape.props.origin]);
  const [showInfo, setShowInfo] = useState(false);
  const [showCandidates, setShowCandidates] = useState(false);
  const [showExtract, setShowExtract] = useState(false);
  const [shotDetail, setShotDetail] = useState<{ shot: ShotRecord; label: string | null } | null>(null);
  const [assetOrigin, setAssetOrigin] = useState<AssetOrigin | null>(null);
  useEffect(() => subscribeLinkedContent(editor, shape.id, () => setRevision((value) => value + 1)), [editor, shape.id]);
  const sceneNumber = useMemo(() => inferVideoSceneNumber(editor, shape), [editor, shape, revision]);
  useEffect(() => { if (!shape.props.src || shape.props.src.startsWith("data:")) return; let active = true; void (async () => { const current = shape.props.assetId ? await getAsset(shape.props.assetId) : null; if (current?.storageReference === shape.props.src) return; const asset = await assetForSource(shape.props.src, "video", shape.props.name, { duration: durationSeconds(shape.props.duration), fps: shape.props.fps }); if (active && editor.getShape(shape.id)?.type === "video-node") editor.updateShape({ id: shape.id, type: "video-node", props: { assetId: asset.assetId } }); })().catch((cause) => showCanvasToast(cause instanceof Error ? cause.message : "旧视频资产登记失败")); return () => { active = false; }; }, [editor, shape.id, shape.props.src, shape.props.name, shape.props.assetId, shape.props.duration, shape.props.fps]);
  useEffect(() => { let active = true; if (!shape.props.assetId) return; void getAsset(shape.props.assetId).then((asset) => { if (active) setAssetOrigin(asset?.origin ?? null); }).catch((cause) => showCanvasToast(cause instanceof Error ? cause.message : "无法读取媒体信息")); return () => { active = false; }; }, [shape.props.assetId]);
  useEffect(() => { let active = true; const refresh = () => { if (!shape.props.shotId || !shape.props.assetId) return; void Promise.all([getShot(shape.props.shotId), getRootCandidateLabel(shape.props.shotId, shape.props.assetId)]).then(([shot, label]) => { if (active) setShotDetail(shot ? { shot, label } : null); }).catch(() => {}); }; refresh(); window.addEventListener("frameflow-shot-changed", refresh); return () => { active = false; window.removeEventListener("frameflow-shot-changed", refresh); }; }, [shape.props.shotId, shape.props.assetId]);
  const upstream = useMemo(() => getIncomingSource(editor, shape.id), [editor, shape.id, revision]);
  const hasProvenance = Boolean(shape.props.runId || assetOrigin === "unknown" && upstream && ["h3-node", "upscale-node", "smooth-node"].includes(upstream.type));
  const eyebrow = shotDetail ? `视频 · ${shotName(shotDetail.shot)} · 候选${shotDetail.label ?? "—"}${shotDetail.shot.adoptedAssetId === shape.props.assetId ? " ★" : ""}` : shape.props.origin === "rough" ? "粗剪成片" : shape.props.origin === "smooth" ? "视频 · 流畅增强" : sceneNumber ? `视频 · 镜头${String(sceneNumber).padStart(2, "0")}` : "视频";
  return <HTMLContainer className="node-container interactive-node node-minimal"><NodeShell nodeId={shape.id} preview={{src:shape.props.src,kind:"video"}} inputPort={<WorkflowPort editor={editor} shape={shape} side="left" onClick={() => { const upstream = getIncomingSource(editor, shape.id, "h3-node"); if (upstream) editor.select(upstream.id); else showCanvasToast("这是导入视频，可将左侧加号拖到已有视频节点，为它添加尾帧"); }} />} icon={<Video size={17} />} eyebrow={eyebrow} title={shape.props.name} accent="#858585" onDownload={() => downloadNodeMedia(shape.props.src, shape.props.name, "video")} onInput={() => { const arrow = editor.getCurrentPageShapes().find(a => a.type === "arrow" && getArrowBindings(editor, a as TLArrowShape).end?.toId === shape.id); const upstream = arrow && getArrowBindings(editor, arrow as TLArrowShape).start?.toId; if (upstream) editor.select(upstream); else showCanvasToast("这是导入的视频，可从右侧加号继续制作"); }} onDelete={() => deleteNodeWithHistory(editor, shape.id)} actions={<><DemixNodeControl editor={editor} shapeId={shape.id} assetId={shape.props.assetId} /><AuditBadge assetId={shape.props.assetId}/>{shape.props.assetId && <button type="button" className="node-header-button" title="血缘查看" aria-label="血缘查看" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); openLineage(shape.props.assetId!); }}><GitBranch size={13} /></button>}<button type="button" className="node-header-button" title="提取声音" aria-label="提取声音" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); setShowExtract(true); }}><Mic2 size={13} /></button>{shotDetail && <button type="button" className="node-header-button" title="候选结果" aria-label="候选结果" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); setShowCandidates(true); }}><Film size={13} /></button>}{hasProvenance && <button type="button" className="node-header-button" title="生成信息" aria-label="生成信息" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); setShowInfo(true); }}><Info size={13} /></button>}</>} outputPort={<WorkflowPort editor={editor} shape={shape} />}><div className="video-stage" onContextMenu={()=>{if(editor.getSelectedShapeIds().length<2)editor.select(shape.id);}} onClick={() => editor.select(shape.id)}>{!mediaActive ? <div className="video-empty video-poster">{poster && near ? <img src={poster} alt="" draggable={false} /> : <Video size={24} />}</div> : playableUrl ? <video ref={videoRef} key={playableUrl} src={playableUrl} poster={poster}  controls playsInline preload="metadata" draggable={false} onPointerDown={videoPointerDown} onPointerUp={videoPointerUp} onClick={videoClick} onPlay={() => { setPlayRequested(false); setPlaying(true); }} onPause={event => { rememberVideoPosition(shape.id+shape.props.src,event.currentTarget); setPlaying(false); setPlayRequested(false); }} onEnded={() => { clearVideoPosition(shape.id+shape.props.src); setPlaying(false); setPlayRequested(false); }} onLoadedData={(event) => { preparePosterFrame(event.currentTarget); updatePoster(event.currentTarget); if(playRequested && selected) void event.currentTarget.play().catch(()=>setPlayRequested(false)); }} onSeeked={(event) => updatePoster(event.currentTarget)} onTimeUpdate={event => { rememberVideoPosition(shape.id+shape.props.src,event.currentTarget); pauseVideoOutsideViewport(event.currentTarget); }} onLoadedMetadata={(event) => { restoreVideoPosition(shape.id+shape.props.src,event.currentTarget); preparePosterFrame(event.currentTarget); if (shape.props.w !== VIDEO_NODE_WIDTH || shape.props.h !== VIDEO_NODE_HEIGHT) return; const video = event.currentTarget; if (!video.videoWidth || !video.videoHeight) return; const fitted = fittedVideoSize(editor, video.videoWidth, video.videoHeight); if (fitted.w !== shape.props.w || fitted.h !== shape.props.h) editor.updateShape({ id: shape.id, type: "video-node", y: shape.y + (shape.props.h - fitted.h) / 2, props: fitted }); }} /> : <div className="video-empty"><Video size={24} /><span>正在恢复本地视频…</span></div>}<button type="button" className="canvas-video-play" aria-label={playing ? "暂停视频" : "播放视频"} onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={event => { event.stopPropagation(); editor.select(shape.id); if (playing) { videoRef.current?.pause(); setPlayRequested(false); } else { setPlayRequested(true); void videoRef.current?.play().catch(() => showCanvasToast("请再次点击播放")); } }}>{playing ? "暂停" : "播放"}</button></div><div className="video-meta"><span>{shape.props.duration}</span><i /><span>{shape.props.size}</span><i /><span>{shape.props.fps ? `${formatFps(shape.props.fps)} FPS` : "MP4"}</span><b title={shape.props.name}>{shape.props.name}</b></div></NodeShell>{showInfo && createPortal(<GenerationInfo runId={shape.props.runId} assetId={shape.props.assetId} fallbackName={shape.props.name} onClose={() => setShowInfo(false)} />, document.body)}{showCandidates && shotDetail && createPortal(<ShotCandidatesPanel shotId={shotDetail.shot.shotId} editor={editor} onClose={() => setShowCandidates(false)} />, document.body)}{showExtract && createPortal(<AudioExtractPanel editor={editor} video={shape} onClose={() => setShowExtract(false)} />, document.body)}</HTMLContainer>;
}

function AudioExtractPanel({ editor, video, onClose }: { editor: Editor; video: VideoNode; onClose: () => void }) {
  const [probe, setProbe] = useState<AudioProbe | null>(null);
  const [mode, setMode] = useState<"whole" | "clip">("whole");
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { let active = true; void getLocalVideoBlob(video.props.src).then(probeVideoAudio).then((result) => { if (active) { setProbe(result); setEnd(result.duration.toFixed(2)); if (!result.hasAudio) setError("这个视频没有可提取的声音"); } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "音轨检测失败"); }); return () => { active = false; }; }, [video.props.src]);
  const extract = async () => {
    if (working || !probe?.hasAudio) return;
    const first = Number(start); const last = Number(end);
    if (mode === "clip" && (!Number.isFinite(first) || !Number.isFinite(last) || first < 0 || last <= first || last > probe.duration + .02)) { setError(`截取时间需在 0–${probe.duration.toFixed(2)} 秒之间，且结束晚于开始`); return; }
    setWorking(true); setError("");
    try {
      const source = await assetForSource(video.props.src, "video", video.props.name, { duration: probe.duration });
      const { blob, duration } = await extractVideoAudio(await getLocalVideoBlob(video.props.src), mode === "clip" ? { start: first, end: last } : undefined);
      const filename = `${video.props.name.replace(/\.mp4$/i, "")}${mode === "clip" ? `_${first.toFixed(1)}-${last.toFixed(1)}` : ""}_声音.wav`;
      const src = await storeLocalAudio(blob, filename);
      const asset = await registerAsset({ kind: "audio", origin: "generated", filename, mimeType: "audio/wav", storageReference: src, sourceRunId: null, fileSize: blob.size, duration, derivationType: "audio_extract", sourceVideoAssetId: source.assetId, sourceStartTime: mode === "clip" ? first : 0, sourceEndTime: mode === "clip" ? last : probe.duration });
      const id = createShapeId();
      editor.createShape({ id, type: "audio-node", x: video.x + video.props.w + 120, y: video.y + Math.max(0, (video.props.h - 155) / 2), props: { w: 330, h: 155, src, name: filename, duration, assetId: asset.assetId, sourceVideoAssetId: source.assetId } });
      const audio = editor.getShape(id);
      if (audio?.type === "audio-node") createBoundArrow(editor, video, audio);
      showCanvasToast("声音已提取；可在声音节点加入角色"); onClose();
    } catch (cause) { const detail = cause instanceof Error ? cause.message : "提取声音失败"; setError(detail); void logEvent({ level: "error", category: categorize(detail, "audio"), title: "提取声音失败", detail, nodeId: video.id }); } finally { setWorking(false); }
  };
  return <div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget && !working) onClose(); }}>
    <section className="generation-info-panel audio-extract-panel" role="dialog" aria-modal="true" aria-label="提取声音" onPointerDown={stopPropagation} onClick={stopPropagation}>
      <header><div><small>本地音轨处理 · PyAV</small><h2>提取声音</h2></div><button type="button" aria-label="关闭" disabled={working} onClick={onClose}><X size={17} /></button></header>
      <div className="audio-extract-body"><p title={video.props.name}>来源：{video.props.name}</p><p>{probe ? probe.hasAudio ? `有音轨 · ${probe.audioCodec} · ${probe.duration.toFixed(2)} 秒` : "没有音轨" : error ? "检测失败" : "正在检测音轨…"}</p>
        <div className="audio-mode"><button type="button" className={mode === "whole" ? "active" : ""} onClick={() => setMode("whole")}>整段</button><button type="button" className={mode === "clip" ? "active" : ""} onClick={() => setMode("clip")}>截取片段</button></div>
        {mode === "clip" && <div className="audio-range"><label>开始（秒）<input type="number" min="0" max={probe?.duration} step="0.1" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>结束（秒）<input type="number" min="0" max={probe?.duration} step="0.1" value={end} onChange={(event) => setEnd(event.target.value)} /></label></div>}
        <small className="ff-hint">输出 WAV · 48 kHz · 单声道 · PCM 16-bit</small><small className="ff-hint">作为角色声音时，建议截取单一角色、没有其他对白或明显背景音乐的干净片段。</small>{error && <p className="role-error" role="alert">{error}</p>}
        <button type="button" className="generate-button" disabled={working || !probe?.hasAudio} onClick={() => void extract()}>{working ? "正在提取…" : mode === "whole" ? "提取整段声音" : "截取并创建声音节点"}</button>
      </div>
    </section>
  </div>;
}

class AudioNodeUtil extends BaseBoxShapeUtil<AudioNode> {
  static override type = "audio-node" as const;
  static override props = { w: T.number, h: T.number, src: T.string, name: T.string, duration: T.number, assetId: T.string, sourceVideoAssetId: T.optional(T.string), sourceAudioAssetId: T.optional(T.string), trimOpen: T.optional(T.boolean) };
  override getDefaultProps(): AudioNode["props"] { return { w: 330, h: 155, src: "", name: "声音", duration: 0, assetId: "", trimOpen: false }; }
  override component(shape: AudioNode) { return <CulledShape editor={this.editor} shapeId={shape.id}><AudioNodeContent shape={shape} editor={this.editor} /></CulledShape>; }
  override getIndicatorPath(shape: AudioNode): Path2D { const path = new Path2D(); path.rect(0, 0, shape.props.w, shape.props.h); return path; }
}

function AudioNodeContent({ shape, editor }: { shape: AudioNode; editor: Editor }) {
  const [showRoles, setShowRoles] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const trimOpen = Boolean(shape.props.trimOpen);
  const url = useAcquiredMediaUrl(shape.props.src, useMediaActive(editor, shape.id, { playing, keepAlive: trimOpen }));
  const toggleTrim = () => editor.updateShape({ id: shape.id, type: "audio-node", props: { trimOpen: !trimOpen, h: trimOpen ? 155 : Math.max(shape.props.h, 320) } });
  return <HTMLContainer className="node-container interactive-node"><NodeShell icon={<Mic2 size={17} />} eyebrow={shape.props.sourceAudioAssetId ? "声音 · 裁剪片段" : shape.props.sourceVideoAssetId ? "声音 · 视频提取" : "声音"} title={shape.props.name} accent="#858585" onDownload={() => downloadNodeMedia(shape.props.src, shape.props.name, "audio")} onDelete={() => deleteNodeWithHistory(editor, shape.id)} actions={<>{shape.props.assetId && <button type="button" className="node-header-button" title="血缘查看" aria-label="血缘查看" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); openLineage(shape.props.assetId); }}><GitBranch size={13} /></button>}<button type="button" className="node-header-button" title="加入角色" aria-label="加入角色" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); setShowRoles(true); }}><Users size={13} /></button></>}><div className={`audio-node-body ${trimOpen ? "is-trimming" : ""}`}><audio ref={audioRef} controls src={url || undefined} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={stopPropagation} onContextMenu={stopPropagation} /><div className="audio-node-summary"><span>{shape.props.duration.toFixed(2)} 秒 · {shape.props.name.split(".").at(-1)?.toUpperCase() || "音频"}</span><button type="button" onPointerDown={stopPropagation} onClick={(event) => { event.stopPropagation(); toggleTrim(); }} aria-expanded={trimOpen}>{trimOpen ? "收起裁剪" : "裁剪声音"}</button></div>{trimOpen && <AudioTrimPanel shape={shape} editor={editor} audioRef={audioRef} />}</div></NodeShell>{showRoles && createPortal(<AudioRolePanel assetId={shape.props.assetId} onClose={() => setShowRoles(false)} />, document.body)}</HTMLContainer>;
}

function AudioTrimPanel({ shape, editor, audioRef }: { shape: AudioNode; editor: Editor; audioRef: React.RefObject<HTMLAudioElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"start" | "end" | null>(null);
  const previewing = useRef(false);
  const previewEnd = useRef(0);
  const previewFrame = useRef<number>(0);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [range, setRange] = useState({ start: 0, end: shape.props.duration });
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const context = new AudioContext();
    void getLocalAudioBlob(shape.props.src).then((blob) => blob.arrayBuffer()).then((bytes) => context.decodeAudioData(bytes)).then((buffer) => {
      if (!active) return;
      setPeaks(calculateWaveformPeaks(Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))));
    }).catch((cause) => { if (active) setError(cause instanceof Error ? `无法生成波形：${cause.message}` : "无法生成波形"); });
    return () => { active = false; void context.close(); };
  }, [shape.props.src]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks.length) return;
    const width = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
    const height = 64;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const first = shape.props.duration > 0 ? range.start / shape.props.duration : 0;
    const last = shape.props.duration > 0 ? range.end / shape.props.duration : 0;
    const step = width / peaks.length;
    for (let index = 0; index < peaks.length; index++) {
      const amplitude = Math.max(2, peaks[index] * (height - 8));
      context.fillStyle = index / peaks.length >= first && index / peaks.length <= last ? "#8fb89c" : "#6d6d6d";
      context.fillRect(Math.round(index * step), (height - amplitude) / 2, Math.max(1, step * .68), amplitude);
    }
  }, [peaks, range, shape.props.duration, shape.props.w]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPause = () => { previewing.current = false; if (previewFrame.current) cancelAnimationFrame(previewFrame.current); setIsPreviewing(false); };
    const onTimeUpdate = () => { if (previewing.current && audio.currentTime >= previewEnd.current - .015) { audio.pause(); audio.currentTime = previewEnd.current; } };
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    return () => { audio.removeEventListener("pause", onPause); audio.removeEventListener("timeupdate", onTimeUpdate); if (previewFrame.current) cancelAnimationFrame(previewFrame.current); if (previewing.current) audio.pause(); };
  }, [audioRef]);
  const stopPreview = () => { previewing.current = false; if (previewFrame.current) cancelAnimationFrame(previewFrame.current); audioRef.current?.pause(); setIsPreviewing(false); };
  const audition = async () => {
    if (previewing.current) { stopPreview(); return; }
    const audio = audioRef.current;
    if (!audio || !validAudioClip(range.start, range.end, shape.props.duration)) return;
    stopPreview(); setError(""); audio.currentTime = range.start; previewEnd.current = range.end; previewing.current = true;
    const tick = () => { if (!previewing.current) return; if (audio.currentTime >= previewEnd.current - .015) { audio.pause(); audio.currentTime = previewEnd.current; return; } previewFrame.current = requestAnimationFrame(tick); };
    try { await audio.play(); setIsPreviewing(true); previewFrame.current = requestAnimationFrame(tick); }
    catch (cause) { stopPreview(); setError(cause instanceof Error ? cause.message : "无法试听选区"); }
  };
  const dragHandle = (side: "start" | "end") => ({ currentTarget, pointerId, clientX }: ReactPointerEvent<HTMLButtonElement>) => {
    stopPreview(); dragging.current = side; currentTarget.setPointerCapture(pointerId);
    const bounds = trackRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const time = Math.max(0, Math.min(shape.props.duration, Math.round((clientX - bounds.left) / bounds.width * shape.props.duration * 100) / 100));
    setRange((current) => side === "start" ? { ...current, start: Math.min(time, current.end - MIN_AUDIO_CLIP_SECONDS) } : { ...current, end: Math.max(time, current.start + MIN_AUDIO_CLIP_SECONDS) });
  };
  const moveHandle = (side: "start" | "end") => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (dragging.current !== side) return;
    const bounds = trackRef.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    const time = Math.max(0, Math.min(shape.props.duration, Math.round((event.clientX - bounds.left) / bounds.width * shape.props.duration * 100) / 100));
    setRange((current) => side === "start" ? { ...current, start: Math.min(time, current.end - MIN_AUDIO_CLIP_SECONDS) } : { ...current, end: Math.max(time, current.start + MIN_AUDIO_CLIP_SECONDS) });
  };
  const releaseHandle = (event: ReactPointerEvent<HTMLButtonElement>) => { event.stopPropagation(); dragging.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); };
  const clip = async () => {
    if (working) return;
    if (!validAudioClip(range.start, range.end, shape.props.duration)) { setError(range.end - range.start < MIN_AUDIO_CLIP_SECONDS ? "选中的声音片段太短" : "声音裁剪范围无效"); return; }
    stopPreview(); setWorking(true); setError("");
    try {
      const source = await getAsset(shape.props.assetId);
      if (!source || source.kind !== "audio" || source.storageReference !== shape.props.src) throw new Error("源声音 Asset 不可用");
      const { blob, duration } = await clipAudioBlob(await getLocalAudioBlob(shape.props.src), range.start, range.end);
      const previous = (await listAssets("audio")).filter((asset) => asset.derivationType === "audio_clip" && asset.sourceAudioAssetId === source.assetId);
      const name = `${shape.props.name.replace(/\.wav$/i, "")}_片段${String(previous.length + 1).padStart(2, "0")}.wav`;
      const src = await storeLocalAudio(blob, name);
      const asset = await registerAsset({ kind: "audio", origin: "generated", filename: name, mimeType: "audio/wav", storageReference: src, sourceRunId: null, fileSize: blob.size, duration, derivationType: "audio_clip", sourceAudioAssetId: source.assetId, sourceStartTime: range.start, sourceEndTime: range.end });
      const prior = getOutgoingTargets(editor, shape.id, "audio-node").length;
      const id = createShapeId();
      editor.createShape({ id, type: "audio-node", x: shape.x + shape.props.w + 110, y: shape.y + prior * 180, props: { w: 330, h: 155, src, name, duration, assetId: asset.assetId, sourceAudioAssetId: source.assetId, trimOpen: false } });
      const next = editor.getShape(id);
      if (next?.type === "audio-node") createBoundArrow(editor, shape, next);
      showCanvasToast("片段声音已保存，原声音保持不变");
    } catch (cause) { const detail = cause instanceof Error ? cause.message : "声音裁剪失败"; setError(`声音裁剪失败：${detail}`); void logEvent({ level: "error", category: categorize(detail, "audio"), title: "声音裁剪失败", detail, nodeId: shape.id }); }
    finally { setWorking(false); }
  };
  const percent = (time: number) => `${shape.props.duration > 0 ? Math.max(0, Math.min(100, time / shape.props.duration * 100)) : 0}%`;
  return <div className="audio-trim-panel" onPointerDown={stopPropagation} onPointerUp={stopPropagation} onClick={stopPropagation} onContextMenu={stopPropagation}>
    <div className="audio-waveform-track" ref={trackRef} data-waveform-ready={peaks.length > 0}>
      <canvas ref={canvasRef} aria-label="真实音频波形" />
      <div className="audio-waveform-selection" style={{ left: percent(range.start), width: shape.props.duration > 0 ? `${(range.end - range.start) / shape.props.duration * 100}%` : "0%" }} />
      <button type="button" className="audio-trim-handle start" aria-label="拖动开始时间" style={{ left: percent(range.start) }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); dragHandle("start")(event); }} onPointerMove={moveHandle("start")} onPointerUp={releaseHandle} onPointerCancel={releaseHandle} />
      <button type="button" className="audio-trim-handle end" aria-label="拖动结束时间" style={{ left: percent(range.end) }} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); dragHandle("end")(event); }} onPointerMove={moveHandle("end")} onPointerUp={releaseHandle} onPointerCancel={releaseHandle} />
    </div>
    <div className="audio-trim-times"><span>开始 {formatAudioTime(range.start)}</span><span>结束 {formatAudioTime(range.end)}</span><b>选区 {formatAudioTime(range.end - range.start)}</b></div>
    <div className="audio-trim-actions"><button type="button" disabled={!peaks.length || working} onClick={() => void audition()}>{isPreviewing ? "■ 停止试听" : "▶ 试听选区"}</button><button type="button" disabled={!peaks.length || working || !validAudioClip(range.start, range.end, shape.props.duration)} onClick={() => void clip()}><Scissors size={13} />{working ? "正在裁剪…" : "裁剪为新声音"}</button></div>
    {!peaks.length && !error && <small>正在从声音文件生成波形…</small>}{error && <small className="audio-trim-error" role="alert">{error}</small>}
  </div>;
}

function AudioRolePanel({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void listRoles().then(setRoles).catch((cause) => setError(cause instanceof Error ? cause.message : "角色读取失败")); }, []);
  const add = async (role: RoleRecord) => { if (busy) return; setBusy(true); setError(""); setNotice(""); try { const result = await addRoleAsset(role.roleId, assetId, "audio"); setNotice(result.added ? `已加入 ${role.displayName}` : "该声音已在此角色中"); setRoles(await listRoles()); } catch (cause) { setError(cause instanceof Error ? cause.message : "加入角色失败"); } finally { setBusy(false); } };
  const primary = async (role: RoleRecord) => { if (busy) return; if (role.primaryVoiceAssetId && role.primaryVoiceAssetId !== assetId && !await askConfirm(`将“${role.displayName}”的主声音改为当前声音？原主声音会保留在角色中。`)) return; setBusy(true); setError(""); try { await addRoleAsset(role.roleId, assetId, "audio"); await setPrimaryRoleAsset(role.roleId, assetId, "audio"); setRoles(await listRoles()); setNotice(`已设为 ${role.displayName} 的主声音`); } catch (cause) { setError(cause instanceof Error ? cause.message : "设置主声音失败"); } finally { setBusy(false); } };
  return <div className="generation-info-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}><section className="generation-info-panel audio-role-panel" role="dialog" aria-modal="true" aria-label="加入角色" onPointerDown={stopPropagation}><header><div><small>复用声音 Asset</small><h2>加入角色</h2></div><button type="button" aria-label="关闭" onClick={onClose}><X size={17} /></button></header><div className="audio-extract-body">{roles.length ? roles.map((role) => <div className="audio-role-row" key={role.roleId}><span>{role.displayName}{role.voiceAssetIds.includes(assetId) ? " · 已加入" : ""}{role.primaryVoiceAssetId === assetId ? " · 主声音" : ""}</span><button type="button" disabled={busy} onClick={() => void add(role)}>加入</button><button type="button" disabled={busy || role.primaryVoiceAssetId === assetId} onClick={() => void primary(role)}>设为主声音</button></div>) : <p>还没有角色，请先在角色资产中创建。</p>}{notice && <p className="role-notice">{notice}</p>}{error && <p className="role-error" role="alert">{error}</p>}</div></section></div>;
}

class UpscaleNodeUtil extends BaseBoxShapeUtil<UpscaleNode> {
  static override type = "upscale-node" as const;
  static override props = { w: T.number, h: T.number, clipMode: T.string, start: T.number, duration: T.number, collapsed: T.optional(T.boolean), autoHeight: T.optional(T.boolean), withInterpolation: T.optional(T.boolean), upscaleProfile:T.optional(T.literalEnum("safe","quality")), autoStart: T.optional(T.boolean), targetResolution: T.optional(T.string) };
  override getDefaultProps(): UpscaleNode["props"] { return { w: 350, h: 310, clipMode: "whole", start: 0, duration: 2, collapsed: false, autoHeight: true, targetResolution: "1080p" }; }
  override component(shape: UpscaleNode) { return <CulledShape editor={this.editor} shapeId={shape.id}><UpscaleNodeContent shape={shape} editor={this.editor} /></CulledShape>; }
  override getIndicatorPath(shape: UpscaleNode): Path2D { const path = new Path2D(); path.rect(0, 0, shape.props.w, shape.props.h); return path; }
  override onResize(shape: UpscaleNode, info: TLResizeInfo<UpscaleNode>) { const next = super.onResize(shape, info); return { ...next, props: { ...next.props, autoHeight: false } }; }
}

function useProcessingVideoSource(editor: Editor, targetId: TLShape['id'], revision: number): VideoNode | null {
  const incoming = useMemo(() => getIncomingSource(editor, targetId), [editor, targetId, revision]);
  const [resolved, setResolved] = useState<{ key: string; video: VideoNode | null } | null>(null);
  const inputMeta=editor.getShape(targetId)?.meta;
  const pinnedAssetId=typeof inputMeta?.batchInputAssetId==='string'?inputMeta.batchInputAssetId:undefined;
  const pinnedSource=typeof inputMeta?.batchInputSource==='string'?inputMeta.batchInputSource:undefined;
  const key = incoming?.type === 'h3-node' ? `${incoming.id}:${pinnedAssetId??incoming.props.previewAssetId ?? ''}:${incoming.props.shotId ?? ''}` : '';
  useEffect(() => {
    if (incoming?.type !== 'h3-node') return;
    let active = true;
    const refresh = async () => {
      const current = editor.getShape(incoming.id) as H3Node | undefined;
      if (!current || current.type !== 'h3-node') return;
      if(pinnedAssetId){
        const asset=await getAsset(pinnedAssetId);
        const video=asset?.kind==='video'&&asset.storageReference===pinnedSource?processingVideoFromH3(current,asset):null;
        if(active)setResolved({key,video});
        return;
      }
      const shot = current.props.shotId ? await getShot(current.props.shotId) : null;
      const assets = current.props.shotId ? await getShotAssetVersions(current.props.shotId) : [];
      const inherited = current.props.inheritedVideo ? await getAsset(current.props.inheritedVideo.assetId) : null;
      if (inherited && !assets.some(a => a.assetId === inherited.assetId)) assets.push(inherited);
      const legacy = current.props.shotId ? findShotDisplay(editor, current.props.shotId, current.id) : undefined;
      // Match H3's displayed candidate: a stale preview ID must not bypass a valid
      // adopted/visible version and silently choose a later HD or interpolation output.
      const asset = resolveCandidatePreview(assets, [current.props.previewAssetId, shot?.adoptedAssetId, legacy?.props.assetId, current.props.inheritedVideo?.assetId]);
      const video: VideoNode | null = asset ? { ...current, type: 'video-node', props: { w: current.props.w, h: current.props.h, src: asset.storageReference, name: asset.filename, size: asset.fileSize ? formatBytes(asset.fileSize) : '—', duration: asset.duration ? `${asset.duration.toFixed(1)} 秒` : '—', originalPath: '', assetId: asset.assetId, runId: asset.sourceRunId ?? undefined, shotId: asset.shotId, fps: asset.fps } } : legacy ?? null;
      if(active) setResolved({key, video});
    };
    const update = () => { void refresh().catch(() => { if(active) setResolved({key,video:null}); }); };
    update();
    window.addEventListener('frameflow-shot-changed',update);
    return () => { active=false; window.removeEventListener('frameflow-shot-changed',update); };
  }, [editor, incoming, key, pinnedAssetId, pinnedSource]);
  return incoming?.type === 'video-node' ? incoming : key && resolved?.key === key ? resolved.video : null;
}

function UpscaleNodeContent({ shape, editor }: { shape: UpscaleNode; editor: Editor }) {
  const targetEdge: 720 | 1080 = shape.props.targetResolution === "720p" ? 720 : 1080;
  const combined = shape.props.withInterpolation === true;
  const targetLabel = `${targetEdge}P`;
  const processingLabel = combined ? "1080P＋60 FPS" : `提升至${targetLabel}`;
  const target1080 = shape.props.targetResolution === "1080p" || shape.props.targetResolution === "720p";
  const formRef = useRef<HTMLDivElement>(null);
  useAutoNodeHeight(editor, shape, formRef, 310);
  const [status, setStatus] = useState<AiGenerationStatus>("disconnected");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<H3GenerationUpdate>({ status: "disconnected" });
  const [revision, setRevision] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const jobRef = useRef("");
  const runIdRef = useRef("");
  const busy = busyStatuses.includes(status);
  const source = useProcessingVideoSource(editor, shape.id, revision);
  const sourceNear = useMediaActive(editor, shape.id);
  const [sourceDimensions, setSourceDimensions] = useState<{ width: number; height: number } | "loading" | "unknown" | null>(null);
  useEffect(() => subscribeLinkedContent(editor, shape.id, () => setRevision((value) => value + 1)), [editor, shape.id]);
  useEffect(() => {
    if (!source?.props.src || !sourceNear) { queueMicrotask(() => setSourceDimensions(null)); return; }
    let active = true;
    let video: HTMLVideoElement | null = null;
    let ownedUrl = "";
    let releaseKey: string | null = null;
    queueMicrotask(() => { if (active) setSourceDimensions("loading"); });
    void acquireMediaUrl(source.props.src).then((result) => {
      if (!active) { releaseMediaUrl(result.key); if (result.revoke) URL.revokeObjectURL(result.url); return; }
      releaseKey = result.key;
      if (result.revoke) ownedUrl = result.url;
      video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => { if (active) setSourceDimensions(video?.videoWidth && video.videoHeight ? { width: video.videoWidth, height: video.videoHeight } : "unknown"); };
      video.onerror = () => { if (active) setSourceDimensions("unknown"); };
      video.src = result.url;
    }).catch(() => { if (active) setSourceDimensions("unknown"); });
    return () => { active = false; if (video) { video.onloadedmetadata = null; video.onerror = null; video.removeAttribute("src"); video.load(); } releaseMediaUrl(releaseKey); if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
  }, [source?.props.src, sourceNear]);
  useEffect(() => { let active = true; void comfyUIH3Adapter.isAvailable().then((available) => { if (active) setStatus(available ? "connected" : "disconnected"); }); return () => { active = false; }; }, []);
  const update = (props: Partial<UpscaleNode["props"]>) => editor.updateShape({ id: shape.id, type: "upscale-node", props });
  const cancel = async () => {
    const jobId = jobRef.current;
    try { if (jobId) await comfyUIH3Adapter.cancel(jobId); }
    catch (cause) { showCanvasToast(cause instanceof Error ? cause.message : "取消高清任务失败"); return; }
    abortRef.current?.abort();
    const runId = runIdRef.current;
    if (runId) { try { await updateRun(runId, { status: "cancelled", completedAt: Date.now(), error: "用户取消" }); } catch (cause) { showCanvasToast(cause instanceof Error ? cause.message : "取消记录保存失败"); } }
    releaseNodeClaim(shape.id); setNodeGenerating(shape.id, false); setStatus("cancelled");
    return true;
  };
  const recovery = useRunRecovery(shape.id, () => Boolean(runIdRef.current || abortRef.current), (_run, asset) => { presentDerivedVideo(editor, shape, asset); showCanvasToast("刷新前的高清增强任务已完成，结果已恢复到画布"); });
  useGeneratingSignal(shape.id, busy, recovery.view?.phase);
  useEffect(()=>registerNodeTaskCancel(shape.id,async()=>busy?await cancel():true));
  const deleteNode = () => deleteNodeWithHistory(editor, shape.id);
  const generate = async () => {
    if (busy || recovery.blocking) return;
    if (!source) { setStatus("failed"); setError("请先连接一个视频节点"); return; }
    const live=editor.getShape(shape.id);if(!live||live.type!=='upscale-node')return;
    const executionProps=structuredClone((live as UpscaleNode).props),executionMeta=structuredClone(live.meta);
    const executionModeLabel=`${executionProps.clipMode==='segmented'?'分段高清':executionProps.clipMode==='clip'?'截取':'整段'} · ${(executionProps.upscaleProfile??'quality')==='quality'?'画质实验档':'16G安全档'}${combined?' · 1080P＋60 FPS':''}`;
    const release = claimNode(shape.id);
    if (!release) return;
    let uncertain = false;
    const controller = new AbortController(); abortRef.current = controller; jobRef.current = ""; runIdRef.current = ""; setError(""); setStatus("preparing");
    try {
      const blob = await getLocalVideoBlob(source.props.src);
      const clip = executionProps.clipMode === "clip" ? { start: executionProps.start, duration: executionProps.duration } : undefined;
      const inputMetadata = await readVideoMetadata(blob);
      const inputAsset = await assetForSource(source.props.src, "video", source.props.name, { width: inputMetadata.width, height: inputMetadata.height, duration: durationSeconds(inputMetadata.duration), fileSize: blob.size });
      const shotId = inputAsset.shotId ?? source.props.shotId;
      if (target1080 && !combined && Math.min(inputMetadata.width, inputMetadata.height) >= targetEdge) throw new Error(`原视频已达到${targetLabel}或更高，无需提升；不会自动降低分辨率。`);
      const upscaleDimensions = target1080 ? video1080Dimensions(inputMetadata.width, inputMetadata.height, targetEdge) : undefined;
      const inputFps = combined ? await readMp4VideoFps(blob) : null;
      if (combined && (inputFps === null || !upscaleDimensions)) throw new Error("高清插帧无法确定源帧率或目标尺寸");
      const snapshot = combined ? await snapshotUpscale60(inputFps!,inputMetadata.width,inputMetadata.height,upscaleDimensions!,clip,executionProps.upscaleProfile??'safe') : await snapshotUpscale(clip, inputMetadata.width, inputMetadata.height, upscaleDimensions,executionProps.upscaleProfile??'safe');
      const segmentSeconds=executionMeta.nightSegmentSeconds===.5?.5:combined?1:3;
      let segmentPlan = executionProps.clipMode === 'segmented' ? await prepareSegmentedUpscale(blob,source.props.name,durationSeconds(inputMetadata.duration) ?? 0,controller.signal,upscaleDimensions,{seconds:segmentSeconds,contextFrames:8,clip}) : undefined;
      if(combined && segmentPlan)segmentPlan=boundInterpolationPlan(segmentPlan);
      if(segmentPlan) {
        snapshot.parameters = {...snapshot.parameters,enhancementPipeline:true,segmentedUpscale:true,segmentedPlan:segmentPlan,fps:segmentPlan.fps,frames:segmentPlan.frames,duration:segmentPlan.frames/segmentPlan.fps,acceptance:'not_render_tested',audioPolicy:'original_continuous_aac',segmentSeconds,upscaleProfile:executionProps.upscaleProfile??"quality"};
        snapshot.workflowIdentity = {...snapshot.workflowIdentity,templateFile:'segmented-upscale-v1 + seedvr2-workflow.json + rough-cut.py'};
      }
      snapshot.parameters={...snapshot.parameters,executionRangeMode:executionProps.clipMode,executionModeLabel,upscaleProfile:executionProps.upscaleProfile??'safe',batchRequestedRangeMode:executionMeta.batchRequestedRangeMode,nightAttemptLabel:executionMeta.nightAttemptLabel};
      const run = await createRunExclusively(shape.id, listRuns, attemptSignal => createRun({ ...snapshot, ownerNodeId: shape.id, shotId, inputAssetIds: [inputAsset.assetId], rawPrompt: null, finalPrompt: null, seed: null }, { reservePromptId: !segmentPlan }));
      if (shotId) await addRunToShot(shotId, run.runId);
      runIdRef.current = run.runId;
      let markedRunning = false;
      const options: H3GenerationOptions = { upscaleProfile:executionProps.upscaleProfile??"quality", upscaleDimensions, signal: controller.signal, promptId: run.runId, onJobId: (jobId) => { if (controller.signal.aborted) return; jobRef.current = jobId; recordRunUpdate(run.runId, { comfyPromptId: jobId, submission: "accepted" }); }, onUpdate: (next) => { if (controller.signal.aborted) return; setStatus(next.status); setProgress(next); if (["loading","running","decoding"].includes(next.status) && !markedRunning) { markedRunning = true; recordRunUpdate(run.runId, { status: "running", startedAt: Date.now() }); } } };
      if(segmentPlan) await saveEnhancement(newEnhancementCheckpoint({runId:run.runId,plan:segmentPlan,combined,profile:executionProps.upscaleProfile??"quality",originalSource:inputAsset.storageReference,originalName:source.props.name,clip}));
      const result = segmentPlan ? await resumeEnhancement(run,options) : combined ? await comfyUIH3Adapter.upscale60(blob,source.props.name,clip,options) : await comfyUIH3Adapter.upscale(blob,source.props.name,clip,options);
      const finalized = await finalizeRunOutput(run.runId, runOutputStore, async () => { const metadata = await readVideoMetadata(result.video); const src = await storeLocalVideo(result.video, result.filename); const outputFps = await readMp4VideoFps(result.video).catch(() => null); if (combined && (outputFps === null || Math.abs(outputFps - 60) > .01 || metadata.width !== upscaleDimensions?.width || metadata.height !== upscaleDimensions?.height)) throw new Error("输出未通过1080P及60 FPS校验"); return generatedVideoAsset(src, result, metadata, run.runId, outputFps ?? source.props.fps, shotId); });
      presentDerivedVideo(editor, shape, finalized.asset);
      setStatus("completed"); logTaskDone(shape.type, shape.id, run.runId, shotId); showCanvasToast(combined ? "1080P＋60 FPS视频已加入画布，只显示最终结果，原视频保留" : "高清视频已加入画布，原视频保持不变");
      return 'completed' as const;
    } catch (cause) {
      uncertain = !(cause instanceof DOMException && cause.name === "AbortError") && Boolean(runIdRef.current) && isUncertainAfterSubmit(cause, Boolean(jobRef.current));
      if (uncertain) { setStatus("disconnected"); setError("与 ComfyUI 的连接中断，任务状态待确认（不会重复提交）"); logTaskUncertain(shape.type, shape.id, runIdRef.current); }
      else {
        if (runIdRef.current) recordRunUpdate(runIdRef.current, { status: cause instanceof DOMException && cause.name === "AbortError" ? "cancelled" : "failed", completedAt: Date.now(), error: `本次执行：${executionModeLabel}；${cause instanceof Error ? cause.message : "高清增强失败"}` });
        if (cause instanceof DOMException && cause.name === "AbortError") setStatus("cancelled");
        else { const raw = cause instanceof Error ? cause.message : "高清增强失败"; const message = /DefaultCPUAllocator|alloc_cpu|not enough memory/i.test(raw) ? "系统内存申请失败：可选择分段高清，减少编码前的整段内存峰值" : /out of memory|cuda.*memory|allocation on device/i.test(raw) ? "显存不足：可改为截取较短片段后重试；安全默认 split_latent 已开启" : humanizeGenerationError(cause); const contextualMessage=`本次执行：${executionModeLabel}；${message}`; setStatus("failed"); setError(contextualMessage); logTaskFailure(shape.type, shape.id, runIdRef.current, contextualMessage); showCanvasToast(contextualMessage); }
      }
    } finally { abortRef.current = null; jobRef.current = ""; runIdRef.current = ""; release(); if (uncertain) void recovery.recheck(); }
    return uncertain ? 'uncertain' as const : controller.signal.aborted ? 'cancelled' as const : 'failed' as const;
  };
  useProcessingController(shape.id,()=>({ready:!!source&&!busy&&!recovery.blocking&&status!=="disconnected"&&sourceDimensions!=="loading",generate}));
  // Node creation/mounting is never permission to submit. Keep autoStart in the schema
  // only for older saved canvases; execution requires Start or an explicit batch command.
  return <HTMLContainer className="node-container interactive-node"><NodeShell icon={<Sparkles size={17} />} eyebrow={combined ? "高清＋流畅增强" : target1080 ? targetLabel : "高清增强"} title={combined ? processingLabel : target1080 ? `提升至${targetLabel}` : "视频高清增强"} accent="#858585" onDelete={deleteNode} outputPort={<WorkflowPort editor={editor} shape={shape} />}>
    <div ref={formRef} className="h3-form upscale-form" onPointerDown={stopPropagation} onPointerUp={stopPropagation} onContextMenu={stopPropagation} onWheel={stopWheelPropagation}>
      <div className="setting-title"><span>输入视频</span><b title={source?.props.name}>{source?.props.name ?? "等待连接"}</b></div>
      <div className="setting-title"><span>{target1080 ? "目标分辨率" : "倍率"}</span><b>{target1080 ? `${targetLabel} · SeedVR2高清增强` : "2× · 16GB 安全配置"}</b></div>
      <div className="upscale-dimensions">{sourceDimensions === "loading" ? "正在读取尺寸…" : sourceDimensions === "unknown" || !sourceDimensions ? "尺寸未知" : (() => { const output = target1080 ? video1080Dimensions(sourceDimensions.width,sourceDimensions.height,targetEdge) : {width:sourceDimensions.width*2,height:sourceDimensions.height*2}; return target1080 && Math.min(sourceDimensions.width,sourceDimensions.height)>=targetEdge ? `原始：${sourceDimensions.width}×${sourceDimensions.height} · 已达到${targetLabel}，无需提升` : `原始：${sourceDimensions.width}×${sourceDimensions.height} → 输出：${output.width}×${output.height}`; })()}</div>
      <div className="setting-title"><span>处理范围</span></div>
      <fieldset disabled={busy || recovery.blocking} style={{border:0,padding:0,margin:0}}><Segmented value={shape.props.clipMode === "segmented" ? "分段高清" : shape.props.clipMode === "clip" ? "截取" : "整段"} options={["整段", "截取", "分段高清"]} onChange={(value) => update({ clipMode: value === "分段高清" ? "segmented" : value === "截取" ? "clip" : "whole" })} /></fieldset>
      {shape.props.clipMode === 'segmented' && <p>每段约{shape.meta.nightSegmentSeconds===.5?.5:combined?1:3}秒，重叠上下文后裁掉重复帧，最终只输出一条完整{target1080 ? targetLabel : "2×"}视频，恢复原音轨。请保持页面打开，刷新不会自动续跑。</p>}
      {shape.props.clipMode === "clip" && <div className="upscale-clip"><label>开始时间（秒）<input type="number" min="0" step="0.1" value={shape.props.start} onChange={(event) => update({ start: Math.max(0, Number(event.target.value) || 0) })} /></label><label>时长（秒）<input type="number" min="0.1" step="0.1" value={shape.props.duration} onChange={(event) => update({ duration: Math.max(0.1, Number(event.target.value) || 0.1) })} /></label></div>}
      <div className="setting-title"><span>SeedVR2 档位</span></div>
      <fieldset aria-label="SeedVR2 档位" disabled={busy || recovery.blocking} style={{border:0,padding:0,margin:0}}><Segmented value={(shape.props.upscaleProfile??"quality")==="quality" ? "画质实验 · 21帧＋重叠" : "16G 安全 · 9帧分块"} options={["16G 安全 · 9帧分块", "画质实验 · 21帧＋重叠"]} onChange={value=>update({upscaleProfile:value==="画质实验 · 21帧＋重叠" ? "quality" : "safe"})} /></fieldset>
      {combined&&<p>{shape.props.clipMode==='segmented'?'分段处理：先逐段高清，再逐段插帧。':'整段处理：整个选定范围先高清，再插帧，不自动切段；提交前检查内存预算。'}中间视频不显示，完成后只加入一条1080P＋60 FPS视频。</p>}
      {shape.meta.nightMode===true&&<p>批量夜间容错：{String(shape.meta.nightAttemptLabel??'所选档位')}。确认失败才降档；状态不明暂停核对，不重复提交。</p>}
      <details className="execution-info"><summary>高级参数</summary><p>SeedVR2 3B INT8 · VAE FP16 · {target1080 ? `目标${targetLabel}；先对齐推理，再裁切到精确输出尺寸，边缘可能轻微裁切` : "2×"} · split_latent=true · {combined ? (shape.props.clipMode==="segmented" ? "逐段高清和60 FPS插帧，已完成段可恢复；输出一条完整视频" : "整段高清后整段插帧至60 FPS，原音轨保留；输出一条完整视频") : "保留原视频帧率和音轨"}</p></details>
      <div className={`generation-status status-${status}`}><div className="status-copy"><span>{statusLabels[status]}</span><b>{error || progress.stage || "就绪"}</b></div></div>
      <RecoveryStatus recovery={recovery} />
      <div className="generation-actions">{busy && <button type="button" className="cancel-button" onClick={() => void cancel()}><X size={14} />取消</button>}<button type="button" className="generate-button" disabled={busy || recovery.blocking} onClick={() => void generate()}><Sparkles size={16} />{busy ? statusLabels[status] : recovery.blocking && recovery.view ? recoveryPhaseLabels[recovery.view.phase] : "开始增强"}</button></div>
    </div>
  </NodeShell></HTMLContainer>;
}

class SmoothNodeUtil extends BaseBoxShapeUtil<SmoothNode> {
  static override type = "smooth-node" as const;
  static override props = { w: T.number, h: T.number, autoHeight: T.optional(T.boolean) };
  override getDefaultProps(): SmoothNode["props"] { return { w: 350, h: 264, autoHeight: true }; }
  override component(shape: SmoothNode) { return <CulledShape editor={this.editor} shapeId={shape.id}><SmoothNodeContent shape={shape} editor={this.editor} /></CulledShape>; }
  override getIndicatorPath(shape: SmoothNode): Path2D { const path = new Path2D(); path.rect(0, 0, shape.props.w, shape.props.h); return path; }
  override onResize(shape: SmoothNode, info: TLResizeInfo<SmoothNode>) { const next = super.onResize(shape, info); return { ...next, props: { ...next.props, autoHeight: false } }; }
}

const smoothStatusLabels: Record<AiGenerationStatus, string> = { ...statusLabels, connected: "待生成", uploading: "上传视频", running: "处理中", decoding: "整理视频", fetching: "获取视频" };

function smoothError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "流畅增强失败";
  if (/film_net_fp16|FrameInterpolationModelLoader/i.test(message) && /not found|not in list|does not exist|missing|invalid|找不到|缺少|不存在/i.test(message)) return "缺少帧插值模型 film_net_fp16.safetensors；请检查现有 ComfyUI 模型目录";
  if (/没有找到 SaveVideo|输出.*不存在|视频文件为空/i.test(message)) return "输出文件不存在或无法从 ComfyUI 取得";
  return message;
}

function SmoothNodeContent({ shape, editor }: { shape: SmoothNode; editor: Editor }) {
  const formRef = useRef<HTMLDivElement>(null);
  useAutoNodeHeight(editor, shape, formRef, 264);
  const [status, setStatus] = useState<AiGenerationStatus>("disconnected");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<H3GenerationUpdate>({ status: "disconnected" });
  const [revision, setRevision] = useState(0);
  const [inputFps, setInputFps] = useState<number | "loading" | "unknown">("loading");
  const abortRef = useRef<AbortController | null>(null);
  const jobRef = useRef("");
  const runIdRef = useRef("");
  const busy = busyStatuses.includes(status);
  const source = useProcessingVideoSource(editor, shape.id, revision);
  const sourceNear = useMediaActive(editor, shape.id);
  useEffect(() => subscribeLinkedContent(editor, shape.id, () => setRevision((value) => value + 1)), [editor, shape.id]);
  useEffect(() => {
    let active = true;
    if (source?.props.fps) queueMicrotask(() => { if (active) setInputFps(source.props.fps ?? "unknown"); });
    else if (source?.props.src && sourceNear) {
      queueMicrotask(() => { if (active) setInputFps("loading"); });
      void getLocalVideoBlob(source.props.src).then(readMp4VideoFps).then((fps) => { if (active) setInputFps(fps ?? "unknown"); }).catch(() => { if (active) setInputFps("unknown"); });
    } else queueMicrotask(() => { if (active) setInputFps(source?.props.src ? "unknown" : "unknown"); });
    return () => { active = false; };
  }, [source?.props.src, source?.props.fps, sourceNear]);
  useEffect(() => { let active = true; void comfyUIH3Adapter.isAvailable().then((available) => { if (active) setStatus(available ? "connected" : "disconnected"); }); return () => { active = false; }; }, []);
  const cancel = async () => {
    try { if (jobRef.current) await comfyUIH3Adapter.cancel(jobRef.current); }
    catch (cause) { showCanvasToast(smoothError(cause)); return false; }
    abortRef.current?.abort();
    const runId = runIdRef.current;
    if (runId) { try { await updateRun(runId, { status: "cancelled", completedAt: Date.now(), error: "用户取消" }); } catch (cause) { showCanvasToast(cause instanceof Error ? cause.message : "取消记录保存失败"); } }
    releaseNodeClaim(shape.id); setNodeGenerating(shape.id, false);
    setStatus("cancelled"); setProgress({ status: "cancelled", stage: "任务已取消" }); return true;
  };
  const recovery = useRunRecovery(shape.id, () => Boolean(runIdRef.current || abortRef.current), (_run, asset) => { presentDerivedVideo(editor, shape, asset, "smooth"); showCanvasToast("刷新前的流畅增强任务已完成，结果已恢复到画布"); });
  useGeneratingSignal(shape.id, busy, recovery.view?.phase);
  useEffect(()=>registerNodeTaskCancel(shape.id,async()=>busy?await cancel():true));
  const deleteNode = () => deleteNodeWithHistory(editor, shape.id);
  const generate = async () => {
    if (busy || recovery.blocking) return;
    if (!source) { setStatus("failed"); setError("请先连接一个视频节点"); return; }
    const release = claimNode(shape.id);
    if (!release) return;
    let uncertain = false;
    const controller = new AbortController(); abortRef.current = controller; jobRef.current = ""; runIdRef.current = ""; setStatus("preparing"); setError(""); setProgress({ status: "preparing", stage: "读取输入视频" });
    try {
      const blob = await getLocalVideoBlob(source.props.src);
      if (!blob.size) throw new Error("输入视频不可用或文件为空");
      let inputMetadata: Awaited<ReturnType<typeof readVideoMetadata>>;
      try { inputMetadata = await readVideoMetadata(blob); } catch { throw new Error("输入视频 metadata 读取失败，请检查 MP4 文件"); }
      const sourceFps = await readMp4VideoFps(blob).catch(() => null) ?? (typeof inputFps === "number" ? inputFps : source.props.fps ?? null);
      const inputAsset = await assetForSource(source.props.src, "video", source.props.name, { width: inputMetadata.width, height: inputMetadata.height, duration: durationSeconds(inputMetadata.duration), fps: sourceFps ?? undefined, fileSize: blob.size });
      const shotId = inputAsset.shotId ?? source.props.shotId;
      const snapshot = await snapshotFilm(sourceFps ?? null);
      let segmentPlan=await prepareSegmentedUpscale(blob,source.props.name,durationSeconds(inputMetadata.duration)??0,controller.signal,{width:inputMetadata.width,height:inputMetadata.height},{seconds:1,contextFrames:8});
      segmentPlan=boundInterpolationPlan(segmentPlan);
      snapshot.parameters={...snapshot.parameters,enhancementPipeline:true,segmentedUpscale:true,segmentedPlan:segmentPlan,outputFps:60};
      const run = await createRunExclusively(shape.id, listRuns, attemptSignal => createRun({ ...snapshot, ownerNodeId: shape.id, shotId, inputAssetIds: [inputAsset.assetId], rawPrompt: null, finalPrompt: null, seed: null }, { reservePromptId: false }));
      if (shotId) await addRunToShot(shotId, run.runId);
      runIdRef.current = run.runId;
      let markedRunning = false;
      await saveEnhancement(newEnhancementCheckpoint({runId:run.runId,plan:segmentPlan,combined:false,interpolationOnly:true,profile:"safe",originalSource:inputAsset.storageReference,originalName:source.props.name}));
      const result = await resumeEnhancement(run, { signal: controller.signal, promptId: run.runId, onJobId: (id) => { if (controller.signal.aborted) return; jobRef.current = id; recordRunUpdate(run.runId, { comfyPromptId: id, submission: "accepted" }); }, onUpdate: (next) => { if (controller.signal.aborted) return; setStatus(next.status); setProgress(next); if (["loading", "running", "decoding"].includes(next.status) && !markedRunning) { markedRunning = true; recordRunUpdate(run.runId, { status: "running", startedAt: Date.now() }); } } });
      const finalized = await finalizeRunOutput(run.runId, runOutputStore, async () => {
        let metadata: Awaited<ReturnType<typeof readVideoMetadata>>;
        try { metadata = await readVideoMetadata(result.video); } catch { throw new Error("输出视频 metadata 读取失败"); }
        const actualFps = await readMp4VideoFps(result.video).catch(() => null);
        if (actualFps === null || Math.abs(actualFps - 60) > 0.01) throw new Error("插帧结果未验证为60 FPS，请检查输出视频");
        const fps = actualFps;
        const src = await storeLocalVideo(result.video, result.filename);
        return generatedVideoAsset(src, result, metadata, run.runId, fps, shotId);
      });
      presentDerivedVideo(editor, shape, finalized.asset, "smooth");
      setStatus("completed"); logTaskDone(shape.type, shape.id, run.runId, shotId); showCanvasToast("流畅增强视频已加入画布，原视频保持不变");
      return 'completed' as const;
    } catch (cause) {
      uncertain = !(cause instanceof DOMException && cause.name === "AbortError") && Boolean(runIdRef.current) && isUncertainAfterSubmit(cause, Boolean(jobRef.current));
      if (uncertain) { setStatus("disconnected"); setError("与 ComfyUI 的连接中断，任务状态待确认（不会重复提交）"); logTaskUncertain(shape.type, shape.id, runIdRef.current); }
      else {
        if (runIdRef.current) recordRunUpdate(runIdRef.current, { status: cause instanceof DOMException && cause.name === "AbortError" ? "cancelled" : "failed", completedAt: Date.now(), error: cause instanceof Error ? cause.message : "流畅增强失败" });
        if (cause instanceof DOMException && cause.name === "AbortError") setStatus("cancelled");
        else { const message = smoothError(cause); setStatus("failed"); setError(message); logTaskFailure(shape.type, shape.id, runIdRef.current, message); showCanvasToast(message); }
      }
    } finally { abortRef.current = null; jobRef.current = ""; runIdRef.current = ""; release(); if (uncertain) void recovery.recheck(); }
    return uncertain ? 'uncertain' as const : controller.signal.aborted ? 'cancelled' as const : 'failed' as const;
  };
  const fpsLabel = inputFps === "loading" ? "正在读取 FPS…" : typeof inputFps === "number" ? `${formatFps(inputFps)} FPS → 60 FPS` : "原FPS未知 → 60 FPS（需先识别）";
  useProcessingController(shape.id,()=>({ready:!!source&&!busy&&!recovery.blocking&&status!=="disconnected"&&inputFps!=="loading",generate}));
  return <HTMLContainer className="node-container interactive-node"><NodeShell icon={<Film size={17} />} eyebrow="流畅增强" title="流畅增强" accent="#858585" onDelete={deleteNode} outputPort={<WorkflowPort editor={editor} shape={shape} />}>
    <div ref={formRef} className="h3-form smooth-form" onPointerDown={stopPropagation} onPointerUp={stopPropagation} onContextMenu={stopPropagation} onWheel={stopWheelPropagation}>
      <div className="setting-title"><span>输入视频</span><b title={source?.props.name}>{source?.props.name ?? "等待连接"}</b></div>
<div className="setting-title"><span>输入时长</span><b>{source?.props.duration ?? "—"}</b></div><div className="setting-title"><span>帧率</span><b>{fpsLabel}</b></div>
      <div className="setting-title"><span>目标帧率</span><b>60 FPS</b></div>
      <div className="setting-title"><span>声音</span><b>原声音保留</b></div>
      <details className="execution-info"><summary>高级参数</summary><p className="ff-hint">插帧模型：film_net_fp16.safetensors · 目标：60 FPS · 自动整数倍插帧后均匀取帧，不改变播放速度</p></details>
      <div className={`generation-status status-${status}`}><div className="status-copy"><span>{smoothStatusLabels[status]}</span><b>{error || progress.stage || "就绪"}</b></div>{busy && <div className={`progress-track ${progress.percent === undefined ? "indeterminate" : ""}`}><i style={progress.percent === undefined ? undefined : { width: `${progress.percent}%` }} /></div>}</div>
      <RecoveryStatus recovery={recovery} />
      <div className="generation-actions">{busy && <button type="button" className="cancel-button" onClick={() => void cancel()}><X size={14} />取消</button>}<button type="button" className="generate-button" disabled={busy || recovery.blocking} onClick={() => void generate()}><Sparkles size={16} />{busy ? smoothStatusLabels[status] : recovery.blocking && recovery.view ? recoveryPhaseLabels[recovery.view.phase] : "开始增强"}</button></div>
    </div>
  </NodeShell></HTMLContainer>;
}

FluxImageNodeUtil.renderPort = (editor, shape) => {
  const image = referenceImageOf(shape);
  return image ? <WorkflowPort editor={editor} shape={image} /> : null;
};
FluxImageNodeUtil.incomingImage = (editor, shape) => {
  for (const binding of editor.getBindingsToShape(shape.id, "arrow")) {
    if (binding.props.terminal !== "end") continue;
    const arrow = editor.getShape(binding.fromId);
    if (arrow?.type !== "arrow") continue;
    const source = referenceImageOf(editor.getShape(getArrowBindings(editor, arrow as TLArrowShape).start?.toId ?? shape.id));
    if (source) return { src: source.props.src, name: source.props.name };
  }
};
CoverNodeUtil.placeImage=createImageNodeForAsset;
const shapeUtils = [WorkflowArrowUtil, ImageNodeUtil, H3NodeUtil, VideoNodeUtil, AudioNodeUtil, UpscaleNodeUtil, SmoothNodeUtil, FluxImageNodeUtil, CoverNodeUtil,TranslationNodeUtil, TTSNodeUtil, AudioVideoNodeUtil, MusicNodeUtil];
function placeSelectedFrameImage(editor: Editor, image: ImageNode, h3: H3Node, role: "first" | "last") {
  // Separate columns avoid overlapping the H3 card or another large portrait frame.
  editor.updateShape({ id: image.id, type: "image-node", x: h3.x - image.props.w - (role === "first" ? 100 : 470), y: h3.y + (role === "first" ? 20 : 90) });
}
async function createImageNodeForAsset(editor: Editor, asset: Pick<AssetRecord, "assetId" | "kind" | "storageReference" | "filename" | "width" | "height">, point: Point) {
  if (asset.kind !== "image") throw new Error("只能选择图片素材");
  const size = asset.width && asset.height ? { width: asset.width, height: asset.height } : await getLocalImageSize(asset.storageReference);
  const { w, h } = imageNodeSize(size.width, size.height);
  const id = createShapeId();
  editor.createShape({ id, type: "image-node", x: point.x - w / 2, y: point.y - h / 2, props: { w, h, src: asset.storageReference, name: asset.filename, originalPath: asset.filename, naturalWidth: size.width, naturalHeight: size.height, assetId: asset.assetId } });
  const shape = editor.getShape(id);
  if (shape?.type !== "image-node") throw new Error("图片节点创建失败");
  return shape as ImageNode;
}
async function addImageFile(editor: Editor, file: File, point?: Point) { const temp = URL.createObjectURL(file); try { const natural = await getImageSize(temp); const src = await storeLocalImage(file, file.name); const asset = await importedAsset(src, "image", file, { width: natural.width, height: natural.height }); return createImageNodeForAsset(editor, asset, point ?? editor.getViewportPageBounds().center); } finally { URL.revokeObjectURL(temp); } }
const automationDeps: AutomationDeps = {
  addImageFile,
  addVideoFile: (editor, file, point) => addVideoFile(editor, file, point),
  createH3Node: (editor, point, props) => createH3Node(editor, point, props as Partial<H3Node["props"]>),
  connect: (editor, fromId, toId, role) => {
    const from = editor.getShape(fromId as TLShape["id"]) as CustomNode | undefined;
    const to = editor.getShape(toId as TLShape["id"]) as CustomNode | undefined;
    if (!from || !to) throw new Error("连接的节点不存在");
    const arrowId = createBoundArrow(editor, from, to, role);
    editor.updateShape({ id: arrowId, type: "arrow", meta: { frameRole: role } });
    return arrowId;
  },
  inputsOf: (editor, id) => ({ first: getIncomingFrameSource(editor, id as H3Node["id"], "first")?.id, last: getIncomingFrameSource(editor, id as H3Node["id"], "last")?.id, references: getIncomingReferenceImages(editor, id as H3Node["id"]).map((image) => image.id) }),
  h3Width: H3_NODE_WIDTH,
};
async function addVideoFile(editor: Editor, file: File, point?: Point) { const metadata = await readVideoMetadata(file); const src = await storeLocalVideo(file, file.name); const asset = await importedAsset(src, "video", file, { width: metadata.width, height: metadata.height, duration: durationSeconds(metadata.duration) }); const { w, h } = fittedVideoSize(editor, metadata.width, metadata.height); const at = point ?? editor.getViewportPageBounds().center; const id = createShapeId(); editor.createShape({ id, type: "video-node", x: at.x - w / 2, y: at.y - h / 2, props: { w, h, src, name: file.name, size: formatBytes(file.size), duration: metadata.duration, originalPath: file.webkitRelativePath || file.name, assetId: asset.assetId } }); return editor.getShape(id) as VideoNode | undefined; }

/** Freeze the exact displayed take; importing and probing never edits source video. */
/**
 * 右键「打开所在文件夹」：节点当前显示的那一版素材（h3-node 和粗剪 / 去背景音同一规则：previewAssetId → 采用版 → 最新候选）。
 * 只读：不登记新素材、不读视频内容。找不到返回 null。
 */
async function resolveRevealAsset(shape: TLShape): Promise<AssetRecord|null> {
  const p=shape.props as {src?:string;assetId?:string;previewAssetId?:string;shotId?:string;inheritedVideo?:{src:string;assetId?:string}};
  if(shape.type==="h3-node"){
    const [shot,versions,inherited]=await Promise.all([p.shotId?getShot(p.shotId):null,p.shotId?getShotAssetVersions(p.shotId):[],p.inheritedVideo?.assetId?getAsset(p.inheritedVideo.assetId):null]);
    const asset=resolveCandidatePreview(inherited?[...versions,inherited]:versions,[p.previewAssetId,shot?.adoptedAssetId,p.inheritedVideo?.assetId]);
    if(asset)return asset;
    return p.inheritedVideo?.src&&!p.inheritedVideo.src.startsWith("data:")?(await getAssetBySource(p.inheritedVideo.src))??null:null;
  }
  if(p.assetId){const asset=await getAsset(p.assetId);if(asset)return asset;}
  return p.src&&!p.src.startsWith("data:")?(await getAssetBySource(p.src))??null:null;
}

/** Select and frame the canvas node showing this Asset; false when it is not on the canvas. */
function locateAssetOnCanvas(editor: Editor, assetId: string) {
  const node = editor.getCurrentPageShapes().find((candidate) => (candidate.props as { assetId?: string }).assetId === assetId);
  if (!node) return false;
  editor.select(node.id);
  editor.zoomToSelection({ animation: { duration: 220 } });
  return true;
}

/** Asset Library "放到画布": a new node pointing at the existing Asset and Blob (no re-import, no copy). */
/** Phase 19: the new rough cut goes to the right of everything on the page (never replacing a node). */
async function placeRoughCut(editor: Editor, asset: AssetRecord) {
  const bounds = editor.getCurrentPageBounds();
  const size = fittedVideoSize(editor, asset.width ?? 1280, asset.height ?? 720);
  const point = bounds ? { x: bounds.maxX + 160 + size.w / 2, y: bounds.minY + size.h / 2 } : editor.getViewportPageBounds().center;
  await placeAssetOnCanvas(editor, asset, point);
  const placed = editor.getSelectedShapes().find((shape) => shape.type === "video-node" && (shape.props as { assetId?: string }).assetId === asset.assetId);
  if (placed) { editor.updateShape({ id: placed.id, type: "video-node", props: { origin: "rough" } }); editor.zoomToSelection({ animation: { duration: 240 } }); }
  showCanvasToast(`粗剪完成：${asset.filename}`);
}

async function placeAssetOnCanvas(editor: Editor, asset: AssetRecord, point: Point) {
  editor.markHistoryStoppingPoint("before placing library asset");
  const spec = assetNodeProps(asset);
  let id: TLShape["id"];
  if (spec.type === "image-node") id = (await createImageNodeForAsset(editor, asset, point)).id;
  else if (spec.type === "video-node") {
    const size = fittedVideoSize(editor, asset.width ?? 1280, asset.height ?? 720);
    id = createShapeId();
    editor.createShape({ id, type: "video-node", x: point.x - size.w / 2, y: point.y - size.h / 2, props: { ...size, ...spec.props } });
  } else {
    id = createShapeId();
    editor.createShape({ id, type: "audio-node", x: point.x - 165, y: point.y - 78, props: { w: 330, h: 155, ...spec.props } });
  }
  editor.select(id);
  return editor.getShape(id);
}
/**
 * 导演台 → 发送到 H3: a normal H3 node plus normal image nodes (existing Assets, no copies) connected
 * as 首帧 / 尾帧 / 参考 with the same arrows a user would draw; reference videos / audios go into the
 * node's existing reference lists. Generation then runs through the unchanged H3 path.
 */
async function sendDirectorPlanToH3(editor: Editor, plan: H3HandoffPlan, shotId?: string) {
  editor.markHistoryStoppingPoint("before director stage hand-off");
  const bounds = editor.getCurrentPageBounds();
  const point = bounds ? { x: bounds.maxX + 900, y: bounds.minY } : editor.getViewportPageBounds().center;
  const h3 = await createH3Node(editor, point, {
    referenceVideos: plan.referenceVideos.map((asset) => ({ src: asset.storageReference, name: asset.filename })),
    referenceAudios: plan.referenceAudios.map((asset) => ({ src: asset.storageReference, name: asset.filename })),
    directorContext: plan.context,
    ...(plan.generationLength ? { duration: String(plan.generationLength / H3_FPS) } : {}),
  }, shotId);
  if (!h3) throw new Error("H3 节点创建失败");
  for (const [asset, role] of [[plan.firstFrame, "first"], [plan.lastFrame, "last"]] as const) {
    if (!asset) continue;
    const image = await createImageNodeForAsset(editor, asset, point);
    createBoundArrow(editor, image, h3, role);
    placeSelectedFrameImage(editor, image, h3, role);
  }
  let y = h3.y + h3.props.h + 80;
  for (const asset of plan.referenceImages) {
    const image = await createImageNodeForAsset(editor, asset, point);
    editor.updateShape({ id: image.id, type: "image-node", x: h3.x - image.props.w - 100, y });
    createBoundArrow(editor, image, h3, "reference");
    y += image.props.h + 40;
  }
  editor.select(h3.id);
  editor.zoomToSelection({ animation: { duration: 240 } });
  showCanvasToast("已从导演台创建 H3 节点：填写 Prompt 后即可生成");
}

/**
 * Shot System V0.1: 导演台 Shot → H3. A Shot whose H3 node is still on the canvas is only located (one
 * node per Shot); otherwise a new H3 node is created for that same Shot, so its Runs and candidate
 * videos attach to it through the unchanged H3 flow.
 */
async function sendDirectorShotToH3(editor: Editor, shotId: string, plan: H3HandoffPlan): Promise<"created" | "located"> {
  const shot = await getShot(shotId);
  if (!shot) throw new Error("镜头记录不存在");
  const node = shot.sourceH3NodeId ? editor.getShape(shot.sourceH3NodeId as H3Node["id"]) : undefined;
  if (node?.type === "h3-node" && (node as H3Node).props.shotId === shotId) {
    editor.select(node.id);
    editor.zoomToSelection({ animation: { duration: 240 } });
    showCanvasToast(`${shot.title} 已有 H3 节点，已定位；要按新的绑定重建，请先删除这个节点`);
    return "located";
  }
  await sendDirectorPlanToH3(editor, plan, shotId);
  showCanvasToast(`已为 ${shot.title} 创建 H3 节点：填写 Prompt 后即可生成，结果会挂回这个镜头`);
  return "created";
}

/** Asset Library import: store the Blob and register the Asset only; no canvas node is created. */
async function importAssetOnly(kind: "image" | "video" | "audio", file: File) {
  if (kind === "image") {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("请选择 JPG、PNG 或 WEBP 图片");
    const temp = URL.createObjectURL(file);
    try { const natural = await getImageSize(temp); return importedAsset(await storeLocalImage(file, file.name), "image", file, { width: natural.width, height: natural.height }); }
    finally { URL.revokeObjectURL(temp); }
  }
  if (kind === "video") {
    if (file.type !== "video/mp4" && !/\.mp4$/i.test(file.name)) throw new Error("请选择 MP4 视频");
    const metadata = await readVideoMetadata(file);
    const fps = await readMp4VideoFps(file).catch(() => null);
    return importedAsset(await storeLocalVideo(file, file.name), "video", file, { width: metadata.width, height: metadata.height, duration: durationSeconds(metadata.duration), ...(fps ? { fps } : {}) });
  }
  if (!file.type.startsWith("audio/") && !/\.m4a$/i.test(file.name)) throw new Error("请选择音频文件");
  const metadata = await readVideoMetadata(file).catch(() => null);
  // Stored in the audio store (audio:) so the Audio node can play, trim and add it to a Role.
  return importedAsset(await storeLocalAudio(file, file.name), "audio", file, { duration: metadata ? durationSeconds(metadata.duration) : undefined });
}

const CANVAS_PERSISTENCE_KEY = "frameflow-v0.1-canvas";

export default function CanvasWorkspace() {
  useEffect(() => installUiErrorReporting(window, showCanvasToast), []);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [toast, setToast] = useState("");
  const [saveLabel, setSaveLabel] = useState("自动保存已开启");
  const [quickMenu, setQuickMenu] = useState<{ client: Point; page: Point } | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const point = (event as CustomEvent<{ point?: Point }>).detail?.point;
      if (editor) createFluxImageNode(editor, point);
    };
    const pointOf = (event: Event) => (event as CustomEvent<{point?:Point}>).detail?.point ?? editor?.getViewportPageBounds().center;
    const voice = (event: Event) => { if (editor) createTTSNode(editor, pointOf(event)); };
    const audioVideo = (event: Event) => { if (editor) createAudioVideoNode(editor, pointOf(event)); };
    const music = (event: Event) => { if (editor) createMusicNode(editor, pointOf(event)); };
    const cover=(event:Event)=>{if(editor)createCoverNode(editor,pointOf(event));};
    window.addEventListener('frameflow-open-cover',cover);
    const tailVideo=(event:Event)=>{
      const detail=(event as CustomEvent<{sourceId:TLShape["id"];ai?:boolean;point?:Point}>).detail;
      const id=detail?.sourceId;
      const source=id&&editor?.getShape(id);
      if(editor&&source&&(source.type==="h3-node"||source.type==="video-node")){
        if(detail.ai&&tailHDStarts.has(source.id)){showCanvasToast('这个视频的尾帧高清已在处理中');return;}
        if(detail.ai)tailHDStarts.add(source.id);
        void runPortAction(editor,source as CustomNode,detail.point,detail.ai?"last-frame-hd":"last-frame").catch(cause=>showCanvasToast(cause instanceof Error?cause.message:String(cause))).finally(()=>{if(detail.ai)tailHDStarts.delete(source.id);});
      }
    };
    window.addEventListener(OPEN_FLUX_IMAGE_EVENT, open);
    window.addEventListener(OPEN_TTS_EVENT, voice);
    window.addEventListener(OPEN_AUDIO_VIDEO_EVENT, audioVideo);
    window.addEventListener(OPEN_MUSIC_EVENT, music);
    window.addEventListener(OPEN_TAIL_VIDEO_EVENT,tailVideo);
    return () => { window.removeEventListener('frameflow-open-cover',cover);window.removeEventListener(OPEN_FLUX_IMAGE_EVENT, open);window.removeEventListener(OPEN_TTS_EVENT, voice);window.removeEventListener(OPEN_AUDIO_VIDEO_EVENT, audioVideo);window.removeEventListener(OPEN_MUSIC_EVENT, music);window.removeEventListener(OPEN_TAIL_VIDEO_EVENT,tailVideo); };
  }, [editor]);
  const [connectionMenu, setConnectionMenu] = useState<{ sourceId: string; targetId?: string; referenceIds?: ImageNode["id"][]; client: Point; page?: Point } | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [storagePersistence, setStoragePersistence] = useState<StoragePersistence | null>(null);
  useEffect(() => { let live = true; void ensurePersistentStorage().then((state) => { if (live) setStoragePersistence(state); }); return () => { live = false; }; }, []);
  // Daily light backup (canvas + records, no media), about a minute after the canvas is ready, then re-checked hourly for a new day.
  useEffect(() => {
    if (!editor) return;
    const tick = () => { void runDailyBackup(getSnapshot(editor.store).document, { appVersion: "V0.5", persistenceKey: CANVAS_PERSISTENCE_KEY }).catch((cause) => { void logEvent({ level: "warning", category: "backup", title: "每日自动备份没有完成（下个小时再试）", detail: cause instanceof Error ? cause.message : String(cause) }); }); };
    const first = window.setTimeout(tick, 60_000);
    const hourly = window.setInterval(tick, 3_600_000);
    return () => { window.clearTimeout(first); window.clearInterval(hourly); };
  }, [editor]);
  // 硬盘定时轻量快照：每 10 分钟以及页面隐藏/关闭前发送一次，内容未变不重复写盘。
  useEffect(() => {
    if (!editor) return;
    const snap = (keepalive = false) => {
      void runDiskSnapshot(getSnapshot(editor.store).document, { appVersion: "V0.5", persistenceKey: CANVAS_PERSISTENCE_KEY, keepalive }).catch((cause) => {
        void logEvent({ level: "warning", category: "backup", title: "硬盘定时快照写入失败", detail: cause instanceof Error ? cause.message : String(cause) });
      });
    };
    const first = window.setTimeout(() => snap(false), 60_000);
    const periodic = window.setInterval(() => snap(false), DISK_SNAPSHOT_INTERVAL_MS);
    const onVisibility = () => { if (document.visibilityState === "hidden") snap(true); };
    const onPageHide = () => { snap(true); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(periodic);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [editor]);
  const [showBoard, setShowBoard] = useState(false);
  const [showQueue, setShowQueue] = useState(false); // 镜头卡片（含「JSON / 进度」抽屉）开着
  const [cardsIncoming, setCardsIncoming] = useState(0);
  useEffect(() => {
    // The card owner (ShotQueuePanel) asks to be shown (收件箱 *_cards.json) and reports waiting inbox queues for the red dot.
    const show = () => { setShowLibrary(false); setShowBoard(false); setShowErrors(false); setShowKeyframes(false); setShowQueue(true); };
    const incoming = (event: Event) => setCardsIncoming(Number((event as CustomEvent<number>).detail) || 0);
    window.addEventListener("frameflow-show-shot-cards", show); window.addEventListener("frameflow-cards-incoming", incoming);
    return () => { window.removeEventListener("frameflow-show-shot-cards", show); window.removeEventListener("frameflow-cards-incoming", incoming); };
  }, []);
  const [showKeyframes, setShowKeyframes] = useState(false);
  const [pendingQueueText, setPendingQueueText] = useState<string | null>(null);
  const [pendingQueueDelivery, setPendingQueueDelivery] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  useEffect(() => {
    if (!editor) return;
    const host = window as Window & { __ffPendingShotQueue?: Promise<string | null> };
    if (!host.__ffPendingShotQueue) {
      host.__ffPendingShotQueue = fetch("/pending-shot-queue.json", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) return null;
        const text = await response.text();
        return text.includes('"shot-queue-v1"') ? text : null;
      }).catch(() => null);
    }
    let cancelled = false;
    void host.__ffPendingShotQueue.then((text) => {
      if (cancelled || !text) return;
      setShowLibrary(false);
      setShowBoard(false);

      setShowErrors(false);
      setPendingQueueText(text);
      setShowQueue(true);
    });
    return () => { cancelled = true; };
  }, [editor]);
  const [lineageAssetId, setLineageAssetId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState<false | "command" | "search">(false);
  const searchData = useRef<Promise<Omit<SearchData, "nodes">> | null>(null);
  const audioImportInput = useRef<HTMLInputElement>(null);
  // Ctrl/Cmd+K only; tldraw's own shortcuts (plain letters, Ctrl+Z, …) are never intercepted.
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (!isPaletteShortcut(event)) return; event.preventDefault(); event.stopPropagation(); setPaletteOpen((open) => open ? false : "command"); }; window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true); }, []);
  useEffect(() => { const open = (event: Event) => setLineageAssetId((event as CustomEvent<string>).detail); window.addEventListener(OPEN_LINEAGE_EVENT, open); return () => window.removeEventListener(OPEN_LINEAGE_EVENT, open); }, []);
  useEffect(() => {
    if (!editor) return;
    const onRename = (event: Event) => {
      const detail = (event as CustomEvent<{ assetId?: string; filename?: string }>).detail;
      if (detail?.assetId && detail.filename) applyRenamedAsset(editor, detail.assetId, detail.filename);
    };
    window.addEventListener(ASSET_RENAMED_EVENT, onRename);
    return () => window.removeEventListener(ASSET_RENAMED_EVENT, onRename);
  }, [editor]);
  useEffect(() => { if (!editor) return; return maintainCanvasAutomation(editor, automationDeps); }, [editor]);
  // 生产线 page (same origin, opened from the toolbar) reads roles through this read-only bridge.
  useEffect(() => installProductionBridge(), []);
  const logVersion = useLogVersion();
  const unread = useMemo(() => (logVersion >= 0 ? unreadCount() : 0), [logVersion]);
  const libraryPlacements = useRef(0);
  const [replaceTargetId, setReplaceTargetId] = useState<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null); const videoInput = useRef<HTMLInputElement>(null); const insertionPoint = useRef<Point | undefined>(undefined); const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingVideoConnection = useRef<string | null>(null);
  const canvasArea = useRef<HTMLElement>(null);
  const showToast = useCallback((message: string) => { if (toastTone(message) === "error") void logToast(message, "error"); setToast(message); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 2800); }, []);
  const createH3 = useCallback((point?: Point) => { if (!editor) return; const center = point ?? editor.getViewportPageBounds().center; void createH3Node(editor, { x: center.x - H3_NODE_WIDTH / 2, y: center.y - H3_DEFAULT_HEIGHT / 2 }).then((shape) => { if (shape) editor.select(shape.id); editor.setCurrentTool("select"); }).catch((cause) => showCanvasToast(cause instanceof Error ? cause.message : "无法创建镜头")); }, [editor]);
  const handleImageInput = useCallback(async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !editor) return; const point = insertionPoint.current; insertionPoint.current = undefined; try { await addImageFile(editor, file, point); } catch { showToast("图片读取失败"); } }, [editor, showToast]);
  const handleVideoInput = useCallback(async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !editor) { pendingVideoConnection.current = null; return; } const point = insertionPoint.current; insertionPoint.current = undefined; const sourceId = pendingVideoConnection.current; pendingVideoConnection.current = null; try { const video = await addVideoFile(editor, file, point); const source = sourceId ? editor.getShape(sourceId as TLShape["id"]) : undefined; if (video && source?.type === "h3-node") createBoundArrow(editor, source as H3Node, video); } catch (cause) { showToast(cause instanceof Error ? cause.message : "视频导入失败"); } }, [editor, showToast]);
  const handleMount = useCallback((mountedEditor: Editor) => {
    void installCanvasLibraryScope(mountedEditor).catch(cause => showCanvasToast(`角色／素材画布归属初始化失败：${cause instanceof Error ? cause.message : String(cause)}`));
    const onLibraryPageChanged = () => { setShowRoles(false); setShowLibrary(false); setPaletteOpen(false); searchData.current = null; };
    window.addEventListener('frameflow-canvas-library-changed', onLibraryPageChanged);
    setEditor(mountedEditor); mountedEditor.user.updateUserPreferences({ colorScheme: "dark", locale: "zh-cn", inputMode: "mouse" });
    // A workflow edge is an indivisible two-ended connection, not a free-standing arrow.
    const workflowArrows = new Set<TLArrowShape["id"]>();
    const pendingDisconnectedArrows = new Set<TLArrowShape["id"]>();
    const flushDisconnectedArrows = () => {
      for (const arrowId of pendingDisconnectedArrows) {
        pendingDisconnectedArrows.delete(arrowId);
        const arrow = mountedEditor.getShape(arrowId);
        if (arrow?.type !== "arrow") continue;
        const { start, end } = getArrowBindings(mountedEditor, arrow as TLArrowShape);
        if (!start || !end) mountedEditor.deleteShape(arrowId);
        else trackWorkflowArrow(arrowId);
      }
    };
    // tldraw still reads the arrow during handle dragging; remove it only after pointerup.
    let disconnectTimer: number | null = null;
    const onPointerFinish = () => { if (disconnectTimer !== null) window.clearTimeout(disconnectTimer); disconnectTimer = window.setTimeout(() => { disconnectTimer = null; flushDisconnectedArrows(); }, 0); };
    window.addEventListener("pointerup", onPointerFinish);
    window.addEventListener("pointercancel", onPointerFinish);
    const trackWorkflowArrow = (arrowId: TLArrowShape["id"]) => {
      const arrow = mountedEditor.getShape(arrowId);
      if (arrow?.type !== "arrow") return;
      const { start, end } = getArrowBindings(mountedEditor, arrow as TLArrowShape);
      const source = start && mountedEditor.getShape(start.toId);
      const target = end && mountedEditor.getShape(end.toId);
      if (source && target && customTypes.has(source.type) && customTypes.has(target.type)) workflowArrows.add(arrowId);
    };
    for (const candidate of mountedEditor.getCurrentPageShapes()) {
      if (candidate.type !== "arrow") continue;
      const { start, end } = getArrowBindings(mountedEditor, candidate as TLArrowShape);
      if (start && end) trackWorkflowArrow(candidate.id);
      else if ((start && customTypes.has(mountedEditor.getShape(start.toId)?.type ?? "")) || (end && customTypes.has(mountedEditor.getShape(end.toId)?.type ?? ""))) mountedEditor.deleteShape(candidate.id);
    }
    const untrackCreate = mountedEditor.sideEffects.registerAfterCreateHandler("binding", (binding) => { if (binding.type === "arrow") trackWorkflowArrow(binding.fromId); });
    const untrackDelete = mountedEditor.sideEffects.registerAfterDeleteHandler("binding", (binding) => {
      if (binding.type !== "arrow" || !workflowArrows.delete(binding.fromId)) return;
      const arrow = mountedEditor.getShape(binding.fromId);
      if (arrow?.type !== "arrow") return;
      if (mountedEditor.inputs.getIsPointing()) pendingDisconnectedArrows.add(arrow.id);
      else mountedEditor.deleteShape(arrow.id);
    });
    const untrackShape = mountedEditor.sideEffects.registerAfterDeleteHandler("shape", (shape) => { if (shape.type === "arrow") workflowArrows.delete(shape.id); });
    mountedEditor.registerExternalContentHandler("files", async ({ files, point }) => {
      const anchor = point ?? mountedEditor.getViewportPageBounds().center;
      const placeNext = createMediaImportRow(anchor);
      const imported: TLShape["id"][] = [];
      const pageId = mountedEditor.getCurrentPageId();
      for (const file of files) {
        // Do not start the next file after a page switch.
        if (mountedEditor.getCurrentPageId() !== pageId) { showToast("画布已切换，剩余素材未导入"); break; }
        try {
          let node: TLShape | undefined;
          if (["image/jpeg", "image/png", "image/webp"].includes(file.type)) node = await addImageFile(mountedEditor, file, anchor);
          else if (file.type.startsWith("audio/") || /\.m4a$/i.test(file.name)) {
            const asset = await importAssetOnly("audio", file);
            node = await placeAssetOnCanvas(mountedEditor, asset, anchor);
          } else if (file.type === "video/mp4") node = await addVideoFile(mountedEditor, file, anchor);
          else { showToast("支持 JPG、PNG、WEBP 图片、MP4 视频及 M4A 等音频；聊天文件请先下载到本地"); continue; }
          if (node) {
            const size = node.props as { w: number; h: number };
            const at = placeNext(size.w, size.h);
            mountedEditor.updateShape({ id: node.id, type: node.type, parentId: pageId, ...at });
            imported.push(node.id);
          }
        } catch (cause) { showToast(cause instanceof Error ? cause.message : "文件读取失败"); }
      }
      if (imported.length > 1 && mountedEditor.getCurrentPageId() === pageId) {
        mountedEditor.select(...imported);
        mountedEditor.zoomToSelection({ animation: { duration: 200 } });
      }
    });
    for (const shape of mountedEditor.getCurrentPageShapes()) { if (shape.type !== "video-node" || !shape.props.src.startsWith("data:")) continue; void migrateVideoDataUrl(shape.props.src, shape.props.name).then((src) => mountedEditor.updateShape({ id: shape.id, type: shape.type, props: { src } })).catch(() => showToast("旧视频数据恢复失败，请检查文件编码")); }
    for (const candidate of mountedEditor.getCurrentPageShapes()) {
      if (candidate.type !== "arrow") continue;
      const bindings = getArrowBindings(mountedEditor, candidate as TLArrowShape);
      if (!bindings.start || !bindings.end) continue;
      const source = mountedEditor.getShape(bindings.start.toId);
      const target = mountedEditor.getShape(bindings.end.toId);
      if (!source || !target || !customTypes.has(source.type) || !customTypes.has(target.type)) continue;
      if (candidate.props.kind !== "elbow") mountedEditor.updateShape({ id: candidate.id, type: "arrow", props: { kind: "elbow", elbowMidPoint: getWorkflowMidpoint(source as CustomNode, target as CustomNode) } });
    }
    let validating = false;
    const save = watchCanvasSave({ persistenceKey: CANVAS_PERSISTENCE_KEY, onStatus: setSaveLabel });
    const beforeUnload = (event: BeforeUnloadEvent) => { if (save.hasPending()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    const unlisten = mountedEditor.store.listen(({ changes }) => {
      save.changed(changes);
      if (validating) return;
      const candidates = affectedArrowIds(changes, id => mountedEditor.getBindingsToShape(id as TLShape["id"], "arrow").map(binding => binding.fromId));
      const invalid: TLArrowShape["id"][] = [];
      for (const id of candidates) {
        const candidate = mountedEditor.getShape(id as TLShape["id"]);
        if (candidate?.type !== "arrow") continue;
        const { start, end } = getArrowBindings(mountedEditor, candidate as TLArrowShape);
        if (!start || !end) continue;
        const source = mountedEditor.getShape(start.toId), target = mountedEditor.getShape(end.toId);
        if (source && target && customTypes.has(source.type) && customTypes.has(target.type) && !isCompatibleConnection(source, target)) invalid.push(candidate.id);
      }
      if (invalid.length) {
        validating = true;
        try { mountedEditor.deleteShapes(invalid); } finally { validating = false; }
        showToast("已移除不兼容的节点连线");
      }
    }, { scope: "document" });
    const onToast = (event: Event) => showToast((event as CustomEvent<string>).detail); window.addEventListener("canvas-toast", onToast);
    return () => { window.removeEventListener('frameflow-canvas-library-changed', onLibraryPageChanged); unlisten(); untrackCreate(); untrackDelete(); untrackShape(); save.close(); window.removeEventListener("beforeunload", beforeUnload); if (disconnectTimer !== null) window.clearTimeout(disconnectTimer); window.removeEventListener("pointerup", onPointerFinish); window.removeEventListener("pointercancel", onPointerFinish); window.removeEventListener("canvas-toast", onToast); };
  }, [showToast]);
  useEffect(() => {
    const onDrop = (event: Event) => { const detail = (event as CustomEvent<{ sourceId: string; client: Point; page: Point }>).detail; setConnectionMenu(detail); };
    const onChoice = (event: Event) => { const detail = (event as CustomEvent<{ sourceId: string; targetId: string; client: Point }>).detail; setConnectionMenu(detail); };
    window.addEventListener("frameflow-port-drop", onDrop);
    window.addEventListener("frameflow-port-choice", onChoice);
    return () => { window.removeEventListener("frameflow-port-drop", onDrop); window.removeEventListener("frameflow-port-choice", onChoice); };
  }, []);
  const handleDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!editor || !Array.from(event.dataTransfer.items).some((item) => item.kind === "file" && (!item.type || ["image/jpeg", "image/png", "image/webp"].includes(item.type)))) { setReplaceTargetId(null); return; }
    const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
    const target = editor.getShapeAtPoint(point, { hitInside: true });
    setReplaceTargetId(target?.type === "image-node" ? target.id : null);
  };
  const handleDropReplace = (event: React.DragEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest("[data-flux-input]")) { setReplaceTargetId(null); return; }
    const target = replaceTargetId ? editor?.getShape(replaceTargetId as TLShape["id"]) : undefined;
    setReplaceTargetId(null);
    if (!editor || target?.type !== "image-node") return;
    const file = Array.from(event.dataTransfer.files).find((candidate) => ["image/jpeg", "image/png", "image/webp"].includes(candidate.type));
    if (!file) return;
    event.preventDefault(); event.stopPropagation();
    void replaceImageFile(editor, target as ImageNode, file).then(() => showToast("图片已原位替换，连接保持不变")).catch((cause) => showToast(cause instanceof Error ? cause.message : "图片替换失败"));
  };
  useEffect(() => {
    const element = canvasArea.current;
    if (!element || !editor) return;
    let lastBlankPointer: { x: number; y: number; time: number } | null = null;
    let suppressUntil = 0;
    const isBlankTarget = (target: EventTarget | null) => target instanceof HTMLElement && !target.closest("[data-node-shell],button,input,textarea,select,video,.tlui-menu,.tlui-toolbar,.tl-selection__fg");
    const blockEvent = (event: Event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !isBlankTarget(event.target)) return;
      // The creative dock is portaled outside tldraw. Clicking back onto the
      // canvas must restore its keyboard focus (Undo / Delete / shortcuts).
      editor.focus();
      const now = performance.now();
      const isSecondClick = lastBlankPointer && now - lastBlankPointer.time < 420 && Math.hypot(event.clientX - lastBlankPointer.x, event.clientY - lastBlankPointer.y) < 8;
      if (isSecondClick) {
        suppressUntil = now + 520;
        lastBlankPointer = null;
        blockEvent(event);
        setQuickMenu({ client: { x: event.clientX, y: event.clientY }, page: editor.screenToPage({ x: event.clientX, y: event.clientY }) });
      } else lastBlankPointer = { x: event.clientX, y: event.clientY, time: now };
    };
    const handleSuppressedMouseEvent = (event: MouseEvent) => { if (performance.now() < suppressUntil && isBlankTarget(event.target)) blockEvent(event); };
    const handleDoubleClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (!isBlankTarget(event.target)) return;
      blockEvent(event);
      editor.cancel();
      setQuickMenu({ client: { x: event.clientX, y: event.clientY }, page: editor.screenToPage({ x: event.clientX, y: event.clientY }) });
    };
    element.addEventListener("pointerdown", handlePointerDown, { capture: true });
    element.addEventListener("click", handleSuppressedMouseEvent, { capture: true });
    element.addEventListener("dblclick", handleDoubleClick, { capture: true });
    return () => {
      element.removeEventListener("pointerdown", handlePointerDown, { capture: true });
      element.removeEventListener("click", handleSuppressedMouseEvent, { capture: true });
      element.removeEventListener("dblclick", handleDoubleClick, { capture: true });
    };
  }, [editor]);
  const chooseQuickAction = (kind: "image" | "h3" | "video" | "flux" | "translation" | "tts" | "audio-video" | "music" | "cover") => { if (!quickMenu) return; if(kind==='cover'){if(editor)createCoverNode(editor,quickMenu.page);} else if(kind==='audio-video'){if(editor)createAudioVideoNode(editor,quickMenu.page);} else if(kind==='music'){if(editor)createMusicNode(editor,quickMenu.page);} else if(kind==='tts'){if(editor)createTTSNode(editor,quickMenu.page);} else if(kind==='translation'){if(editor)createTranslationNode(editor,quickMenu.page);} else if (kind === "flux") { if (editor) createFluxImageNode(editor, quickMenu.page); } else { insertionPoint.current = quickMenu.page; if (kind === "h3") createH3(quickMenu.page); else (kind === "image" ? imageInput.current : videoInput.current)?.click(); } setQuickMenu(null); };
  const chooseConnectionAction = (action: "first" | "last" | "reference" | "create-h3" | "create-flux" | "last-frame-video" | "upscale" | "upscale-720" | "upscale-60" | "smooth" | "import-video") => {
    if (!connectionMenu || !editor) return;
    const rawSource = editor.getShape(connectionMenu.sourceId as TLShape["id"]);
    const source = (referenceImageOf(rawSource) ?? rawSource) as CustomNode | undefined;
    if (!source) { setConnectionMenu(null); return; }
    if (action === "create-flux" && source.type === "image-node") {
      const point = connectionMenu.page ?? { x: source.x + source.props.w + 130, y: source.y };
      const id = createFluxImageNode(editor, { x: point.x + 150, y: point.y + 225 });
      const original = editor.getShape(source.id);
      const previous = original?.type === "flux-image-node" ? original as FluxImageNode : undefined;
      const width = source.props.naturalWidth ?? 1024, height = source.props.naturalHeight ?? 1536;
      const scale = Math.min(1, 1536 / Math.max(width, height));
      editor.updateShape({ id, type: "flux-image-node", props: { imageMode: true, inputSrc: source.props.src, inputName: source.props.name, size: `${Math.max(256, Math.round(width * scale / 16) * 16)}x${Math.max(256, Math.round(height * scale / 16) * 16)}`, fluxVersion: "dev", steps: previous?.props.fluxVersion === "dev" ? previous.props.steps ?? 24 : 24, cfg: 1, guidance: previous?.props.guidance ?? 3.5, editMode: "img2img", sampler: previous?.props.sampler ?? "euler", scheduler: previous?.props.scheduler ?? "simple", imageDenoise: previous?.props.fluxVersion === "dev" ? previous.props.imageDenoise ?? 0.5 : 0.5 } });
      createBoundArrow(editor, source, editor.getShape(id) as FluxImageNode);
      showToast("已创建独立图生图节点，原图保留");
    } else if (connectionMenu.targetId && (action === "first" || action === "last" || action === "reference")) {
      const target = editor.getShape(connectionMenu.targetId as TLShape["id"]);
      if (target?.type === "h3-node" && source.type === "image-node") createBoundArrow(editor, source, target as H3Node, action);
      else if (target && (source.type === "video-node" || source.type === "h3-node") && action !== "reference") void handoffVideoFrame(editor, source.id, target.id, action).catch(cause => showToast(cause instanceof Error ? cause.message : "连接视频帧失败"));
    } else if (action === "create-h3" && source.type === "image-node") void runPortAction(editor, source, connectionMenu.page, undefined, connectionMenu.referenceIds).catch((cause) => showToast(String(cause)));
    else if (action === "last-frame-video" && (source.type === "video-node" || source.type === "h3-node")) void runPortAction(editor, source, connectionMenu.page, "last-frame").catch((cause) => showToast(String(cause)));
    else if ((action === "upscale" || action === "upscale-720" || action === "upscale-60") && (source.type === "video-node" || source.type === "h3-node")) createUpscaleNode(editor, connectionMenu.page ?? { x: source.x + source.props.w + 130, y: source.y }, source, action === "upscale-720" ? "720p" : "1080p", action === "upscale-60");
    else if (action === "smooth" && (source.type === "video-node" || source.type === "h3-node")) createSmoothNode(editor, connectionMenu.page ?? { x: source.x + source.props.w + 130, y: source.y }, source);
    else if (action === "import-video" && source.type === "h3-node") { pendingVideoConnection.current = source.id; insertionPoint.current = connectionMenu.page; videoInput.current?.click(); }
    setConnectionMenu(null);
  };
  const chooseAddAction = (kind: "image" | "h3" | "video" | "text" | "tts" | "audio-video" | "music" | "cover") => { if (!editor) return; insertionPoint.current = undefined; if(kind==="cover") createCoverNode(editor); else if (kind === "audio-video") createAudioVideoNode(editor); else if (kind === "music") createMusicNode(editor); else if (kind === "tts") createTTSNode(editor); else if (kind === "h3") createH3(); else if (kind === "text") { editor.setCurrentTool("text"); showToast("文本工具已启用，在画布上点击输入"); } else (kind === "image" ? imageInput.current : videoInput.current)?.click(); setAddMenuOpen(false); };
  const openDrawer = (drawer: "library" | "board" | "errors") => { setShowLibrary(drawer === "library"); setShowBoard(drawer === "board"); setShowErrors(drawer === "errors"); };
  const paletteCommands: PaletteAction[] = editor ? [
    { id: "new-h3", group: "创建", label: "新建 H3 节点", hint: "图生视频 / 多参考", keywords: ["h3", "xinjian", "shengcheng", "视频"], run: () => createH3() },
    { id: "new-music", group: "创建", label: "AI 作歌 · MiniMax Music 3", hint: "歌曲 / 配乐 / 歌词", keywords: ["music","作歌","音乐","配乐"], run: () => createMusicNode(editor) },
    { id: "new-tts", group: "创建", label: "AI音色设计 · 试听选角", hint: "文字设计音色 / 试听选角", keywords: ["tts", "voice", "配音", "文生配音", "音色设计"], run: () => createTTSNode(editor) },
    { id: "new-text", group: "创建", label: "新建文本", keywords: ["text", "wenben"], run: () => chooseAddAction("text") },
    { id: "import-image", group: "创建", label: "导入图片", hint: "JPG / PNG / WEBP", keywords: ["image", "tupian", "daoru"], run: () => chooseAddAction("image") },
    { id: "import-video", group: "创建", label: "导入视频", hint: "MP4", keywords: ["video", "shipin", "daoru"], run: () => chooseAddAction("video") },
    { id: "import-audio", group: "创建", label: "导入声音", hint: "入库并放到画布", keywords: ["audio", "shengyin", "daoru", "wav"], run: () => audioImportInput.current?.click() },
    { id: "open-library", group: "面板", label: "打开素材库", keywords: ["asset", "sucai", "library"], run: () => openDrawer("library") },
    { id: "open-roles", group: "面板", label: "打开角色库", keywords: ["role", "juese"], run: () => setShowRoles(true) },
    { id: "open-board", group: "面板", label: "打开镜头板", keywords: ["shot", "board", "jingtou", "ban", "chengpian", "qingdan"], run: () => openDrawer("board") },
    { id: "open-shot-queue", group: "面板", label: "打开镜头卡片 · JSON / 进度", hint: "原「队列」：粘贴 / 载入 JSON、入队、排队进度、停止", keywords: ["queue", "duilie", "piliang", "ref2va", "zhangjie", "kapian", "json", "jindu"], run: () => { setShowLibrary(false); setShowBoard(false); setShowErrors(false); setShowKeyframes(false); setShowQueue(true); window.dispatchEvent(new Event("frameflow-open-queue-drawer")); } },
    { id: "open-production", group: "面板", label: "打开生产线（整集批量）", hint: "分镜 → 关键帧 → 审片 → H3 视频 → 成片，后台执行", keywords: ["production", "shengchanxian", "piliang", "guanjianzhen", "chengpian"], run: () => { window.open("/__production/", "frameflow-production"); } },
    { id: "open-diagnostics", group: "面板", label: "打开诊断中心", keywords: ["diagnostic", "zhenduan", "tijian"], run: () => setShowDiagnostics(true) },
    { id: "open-errors", group: "面板", label: "打开错误中心", keywords: ["error", "log", "cuowu", "rizhi"], run: () => openDrawer("errors") },
    { id: "open-backup", group: "面板", label: "打开项目备份", keywords: ["backup", "beifen", "export", "import"], run: () => setShowBackup(true) },
    { id: "canvas-rough-cut", group: "剪辑", label: "一键粗剪选中视频", keywords: ["粗剪","剪辑","cut"], run: ()=>window.dispatchEvent(new Event(OPEN_CANVAS_ROUGH_CUT)) },
    { id: "zoom-fit", group: "视图", label: "适应画布", hint: "Shift+1", keywords: ["fit", "shiying", "quanbu"], run: () => { editor.zoomToFit({ animation: { duration: 240 } }); } },
    { id: "zoom-selection", group: "视图", label: "聚焦选中节点", hint: "Shift+2", keywords: ["focus", "juji", "selection"], disabled: editor.getSelectedShapeIds().length === 0, run: () => { editor.zoomToSelection({ animation: { duration: 240 } }); } },
    { id: "zoom-100", group: "视图", label: "缩放至 100%", hint: "Shift+0", keywords: ["zoom", "100"], run: () => { editor.resetZoom(editor.getViewportScreenCenter(), { animation: { duration: 200 } }); } },
  ] : [];
  /** Phase 16: records are read once per palette session; canvas nodes are read live. */
  const canvasNodes = (): CanvasNodeInfo[] => editor ? editor.getCurrentPageShapes().filter((shape) => customTypes.has(shape.type)).map((shape) => {
    const props = shape.props as { name?: string; prompt?: string; assetId?: string; shotId?: string };
    const title = shape.type === "h3-node" ? (props.prompt?.trim() ? `H3 · ${props.prompt.trim().slice(0, 40)}` : "H3 图生视频") : shape.type === "upscale-node" ? "视频高清增强" : shape.type === "smooth-node" ? "流畅增强" : props.name ?? "";
    return { id: shape.id, type: shape.type, title, assetId: props.assetId, shotId: props.shotId };
  }) : [];
  const runSearchResult = (result: SearchResult) => {
    if (!editor) return;
    const locateNode = (nodeId: string) => { const node = editor.getShape(nodeId as TLShape["id"]); if (!node) return false; editor.select(node.id); editor.zoomToSelection({ animation: { duration: 240 } }); return true; };
    const target = result.target;
    if (target.kind === "node") { if (!locateNode(target.nodeId)) showToast("该节点已不在画布上"); }
    else if (target.kind === "asset") { if (!locateAssetOnCanvas(editor, target.assetId)) { openLineage(target.assetId); showToast("该素材不在画布上，已打开血缘查看"); } }
    else if (target.kind === "shot") { if (!(target.adoptedAssetId && locateAssetOnCanvas(editor, target.adoptedAssetId))) { openDrawer("board"); if (target.adoptedAssetId) showToast("采用版本不在画布上，已打开镜头板"); } }
    else if (target.kind === "role") setShowRoles(true);
    else if (target.outputAssetId) { if (!locateAssetOnCanvas(editor, target.outputAssetId)) openLineage(target.outputAssetId); }
    else showToast(`该 Run 没有输出（${result.detail}）`);
  };
  const paletteSearch = async (query: string): Promise<PaletteResult[]> => {
    if (!searchData.current) searchData.current = Promise.all([listAssets(), listRuns(), listShots(), listRoleRecords()]).then(([assets, runs, shots, roles]) => ({ assets, runs, shots, roles }));
    const results = searchAll({ ...(await searchData.current), nodes: canvasNodes() }, query);
    return results.map((result) => ({ id: result.id, group: result.group, label: result.label, detail: result.detail, run: () => runSearchResult(result) }));
  };
  // Stable identity for the palette (its search effect should re-run on typing, not on every canvas render).
  const paletteSearchRef = useRef(paletteSearch);
  useEffect(() => { paletteSearchRef.current = paletteSearch; });
  const stablePaletteSearch = useCallback((query: string) => paletteSearchRef.current(query), []);
  const handleAudioImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || !editor) return;
    try { const asset = await importAssetOnly("audio", file); await placeAssetOnCanvas(editor, asset, editor.getViewportPageBounds().center); showToast(`已导入声音：${asset.filename}`); }
    catch (cause) { showToast(cause instanceof Error ? cause.message : "声音导入失败"); }
  };

  return <CanvasSaveStatusContext.Provider value={saveLabel}><main className="workspace" onPointerDown={() => { if (quickMenu) setQuickMenu(null); if (connectionMenu) setConnectionMenu(null); if (addMenuOpen) setAddMenuOpen(false); if (moreMenuOpen) setMoreMenuOpen(false); }}>
    <header className="app-bar"><div className="app-bar-left"><div className="brand"><div className="brand-mark"><Film size={15} /></div><strong>Frameflow</strong></div>{editor && <CanvasLibrary editor={editor} persistenceKey={CANVAS_PERSISTENCE_KEY}/>}</div><nav className="header-nav" aria-label="面板"><button type="button" className="role-entry has-badge" aria-pressed={showQueue} title={`卡片（镜头卡片）：渲染前逐镜检查剧情、运镜、参考图、外观、声音，找写错和漏写；顶栏「JSON / 进度」里粘贴 / 载入队列、入队、看排队进度、停止${cardsIncoming > 0 ? `。收件箱来了 ${cardsIncoming} 份新队列等你切换` : ""}`} onClick={() => { setShowLibrary(false); setShowBoard(false); setShowErrors(false); setShowKeyframes(false); setShowQueue(true); window.dispatchEvent(new Event("frameflow-open-shot-cards")); }}><LayoutGrid size={14} />卡片{cardsIncoming > 0 && !showQueue && <span className="header-badge cards-dot" aria-label="收件箱有新队列" />}</button><button type="button" className="role-entry" aria-pressed={showLibrary} onClick={() => { setShowBoard(false); setShowErrors(false); setShowQueue(false); setShowKeyframes(false); setShowLibrary((open) => !open); }}><FolderOpen size={14} />素材</button><button type="button" className="role-entry" onClick={() => setShowRoles(true)}><Users size={14} />角色</button><DirectorStageEntry onSendToH3={editor ? (plan) => sendDirectorPlanToH3(editor, plan) : undefined} onSendShotToH3={editor ? (shotId, plan) => sendDirectorShotToH3(editor, shotId, plan) : undefined} onImportImage={(file) => importAssetOnly("image", file)} /></nav><div className="header-tools"><button type="button" className="role-entry icon-only" title="搜索与命令（Ctrl / ⌘ + K）" aria-label="搜索与命令" onClick={() => setPaletteOpen("command")}><SearchIcon size={14} /></button><button type="button" className="role-entry has-badge" title="更多：镜头板、批量关键帧、生产线、备份、诊断、错误记录" aria-haspopup="menu" aria-expanded={moreMenuOpen} onPointerDown={(event) => event.stopPropagation()} onClick={() => setMoreMenuOpen((open) => !open)}><MoreHorizontal size={14} />更多{unread > 0 ? <span className="header-badge" aria-label={`${unread} 条未读错误`}>{unread > 99 ? "99+" : unread}</span> : storagePersistence !== null && !isPersistent(storagePersistence) ? <span className="header-badge" aria-label="浏览器未允许持久保存">!</span> : null}</button><LocalSystemStatus /><span className="save-state" title={saveLabel}>{saveLabel}</span><InstanceChrome editor={editor} /></div></header>
    <section ref={canvasArea} className="canvas-area" onDragOverCapture={handleDragOver} onDragLeave={() => setReplaceTargetId(null)} onDropCapture={handleDropReplace}>{replaceTargetId && <style>{`.tl-shape[data-shape-id="${replaceTargetId}"] .node-shell{outline:3px solid var(--ff-ok)!important;box-shadow:0 0 0 8px rgba(143,184,156,0.15)!important;}`}</style>}<Tldraw overrides={canvasInteractionOverrides} shapeUtils={shapeUtils} components={canvasUiComponents} persistenceKey={CANVAS_PERSISTENCE_KEY} onMount={handleMount} maxAssetSize={60 * 1024 * 1024} options={tldrawOptions} /></section>
    {moreMenuOpen && <div className="canvas-quick-menu header-more-menu" role="menu" onPointerDown={(event) => event.stopPropagation()}><b>更多</b><button type="button" role="menuitem" title="镜头板：镜头 / 候选 / ★采用" onClick={() => { setMoreMenuOpen(false); setShowLibrary(false); setShowErrors(false); setShowQueue(false); setShowKeyframes(false); setShowBoard(true); }}><Clapperboard size={15} />镜头板</button><button type="button" role="menuitem" title="批量关键帧：一张母版按顺序串行图生图，只出静帧" onClick={() => { setMoreMenuOpen(false); setShowLibrary(false); setShowBoard(false); setShowErrors(false); setShowQueue(false); setShowKeyframes(true); }}><ImageIcon size={15} />批量关键帧</button><button type="button" role="menuitem" title="生产线：分镜 → 关键帧（自动按人脸打分）→ 审过才出 H3 视频 → 整集成片；后台执行，关掉画布也继续" onClick={() => { setMoreMenuOpen(false); window.open("/__production/", "frameflow-production"); }}><ListVideo size={15} />生产线</button><button type="button" role="menuitem" title={`项目备份 · ${persistenceLabel(storagePersistence)}`} onClick={() => { setMoreMenuOpen(false); setShowBackup(true); }}><Archive size={15} />备份{storagePersistence !== null && !isPersistent(storagePersistence) && <small>未允许持久保存</small>}</button><button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); setShowDiagnostics(true); }}><Stethoscope size={15} />诊断中心</button><button type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); setShowLibrary(false); setShowBoard(false); setShowErrors(true); }}><Bug size={15} />错误中心{unread > 0 && <small>{unread > 99 ? "99+" : unread} 条未读</small>}</button></div>}
    <div className="add-dock" onPointerDown={(event) => event.stopPropagation()}><button type="button" className="add-dock-trigger" aria-label="添加素材或节点" aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen((open) => !open)}><Plus size={19} /></button>{addMenuOpen && <div className="add-dock-menu"><b>添加</b><button type="button" onClick={() => chooseAddAction("cover")}><Sparkles size={15} /><span>AI短剧封面</span></button><button type="button" onClick={() => chooseAddAction("music")}><Mic2 size={15} /><span>AI 作歌</span></button><button type="button" onClick={() => chooseAddAction("tts")}><Mic2 size={15} /><span>文生配音</span></button><button type="button" onClick={() => chooseAddAction("image")}><ImageIcon size={15} /><span>导入图片</span></button><button type="button" onClick={() => chooseAddAction("video")}><Video size={15} /><span>导入视频</span></button><button type="button" onClick={() => chooseAddAction("h3")}><WandSparkles size={15} /><span>H3 图生视频</span></button><button type="button" onClick={() => chooseAddAction("text")}><FileText size={15} /><span>文本</span></button></div>}</div>
    <input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={handleImageInput} /><input ref={audioImportInput} type="file" accept="audio/*,.m4a" hidden onChange={(event) => void handleAudioImport(event)} /><input ref={videoInput} type="file" accept="video/mp4" hidden onChange={handleVideoInput} />
    {quickMenu && <div className="canvas-quick-menu" style={{ left: quickMenu.client.x, top: quickMenu.client.y }} onPointerDown={(event) => event.stopPropagation()}><b>快速创建</b><button type="button" onClick={() => chooseQuickAction("cover")}><Sparkles size={15} />AI短剧封面</button><button type="button" onClick={() => chooseQuickAction("music")}><Mic2 size={15} />AI 作歌 · MiniMax Music 3</button><button type="button" onClick={() => chooseQuickAction("tts")}><Mic2 size={15} />AI音色设计 · 试听选角</button><button type="button" onClick={() => chooseQuickAction("image")}><ImageIcon size={15} />导入图片</button><button type="button" onClick={() => chooseQuickAction("flux")}><Sparkles size={15} />文生图 · Flux Dev</button><button type="button" onClick={() => chooseQuickAction("h3")}><WandSparkles size={15} />H3 视频</button><button type="button" onClick={() => chooseQuickAction("translation")}><FileText size={15} />中英翻译</button><button type="button" onClick={() => chooseQuickAction("video")}><Video size={15} />导入 MP4</button></div>}
{connectionMenu && editor && <div className="canvas-quick-menu" style={{ left: connectionMenu.client.x, top: connectionMenu.client.y }} onPointerDown={(event) => event.stopPropagation()}><b>{connectionMenu.targetId ? "连接为" : "下一步做什么？"}</b>{connectionMenu.targetId ? <><button type="button" onClick={() => chooseConnectionAction("first")}>首帧</button><button type="button" onClick={() => chooseConnectionAction("last")}>尾帧</button>{referenceImageOf(editor.getShape(connectionMenu.sourceId as TLShape["id"])) && <button type="button" onClick={() => chooseConnectionAction("reference")}>参考图</button>}</> : referenceImageOf(editor.getShape(connectionMenu.sourceId as TLShape["id"])) ? <><button type="button" onClick={() => chooseConnectionAction("create-flux")}><ImageIcon size={15} />图生图 · Flux Dev</button><button type="button" onClick={() => chooseConnectionAction("create-h3")}><WandSparkles size={15} />H3 视频</button></> : editor.getShape(connectionMenu.sourceId as TLShape["id"])?.type === "video-node" ? <><button type="button" onClick={() => chooseConnectionAction("last-frame-video")} title="提取最后一帧作为首帧，生成独立新片段"><ImageIcon size={15} />尾帧做视频</button><button type="button" onClick={() => {window.dispatchEvent(new CustomEvent(OPEN_TAIL_VIDEO_EVENT,{detail:{sourceId:connectionMenu.sourceId,ai:true,point:connectionMenu.page}}));setConnectionMenu(null);}} title="先用 SeedVR2 增强原始尾帧，再建立独立视频节点"><Sparkles size={15} />尾帧＋AI 高清做视频</button><button type="button" onClick={() => chooseConnectionAction("upscale")}><Sparkles size={15} />提升至1080P</button><button type="button" onClick={() => chooseConnectionAction("upscale-720")}><Sparkles size={15} />提升至720P</button><button type="button" onClick={() => chooseConnectionAction("upscale-60")} title="自动排队：先1080P高清，再插帧60 FPS，只输出最终视频"><Sparkles size={15} />1080P＋60 FPS</button><button type="button" onClick={() => chooseConnectionAction("smooth")}><Film size={15} />流畅增强</button></> : editor.getShape(connectionMenu.sourceId as TLShape["id"])?.type === "h3-node" ? <><button type="button" onClick={() => chooseConnectionAction("last-frame-video")} title="提取最后一帧作为首帧，生成独立新片段"><ImageIcon size={15} />尾帧做视频</button><button type="button" onClick={() => {window.dispatchEvent(new CustomEvent(OPEN_TAIL_VIDEO_EVENT,{detail:{sourceId:connectionMenu.sourceId,ai:true,point:connectionMenu.page}}));setConnectionMenu(null);}} title="先用 SeedVR2 增强原始尾帧，再建立独立视频节点"><Sparkles size={15} />尾帧＋AI 高清做视频</button><button type="button" onClick={() => chooseConnectionAction("upscale")}><Sparkles size={15} />提升至1080P</button><button type="button" onClick={() => chooseConnectionAction("upscale-720")}><Sparkles size={15} />提升至720P</button><button type="button" onClick={() => chooseConnectionAction("upscale-60")} title="自动排队：先1080P高清，再插帧60 FPS，只输出最终视频"><Sparkles size={15} />1080P＋60 FPS</button><button type="button" onClick={() => chooseConnectionAction("smooth")}><Film size={15} />流畅增强（插帧）</button></> : null}</div>}
    {toast && (() => { const tone = toastTone(toast); return <div className={`toast tone-${tone}`} role={tone === "error" ? "alert" : "status"}><span>{tone === "error" ? <CircleX size={16} /> : tone === "warning" ? <CircleAlert size={16} /> : tone === "success" ? <CircleCheck size={16} /> : <Sparkles size={16} />}</span>{toast}</div>; })()}
    {showLibrary && editor && <CanvasPanelBoundary name="素材库" onClose={() => setShowLibrary(false)}><AssetLibrary onClose={() => setShowLibrary(false)} onImport={importAssetOnly} onPlace={async (asset) => { const center = editor.getViewportPageBounds().center; const step = (libraryPlacements.current++ % 6) * 36; await placeAssetOnCanvas(editor, asset, { x: center.x - 120 + step, y: center.y + step }); }} /></CanvasPanelBoundary>}
    {showBoard && editor && <CanvasPanelBoundary name="镜头板" onClose={() => setShowBoard(false)}><ShotBoard onClose={() => setShowBoard(false)} onLocate={(asset) => locateAssetOnCanvas(editor, asset.assetId)} /></CanvasPanelBoundary>}
    {editor && <ShotQueueRecovery editor={editor} />}
    {editor && <InboxAutorun editor={editor} onImportImage={(file) => importAssetOnly("image", file)} onQueue={(text, deliveryId) => { setShowLibrary(false); setShowBoard(false); setShowErrors(false); setPendingQueueText(text); setPendingQueueDelivery(deliveryId??null); setShowQueue(true); }} />}
    {editor && <InboxControlBar />}
    {editor && <div style={{ display: showQueue ? "contents" : "none" }}><ShotQueuePanel visible={showQueue} editor={editor} persistenceKey={CANVAS_PERSISTENCE_KEY} autoSubmitText={pendingQueueText} autoSubmitRequestId={pendingQueueDelivery} onClose={() => setShowQueue(false)} origin={() => editor.getViewportPageBounds().center} focusNode={(id, moveCamera = false) => { const shape = editor.getShape(id as TLShape["id"]); if (!shape) return; editor.select(shape.id); if (moveCamera) editor.zoomToSelection({ animation: { duration: 220 } }); }} createNode={(props, point,signal) => createH3Node(editor, point, props,undefined,signal)} /></div>}
    {editor && <div style={{ display: showKeyframes ? "contents" : "none" }}><KeyframeBatchPanel visible={showKeyframes} editor={editor} onClose={() => setShowKeyframes(false)} /></div>}
    {editor && <CanvasDemix editor={editor} resolveSource={resolveCanvasCutSource} />}
    {editor && <RevealNodeFile editor={editor} resolveAsset={resolveRevealAsset} />}
    {editor && <CopyVideoList editor={editor} resolveAsset={resolveRevealAsset} />}
    {editor && <CanvasRoughCut editor={editor} resolveSource={resolveCanvasCutSource} onReady={(asset)=>void placeRoughCut(editor,asset)} />}
    {editor && <VideoFrameCapture editor={editor} resolveSource={resolveCanvasCutSource} place={async(asset,sourceId)=>{
      const source=editor.getShapePageBounds(sourceId);if(!source)throw Error('原视频节点已删除，截图保留在素材库');
      const size=imageNodeSize(asset.width!,asset.height!);
      const prior=editor.getCurrentPageShapes().filter(s=>s.meta.frameCaptureFor===sourceId).flatMap(s=>{const b=editor.getShapePageBounds(s);return b?[{x:b.x,y:b.y,w:b.w,h:b.h}]:[];});
      const point=batchOutputPosition(source,size,prior);
      const node=await createImageNodeForAsset(editor,asset,{x:point.x+size.w/2,y:point.y+size.h/2});
      editor.updateShape({id:node.id,type:node.type,meta:{...node.meta,frameCaptureFor:sourceId}});editor.select(node.id);
    }}/>}
    {editor && <CanvasTools editor={editor} persistenceKey={CANVAS_PERSISTENCE_KEY} resolveSource={resolveCanvasCutSource} />}
    {showDiagnostics && <CanvasPanelBoundary name="诊断" onClose={() => setShowDiagnostics(false)}><DiagnosticsPanel onClose={() => setShowDiagnostics(false)} /></CanvasPanelBoundary>}
    {paletteOpen && editor && <CanvasPanelBoundary name="搜索与命令" onClose={() => setPaletteOpen(false)}><CommandPalette commands={paletteOpen === "search" ? [] : paletteCommands} search={stablePaletteSearch} placeholder={paletteOpen === "search" ? "搜索节点、文件名、镜头编号、角色、Run ID，或输入“已采用”“候选”…" : undefined} onClose={() => { setPaletteOpen(false); searchData.current = null; }} /></CanvasPanelBoundary>}
    {lineageAssetId && editor && <CanvasPanelBoundary name="素材来源" onClose={() => setLineageAssetId(null)}><LineageViewer assetId={lineageAssetId} onClose={() => setLineageAssetId(null)} onLocate={(assetId) => locateAssetOnCanvas(editor, assetId)} /></CanvasPanelBoundary>}
    {showErrors && editor && <CanvasPanelBoundary name="错误中心" onClose={() => setShowErrors(false)}><ErrorCenter onClose={() => setShowErrors(false)} onLocateNode={(nodeId) => { const node = editor.getShape(nodeId as TLShape["id"]); if (!node) return false; editor.select(node.id); editor.zoomToSelection({ animation: { duration: 220 } }); return true; }} /></CanvasPanelBoundary>}
    {showBackup && editor && <CanvasPanelBoundary name="备份" onClose={() => setShowBackup(false)}><ProjectBackupPanel appVersion="V0.5" persistenceKey={CANVAS_PERSISTENCE_KEY} persistence={storagePersistence} canvas={{ current: () => getSnapshot(editor.store).document, load: (document) => loadSnapshot(editor.store, { document: document as ReturnType<typeof getSnapshot>["document"] }) }} onClose={() => setShowBackup(false)} /></CanvasPanelBoundary>}
    {showRoles && <CanvasPanelBoundary name="角色库" onClose={() => setShowRoles(false)}><RoleLibrary onClose={() => setShowRoles(false)} onUpload={async (kind, file) => { if (kind === "image" && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("请选择 JPG、PNG 或 WEBP 图片"); if (kind === "audio" && !file.type.startsWith("audio/") && !/\.m4a$/i.test(file.name)) throw new Error("请选择音频文件"); const source = kind === "image" ? await storeLocalImage(file, file.name) : await storeLocalAudio(file, file.name); return importedAsset(source, kind, file); }} /></CanvasPanelBoundary>}
  </main></CanvasSaveStatusContext.Provider>;
}
