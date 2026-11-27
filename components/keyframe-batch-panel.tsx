"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { createShapeId, useValue, type Editor, type TLShape } from "tldraw";
import type { FluxImageNode } from "@/components/canvas/flux-image-node";
import { CanvasPanelBoundary, GuardedPanelRender } from "@/components/canvas-error-boundary";
import { copyPlainText } from "@/lib/copy-plain-text";
import { isTypingTarget } from "@/lib/keyboard-guards";
import { runFluxDev, waitForFluxDev } from "@/lib/comfyui/flux-dev";
import { SHEET_FACE_CLOSEUP, SHEET_FRONT_BODY, pixelCrop, type NormalizedCrop } from "@/lib/character-sheet-crop";
import { getLocalImageBlob, storeLocalImage } from "@/lib/local-video-store";
import { registerAsset } from "@/lib/production-records";
import { setRoleStillReferences } from "@/lib/role-records";
import { KEYFRAME_FLUX, KEYFRAME_INPUT_CHAIN, KEYFRAME_INPUT_MASTER, KEYFRAME_STILL, keyframeBatchExample, parseKeyframeBatch, planKeyframeChain, runKeyframeBatch, type KeyframeBatchDocument, type KeyframeInputMode, type KeyframeReceipt, type KeyframeRunStatus, type KeyframeSource, type KeyframeStepPlan, type KeyframeStill } from "@/lib/keyframe-batch";
import { STORYBOARD_FLUX, STORYBOARD_SIZES, isStoryboardDocument, keyframeStoryboardExample, parseKeyframeStoryboard, planStoryboardBatch, storyboardPromptWarnings, type KeyframeStoryboardDocument, type StoryboardStep } from "@/lib/keyframe-storyboard";
import { identityBodyDenoise, identityDispatch, identityFaceWeight, isIdentityDocument, keyframeIdentityExample, parseKeyframeIdentity, planIdentityBatch, type IdentitySessionFrame, type IdentityStep, type KeyframeIdentityDocument } from "@/lib/keyframe-identity";

type Master = KeyframeSource & { name: string; x: number; y: number; w: number; h: number };
type Draft = { id: string; camera: string; pose: string; shotId?: string; status: KeyframeRunStatus | ""; detail: string; assetId: string; promptId?: string; seed?: number };
const SESSION_KEY = "frameflow-keyframe-identity-v1";
const IDENTITY_ATTEMPTS = 2;

const statusText: Record<string, string> = {
  pending: "待出图",
  running: "正在出图",
  completed: "已出图",
  failed: "未入队",
  stopped: "未出图",
  unconfirmed: "已入队，结果未确认",
};

function findMaster(editor: Editor, assetId: string): Master {
  const shape = editor.getCurrentPageShapes().find(item => {
    if (item.type !== "image-node" && item.type !== "flux-image-node") return false;
    const props = item.props as { src?: string; assetId?: string };
    return props.assetId === assetId && !!props.src;
  });
  if (!shape) throw new Error("当前画布上没有这个母版 Asset ID");
  const props = shape.props as { src: string; assetId: string; name?: string; filename?: string; w: number; h: number };
  return { assetId: props.assetId, src: props.src, name: props.name || props.filename || "母版", x: shape.x, y: shape.y, w: props.w, h: props.h };
}

function insertMaster(raw: string, assetId: string) {
  const value = JSON.parse(raw) as { masterAssetId?: string };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("关键帧表必须是对象");
  value.masterAssetId = assetId;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeMode(raw: string, mode: KeyframeInputMode) {
  const value = JSON.parse(raw) as { mode?: KeyframeInputMode };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("关键帧表必须是对象");
  value.mode = mode;
  return `${JSON.stringify(value, null, 2)}\n`;
}

function peekMode(raw: string): KeyframeInputMode {
  try {
    const value = JSON.parse(raw) as { mode?: unknown };
    if (!value || typeof value !== "object" || Array.isArray(value)) return KEYFRAME_INPUT_MASTER;
    if (value.mode === KEYFRAME_INPUT_CHAIN) return KEYFRAME_INPUT_CHAIN;
  } catch { /* 正在输入时仍显示默认的原始母版 */ }
  return KEYFRAME_INPUT_MASTER;
}

function readMaster(editor: Editor): Master {
  const shapes = editor.getSelectedShapes();
  if (shapes.length !== 1) throw new Error("先在画布上只选中一张母版图");
  const shape = shapes[0];
  if (shape.type !== "image-node" && shape.type !== "flux-image-node") throw new Error("母版用画布上的图片");
  const props = shape.props as { src?: string; assetId?: string; name?: string; filename?: string; w: number; h: number };
  if (!props.src || !props.assetId) throw new Error("这张图还没有 Asset ID，登记完成后再当母版");
  return { assetId: props.assetId, src: props.src, name: props.name || props.filename || "母版", x: shape.x, y: shape.y, w: props.w, h: props.h };
}

function nextColumn(editor: Editor, assetId: string) {
  const columns = editor.getCurrentPageShapes().flatMap(shape => shape.type === "flux-image-node" && shape.meta.keyframeOf === assetId ? [Number(shape.meta.keyframeColumn) || 0] : []);
  return columns.length ? Math.max(...columns) + 1 : 0;
}

function writeFlux(editor: Editor, id: TLShape["id"], props: Partial<FluxImageNode["props"]>) {
  const shape = editor.getShape(id);
  if (!shape || shape.type !== "flux-image-node") return;
  editor.updateShape({ id, type: "flux-image-node", props });
}

async function renderStill(editor: Editor, master: Master, column: number, denoise: number, plan: KeyframeStepPlan, source: KeyframeSource, receipt: KeyframeReceipt, onStage: (text: string) => void): Promise<KeyframeStill> {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const cardWidth = 300;
  const cardHeight = Math.round(cardWidth * KEYFRAME_STILL.height / KEYFRAME_STILL.width);
  const id = createShapeId();
  editor.createShape({
    id,
    type: "flux-image-node",
    x: master.x + master.w + 48 + column * (cardWidth + 36),
    y: master.y + plan.index * (cardHeight + 28),
    meta: { keyframeOf: master.assetId, keyframeIndex: plan.index, keyframeColumn: column },
  });
  writeFlux(editor, id, {
    prompt: plan.prompt,
    size: `${KEYFRAME_STILL.width}x${KEYFRAME_STILL.height}`,
    w: cardWidth,
    h: cardHeight,
    imageMode: true,
    inputSrc: source.src,
    inputName: source.assetId === master.assetId ? master.name : `关键帧 ${plan.index}`,
    imageDenoise: denoise,
    editMode: "img2img",
    count: 1,
    steps: KEYFRAME_FLUX.steps,
    guidance: KEYFRAME_FLUX.guidance,
    sampler: KEYFRAME_FLUX.sampler,
    scheduler: KEYFRAME_FLUX.scheduler,
    stage: "正在入队",
    lastSeed: seed,
  });
  editor.select(id);
  const blob = await getLocalImageBlob(source.src);
  let promptId = "";
  try {
    const result = await runFluxDev({
      prompt: plan.prompt,
      width: KEYFRAME_STILL.width,
      height: KEYFRAME_STILL.height,
      seed,
      steps: KEYFRAME_FLUX.steps,
      guidance: KEYFRAME_FLUX.guidance,
      sampler: KEYFRAME_FLUX.sampler,
      scheduler: KEYFRAME_FLUX.scheduler,
      extraLora: true,
      denoise,
      imageName: "pending-original.png",
    }, {
      sourceImage: blob,
      onStage: (stage) => { onStage(stage); writeFlux(editor, id, { stage: `${plan.index + 1} · ${stage}` }); },
      onReserved: async (reserved) => {
        promptId = reserved;
        receipt.onReserved?.(reserved);
        writeFlux(editor, id, { pendingId: reserved, lastSeed: seed, stage: `${plan.index + 1} · 已预留，等待回执` });
      },
      onSubmitted: (accepted) => {
        promptId = accepted;
        receipt.onAccepted(accepted);
        writeFlux(editor, id, { pendingId: accepted, lastSeed: seed, stage: `${plan.index + 1} · 已入队 ${accepted}` });
      },
    });
    const src = await storeLocalImage(result.image, result.filename);
    const asset = await registerAsset({ kind: "image", origin: "generated", filename: result.filename, mimeType: "image/png", storageReference: src, sourceRunId: null, width: KEYFRAME_STILL.width, height: KEYFRAME_STILL.height, fileSize: result.image.size });
    writeFlux(editor, id, { src, assetId: asset.assetId, filename: result.filename, pendingId: "", lastSeed: seed, stage: "生成完成", resultWidth: KEYFRAME_STILL.width, resultHeight: KEYFRAME_STILL.height });
    return { assetId: asset.assetId, src, filename: result.filename, promptId: result.promptId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "提交失败";
    writeFlux(editor, id, { stage: promptId ? `结果未确认 · ${message}` : `未入队 · ${message}`, ...(promptId ? { pendingId: promptId, lastSeed: seed } : {}) });
    throw error;
  }
}

async function cropBlob(blob: Blob, crop: NormalizedCrop) {
  const bitmap = await createImageBitmap(blob);
  try {
    const rect = pixelCrop(bitmap.width, bitmap.height, crop);
    const canvas = new OffscreenCanvas(rect.width, rect.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法裁切参考图");
    context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}

async function registerStillImage(blob: Blob, filename: string, shotId?: string) {
  const src = await storeLocalImage(blob, filename);
  return registerAsset({ kind: "image", origin: "generated", filename, mimeType: "image/png", storageReference: src, sourceRunId: null, fileSize: blob.size, ...(shotId ? { shotId } : {}) });
}

function placeImage(editor: Editor, asset: { assetId: string; storageReference: string; filename: string }, x: number, y: number, w: number, h: number) {
  const id = createShapeId();
  editor.createShape({ id, type: "image-node", x, y, props: { src: asset.storageReference, assetId: asset.assetId, name: asset.filename, originalPath: asset.filename, w, h } });
  return id;
}

function readSession(): IdentitySessionFrame[] {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "[]") as IdentitySessionFrame[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeSession(frames: IdentitySessionFrame[]) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(frames));
}

async function renderIdentity(editor: Editor, anchor: Master, column: number, plan: IdentityStep, face: KeyframeSource, body: KeyframeSource, source: KeyframeSource, receipt: KeyframeReceipt, onStage: (text: string) => void): Promise<KeyframeStill> {
  const seed = plan.seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
  const cardWidth = 300;
  const cardHeight = Math.round(cardWidth * KEYFRAME_STILL.height / KEYFRAME_STILL.width);
  const id = createShapeId();
  const chain = plan.source === "previous";
  editor.createShape({
    id,
    type: "flux-image-node",
    x: anchor.x + anchor.w + 48 + column * (cardWidth + 36),
    y: anchor.y + plan.index * (cardHeight + 28),
    meta: { keyframeOf: face.assetId, keyframeIndex: plan.index, keyframeColumn: column, keyframeShotId: plan.shotId, keyframeBatch: "identity" },
  });
  writeFlux(editor, id, {
    prompt: plan.prompt,
    size: `${KEYFRAME_STILL.width}x${KEYFRAME_STILL.height}`,
    w: cardWidth,
    h: cardHeight,
    imageMode: chain,
    inputSrc: chain ? source.src : "",
    inputName: chain ? source.assetId : face.assetId,
    imageDenoise: chain ? KEYFRAME_FLUX.denoise : 1,
    editMode: chain ? "img2img" : "txt2img",
    count: 1,
    steps: KEYFRAME_FLUX.steps,
    guidance: KEYFRAME_FLUX.guidance,
    sampler: KEYFRAME_FLUX.sampler,
    scheduler: KEYFRAME_FLUX.scheduler,
    stage: "正在入队",
    lastSeed: seed,
  });
  editor.select(id);
  const faceBlob = await getLocalImageBlob(face.src);
  const bodyBlob = await getLocalImageBlob(body.src);
  if (!faceBlob.size || !bodyBlob.size) throw new Error("脸部参考或全身参考是空的");
  if (face.assetId === body.assetId) throw new Error("脸部参考和全身参考要是两张图");
  let promptId = "";
  let reserved = false;
  const submitOnce = async () => {
    const previous = chain ? await getLocalImageBlob(source.src) : undefined;
    const bodyDenoise = identityBodyDenoise(plan.cameraAngle);
    const useBody = !chain && bodyDenoise < 1;
    const result = await runFluxDev({
      prompt: plan.prompt,
      width: KEYFRAME_STILL.width,
      height: KEYFRAME_STILL.height,
      seed,
      steps: KEYFRAME_FLUX.steps,
      guidance: KEYFRAME_FLUX.guidance,
      sampler: KEYFRAME_FLUX.sampler,
      scheduler: KEYFRAME_FLUX.scheduler,
      extraLora: true,
      denoise: chain ? KEYFRAME_FLUX.denoise : bodyDenoise,
      ...(chain ? { imageName: "pending-original.png" } : {}),
      ...(useBody ? { bodyImageName: "pending-body.png" } : {}),
      faceImageName: "pending-face.png",
      faceWeight: identityFaceWeight(plan.cameraAngle),
    }, {
      sourceImage: previous,
      bodyImage: useBody ? bodyBlob : undefined,
      faceImage: faceBlob,
      onStage: (stage) => { onStage(stage); writeFlux(editor, id, { stage: `${plan.index + 1} · ${stage}` }); },
      onReserved: async (value) => {
        reserved = true;
        promptId = value;
        receipt.onReserved?.(value);
        writeFlux(editor, id, { pendingId: value, lastSeed: seed, stage: `${plan.index + 1} · 已预留，等待回执` });
      },
      onSubmitted: (accepted) => {
        promptId = accepted;
        receipt.onAccepted(accepted);
        writeFlux(editor, id, { pendingId: accepted, lastSeed: seed, stage: `${plan.index + 1} · 已入队 ${accepted}` });
      },
    });
    const src = await storeLocalImage(result.image, result.filename);
    const asset = await registerAsset({ kind: "image", origin: "generated", filename: result.filename, mimeType: "image/png", storageReference: src, sourceRunId: null, width: KEYFRAME_STILL.width, height: KEYFRAME_STILL.height, fileSize: result.image.size, shotId: plan.shotId });
    writeFlux(editor, id, { src, assetId: asset.assetId, filename: result.filename, pendingId: "", lastSeed: seed, stage: "生成完成", resultWidth: KEYFRAME_STILL.width, resultHeight: KEYFRAME_STILL.height });
    return { assetId: asset.assetId, src, filename: result.filename, promptId: result.promptId };
  };
  try {
    let last: unknown;
    for (let attempt = 0; attempt < IDENTITY_ATTEMPTS; attempt += 1) {
      if (identityDispatch({ promptId: reserved ? promptId : "", assetId: "" }, attempt, IDENTITY_ATTEMPTS) !== "submit") break;
      try { return await submitOnce(); }
      catch (error) {
        last = error;
        if (reserved) throw error;
      }
    }
    throw last instanceof Error ? last : new Error("提交失败");
  } catch (error) {
    const message = error instanceof Error ? error.message : "提交失败";
    writeFlux(editor, id, { stage: promptId ? `结果未确认 · ${message}` : `未入队 · ${message}`, ...(promptId ? { pendingId: promptId, lastSeed: seed } : {}) });
    throw error;
  }
}

/** One storyboard frame: depth of the storyboard locks camera/pose, PuLID locks the face. No retries after a receipt. */
async function renderStoryboard(editor: Editor, board: Master, column: number, plan: StoryboardStep, doc: KeyframeStoryboardDocument, face: KeyframeSource | null, receipt: KeyframeReceipt, onStage: (text: string) => void): Promise<KeyframeStill> {
  const size = STORYBOARD_SIZES[doc.aspect];
  const seed = plan.seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
  const cardWidth = 300;
  const cardHeight = Math.round(cardWidth * size.height / size.width);
  const id = createShapeId();
  editor.createShape({
    id,
    type: "flux-image-node",
    x: board.x + board.w + 48 + column * (cardWidth + 36),
    y: board.y,
    meta: { keyframeOf: board.assetId, keyframeIndex: plan.index, keyframeColumn: column, keyframeShotId: plan.shotId, keyframeBatch: "storyboard" },
  });
  writeFlux(editor, id, { prompt: plan.prompt, size: `${size.width}x${size.height}`, w: cardWidth, h: cardHeight, imageMode: false, inputSrc: "", inputName: board.assetId, imageDenoise: 1, editMode: "txt2img", count: 1, steps: STORYBOARD_FLUX.steps, guidance: 10, sampler: KEYFRAME_FLUX.sampler, scheduler: KEYFRAME_FLUX.scheduler, stage: "正在入队", lastSeed: seed });
  const boardBlob = await getLocalImageBlob(board.src);
  const faceBlob = face ? await getLocalImageBlob(face.src) : undefined;
  if (!boardBlob.size || (face && !faceBlob?.size)) throw new Error("分镜图或脸部参考是空的");
  let promptId = "";
  try {
    const result = await runFluxDev({
      prompt: plan.prompt, width: size.width, height: size.height, seed,
      steps: STORYBOARD_FLUX.steps, guidance: 10, sampler: KEYFRAME_FLUX.sampler, scheduler: KEYFRAME_FLUX.scheduler,
      extraLora: true, denoise: 1, depthImageName: "pending-storyboard.png", depthStrength: doc.depthStrength,
      ...(face ? { faceImageName: "pending-face.png", faceWeight: plan.faceWeight } : {}),
    }, {
      depthImage: boardBlob,
      faceImage: faceBlob,
      onStage: (stage) => { onStage(stage); writeFlux(editor, id, { stage: `${plan.shotId} · ${stage}` }); },
      onReserved: async (value) => { promptId = value; receipt.onReserved?.(value); writeFlux(editor, id, { pendingId: value, lastSeed: seed, stage: `${plan.shotId} · 已预留，等待回执` }); },
      onSubmitted: (accepted) => { promptId = accepted; receipt.onAccepted(accepted); writeFlux(editor, id, { pendingId: accepted, lastSeed: seed, stage: `${plan.shotId} · 已入队 ${accepted}` }); },
    });
    const src = await storeLocalImage(result.image, result.filename);
    const asset = await registerAsset({ kind: "image", origin: "generated", filename: result.filename, mimeType: "image/png", storageReference: src, sourceRunId: null, width: size.width, height: size.height, fileSize: result.image.size, shotId: plan.shotId });
    writeFlux(editor, id, { src, assetId: asset.assetId, filename: result.filename, pendingId: "", lastSeed: seed, stage: "生成完成", resultWidth: size.width, resultHeight: size.height });
    return { assetId: asset.assetId, src, filename: result.filename, promptId: result.promptId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "提交失败";
    writeFlux(editor, id, { stage: promptId ? `结果未确认 · ${message}` : `未入队 · ${message}`, ...(promptId ? { pendingId: promptId, lastSeed: seed } : {}) });
    throw error;
  }
}

/** Selected canvas images with Asset IDs, left to right then top to bottom: the storyboard reading order. */
function selectedBoards(editor: Editor) {
  return editor.getSelectedShapes().flatMap(shape => {
    if (shape.type !== "image-node" && shape.type !== "flux-image-node") return [];
    const props = shape.props as { assetId?: string; src?: string };
    return props.assetId && props.src ? [{ assetId: props.assetId, x: shape.x, y: shape.y }] : [];
  }).sort((a, b) => Math.abs(a.y - b.y) > 200 ? a.y - b.y : a.x - b.x);
}

export function KeyframeBatchPanel({ editor, onClose, visible = true }: { editor: Editor; onClose: () => void; visible?: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const stopRef = useRef<AbortController | null>(null);
  const [raw, setRaw] = useState(keyframeStoryboardExample);
  const [master, setMaster] = useState<Master | null>(null);
  const [rows, setRows] = useState<Draft[]>([]);
  const [denoise, setDenoise] = useState<number>(KEYFRAME_FLUX.denoise);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("框选分镜图后点「把选中的分镜图加进表」，填好脸部参考和英文描述，检查通过后依次出图。旧的身份表和母版表照常可用。");
  const inputMode = peekMode(raw);
  const selected = useValue("keyframe master candidate", () => {
    const shapes = editor.getSelectedShapes();
    if (shapes.length !== 1) return "";
    const shape = shapes[0];
    if (shape.type !== "image-node" && shape.type !== "flux-image-node") return "";
    const props = shape.props as { src?: string; name?: string; filename?: string; assetId?: string };
    if (!props.src) return "";
    return `${props.name || props.filename || "未命名图片"}${props.assetId ? "" : "（还没有 Asset ID）"}`;
  }, [editor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!visible || event.key !== "Escape" || event.isComposing || isTypingTarget(event.target) || !panel.current?.getClientRects().length) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, visible]);

  const loadLegacy = (): { doc: KeyframeBatchDocument; found: Master } => {
    const doc = parseKeyframeBatch(raw);
    const found = findMaster(editor, doc.masterAssetId);
    setMaster(found);
    setDenoise(doc.denoise);
    return { doc, found };
  };

  const showFrames = (doc: KeyframeBatchDocument) => {
    setRows(doc.frames.map(frame => ({ id: crypto.randomUUID(), camera: frame.camera, pose: frame.pose, status: "", detail: "", assetId: "" })));
  };

  const pickMaster = () => {
    if (busy) return;
    try {
      const picked = readMaster(editor);
      if (isIdentityDocument(raw)) {
        const value = JSON.parse(raw) as { sourceSheetAssetId?: string };
        value.sourceSheetAssetId = picked.assetId;
        setRaw(`${JSON.stringify(value, null, 2)}\n`);
        setNotice("已把选中图片写入四格来源。它不会直接当生成底图。先裁切，再确认。");
      } else {
        setRaw(raw.trim() ? insertMaster(raw, picked.assetId) : keyframeBatchExample(picked.assetId));
        setNotice("已把选中图片写入 masterAssetId。检查通过后再依次出图。");
      }
      setMaster(picked);
      setRows([]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "还不能把这张图写进表里");
    }
  };

  const cutSheet = async () => {
    if (busy) return;
    const doc = parseKeyframeIdentity(raw);
    if (!doc.sourceSheetAssetId) throw new Error("先把四格设定图的 Asset ID 写入 sourceSheetAssetId");
    const sheet = findMaster(editor, doc.sourceSheetAssetId);
    const faceBlob = await cropBlob(await getLocalImageBlob(sheet.src), SHEET_FACE_CLOSEUP);
    const bodyBlob = await cropBlob(await getLocalImageBlob(sheet.src), SHEET_FRONT_BODY);
    const face = await registerStillImage(faceBlob, "角色脸部参考.png");
    const body = await registerStillImage(bodyBlob, "角色全身参考.png");
    placeImage(editor, { assetId: face.assetId, storageReference: face.storageReference, filename: face.filename }, sheet.x + sheet.w + 48, sheet.y, 220, 280);
    placeImage(editor, { assetId: body.assetId, storageReference: body.storageReference, filename: body.filename }, sheet.x + sheet.w + 48, sheet.y + 320, 220, 360);
    const next = { ...doc, faceReferenceAssetId: face.assetId, bodyReferenceAssetId: body.assetId, cropsConfirmed: false };
    setRaw(`${JSON.stringify(next, null, 2)}\n`);
    setNotice(`已裁出脸 ${face.assetId} 和全身 ${body.assetId}。看过画面后再点确认裁切。四格原图不会进入生成。`);
  };

  const confirmCrops = async () => {
    if (busy) return;
    const doc = parseKeyframeIdentity(raw);
    if (!doc.faceReferenceAssetId || !doc.bodyReferenceAssetId) throw new Error("先裁出脸部参考和全身参考");
    const next = { ...doc, cropsConfirmed: true };
    setRaw(`${JSON.stringify(next, null, 2)}\n`);
    await setRoleStillReferences(doc.characterId, { faceAssetId: doc.faceReferenceAssetId, bodyAssetId: doc.bodyReferenceAssetId, clothing: doc.clothing, hair: doc.hair, description: doc.character });
    setNotice("裁切已确认，并写进角色。可以依次出图。");
  };

  const chooseMode = (next: KeyframeInputMode) => {
    if (busy) return;
    try {
      setRaw(writeMode(raw.trim() ? raw : keyframeBatchExample(), next));
      setRows([]);
      setNotice(next === KEYFRAME_INPUT_MASTER ? "已改为原始母版：每一张都直接改最初的母版。" : "已改为连续递进：后面每一张改上一张的结果。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "还不能写入输入模式");
    }
  };

  const addBoards = () => {
    if (busy) return;
    try {
      const boards = selectedBoards(editor);
      if (!boards.length) throw new Error("先在画布上框选分镜图（要有 Asset ID）");
      type Doc = { frames?: { shotId: string; storyboardAssetId: string; prompt?: string }[] };
      const current = isStoryboardDocument(raw);
      const base = JSON.parse(current ? raw : keyframeStoryboardExample()) as Doc;
      const kept = current ? (base.frames ?? []).filter(frame => !/Asset ID$/.test(frame.storyboardAssetId)) : [];
      const used = new Set(kept.map(frame => frame.shotId));
      let n = kept.length;
      const added = boards.filter(board => !kept.some(frame => frame.storyboardAssetId === board.assetId)).map(board => {
        let shotId = "";
        do { n += 1; shotId = `S${String(n).padStart(2, "0")}`; } while (used.has(shotId));
        used.add(shotId);
        return { shotId, storyboardAssetId: board.assetId, prompt: "" };
      });
      base.frames = [...kept, ...added];
      setRaw(`${JSON.stringify(base, null, 2)}\n`);
      setRows([]);
      setNotice(`已加入 ${added.length} 张分镜图（按从左到右、从上到下排序）。再填 look、脸部参考和每张的 prompt（英文），然后检查。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "还不能加入分镜图");
    }
  };

  const check = () => {
    if (busy) return;
    try {
      if (isStoryboardDocument(raw)) {
        const doc = parseKeyframeStoryboard(raw);
        for (const frame of doc.frames) findMaster(editor, frame.storyboardAssetId);
        for (const id of new Set(doc.frames.map(frame => frame.faceReferenceAssetId).filter((id): id is string => !!id))) findMaster(editor, id);
        const plans = planStoryboardBatch(doc);
        const warned = plans.flatMap(plan => storyboardPromptWarnings(plan.prompt).map(w => `${plan.shotId}：${w}`));
        setRows(plans.map(plan => ({ id: crypto.randomUUID(), camera: "跟随分镜图", pose: plan.faceReferenceAssetId ? `锁脸 ${plan.faceWeight}` : "不锁脸", shotId: plan.shotId, status: "", detail: "", assetId: "" })));
        setNotice(`${plans.length} 张已检查，分镜图和脸部参考都在画布上。${warned.length ? ` 提醒：${[...new Set(warned)].slice(0, 4).join("；")}` : ""}`);
        return;
      }
      if (isIdentityDocument(raw)) {
        const doc = parseKeyframeIdentity(raw);
        setRows(doc.frames.map(frame => ({ id: crypto.randomUUID(), camera: `${frame.cameraAngle} · ${frame.shotSize}`, pose: frame.pose, shotId: frame.shotId, status: "", detail: "", assetId: "" })));
        setNotice(`${doc.frames.length} 张已检查。${doc.cropsConfirmed ? "裁切已确认。" : "还没有确认裁切。"} ${doc.mode === KEYFRAME_INPUT_MASTER ? "原始母版：每一张都用同一张脸和同一张全身，不用上一张结果。" : "连续递进：后面的张会用上一张结果。"}`);
        return;
      }
      const { doc } = loadLegacy();
      showFrames(doc);
      setNotice(`${doc.frames.length} 张已检查，尚未出图。${doc.mode === KEYFRAME_INPUT_MASTER ? "原始母版：每一张都直接改最初的母版。" : "连续递进：第 1 张改母版，后面每一张改上一张的结果。"}`);
    } catch (error) {
      setRows([]);
      setNotice(error instanceof Error ? error.message : "这份表还不能出图");
    }
  };

  const runIdentity = async (doc: KeyframeIdentityDocument) => {
    const plans = planIdentityBatch(doc).map(plan => ({ ...plan, seed: plan.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] }));
    const face = findMaster(editor, doc.faceReferenceAssetId);
    const body = findMaster(editor, doc.bodyReferenceAssetId);
    const anchor = doc.sourceSheetAssetId ? findMaster(editor, doc.sourceSheetAssetId) : face;
    const controller = new AbortController();
    stopRef.current = controller;
    const column = nextColumn(editor, face.assetId);
    const session: IdentitySessionFrame[] = plans.map(plan => ({ index: plan.index, shotId: plan.shotId, promptId: "", assetId: "", seed: plan.seed ?? 0, status: "pending" }));
    writeSession(session);
    setRows(plans.map(plan => ({ id: crypto.randomUUID(), camera: `${plan.cameraAngle} · ${plan.shotSize}`, pose: plan.pose, shotId: plan.shotId, status: "pending", detail: "等待前面的关键帧", assetId: "", seed: plan.seed ?? 0 })));
    const outcome = await runKeyframeBatch(plans, {
      signal: controller.signal,
      master: face,
      onUpdate: (index, status, detail, still) => {
        session[index] = { ...session[index], status, assetId: still?.assetId ?? session[index].assetId, promptId: still?.promptId || session[index].promptId, seed: plans[index].seed ?? session[index].seed };
        writeSession(session);
        setRows(current => current.map((row, at) => at === index ? { ...row, status, detail: still?.assetId ?? detail, assetId: still?.assetId ?? row.assetId, promptId: still?.promptId ?? row.promptId } : row));
        if (status !== "pending") setNotice(`第 ${index + 1} 张 · ${statusText[status] ?? status} · ${still?.assetId ?? detail}`);
      },
      submit: (plan, source, receipt) => renderIdentity(editor, anchor, column, plan as IdentityStep, face, body, source, {
        onReserved: (promptId) => { session[plan.index].promptId = promptId; session[plan.index].seed = (plan as IdentityStep).seed ?? session[plan.index].seed; writeSession(session); receipt.onReserved?.(promptId); },
        onAccepted: (promptId) => { session[plan.index].promptId = promptId; writeSession(session); receipt.onAccepted(promptId); },
      }, (stage) => setNotice(`第 ${plan.index + 1} 张 · ${stage}`)),
    });
    setNotice(outcome === "completed" ? "这一批身份关键帧已出完。每张都有自己的 Asset ID 和 shotId。" : outcome === "stopped" ? "已停止。还没入队的关键帧留在列表里。" : outcome === "unconfirmed" ? "有一张已入队但结果未确认。用恢复已入队结果，不要重新出图。" : "这一张没有入队，后面的关键帧已停下。失败的一张会在入队前自动再试一次。");
  };

  const recover = async () => {
    if (busy) return;
    const saved = readSession();
    setBusy(true);
    try {
      for (const frame of saved) {
        const action = identityDispatch(frame, IDENTITY_ATTEMPTS, IDENTITY_ATTEMPTS);
        if (action !== "poll") continue;
        const result = await waitForFluxDev(frame.promptId, frame.seed);
        const src = await storeLocalImage(result.image, result.filename);
        const asset = await registerAsset({ kind: "image", origin: "generated", filename: result.filename, mimeType: "image/png", storageReference: src, sourceRunId: null, width: KEYFRAME_STILL.width, height: KEYFRAME_STILL.height, fileSize: result.image.size, shotId: frame.shotId });
        const view = editor.getViewportPageBounds();
        const shapeId = placeImage(editor, { assetId: asset.assetId, storageReference: src, filename: result.filename }, view.x + 48 + frame.index * 340, view.y + 48, 300, 520);
        editor.updateShape({ id: shapeId, type: "image-node", meta: { keyframeShotId: frame.shotId, keyframeBatch: "identity", keyframeIndex: frame.index } });
        frame.assetId = asset.assetId;
        frame.status = "completed";
        writeSession(saved);
        setNotice(`已恢复第 ${frame.index + 1} 张 ${asset.assetId}`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setBusy(false);
    }
  };

  const runStoryboard = async (doc: KeyframeStoryboardDocument) => {
    const plans = planStoryboardBatch(doc).map(plan => ({ ...plan, seed: plan.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] }));
    const boards = plans.map(plan => findMaster(editor, plan.storyboardAssetId));
    const faces = new Map(plans.filter(plan => plan.faceReferenceAssetId).map(plan => [plan.faceReferenceAssetId, findMaster(editor, plan.faceReferenceAssetId)]));
    const controller = new AbortController();
    stopRef.current = controller;
    setRows(plans.map(plan => ({ id: crypto.randomUUID(), camera: "跟随分镜图", pose: plan.faceReferenceAssetId ? `锁脸 ${plan.faceWeight}` : "不锁脸", shotId: plan.shotId, status: "pending", detail: "等待前面的关键帧", assetId: "", seed: plan.seed ?? 0 })));
    const outcome = await runKeyframeBatch(plans, {
      signal: controller.signal,
      master: boards[0],
      onUpdate: (index, status, detail, still) => {
        setRows(current => current.map((row, at) => at === index ? { ...row, status, detail: still?.assetId ?? detail, assetId: still?.assetId ?? row.assetId, promptId: still?.promptId ?? row.promptId } : row));
        if (status !== "pending") setNotice(`${plans[index].shotId} · ${statusText[status] ?? status} · ${still?.assetId ?? detail}`);
      },
      submit: (plan, _source, receipt) => {
        const step = plan as StoryboardStep;
        const board = boards[step.index];
        const face = step.faceReferenceAssetId ? faces.get(step.faceReferenceAssetId) ?? null : null;
        return renderStoryboard(editor, board, nextColumn(editor, board.assetId), step, doc, face, receipt, (stage) => setNotice(`${step.shotId} · ${stage}`));
      },
    });
    setNotice(outcome === "completed" ? "这一批分镜关键帧已出完，每张放在对应分镜图右边，带 shotId 和 Asset ID。" : outcome === "stopped" ? "已停止。还没入队的关键帧留在列表里。" : outcome === "unconfirmed" ? "有一张已入队但结果未确认。用那张 Flux 节点上的「查看原任务结果」，不要在这里重跑。" : "这一张没有入队，后面的关键帧已停下。");
  };

  const run = async () => {
    if (busy) return;
    if (isStoryboardDocument(raw)) {
      let doc: KeyframeStoryboardDocument;
      try { doc = parseKeyframeStoryboard(raw); }
      catch (error) { setNotice(error instanceof Error ? error.message : "这份表还不能出图"); return; }
      setBusy(true);
      try { await runStoryboard(doc); }
      catch (error) { setNotice(error instanceof Error ? error.message : "这一批已停下"); }
      finally { if (stopRef.current) stopRef.current = null; setBusy(false); }
      return;
    }
    if (isIdentityDocument(raw)) {
      let doc: KeyframeIdentityDocument;
      try { doc = parseKeyframeIdentity(raw); }
      catch (error) { setNotice(error instanceof Error ? error.message : "这份表还不能出图"); return; }
      setBusy(true);
      try { await runIdentity(doc); }
      catch (error) { setNotice(error instanceof Error ? error.message : "这一批已停下"); }
      finally { if (stopRef.current) stopRef.current = null; setBusy(false); }
      return;
    }
    let doc: KeyframeBatchDocument;
    let found: Master;
    try {
      ({ doc, found } = loadLegacy());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "这份表还不能出图");
      return;
    }
    const plans = planKeyframeChain(doc.frames, doc.mode);
    const strength = doc.denoise;
    const controller = new AbortController();
    stopRef.current = controller;
    const column = nextColumn(editor, found.assetId);
    setBusy(true);
    setRows(doc.frames.map(frame => ({ id: crypto.randomUUID(), camera: frame.camera, pose: frame.pose, status: "pending", detail: "等待前面的关键帧", assetId: "" })));
    try {
      const outcome = await runKeyframeBatch(plans, {
        signal: controller.signal,
        master: found,
        onUpdate: (index, status, detail, still) => {
          setRows(current => current.map((row, at) => at === index ? { ...row, status, detail: still?.assetId ?? detail, assetId: still?.assetId ?? row.assetId } : row));
          if (status !== "pending") setNotice(`第 ${index + 1} 张 · ${statusText[status] ?? status} · ${still?.assetId ?? detail}`);
        },
        submit: (plan, source, receipt) => renderStill(editor, found, column, strength, plan, source, receipt, (stage) => setNotice(`第 ${plan.index + 1} 张 · ${stage}`)),
      });
      setNotice(outcome === "completed" ? "这一批静帧已出完。复制 Asset ID，填进视频镜头的 firstFrameAssetId。" : outcome === "stopped" ? "已停止。还没入队的关键帧留在列表里。" : outcome === "unconfirmed" ? "有一张已入队但结果未确认。用那张 Flux 节点上的「查看原任务结果」，不要在这里重跑。" : "这一张没有入队，后面的关键帧已停下。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "这一批已停下");
    } finally {
      if (stopRef.current === controller) stopRef.current = null;
      setBusy(false);
    }
  };

  return <CanvasPanelBoundary name="批量关键帧" onClose={onClose}><GuardedPanelRender render={() => <aside ref={panel} className="asset-library-drawer ff-panel shot-board" role="dialog" aria-label="批量关键帧" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <header><div><small className="ff-hint">Flux Dev · 分镜深度锁构图 · PuLID 锁脸 · 串行</small><h2>批量关键帧</h2></div><button type="button" aria-label="关闭批量关键帧" onClick={onClose}><X size={17} /></button></header>
    <div className="shot-queue-body">
      <p className="ff-hint">身份表用同一张脸和同一张单人全身。四格设定图只用来裁切，确认后才出图，不会整张送进生成。默认原始母版：每一张单独生成。连续递进仍可用。一份画面只有一个人、一个构图。这份写在面板里，不要放进收件箱。</p>
      <fieldset className="keyframe-mode" disabled={busy}>
        <legend>输入模式</legend>
        <label><input type="radio" name="keyframe-input-mode" value="master" checked={inputMode === KEYFRAME_INPUT_MASTER} onChange={() => chooseMode(KEYFRAME_INPUT_MASTER)} /> <span><b>原始母版（默认）</b> 每一张都直接使用最初选定的母版，上一张结果不会成为下一张的输入。</span></label>
        <label><input type="radio" name="keyframe-input-mode" value="chain" checked={inputMode === KEYFRAME_INPUT_CHAIN} onChange={() => chooseMode(KEYFRAME_INPUT_CHAIN)} /> <span><b>连续递进</b> 第 1 张改母版，后面每一张改上一张刚生成的结果。</span></label>
      </fieldset>
      <label className="autopilot-field"><span>关键帧表 JSON</span><textarea rows={12} spellCheck={false} disabled={busy} aria-label="关键帧表 JSON" value={raw} onChange={(event) => { setRaw(event.target.value); setRows([]); }} /></label>
      <div className="reference-actions">
        <button type="button" disabled={busy} onClick={check}>检查</button>
        <button type="button" disabled={busy} onClick={() => { setRaw(keyframeStoryboardExample()); setRows([]); setMaster(null); setNotice("已填入分镜示例：每张分镜图决定构图和机位，脸部参考锁长相，look 和 prompt 用英文写外观。"); }}>填入分镜示例</button>
        <button type="button" disabled={busy} onClick={addBoards}>把选中的分镜图加进表</button>
        <button type="button" disabled={busy} onClick={() => { setRaw(keyframeIdentityExample()); setRows([]); setMaster(null); setNotice("已填入身份示例。写入四格来源后先裁切，确认后再出图。"); }}>填入示例</button>
        <button type="button" disabled={busy} onClick={pickMaster}>把选中图片写入母版</button>
        <button type="button" disabled={busy} onClick={() => { void cutSheet().catch(error => setNotice(error instanceof Error ? error.message : "裁切失败")); }}>裁出脸和全身</button>
        <button type="button" disabled={busy} onClick={() => { void confirmCrops().catch(error => setNotice(error instanceof Error ? error.message : "还不能确认裁切")); }}>确认裁切</button>
      </div>
      <p>{master ? <>母版 {master.name} · {inputMode === KEYFRAME_INPUT_MASTER ? "原始母版" : "连续递进"} · 重绘 {denoise} · <code>{master.assetId}</code></> : selected ? `当前选中：${selected}` : "在画布上选中母版，或把 Asset ID 写进 JSON。"}</p>
      {rows.length > 0 && <ol className="keyframe-batch-list">
        {rows.map((row, index) => <li className="keyframe-batch-row" key={row.id}>
          <b>第 {index + 1} 张</b>
          <span>机位 {row.camera} · 姿态 {row.pose}{row.shotId ? ` · 镜头 ${row.shotId}` : ""}</span>
          <span>{inputMode === KEYFRAME_INPUT_CHAIN && index > 0 ? "输入：上一张结果" : "输入：原始母版"}</span>
          {(row.status || row.assetId) && <div className="keyframe-result"><span>{row.status ? statusText[row.status] : ""}{row.detail && !row.assetId ? ` · ${row.detail}` : ""}</span>{row.assetId && <><code>{row.assetId}</code><button type="button" onClick={() => { void copyPlainText(row.assetId).then(ok => setNotice(ok ? `已复制第 ${index + 1} 张的 Asset ID` : "复制失败，请重试")); }}>复制 Asset ID</button></>}</div>}
        </li>)}
      </ol>}
      <div className="reference-actions">
        <button type="button" disabled={busy} onClick={() => void run()}>{busy ? "正在按顺序出图" : "依次出图"}</button>
        <button type="button" disabled={!busy} onClick={() => stopRef.current?.abort()}>停止后面的张</button>
        <button type="button" disabled={busy} onClick={() => void recover()}>恢复已入队结果</button>
      </div>
      <p role="status">{notice}</p>
      <style>{`.keyframe-batch-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}.keyframe-batch-row{display:grid;gap:6px;padding-top:8px;border-top:1px solid var(--ff-border)}.keyframe-mode{display:grid;gap:8px;margin:0 0 12px;padding:10px 12px;border:1px solid var(--ff-border);border-radius:8px}.keyframe-mode legend{padding:0 4px;font-size:12px;color:var(--ff-text-2)}.keyframe-mode label{display:flex;gap:8px;align-items:flex-start;line-height:1.45}.keyframe-mode input{margin-top:3px}.keyframe-edit{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end}.keyframe-edit label{display:grid;gap:4px}.keyframe-edit button,.keyframe-result button{min-height:30px}.keyframe-batch-row small,.keyframe-result{font-size:12px;color:var(--ff-text-2);overflow-wrap:anywhere}.keyframe-result{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.keyframe-result code{font-size:11px}`}</style>
    </div>
  </aside>} /></CanvasPanelBoundary>;
}
