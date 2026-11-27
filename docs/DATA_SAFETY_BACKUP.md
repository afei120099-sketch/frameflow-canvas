# V1 数据安全 Hotfix：双备份

## 浏览器项目备份

【备份】保存当前 origin 的画布、Asset / Run / Shot / Role、导演台、成片清单和浏览器媒体。
**当前备份不包含夜班任务/计划/夜班磁盘账本。** 夜班完整数据另存于 `runtime/autopilot`（或 `FRAMEFLOW_AUTOPILOT_DIR`）。

恢复前比较同 ID 媒体的 SHA-256、实际大小和 MIME；冲突拒绝。同内容复用，不覆盖。失败时回滚新媒体及已完成的元数据阶段。v1/v2 格式不变。
恢复期间媒体和项目记录写入使用同 origin 的 Web Locks。请先等待或取消生成、关闭其他画布标签页，勿在恢复中编辑。旧浏览器不支持安全锁时拒绝恢复。断电/浏览器退出不保证自动回滚：覆盖恢复前仍须导出当前项目。

## 夜班独立归档（不安装、不启动 GPU）

1. 从画布导出浏览器项目备份。
2. 等夜班完成，**正常停止本地画布服务器**；关闭浏览器不会停止夜班。发现活的账本进程时脚本拒绝归档，不杀进程。
3. 在项目目录运行：

```powershell
node scripts/archive-autopilot.mjs --destination "<备份目录>"
```

创建独立新文件夹，包含夜班任务、计划、账本、日志、输入、视频、输出；只排除 `worker.lock`。持有账本锁，每文件校验 SHA-256；最后写 `manifest.json`。失败目录保留但无完整标记，不可恢复。

```powershell
node scripts/archive-autopilot.mjs --verify "<备份目录>/frameflow-night-实际目录名"
```

两份备份都应复制到另一块磁盘。归档不会读取 API 密钥环境变量。

## 夜班恢复边界

先校验归档，保持服务器停止，将现有 `runtime/autopilot` 保留为另一个目录，再把归档 `data` 内容复制到新的 `runtime/autopilot`。**不要覆盖现有账本，不复制旧 worker.lock。**
未完成任务在服务启动时可能继续查询/执行。正常归档优先选全部任务完成时；未完成账本须先人工确认再启动。浏览器项目和夜班归档分别保存、分别恢复。
