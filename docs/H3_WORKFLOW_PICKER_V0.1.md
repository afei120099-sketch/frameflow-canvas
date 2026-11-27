# H3 工作流选择 V0.1

视频节点底部 → H3 工作流按钮 → 小菜单。旧节点默认 stable，选择存为可选的 workflowOptionId，随画布快照保存/备份，不改其他参数、素材或已排队任务。

## 已完成与尚未完成

- stable 完全沿用既有生成路由、模板、Shot / Run / Asset / 恢复链。
- community-ultimate / community-dialogue 仅完成候选文件归档、菜单选择与安全拦截。**没有完成执行适配，不可生成**。不能将菜单登记理解为本机已支持。
- 两份来源是用户上传的 API JSON，不视名称为官方来源证明。归档 JSON 只规范换行，节点内容不变；四图均为 Ref2VA 参考，不是首尾帧锁定。
- 未知工作流也拒绝生成，不回落 stable。入口在任何上传、建 Run 或 GPU 提交之前拦截；菜单在生成/恢复期间不能切换。
- 缺 BlockSparseAttention、ModelPreviewOverrideKJ，以及指定 Hybrid 模型、INT8 文本编码器、DMAD LoRA、taeh3。不会自动安装、下载、切换模型或启用。
- 后续需用户批准依赖处理、核验来源与许可、独立执行适配（参数、采样进度、VHS 输出、Run 身份、断线恢复）和真实 GPU 验收，才能启用候选。单采版扩展 Sigma，不承诺只有四步。

## 验证

node --experimental-strip-types scripts/test-h3-workflow-options.mjs

另回归 H3 / AddGuide 冻结模板与项目备份；TypeScript、修改文件 ESLint 和构建；独立浏览器核对选择、阻断、刷新恢复及切回 stable。
