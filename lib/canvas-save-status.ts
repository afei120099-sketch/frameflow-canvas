/** Read-only confirmation of tldraw 5.x's existing IndexedDB writer. Never writes a second snapshot. */
export type SaveChanges = { added: Record<string, unknown>; updated: Record<string, [unknown, unknown]>; removed: Record<string, unknown> };
export function updatePendingRecords(pending: Map<string, unknown>, changes: SaveChanges) {
  for (const [id, record] of Object.entries(changes.added)) pending.set(id, record);
  for (const [id, [, record]] of Object.entries(changes.updated)) pending.set(id, record);
  for (const id of Object.keys(changes.removed)) pending.set(id, undefined);
}
export type CanvasSaveDifference = { id: string; field: string; expected: unknown; stored: unknown };
/** Diagnostic only: object-key order is reported separately; nothing is repaired or written. */
export function diffCanvasRecord(id: string, expected: unknown, stored: unknown): CanvasSaveDifference[] {
  const differences: CanvasSaveDifference[] = [];
  const sample = (value: unknown): unknown => value === undefined ? {missing:true} : typeof value === "string" && value.length > 240 ? `${value.slice(0,240)}… (${value.length}字符)` : value;
  const visit = (a: unknown, b: unknown, field: string) => {
    if (differences.length >= 100 || Object.is(a,b)) return;
    if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
      const left=a as Record<string,unknown>, right=b as Record<string,unknown>;
      for (const key of new Set([...Object.keys(left),...Object.keys(right)])) visit(left[key],right[key],field ? `${field}.${key}` : key);
    } else differences.push({id,field:field||"$record",expected:sample(a),stored:sample(b)});
  };
  visit(expected,stored,"");
  if (!differences.length && JSON.stringify(expected)!==JSON.stringify(stored)) differences.push({id,field:"$propertyOrder",expected:"完整字段值相同",stored:"仅对象键序不同，原严格核实仍不通过"});
  return differences;
}
export async function diagnoseCanvasRecords(persistenceKey:string, records:ReadonlyMap<string,unknown>) {
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open(`TLDRAW_DOCUMENT_v2${persistenceKey}`);
    let settled=false;
    const timer=setTimeout(()=>{settled=true;reject(Error("画布诊断读取超时"));},10_000);
    request.onupgradeneeded=()=>request.transaction?.abort();
    request.onsuccess=()=>{clearTimeout(timer);if(settled)request.result.close();else resolve(request.result);};
    request.onerror=()=>{clearTimeout(timer);reject(request.error??Error("画布诊断读取失败"));};
    request.onblocked=()=>{clearTimeout(timer);settled=true;reject(Error("画布存储被占用"));};
  });
  try {
    if(!db.objectStoreNames.contains("records"))throw Error("画布存储没有records表");
    return await new Promise<{checked:number;matches:boolean;differences:CanvasSaveDifference[]}>((resolve,reject)=>{
      const tx=db.transaction("records","readonly"), differences:CanvasSaveDifference[]=[];
      for(const [id,expected] of records){const request=tx.objectStore("records").get(id);request.onsuccess=()=>differences.push(...diffCanvasRecord(id,expected,request.result));}
      tx.oncomplete=()=>resolve({checked:records.size,matches:differences.length===0,differences});
      tx.onerror=tx.onabort=()=>reject(tx.error??Error("画布诊断读取事务失败"));
    });
  } finally {db.close();}
}
function recordsEqualIgnoringKeyOrder(expected: unknown, stored: unknown): boolean {
  if (Object.is(expected, stored)) return true;
  if (!expected || !stored || typeof expected !== "object" || typeof stored !== "object") return false;
  if (Array.isArray(expected) || Array.isArray(stored)) {
    if (!Array.isArray(expected) || !Array.isArray(stored) || expected.length !== stored.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (!recordsEqualIgnoringKeyOrder(expected[i], stored[i])) return false;
    }
    return true;
  }
  const left = expected as Record<string, unknown>;
  const right = stored as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] === undefined && right[key] === undefined) continue;
    if (!recordsEqualIgnoringKeyOrder(left[key], right[key])) return false;
  }
  return true;
}

export async function confirmCanvasRecords(persistenceKey: string, pending: ReadonlyMap<string, unknown>) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    let settled = false;
    const request = indexedDB.open(`TLDRAW_DOCUMENT_v2${persistenceKey}`);
    // diagnoseCanvasRecords already times out. This open did not, so a stuck
    // request held waitForCanvasSave, the submit lock, and the file tick forever.
    const timer = setTimeout(() => { if (settled) return; settled = true; reject(new Error("画布保存核实超时")); }, 20_000);
    timer.unref?.();
    const finish = (settle: () => void) => { if (settled) return; settled = true; clearTimeout(timer); settle(); };
    // Missing DB is not permission to create or migrate it.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => { if (settled) { request.result.close(); return; } finish(() => { if (blocked) request.result.close(); else resolve(request.result); }); };
    request.onerror = () => finish(() => reject(request.error ?? new Error("无法核实画布保存")));
    request.onblocked = () => { blocked = true; finish(() => reject(new Error("画布存储被其他窗口占用"))); };
  });
  try {
    if (!db.objectStoreNames.contains("records")) throw new Error("画布保存格式无法识别");
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction("records", "readonly");
      const timer = setTimeout(() => { try { tx.abort(); } catch { /* already finished */ } reject(new Error("画布保存核实超时")); }, 20_000);
      timer.unref?.();
      let matches = true;
      for (const [id, expected] of pending) {
        const request = tx.objectStore("records").get(id);
        request.onsuccess = () => { if (!recordsEqualIgnoringKeyOrder(expected, request.result)) matches = false; };
      }
      tx.oncomplete = () => { clearTimeout(timer); resolve(matches); };
      tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(tx.error ?? new Error("画布保存核实失败")); };
    });
  } finally { db.close(); }
}

export function watchCanvasSave(options: {
  persistenceKey: string; onStatus: (label: string) => void;
  verify?: typeof confirmCanvasRecords; delay?: number; timeout?: number;
}) {
  const pending = new Map<string, unknown>();
  let version = 0, closed = false, firstDirty = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const verify = options.verify ?? confirmCanvasRecords;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(check, options.delay ?? 650); };
  async function check() {
    if (closed || !pending.size) return;
    const token = version;
    try {
      const saved = await verify(options.persistenceKey, new Map(pending));
      if (closed || token !== version) return;
      if (saved) { pending.clear(); firstDirty = 0; options.onStatus("画布已保存"); }
      else {
        options.onStatus(Date.now() - firstDirty > (options.timeout ?? 10_000) ? "保存尚未确认，请导出备份" : "正在保存…");
        schedule();
      }
    } catch {
      if (!closed && token === version) { options.onStatus("保存核实失败，请导出备份"); schedule(); }
    }
  }
  return {
    changed(changes: SaveChanges) {
      if (closed) return;
      updatePendingRecords(pending, changes); version++;
      if (!firstDirty) firstDirty = Date.now();
      options.onStatus("正在保存…"); schedule();
    },
    hasPending: () => pending.size > 0,
    close() { closed = true; clearTimeout(timer); },
  };
}
