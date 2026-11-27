# Director Stage（导演台）｜V0.1 基础设施

> 依据：AI视频导演系统 V1 的架构设计、数据结构与白模导演台设计。

## 模块目标

在现有无限画布上增加“导演台”能力，最终打通：Scene → Prop → State → 白模 → Control → H3 → Shot。
导演台是 AI 视频 Previs 系统，负责空间预演、摄影机规划、动作规划和控制素材生成。它不是建模软件，也不是第二套画布。

## 当前阶段（2026-10-02）

只建基础设施：

| 路径 | 内容 |
|---|---|
| `lib/director-stage/index.ts` | 只有模块身份常量（`enabled: false`），没有数据类型，也没有存储 |
| `components/director-stage/director-stage-panel.tsx` | 占位面板，复用现有 `generation-info-*` 样式；**尚未挂载到画布** |
| `docs/director-stage/README.md` | 本文件 |

现有画布、H3、ComfyUI 适配，以及 Asset/Run/Shot/Role 数据库都没有改动。

## 本模块不负责

- 修改 H3 冻结工作流、ComfyUI 适配、Reference Manifest 或 Prompt Compiler
- 修改 Asset / Run / Shot / Role 的库结构或版本
- 另建一套平行的媒体或生成记录系统：媒体仍然走 Asset，生成仍然走 Run/Shot
- 3D 引擎、Blender 和模型的安装

## 等待后续接入（每一项单独立项、单独验收）

1. Scene / Prop / SceneState / Camera / Motion / ControlPackage 的正式数据结构（待架构确认）
2. 存储方案：新建的库只引用 Asset ID，并决定是否纳入 `lib/project-backup.ts`
3. 画布入口（见下一节）
4. 白模预演（3D 预览依赖需要先审批）和 Blender 桥（本机安装状态未知）
5. ControlPackage → H3：本机目前只能映射为首帧、尾帧或参考图；AddGuide 和 Depth/Mask 控制要先单独验证

## Director Mode 入口：最小修改方案（尚未实施）

只改 `app/canvas-workspace.tsx` 的 4 处，每处 1 行，照搬“夜班”面板的现有模式：

1. import：`import { DirectorStagePanel } from "@/components/director-stage/director-stage-panel";`
2. state（约 L1657，紧挨着 `showAutopilot`）：`const [showDirectorStage, setShowDirectorStage] = useState(false);`
3. 顶栏（约 L1868，`.header-actions` 里“夜班”按钮之后）：加一个 `role-entry` 按钮“导演台”，`onClick={() => setShowDirectorStage(true)}`，图标沿用已引入的 lucide 图标
4. 挂载（约 L1879，`{showAutopilot && …}` 之后）：`{showDirectorStage && <DirectorStagePanel onClose={() => setShowDirectorStage(false)} />}`

可选：在命令面板列表（约 L1824）加一条 `open-director-stage`。

不改 shapeUtils、节点、持久化键或任何现有逻辑。实施前需要用户确认，并先做项目快照。

## 数据层 V0.1（2026-10-02）

- `lib/director-stage/schema.ts`：zod strict 结构，包括 Scene、Prop、SceneState（propChanges）、Camera、Motion（targetId + keyframes）、ControlPackage（type + assetIds）。每条记录都带 `schemaVersion=1`、`id`、`createdAt`、`updatedAt`，由 store 自动填写。这一版只是最小结构，不是最终设计。
- `lib/director-stage/store.ts`：独立的 IndexedDB `frameflow-director-stage` v1，共 6 张表，主键都是 `id`。库说明集中写在 `DIRECTOR_STAGE_DATABASE`，备份系统以后从这里读，**本次没有改备份系统**。
- 数据约束（同一个事务内检查）：
  - Prop、State、Camera、Motion、ControlPackage 都必须属于一个已存在的 Scene，`sceneId` 创建后不能改。
  - State 的 propChanges、Motion 的 targetId 只能引用同一个 Scene 里的 Prop 或 Camera。
  - 删除 Scene 会一并删除它下面的子记录，但不删除任何 Asset。
  - Prop 或 Camera 仍被引用时，不允许删除。
- `assetIds` 原样保存，V0.1 不去 production-records 核对这些 Asset 是否存在。
- 测试：`pnpm test:director-stage`（`scripts/test-director-stage.mjs`，使用假的 IndexedDB）。

## 备份接入（2026-10-02）

- 项目备份格式升到 **v2**，`format` 名称不变（`frameflow-project-v1`），新增：
  - `director-stage.json`：导演台 6 张表的全部记录，外加 `databaseVersion`；
  - `manifest.directorCounts`：各表记录数。
- 导入时校验 `director-stage.json`：
  - 每条记录都要符合 V0.1 结构、ID 不重复；
  - 子记录所属的场景必须存在，State 和 Motion 只能引用同一场景里的道具或摄影机；
  - 记录数要与 manifest 中的统计一致。
  - 任何一项不通过，整个备份都不导入。
- 控制素材包引用的 Asset 如果不在备份里，只给警告（`directorMissingAssets`），不拒绝导入。
- 恢复顺序：媒体 → records → 角色 → **导演台**（一个事务，整组替换）→ 画布。后面的步骤失败时，导演台和其他元数据一起退回恢复前的状态。
- **旧的 v1 备份**照常可以导入。v1 不含导演台数据，恢复时当前的导演台数据**保持不变**，并给出提示，不会被清空。
- 新版程序生成的 v2 备份，旧版程序无法导入（会提示“不支持的备份版本 2”）。
- 测试：`pnpm test:project-backup` 第 15 组覆盖导演台导出、删除、导入、v1 兼容和损坏备份拒绝。

## UI 入口（2026-10-02）

- 画布顶栏“夜班”后面新增【导演台】按钮。`app/canvas-workspace.tsx` 只改了 2 行：1 行 import，1 处放置 `<DirectorStageEntry />`。按钮和面板的开关状态都在组件内部管理。
- 面板 `components/director-stage/director-stage-panel.tsx` 只能查看：
  - 先显示场景列表，每张卡片标出道具数和状态数；
  - 点进一个场景，显示它的道具（名称、类型）和状态（名称，以及每项道具变化的描述）。
- 沿用现有的 `generation-info-*` / `role-*` 样式，没有新增 CSS。按 Esc 或点击遮罩可以关闭。
- 这一版还不能在界面里新建或编辑，也没有命令面板入口。

## 编辑功能（2026-10-02）

- **新建**：
  - 场景：只填名称；
  - 道具：名称和类型，归属当前打开的场景；
  - 状态：名称，可选一个道具并写一句变化描述，存成 `propChanges` 的一条。填了描述但没选道具时会提示，不保存。
- **重命名**：场景名称在输入框里改，离开输入框即保存；道具和状态点 ✎ 原地改名，回车或离开保存，Esc 取消。
- **删除**：
  - 场景：确认框先列出将一起删除的道具数和状态数（以及该场景的摄影机、动作、控制素材包记录），并说明素材不会被删除；
  - 道具：如果仍被状态引用，直接提示，不弹确认框。数据层同样会拒绝这种删除，也会拒绝被动作引用的道具；
  - 状态：确认后删除。
- 所有规则仍在 `lib/director-stage/store.ts` 里执行，界面只是先给出提示。数据结构和备份格式都没有改。

## 摄影机与控制素材包（2026-10-02）

- **结构变化**：同一个库，版本不变。
  - Camera 新增可选字段 `note`，旧记录照常有效。
  - ControlPackage 新增必填字段 `name`。
  - `type` 改为只能是 `first_frame` / `last_frame` / `reference` / `guide`，depth / mask / pose 已移除。改动时还没有界面能创建控制素材包，因此不存在需要迁移的旧数据。
- **素材规则**（`CONTROL_PACKAGE_ASSET_RULES` 与 `controlPackageAssetProblem`，在 `schema.ts`，有测试）：
  - 首帧、尾帧：1 张图片；
  - 参考：图片、视频或声音，最多 9 个；
  - 引导锚点：图片或视频，最多 9 个；
  - 同一个素材不能重复加入。
  - 这些规则在界面写入前检查；数据层只保存 Asset ID，不跨库核对素材。
- **界面**（场景详情）：
  - 摄影机：名称、可选备注，可以改名、改备注、删除；
  - 控制素材包：填名称、选类型，可选绑定 1 个已有素材，之后可以继续绑定或解除；删除时素材保留。
  - 素材只读地从 `listAssets()` 获取，不提供上传，也不修改任何 Asset。
- 场景卡片和删除场景的确认框都加上了摄影机和控制素材包的数量。
- 备份：沿用 v2 格式；`director-stage.json` 的校验直接使用新结构，所以会带上新字段。

## 发送到 H3（2026-10-02）

- 场景详情里的【发送到 H3】：选择首帧包、尾帧包、参考包（都可选）和场景状态（可选）→ 在画布上新建一个普通 H3 节点，再把包里的**已有素材**放成普通图片节点（同一个 Asset，不复制），用用户手动连线时完全相同的箭头连成首帧 / 尾帧 / 参考。参考包里的视频和声音放进 H3 节点原有的参考列表。之后照常填写 Prompt，点【生成视频】。
- 映射：first_frame → 首帧（I2VA），加 last_frame → 首尾帧（FL2VA），reference → 多参考（Ref2VA，此时首帧作为一张参考图）。引导锚点（guide）不发送。
- 发送前由 `lib/director-stage/h3-handoff.ts`（纯函数，有测试）检查组合，规则与 H3 节点一致：
  - 尾帧必须配首帧；
  - 尾帧和参考不能同时用（🧪 Hybrid 未启用）；
  - 首帧包和尾帧包都必须恰好是 1 张图片；
  - 参考图（含首帧）最多 9 张，视频最多 3 个，声音最多 3 条；
  - 所有包和状态都必须属于当前场景。
- 面板会实时预览将得到的模式，例如“首帧图生视频（I2VA），连接 1 个素材”。
- **Run 记录**：新增可选字段 `Run.directorContext = { sceneId, sceneStateId, controlPackageIds, handoffAssetIds, inputsMatchHandoff }`。
  - 只记 ID，从 H3 节点的 `directorContext` 属性复制而来；不是从导演台建出的节点不会有这个字段。
  - 如果发送后用户改了节点上的输入，`inputsMatchHandoff` 会是 false。
- **没有改的部分**：H3 workflow 模板（5 个 SHA 不变）、`h3-adapter`、Prompt Compiler、Shot 逻辑、ComfyUI，以及 Asset 结构。
  - 画布只新增了 `sendDirectorPlanToH3` 和 H3 节点的一个可选属性；
  - `createImageNodeForAsset` 的参数类型放宽成它实际用到的 6 个字段，现有调用不受影响。
- 测试：`pnpm test:director-stage-h3`。

### 真实 GPU 验收（2026-10-02，用户授权）

- 环境：现有 ComfyUI 0.34.0，用原有参数启动（8188）；画布用隔离测试地址 127.0.0.1:5180（不碰 5173 的真实数据）。首帧是合成的白模书房图（1088×1920），不是用户素材。
- 流程：导演台 → 选首帧包“椅子首帧（白模）”和状态“椅子立着”→【发送到 H3】→ H3 节点自动成为图生视频（I2VA）→ 填写 Prompt →【生成视频】。工作流和参数都没有改，用的是节点默认值。
- ComfyUI：只收到 1 次 `got prompt`，执行 145.5 秒（含首次加载模型）。
- 出片 `MiniMax_H3_i2v_00079_.mp4`：544×960、24 FPS、141 帧、5.875 秒、AAC 32 kHz 立体声；画面延续白模首帧，镜头按 Prompt 缓慢推进。注意：H3 自己加了一盏吊灯，说明首帧只锁定开头画面，不约束之后出现的内容。
- Run：
  - `completed`，`taskMode=i2va`，`h3-workflow.json`（`templateVersion` 为冻结模板规范化 JSON 的 sha256:215b17f1…，与原有的身份计算方式一致；文件本身的 SHA 53131f30… 没变）；
  - 0.5 MP，Turbo 6 步，`engine` 已记录；
  - `directorContext` 中的场景、状态、控制素材包、素材 ID 与导演台记录逐一对应，`inputsMatchHandoff=true`；
  - 输出 Asset 的 `sourceRunId` 指向这个 Run，画布上的视频节点为“镜头01 · 候选A”。

## 🧪 AddGuide 实验接入 V0.1（2026-10-02）

依据：`experiments/h3-addguide/RESULT.md`。补测结论是 B：只能作为实验能力接入。

- **新能力**：`H3_ADDGUIDE_EXPERIMENTAL`，值为 `"h3_addguide_experimental"`（`lib/comfyui/experimental/h3-addguide.ts`）。新增 `isH3Capability()` 作为统一判断，Shot 候选 / 采用、血缘、素材库、画布等处都认这个能力为 H3 生成；其他 Shot 逻辑没变。
- **冻结的实验模板**：`lib/comfyui/experimental/h3-i2va-addguide-workflow.json`（SHA 0dab2b09…）。
  - 内容 = 生产 I2VA 模板 + 一组 `LoadImage(40) → MiniMaxH3AddGuide(41) → BasicGuider(7)`。模块加载时和测试都会核对这一点，生产模板（53131f30…）不变。
  - 构建器先调用不变的 `buildH3Workflow`，再按锚点帧顺序为每个锚点复制一组冻结的 guide 节点并串联；最多 4 个锚点，锚点帧范围 1…(总帧数−1)，不允许重复。
  - 只支持 I2VA（首帧 + 锚点）：带尾帧、参考素材或文生视频时一律拒绝。
- **数据**：ControlPackage 新增可选字段 `anchorFrame`（1–361），旧记录照常有效。
  - guide 包在 V0.1 必须恰好绑定 1 张图片；
  - 列表里 guide 包按锚点帧排序；
  - 发送到 H3 时可以勾选多个 guide 包，按帧顺序串联。
- **界面**：类型显示为“🧪 引导锚点”，新建时可填锚点帧，也可以修改；面板和 H3 节点上都显示说明“锚点表示最晚在这一帧附近达到目标画面，不保证动作在该帧发生。”
  - H3 节点上有“🧪 引导锚点（实验）”区块，列出每个锚点的帧号、约合秒数和文件名，并可【移除】；移除后恢复普通首帧生成。
  - 不满足 I2VA 条件时，节点会提示“生成时会被拒绝”。
- **Run**：
  - `capabilityId = h3_addguide_experimental`，`workflowIdentity` 指向实验模板；
  - `parameters` 中 `mode = first+guides`、`anchorFrames`、`experimental: true`；
  - `directorContext` 新增 `guidePackageIds` 和 `anchorFrames`（按帧顺序）；
  - `referenceInputs` 中锚点图的角色为 `guide_frame_<N>`；
  - `engine` 中包含 `MiniMaxH3AddGuide`。
- **测试**：`pnpm test:h3-addguide`（新增）、`test:director-stage-h3`、`test:director-stage`（补充用例）。
- **真实 GPU 验收**（隔离测试地址 5180 + 真实 ComfyUI 8188，通过导演台界面操作）：
  - 首帧 + 1 个锚点（f70）：出片 `MiniMax_H3_i2v_00080_`，约 f42–f133 为倒地状态；
  - 首帧 + 2 个锚点（f47 → f117）：出片 `…_00081_`，约 f28–f67 倒地、f74–f140 扶正并右移；
  - 两个 Run 的记录都正确，都成为了 Shot 候选。
  - 已知问题：变化会提前发生；锚点之后会编造内容（显示器）；双锚点过渡段出现了一次残留碎片（椅子重复）。

## Motion V0.1（2026-10-02）

- **定位**：只保存导演的动作规划，不会转成 H3 的精确运动。界面上明确提示：“Motion 当前是导演动作规划，不代表 H3 能精确按帧执行。”
- **结构**（`schema.ts`）：Motion = `name`、`sceneId`、`targetType`（prop / camera）、`targetId`、`keyframes[{ frame, description }]`。
  - `frame` 是 24 FPS 下的整数帧号，范围 0–14400。
  - 存储时关键帧一律按帧号严格递增；同一个 Motion 里出现重复帧号会被拒绝，报“同一动作中出现重复帧 N”。
  - 数据层接受任意顺序的输入，保存前统一排序（`sortKeyframes`）。
  - 目标必须是同一场景里、与 `targetType` 相符的道具或摄影机。
- **兼容性**：旧版 Motion 结构（`time` / `note`、没有 name）已经替换掉。此前没有任何 Motion 界面，只有测试数据用过旧结构，所以不需要迁移。数据库版本和备份格式都不变，备份校验直接使用新结构（包括目标类型一致、帧号不重复）。
- **界面**：场景详情新增“动作 Motion”区域。
  - 新建动作：填名称，从“道具：…”或“摄影机：…”中选目标；
  - 每个动作可以添加多个关键帧（帧号 + 描述），列表自动排序，并显示约合秒数；
  - 关键帧可以原地修改（帧号和描述都能改，回车或离开保存，Esc 取消）、删除；
  - 动作可以重命名、删除（需确认）；
  - 场景卡片和删除场景的确认框会统计动作数量。
- **测试**：`test:director-stage`（排序、重复帧、目标类型、无效帧号、名称必填、更新被拒时数据不变）、`test:project-backup`（关键帧往返、目标类型不符和重复帧会被拒绝）。

## 3D 白模导演台 V0.1-A

- **依赖**：`three` 0.186.1（MIT，无运行时依赖）和 `@types/three` 0.186.0（devDependency），版本精确锁定。three 只在打开白模导演台时用 `import()` 动态加载；平时打开画布不会加载它。
- **入口**：导演台面板 → 选中场景 → 【打开白模导演台（3D）】。按 Esc 只关闭白模层。
- **数据**（全部是可选字段，旧数据照常有效）：
  - `Scene.room` {width, depth, height}，单位米；
  - `Prop.geometry` box | plane，`Prop.transform`；
  - `Camera.transform`、`Camera.focalLength`（8–300 mm，全画幅等效）、`Camera.aspect`（16:9 | 9:16）。
- **约定**：Y 轴朝上，原点在地面中心。旋转用度数（XYZ 欧拉角），机位朝本地 −Z 方向看。方盒原点在底面中心，平面原点在中心。
- **纯函数**：`lib/director-stage/whitebox.ts`（规范化、默认位置、焦距换算 FOV、画幅适配），不依赖 three。
- **界面**：`components/director-stage/whitebox-stage.tsx`。
  - 房间盒子；添加方盒 / 平面；把已有 Prop / Camera 放进白模。
  - 用手柄移动 / 旋转 / 缩放，松开鼠标即保存；也可以在数值框里输入，回车保存。
  - 机位可调焦距和画幅，可以切到这个机位视角（按画幅加黑边）。
  - Motion 只读显示。
- **不包含**：在 3D 里删除（请在导演台面板删除）、Motion 播放、Depth/Mask、材质与灯光、Blender、发送到 H3 的 3D 渲染。
- **测试**：`test:director-stage-whitebox`；`test:project-backup` 第 15 组覆盖 3D 字段的备份往返。

## Blender Bridge V0.1

- 流程：白模导演台 → 导出项目备份（其中的 `director-stage.json`）→ `tools/blender/whitebox_render.py`（官方便携版 Blender，命令行后台运行）→ `rgb.png` + `camera.json` → 用素材库导入图片 → 建首帧控制素材包 → 发送到 H3。
- 只输出 RGB。暂不做 Depth / Mask / Normal / Motion 动画，也不需要 HTTP 桥。浏览器端代码和 H3 都没有改动。
- 构图与 three.js 一致：用同一套坐标和欧拉角约定，传感器按高度适配、高 24 mm；画幅严格是 9:16 或 16:9。
- 用法和约定见 `tools/blender/README.md`；测试：`test:blender-bridge`。

## 一键白模首帧 V0.2

- 入口：导演台 → 场景详情 →「白模首帧（Blender）」→ 选择已放入白模的机位 →【生成白模首帧】。
- 流程：
  1. 读取当前场景和所选机位，组装只含这个场景的 director-stage 数据；
  2. 交给本地开发服务器的 `/__blender_render`，它在后台运行便携版 Blender，执行 `tools/blender/whitebox_render.py`，用完删除临时目录；
  3. 得到 PNG（9:16 时 720×1280，16:9 时 1280×720）；
  4. 走素材库同一条导入路径，登记为图片 Asset；
  5. 创建 first_frame 控制素材包；
  6. 下方【发送到 H3】自动选中这个首帧包，面板里显示缩略图。
- 服务端：
  - `scripts/blender-render-routes.ts`：只接受本机页面发来的 JSON 请求；一次只渲染一张；脚本报出的场景问题返回 422；超时 120 秒；
  - `scripts/blender-render-vite-plugin.ts`、`scripts/blender-runtime.ts`：负责查找 Blender，环境变量 `FRAMEFLOW_BLENDER`（未设置时按 `FRAMEFLOW_BLENDER_SEARCH_DIR` 搜索 `blender-*` 目录）。
- 浏览器端：`lib/director-stage/whitebox-firstframe.ts`。只读取 Scene / Prop / Camera，不修改；新建的控制素材包和手工创建的完全一样，所以 H3 流程不用任何改动。
- 不包含：Depth / Mask、Motion 动画、材质系统。H3 模板和 ComfyUI 没有改动。
- 测试：`test:whitebox-firstframe`（真实 Blender；找不到 Blender 时跳过渲染部分）。

## Motion V0.2 空间动画

- **数据**：关键帧新增可选的 `transform`（位置 / 旋转 / 尺寸），结构和限制都和 Prop / Camera 的 `transform` 相同，使用 three.js 坐标。
  - 有 `transform` 的关键帧是“📍 空间关键帧”；没有的仍是“📝 文字关键帧”。
  - 旧 Motion 一律保持原样，照常显示。
- **插值**（`lib/director-stage/motion-anim.ts`，纯函数）：
  - 只有空间关键帧参与插值；
  - 位置和尺寸线性插值，旋转按 X/Y/Z 各自走较近的方向；
  - 第一个关键帧之前、最后一个之后保持该帧姿态；
  - 不做缓动，不做物理。
  - 同一个目标有多个空间动作时，只播放当前选中的那个（默认是第一个）。
- **白模导演台（three.js）**：
  - 时间线：播放预览 / 暂停 / 拖动帧号 / 回到第 0 帧 / 退出预览。按 24 FPS 实时播放，Prop 和 Camera 都会按关键帧运动；在机位视角下就是镜头运动。
  - 右侧“动作 Motion”：新建动作；每个关键帧可以跳到、编辑位置、编辑旋转、记录当前姿态、清除空间数据；也可以在指定帧号记录当前姿态。
  - 预览中拖动手柄 = 在当前帧记录关键帧（不改布置位置）；布置模式下拖动手柄改的是布置位置。只点手柄、不拖动，不会写入任何数据。
- **导演台面板**：📍 标记带位置的关键帧；修改帧号或描述时会保留位置数据。
- **Blender**：只做导出准备，不渲染动画。
  - `whitebox_render.py` 在场景有空间关键帧时额外写出 `motion.json`，内容是每个关键帧的 three.js 姿态和 Blender 世界矩阵。
  - TS 端的 `buildMotionExport` 输出“展开”后的旋转值，以后在 Blender 里用线性 F-curve 就能走出和预览一样的路径。
- **备份**：Motion 本来就在 `director-stage.json` 里，位置数据随 schema 一起备份和恢复，非法姿态会被拒绝。
- **测试**：`test:director-stage-motion-v2`、`test:project-backup`、`test:blender-bridge`（motion.json 中的矩阵与 three.js 换算结果一致）。

## Shot System V0.1

- **数据**：沿用现有的 `ShotRecord`（`frameflow-production-records` 里的 shots，与画布、镜头板共用同一套编号）。只新增一个可选字段 `director`：
  - `{ sceneId, sceneStateId, cameraId, motionIds, firstFramePackageId, lastFramePackageId, referencePackageId, guidePackageIds }`，只存 ID；
  - 画布上直接创建的镜头没有这个字段。
  - Run 和候选视频照旧记在 `runIds` / `adoptedAssetId` / `Asset.shotId` 上。
- **新增函数**（`lib/production-records.ts`）：
  - `createShot(title, sourceH3NodeId?, director?)`；
  - `updateShotDirector(shotId, binding, title?)`；
  - `linkShotToH3Node(shotId, nodeId)`。
- **导演台 → 场景 →「镜头 Shot」**：
  - 新建镜头时可填标题（留空自动编号），选择机位、状态、首帧 / 尾帧 / 参考包，勾选动作和 🧪 引导锚点；
  - 实时提示发送到 H3 时会走哪种模式；
  - 列表显示状态、生成次数、候选数和绑定摘要，可以编辑绑定。
- **发送到 H3**：
  - 先由 `shotHandoffRequest` 把绑定转成交接请求（绑定的记录已被删除就拒绝发送），再交给 `planH3Handoff`；
  - 画布新建 H3 节点时直接用这个镜头（`createH3Node(..., existingShotId)`），不再另建镜头；
  - 之后生成的 Run 和候选视频经原有 H3 流程挂回这个镜头；
  - 镜头已有 H3 节点时只定位，不重复创建。
  - 机位和动作只记录到节点和 `Run.directorContext`（`cameraId` / `motionIds`）上，H3 只使用控制素材包。
- **不改动**：H3 模板、ComfyUI、现有镜头逻辑（画布镜头、镜头板、候选 / 采用）。
- **测试**：`test:shot-system`；`test:project-backup` 覆盖镜头绑定的备份往返。
- **浏览器验收**：在 5180 上进行，`/comfyui` 代理指向 `scripts/fake-comfyui.mjs`（8199），不使用 GPU。

## 高级控制素材 V0.1

- **入口**：导演台 → 场景 →「白模首帧（Blender）」→【生成控制素材组（RGB + 深度 + 遮罩 + 物体 ID）】。原来的【生成白模首帧】保持不变。
- **一次渲染出四张图**：`whitebox_render.py --controls depth,mask,object-id`，同一机位、同一分辨率，构图完全一致。
  - RGB 仍走原来的 Workbench 渲染。
  - 另做一次 Cycles 数据渲染（每像素只在中心采样 1 次，不做抗锯齿）：每个物体用自发光材质，把颜色当数据通道，R = 相机空间深度，G = 物体编号，B = 是否命中。结果存成浮点 EXR，再用 Blender 自带的 numpy + OpenImageIO 生成三张图。这样做是因为 Blender 5.x 只把 Combined 层写进文件，渲染通道（passes）存不下来。
  - `depth.png`：8 位灰度，按相机深度线性映射，越近越亮（近 = 255，远 = 1），没命中 = 0；近、远两端的米数写在记录里。
  - `mask.png`：所有道具为白，房间和背景为黑。
  - `object-id.png`：每个道具一种纯色，房间和背景为黑；颜色与道具的对应关系、每个道具的可见像素数都写在记录里。
- **登记**：四张图都通过素材库的导入登记为图片 Asset，并各建一个控制素材包：
  - 类型分别是 `first_frame`（RGB）、`depth`、`mask`、`object_id`（新增后三种类型，每个包只放 1 张图）；
  - 每个包的 `render` 字段记录：输出类型、同一批次 ID、sceneId、cameraId、来源物体（名称 / 颜色 / 可见像素）、是否包含房间、渲染时间、尺寸、渲染引擎、深度范围。
- **只做生成、登记和管理**：H3 交接和镜头绑定只认首帧 / 尾帧 / 参考 / 引导锚点这几种包；深度 / 遮罩 / 物体 ID 不会被发送到 H3，也没有接 ControlNet。
- **测试**：`test:blender-controls`：用 three.js 光线投射独立复算每个采样像素，逐一核对物体 ID、遮罩和深度；`test:project-backup` 覆盖 render 字段的备份往返。

## Depth 写实首帧 V0.1

- **入口**：导演台 → 场景 →「写实首帧（Depth → SDXL）」→ 填写描述（可选，英文效果更好）→【生成写实首帧（Depth）】。需要本机 ComfyUI 8188 已启动。
- **流程**：
  1. Blender 用所选机位渲染 RGB + depth（同一次渲染）；
  2. depth.png 登记为图片 Asset，并建一个深度包；
  3. 运行冻结模板 `SDXL_DEPTH_FIRSTFRAME_V0.1`（`lib/comfyui/sdxl-depth-firstframe-workflow.json`，sha256 924a6bbb…）；
  4. 生成的写实图登记为图片 Asset，并建一个普通首帧包；
  5. 首帧包自动选入【发送到 H3】，之后走现有的 H3 I2VA。
- **模板**：只用本机已有的模型——Juggernaut-XL v9 + SDXL ControlNet Union v1（depth 类型）。参数保持保守：控制强度 0.8，前 80% 的步数生效，30 步，CFG 5.5，dpmpp_2m karras。输出尺寸与 Blender 深度图一致（720×1280 / 1280×720）。程序只改深度图文件名、描述、种子和尺寸。
- **记录**：写实首帧包的 `render.pass = "sdxl_first_frame"`，`render.generator` 记录模板及其 SHA、底模、ControlNet、控制强度、步数、CFG、种子、完整提示词、ComfyUI 任务 ID，以及来源深度包和深度 Asset。它和深度包使用同一个 groupId。
- **代码位置**：适配器 `lib/comfyui/sdxl-depth-firstframe.ts`，流程 `lib/director-stage/depth-firstframe.ts`；H3 模板、Shot、AddGuide、Asset 结构都没有改动。
- **测试**：`test:sdxl-depth-firstframe`，用假 ComfyUI，不占 GPU。
- **真实 GPU 验收**：启动配置 `canvas-smoke-isolated-gpu`（`.claude/smoke-gpu.env`），让 5180 的 `/comfyui` 代理指向真实 8188；默认的隔离测试配置仍然指向假服务。

## 变更记录

- 2026-10-02：建立目录和占位文件（V0.1 基础设施）。
- 2026-10-02：数据层 V0.1（schema、store、测试）。
- 2026-10-02：导演台数据接入项目备份（格式 v2，兼容 v1）。
- 2026-10-02：顶栏【导演台】入口和只读面板。
- 2026-10-02：编辑功能（新建、重命名、删除，以及删除保护）。
- 2026-10-02：摄影机与控制素材包的管理（数据和界面），可以引用已有素材。
- 2026-10-02：发送到 H3（首帧 / 尾帧 / 参考），Run 中记录 `directorContext`。
- 2026-10-02：🧪 AddGuide 实验接入（新能力、冻结的实验模板、`anchorFrame`、多锚点串联）。
- 2026-10-02：Motion V0.1（name / targetType / 关键帧按帧号，界面和备份）。
- 2026-10-02：3D 白模导演台 V0.1-A（three.js 按需加载；房间、方盒 / 平面、变换、机位视角、持久化、备份）。
- 2026-10-02：Blender Bridge V0.1（便携版 Blender 5.2.2 LTS；白模 → RGB 白模图 + camera.json；可导入为 Asset，作为首帧发送到 H3）。
- 2026-10-02：一键白模首帧 V0.2（导演台按钮 → 本地 Blender → 图片 Asset → 首帧包 → 可直接发送到 H3）。
- 2026-10-02：Motion V0.2 空间动画（空间关键帧、three.js 播放 / 拖动帧号、关键帧位置 / 旋转编辑、Blender motion.json 导出准备）。
- 2026-10-02：Shot System V0.1（现有镜头记录新增可选的导演绑定，可一键发送到 H3，Run 和候选视频挂回镜头）。
- 2026-10-03：高级控制素材 V0.1（一次 Blender 渲染输出 RGB / 深度 / 遮罩 / 物体 ID，登记为 Asset，并按控制素材包管理和记录渲染信息）。
- 2026-10-03：Depth 写实首帧 V0.1（冻结 SDXL 模板：Blender 深度图 → Juggernaut XL + Union depth → 写实首帧 Asset 与首帧包 → 现有 H3 I2VA；已通过真实 GPU 验收）。
