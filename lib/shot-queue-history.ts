/**
 * 每份队列（按队列标题）的修改历史：最近 20 版，可撤销 / 恢复。
 * 存在 IndexedDB 的 meta 里（不放 localStorage：20 版 × 100 多 KB 会撑爆它的几 MB 上限）。
 * 只存文本，不解析、不入队、不碰节点。
 */
export const QUEUE_HISTORY_LIMIT = 20;
export interface QueueHistory { versions: string[]; index: number }

const EMPTY: QueueHistory = { versions: [], index: -1 };

/** Add a version after the current one; anything that was undone is dropped (like any editor). */
export function pushVersion(history: QueueHistory, text: string, limit = QUEUE_HISTORY_LIMIT): QueueHistory {
  if (history.versions[history.index] === text) return history;
  const versions = [...history.versions.slice(0, history.index + 1), text];
  const drop = Math.max(0, versions.length - limit);
  return { versions: versions.slice(drop), index: versions.length - 1 - drop };
}
export const canUndo = (history: QueueHistory) => history.index > 0;
export const canRedo = (history: QueueHistory) => history.index >= 0 && history.index < history.versions.length - 1;
export function stepVersion(history: QueueHistory, delta: -1 | 1): { history: QueueHistory; text: string } | null {
  const index = history.index + delta;
  if (index < 0 || index >= history.versions.length) return null;
  return { history: { ...history, index }, text: history.versions[index] };
}

type Meta = { get: (key: string) => Promise<QueueHistory | undefined | null>; put: (key: string, value: QueueHistory) => Promise<unknown> };
const historyKey = (title: string) => `shot-queue-history:v1:${title}`;
const valid = (value: unknown): value is QueueHistory => !!value && typeof value === "object" && Array.isArray((value as QueueHistory).versions) && (value as QueueHistory).versions.every((item) => typeof item === "string") && Number.isInteger((value as QueueHistory).index);

/** Serialised per store: a record right after an undo can never interleave with it. */
export class QueueHistoryStore {
  private cache = new Map<string, QueueHistory>();
  private chain: Promise<unknown> = Promise.resolve();
  private meta: Meta;
  constructor(meta: Meta) { this.meta = meta; }
  private async read(title: string) {
    let history = this.cache.get(title);
    if (!history) {
      const saved = await this.meta.get(historyKey(title)).catch(() => null);
      history = valid(saved) && saved.index < saved.versions.length ? saved : EMPTY;
      this.cache.set(title, history);
    }
    return history;
  }
  private run<T>(work: () => Promise<T>) { const next = this.chain.then(work); this.chain = next.catch(() => undefined); return next; }
  private async write(title: string, history: QueueHistory) { this.cache.set(title, history); await this.meta.put(historyKey(title), history); }
  state(title: string) { return this.run(() => this.read(title)); }
  record(title: string, text: string) { return this.run(async () => { const before = await this.read(title); const after = pushVersion(before, text); if (after !== before) await this.write(title, after); return after; }); }
  step(title: string, delta: -1 | 1) { return this.run(async () => { const moved = stepVersion(await this.read(title), delta); if (moved) await this.write(title, moved.history); return moved; }); }
}
