import { addItem, createFinalCutList, resolveRows, validateRange } from './final-cut-list.ts';
import type { AssetRecord } from './production-records.ts';

export const OPEN_CANVAS_ROUGH_CUT = 'frameflow-open-canvas-rough-cut';
export type CutTransition = {type:"cut"|"dissolve"|"fade";seconds:number};
export type CanvasCutClip = { transition?:CutTransition; nodeId:string; asset:AssetRecord; inPoint:number; outPoint:number; duration:number };
export function isCuttableVideo(shape:{type:string;props:object}) {
 const p=shape.props as {src?:string;shotId?:string;inheritedVideo?:{src?:string}};
 return (shape.type==='video-node'||shape.type==='audio-video-node')?!!p.src:shape.type==='h3-node'&&!!(p.shotId||p.inheritedVideo?.src);
}
/** Geometry order, never selection-click order; stable for equal coordinates. */
export function leftToRight<T extends {id:string;x:number;y:number}>(shapes:readonly T[]) {
 return shapes.map((shape,i)=>({shape,i})).sort((a,b)=>a.shape.x-b.shape.x||a.shape.y-b.shape.y||a.i-b.i).map(item=>item.shape);
}
export function moveCutClip(clips:readonly CanvasCutClip[],from:number,to:number) {
 if(from<0||to<0||from>=clips.length||to>=clips.length||from===to)return [...clips];
 const next=[...clips], [clip]=next.splice(from,1);next.splice(to,0,clip);return next;
}
/** Transient export list: never changes the older persisted Final Cut List. */
export function canvasCutList(clips:readonly CanvasCutClip[],sequenceId:string) {
 let list=createFinalCutList({sequenceId,title:'画布粗剪'});
 const assets=new Map<string,AssetRecord>();
 for(const [index,clip] of clips.entries()){
  try { validateRange(clip.inPoint,clip.outPoint,clip.duration); }
  catch(cause){throw Error(`第${index+1}段「${clip.asset.filename}」：${cause instanceof Error?cause.message:String(cause)}`);}
  assets.set(clip.asset.assetId,clip.asset);
  list=addItem(list,{asset:clip.asset,duration:clip.duration},{itemId:clip.nodeId}).list;
  list.items[list.items.length-1]={...list.items.at(-1)!,inPoint:clip.inPoint,outPoint:clip.outPoint,transition:clip.transition};
 }
 return {list,rows:resolveRows(list,{assets})};
}
