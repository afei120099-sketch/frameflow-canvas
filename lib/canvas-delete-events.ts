/** Shared event contract; no React imports, so deletion actions never depend on the UI that hosts them. */
export interface DeleteUndoOffer { restore: () => boolean; message?: string; onExpire?: () => Promise<string | void> | void }
/** One toast per delete: the outcome text and an 撤销 button. */
export const offerDeleteUndo = (restore: () => boolean, message?: string, onExpire?: () => Promise<string | void> | void) => window.dispatchEvent(new CustomEvent<DeleteUndoOffer>('canvas-delete-undo', { detail: { restore, ...(message ? { message } : {}), ...(onExpire ? { onExpire } : {}) } }));
