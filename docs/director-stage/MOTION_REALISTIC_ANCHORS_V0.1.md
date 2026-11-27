# Motion 写实锚点 V0.1 施工记录

日期：2026-10-03。工程接入完成；一次真实 GPU 出片成功。效果仍属于 AddGuide 实验，不是逐帧动作控制。

## 实现范围

- Director Stage 新增“Motion 写实锚点”小节：选择机位、Motion、1–4 个空间关键帧、视频时长及统一写实描述。
- 使用 Motion V0.2 原有 drivingMotion / sampleMotion 计算 Prop 与 Camera 的临时姿态快照；所有快照在批次开始前复制，不修改静态布置数据。
- 顺序复用 Blender Depth → SDXL_DEPTH_FIRSTFRAME_V0.1 → 现有媒体 Asset 登记。
- 每帧创建 depth 包和 guide 包；guide.anchorFrame 等于选中帧。f0、文字帧、重复帧、越界帧拒绝。
- guide.render 保留 sceneId、cameraId、motionId、frame、generationLength、batchId、renderedAt，以及原有 SDXL generator 的模板 ID/SHA、完整 prompt、seed、ComfyUI promptId、sourceDepthPackageId/AssetId。
- 当前批次生成成功的 guide 自动选入“发送到 H3”，保留原首帧选择；不删除旧包或旧素材。部分失败保留已完成包及已登记 Depth。
- handoff 按 anchorFrame 排序，记录来源 Motion，并把本批次 length 同步给新 H3 节点；多个不同 length 的 Motion 包拒绝混用。H3 原有提交校验继续检查用户随后缩短的长度。
- 旧包无需迁移，普通 Depth 写实首帧仍创建 first_frame，普通 H3 / Shot 不变。

业务修改：

- lib/director-stage/motion-realistic-anchors.ts（新增）
- lib/director-stage/depth-firstframe.ts（可选快照/guide 来源入口）
- lib/director-stage/schema.ts（可选来源字段，兼容旧记录）
- lib/director-stage/h3-handoff.ts（长度、Motion 来源）
- components/director-stage/director-stage-panel.tsx（小节及批次反馈）
- app/canvas-workspace.tsx（Motion guide 新节点同步时长）
- scripts/test-motion-realistic-anchors.mjs、package.json（测试入口）

没有修改 H3 / AddGuide / SDXL 冻结模板，没有安装软件、模型或节点，没有重构 Shot / Blender Bridge。

## 自动检查

通过：pnpm exec tsc --noEmit、pnpm build、pnpm lint（0 error，22 条已有 warning；构建有大 chunk 提示）。

通过：test:motion-realistic-anchors、test:director-stage、test:director-stage-motion-v2、test:director-stage-h3、test:shot-system、test:h3-addguide、test:h3-modes、test:project-backup、test:sdxl-depth-firstframe。

新增测试使用真实本机 Blender、假 ComfyUI（不执行 AI 推理），覆盖 f0/f50/f100 快照、实际两张不同 Depth、两包、来源、排序、f0/文字/越界拒绝、Prop/Camera 不变、Camera Motion、普通首帧、Run 上下文、备份恢复、失败保留素材。

## 一次真实 GPU 验收

在内置浏览器的独立 127.0.0.1:5180 origin 进行，不修改用户 5173 的 IndexedDB。已有 ComfyUI 8188 运行中，没有启动或升级后端。

- 场景：4×5×2.8m 简单房间，固定 28mm 9:16 机位，木方块。
- Motion：f0 站立；f50 绕 X 轴 -30°；f100 -85°。渲染姿态来自关键帧快照。
- 原有白模首帧逻辑生成 f0 RGB；本次没有另加第三次 SDXL 出图。
- 生成 f50 和 f100 两张 SDXL 写实 Guide，然后只提交一次 H3。
- H3：length=141，0.5MP，Turbo=true，6 steps，24FPS。输出 544×960、141 帧、5.875 秒。
- 输出：video/MiniMax_H3_i2v_00104_.mp4。
- H3 prompt/Run ID：a816916c-617e-4f92-af85-6eb61da4ed46；ComfyUI 执行约 150 秒。
- Scene：d6c6371c-414a-42ec-90a3-37247aaedc4e。
- Camera：d2fa84d1-a818-454e-a3e1-be425728ee31。
- Motion：4efa1e4b-196c-4aad-a556-fce08d23b054。
- Shot：57777a1d-8d05-4895-9493-acd2a1719344；status=has_candidates；候选 A 正常创建，没有自动采用。
- Guide f50：c4f48b29-c005-4fe8-8ddb-2ed1dc31148e，seed=1044461304，SDXL promptId=6fece5cd-98b3-46e6-8ea9-b5af270f64e1。
- Guide f100：44957bd2-a383-4391-a3ab-9e9a6b102604，seed=385977756，SDXL promptId=1566a149-ac10-4963-bbe5-d2486a13d4e5。
- 两包同 batch：c423355f-38d3-42bd-bd34-02584c7dfc75。
- Run.directorContext 正确记录 motionIds、两包 guidePackageIds、anchorFrames=[50,100]，inputsMatchHandoff=true。
- 重新打开画布后视频、两锚点、候选及记录恢复；真实鼠标点击原生播放三角后 paused=false、currentTime 前进。控制台无新 error，只有已有中文翻译缺项 warning。

## 锚点效果与提前时间

两个 Guide 对应的木纹/墙地材质和不同轮廓都明显出现在视频里，先接近 f50 图，再接近 f100 图，没有颠倒。

人工逐帧观察：第一张 Guide 的写实外观约 f20 已出现（比 f50 提前约 30 帧 / 1.25 秒）；第二张的近水平倒下姿态约 f75 已明显出现（比 f100 提前约 25 帧 / 1.04 秒）。这描述的是目标特征提前出现，不是精确测量动作起点或某个旋转角度。

辅助 RGB 差异检查（缩小到 136×240，非动作识别）：与 Guide f50 最接近的是视频 f51；Guide f100 最接近的是 f100，95 帧已进入最低误差 20% 范围。不能把外观出现时间与像素最接近时间混为一谈。

新发现：倒下过渡仍更像形变而非严格刚体旋转；白模 RGB 首帧到写实 Guide 存在材质转换。AddGuide 对目标画面有用，但不保证 Motion 角度、物理运动或严格发生时刻。

证据在 .claude/artifacts/motion-realistic-anchors-v0.1/：通过 ComfyUI HTTP history/view 取得的两个 Depth、两张 Guide、MP4、history JSON、comparison.jpg、timing-detail.jpg、canvas-proof.png。检查脚本只下载和 CPU 解码，不提交 GPU。

下一步：先由用户真人验收；若继续效果实验，优先使用风格一致的写实首帧与 Guide，并单独评估空间动作还原。本轮未追加 GPU 生成或调参，不自动继续下一阶段。
