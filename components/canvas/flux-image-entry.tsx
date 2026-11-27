"use client";
import { openCanvasTools } from "./canvas-tools";
import { Fragment, useRef, type ReactNode } from "react";
import {
  ArrangeMenuSubmenu, ConvertToBookmarkMenuItem, ConvertToEmbedMenuItem, CopyAsMenuGroup, CopyMenuItem, CursorChatItem, CutMenuItem, DefaultContextMenu,
  DeleteMenuItem, DuplicateMenuItem, EditLinkMenuItem, ExportAsMenuGroup, FitFrameToContentMenuItem, GroupMenuItem, MoveToPageMenu, PasteMenuItem,
  RemoveFrameMenuItem, ReorderMenuSubmenu, SelectAllMenuItem, TldrawUiMenuActionItem, TldrawUiMenuGroup, TldrawUiMenuItem, TldrawUiMenuSubmenu,
  ToggleAutoSizeMenuItem, ToggleLockMenuItem, UngroupMenuItem, useEditor, useReadonly, useShowCollaborationUi, useValue, type TLUiContextMenuProps,
} from "tldraw";
import { FRAMEFLOW_ITEMS, contextMenuPlan, type MenuEntry, type MenuItemId } from "@/lib/canvas-context-menu-plan";

import { selectedImageCatalog, formatImageCatalog } from "@/lib/selected-image-catalog";
import { OPEN_CANVAS_ROUGH_CUT, isCuttableVideo } from "@/lib/canvas-rough-cut";
import { COPY_VIDEO_LIST_EVENT } from "@/lib/canvas-video-list";
import { OPEN_CANVAS_DEMIX, isDemixableVideo } from "./canvas-demix";
import { copyPlainText } from "@/lib/copy-plain-text";
import { showCanvasToast } from "./canvas-events";
import {OPEN_VIDEO_FRAME_CAPTURE} from './video-frame-capture';
import {deleteCanvasNodes} from './safe-delete-action';
import { OPEN_REVEAL_FILE_EVENT, isRevealableNode } from "@/lib/reveal-node-file";

export const OPEN_AUDIO_VIDEO_EVENT = "frameflow-open-audio-video";
export const OPEN_MUSIC_EVENT = "frameflow-open-music";
export const OPEN_TTS_EVENT = "frameflow-open-tts";
export const OPEN_FLUX_IMAGE_EVENT = "frameflow-open-flux-image";
export const OPEN_TAIL_VIDEO_EVENT = "frameflow-open-tail-video";
const emit=(name:string,detail?:unknown)=>window.dispatchEvent(new CustomEvent(name,detail===undefined?undefined:{detail}));

/**
 * 右键菜单：顶层只放常用项 + 几个子菜单，按选中的节点类型显示（排法见 lib/canvas-context-menu-plan.ts）。
 * tldraw 自带的剪切 / 复制 / 粘贴 / 创建副本 / 排列 / 重新排序 / 移动到页面 / 复制为 / 导出为 / 选中全部都在「编辑 ▸」里，删除在最下面。
 * 快捷键挂在 tldraw 动作上，和菜单放哪无关，照旧能用。
 */
function PlannedContextMenu(){
  const editor=useEditor();
  const point=useRef({...editor.inputs.getCurrentPagePoint()});
  const readonly=useReadonly();
  const showCollaborationUi=useShowCollaborationUi();
  const state=useValue("planned context menu",()=>{
    const shapes=editor.getSelectedShapes();
    const videos=shapes.filter(isCuttableVideo);
    const revealable=shapes.filter(isRevealableNode);
    const hit=revealable.find(s=>editor.getShapePageBounds(s)?.containsPoint(point.current))??(revealable.length===1?revealable[0]:null);
    return {
      selectedIds:editor.getSelectedShapeIds(),
      videoIds:videos.map(s=>s.id),
      singleVideoId:shapes.length===1&&videos.length===1?videos[0].id:null,
      demixIds:shapes.filter(isDemixableVideo).map(s=>s.id),
      images:selectedImageCatalog(shapes),
      revealId:hit?.id??null,
      hasShapes:editor.getCurrentPageShapeIds().size>0,
      multiPage:editor.options.maxPages>1,
      onlyTlImage:shapes.length===1&&shapes[0].type==="image",
      originalDownload:shapes.some(s=>s.type==="image"||s.type==="video"),
    };
  },[editor]);
  const plan=contextMenuPlan({selected:state.selectedIds.length,videos:state.videoIds.length,singleVideo:!!state.singleVideoId,demixable:state.demixIds.length,images:state.images.length,reveal:state.revealId?{many:state.selectedIds.length>1}:null});
  const item=(id:MenuItemId,label:string,onSelect:()=>void)=><TldrawUiMenuItem key={id} id={id} label={label} onSelect={onSelect}/>;
  const label=(id:keyof typeof FRAMEFLOW_ITEMS)=>FRAMEFLOW_ITEMS[id];
  const render=(id:MenuItemId):ReactNode=>{
    switch(id){
      case "reveal-in-folder":return item(id,state.selectedIds.length>1?`${label(id)}（1 个，右键的这个）`:label(id),()=>emit(OPEN_REVEAL_FILE_EVENT,{sourceId:state.revealId}));
      case "compare-candidates":return item(id,label(id),()=>openCanvasTools("compare"));
      case "promote-drafts":return item(id,label(id),()=>openCanvasTools("promote"));
      case "audit-videos":return item(id,label(id),()=>openCanvasTools("audit"));
      case "one-click-demix":return item(id,`${label(id)}（${state.demixIds.length}个视频）`,()=>emit(OPEN_CANVAS_DEMIX,{ids:state.demixIds}));
      case "one-click-rough-cut":return item(id,`${label(id)}（${state.videoIds.length}个视频）`,()=>emit(OPEN_CANVAS_ROUGH_CUT,{ids:state.videoIds}));
      case "copy-video-list":return item(id,`${label(id)}（${state.videoIds.length}个视频）`,()=>emit(COPY_VIDEO_LIST_EVENT,{ids:state.videoIds}));
      case "tail-frame-video":return item(id,label(id),()=>emit(OPEN_TAIL_VIDEO_EVENT,{sourceId:state.singleVideoId}));
      case "tail-frame-hd-video":return item(id,label(id),()=>emit(OPEN_TAIL_VIDEO_EVENT,{sourceId:state.singleVideoId,ai:true}));
      case "capture-original-frame":return item(id,label(id),()=>emit(OPEN_VIDEO_FRAME_CAPTURE,{sourceId:state.singleVideoId}));
      case "capture-ai-frame":return item(id,label(id),()=>emit(OPEN_VIDEO_FRAME_CAPTURE,{sourceId:state.singleVideoId,ai:true}));
      case "ai-drama-cover":return item(id,label(id),()=>emit("frameflow-open-cover"));
      case "flux-text-to-image":return item(id,label(id),()=>emit(OPEN_FLUX_IMAGE_EVENT,{point:point.current}));
      case "text-to-voice":return item(id,label(id),()=>emit(OPEN_TTS_EVENT,{point:point.current}));
      case "music-generation":return item(id,label(id),()=>emit(OPEN_MUSIC_EVENT,{point:point.current}));
      case "save-node-template":return item(id,label(id),()=>openCanvasTools("save-template"));
      case "node-templates":return item(id,label(id),()=>openCanvasTools("templates"));
      case "prompt-library":return item(id,label(id),()=>openCanvasTools("prompts"));
      case "copy-selected-image-catalog":return item(id,`${label(id)}（${state.images.length}张）`,()=>{
        if(state.images.some(i=>!i.assetId)){showCanvasToast("有图片尚未登记 Asset ID，请稍后再复制");return;}
        void copyPlainText(formatImageCatalog(state.images)).then(ok=>showCanvasToast(ok?`已复制${state.images.length}张图片的名称和 Asset ID`:"复制失败，请重试"));
      });
      case "delete-with-media":return item(id,label(id),()=>deleteCanvasNodes(editor,state.selectedIds,"canvas-and-media"));
      case "tl-cut":return <CutMenuItem key={id}/>;
      case "tl-copy":return <CopyMenuItem key={id}/>;
      case "tl-paste":return <PasteMenuItem key={id}/>;
      case "tl-duplicate":return <DuplicateMenuItem key={id}/>;
      // 原 tldraw「编辑 ▸」里的项：只在选中了东西、不是只读时有（和 tldraw 自己的条件一样）
      case "tl-edit-items":return readonly||!state.selectedIds.length?null:<Fragment key={id}><GroupMenuItem/><UngroupMenuItem/>{state.selectedIds.length>1&&<TldrawUiMenuActionItem actionId="frame-selection"/>}{!state.onlyTlImage&&<TldrawUiMenuActionItem actionId="flatten-to-image"/>}<EditLinkMenuItem/><FitFrameToContentMenuItem/><RemoveFrameMenuItem/><ConvertToEmbedMenuItem/><ConvertToBookmarkMenuItem/><ToggleAutoSizeMenuItem/><ToggleLockMenuItem/></Fragment>;
      case "tl-arrange":return <ArrangeMenuSubmenu key={id}/>;
      case "tl-reorder":return <ReorderMenuSubmenu key={id}/>;
      case "tl-move-to-page":return state.multiPage?<MoveToPageMenu key={id}/>:null;
      case "tl-copy-as":return state.hasShapes?<CopyAsMenuGroup key={id}/>:null;
      case "tl-export-as":return state.hasShapes?<ExportAsMenuGroup key={id}/>:null;
      case "tl-download-original":return state.originalDownload?<TldrawUiMenuActionItem key={id} actionId="download-original"/>:null;
      case "tl-select-all":return <SelectAllMenuItem key={id}/>;
      case "tl-cursor-chat":return showCollaborationUi?<CursorChatItem key={id}/>:null;
      case "tl-delete":return <DeleteMenuItem key={id}/>;
    }
  };
  const entry=(value:MenuEntry)=>typeof value==="string"?render(value):<TldrawUiMenuSubmenu key={value.submenu} id={`ff-${value.submenu}`} label={value.label} size="small">{value.groups.map((group,index)=><TldrawUiMenuGroup key={index} id={`ff-${value.submenu}-${index}`}>{group.map(render)}</TldrawUiMenuGroup>)}</TldrawUiMenuSubmenu>;
  return <>{plan.map((group,index)=><TldrawUiMenuGroup key={index} id={`ff-top-${index}`}>{group.map(entry)}</TldrawUiMenuGroup>)}</>;
}
export function FluxCanvasContextMenu(props: TLUiContextMenuProps) {
  return <DefaultContextMenu {...props}><PlannedContextMenu /></DefaultContextMenu>;
}
export function FluxImageEntry() {
  return <button type="button" title="新建 Flux Dev 文生图节点" style={{ padding: "8px 12px", color: "var(--ff-text)", background: "var(--ff-hover)", border: "1px solid var(--ff-text-3)", borderRadius: 8, cursor: "pointer" }} onPointerDown={e => e.stopPropagation()} onClick={() => window.dispatchEvent(new CustomEvent(OPEN_FLUX_IMAGE_EVENT))}>Flux 生图</button>;
}
