import type { SaveChanges } from "./canvas-save-status.ts";
type RecordLike={id?:string;typeName?:string;type?:string;fromId?:string};
/** Compatibility depends on node type, not position/prompt/layout. */
export function affectedArrowIds(changes:SaveChanges, arrowsForNode:(id:string)=>string[]) {
  const ids=new Set<string>();
  function add(record:RecordLike | undefined, topology:boolean) {
    if(!record)return;
    if(record.typeName==="binding" && record.type==="arrow" && record.fromId) ids.add(record.fromId);
    else if(record.typeName==="shape" && record.type==="arrow" && record.id) ids.add(record.id);
    else if(topology && record.typeName==="shape" && record.id) arrowsForNode(record.id).forEach(id=>ids.add(id));
  }
  Object.values(changes.added).forEach(record=>add(record as RecordLike,true));
  Object.values(changes.removed).forEach(record=>add(record as RecordLike,true));
  Object.values(changes.updated).forEach(([from,to])=>{
    const a=from as RecordLike,b=to as RecordLike; const typeChanged=a.type!==b.type;
    add(a,typeChanged);add(b,typeChanged);
  });
  return ids;
}
