import type {CoverPhoto} from './cover-model.ts';
import {legacyRoleId} from './cover-director.ts';
export type CanvasCoverImage={id:string;src:string;name:string;assetId?:string;width?:number;height?:number};
export function canvasCoverImage(shape:{id:string;type:string;props:unknown}|undefined):CanvasCoverImage|null{
 if(!shape||shape.type!=='image-node')return null;
 const p=shape.props as {src?:string;name?:string;assetId?:string;naturalWidth?:number;naturalHeight?:number};
 if(!p.src)return null;return {id:shape.id,src:p.src,name:p.name||'画布图片.png',assetId:p.assetId,width:p.naturalWidth,height:p.naturalHeight};
}
/** Reuses an existing Asset; same reference cannot accidentally consume another photo slot. */
export function addCanvasCoverPhoto(photos:CoverPhoto[],assetId:string):CoverPhoto[]{
 if(photos.some(p=>p.assetId===assetId))throw Error('这张图片已经添加到封面');
 if(photos.length>=9)throw Error('人物剧照最多9张');
 const role=photos.length?'女主':'男主',existing=photos.find(p=>p.role===role);return [...photos,{assetId,role,roleId:existing?.roleId||legacyRoleId(role),primary:!existing}];
}
