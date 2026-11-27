/**
 * 审片标记的存储：生成记录库（frameflow-production-records）meta 里的一行 `review-tags-v1`，
 * 和修改历史、去配乐任务同一个地方（A 批「持久存储」那一套）。所以：刷新页面还在；
 * 每日轻量备份和「备份到文件夹」导出整个 meta，标记跟着走；恢复备份时也一起恢复。
 * 返修说明放在同一库的 `review-rework-note-v1:<返修队列标题>`。
 */
import { getMeta, patchMeta, putMeta } from "./production-records.ts";
import { isReviewBook, putEntry, type ReviewBook, type ReviewEntry } from "./review-tags.ts";

export const REVIEW_TAGS_META_KEY = "review-tags-v1";
export const reworkNoteKey = (title: string) => `review-rework-note-v1:${title}`;

const listeners = new Set<(book: ReviewBook) => void>();
export function subscribeReviewTags(listener: (book: ReviewBook) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export async function loadReviewBook(): Promise<ReviewBook> {
  const value = await getMeta<unknown>(REVIEW_TAGS_META_KEY);
  return isReviewBook(value) ? value : {};
}

/** One transaction on the latest row: two tabs tagging different videos never overwrite each other. */
export async function saveReviewEntry(entry: ReviewEntry): Promise<ReviewBook> {
  const book = await patchMeta<ReviewBook>(REVIEW_TAGS_META_KEY, (current) => putEntry(isReviewBook(current) ? current : {}, { ...entry, updatedAt: Date.now() })) ?? {};
  for (const listener of listeners) listener(book);
  return book;
}

export interface ReworkNoteRecord { from: string; title: string; text: string; createdAt: number }
export const saveReworkNote = (record: ReworkNoteRecord) => putMeta(reworkNoteKey(record.title), record);
export async function loadReworkNote(title: string): Promise<ReworkNoteRecord | null> {
  const value = await getMeta<ReworkNoteRecord>(reworkNoteKey(title)).catch(() => null);
  return value && typeof value.text === "string" ? value : null;
}
