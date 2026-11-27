/** 1MB: real episode queues are already ~140KB. localStorage holds ~5M characters per site, one draft per canvas page. */
export const QUEUE_DRAFT_LIMIT = 1024 * 1024;
export const queueDraftKey = (workspace: string, page: string) => `frameflow.shot-queue-draft.v1:${encodeURIComponent(workspace)}:${encodeURIComponent(page)}`;
type Draft = { raw: string; source: "draft" | "session" | "external" | "manual"; dirty: boolean; pending: boolean };

/** Text only. No queue parsing, task APIs, node creation or auto-start access. */
export class QueueDraftBook {
  private pages = new Map<string, Draft>();
  private externalPages = new Map<string, string>();
  private applied = new Set<string>();
  private warned = new Set<string>();
  private workspace: string;
  private storage: () => Pick<Storage, "getItem" | "setItem">;
  private warn: (message: string) => void;
  constructor(workspace: string, storage: () => Pick<Storage, "getItem" | "setItem">, warn: (message: string) => void) { this.workspace = workspace; this.storage = storage; this.warn = warn; }
  private warning(page: string, message: string) { const key = page + "\u0000" + message; if (!this.warned.has(key)) { this.warned.add(key); this.warn(message); } }
  read(page: string): Draft {
    let draft = this.pages.get(page);
    if (!draft) {
      let raw = "", dirty = false;
      try {
        const saved = this.storage().getItem(queueDraftKey(this.workspace, page));
        if (saved && saved.length <= QUEUE_DRAFT_LIMIT * 6 + 128) {
          const value: unknown = JSON.parse(saved);
          if (value && typeof value === "object" && "raw" in value && typeof value.raw === "string" && new TextEncoder().encode(value.raw).length <= QUEUE_DRAFT_LIMIT) { raw = value.raw; dirty = "manual" in value && value.manual === true; }
        }
      } catch { this.warning(page, "草稿读取失败，当前操作不受影响，请自行保留镜头表文本"); }
      draft = { raw, source: "draft", dirty, pending: false }; this.pages.set(page, draft);
    }
    return draft;
  }
  edit(page: string, raw: string) { this.pages.set(page, { raw, source: "manual", dirty: true, pending: true }); }
  external(page: string, raw: string) {
    if (!raw) return false;
    if (!this.externalPages.has(raw)) this.externalPages.set(raw, page);
    if (this.externalPages.get(raw) !== page) return false;
    const key = page + "\u0000" + raw;
    if (!this.applied.has(key)) { this.applied.add(key); this.pages.set(page, { raw, source: "external", dirty: false, pending: true }); }
    return true;
  }
  isExternalTarget(page: string, raw: string) { return !!raw && this.externalPages.get(raw) === page; }
  isUneditedExternal(page: string, raw: string) { const draft = this.read(page); return this.isExternalTarget(page, raw) && draft.source === "external" && draft.raw === raw; }
  restoreSession(page: string, raw: string) {
    const draft = this.read(page);
    if (draft.dirty || draft.source === "external") return false;
    this.pages.set(page, { raw, source: "session", dirty: false, pending: true }); return true;
  }
  flush(page: string) {
    const draft = this.pages.get(page); if (!draft?.pending) return;
    if (new TextEncoder().encode(draft.raw).length > QUEUE_DRAFT_LIMIT) { this.warning(page, "镜头表草稿超过1MB，未保存草稿，请导出或复制保留"); return; }
    try { this.storage().setItem(queueDraftKey(this.workspace, page), JSON.stringify({ version: 1, raw: draft.raw, manual: draft.dirty })); draft.pending = false; for (const key of this.warned) if (key.startsWith(page + "\u0000")) this.warned.delete(key); }
    catch { this.warning(page, "草稿保存失败，浏览器存储空间不足或不可写，请导出或复制保留"); }
  }
  flushAll() { for (const page of this.pages.keys()) this.flush(page); }
}
