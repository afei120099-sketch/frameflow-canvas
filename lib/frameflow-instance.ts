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

type SplitPage = { id: string; port: number; label: string; inboxPort: number; claimPort: number; match: (name: string) => boolean };

// Public so the browser and server use the same build-time mapping. Empty means no splitting.
export function parseSplitPages(raw: string): SplitPage[] {
  if (!raw.trim()) return [];
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error("Page split configuration must be an array");
  const ids = new Set<string>(), ports = new Set<number>(), labels = new Set<string>();
  return rows.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid page split entry");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !/^[a-z0-9_-]+$/i.test(row.id) || typeof row.label !== "string" || !row.label.trim()) throw new Error("Invalid page split id or label");
    for (const key of ["port", "inboxPort", "claimPort"]) {
      const port = row[key];
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535 || ports.has(port) || [5173, 5192, 5193, 8791].includes(port)) throw new Error("Invalid or duplicate page split port");
      ports.add(port);
    }
    const id = row.id, label = row.label.trim();
    if (ids.has(id) || labels.has(label)) throw new Error("Duplicate page split id or label");
    ids.add(id); labels.add(label);
    return { id, label, port: row.port as number, inboxPort: row.inboxPort as number, claimPort: row.claimPort as number, match: (name: string) => name.trim() === label };
  });
}

export const SPLIT_PAGES = parseSplitPages(process.env.NEXT_PUBLIC_FRAMEFLOW_SPLIT_PAGES || "");

export function pageStaysOnDefault(name: string) {
  return !instanceForPageName(name);
}

export function instanceForPageName(name: string) {
  return SPLIT_PAGES.find((item) => item.match(name)) ?? null;
}

/** Unconfigured ports stay on the default instance. */
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
