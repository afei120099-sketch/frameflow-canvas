/** One metadata index per page, one read per changed Run, notifications scoped to its owner. */
export function createRunObserver<T extends {runId:string;ownerNodeId?:string|null;createdAt:number}>(io:{list:()=>Promise<T[]>;get:(id:string)=>Promise<T|null>;listen:(changed:(id?:string)=>void)=>()=>void}){
  const records=new Map<string,T>();
  const byNode=new Map<string,Map<string,T>>();
  const subscribers=new Map<string,Set<()=>void>>();
  let initial:Promise<void>|null=null,close:(()=>void)|null=null,generation=0;
  const pending=new Set<string>();
  const versions=new Map<string,number>();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const insert=(run:T)=>{const old=records.get(run.runId);if(old?.ownerNodeId&&old.ownerNodeId!==run.ownerNodeId)byNode.get(old.ownerNodeId)?.delete(run.runId);records.set(run.runId,run);if(run.ownerNodeId){let runs=byNode.get(run.ownerNodeId);if(!runs){runs=new Map();byNode.set(run.ownerNodeId,runs);}runs.set(run.runId,run);}};
  const notify=(node:string)=>{for(const listener of subscribers.get(node)??[])listener();};
  const load=()=>{
    if(!initial){const ticket=generation;initial=io.list().then(runs=>{if(ticket!==generation)return;records.clear();byNode.clear();runs.forEach(insert);}).catch(cause=>{if(ticket===generation)initial=null;throw cause;});}
    return initial;
  };
  const changed=(id?:string)=>{
    if(!id){initial=null;void load().then(()=>{for(const node of subscribers.keys())notify(node);}).catch(()=>{});return;}
    pending.add(id);versions.set(id,(versions.get(id)??0)+1);if(timer)return;
    timer=setTimeout(()=>{timer=undefined;const ids=[...pending],revisions=ids.map(id=>versions.get(id));pending.clear();const ticket=generation;
      void load().then(async()=>{const updates=await Promise.all(ids.map(id=>io.get(id)));if(ticket!==generation)return;const affected=new Set<string>();
        updates.forEach((run,index)=>{if(versions.get(ids[index])!==revisions[index])return;const old=records.get(ids[index]);if(old?.ownerNodeId)affected.add(old.ownerNodeId);if(run){insert(run);if(run.ownerNodeId)affected.add(run.ownerNodeId);}else{records.delete(ids[index]);if(old?.ownerNodeId)byNode.get(old.ownerNodeId)?.delete(ids[index]);}});
        affected.forEach(notify);
      }).catch(()=>{if(ticket===generation){initial=null;for(const node of subscribers.keys())notify(node);}});
    },100);
  };
  const ensure=()=>{if(!close)close=io.listen(changed);};
  return {
    async read(node:string){ensure();await load();return [...(byNode.get(node)?.values()??[])].sort((a,b)=>b.createdAt-a.createdAt).map(run=>structuredClone(run));},
    subscribe(node:string,listener:()=>void){ensure();let set=subscribers.get(node);if(!set){set=new Set();subscribers.set(node,set);}set.add(listener);
      return()=>{set!.delete(listener);if(!set!.size)subscribers.delete(node);if(!subscribers.size){close?.();close=null;clearTimeout(timer);timer=undefined;pending.clear();versions.clear();generation++;initial=null;records.clear();byNode.clear();}};
    },
  };
}
