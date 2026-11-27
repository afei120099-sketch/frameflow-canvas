/**
 * Phase 9: one Object URL per media key, shared and reference-counted.
 *
 * - Concurrent requests for the same key share one in-flight load (the old cache was checked
 *   before an async read, so N nodes mounting together created N URLs and leaked N-1).
 * - acquire()/release() count users; when the count reaches 0 the URL is revoked after a grace
 *   period (undo/redo and viewport jitter re-acquire without reloading the Blob).
 * - pin() is for existing callers that never release (resolveImageSource etc.): the URL is shared
 *   but kept for the page lifetime, exactly as before.
 * Blob storage is untouched; only URL lifetime is managed here.
 */

type UrlApi = { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
interface Entry { promise: Promise<string>; url: string | null; refs: number; pinned: boolean; timer: unknown; failed: boolean }

export class ObjectUrlRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly api: UrlApi;
  private readonly timers: Timers;
  private readonly graceMs: number;
  created = 0;
  revoked = 0;

  constructor(options: { api?: UrlApi; timers?: Timers; graceMs?: number } = {}) {
    this.api = options.api ?? URL;
    this.timers = options.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    this.graceMs = options.graceMs ?? 4_000;
  }

  private entry(key: string, load: () => Promise<Blob>) {
    let entry = this.entries.get(key);
    if (!entry || entry.failed) {
      const created: Entry = { promise: Promise.resolve(""), url: null, refs: 0, pinned: false, timer: null, failed: false };
      created.promise = load().then((blob) => {
        const url = this.api.createObjectURL(blob);
        this.created += 1;
        // Released to zero (and not pinned) while loading: do not keep a URL nobody holds.
        if (this.entries.get(key) !== created) { this.api.revokeObjectURL(url); this.revoked += 1; return url; }
        created.url = url;
        return url;
      }, (cause) => { created.failed = true; if (this.entries.get(key) === created) this.entries.delete(key); throw cause; });
      this.entries.set(key, created);
      entry = created;
    }
    if (entry.timer !== null) { this.timers.clear(entry.timer); entry.timer = null; }
    return entry;
  }

  /** Shared URL for `key`; call release(key) exactly once when this user is done. */
  acquire(key: string, load: () => Promise<Blob>) { const entry = this.entry(key, load); entry.refs += 1; return entry.promise; }

  /** Shared URL kept for the page lifetime (legacy resolve* callers). */
  pin(key: string, load: () => Promise<Blob>) { const entry = this.entry(key, load); entry.pinned = true; return entry.promise; }

  release(key: string) {
    const entry = this.entries.get(key);
    if (!entry || entry.refs === 0) return;
    entry.refs -= 1;
    if (entry.refs > 0 || entry.pinned) return;
    entry.timer = this.timers.set(() => {
      if (this.entries.get(key) !== entry || entry.refs > 0 || entry.pinned) return;
      this.entries.delete(key);
      if (entry.url) { this.api.revokeObjectURL(entry.url); this.revoked += 1; }
    }, this.graceMs);
  }

  /** Drop idle unpinned URLs the current page does not show. Pinned submit/download URLs and
   * URLs a mounted component still holds (refs > 0, e.g. `thumb:` previews) stay. */
  releaseUnreferenced(keep: ReadonlySet<string>) {
    for (const [key, entry] of this.entries) {
      if (keep.has(key) || entry.pinned || entry.refs > 0) continue;
      if (entry.timer !== null) { this.timers.clear(entry.timer); entry.timer = null; }
      entry.refs = 0;
      this.entries.delete(key);
      if (entry.url) { this.api.revokeObjectURL(entry.url); entry.url = null; this.revoked += 1; }
    }
  }

  stats() {
    let live = 0; let referenced = 0; let pinned = 0;
    for (const entry of this.entries.values()) { if (entry.url) live += 1; if (entry.refs > 0) referenced += 1; if (entry.pinned) pinned += 1; }
    return { keys: this.entries.size, liveUrls: live, referenced, pinned, created: this.created, revoked: this.revoked };
  }
}

export const mediaUrlRegistry = new ObjectUrlRegistry();
