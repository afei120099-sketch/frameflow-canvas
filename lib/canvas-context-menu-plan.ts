/**
 * 画布右键菜单的排法（2026-11-12 用户：「右击显示的东西太多了」）。
 * 顶层只放常用的几项和几个子菜单（▸），和当前节点无关的项不显示；功能一个不删，只挪位置，快捷键不受影响（快捷键挂在 tldraw 动作上，不挂在菜单上）。
 * 这里只算「放哪」，渲染在 components/canvas/flux-image-entry.tsx；测试 scripts/test-context-menu-plan.mjs。
 */

/** Frameflow 自己的菜单项（id 和改前一样）。 */
export const FRAMEFLOW_ITEMS = {
  "reveal-in-folder": "打开所在文件夹",
  "compare-candidates": "候选并排对比",
  "promote-drafts": "试片转正 · 终极版",
  "audit-videos": "成片质检",
  "one-click-demix": "一键去背景音",
  "one-click-rough-cut": "一键粗剪",
  "copy-video-list": "复制视频清单",
  "tail-frame-video": "尾帧做视频",
  "tail-frame-hd-video": "尾帧＋AI 高清做视频",
  "capture-original-frame": "截取原画质图片",
  "capture-ai-frame": "截帧＋AI 高清",
  "ai-drama-cover": "AI短剧封面",
  "flux-text-to-image": "文生图 · Flux Dev",
  "text-to-voice": "AI音色设计 · 试听选角",
  "music-generation": "AI 作歌 · MiniMax Music 3",
  "save-node-template": "保存选中节点为模板",
  "node-templates": "节点模板库",
  "prompt-library": "提示词模板库",
  "copy-selected-image-catalog": "复制图片名称＋ID",
  "delete-with-media": "删除并清理素材文件",
} as const;

/** tldraw 自带的菜单项（DefaultContextMenuContent 里的全部），挪进「编辑 ▸」，删除放最下面。 */
export const TLDRAW_ITEMS = {
  "tl-cut": "剪切",
  "tl-copy": "复制",
  "tl-paste": "粘贴",
  "tl-duplicate": "创建副本",
  "tl-edit-items": "组合 / 取消组合 / 锁定等（原「编辑 ▸」里的）",
  "tl-arrange": "排列 ▸",
  "tl-reorder": "重新排序 ▸",
  "tl-move-to-page": "移动到页面 ▸",
  "tl-copy-as": "复制为 ▸",
  "tl-export-as": "导出为 ▸",
  "tl-download-original": "下载原文件",
  "tl-select-all": "选中全部",
  "tl-cursor-chat": "光标聊天（多人协作时）",
  "tl-delete": "删除",
} as const;

export type MenuItemId = keyof typeof FRAMEFLOW_ITEMS | keyof typeof TLDRAW_ITEMS;
export type MenuSubmenu = { submenu: "next" | "video-tools" | "ai-templates" | "edit"; label: string; groups: MenuItemId[][] };
export type MenuEntry = MenuItemId | MenuSubmenu;
/** 顶层分组（组之间是分隔线）。 */
export type MenuPlan = MenuEntry[][];

export const SUBMENU_LABELS = { next: "接着做", "video-tools": "视频工具", "ai-templates": "AI 工具 · 模板", edit: "编辑" } as const;

/**
 * 右键时选中了什么。videos = 能粗剪的视频（视频节点 / 出过片的 H3 节点）；singleVideo = 只选中一个且它是视频；
 * images = 选中的图片节点数；reveal = 右键点中的那个节点有本机文件（many：选中了不止一个）。
 */
export type MenuContext = { selected: number; videos: number; singleVideo: boolean; demixable: number; images: number; reveal: null | { many: boolean } };

export function contextMenuPlan(ctx: MenuContext): MenuPlan {
  const main: MenuEntry[] = [];
  const subs: MenuEntry[] = [];
  if (ctx.reveal) main.push("reveal-in-folder");
  if (ctx.videos > 0) main.push("compare-candidates", "promote-drafts", "audit-videos");
  if (ctx.demixable > 0) main.push("one-click-demix");
  // 只选中一个视频：尾帧 / 截图 / 粗剪 / 复制视频清单 收进「接着做 ▸」；选了好几个视频时粗剪和复制视频清单放顶层（尾帧和截图只对单个视频）。
  // 复制视频清单（2026-11-18）：框选几十个视频按画布顺序把标题＋本机路径复制给剪辑助手，跟在粗剪后面。
  if (ctx.singleVideo) subs.push({ submenu: "next", label: SUBMENU_LABELS.next, groups: [["tail-frame-video", "tail-frame-hd-video", "one-click-rough-cut", "copy-video-list"], ["capture-original-frame", "capture-ai-frame"]] });
  else if (ctx.videos > 0) main.push("one-click-rough-cut", "copy-video-list");
  // 只选图片：复制名称＋ID 放顶层；和视频混选时放进「编辑 ▸」的复制组。
  const imageCatalogTop = ctx.images > 0 && ctx.videos === 0;
  if (imageCatalogTop) main.push("copy-selected-image-catalog");
  // 空白处右键：视频工具收进子菜单（它们针对选中的视频，空白处打开是空列表）。
  if (ctx.selected === 0) subs.push({ submenu: "video-tools", label: SUBMENU_LABELS["video-tools"], groups: [["compare-candidates", "promote-drafts", "audit-videos"]] });
  subs.push({ submenu: "ai-templates", label: SUBMENU_LABELS["ai-templates"], groups: [["ai-drama-cover", "flux-text-to-image", "text-to-voice", "music-generation"], [...(ctx.selected > 0 ? ["save-node-template" as const] : []), "node-templates", "prompt-library"]] });
  const copyGroup: MenuItemId[] = ["tl-cut", "tl-copy", "tl-paste", "tl-duplicate", ...(ctx.images > 0 && !imageCatalogTop ? ["copy-selected-image-catalog" as const] : [])];
  subs.push({ submenu: "edit", label: SUBMENU_LABELS.edit, groups: [copyGroup, ["tl-edit-items"], ["tl-arrange", "tl-reorder", "tl-move-to-page"], ["tl-copy-as", "tl-export-as", "tl-download-original"], ["tl-select-all", "tl-cursor-chat"]] });
  const plan: MenuPlan = [];
  if (main.length) plan.push(main);
  plan.push(subs);
  if (ctx.selected > 0) plan.push(["delete-with-media", "tl-delete"]);
  return plan;
}

/** 顶层一共几项（子菜单算一项）。 */
export const topLevelCount = (plan: MenuPlan) => plan.reduce((sum, group) => sum + group.length, 0);

/** 菜单里能找到的全部项（展开子菜单）。 */
export function allMenuItems(plan: MenuPlan): MenuItemId[] {
  return plan.flat().flatMap((entry) => (typeof entry === "string" ? [entry] : entry.groups.flat()));
}
