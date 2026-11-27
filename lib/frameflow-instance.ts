/** Runtime identity of this canvas process. The default instance (5173, no name) keeps empty id. */
export type FrameflowInstanceInfo = { id: string; name: string; inboxPort: number; claimPort: number; transfer: string };

const fallback: FrameflowInstanceInfo = { id: "", name: "", inboxPort: 5193, claimPort: 8791, transfer: "http://127.0.0.1:5198" };
let current: FrameflowInstanceInfo = fallback;
let pending: Promise<FrameflowInstanceInfo> | null = null;

function readInjected() {
  if (typeof window === "undefined") return;
  const injected = (window as Window & { __FRAMEFLOW_INSTANCE__?: Partial<FrameflowInstanceInfo> }).__FRAMEFLOW_INSTANCE__;
  if (!injected || typeof injected !== "object") return;
  current = {
    id: injected.id || "",
    name: injected.name || "",
    inboxPort: Number(injected.inboxPort) || 5193,
    claimPort: Number(injected.claimPort) || 8791,
    transfer: injected.transfer || fallback.transfer,
  };
}
readInjected();

export function frameflowInstance() { return current; }

export function loadFrameflowInstance() {
  if (typeof window === "undefined") return Promise.resolve(current);
  readInjected();
  if (current.id || current.name) return Promise.resolve(current);
  if (!pending) {
    pending = fetch("/api/instance", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return current;
      const body = await response.json() as Partial<FrameflowInstanceInfo>;
      current = { id: body.id || "", name: body.name || "", inboxPort: Number(body.inboxPort) || 5193, claimPort: Number(body.claimPort) || 8791, transfer: body.transfer || fallback.transfer };
      return current;
    }).catch(() => current);
  }
  return pending;
}

/**
 * Default instance (empty id) accepts only history rows that have no instance stamp.
 * A named instance accepts only rows stamped with its own id.
 * Lookup is still by the caller's own prompt_id; this rejects a colliding row from the other canvas.
 */
export function historyBelongsToThisInstance(entry: { prompt?: unknown }) {
  const prompt = entry.prompt;
  const extra = Array.isArray(prompt) ? prompt[3] : undefined;
  const marked = extra && typeof extra === "object" ? (extra as { frameflowInstance?: unknown }).frameflowInstance : undefined;
  const mine = frameflowInstance().id;
  if (typeof marked !== "string" || !marked) return mine === "";
  return marked === mine;
}

export const SPLIT_PAGES = [
  { id: "page1", port: 5174, label: "Page 1", inboxPort: 5194, claimPort: 8804, match: (name: string) => name.trim() === "Page 1" },
  { id: "xincanvas", port: 5175, label: "新画布", inboxPort: 5195, claimPort: 8805, match: (name: string) => name.trim() === "新画布" },
  { id: "yemian1", port: 5176, label: "页面 1", inboxPort: 5196, claimPort: 8806, match: (name: string) => name.trim() === "页面 1" },
  { id: "yemian2", port: 5177, label: "页面 2", inboxPort: 5197, claimPort: 8807, match: (name: string) => name.trim() === "页面 2" },
] as const;

export function pageStaysOnDefault(name: string) {
  const trimmed = name.trim();
  return trimmed === "仙侠" || trimmed.startsWith("尾帧高清队列验收");
}

export function instanceForPageName(name: string) {
  return SPLIT_PAGES.find((item) => item.match(name)) ?? null;
}

/** workerd does not inherit FRAMEFLOW_* . Only 5174–5177 map to a split canvas; every other port stays the default instance. */
export function instanceForPort(port: number) {
  return SPLIT_PAGES.find((item) => item.port === port) ?? null;
}

export function requestPort(request: Request) {
  const fromUrl = Number(new URL(request.url).port);
  if (fromUrl) return fromUrl;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
  const match = /:(\d+)\s*$/.exec(host);
  return match ? Number(match[1]) : 0;
}

export function mediaKeysIn(value: unknown, keys = new Set<string>()) {
  if (typeof value === "string") { if (/^(image:|media:|audio:)/.test(value)) keys.add(value); }
  else if (Array.isArray(value)) for (const item of value) mediaKeysIn(item, keys);
  else if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) mediaKeysIn(item, keys);
  return keys;
}
