/**
 * 镜头卡片「复制给 AI 修改」：把卡片查出来的问题写成一段能直接贴给 AI 的中文。
 * 纯函数；类别「怎样才算写到」一律取 lib/zhengben-categories.ts 的 rule，不另编。
 * 不附队列 JSON（太长），只提醒用卡片「导出 JSON」。
 */
import { CATEGORY_BY_ID, type CategoryId } from "./zhengben-categories.ts";
import type { H3qItem } from "./h3q-report.ts";

/** 提示词规则工具包随仓库放在 h3-tools/，也可用环境变量 FRAMEFLOW_H3_TOOLS 指到别处。 */
export const ZHENGBEN_PATH = "%FRAMEFLOW_H3_TOOLS%\\SKILL_h3-video.md";
/** 正本 v2026-11-13 起写法：MiniMax 官方 Ref2VA 六段式；细则 h3q get 提示词 官方格式，范本两份。 */
export const OFFICIAL_GUIDE = "python -I \"%FRAMEFLOW_H3_TOOLS%\\h3q.py\" get 提示词 官方格式";
export const OFFICIAL_SAMPLES = ["%FRAMEFLOW_H3_TOOLS%\\范本\\官方格式_示例_O1O2\\", "%FRAMEFLOW_H3_TOOLS%\\范本\\示例项目_EP02v5_L03_官方格式\\"] as const;

export interface AiCopyShot {
  /** 镜号（卡片左上角那个） */
  code: string;
  /** 完整标题，原样 */
  title: string;
  /** 所在章节标题 */
  chapter: string;
  /** 提示词完整度里漏写的类别（画面五项也在里面也没关系，会归到「必改」） */
  missing: CategoryId[];
  /** 这一镜的正本 h3q 原文；h3q 没用上时为空 */
  h3q: H3qItem[];
  /** 画布自己的检查（正本 h3q 查不到的：参考图、素材、时间轴……），已去掉用户忽略的 */
  canvas: { level: "error" | "warn"; message: string }[];
  /** 画面五项不过的项 */
  gate: { id?: CategoryId; label: string; note?: string }[];
  /** 用户「我确认没问题」放行的理由（放行了才有） */
  confirmed?: string;
  /** 画布程序体检（只是提醒；已去掉和 h3q / 卡片重复的，见 lib/shot-card-health.ts） */
  health?: string[];
  /** ID / 参考图问题的改法（lib/shot-card-ref-help.ts）：json = 队列写错了，canvas = 画布里缺东西 */
  idFixes?: { owner: "json" | "canvas"; fix: string }[];
  /** 正文是官方 Ref2VA 六段式（lib/official-format.ts） */
  official?: boolean;
  /** 官方格式里认出的台词，一句一行「S1 <Subject 4> 王五：又绕回原样了？」 */
  lines?: string[];
}

export interface AiCopyInput {
  queueTitle: string;
  chapters: string[];
  /** 正本当前版本（h3q 那次读到的）；读不到写「未知」 */
  zhengbenVersion?: string;
  /** 这次复制的范围，写进开头一句，例如「提示词完整度有漏写的镜头」 */
  scope: string;
  shots: AiCopyShot[];
  /** h3q 报的、不属于某一镜的条目（一致性、对照表……） */
  general?: H3qItem[];
}

const hasProblem = (shot: AiCopyShot) => shot.missing.length > 0 || shot.h3q.length > 0 || shot.canvas.length > 0 || shot.gate.length > 0 || (shot.health?.length ?? 0) > 0 || (shot.idFixes?.length ?? 0) > 0;
const isDuration = (item: H3qItem) => item.message.trim().startsWith("[时长]");
const ruleOf = (id: CategoryId) => CATEGORY_BY_ID[id]?.rule ?? "";

function shotBlock(shot: AiCopyShot): string {
  const lines = [`【${shot.code}】${shot.title}${shot.chapter ? `（章节：${shot.chapter}）` : ""}${shot.official === undefined ? "" : shot.official ? "（官方格式）" : "（旧格式：第一集中文写法，正本已停用，要改成官方格式）"}`];
  if (shot.lines?.length) { lines.push("卡片认出的台词（说话人编号 / Subject / 原话；改的时候台词原话不变）："); for (const line of shot.lines) lines.push(`- ${line}`); }
  if (shot.confirmed) lines.push(`※ 用户已确认放行，可以不改（理由：${shot.confirmed}）。`);
  const gateIds = new Set(shot.gate.flatMap((item) => item.id ? [item.id] : []));
  if (shot.gate.length) {
    lines.push(shot.confirmed ? "画面五项不过（用户已确认放行）：" : "画面五项不过（必改，不改不能入队）：");
    for (const item of shot.gate) { const rule = item.id ? ruleOf(item.id) : ""; lines.push(`- ${item.label}${rule ? `：${rule}` : ""}${item.note ? `（检查说：${item.note}）` : ""}`); }
  }
  const jsonFixes = (shot.idFixes ?? []).filter((item) => item.owner === "json");
  if (jsonFixes.length) {
    lines.push("ID 字段写错了（这是 JSON 的问题，必改：不改这一镜排不出参考图、不能渲染）：");
    for (const item of jsonFixes) lines.push(`- ${item.fix}`);
  }
  const canvasFixes = (shot.idFixes ?? []).filter((item) => item.owner === "canvas");
  if (canvasFixes.length) {
    lines.push("画布里缺的（这是画布的问题：请告诉用户在画布里补；除非写明，不用改 JSON）：");
    for (const item of canvasFixes) lines.push(`- ${item.fix}`);
  }
  const missing = shot.missing.filter((id) => !gateIds.has(id));
  if (missing.length) {
    lines.push("漏写（按正本的类别，怎样才算写到）：");
    for (const id of missing) lines.push(`- ${CATEGORY_BY_ID[id]?.label ?? id}：${ruleOf(id)}`);
  }
  const h3q = shot.h3q.filter((item) => !isDuration(item));
  if (h3q.length) {
    lines.push("正本 h3q 原文：");
    for (const item of h3q) lines.push(`- ${item.level} ${item.where ? `${item.where}：` : ""}${item.message}`);
  }
  const duration = shot.h3q.filter(isDuration);
  if (duration.length) {
    lines.push("时长（正本 h3q，只是提醒；秒数由用户在卡片里点「改成 N 秒」改，你不用改 seconds；要保留秒数就按原话把空着的时间段补成有内容的）：");
    for (const item of duration) lines.push(`- ${item.message}`);
  }
  if (shot.canvas.length) {
    lines.push("画布检查（正本 h3q 查不到的）：");
    for (const item of shot.canvas) lines.push(`- ${item.level === "error" ? "写错" : "漏写"}：${item.message}`);
  }
  if (shot.health?.length) {
    lines.push("画布程序体检（只是提醒，和正本冲突时听正本）：");
    for (const message of shot.health) lines.push(`- ${message}`);
  }
  return lines.join("\n");
}

/** 生成要复制的文字。count = 列出了几镜（0 = 没有问题）。 */
export function aiFixText(input: AiCopyInput): { text: string; count: number } {
  const shots = input.shots.filter(hasProblem);
  const general = input.general ?? [];
  const version = input.zhengbenVersion || "未知";
  if (!shots.length && !general.length) return { count: 0, text: `「${input.queueTitle}」${input.scope}：没有问题，不用改。（正本 ${version}）` };
  const mustFix = shots.filter((shot) => shot.gate.length && !shot.confirmed).length;
  const head = [
    `下面是 Frameflow 镜头卡片查出的问题，请帮我改提示词。`,
    `队列：「${input.queueTitle}」${input.chapters.length ? `，章节：${input.chapters.join("、")}` : ""}。范围：${input.scope}，共 ${shots.length} 镜${mustFix ? `，其中 ${mustFix} 镜画面五项不过，必改` : ""}。`,
    `正本：${ZHENGBEN_PATH}（当前版本 ${version}）。`,
    `要求：`,
    `1. 先读正本里的官方格式写法（运行 ${OFFICIAL_GUIDE}），照范本 ${OFFICIAL_SAMPLES.join(" 和 ")} 写成 MiniMax 官方 Ref2VA 六段式（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music，英文；台词写成 <d>[Chinese] 原话</d>，前面标 <Subject N> 和说话人编号 S1、S2；不要配乐 non_diegetic_music 写 N/A；dialogue 留空）。标「旧格式」的镜头整镜改成官方格式，剧情、台词、人物、参考图、秒数不变。不要自己发明写法。`,
    `2. 只改提示词正文（prompt）和下面明确写了「ID 字段写错了」的 roleIds / sceneAssetIds，其他字段不动；镜头 title 一字不改（卡片、视频、审片记录都靠 title 对应）。`,
    `3. 改完用 h3q check 再查一遍，ERROR 和 WARN 清零（官方格式的检查前缀是 [官方·…]；旧格式会多一条 [旧格式]）。画布对官方格式原样提交，不会往正文里加任何句子。`,
    `4. 标「用户已确认放行，可以不改」的镜头，可以不改。`,
    `完整队列请用卡片「导出 JSON」。`,
  ].join("\n");
  const blocks = shots.map(shotBlock);
  if (general.length) blocks.push(["整集的 h3q 条目（不属于某一镜）：", ...general.map((item) => `- ${item.level} ${item.where ? `${item.where}：` : ""}${item.message}`)].join("\n"));
  return { count: shots.length, text: `${head}\n\n${blocks.join("\n\n")}\n` };
}
