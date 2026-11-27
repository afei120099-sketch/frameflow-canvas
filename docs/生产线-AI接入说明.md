# Frameflow 生产线 · AI 接入说明（给写剧集 JSON 的 AI 看）

> 你的任务：把用户给的一集剧情，写成一份 **production-episode-v1** 剧集 JSON。用户会把它粘进生产线页面（「＋ 新建」→ 粘贴 → 保存），然后上传你列出的素材文件。**只输出 JSON，不要 Markdown 代码块以外的解释，也不要注释。**

## 1. 生产线怎么跑（理解这一点再写）

```
（可选）每镜一张分镜图 ──自动转深度图（锁构图、机位、站位、姿态）
        └→ Flux Dev 出关键帧 ×N（PuLID 锁主角的脸；没有分镜图就只按 keyframePrompt 出图）→ 用户点「通过」
               └→ 通过的关键帧当首帧（Picture 1）→ H3 出视频 → 用户点「选定」
                       └→ 全部选定后按镜头顺序硬切成片
```

- **分镜图是可选的**，见 §6.1。
  - **有分镜图**：构图、机位、姿态来自分镜图，不是文字。`keyframePrompt` 只写外观：人物、衣服、场景、光线、质感。
  - **没有分镜图**（`storyboard` 不写或写 `null`）：构图全靠文字。`keyframePrompt` 必须先写景别、机位、人物在画面里的位置和姿态，再写外观。例：`medium shot, low angle, she sits on the left end of a grey sofa facing camera, he stands behind the sofa on the right, modern office at night, warm desk lamp`。
- **视频的第一帧就是通过的关键帧**，所以 `videoPrompt` 写的是从这一帧开始发生什么。

## 2. 顶层字段

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `version` | 是 | 固定 `"production-episode-v1"` |
| `title` | 是 | 1–80 字 |
| `aspect` | 否 | `"9:16"`（默认，关键帧 864×1536）或 `"16:9"` |
| `roles` | 否 | 0–12 个角色，见 §3 |
| `keyframe` | 否 | 见 §4 |
| `video` | 否 | 见 §5 |
| `shots` | 是 | 1–80 镜，见 §6 |

**不认识的字段会被拒绝**，不要自创字段。

## 3. roles[] 角色

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `key` | 是 | 角色 ID，只用英文字母、数字、`_`、`-`，例如 `"zhangsan"`，整集唯一 |
| `name` | 否 | 显示名，例如 `"张三"` |
| `description` | 否 | 稳定身份描述（年龄段、发型、固定服装），最多 400 字；会进 H3 的人物定义 |
| `face` | 否 | 脸部特写图文件名；关键帧靠它锁脸。要锁脸的角色必须有 |
| `appearance` | 否 | 外观图文件名数组，最多 4 张；**第 1 张**是交给 H3 的主外观 |
| `voice` | 否 | 主声音文件名（wav/mp3/flac/m4a）；有台词的角色建议提供 |

## 4. keyframe 关键帧设置

| 字段 | 默认 | 规则 |
| --- | --- | --- |
| `look` | `""` | 全集共用的外观/画风描述，**英文**，最多 600 字 |
| `depthStrength` | `1` | 分镜深度控制强度 0.3–1.5 |
| `candidates` | `3` | 每镜出几张候选 1–6 |
| `autoApproveAbove` | `null` | 0.3–0.95：人脸相似度最高且达到这个值的那张自动通过；`null` 全部人工审 |

## 5. video 视频设置

| 字段 | 默认 | 规则 |
| --- | --- | --- |
| `workflow` | `"ultimate"` | 目前只能是 `"ultimate"` |
| `tuning` | `"default"` | `"default"`：原 10 步，快。`"understanding"`：去加速 LoRA、25 步，动作时间点更准，耗时约 1.5–2.3 倍。**打斗、动作节点多的集选 understanding** |
| `soundMode` | `"av"` | `"av"` 有台词有声 / `"ambient"` 只要环境声 / `"silent"` 静音。**任何镜头有台词就必须是 av** |
| `megapixels` | `0.5` | 0.3–1.0 |
| `candidates` | `1` | 每镜出几条 1–6 |

## 6. shots[] 镜头

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `shotId` | 是 | 镜头 ID，只用英文字母、数字、`_`、`-`，整集唯一，例如 `"S01"` |
| `title` | 否 | 镜头名，最多 80 字，例如 `"李四推门"` |
| `storyboard` | 否 | 这一镜的分镜图文件名（决定构图和机位），格式见 §6.1；不写或写 `null` = 按 `keyframePrompt` 直接出关键帧 |
| `faceRole` | 否 | 关键帧锁谁的脸（角色 key）；该角色必须有 `face`；空镜或群演写 `null` |
| `faceWeight` | 否 | 锁脸强度 0–1.5，默认 0.85；仰拍/俯拍/侧脸建议 0.5–0.65 |
| `keyframePrompt` | 否* | 这一镜的关键帧描述，**英文**，最多 800 字。有分镜图时只写外观；**没有分镜图时先写景别、机位、站位和姿态**。*和 `keyframe.look` 至少有一个非空 |
| `videoPrompt` | 是 | H3 视频提示词，最多 12000 字，写法见 §7 |
| `roles` | 否 | 本镜出现或说话的角色 key 数组 |
| `dialogue` | 否 | 台词数组，见 §8 |
| `voiceRole` | 否 | 当台词写在 videoPrompt 的 `<d>…</d>` 里而不用 dialogue 时，指定说话角色 |
| `offscreen` | 否 | 只出声不出镜的角色 key（必须在 roles 里），不提交其外观 |
| `seconds` | 否 | 5–15 秒，默认 6。H3 会对齐到 17n+5 帧，实际可能略短 |
| `seed` | 否 | 非负整数，固定种子；不写则随机 |

### 6.1 分镜图（storyboard）格式

- **可选**。用户已经有分镜图、或者构图很讲究（多人站位、特殊机位、动作姿态）时才写；没有就省略这个字段，不要编造用户没有的文件。
- **文件**：图片，`png / jpg / jpeg / webp`，文件名规则见 §9。推荐 `<shotId>.png`，例如 `"A15.png"`。如果用户画布里已经有这张图，**直接写画布里的文件名**，或写 `<assetId>.png`（画布素材编码），打开剧集时会自动从画布补上。
- **比例**：和 `aspect` 一致。9:16 用竖图（关键帧 864×1536），16:9 用横图（1536×864）；比例不同会被拉伸。
- **内容**：只管构图，不管好不好看。线稿、火柴人、白模截图、实拍照片、AI 草图都可以。要看得出：景别、机位高低、人物在画面里的位置、大致姿态、前后景关系。脸、服装、光线由 `keyframePrompt` / `look` 和角色脸部图负责。
- 同一张分镜图可以给多镜共用；`keyframe.depthStrength` 调分镜约束的强弱（默认 1，构图太死就调到 0.6–0.8）。

## 7. videoPrompt 写法（H3）

1. **第一句**：`<Picture 1> is the first frame.` 然后**用一句话描述首帧里看得见的东西**（谁、站位、服装、光线），再写动作。不要第一句就写动作。
2. **图片编号**：`<Picture 1>` = 通过的关键帧；`<Picture 2>` 起依次是本镜 `roles` 里**出镜**角色的主外观图（按 roles 顺序，`offscreen` 的不算）。用不到可以不写编号。
3. **动作按时间写**：`[0s-2s] … [2s-4s] …`。每个节点至少约 1.5 秒；时间段不能超过 `seconds`。动作多就拆成两镜。
4. **只写画面里有什么，不写"不要什么"**：本地 H3 是 cfg=1，没有负面提示，`no X / never / without / 不要 / 禁止` 会把 X 带进画面。✗ `no people in the background` → ✓ `the corridor behind him is empty`。
5. **声音要写具体**：有台词的镜头之外，写出环境声（脚步、风、雨、远处电梯声…），否则 H3 可能自己编人声。
6. **画外音**：说话角色放进 `offscreen`，提示词里写 `says in an off-screen voiceover`，并写明画面里的人 `mouth stays closed`。
7. **台词不要重复写进 videoPrompt**：用 `dialogue` 字段，系统会自动编译进去（含 `<Subject N>`、`<Audio N>` 绑定）。
8. 中英文都可以（H3 的文本编码器读中文）；运镜用明确术语：slow push-in、pull back、tracking shot、orbit、static camera、handheld。

## 8. dialogue 台词

```json
"dialogue": [
  { "roleId": "lisi", "text": "张总，您找我？" },
  { "speaker": "前台", "text": "这边请。", "voice": "none" }
]
```

- `roleId` 写角色 key，必须在本镜 `roles` 里；不能同时写 `speaker`/`voice`。
- 没建角色的配角：`speaker` + `text`，`voice` 为 `"none"` 或 `"audio:声音文件名"`。
- 最多 100 句；台词照原文写，系统按原语言念。

## 9. 素材文件名规则

- 只用字母、数字、中文、空格和 `. _ - ( )（）`，第一个字必须是字母、数字或中文，最长 120 字。
- 扩展名：图片 `png / jpg / jpeg / webp`，声音 `wav / mp3 / flac / m4a`。
- 不要路径（不能有 `/`、`\`、`..`）。
- 从画布自动补素材：剧集打开时，生产线会在同一端口画布的角色和素材里找缺的文件，对得上的自动上传。为了自动对上：角色的 `name` 写画布里角色的名字（如「张三」），或 `key` 直接写画布角色的 roleId；分镜图的文件名写画布素材的文件名（如画布里叫 `A15.png` 就写 `A15.png`），或写 `<assetId>.png`。对不上的在「素材 → 从画布匹配」里手动选。
- 同一个文件可以被多处引用。**在 JSON 之外**，另起一行列出用户需要准备的全部文件名，方便用户对照上传（这是唯一允许的 JSON 外文字，放在 JSON 后面）。

## 10. 完整示例

```json
{
  "version": "production-episode-v1",
  "title": "示例项目 第3集",
  "aspect": "9:16",
  "roles": [
    { "key": "zhangsan", "name": "张三", "description": "成年男性，短黑发，浅灰衬衫，深色西裤", "face": "zhangsan_face.png", "appearance": ["zhangsan_full.png"], "voice": "zhangsan_voice.wav" },
    { "key": "lisi", "name": "李四", "description": "成年女性，黑色长发，白衬衫配米色西装外套", "face": "lisi_face.png", "appearance": ["lisi_full.png"], "voice": "lisi_voice.wav" }
  ],
  "keyframe": { "look": "photorealistic modern office drama, soft window light, muted film colors", "depthStrength": 1, "candidates": 3, "autoApproveAbove": null },
  "video": { "workflow": "ultimate", "tuning": "default", "soundMode": "av", "megapixels": 0.5, "candidates": 1 },
  "shots": [
    {
      "shotId": "S01", "title": "张三看文件", "storyboard": "S01.png", "faceRole": "zhangsan",
      "keyframePrompt": "a mature East Asian man in a light gray shirt reading a document at a wooden desk, city skyline through the window",
      "videoPrompt": "<Picture 1> is the first frame. A man sits at his desk by the window, holding a document, soft afternoon light. Static camera. [0s-3s] He slowly lowers the document. [3s-6s] He looks up toward the door, eyes narrowing. Sound: quiet office room tone, the faint hum of the air conditioner, paper rustling.",
      "roles": ["zhangsan"], "seconds": 6
    },
    {
      "shotId": "S02", "title": "李四推门", "faceRole": "lisi", "faceWeight": 0.8,
      "keyframePrompt": "medium shot, eye-level camera inside the office, a young East Asian woman stands in the center of a glass office door facing camera, one hand on the handle, white shirt and beige blazer",
      "videoPrompt": "<Picture 1> is the first frame. A woman stands at the glass door of the office, one hand on the handle. Slow push-in. [0s-2s] She pushes the door open. [2s-5s] She stops in the doorway and speaks politely. Sound: the door hinge, soft footsteps on carpet.",
      "roles": ["lisi"], "dialogue": [{ "roleId": "lisi", "text": "张总，您找我？" }], "seconds": 5
    }
  ]
}
```

（S01 有分镜图，S02 没有分镜图，构图写在 keyframePrompt 里。）

需要的文件：S01.png、zhangsan_face.png、zhangsan_full.png、zhangsan_voice.wav、lisi_face.png、lisi_full.png、lisi_voice.wav

## 11. 交付前自检

- [ ] `version`、每镜 `shotId`/`videoPrompt` 都有；没有自创字段；`storyboard` 只写用户真有（或会去画）的图
- [ ] 所有 `faceRole`、`roles`、`dialogue.roleId`、`offscreen` 都是 roles 里存在的 key；`faceRole` 的角色有 `face`
- [ ] 有台词 → `video.soundMode` 是 `"av"`
- [ ] `keyframePrompt` / `look` 是英文、没有否定词；有分镜图的只写外观，没分镜图的先写景别、机位、站位
- [ ] `videoPrompt` 第一句描述首帧画面；时间段不超过 `seconds`；每个动作节点 ≥1.5 秒；没有 no/never/不要/禁止
- [ ] 无台词镜头写了具体声景；画外音写了 off-screen voiceover 和 mouth stays closed
- [ ] 台词只放在 `dialogue`，没有在 `videoPrompt` 里重复
- [ ] 打斗或动作节点多 → `video.tuning` 用 `"understanding"`
- [ ] 文件名符合 §9，并在 JSON 后列出全部所需文件

导入后页面会对每镜做「体检」（否定词、首句、声景、时间轴、打斗配置等），只提醒不拦截；格式错误会在保存时直接报出具体字段。
