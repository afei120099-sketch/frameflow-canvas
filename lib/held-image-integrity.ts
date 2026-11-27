import {fetchBody} from './operation-scope.ts';
import {imageProof} from './image-integrity.ts';
export async function assertHeldGraphImages(graph:Record<string,unknown>,signal?:AbortSignal,inspect?:(path:string)=>Promise<unknown>){
 const files=[...new Set(Object.values(graph).flatMap(value=>{const node=value as {class_type?:string;inputs?:{image?:unknown}};return node?.class_type==='LoadImage'&&typeof node.inputs?.image==='string'?[node.inputs.image]:[];}))];
 for(const path of files){
  signal?.throwIfAborted();
  if(inspect){await inspect(path);continue;}
  const parts=path.split('/'),filename=parts.pop()!;
  const blob=await fetchBody('/comfyui/view?'+new URLSearchParams({filename,subfolder:parts.join('/'),type:'input'}),{cache:'no-store'},r=>r.blob(),12000,fetch,signal);
  await imageProof(blob,signal);
 }
 return files.length;
}
