/** Existing schemas only. Blocked/failed requests must not poison a cached connection. */
export function openLocalDatabase(name: string, version: number, upgrade: (request: IDBOpenDBRequest) => void, invalidate: () => void, message: string): Promise<IDBDatabase> {
  // Defer creation so the caller assigns its cache identity even on a synchronous SecurityError.
  return Promise.resolve().then(() => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version);
    let abandoned = false;
    let settled = false;
    // An open that never fires success/error pins every later read and the file tick.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      abandoned = true;
      reject(new Error(`${message}：打开超时`));
    }, 20_000);
    timer.unref?.();
    const finish = (settle: () => void) => { if (settled) return; settled = true; clearTimeout(timer); settle(); };
    const abortUpgrade = () => { try { request.transaction?.abort(); } catch { /* Already-finished upgrade; keep the original rejection. */ } };
    request.onblocked = () => { abandoned = true; finish(() => reject(new Error(`${message}：数据库被其他页面占用，请关闭其他画布标签页后重试`))); };
    request.onerror = () => { abandoned = true; finish(() => reject(request.error ?? new Error(message))); };
    request.onupgradeneeded = () => {
      if (abandoned) { abortUpgrade(); return; }
      try { upgrade(request); }
      catch (cause) { abandoned = true; finish(() => { abortUpgrade(); reject(cause); }); }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (abandoned || settled) { clearTimeout(timer); db.close(); return; }
      finish(() => {
        db.onversionchange = () => { db.close(); invalidate(); };
        db.onclose = () => { invalidate(); };
        resolve(db);
      });
    };
  })).catch(cause => { invalidate(); throw cause; });
}
