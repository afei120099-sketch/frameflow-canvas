import type { Editor, TLShape, TLShapeId } from 'tldraw';
import { listAllAssets, listRuns, listShots, listCleanupMetadata, markAssetRecycled, type AssetRecord } from './production-records.ts';
import { listAllRoles } from './role-records.ts';
import { getLocalImageBlob, getLocalVideoBlob, getLocalAudioBlob, removeRecycledMediaBytes } from './local-video-store.ts';
import { withProjectRestoreLock } from './project-media-lock.ts';
import { mediaTrashBlockers } from './media-trash-policy.ts';
import {isNodeClaimed} from './run-recovery.ts';
import {inspectNodeRemoval} from './node-removal-guard.ts';
import {automaticallyRecycleNodeFiles} from './automatic-node-trash.ts';
export const requestNodeDeletion = (ids: TLShapeId[]) => window.dispatchEvent(new CustomEvent('canvas-delete-request', {detail:ids}));
export type MediaTrashPlan = { ids: TLShapeId[]; assets: {asset:AssetRecord; reasons:string[];promptId?:string}[]; assetIdsByNode?:Record<string,string[]>;parentIdsByNode?:Record<string,string>; fingerprint:string; pageId:string };
type RecycleReceipt = { receiptId: string; mode: string; recycled: boolean; error?: string };

/** Prefer the loopback helper (same pattern as clipboard). Only fall back to the page proxy when the helper is unreachable. */
async function postMediaRecycle(query: URLSearchParams, blob: Blob): Promise<RecycleReceipt> {
  const headers = { 'Content-Type': 'application/octet-stream', 'X-Frameflow-Action': 'recycle' };
  const read = async (response: Response) => {
    const receipt = await response.json() as RecycleReceipt;
    if (!response.ok || !receipt.recycled || !receipt.receiptId) throw Error(receipt.error || '未收到回收站成功凭据，浏览器素材保留');
    return receipt;
  };
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:5189/?${query}`, { method: 'POST', headers, body: blob });
  } catch {
    response = await fetch(`/api/media-trash?${query}`, { method: 'POST', headers, body: blob });
  }
  return read(response);
}

/** Only invoked after the user confirms removal. No cancel, interrupt, resubmit, or output deletion. */
export async function settleNodeTasksForRemoval(ids: TLShapeId[], editor?: Editor) {
  if(!editor)throw Error('缺少画布上下文，不能核实独立任务链；未删除');
  const checked=await inspectNodeRemoval(editor,ids);
  if(!checked.ok)throw Error(checked.message);
}

async function directorMetadata(): Promise<unknown[]> {
  const names = await indexedDB.databases();
  if (!names.some(db => db.name === 'frameflow-director-stage')) return [];
  const db = await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('frameflow-director-stage');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try { return (await Promise.all([...db.objectStoreNames].map(name=>new Promise<unknown[]>((resolve,reject)=>{const r=db.transaction(name,'readonly').objectStore(name).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);})))) .flat(); }
  finally {db.close();}
}
function outputReferences(shape: {props?: unknown}) {
  const p = shape.props as {src?:string; assetId?:string; previewAssetId?:string; candidates?:{assetId?:string;src?:string}[];takes?:{assetId?:string;src?:string}[]} | undefined;
  return new Set([p?.src, p?.assetId, p?.previewAssetId, ...[...(p?.candidates ?? []),...(p?.takes??[])].flatMap(c=>[c.src,c.assetId])].filter((s):s is string=>!!s));
}
export async function buildMediaTrashPlan(editor: Editor, ids: TLShapeId[], options:{allowOtherJobs?:boolean; detachedShapes?: readonly TLShape[]}={}): Promise<MediaTrashPlan> {
  const [assets, roles, runs, shots, meta, director] = await Promise.all([listAllAssets(),listAllRoles(),listRuns(),listShots(),listCleanupMetadata(),directorMetadata()]);
  const response=await fetch('/comfyui/queue',{cache:'no-store',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('无法核实后台队列，文件清理暂受保护');
  const queue=await response.json() as {queue_running?:unknown[];queue_pending?:unknown[]};
  if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending))throw Error('后台队列格式异常，未清理');
  if((!options.allowOtherJobs&&(queue.queue_running.length||queue.queue_pending.length))||ids.some(isNodeClaimed))throw Error('仍有实际渲染或排队任务，请结束后再清理文件');
  const selected = new Set(ids);
  let shapes: TLShape[];
  if (options.detachedShapes) {
    // 延迟回收前再次核实：若用户在撤销窗口内通过撤销按钮或 Ctrl+Z 恢复了任一节点，立即中止回收
    if (ids.some(id => !!editor.getShape(id))) throw Error('节点已恢复，取消延迟回收');
    shapes = [...options.detachedShapes];
    if (shapes.length !== ids.length || shapes.some(s => s.isLocked)) throw Error('已删除节点快照不完整，取消延迟回收');
  } else {
    shapes = ids.flatMap(id=>editor.getShape(id)?[editor.getShape(id)!]:[]);
    if (shapes.length !== ids.length || shapes.some(s=>s.isLocked)) throw Error('节点已变化或被锁定，请重新选择');
  }
  const tokens = new Set(shapes.flatMap(s=>[...outputReferences(s)]));
  const ownedRunIds = new Set(runs.filter(r=>r.ownerNodeId&&selected.has(r.ownerNodeId as TLShapeId)).map(r=>r.runId));
  const targets = assets.filter(a=>!a.recycled&&(tokens.has(a.assetId)||tokens.has(a.storageReference)|| (!!a.sourceRunId&&ownedRunIds.has(a.sourceRunId))));
  const otherShapes = editor.store.allRecords().filter(r=>r.typeName==='shape'&&!selected.has(r.id as TLShapeId));
  const pageId = editor.getCurrentPageId();
  const assetIdsByNode=Object.fromEntries(shapes.map(shape=>[shape.id,targets.filter(asset=>outputReferences(shape).has(asset.assetId)||outputReferences(shape).has(asset.storageReference)||runs.some(run=>run.ownerNodeId===shape.id&&run.runId===asset.sourceRunId)).map(asset=>asset.assetId)]));
  const metadata=[...meta.filter(row=>!row.key.startsWith('media-recycle:')),...director];
  // `freeIds` = targets currently expected to be recycled in this delete. Same-run siblings and derived assets
  // only stop counting as consumers while they are free too; a target kept for its own reason keeps protecting
  // what it shares. Shrink until stable (monotonic, so it always ends).
  const reasonsFor=(asset:AssetRecord,freeIds:ReadonlySet<string>)=>[
    ...(!/^(image|media|audio):/.test(asset.storageReference)?['不支持安全回收此存储来源']:[]),
    ...(runs.some(r=>r.runId===asset.sourceRunId&&['running','queued'].includes(r.status))?['该素材的生成记录尚未结清，请先恢复结果或核实取消']:[]),
    ...(asset.sourceRunId&&assets.some(other=>other.assetId!==asset.assetId&&!other.recycled&&other.sourceRunId===asset.sourceRunId&&other.kind===asset.kind&&!freeIds.has(other.assetId))?['同一生成任务还有其他素材记录，磁盘原文件可能共用，保留']:[]),
    ...mediaTrashBlockers(asset,{pageId,otherShapes,roles,runs,shots,otherAssets:assets.filter(a=>a.assetId!==asset.assetId&&!a.recycled),metadata,deletingAssetIds:freeIds})
  ];
  let freeIds=new Set(targets.map(asset=>asset.assetId));
  let reasonRows=targets.map(asset=>reasonsFor(asset,freeIds));
  for(;;){
    const next=new Set(targets.filter((_asset,index)=>!reasonRows[index].length).map(asset=>asset.assetId));
    if(next.size===freeIds.size)break;
    freeIds=next;reasonRows=targets.map(asset=>reasonsFor(asset,freeIds));
  }
  return {ids, pageId, assetIdsByNode,parentIdsByNode:Object.fromEntries(shapes.map(shape=>[shape.id,shape.parentId])), fingerprint:JSON.stringify(shapes), assets:targets.map((asset,index)=>({asset,promptId:runs.find(run=>run.runId===asset.sourceRunId)?.comfyPromptId??shapes.flatMap(shape=>((shape.props as {takes?:{assetId?:string;promptId?:string}[]}).takes??[])).find(take=>take.assetId===asset.assetId)?.promptId,reasons:reasonRows[index]}))};
}

/** Default delete: protect shared files, recycle unshared media best-effort. Nodes stay removable even if recycle fails. */
export async function recycleUnsharedNodeMedia(editor:Editor,ids:TLShapeId[],detachedShapes?:readonly TLShape[]){
  const empty={removableIds:ids,recycled:[] as string[],browserCopies:[] as string[],kept:[] as {assetId:string;reasons:string[]}[],failures:[] as {assetId:string;error:string}[]};
  const planOptions={allowOtherJobs:true, ...(detachedShapes ? { detachedShapes } : {})};
  let preview;
  try { preview=await buildMediaTrashPlan(editor,ids,planOptions); }
  catch (cause) { return {...empty,failures:[{assetId:'',error:cause instanceof Error?cause.message:String(cause)}]}; }
  // Nothing can be recycled: removing empty/shared nodes requires no native file operation.
  if(preview.assets.every(row=>row.reasons.length))return {...empty,kept:preview.assets.map(row=>({assetId:row.asset.assetId,reasons:row.reasons}))};
  try {
    return await withProjectRestoreLock(async()=>{
      // Settle is best-effort; skip if nodes already left the canvas (delayed recycle after undo window).
      if (!detachedShapes) { try { await settleNodeTasksForRemoval(ids,editor); } catch { /* continue recycle attempt */ } }
      return automaticallyRecycleNodeFiles({
        plan:()=>buildMediaTrashPlan(editor,ids,planOptions),
        read:asset=>asset.kind==='image'?getLocalImageBlob(asset.storageReference):asset.kind==='audio'?getLocalAudioBlob(asset.storageReference):getLocalVideoBlob(asset.storageReference),
        recycle:async(asset,blob,promptId)=>{
          const extension=({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','video/webm':'.webm','audio/wav':'.wav','audio/mpeg':'.mp3'} as Record<string,string>)[blob.type];
          const filename=/\.(png|jpe?g|webp|mp4|webm|wav|mp3|m4a|flac|ogg)$/i.test(asset.filename)?asset.filename:asset.filename+(extension??'');
          return postMediaRecycle(new URLSearchParams({assetId:asset.assetId,filename,...(promptId?{promptId}:{})}),blob);
        },
        mark:markAssetRecycled,removeBytes:removeRecycledMediaBytes,
      });
    });
  } catch (cause) {
    return {...empty,failures:[{assetId:'',error:cause instanceof Error?cause.message:String(cause)}]};
  }
}
export async function recyclePlannedMedia(editor: Editor, plan: MediaTrashPlan, progress:(done:number)=>void) {
  return withProjectRestoreLock(async()=>{
    await settleNodeTasksForRemoval(plan.ids,editor);
    const fresh = await buildMediaTrashPlan(editor,plan.ids);
    if (fresh.pageId!==plan.pageId || fresh.fingerprint!==plan.fingerprint || JSON.stringify(fresh.assets)!==JSON.stringify(plan.assets)) throw Error('素材或引用已变化，请重新检查后确认');
    if (!fresh.assets.length || fresh.assets.some(row=>row.reasons.length)) throw Error('存在受保护素材，未清理');
    const runs = await listRuns(); let done=0;
    const successes = new Set<string>();
    const removeSuccessfulNodes = () => {
      const removable = plan.ids.filter(id=>{
        const shape=editor.getShape(id); if(!shape)return false;
        const refs=outputReferences(shape);
        const owned=fresh.assets.filter(({asset})=>refs.has(asset.assetId)||refs.has(asset.storageReference)||runs.some(r=>r.ownerNodeId===id&&r.runId===asset.sourceRunId));
        return owned.length>0&&owned.every(({asset})=>successes.has(asset.assetId));
      });
      if (removable.length) {editor.markHistoryStoppingPoint('recycled media');editor.deleteShapes(removable);}
    };
    try {
      for (const {asset} of fresh.assets) {
        const blob = await (asset.kind==='image'?getLocalImageBlob(asset.storageReference):asset.kind==='audio'?getLocalAudioBlob(asset.storageReference):getLocalVideoBlob(asset.storageReference));
        const producer = asset.sourceRunId ? runs.find(r=>r.runId===asset.sourceRunId) : undefined;
        const extension = ({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','audio/wav':'.wav','audio/x-wav':'.wav','audio/mpeg':'.mp3'} as Record<string,string>)[blob.type];
        const filename=/\.(png|jpe?g|webp|mp4|webm|wav|mp3|m4a|flac|ogg)$/i.test(asset.filename)?asset.filename:asset.filename+(extension??'');
        await settleNodeTasksForRemoval(plan.ids,editor);
        if(JSON.stringify(plan.ids.flatMap(id=>editor.getShape(id)?[editor.getShape(id)!]:[]))!==plan.fingerprint)throw Error('节点已变化，未继续回收');
        const query = new URLSearchParams({assetId:asset.assetId,filename,...(producer?.comfyPromptId?{promptId:producer.comfyPromptId}:{})});
        const receipt = await postMediaRecycle(query,blob);
        if(!receipt.recycled||!receipt.receiptId)throw Error(receipt.error||'未收到回收站成功凭据，浏览器素材保留');
        // Disk copy is now recoverable in Windows. Only then remove local bytes and hide the Asset.
        await markAssetRecycled(asset,receipt);
        await removeRecycledMediaBytes(asset.storageReference);
        successes.add(asset.assetId); progress(++done);
      }
      removeSuccessfulNodes();
      return done;
    } catch(cause) {removeSuccessfulNodes(); throw Error(`已回收 ${done}/${fresh.assets.length} 份；其余未清理。${cause instanceof Error?cause.message:String(cause)}`);}
  });
}
