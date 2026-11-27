/** App-wide canvas events (toasts, Shot changes). Extracted from canvas-workspace.tsx (Stage I, no behaviour change). */
export const CANVAS_TOAST_EVENT = "canvas-toast";
export const SHOT_CHANGED_EVENT = "frameflow-shot-changed";
export const showCanvasToast = (message: string) => window.dispatchEvent(new CustomEvent(CANVAS_TOAST_EVENT, { detail: message }));
export const announceShotChange = (shotId: string) => window.dispatchEvent(new CustomEvent(SHOT_CHANGED_EVENT, { detail: shotId }));
