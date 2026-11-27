# H3 生成次数

H3 节点可选 1～10 次生成，旧节点默认 1 次。点击一次后顺序生成，输入素材、提示词和参数沿用点击时的快照；每次独立 Run、Seed 和视频 Asset，归入同一 Shot 候选。随机模式每次不同 Seed；固定模式每次相同，结果可能重复。

失败、取消、提交状态不确定或温度保护拒绝会停止后续次数，不自动重试；已完成候选保留，已采用版本不会被新结果替换。冻结模板不修改。每个 Run 的 parameters.generationBatch 记录批次 ID、序号和总次数，沿用现有项目备份字段。

这是画布页面内的串行批量生成，不是夜班后台任务。期间保持页面打开；刷新/关闭后只恢复已提交 Run，未提交次数不会自动补跑，避免重复生成。高清增强、流畅增强节点暂不增加重复生成。

测试：`node --experimental-strip-types scripts/test-generation-batch.mjs`；浏览器测试 `scripts/test-generation-batch-browser.mjs` 接收 Playwright 入口、Edge 路径和画布 URL。浏览器使用独立上下文，全部 ComfyUI 请求转向模拟后端，不运行真实 GPU。
