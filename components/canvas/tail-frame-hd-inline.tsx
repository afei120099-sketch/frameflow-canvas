"use client";
import {useValue,type Editor,type TLShape} from 'tldraw';
import {enhanceTailPNG,readTailHD,type TailHDState} from '@/lib/tail-frame-hd-job';
import {showCanvasToast} from './canvas-events';
import {isNodeBeingRemoved} from '@/lib/node-task-activity';

const active=new Map<string,Promise<void>>();
export function runTailFrameHD(editor:Editor,nodeId:TLShape['id'],allowSubmit=false):Promise<void>{
  const running=active.get(nodeId);if(running)return running;
  const work=(async()=>{
    const state=readTailHD(editor.getShape(nodeId)?.meta);if(!state||state.status==='completed'||state.status==='detached')return;
    const update=(patch:Partial<TailHDState>)=>{const node=editor.getShape(nodeId),current=readTailHD(node?.meta);if(node&&current&&current.originalAssetId===state.originalAssetId)editor.updateShape({id:nodeId,type:node.type,meta:{...node.meta,tailFrameHD:{...current,...patch}}});};
    try{
      update({status:'running',stage:'尾帧 AI 高清排队中…'});
      const run=()=>{if(!editor.getShape(nodeId)||isNodeBeingRemoved(nodeId))throw Error('节点已删除或正在取消，不再提交尾帧高清');return enhanceTailPNG(state.originalAssetId,stage=>update({stage}),async promptId=>update({promptId}),allowSubmit);};
      const asset=typeof navigator!=='undefined'&&navigator.locks?await navigator.locks.request('frameflow-tail-hd-'+state.originalAssetId,run):await run();
      const node=editor.getShape(nodeId),current=readTailHD(node?.meta);
      if(!node||node.type!=='h3-node'||current?.status==='detached')return;
      const frame=(node.props as {videoFirstFrame?:{src:string;name:string;sourceNodeId:string}}).videoFirstFrame;
      if(frame?.src!==state.expectedSrc){update({status:'detached',stage:'首帧已手动更换，高清图保留在素材库',enhancedAssetId:asset.assetId});return;}
      editor.updateShape({id:nodeId,type:'h3-node',props:{videoFirstFrame:{...frame,src:asset.storageReference,name:asset.filename}},meta:{...node.meta,tailFrameHD:{...current,status:'completed',stage:'尾帧已 AI 高清',enhancedAssetId:asset.assetId}}});
      showCanvasToast('尾帧已自动更新为高清图，填写提示词后即可生成视频');
    }catch(cause){update({status:'error',stage:cause instanceof Error?cause.message:String(cause)});showCanvasToast('尾帧高清未完成，原图保留；可在节点上查询原任务');}
  })();
  active.set(nodeId,work);void work.finally(()=>active.delete(nodeId));return work;
}
export function TailFrameHDStatus({editor,nodeId}:{editor:Editor;nodeId:TLShape['id']}){
  const state=useValue('tail frame HD status',()=>readTailHD(editor.getShape(nodeId)?.meta),[editor,nodeId]);
  if(!state||state.status==='detached')return null;
  return <div role="status" style={{position:'absolute',top:38,left:10,right:10,zIndex:5,background:'rgba(27,27,27,0.91)',color:'var(--ff-text)',borderRadius:8,padding:'6px 10px',fontSize:13,pointerEvents:'auto'}} onPointerDown={e=>e.stopPropagation()}>
    {state.stage}{state.status!=='completed'&&<><button type="button" onClick={()=>void runTailFrameHD(editor,nodeId)}>查询高清任务</button><button type="button" onClick={()=>{const node=editor.getShape(nodeId);if(node)editor.updateShape({id:nodeId,type:node.type,meta:{...node.meta,tailFrameHD:{...state,status:'detached',stage:'使用原尾帧'}}});}}>使用原尾帧</button></>}
  </div>;
}
