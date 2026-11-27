/** Local media and project-record writes share this origin-wide lock with backup restore. */
const LOCK = "frameflow-project-media-restore";
let restoring = false;
let pending: Promise<unknown> = Promise.resolve();
type LockApi = { request<T>(name: string, options: { mode: "exclusive" | "shared"; ifAvailable?: boolean }, action: (lock: unknown) => Promise<T>): Promise<T> };
const locks = () => (globalThis.navigator as unknown as { locks?: LockApi } | undefined)?.locks;
const blocked = () => new Error("项目正在恢复，媒体写入已暂停；请恢复完成后重试");

export function withProjectMediaWrite<T>(action: () => Promise<T>): Promise<T> {
  if (restoring) return Promise.reject(blocked());
  const api = locks();
  if (api) return api.request(LOCK, { mode: "shared", ifAvailable: true }, (lock) => lock ? action() : Promise.reject(blocked()));
  const result = pending.then(action, action);
  pending = result.catch(() => undefined);
  return result;
}

export async function withProjectRestoreLock<T>(action: () => Promise<T>): Promise<T> {
  if (restoring) throw blocked();
  const api = locks();
  // Restore must be exclusive across tabs; fail closed on unsupported browsers.
  if (typeof window !== "undefined" && !api) throw new Error("当前浏览器不支持安全恢复锁，请使用新版 Chrome 或 Edge");
  restoring = true;
  try {
    if (api) return await api.request(LOCK, { mode: "exclusive" }, action);
    await pending;
    return await action();
  } finally { restoring = false; }
}
