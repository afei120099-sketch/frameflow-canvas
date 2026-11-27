# 画布自动化接口 V0.1（window.frameflow）

2026-10-07。目的：用代码代替鼠标完成"找素材 → 建 H3 → 填提示词/参数 → 生成 → 查状态 → 采用"，减少逐个点击。

## 原则

- 只调用鼠标界面本来就调用的函数：图片导入、`createH3Node`、`createBoundArrow`、节点 props、H3 节点自己的 `generate()` / 采用。
- 因此生成前检查、工作流拦截、GPU 温度门禁、Shot / Run / Asset 记录、刷新恢复与点击完全一致。接口本身不发任何 ComfyUI 请求。
- 只能改这些 H3 设置：`prompt, duration, aspect, soundMode, megapixels, seedMode, seed, generationCount`。模型、Steps、LoRA、冻结模板一律不可改。
- 只在本地开发服务器上启用：页面能访问 `/__automation/ping` 才安装 `window.frameflow`；生产构建没有该端点。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/canvas-automation.ts` | `window.frameflow` 本体、H3 节点控制器注册表、后台标签页帧泵 |
| `scripts/automation-vite-plugin.ts` | `/__automation/ping`、`/__automation/file?path=`（只读、仅本机、白名单目录、仅图片/视频/音频、≤200MB） |
| `app/canvas-workspace.tsx` | H3 节点注册 generate/状态；画布挂载时安装；`automationDeps` |
| `vite.config.ts` | 注册插件 |

文件读取白名单：环境变量 `FRAMEFLOW_AUTOMATION_ROOTS`（`;` 分隔），默认 `./data/automation`（`FRAMEFLOW_DATA_ROOT` 下的 `automation`）。

## 用法（在画布页面控制台或通过浏览器自动化执行）

```js
frameflow.help()
frameflow.list({ type: "h3" })                      // 所有节点：位置、名字、H3 设置、连线、生成状态
frameflow.get(id)                                   // 完整提示词与实际提交的提示词
await frameflow.addImage({ path: "/path/to/a.png", x, y })
const h3 = await frameflow.createH3({ first: imageId, last?: imageId, prompt, duration: 5.9, soundMode: "ambient", generationCount: 2 })
await frameflow.setH3(h3.id, { prompt: "..." })
await frameflow.generate(h3.id)                     // 先过生成前检查；返回 submitted.taskMode / compiledPrompt
frameflow.status(h3.id); await frameflow.waitFor(h3.id)
await frameflow.adopt(h3.id)
```

## 后台标签页

tldraw 在 requestAnimationFrame 上刷新 store 监听和形状渲染；Chrome 窗口被遮挡时标签页 hidden，rAF 暂停，脚本建立的连线不会传到 H3 节点。
`canvas-automation.ts` 在模块加载时包装 rAF：自动化调用期间（及之后 3 秒），隐藏页里待执行的帧另加一个计时器兜底，谁先到执行谁、只执行一次。平时完全透明。
`generate()` 还会把节点移入视口，并等到节点模式与连线一致（如 i2va）才提交，不一致则拒绝而不是提交旧设置。

已知限制：从未显示过的新标签页里，Chrome 会推迟加载 `<video>`，生成结果读取元数据会卡住（与本接口无关，鼠标点击同样）。正常使用的画布标签页不受影响。

## 验证（2026-10-07）

- `tsc --noEmit` 通过；新文件 ESLint 0 问题；`canvas-workspace.tsx` 无新增警告。
- 隔离 5180 + 假 ComfyUI（不占 GPU）：addImage（白名单内成功；白名单外 403、非媒体扩展名拒绝）、createH3 连线、setH3 拒绝 `steps`、隐藏标签页 + 视口外节点 generate 正确识别 i2va 并提交。
- 用户 5173 画布：`list()` 只读核对，正确列出全部节点、连线与候选数。
- 未用本接口提交真实 GPU 任务。
