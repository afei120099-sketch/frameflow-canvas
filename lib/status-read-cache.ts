/** Short-lived coalescing for read-only status requests, never POSTs. */
export function createStatusReadCache(ttlMs=250,now=()=>Date.now()){
  const entries=new Map<string,{expires:number;promise:Promise<unknown>}>();
  return {
    read<T>(key:string,load:()=>Promise<T>):Promise<T>{
      const prior=entries.get(key);if(prior&&prior.expires>now())return prior.promise as Promise<T>;
      const entry={expires:Infinity,promise:Promise.resolve().then(load) as Promise<unknown>};
      entries.set(key,entry);
      entry.promise=entry.promise.then(value=>{entry.expires=now()+ttlMs;return value;},cause=>{if(entries.get(key)===entry)entries.delete(key);throw cause;});
      if(entries.size>256)for(const [id,item]of entries)if(item.expires<=now())entries.delete(id);
      return entry.promise as Promise<T>;
    },
  };
}
