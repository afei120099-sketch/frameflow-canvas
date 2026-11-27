// Ephemeral playback positions only; never modifies video files or canvas records.
const positions = new Map<string, number>();
// Resolve taps after pointer capture as well as native clicks. A double tap must
// cancel the pending single tap, never pause/resume the video twice.
const pendingTaps = new WeakMap<HTMLElement, { timer: ReturnType<typeof setTimeout>; x: number; y: number }>();
export function cancelVideoTap(element: HTMLElement | null) {
  if (!element) return;
  const pending = pendingTaps.get(element);
  if (pending) clearTimeout(pending.timer);
  pendingTaps.delete(element);
}
export function queueVideoTap(element: HTMLElement, x: number, y: number, single: () => void, double: () => void) {
  const pending = pendingTaps.get(element);
  if (pending && Math.hypot(x - pending.x, y - pending.y) <= 12) {
    cancelVideoTap(element);
    double();
    return;
  }
  cancelVideoTap(element);
  const timer = setTimeout(() => {
    pendingTaps.delete(element);
    if (element.isConnected) single();
  }, 300);
  pendingTaps.set(element, { timer, x, y });
}
export function rememberVideoPosition(key: string, video: Pick<HTMLVideoElement, 'currentTime'>) {
  if (Number.isFinite(video.currentTime)) positions.set(key, video.currentTime);
  if (positions.size > 256) positions.delete(positions.keys().next().value!);
}
export function clearVideoPosition(key: string) { positions.delete(key); }
export function restoreVideoPosition(key: string, video: Pick<HTMLVideoElement, 'currentTime' | 'duration'>) {
  const time = positions.get(key);
  if (time !== undefined && time > 0 && time < video.duration) video.currentTime = time;
}
export function pauseVideoOutsideViewport(video: HTMLVideoElement) {
  const rect = video.getBoundingClientRect();
  if (document.hidden || rect.width === 0 || rect.height === 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) video.pause();
}
