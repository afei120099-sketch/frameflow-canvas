import type { Editor, TLShape } from "tldraw";
import { snapMediaRect, visibleMediaRect, type MagnetRect } from "../../lib/media-magnet";

const sessions = new WeakMap<Editor, { id: string; targets: MagnetRect[] }>();
export function startMediaMagnet(editor: Editor, shape: TLShape) {
  sessions.delete(editor);
  // Do not change relative positions in multi-selection or rotated groups.
  if (editor.getSelectedShapeIds().length !== 1 || shape.rotation !== 0) return;
  const targets = editor.getSortedChildIdsForParent(shape.parentId).flatMap(id => {
    const target = editor.getShape(id);
    if (!target || target.id === shape.id || target.rotation !== 0) return [];
    const rect = visibleMediaRect(target);
    return rect ? [rect] : [];
  });
  sessions.set(editor, { id: shape.id, targets });
}
export function translateMediaMagnet<S extends TLShape>(editor: Editor, current: S): { id: S["id"]; type: S["type"]; x: number; y: number } | undefined {
  const session = sessions.get(editor);
  if (!session || session.id !== current.id) return;
  const rect = visibleMediaRect(current);
  if (!rect) return;
  // Leave modifier gestures (duplicate, constrained movement, native snapping) intact.
  if (editor.inputs.getAltKey() || editor.inputs.getCtrlKey() || editor.inputs.getShiftKey()) {
    editor.snaps.clearIndicators(); return;
  }
  const result = snapMediaRect(rect, session.targets, editor.getZoomLevel());
  const transform = editor.getShapeParentTransform(current);
  editor.snaps.setIndicators(result.guides.map((points, index) => ({ id: `media-magnet-${index}`, type: "points" as const, points: points.map(p => transform.applyToPoint(p)) })));
  return { id: current.id, type: current.type, x: current.x + result.dx, y: current.y + result.dy };
}
export function endMediaMagnet(editor: Editor) {
  sessions.delete(editor);
  editor.snaps.clearIndicators();
}
