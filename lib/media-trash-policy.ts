/** Conservative, metadata-only reference checks. Never treats a producer Run as a consumer. */
export type TrashAsset = { assetId: string; storageReference: string; canvasPageIds?: string[] };
export type TrashRun = { runId?: string; status: string; ownerNodeId?: string | null; createdAt?: number; inputAssetIds: string[]; referenceInputs?: unknown; referenceManifest?: unknown };
/** Reason texts double as summary categories (see safe-delete deleteSummary). Keep them stable. */
export const TRASH_REASON = {
  otherCanvas: '其他画布的素材库仍在使用',
  otherShapes: '其他节点或画布仍在引用',
  roles: '角色外观或声音仍在引用',
  adopted: '该素材是已采用版本',
  activeRun: '未结束的生成任务仍在用它作输入',
  otherAssets: '其他衍生素材仍在引用',
  pendingQueue: '未完成的队列仍在引用',
  metadata: '成片序列或导演资料仍在引用',
} as const;
/** Only these run states are final; any other (queued / running / unknown future state) still consumes its inputs. */
const FINISHED_RUN = new Set(['completed', 'failed', 'cancelled']);
export const runStillActive = (run: { status: string }) => !FINISHED_RUN.has(run.status);
/** Automatic quality reports describe an asset; they do not consume its bytes.
 * Match the real v1 record, not arbitrary metadata whose key merely looks similar.
 * All unknown metadata remains protected by the conservative reference scan.
 */
export function isHistoricalAuditMetadata(row: unknown): boolean {
  if (!row || typeof row !== 'object' || !('key' in row) || !('value' in row)) return false;
  const value = row.value;
  if (!value || typeof value !== 'object' || !('assetId' in value) || !('version' in value)) return false;
  return typeof value.assetId === 'string' && value.version === 1 && row.key === `automatic-audit-v1:${value.assetId}`;
}
export function containsMediaReference(value: unknown, tokens: ReadonlySet<string>): boolean {
  if (typeof value === 'string') return tokens.has(value);
  if (Array.isArray(value)) return value.some(item => containsMediaReference(item, tokens));
  return !!value && typeof value === 'object' && Object.values(value).some(item => containsMediaReference(item, tokens));
}
export type QueueEntryLike ={ chapter?: unknown; shot?: unknown; nodeId?: string; removedAt?: number; cancelledAt?: number; submissionState?: string; rerun?: unknown };
type QueueSessionLike = { version: 1; entries: QueueEntryLike[]; queue?: { chapters?: { shots?: unknown[] }[] } };
const QUEUE_KEY = /^shot-queue-(session-v1|session-archive-v1|file-v2):/;
/** Recognised queue session row (same shape test as inbox-session-registry). Anything else is not a queue. */
function queueSessionOf(row: unknown): QueueSessionLike | null {
  if (!row || typeof row !== 'object' || !('key' in row) || typeof row.key !== 'string' || !QUEUE_KEY.test(row.key) || !('value' in row)) return null;
  const s = row.value as QueueSessionLike | null;
  if (!s || typeof s !== 'object' || s.version !== 1 || !Array.isArray(s.entries) || !s.entries.every(entry => !!entry && typeof entry === 'object')) return null;
  if (s.queue !== undefined && (!s.queue || typeof s.queue !== 'object' || (s.queue.chapters !== undefined && !Array.isArray(s.queue.chapters)))) return null;
  return s;
}
/**
 * An entry is finished only when the user removed/cancelled it, or its latest node run completed and no rerun
 * is waiting. Stopped batches, failed/uncertain/cancelling entries stay unfinished:「继续未完成」may still use them.
 * Same "latest run" rule as shot-queue-session latestQueueRun / inbox-queue-report.
 */
export function queueEntryFinished(entry: QueueEntryLike, runs: readonly TrashRun[]) {
  if (entry.removedAt || entry.cancelledAt) return true;
  if (!entry.nodeId) return false;
  if (entry.rerun && entry.submissionState === 'pending') return false;
  const latest = runs.filter(run => run.ownerNodeId === entry.nodeId).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
  return latest?.status === 'completed';
}
/** Queue rows protect media only through unfinished shots, plus batch-level settings while any shot is unfinished. */
function queueStillUses(session: QueueSessionLike, tokens: ReadonlySet<string>, runs: readonly TrashRun[]) {
  const finished = session.entries.filter(entry => queueEntryFinished(entry, runs));
  const pending = session.entries.filter(entry => !finished.includes(entry));
  if (pending.some(entry => containsMediaReference(entry, tokens))) return true;
  const chapters = session.queue?.chapters ?? [];
  // A queued shot is done only if a matching entry is finished; a shot without any entry stays protected.
  const shotDone = (chapter: number, shot: number) => finished.some(entry => entry.chapter === chapter && entry.shot === shot);
  if (chapters.some((chapter, c) => Array.isArray(chapter?.shots) && chapter.shots.some((shot, s) => !shotDone(c, s) && containsMediaReference(shot, tokens)))) return true;
  const allShotsDone = !pending.length && chapters.every((chapter, c) => Array.isArray(chapter?.shots) && chapter.shots.every((_shot, s) => shotDone(c, s)));
  if (allShotsDone) return false;
  // Everything outside per-shot data (batch settings, chapter settings, unknown fields) is shared by the unfinished shots.
  const omit = (value: unknown, key: string) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== key)) : value;
  const chapterRest = chapters.map(chapter => Array.isArray(chapter?.shots) ? omit(chapter, 'shots') : chapter);
  return containsMediaReference([omit(omit(session, 'entries'), 'queue'), omit(session.queue, 'chapters'), chapterRest], tokens);
}
export function mediaTrashBlockers(asset: TrashAsset, input: {
  pageId: string; otherShapes: unknown[]; roles: unknown[];
  runs: TrashRun[];
  shots: { adoptedAssetId?: string | null }[]; otherAssets: unknown[]; metadata: unknown[];
  /** Assets being recycled in this same delete; their own references to this asset do not count. */
  deletingAssetIds?: Iterable<string>;
}) {
  const tokens = new Set([asset.assetId, asset.storageReference]);
  const deleting = new Set(input.deletingAssetIds ?? []);
  const reasons: string[] = [];
  if (asset.canvasPageIds?.some(id => id !== input.pageId)) reasons.push(TRASH_REASON.otherCanvas);
  if (input.otherShapes.some(row => containsMediaReference(row, tokens))) reasons.push(TRASH_REASON.otherShapes);
  if (input.roles.some(row => containsMediaReference(row, tokens))) reasons.push(TRASH_REASON.roles);
  if (input.shots.some(row => row.adoptedAssetId === asset.assetId)) reasons.push(TRASH_REASON.adopted);
  if (input.runs.some(row => runStillActive(row) && containsMediaReference([row.inputAssetIds, row.referenceInputs, row.referenceManifest], tokens))) reasons.push(TRASH_REASON.activeRun);
  const otherAssetId = (row: unknown) => row && typeof row === 'object' && 'assetId' in row && typeof row.assetId === 'string' ? row.assetId : undefined;
  if (input.otherAssets.some(row => { const id = otherAssetId(row); return !(id && deleting.has(id)) && containsMediaReference(row, tokens); })) reasons.push(TRASH_REASON.otherAssets);
  let queueUse = false, otherUse = false;
  for (const row of input.metadata) {
    if (isHistoricalAuditMetadata(row)) continue;
    const session = queueSessionOf(row);
    if (session) queueUse ||= queueStillUses(session, tokens, input.runs);
    else otherUse ||= containsMediaReference(row, tokens);
  }
  if (queueUse) reasons.push(TRASH_REASON.pendingQueue);
  if (otherUse) reasons.push(TRASH_REASON.metadata);
  return reasons;
}
