import type { Editor, TLShapeId, TLRecord } from "tldraw";

/** Restore only this deletion's record delta; never undo subsequent unrelated editing. */
export function deleteWithRestore(editor: Editor, ids: TLShapeId[]) {
  const records = () => new Map(editor.store.allRecords().filter(r => r.typeName === "shape" || r.typeName === "binding").map(r => [r.id, r]));
  const before = records();
  editor.markHistoryStoppingPoint("before deleting workflow nodes");
  editor.deleteShapes(ids);
  editor.markHistoryStoppingPoint("after deleting workflow nodes");
  const after = records();
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(id => JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)));
  let used = false;
  return () => {
    if (used || !changed.length) return false;
    // Refuse to overwrite an ID that has since been recreated or modified.
    if (changed.some(id => JSON.stringify(editor.store.get(id)) !== JSON.stringify(after.get(id)))) return false;
    used = true;
    editor.markHistoryStoppingPoint("before restoring deleted nodes");
    editor.run(() => {
      editor.store.remove(changed.filter(id => !before.has(id)));
      editor.store.put(changed.flatMap(id => before.has(id) ? [before.get(id)! as TLRecord] : []));
    });
    editor.markHistoryStoppingPoint("after restoring deleted nodes");
    return true;
  };
}
