import type { Editor, TLShape, TLShapeId } from "tldraw";
import { nearestFrameDropTarget } from "../../lib/frame-drop-target";
import { showDropFeedback } from "./interaction-ui";

export const slotLabel = (role: string) => ({ first: "首帧", last: "尾帧", reference: "参考图", guide: "分镜参考" })[role] ?? "参考素材";
export function findVisibleSlot(editor: Editor, point: { x: number; y: number }, excluded: readonly TLShapeId[], sourceType: string, radius = 42) {
  const targets = Array.from(document.querySelectorAll<HTMLElement>(".tl-shape[data-shape-type='h3-node'] [data-frame-role], .h3-creative-dock [data-frame-role]")).flatMap(card => {
    const id = card.closest<HTMLElement>(".h3-creative-dock")?.dataset.nodeId ?? card.closest<HTMLElement>(".tl-shape")?.dataset.shapeId;
    const target = id ? editor.getShape(id as TLShapeId) : undefined;
    if (!target || target.type !== "h3-node" || target.isLocked || excluded.includes(target.id)) return [];
    if (card.matches(":disabled") || card.closest("[data-drop-disabled='true']")) return [];
    if (!card.querySelector("img") && card.querySelector("button:disabled")) return [];
    if (sourceType === "video-node" && card.dataset.frameRole !== "first") return [];
    if (sourceType !== "image-node" && sourceType !== "video-node") return [];
    return [{ target, role: card.dataset.frameRole ?? "reference", card, bounds: card.getBoundingClientRect() }];
  });
  return nearestFrameDropTarget(point, targets, radius);
}
export function clearSlotFeedback() {
  document.querySelectorAll<HTMLElement>("[data-frame-role][data-magnetic]").forEach(card => { card.removeAttribute("data-magnetic"); card.removeAttribute("data-drop-label"); });
  document.querySelectorAll<HTMLElement>("[data-connect-state]").forEach(card => card.removeAttribute("data-connect-state"));
}
const bodyTargets = new WeakMap<Editor, ReturnType<typeof findVisibleSlot>>();
export const currentImageSlotTarget = (editor: Editor) => bodyTargets.get(editor);
export function trackImageSlotDragging(editor: Editor) {
  const clear = () => { bodyTargets.delete(editor); clearSlotFeedback(); showDropFeedback(null); };
  const move = (event: PointerEvent) => {
    if (!editor.isIn("select.translating")) return;
    const ids = editor.getSelectedShapeIds();
    const shapes = ids.map(id => editor.getShape(id));
    if (!shapes.length || !shapes.every(s => s?.type === "image-node")) return;
    clearSlotFeedback();
    const target = findVisibleSlot(editor, { x: event.clientX, y: event.clientY }, ids, "image-node", 14);
    const valid = !!target && (ids.length === 1 || target.role === "reference");
    bodyTargets.set(editor, valid ? target : null);
    if (!target) { showDropFeedback(null); return; }
    const label = valid ? `${target.card.querySelector("img") && target.role !== "reference" ? "将替换" : "放入"}${slotLabel(target.role)}${ids.length > 1 ? ` · ${ids.length} 张` : ""}` : "首尾帧一次放一张，多图请放参考槽";
    target.card.setAttribute("data-magnetic", valid ? "true" : "invalid");
    target.card.setAttribute("data-drop-label", label);
    showDropFeedback({ x: event.clientX, y: event.clientY, label, valid });
  };
  const up = () => { queueMicrotask(clear); };
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", clear, true);
  return () => { document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", up, true); document.removeEventListener("pointercancel", clear, true); clear(); };
}
