# 制作辅助工具 V0.1

提供章节规划、制作进度、连续性记录和本地视频基础检查。

## 入口与使用

1. 夜班 → 长剧本：分段制作 → 参考视频。选视频后主动检查，本地 CPU 全量解码、最多 12 张带时间抽帧；下载联系表，再将分析任务及图片交给自己选择的 GPT / Claude。人工确认建议后带入章节规划，不自动发送外部服务。
2. 检查章节 JSON 后保存到项目。成片序列 → 制作进度与连续性，按章关联已有画布镜头，读取 Shot / Run / Asset / 审核记录显示进度。
3. 每章填写人物、服装、场景、动作衔接。相邻章节声明不同会提醒；这是人工笔记比较，不是图像身份识别。
4. 成片序列选中视频 → 视频基础质检。检查完整解码、时长、音轨及疑似近黑区间，查看抽帧、下载报告。可设置期待时长和声音要求。黑场可能是正常转场或夜景；报告不替代观看、听音或人工审核。
5. 按剧本收齐并排序已采用镜头：保留既有裁切和有效审核，按章节及绑定顺序排列，其他片段留在后方。缺少绑定、采用视频、来源不符或重复片段歧义时拒绝，不猜测、不重新生成。

## 数据与运行边界

- 制作计划最多 20 份，每份最多 40 章，每章最多 12 个已有镜头。重复保存同一规范化计划不增副本；超限拒绝而非覆盖旧数据。
- 计划写入现有 meta 的 productionPlansV1；原项目备份 v1/v2 机制无需迁移，v2 往返测试覆盖计划、参考建议、绑定及连续性笔记。
- 未保存输入、暂时检查报告和抽帧不进入项目备份，需下载。源视频仍走现有媒体备份。夜班任务、计划及磁盘账本仍独立归档，不能把夜班磁盘任务当成已有画布 Shot。
- 检查接口仅用于本机同源 Vite 服务，复用既有 PyAV Python，一次一个 CPU 任务；上限 1GB / 10 分钟视频 / 5 分钟检查。取消或完成后清理临时上传，清理失败记错误。没有 GPU 推理。
- 不自动识别台词、人物变形、剧情符合度或运镜；也不承诺抽帧覆盖短暂瑕疵。质量判断和采用仍是人工操作。
- 没有新增 Provider、预算、自动付费调用或自动排队生成。生产预览测试使用独立内置浏览器数据，不共享用户 Chrome 的项目。

## 验证命令

- node --experimental-strip-types scripts/test-production-tools.mjs
- node --experimental-strip-types scripts/test-media-audit.mjs
- node --experimental-strip-types scripts/test-story-chapters.mjs
- node --experimental-strip-types scripts/test-production-review.mjs
- node --experimental-strip-types scripts/test-project-backup.mjs
- node --experimental-strip-types scripts/test-data-safety-hotfix.mjs
- node --experimental-strip-types scripts/test-autopilot-m2.mjs
- node --experimental-strip-types scripts/test-rough-cut.mjs
- node node_modules/typescript/bin/tsc --noEmit
- npm run lint / npm run build
