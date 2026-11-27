# h3-tools

[中文](#中文) | [English](#english)

## 中文

### 这是什么

写 MiniMax H3 视频提示词和镜头队列（shot-queue JSON）用的一套规则和检查工具：

| 文件 | 作用 |
|---|---|
| `SKILL_h3-video.md` | 提示词写法规范（正本）：流程、官方格式、每镜必写五项、接尾帧、审片返修 |
| `h3q.py` | 命令行工具：按需取规则，按正本静态检查队列 JSON |
| `h3q_data.json` | h3q 读的规则数据（知识模块、骨架、模板） |
| `h3q检查说明.md` | 每条检查怎么判断、报错是什么格式 |
| `THIRD_PARTY_NOTICES.md` | 第三方署名 |

规范适用 MiniMax H3 官方提示词格式（Ref2VA 六段式；T2VA / I2VA / FL2VA / L2VA 三栏式）。

### 怎么用

需要 Python 3，只用标准库。

```bash
python h3q.py check 队列.json          # 检查队列：ERROR 必改 / WARN 需确认 / HINT 建议
python h3q.py check 队列.json --skip-table   # 旧队列没有 _对照表.md 时
python h3q.py list                    # 列出知识模块
python h3q.py get 提示词 官方格式       # 取一节规则
python h3q.py find 口型                # 跨模块搜
python h3q.py template ref            # 单镜模板
```

`check` 默认要求队列旁边有 `<队列名>_对照表.md`（写法：`python h3q.py get 导演 逐镜对照表`）。

### 和画布的关系

Frameflow 画布的镜头卡片会调用 `python h3q.py check …`，按报错前缀（`[五项·…]`、`[官方·…]`、`[时长]`、`[接尾帧]`、`[ID]` 等）分组显示、做一键修改按钮。所以**报错前缀格式不要改**。

画布通过环境变量 `FRAMEFLOW_H3_TOOLS` 找这个目录；没设置时默认 `./h3-tools`。

## English

### What it is

Rules and a checker for writing MiniMax H3 video prompts and shot queues (shot-queue JSON):

| File | Purpose |
|---|---|
| `SKILL_h3-video.md` | The prompt-writing spec (canonical): workflow, official format, five must-have items per shot, last-frame chaining, review |
| `h3q.py` | CLI: fetch rules on demand and statically check a queue JSON against the spec |
| `h3q_data.json` | Rule data read by h3q (knowledge modules, skeletons, templates) |
| `h3q检查说明.md` | How each check decides and what its message looks like |
| `THIRD_PARTY_NOTICES.md` | Third-party attribution |

The spec targets the official MiniMax H3 prompt format (Ref2VA six-section; T2VA / I2VA / FL2VA / L2VA three-section). Most rule text is in Chinese.

### Usage

Python 3, standard library only.

```bash
python h3q.py check queue.json               # ERROR must fix / WARN confirm / HINT suggestion
python h3q.py check queue.json --skip-table  # older queues without a _对照表.md
python h3q.py list
python h3q.py get 提示词 官方格式
python h3q.py template ref
```

### Relation to the canvas

The Frameflow canvas shot cards run `python h3q.py check …` and group results by message prefix (`[五项·…]`, `[官方·…]`, `[时长]`, `[接尾帧]`, `[ID]` …) to drive one-click fixes, so **do not change the prefix formats**.

The canvas locates this directory through the `FRAMEFLOW_H3_TOOLS` environment variable, defaulting to `./h3-tools`.
