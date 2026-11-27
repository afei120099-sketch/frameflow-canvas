/** Bounded hidden-tab fallback for tldraw store listeners; never writes or submits. */
type PendingFrame = { native: number; timer?: ReturnType<typeof setTimeout>; run: (time: number) => void };
const pendingFrames = new Map<number, PendingFrame>();
let pumpUsers = 0;
let pumpInstalled = false;
function armPendingFrames() {
  if (!pumpUsers || !document.hidden) return;
  for (const frame of pendingFrames.values()) if (frame.timer === undefined) frame.timer = setTimeout(() => frame.run(performance.now()), 16);
}
function installFramePump() {
  if (pumpInstalled) return;
  pumpInstalled = true;
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  let sequence = 0;
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = ++sequence;
    const frame: PendingFrame = { native: 0, run: (time) => { if (!pendingFrames.delete(id)) return; nativeCancel(frame.native); if (frame.timer !== undefined) clearTimeout(frame.timer); callback(time); } };
    frame.native = nativeRequest((time) => frame.run(time));
    pendingFrames.set(id, frame);
    armPendingFrames();
    return id;
  };
  window.cancelAnimationFrame = (id: number) => {
    const frame = pendingFrames.get(id);
    if (!frame) return;
    pendingFrames.delete(id);
    nativeCancel(frame.native);
    if (frame.timer !== undefined) clearTimeout(frame.timer);
  };
  document.addEventListener('visibilitychange', armPendingFrames);
}
// Install before the first scheduled callback; passive outside bounded work.
if (typeof window !== 'undefined') installFramePump();
export async function withCanvasBackgroundWork<T>(work: () => Promise<T> | T): Promise<T> {
  pumpUsers++;
  if (typeof document !== 'undefined') armPendingFrames();
  try { return await work(); }
  finally { setTimeout(() => { pumpUsers--; }, 3000); }
}
