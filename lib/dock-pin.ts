import { atom } from "tldraw";

/**
 * The H3 node whose creative dock is pinned open. Shared so the culling wrapper keeps that node mounted
 * through zoom and pan (otherwise unmounting it would drop the open dock), and so a remounted node can
 * reopen its dock.
 */
export const pinnedDockShapeId = atom<string | null>("pinned H3 creative dock", null);

export function pinDock(shapeId: string) { pinnedDockShapeId.set(shapeId); }
export function unpinDock(shapeId: string) { if (pinnedDockShapeId.get() === shapeId) pinnedDockShapeId.set(null); }
export const isDockPinned = (shapeId: string) => pinnedDockShapeId.get() === shapeId;
