import type {TLShapeId} from 'tldraw';
import type {AssetRecord} from './production-records.ts';
import type {MediaTrashPlan} from './media-trash-client.ts';

export type RecycleReceipt={receiptId:string;mode:string;recycled:boolean};
export type AutomaticTrashResult={removableIds:TLShapeId[];recycled:string[];browserCopies:string[];kept:{assetId:string;reasons:string[]}[];failures:{assetId:string;error:string}[]};
export type AutomaticTrashIO={
  plan:()=>Promise<MediaTrashPlan>; read:(asset:AssetRecord)=>Promise<Blob>;
  recycle:(asset:AssetRecord,blob:Blob,promptId?:string)=>Promise<RecycleReceipt>;
  mark:(asset:AssetRecord,receipt:RecycleReceipt)=>Promise<void>; removeBytes:(source:string)=>Promise<void>;
};
/** Shared files stay on disk. Recycle is best-effort; user delete always keeps nodes removable. */
export async function automaticallyRecycleNodeFiles(io:AutomaticTrashIO):Promise<AutomaticTrashResult>{
  const initial=await io.plan();
  const result:AutomaticTrashResult={removableIds:[...initial.ids],recycled:[],browserCopies:[],kept:[],failures:[]};
  for(const row of initial.assets){
    if(row.reasons.length){result.kept.push({assetId:row.asset.assetId,reasons:row.reasons});continue;}
    try{
      const blob=await io.read(row.asset);
      if(!blob.size)throw Error('素材文件为空，未回收');
      // Reading large media is asynchronous. Re-check ALL current consumers
      // after reading and immediately before the native recycle request.
      const fresh=await io.plan();
      if(fresh.pageId!==initial.pageId||fresh.fingerprint!==initial.fingerprint)throw Error('节点已变化，未继续回收');
      const current=fresh.assets.find(item=>item.asset.assetId===row.asset.assetId);
      if(!current)throw Error('素材记录已变化，未回收');
      if(current.reasons.length){result.kept.push({assetId:row.asset.assetId,reasons:current.reasons});continue;}
      if(JSON.stringify(current.asset)!==JSON.stringify(row.asset)||current.promptId!==row.promptId)throw Error('原文件定位凭证已变化，未回收');
      const receipt=await io.recycle(row.asset,blob,row.promptId);
      if(!receipt.recycled||!receipt.receiptId)throw Error('未收到回收站成功凭据，素材保留');
      await io.mark(row.asset,receipt);
      await io.removeBytes(row.asset.storageReference);
      result.recycled.push(row.asset.assetId);
      if(receipt.mode==='browser-copy')result.browserCopies.push(row.asset.assetId);
    }catch(cause){result.failures.push({assetId:row.asset.assetId,error:cause instanceof Error?cause.message:String(cause)});}
  }
  try{
    const final=await io.plan();
    if(final.pageId!==initial.pageId||final.fingerprint!==initial.fingerprint){
      result.failures.push({assetId:'',error:'删除前节点发生变化；已尽量回收，节点仍按用户删除移除'});
    }
  }catch(cause){
    result.failures.push({assetId:'',error:`最终核实失败，已回收 ${result.recycled.length} 份；节点仍删除：${cause instanceof Error?cause.message:String(cause)}`});
  }
  result.removableIds=[...initial.ids];
  return result;
}
