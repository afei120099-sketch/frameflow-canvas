# AI 视频创作无限画布 V0.2：当前能力清单

## 技术基线

- tldraw SDK：5.4.2
- 画布文档：tldraw IndexedDB persistence，键名继续使用 `frameflow-v0.1-canvas`
- 本地媒体：项目自有 IndexedDB Blob 存储
- AI 后端：本机 ComfyUI HTTP API / WebSocket，默认地址 `127.0.0.1:8188`

## 直接来自 tldraw 的能力

- 无限平移、滚轮缩放、选择、框选、多选、移动、旋转和 Resize
- 删除、Undo / Redo
- Ctrl+C、Ctrl+V、Ctrl+X、Ctrl+D、Ctrl+A 与 tldraw 原生快捷键体系
- 原生右键菜单
- Bring forward、Send backward、Bring to front、Send to back
- Align、Distribute、横排、竖排
- Group / Ungroup
- Lock / Unlock all
- Zoom in、Zoom out、100%、Zoom to fit、Zoom to selection、小地图
- 原生选择、手形、箭头、文本、便签、矩形和媒体工具
- 原生主菜单、操作菜单、样式面板、富文本工具栏和快捷键说明
- 原生文件/剪贴板事件基础设施

## 项目自定义能力

- 专业深色 Frameflow 外壳与创作工作台布局
- 图片节点：JPG / PNG / WEBP 拖入、预览、尺寸调整、原始文件名信息
- H3 视频节点：Prompt、模式、时长、Seed、生成状态与生成按钮
- 视频节点：MP4 Blob 持久化、原生播放器、刷新恢复
- 图片 → H3 → 视频的连线和自动输出布局
- ComfyUI H3 工作流适配、图片上传、任务监听、SaveVideo 输出获取
- 生成 MP4 自动写入媒体 IndexedDB，并创建视频节点及连线


- 取消 `hideUi`，恢复 tldraw 官方 UI 上下文
- 恢复官方右键菜单、主菜单、快捷操作、排列操作、样式面板和缩放导航
- 使用 tldraw 官方 Toolbar 组件组合视频创作所需工具：选择、手形、箭头、文本、便签、矩形、媒体
- 画布限制为单页，避免引入当前阶段不需要的多页白板结构
- tldraw UI 设为简体中文和深色模式
- 保留 H3 表单与视频播放器的事件隔离：交互控件可命中，只阻止事件冒泡，不阻止浏览器默认行为
- 保留图片和 MP4 的自定义拖放及媒体持久化流程

## 刻意没有启用

- 激光笔、高亮笔、自由绘画、橡皮擦和大量几何图形：偏教学白板/复杂绘图，不是当前视频创作主流程
- 评论、多人光标、协作与分享：当前是纯本地单人应用
- 多页面：会增加工作区和持久化复杂度，当前没有产品需求

## 交互边界

- H3 textarea、input、button 显式使用浏览器交互事件；tldraw 不接管其默认行为。
- 视频节点继续使用浏览器原生 controls；画布选择层不覆盖播放器控件。
- H3 和视频控件区域保留原生右键行为，节点非控件区域使用 tldraw 右键菜单。
