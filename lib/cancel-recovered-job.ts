import type { ComfyJobProbe } from './comfyui/h3-adapter.ts';
/** Explicit user cancellation/deletion only. Never guesses that a missing job succeeded. */
export async function cancelRecoveredJob(client: {probeJob:(id:string,save:string)=>Promise<ComfyJobProbe>;cancel:(id:string)=>Promise<void>}, id:string, save:string) {
  let probe = await client.probeJob(id,save);
  if(probe.state==='not_found') probe=await client.probeJob(id,save);
  if(probe.state==='completed') return 'completed' as const;
  if(probe.state==='not_found'||probe.state==='failed') return 'stopped' as const;
  try {await client.cancel(id);}
  catch(cause) {
    // Finish/clear-between-requests is normal, not a reason to trap the node forever.
    const fresh=await client.probeJob(id,save);
    if(fresh.state==='completed')return 'completed' as const;
    if(fresh.state!=='failed'&&fresh.state!=='not_found')throw cause;
  }
  const after=await client.probeJob(id,save);
  if(after.state==='completed')return 'completed' as const;
  if(after.state==='queued'||after.state==='running')throw Error('取消请求处理中，请稍后再删除节点');
  return 'stopped' as const;
}
