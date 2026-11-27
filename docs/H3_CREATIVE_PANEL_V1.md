# H3 创作面板 V1：真实参数基线

调查来源：当前项目 API Workflow、本机 ComfyUI 安装目录（`FRAMEFLOW_COMFYUI_ROOT`）中的节点源码，以及运行中 ComfyUI 的 `/object_info`。

## 时长

`MiniMaxH3ImageToVideo.length` 的运行时范围是 5–3600，步进 17。模型节点明确说明有效帧数落在 `17k+5` 网格，训练范围约 124–362 帧。CreateVideo 固定 24 FPS，因此 141 帧是 `141 / 24 = 5.875` 秒。

产品层使用秒数，计算方法为：

1. 将输入秒数乘以 24 得到目标帧数。
2. 吸附到最近的 `17k+5`。
3. 产品范围限制在节点注明的训练范围内：124 帧到不超过训练上界约 362 帧的最大合法 `17k+5` 值。上限由公式计算，不直接写死最终 length。

| 用户输入 | V1 length | 实际时长 |
| --- | ---: | ---: |
| 3 秒 | 124 | 5.17 秒（触发最短限制） |
| 5 秒 | 124 | 5.17 秒 |
| 5.5 秒 | 124 | 5.17 秒 |
| 8 秒 | 192 | 8.00 秒 |
| 10 秒 | 243 | 10.13 秒 |
| 12 秒 | 294 | 12.25 秒 |
| 15 秒 | 362 | 15.08 秒 |
| 超过约 15.08 秒 | 362 | 15.08 秒（触发最长限制） |

理论节点上限不等于当前硬件的实用上限。V1 目前开放到模型注明的训练范围上限，RTX 4070 Ti SUPER 16GB 的实际可用上限由用户真人测试确认。

## 像素预算

`ImageScaleToTotalPixels` 允许 0.01–16MP、0.01 步进；这只是节点理论范围。当前成功 Workflow 的真实值是 0.5MP，`resolution_steps=32`，使用 Lanczos 并保持比例。0.6MP、0.8MP 尚无本机显存和生成回归证据，因此 V1 只提供一个“0.5MP（已验证）”档位，不虚构质量等级。

## 比例

“跟随原图”保持现有链路：LoadImage → ImageScaleToTotalPixels → GetImageSize → H3 width/height。

固定比例会在任务副本中临时增加 ComfyUI 内置 `ImageScale` 节点，使用 Lanczos + `crop=center`：等比覆盖目标比例后中心裁切，再进入 0.5MP 节点。原图文件和模板文件都不会被修改。开放：16:9、9:16、1:1、4:3、3:4。

## FPS

H3 length 决定生成的真实帧数。CreateVideo 的 24 FPS 决定这些帧的播放速率及最终时长；单独提高 FPS 只会加速播放，不会生成更多运动帧，所以 V1 固定 24 FPS，且不作为质量选项。

## Turbo / Steps

当前真人成功基准是 Turbo=true、Steps=6、Turbo LoRA 与 Turbo sampler。运行时自定义 sampler 的描述提到 4-step 用法，但当前用户 Workflow 已以 6 Steps 真人成功；V1 以用户成功基线为唯一产品基线，固定 Turbo 6 Steps，不开放未经回归的关闭 Turbo 或自由 Steps。

## Seed

ComfyUI `RandomNoise.noise_seed` 接受 0 到 2^64-1。浏览器端为避免 JavaScript 整数精度丢失，固定 Seed 限制为 0 到 `Number.MAX_SAFE_INTEGER`；随机模式每次生成新值，固定模式把输入值原样注入节点 10。

## UI 到 Workflow 的对应关系

| UI | Workflow |
| --- | --- |
| Prompt | 节点 6 `prompt` |
| 秒数及吸附后的实际时长 | 节点 6 `length` |
| 比例 | 可选临时节点 32 `ImageScale`，中心裁切 |
| 0.5MP | 节点 21 `megapixels` |
| 随机/固定 Seed | 节点 10 `noise_seed` |
| Turbo | 节点 25 `value=true` |
| 6 Steps | 节点 27 `value=6` |
| 24 FPS | 节点 14 `fps=24` |
