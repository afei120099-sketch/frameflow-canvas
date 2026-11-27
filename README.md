# Frameflow Canvas

**English** · [中文](#中文说明)

Frameflow is a local-first infinite canvas for making AI short videos. It runs in your browser on top of
[tldraw](https://tldraw.dev), talks to a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) for
generation, and is built mainly around the MiniMax H3 video model (text/image/reference → video with audio).
All media, projects and run records stay on your machine.

> Status: personal project, early (V0.1). Windows-first. Expect rough edges and Chinese-language UI.

## Features

- **Infinite canvas** – pan / zoom, multi-select, undo / redo, arrows between nodes, drag JPG / PNG / WEBP / MP4 / audio in from Explorer, local auto-save (IndexedDB), several independent canvases / instances.
- **H3 video nodes** – text-to-video, first/last-frame, multi-reference (pictures, roles, voices), "ultimate" and "fast" workflow presets, resolution / duration / seed controls, time anchors (experimental), candidate takes with adopt / compare.
- **Shot queue & shot cards** – load a `shot-queue-v1` JSON (paste, file, or full path), review every shot as a card (prompt breakdown, completeness check, reference check, duration advice, dialogue per role), fix and export JSON, then enqueue the whole episode; tail-frame chaining, first/last-frame transitions and independent continuation shots.
- **Inbox automation** – drop queue files into an inbox folder; the canvas picks them up under a root control file (`_control.json`, `STOP`), writes status files back and never resubmits jobs whose state is unknown.
- **Roles & asset library** – roles with primary appearance image and voice, per-canvas asset library, copy asset manifests for an AI assistant.
- **Images** – FLUX Dev / Schnell / Klein nodes (text-to-image, img2img, inpainting with mask editor, PuLID face identity, storyboard depth keyframes), batch keyframes for a whole episode.
- **Audio** – text-to-speech, voice design (Qwen3-TTS VoiceDesign, optional), music generation, background-music removal for finished clips.
- **Post-processing** – SeedVR2 upscale, FILM frame interpolation, tail-frame HD, segmented upscale.
- **Editing helpers** – CPU rough cut (PyAV), final-cut list, copy video list, media audit (black frames etc.).
- **Director stage (experimental)** – 3D white-box scene / camera blocking with three.js, optional Blender render of the white-box first frame.
- **Short-drama cover generator** – poster layouts, title composition, character photos.
- **Production line & autopilot (experimental)** – episode JSON → keyframes → videos, with a pluggable "director" (mock / local LM Studio / Claude API).
- **Safety & recovery** – data backup / restore, daily backup, safe delete to the Windows recycle bin, run recovery after reloads, GPU temperature guard, error center and diagnostics.

## Requirements

- **Windows 10/11** (paths, Explorer integration and launch scripts are Windows-only).
- **Node.js ≥ 22.13** and **pnpm**.
- A local **ComfyUI** (the portable build is assumed), reachable at `http://127.0.0.1:8188`, with the custom nodes the workflows use (MiniMax H3 nodes, VideoHelperSuite, PuLID-Flux, DepthAnythingV2, SeedVR2, FILM …). Missing nodes or models are reported before anything is submitted.
- **Model weights are not included.** Download them yourself and put them in your ComfyUI `models/` folders:
  - **MiniMax H3** weights must be obtained from MiniMax's official release and are governed by the **MiniMax H3 Community License**. You must read and comply with it yourself. **That license contains territorial (regional) restrictions on where the model may be used**; check the license text on the official model page before downloading or using it. This project does not grant any rights to the model.
  - Other models (FLUX, SeedVR2, Qwen3-TTS, MiniMax Music, …) are governed by their own licenses.
- A GPU that can run H3 (the workflows were tuned on a 16 GB card).
- Optional: Python with PyAV (e.g. ComfyUI portable's `python_embeded\python.exe`) for rough cut / media audit; portable Blender for the white-box render.

## Install & run

```powershell
git clone <this repo>
cd frameflow-canvas
pnpm install

# configure (see .env.example for every option; values are read from the environment)
$env:FRAMEFLOW_COMFYUI_ROOT = "C:\ComfyUI_windows_portable\ComfyUI"
$env:FRAMEFLOW_PYAV_PYTHON  = "C:\ComfyUI_windows_portable\python_embeded\python.exe"

# start ComfyUI first, then:
pnpm inbox:server   # inbox helper on 127.0.0.1:5193 (separate terminal)
pnpm dev            # canvas on http://localhost:5173/
```

Or use `scripts/launch-canvas.ps1`, which starts the canvas, the inbox helper and the recycle-bin helper and opens the browser.
Open the canvas with `localhost` (not `127.0.0.1`): browser storage is per hostname.

Local data goes to `./data` by default (`FRAMEFLOW_DATA_ROOT`). Run records, logs and caches go to `./runtime`. Both are git-ignored.

### Configuration

All settings are environment variables; see [`.env.example`](.env.example). The most important ones:

| Variable | Default | Meaning |
|---|---|---|
| `FRAMEFLOW_COMFYUI_ROOT` | `C:\ComfyUI_windows_portable\ComfyUI` | ComfyUI folder (models / input / output) |
| `FRAMEFLOW_PYAV_PYTHON` | `python` | Python with PyAV |
| `FRAMEFLOW_DATA_ROOT` | `./data` | Local data root |
| `FRAMEFLOW_INBOX_ROOT` | `./data/inbox` | Inbox folder |
| `FRAMEFLOW_H3_TOOLS` | `./h3-tools` | Optional external prompt-rules toolkit (not included) |
| `FRAMEFLOW_BLENDER` | – | Path to `blender.exe` |

The "ultimate" / "dialogue" H3 workflow templates (`lib/comfyui/experimental/h3-community-*.json`, node `127`) expect a hybrid H3 UNet named `minimax_h3_hybrid_int8_convrot.safetensors`; put a compatible model under that name or edit the template.

### Tests

Tests are plain Node scripts: `pnpm test:<name>` (see `package.json`), e.g. `pnpm test:shot-queue-history`. Most run on CPU with mocks and never submit GPU jobs. A few optional checks only run when you point `FRAMEFLOW_TEST_QUEUE` / `FRAMEFLOW_H3_TOOLS` at local files.

## Project structure

```
app/            Next.js (vinext) app: canvas workspace, API proxies (inbox, media trash, instance)
components/     React UI: canvas nodes, shot cards, queue panel, director stage, dialogs
lib/            Core logic: ComfyUI workflows & adapters, queue / shot-card rules, records, backup …
  comfyui/      Workflow JSON templates and graph builders (H3, FLUX, SeedVR2, music, voice …)
scripts/        Dev-server plugins, local helpers (inbox, recycle bin), Python helpers, tests (test-*.mjs)
config/         Director provider settings and runtime skill
tools/blender/  Blender white-box renderer
docs/           User / integration docs (queue JSON format, inbox control fields, production line …)
db/, drizzle/   Placeholder DB schema (unused by default)
examples/       Starter example (Cloudflare D1)
vendor/, build/ Vendored CSS and build plugin
```

## License

Copyright (c) 2026 小木

The code in this repository is released under the **PolyForm Noncommercial License 1.0.0** (see [LICENSE.md](LICENSE.md)).
**Commercial use is not permitted.**

- **tldraw** is used under tldraw's own license. Using tldraw in production requires a license key from tldraw — see <https://tldraw.dev>.
- **MiniMax H3** and all other model weights are not part of this repository and are governed by their own licenses (for H3: the MiniMax H3 Community License, including its territorial restrictions).
- Other dependencies keep their own licenses (see `vendor/*.LICENSE*`, `build/*.LICENSE` and `node_modules`).

---

## 中文说明

Frameflow 是一个本地优先的 AI 短视频无限画布：在浏览器里运行，基于 [tldraw](https://tldraw.dev)，调用本机 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) 出图出视频，主要围绕 MiniMax H3 视频模型（文字 / 图片 / 参考 → 带声音的视频）。素材、项目和运行记录都留在你自己的电脑上。

> 状态：个人项目，早期版本（V0.1），以 Windows 为主，界面是中文。

### 功能

- **无限画布**：平移缩放、多选、撤销重做、节点连线；从资源管理器拖入图片 / 视频 / 音频；本地自动保存；可开多个独立画布。
- **H3 视频节点**：文生视频、首尾帧、多参考（图片、角色、声音）；终极版 / 极速版预设；分辨率、时长、种子；时间锚点（实验）；多条候选、采用与对比。
- **镜头队列与镜头卡片**：载入 `shot-queue-v1` JSON（粘贴、选文件或贴完整路径），每镜一张卡片：提示词拆解、完整度检查、参考图检查、时长建议、按角色写台词；改完导出 JSON，整集入队；接尾帧、首尾帧过渡、独立续拍。
- **收件箱自动化**：把队列文件放进收件箱文件夹，画布按根控制文件（`_control.json`、`STOP`）自动接手，回写状态文件；状态不明的任务不会重复提交。
- **角色与素材库**：角色主外观图、主声音；每个画布独立的素材库；可把素材清单复制给 AI。
- **出图**：FLUX Dev / Schnell / Klein（文生图、图生图、遮罩局部重绘、PuLID 人脸身份、分镜深度关键帧），整集批量关键帧。
- **声音**：文字转语音、AI 音色设计（可选）、配乐生成、成片去背景音乐。
- **后期**：SeedVR2 高清、FILM 插帧、尾帧高清、分段高清。
- **剪辑辅助**：CPU 粗剪（PyAV）、成片清单、复制视频清单、素材体检（黑帧等）。
- **导演台（实验）**：three.js 3D 白模摆场景和机位，可选 Blender 渲白模首帧。
- **短剧封面**：海报版式、标题合成、人物照片。
- **生产线与夜班（实验）**：剧集 JSON → 关键帧 → 视频，导演可选 mock / 本地 LM Studio / Claude API。
- **安全与恢复**：备份 / 恢复、每日备份、安全删除到回收站、刷新后恢复任务、GPU 温度保护、错误中心和诊断。

### 环境要求

- **Windows 10/11**（路径、资源管理器联动和启动脚本只支持 Windows）。
- **Node.js ≥ 22.13**、**pnpm**。
- 本机 **ComfyUI**（默认按便携版目录），地址 `http://127.0.0.1:8188`，装好工作流需要的自定义节点（MiniMax H3 节点、VideoHelperSuite、PuLID-Flux、DepthAnythingV2、SeedVR2、FILM 等）。缺节点或缺模型会在提交前报出来。
- **本仓库不含任何模型权重**，需要你自己下载放进 ComfyUI 的 `models/`：
  - **MiniMax H3** 权重请从 MiniMax 官方发布渠道获取，受 **MiniMax H3 Community License** 约束，须自行阅读并遵守。**该许可对模型可使用的国家 / 地区有地域限制**，下载和使用前请在官方模型页核对许可原文。本项目不授予任何模型权利。
  - 其他模型（FLUX、SeedVR2、Qwen3-TTS、MiniMax Music 等）各自受其许可约束。
- 能跑 H3 的显卡（工作流按 16GB 显存调过）。
- 可选：带 PyAV 的 Python（如 ComfyUI 便携版的 `python_embeded\python.exe`），用于粗剪 / 素材体检；便携版 Blender，用于白模渲染。

### 安装与启动

```powershell
git clone <本仓库>
cd frameflow-canvas
pnpm install

# 配置（全部选项见 .env.example；从环境变量读取）
$env:FRAMEFLOW_COMFYUI_ROOT = "C:\ComfyUI_windows_portable\ComfyUI"
$env:FRAMEFLOW_PYAV_PYTHON  = "C:\ComfyUI_windows_portable\python_embeded\python.exe"

# 先启动 ComfyUI，然后：
pnpm inbox:server   # 收件箱助手 127.0.0.1:5193（另开一个终端）
pnpm dev            # 画布 http://localhost:5173/
```

也可以直接运行 `scripts/launch-canvas.ps1`，它会启动画布、收件箱助手和回收站助手并打开浏览器。请用 `localhost` 打开（不要用 `127.0.0.1`），浏览器存储按主机名区分。

本地数据默认放在 `./data`（`FRAMEFLOW_DATA_ROOT`），运行记录、日志和缓存放在 `./runtime`，两者都不进 git。

### 配置

全部配置都是环境变量，见 [`.env.example`](.env.example)。常用项见上面英文部分的表格。

「终极版 / 对白版」H3 工作流模板（`lib/comfyui/experimental/h3-community-*.json` 的 127 号节点）要一个名为 `minimax_h3_hybrid_int8_convrot.safetensors` 的 H3 hybrid UNet；请放入同名的兼容模型，或修改模板。

### 测试

测试是普通 Node 脚本：`pnpm test:<名字>`（见 `package.json`），例如 `pnpm test:shot-queue-history`。大部分只在 CPU 上用模拟数据跑，不提交 GPU 任务。少数可选检查要设置 `FRAMEFLOW_TEST_QUEUE` / `FRAMEFLOW_H3_TOOLS` 指向本机文件才会跑。

### 目录结构

见上面英文部分的 *Project structure*。用户文档在 `docs/`：队列 JSON 写法、收件箱控制字段、生产线说明、导演台说明等。

### 许可证

Copyright (c) 2026 小木

本项目代码按 **PolyForm Noncommercial License 1.0.0** 发布（见 [LICENSE.md](LICENSE.md)），**禁止商用**。

- 依赖 **tldraw** 受 tldraw 自己的许可约束；在生产环境使用需要向 tldraw 申请许可证号，见 <https://tldraw.dev>。
- **MiniMax H3** 等模型权重不在本仓库内，受各自许可约束（H3 为 MiniMax H3 Community License，含地域限制）。
- 其他依赖保留各自的许可（见 `vendor/*.LICENSE*`、`build/*.LICENSE` 和 `node_modules`）。

## 联系 / Contact

小木 · afei120099@muse.ai
