import type { Editor, TLShape } from "tldraw";
import { affectsLinkedContent } from "../../lib/media-activation.ts";

type Subscription = { id: TLShape["id"]; dependencies: Set<string>; notify: () => void };
const hubs = new WeakMap<Editor, { subscriptions:Set<Subscription>; close:()=>void }>();
/** Binding indexes avoid scanning all canvas shapes. Include upstream ancestry for scene numbering. */
function dependencies(editor:Editor,id:TLShape["id"]) {
  const result=new Set<string>([id]); const upstream:TLShape["id"][]=[id]; const visited=new Set<string>();
  while(upstream.length) {
    const current=upstream.pop()!; if(visited.has(current))continue; visited.add(current);
    for(const binding of editor.getBindingsToShape(current,"arrow")) {
      result.add(binding.id); result.add(binding.fromId);
      const arrow=editor.getShape(binding.fromId); if(arrow?.type!=="arrow")continue;
      const bindings=editor.getBindingsFromShape(arrow.id,"arrow");
      const ends={start:bindings.find(binding=>binding.props.terminal==="start"),end:bindings.find(binding=>binding.props.terminal==="end")};
      if(ends.start) {result.add(ends.start.id); result.add(ends.start.toId);}
      if(ends.end) {result.add(ends.end.id); result.add(ends.end.toId);}
      if(ends.end?.toId===current && ends.start) upstream.push(ends.start.toId);
    }
  }
  return result;
}
export function subscribeLinkedContent(editor:Editor,id:TLShape["id"],notify:()=>void) {
  let hub=hubs.get(editor);
  if(!hub) {
    const subscriptions=new Set<Subscription>();
    const close=editor.store.listen(({changes})=>{
      if(!affectsLinkedContent(changes))return;
      const records=[...Object.values(changes.added),...Object.values(changes.removed),...Object.values(changes.updated).flat()];
      const changed=new Set(records.map(record=>record.id));
      const topology=records.some(record=>record.typeName==="binding") || [...Object.values(changes.added),...Object.values(changes.removed)].some(record=>record.typeName==="shape");
      for(const subscription of subscriptions) {
        const before=subscription.dependencies;
        if(topology) subscription.dependencies=dependencies(editor,subscription.id);
        if([...changed].some(key=>before.has(key)||subscription.dependencies.has(key))) subscription.notify();
      }
    },{scope:"document"});
    hub={subscriptions,close};hubs.set(editor,hub);
  }
  const subscription={id,notify,dependencies:dependencies(editor,id)};hub.subscriptions.add(subscription);
  return ()=>{ hub!.subscriptions.delete(subscription); if(!hub!.subscriptions.size){hub!.close();hubs.delete(editor);} };
}
