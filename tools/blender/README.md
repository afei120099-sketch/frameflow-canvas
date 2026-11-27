# Blender Bridge V0.1：白模 → Blender → RGB 白模图

把导演台 3D 白模的一个场景交给 Blender 渲染，输出一张 RGB 白模图和一份机位记录。只用官方便携版 Blender，不装插件，不用系统 Python。

## 准备

- 用官方便携版 Blender（Windows zip），解压即可用（开发时用的是 5.2.2 LTS，自带 Python 3.13）。
- 用环境变量 `FRAMEFLOW_BLENDER` 直接指定 `blender.exe`；或者设 `FRAMEFLOW_BLENDER_SEARCH_DIR`，程序会在该目录下找最新的 `blender-*-windows-x64\blender.exe`。

## 使用

1. 在导演台里摆好白模：房间、方盒 / 平面、摄影机（焦距、画幅）。
2. 在画布上【备份】导出项目，备份文件夹里会有 `director-stage.json`。
3. 渲染：

```bash
"<Blender 目录>/blender.exe" -b --factory-startup --python-exit-code 1 -P tools/blender/whitebox_render.py -- --input "<备份文件夹>" --scene "<场景名或 ID>" --camera "<机位名或 ID>"
```

| 参数 | 说明 |
|---|---|
| `--input` | 备份文件夹，或其中的 `director-stage.json` |
| `--scene` | 场景名或 ID。只有一个场景时可省略 |
| `--camera` | 机位名或 ID，必须已放入白模。该场景只有一个机位时可省略 |
| `--out` | 输出目录，默认是 `<备份文件夹>/blender-out/<场景ID>__<机位ID>/` |
| `--long-side` | 长边像素，默认 1920（9:16 输出 1080×1920，16:9 输出 1920×1080）。必须是 16 的倍数，以保证比例精确 |
| `--save-blend` | 另存一份 `whitebox.blend`，方便检查 |

出错时退出码为 2，错误信息会列出可选的场景或机位。

4. 输出：
   - `rgb.png`：Workbench 渲染的白模图；
   - `camera.json`：焦距、画幅、竖直视角、three.js 坐标下的 transform、Blender 世界矩阵、每个 Prop 在画面中的范围（`framing`）、源文件 SHA256。
5. 回到画布：用素材库【导入】`rgb.png` → 在导演台建一个“首帧”控制素材包并引用它 → 发送到 H3。

## 一键使用（V0.2）

在导演台的场景详情里点【生成白模首帧】，会自动完成上面第 2–5 步：由本地开发服务器在后台调用 Blender，不需要导出备份，也不需要手动导入。详见 `docs/director-stage/README.md`。

## 约定（与 three.js 白模一致）

- 单位是米，Y 轴朝上，房间地面中心是原点。
- 旋转用度数，按 three.js 的 XYZ 欧拉角（矩阵 = Rx·Ry·Rz）。
- 方盒原点在底面中心；平面是本地 XY 平面上 1×1 的正方形。
- 先按 three.js 坐标搭建场景，再整体绕 X 轴转 +90° 进入 Blender 的 Z 朝上坐标：three (x, y, z) → Blender (x, −z, y)。
- 机位朝本地 −Z 方向看。传感器按高度适配、高 24 mm，所以焦距和白模里看到的画面一致。
- 房间只显示内侧，与 three.js 的 BackSide 效果一致。没放入白模的 Prop 会被跳过，并记在 `skippedProps` 里。

## Motion V0.2：只做导出准备

场景里有带位置的关键帧（📍）时，`whitebox_render.py` 会额外写出 `motion.json`（格式 `frameflow-blender-motion-v1`，24 FPS）。内容是每个空间关键帧的 three.js 姿态和 Blender 世界矩阵（几何体和静帧一致，摄影机忽略尺寸）。这个版本不生成动画，也不渲染视频；`rgb.png` 仍然使用布置位置。

## 高级控制素材 V0.1（`--controls depth,mask,object-id`）

在 RGB 之后，用 Cycles 对同一场景、同一机位再做一次数据渲染（每像素只在中心采样 1 次，不做抗锯齿），额外输出 `depth.png`、`mask.png`、`object-id.png`，与 `rgb.png` 像素对齐。`camera.json` 的 `controls` 段记录深度的近 / 远米数、各道具的颜色和可见像素数，以及渲染时间。不加 `--controls` 时，输出与以前完全一样。

已知限制：机位要放在房间里面。机位在房间外时，RGB 会透过墙看到室内（只渲染墙的内侧），而数据渲染会被墙挡住，两者不一致。

## 仍不包含

Normal、Motion 动画、材质与灯光；控制图也不会发送到 H3 或 ControlNet。

## 测试

`pnpm test:blender-bridge`：用 Blender 渲染 9:16 和 16:9 两个机位，逐个比较 Prop 在 Blender 和 three.js 中的画面范围（误差 < 0.2%）。找不到 Blender 时自动跳过。
