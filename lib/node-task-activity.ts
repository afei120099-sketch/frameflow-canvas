/** Deletion protection only. Releasing a query never cancels a backend job. */
const activity = new Map<string, number>();
export function holdNodeTask(id: string) {
  activity.set(id, (activity.get(id) ?? 0) + 1);
  let released = false;
  return () => { if (released) return; released = true; const count = (activity.get(id) ?? 1) - 1; if (count) activity.set(id, count); else activity.delete(id); };
}
export const hasNodeTask = (id: string) => (activity.get(id) ?? 0) > 0;

const removing = new Set<string>();
const cancellers = new Map<string, () => Promise<boolean | void>>();
const queueCancellers = new Map<string, (ids: readonly string[]) => Promise<void>>();
export const isNodeBeingRemoved = (id: string) => removing.has(id);
export function fenceNodeRemoval(ids: readonly string[]) {
  if (ids.some(id => removing.has(id))) throw Error('这些节点正在取消并删除，请勿重复操作');
  ids.forEach(id => removing.add(id));
  return () => ids.forEach(id => removing.delete(id));
}
export function registerNodeTaskCancel(id: string, cancel: () => Promise<boolean | void>) {
  cancellers.set(id, cancel);
  return () => { if (cancellers.get(id) === cancel) cancellers.delete(id); };
}
export async function cancelRegisteredNodeTask(id: string) {
  const cancel = cancellers.get(id);
  if (cancel && await cancel() === false) throw Error('节点任务尚未确认停止，节点保留，请查询任务状态后重试删除');
}
export function registerQueueRemovalCancel(pageId: string, cancel: (ids: readonly string[]) => Promise<void>) {
  queueCancellers.set(pageId, cancel);
  return () => { if (queueCancellers.get(pageId) === cancel) queueCancellers.delete(pageId); };
}
export const cancelQueueForRemoval = (pageId: string, ids: readonly string[]) => queueCancellers.get(pageId)?.(ids) ?? Promise.resolve();
