"use client";

import { videoHandoffEdges } from "@/lib/video-frame-handoff";
import { Plus } from "lucide-react";
import { Editor, TLArrowShape, type TLShape, createShapeId, getArrowBindings, useValue } from "tldraw";
import { PointerEvent as ReactPointerEvent, useRef } from "react";
import { showCanvasToast } from "@/components/canvas/canvas-events";
import { customTypes } from "@/lib/canvas-node-types";
import { nearestFrameDropTarget } from "@/lib/frame-drop-target";
import { extractVideoLastFrame, getLocalImageBlob, storeLocalImage } from "@/lib/local-video-store";
import { showDropFeedback } from "@/components/canvas/interaction-ui";
import { clearSlotFeedback, slotLabel } from "@/components/canvas/slot-drop-feedback";
import { getActualDuration } from "@/lib/comfyui/h3-parameters";
import { type CustomNode, type H3FrameRole, type H3Node, H3_INPUT_ANCHORS, type ImageNode, type Point, createBoundArrow, getIncomingFrameSource, getIncomingReferenceImages, getWorkflowMidpoint, handoffVideoFrame, isCompatibleConnection, referenceImageOf, removeExistingFrameConnection, runPortAction, selectedReferenceImages } from "@/components/canvas/workspace-shared";

/** Ports sit outside the shape bounds. Resolve their owner first and ignore the temporary arrow. */
export function workflowDropTarget(editor: Editor, sourceId: TLShape["id"], client: Point) {
  for (const port of document.querySelectorAll<HTMLElement>(".workflow-port[data-workflow-node-id]")) {
    const rect = port.getBoundingClientRect();
    if (!rect.width || !rect.height || client.x < rect.left || client.x > rect.right || client.y < rect.top || client.y > rect.bottom) continue;
    const node = editor.getShape(port.dataset.workflowNodeId as TLShape["id"]);
    if (node && node.id !== sourceId && customTypes.has(node.type)) return node;
  }
  const point = editor.screenToPage(client);
  return [...editor.getCurrentPageShapes()].reverse().find(node => {
    if (node.id === sourceId || !customTypes.has(node.type)) return false;
    const bounds = editor.getShapePageBounds(node);
    return Boolean(bounds && point.x >= bounds.x && point.x <= bounds.x + bounds.w && point.y >= bounds.y && point.y <= bounds.y + bounds.h);
  });
}

export function WorkflowPort({ editor, shape, side = "right", onClick }: { editor: Editor; shape: CustomNode; side?: "left" | "right"; onClick?: () => void }) {
  const selectedImages = useValue("port selected references", () => selectedReferenceImages(editor), [editor]);
  const startRef = useRef<{ client: Point; page: Point; arrowId: ReturnType<typeof createShapeId> | null; moved: boolean; referenceIds: ImageNode["id"][] } | null>(null);
  const magneticAt = (client: Point) => {
    if (side === "left" || (shape.type !== "image-node" && shape.type !== "video-node")) return null;
    const targets: { target: H3Node; role: H3FrameRole | "guide"; card: HTMLElement; bounds: DOMRect }[] = [];
    for (const card of document.querySelectorAll<HTMLElement>(".tl-shape[data-shape-type='h3-node'] [data-frame-role], .h3-creative-dock [data-frame-role]")) {
      const bounds = card.getBoundingClientRect();
      const id = card.closest<HTMLElement>(".h3-creative-dock")?.dataset.nodeId ?? card.closest<HTMLElement>(".tl-shape")?.dataset.shapeId;
      const target = id ? editor.getShape(id as H3Node["id"]) : undefined;
      if (target?.type !== "h3-node" || target.id === shape.id || target.isLocked) continue;
      if (card.matches(":disabled") || card.closest("[data-drop-disabled='true']") || (!card.querySelector("img") && card.querySelector("button:disabled"))) continue;
      if (shape.type === "video-node" && card.dataset.frameRole !== "first") continue;
      targets.push({ target: target as H3Node, role: card.dataset.frameRole as H3FrameRole | "guide", card, bounds });
    }
    return nearestFrameDropTarget(client, targets);
  };
  const clearMagnet = () => { clearSlotFeedback(); showDropFeedback(null); };
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    editor.markEventAsHandled(event);
    if (event.button !== 0 || shape.isLocked) return;
    const page = editor.screenToPage({ x: event.clientX, y: event.clientY });
    const referenceIds = shape.type === "image-node" && selectedImages.some((image) => image.id === shape.id) ? selectedImages.map((image) => image.id) : [];
    startRef.current = { client: { x: event.clientX, y: event.clientY }, page, arrowId: null, moved: false, referenceIds };
    const move = (moveEvent: PointerEvent) => {
      const state = startRef.current;
      if (!state) return;
      editor.markEventAsHandled(moveEvent);
      const distance = Math.hypot(moveEvent.clientX - state.client.x, moveEvent.clientY - state.client.y);
      if (!state.arrowId && distance > 5) {
        editor.markHistoryStoppingPoint("before connecting workflow nodes");
        state.moved = true; state.arrowId = createShapeId();
        editor.createShape({ id: state.arrowId, type: "arrow", x: state.page.x, y: state.page.y, props: { start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, kind: "elbow", elbowMidPoint: 0.5, color: "grey", size: "s", dash: "solid", arrowheadEnd: "arrow" } });
        editor.createBinding({ type: "arrow", fromId: state.arrowId, toId: shape.id, props: { terminal: "start", normalizedAnchor: { x: side === "left" ? 0 : 1, y: 0.5 }, isExact: false, isPrecise: true, snap: "edge" } });
      }
      if (state.arrowId) {
        clearMagnet();
        const magnet = magneticAt({ x: moveEvent.clientX, y: moveEvent.clientY });
        const target = magnet?.target ?? workflowDropTarget(editor, shape.id, {x:moveEvent.clientX,y:moveEvent.clientY});
        if (target) {
          const videoHandoff = ["h3-node", "video-node"].includes(shape.type) && ["h3-node", "video-node"].includes(target.type);
          const valid = !target.isLocked && (videoHandoff || isCompatibleConnection(shape, target));
          const label = !valid ? target.isLocked ? "节点已锁定，不能连接" : "这两种节点不能连接" : target.type === "h3-node" && state.referenceIds.length > 1 ? `加入 ${state.referenceIds.length} 张参考图` : magnet ? `${magnet.card.querySelector("img") && magnet.role !== "reference" ? "将替换" : "连接到"}${slotLabel(magnet.role)}` : target.type === "h3-node" && shape.type === "image-node" ? "松开后选择：首帧／尾帧／参考" : videoHandoff ? side === "left" ? "松开：将本视频首帧设为上一视频尾帧" : "松开后选择：首帧／尾帧（使用原节点）" : "可以连接";
          if (magnet) { magnet.card.setAttribute("data-magnetic", valid ? "true" : "invalid"); magnet.card.setAttribute("data-drop-label", label); }
          const node = document.querySelector<HTMLElement>(`.tl-shape[data-shape-id="${target.id}"] .node-shell`);
          node?.setAttribute("data-connect-state", valid ? "valid" : "invalid");
          showDropFeedback({ x: moveEvent.clientX, y: moveEvent.clientY, label, valid });
        }
        const endClient = magnet ? { x: magnet.card.getBoundingClientRect().left, y: magnet.card.getBoundingClientRect().top + magnet.card.getBoundingClientRect().height / 2 } : { x: moveEvent.clientX, y: moveEvent.clientY };
        const pagePoint = editor.screenToPage(endClient);
        editor.updateShape({ id: state.arrowId, type: "arrow", props: { end: { x: pagePoint.x - state.page.x, y: pagePoint.y - state.page.y } } });
      }
    };
    const up = (upEvent: PointerEvent) => {
      editor.markEventAsHandled(upEvent);
      window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true); window.removeEventListener("pointercancel", up, true);
      const state = startRef.current; startRef.current = null;
      clearMagnet();
      if (!state) return;
      if (upEvent.type === "pointercancel") { if (state.arrowId) editor.deleteShape(state.arrowId); return; }
      if (!state.moved) {
        if (side === "left") { onClick?.(); return; }
        if (shape.type === "video-node" || shape.type === "h3-node" || shape.type === "image-node") window.dispatchEvent(new CustomEvent("frameflow-port-drop", { detail: { sourceId: shape.id, referenceIds: state.referenceIds, client: { x: upEvent.clientX, y: upEvent.clientY }, page: { x: shape.x + shape.props.w + 130, y: shape.type === "image-node" ? shape.y : shape.y - 80 } } }));
        else void runPortAction(editor, shape, undefined, undefined, state.referenceIds).catch((cause) => showCanvasToast(cause instanceof Error ? cause.message : "无法创建下一节点"));
        return;
      }
      if (!state.arrowId) return;
      const pagePoint = editor.screenToPage({ x: upEvent.clientX, y: upEvent.clientY });
      const magnet = magneticAt({ x: upEvent.clientX, y: upEvent.clientY });
      const hit = workflowDropTarget(editor, shape.id, {x:upEvent.clientX,y:upEvent.clientY});
      const target = magnet?.target ?? hit;
      if ((shape.type === "video-node" || shape.type === "h3-node") && (target?.type === "h3-node" || target?.type === "video-node")) {
        editor.deleteShape(state.arrowId);
        if (side === "left") void handoffVideoFrame(editor, shape.id, target.id, videoHandoffEdges(side).target).catch(cause => showCanvasToast(cause instanceof Error ? cause.message : "连接尾帧失败"));
        else window.dispatchEvent(new CustomEvent("frameflow-port-choice", { detail: { sourceId: shape.id, targetId: target.id, client: { x: upEvent.clientX, y: upEvent.clientY } } }));
        return;
      }
      if (side === "left") { editor.deleteShape(state.arrowId); showCanvasToast("请拖到已有视频节点，为它添加尾帧"); return; }
      if (target?.type === "h3-node" && shape.type === "image-node" && state.referenceIds.length > 1 && !target.isLocked) {
        editor.deleteShape(state.arrowId);
        for (const id of state.referenceIds) {
          const image = referenceImageOf(editor.getShape(id));
          if (image && !getIncomingReferenceImages(editor, target.id).some((existing) => existing.id === id) && getIncomingFrameSource(editor, target.id, "first")?.id !== id) createBoundArrow(editor, image, target as H3Node, "reference");
        }
        showCanvasToast("已将框选图片一起加入视频参考");
        return;
      }
      if (!target || !isCompatibleConnection(shape, target)) {
        editor.deleteShape(state.arrowId);
        if (!target) window.dispatchEvent(new CustomEvent("frameflow-port-drop", { detail: { sourceId: shape.id, referenceIds: state.referenceIds, client: { x: upEvent.clientX, y: upEvent.clientY }, page: pagePoint } }));
        else showCanvasToast("此处不能建立这种节点连接");
        return;
      }
      if (target.type === "h3-node" && !magnet && shape.type === "image-node") {
        editor.deleteShape(state.arrowId);
        window.dispatchEvent(new CustomEvent("frameflow-port-choice", { detail: { sourceId: shape.id, targetId: target.id, client: { x: upEvent.clientX, y: upEvent.clientY } } }));
        return;
      }
      if (target.type === "h3-node" && magnet?.role === "guide" && shape.type === "image-node") {
        const h3 = target as H3Node;
        const slot = Number(magnet.card.dataset.guideSlot);
        const guides = (h3.props.storyboardGuides ?? []).map((g, index) => ({ ...g, slot: g.slot ?? index })).filter((g) => !g.sourceNodeId || editor.getCurrentPageShapes().some((a) => {
          if (a.type !== "arrow" || a.meta.guideSlot !== g.slot) return false;
          const bindings = getArrowBindings(editor, a as TLArrowShape);
          return bindings.end?.toId === h3.id && bindings.start?.toId === g.sourceNodeId;
        }));
        const previous = guides.find((g) => g.slot === slot);
        if (!previous && guides.length + (h3.props.directorContext?.guides?.length ?? 0) >= 4) { editor.deleteShape(state.arrowId); showCanvasToast("引导锚点合计最多 4 个"); return; }
        const oldArrows = editor.getCurrentPageShapes().filter((a) => a.type === "arrow" && a.id !== state.arrowId && a.meta.guideSlot === slot && getArrowBindings(editor, a as TLArrowShape).end?.toId === target.id);
        editor.deleteShapes(oldArrows.map((a) => a.id));
        editor.updateShape({ id: h3.id, type: "h3-node", props: { storyboardGuides: [...guides.filter((g) => g.slot !== slot), { assetId: shape.props.assetId ?? "", storageReference: shape.props.src, filename: shape.props.name, sourceNodeId: shape.id, slot, anchorFrame: previous?.anchorFrame ?? Math.round((getActualDuration(h3.props.duration).length - 1) * (slot + 1) / 4), atEnd: previous?.atEnd ?? false }] } });
        editor.updateShape({ id: state.arrowId, type: "arrow", meta: { frameRole: "guide", guideSlot: slot } });
        editor.createBinding({ type: "arrow", fromId: state.arrowId, toId: target.id, props: { terminal: "end", normalizedAnchor: { x: 0, y: 0.1 }, isExact: true, isPrecise: true, snap: "none" } });
        showCanvasToast(`已连接到分镜 ${slot + 1}`);
        return;
      }
      const frameRole: H3FrameRole = magnet?.role === "guide" ? "first" : magnet?.role ?? "first";
      if (target.type === "flux-image-node") {
        editor.deleteShapes(editor.getBindingsToShape(target.id, "arrow").filter(b => b.props.terminal === "end" && b.fromId !== state.arrowId).map(b => b.fromId));
        editor.updateShape({ id: target.id, type: "flux-image-node", props: { imageMode: true } });
        showCanvasToast("已连接图生图原图；填写提示词后生成");
      }
      const anchorY = target.type === "h3-node" && (shape.type === "image-node" || shape.type === "video-node") ? H3_INPUT_ANCHORS[frameRole] : 0.5;
      if (target.type === "h3-node" && frameRole !== "reference" && (shape.type === "image-node" || shape.type === "video-node")) removeExistingFrameConnection(editor, target.id, frameRole, state.arrowId);
      editor.createBinding({ type: "arrow", fromId: state.arrowId, toId: target.id, props: { terminal: "end", normalizedAnchor: { x: 0, y: anchorY }, isExact: false, isPrecise: true, snap: "edge" } });
      editor.updateShape({ id: state.arrowId, type: "arrow", meta: { frameRole }, props: { kind: "elbow", elbowMidPoint: getWorkflowMidpoint(shape, target as CustomNode) } });
      if (target.type === "h3-node" && shape.type === "image-node") showCanvasToast(frameRole === "last" ? "已连接为尾帧" : frameRole === "reference" ? "已连接为参考图" : "已连接为首帧");
      if (target.type === "h3-node" && shape.type === "video-node") void extractVideoLastFrame(shape.props.src).then(async (frame) => { const name = `${shape.props.name}-尾帧.jpg`; const src = await storeLocalImage(await getLocalImageBlob(frame.dataUrl), name); if (editor.getShape(target.id)) editor.updateShape({ id: target.id, type: "h3-node", props: { sourceFrameSrc: src, sourceFrameName: name } }); }).catch((cause) => showCanvasToast(cause instanceof Error ? cause.message : "无法提取视频尾帧"));
    };
    // Canvas/forms stop bubbling pointer events. Observe release in capture without
    // cancelling the event, so a visible preview always becomes a real binding.
    window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", up, { once: true, capture: true }); window.addEventListener("pointercancel", up, { once: true, capture: true });
  };
  const label = side === "left" ? "拖到上一视频：将本视频首帧设为它的尾帧；单击添加输入" : shape.type === "video-node" || shape.type === "h3-node" ? "拖动连线；单击选择尾帧做视频或高清" : shape.type === "image-node" ? "拖动连线；单击选择图生图或 H3 视频" : "拖动到视频节点建立连线";
  return <button type="button" data-workflow-node-id={shape.id} className={`workflow-port${side === "left" ? " workflow-input-port" : ""}`} aria-label={label} title={label} onPointerDownCapture={onPointerDown}><Plus size={12} /></button>;
}
