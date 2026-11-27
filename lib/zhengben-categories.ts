/**
 * 提示词「完整度」类别表：每一镜的提示词应该写到哪些东西。
 * 取自正本 %FRAMEFLOW_H3_TOOLS%\SKILL_h3-video.md 对应版本的「提示词/第一集写法」七段
 * （参考说明 / 风格场景 / 主要动作 / 分秒 / 声音 / 对白 / 画面要求）和「提示词/细节清单」十条。
 * 正本改版时：先运行 python -I "%FRAMEFLOW_H3_TOOLS%\h3q.py" get 提示词 第一集写法 和 get 提示词 细节清单，
 * 对照改这张表和 ZHENGBEN_CATEGORY_VERSION，再改 lib/prompt-completeness.ts 里对应的判定。
 * 只标出来，不拦截入队（用户 2026-11-11 拍板）。
 * ZHENGBEN_CATEGORY_VERSION = 已核对到的正本版本。正本升了版本、更新记录写明规则 / 类别没变（如 v2026-11-11.3 只给 h3q check 加了检查），就只把这个版本号改上去。
 * 卡片发现正本比这里新时只在完整度详情里给一行灰字，不改汇总卡片的颜色和摘要（用户 2026-11-11：别因为小版本号就提醒）。
 * v2026-11-11.3 核对：类别无变化。
 * v2026-11-11.2 同步：类别不增不减；动作声、台词时长两类加了提示（重要动作声写明显不写「很轻」；有台词镜开场空段 ≤1 秒🧪、最后一句后多留 1～2 秒），只提示不算漏写。
 * 标准范本 %FRAMEFLOW_H3_TOOLS%\范本\示例项目_EP02v5_L03_标准 必须 0 漏写（scripts/test-prompt-completeness.mjs）。
 * 卡片会读正本当前版本号（开发服务器 /api/inbox?op=zhengben-version），和 ZHENGBEN_CATEGORY_VERSION 不一样时在完整度汇总上提示「类别表要同步」。
 */
export const ZHENGBEN_CATEGORY_VERSION = "v2026-11-11.3";

export type CategoryId =
  | "reference" | "style" | "scene" | "props" | "light" | "main" | "timeline" | "shotsize" | "compose" | "blocking"
  | "camera" | "face" | "hands" | "actionSound" | "sound" | "dialogue" | "dialogueTime" | "require" | "continuity";

/** 能从词库点选替换的类别，对应 vocab.json 的类名（景别另有一排快捷按钮）。 */
export type PresetKind = "film" | "light" | "camera" | "lens" | "compose";

export interface PromptCategory {
  id: CategoryId;
  /** 卡片标签上的字 */
  label: string;
  /** 要写到什么（说人话） */
  rule: string;
  /** 正本出处 */
  source: string;
  /** 点开可以从词库选预设 */
  preset?: PresetKind;
}

export const PROMPT_CATEGORIES: readonly PromptCategory[] = [
  { id: "reference", label: "参考说明", source: "第一集写法·参考说明", rule: "第一行「参考说明（编号与提交顺序一致）：」；每个出镜角色写「<Picture N>是X，……只用于X的脸、发型和服装」；场景图写清只用于什么（正本模板「只用于……的布局与光线，不用于人物」，没写「不用于人物」只提示）。" },
  { id: "style", label: "风格胶片", source: "第一集写法·风格；细节清单第 9 条", rule: "风格块写胶片和色彩（如「写实真人电影质感，Kodak Vision3 250D 胶片颗粒」），整集逐字复用。", preset: "film" },
  { id: "scene", label: "场景", source: "第一集写法·风格场景", rule: "写清在什么地方、房间里有什么（桌、窗、门……）。" },
  { id: "props", label: "道具可见", source: "第一集写法·风格场景", rule: "重要道具写「必须清晰可见」。这一镜没有手拿的道具时不适用。" },
  { id: "light", label: "光线", source: "第一集写法；细节清单第 9 条", rule: "光线句：光源、方向、亮在哪一侧；同一场景从设定档逐字复制，白天还是夜里、主光暖黄还是冷白前后一样（剧情换了时间就当新场景）。", preset: "light" },
  { id: "main", label: "主要动作", source: "第一集写法·主要动作", rule: "单独一行「主要动作：一句话」。" },
  { id: "timeline", label: "分秒动作", source: "第一集写法·分秒", rule: "按秒分段「0-3秒：……」，每段谁、景别、动作、表情。" },
  { id: "shotsize", label: "景别焦段", source: "细节清单第 1 条", rule: "景别（特写 / 近景 / 中景 / 全景 / 远景）+ 焦段（如 50mm 等效）+ 景深（如浅景深、背景虚化）。", preset: "lens" },
  { id: "compose", label: "构图", source: "细节清单第 2 条", rule: "主体在画面哪里（左三分之一 / 居中……），前景、中景、背景各是什么。", preset: "compose" },
  { id: "blocking", label: "站位朝向", source: "细节清单第 3 条", rule: "每个人在画左 / 画右、前后景；朝向（四分之三侧脸 / 背对镜头……）；两人以上写相距多远（一臂、两步、隔着桌子）。" },
  { id: "camera", label: "运镜机位", source: "第一集写法·风格场景（机位）", rule: "机位和运镜：固定、推、拉、跟、仰拍、俯拍……", preset: "camera" },
  { id: "face", label: "每段表情", source: "细节清单第 4 条", rule: "每个出镜角色每个时间段都有看得见的表情或身体小反应；不说话的人也要有。" },
  { id: "hands", label: "左右手", source: "细节清单第 5 条", rule: "手和道具写左手还是右手，全镜不换手。没有手部动作时不适用。" },
  { id: "actionSound", label: "动作声", source: "细节清单第 6 条；v2026-11-11.2 声音", rule: "声音段写看得见的动作有没有声（纸页轻响、椅子轻吱）；重要动作声写成明显的声音，不写「很轻」（v2026-11-11.2，只提示）。静音镜不适用。" },
  { id: "sound", label: "声音段", source: "第一集写法·声音", rule: "单独一行「声音：」，只写房间底噪、对白和动作声。静音镜不适用。" },
  { id: "dialogue", label: "对白语气", source: "第一集写法·对白", rule: "台词只写在「对白（中文普通话，口型同步）：张三（平淡）：“……”」这一行，dialogue 字段留空；语气括号是模板写法，没写只提示。没有台词时不适用。" },
  { id: "dialogueTime", label: "台词时长", source: "细节清单第 7 条；v2026-11-11.2 对白", rule: "说话那一段的秒数 ≥ 台词字数 ÷ 3.5。另提示（v2026-11-11.2，单次结果）：开场没台词那段 ≤1 秒（🧪），最后一句后多留 1～2 秒——时间段卡不住开口时间。没有台词时不适用。" },
  { id: "require", label: "画面要求", source: "第一集写法·画面要求", rule: "单独一行「画面要求：」，整集逐字复用。" },
  { id: "continuity", label: "镜间衔接", source: "细节清单第 8 条", rule: "同一场景相邻两镜，上一镜结束的站位、手里拿的东西（哪只手）就是这一镜开始的站位和手；衣服状态（穿什么、扣没扣、外套在哪）也要接上，只有换衣服那一镜能变（衣服画布不自动查，看对照表）。第一镜、换场景时不适用；首帧接上一镜尾帧算衔接上了。" },
];

export const CATEGORY_BY_ID = Object.fromEntries(PROMPT_CATEGORIES.map((category) => [category.id, category])) as Record<CategoryId, PromptCategory>;

/** 类别表跟的正本版本和正本现在的版本不一样（读不到「未知」时不算）：要按正本改这张表。 */
export function categoryTableStale(current: string | null | undefined) {
  return Boolean(current && current !== "未知" && current !== ZHENGBEN_CATEGORY_VERSION);
}

/** 「复制卡片功能说明」里的类别清单（和上面同一张表）。 */
export function categoryGuideText() {
  return PROMPT_CATEGORIES.map((category, i) => `${i + 1}. ${category.label}：${category.rule}（${category.source}）`).join("\n");
}
