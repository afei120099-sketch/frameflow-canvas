/**
 * 审片标记：出片后给每条视频（按素材 assetId）打问题标签，可以多选；不改队列 JSON。
 *
 * 这里只放纯逻辑（标签表、汇总、按写法统计问题率、生成返修队列和返修说明），不碰浏览器存储；
 * 存储在 lib/review-tags-store.ts（生成记录库 meta 里一行，跟每日备份走）。
 *
 * 每条标记带一份「出片时的写法快照」（正本版本、auto / first-last、有没有首帧、对比实验 A/B），
 * 队列以后再改，统计也不会变。
 */
import type { ShotQueue, ShotQueueShot } from "./shot-queue.ts";
import { queueGeneration } from "./shot-queue.ts";
import { pinRelativeReferences } from "./shot-card-structure.ts";

export const REVIEW_TAGS = [
  { id: "babble", label: "乱说话" },
  { id: "face_swap", label: "换脸" },
  { id: "music", label: "出配乐" },
  { id: "hand", label: "手变形" },
  { id: "action_unfinished", label: "动作没做完" },
  { id: "early_voice", label: "开头冒人声" },
  { id: "blocking", label: "站位不对" },
  { id: "lighting", label: "光线不对" },
  { id: "other", label: "其他" },
] as const;
export type ReviewTagId = typeof REVIEW_TAGS[number]["id"];
export const REVIEW_TAG_LABEL = Object.fromEntries(REVIEW_TAGS.map((tag) => [tag.id, tag.label])) as Record<ReviewTagId, string>;
const TAG_IDS = new Set<string>(REVIEW_TAGS.map((tag) => tag.id));

/** 出片时的写法快照：统计按它分组。 */
export interface ReviewContext {
  /** Run.zhengbenVersion；旧视频没记录写「未记录」。 */
  zhengben: string;
  /** auto（多参考）/ first-last（首尾帧）/ extend */
  mode: string;
  /** 这一镜有没有首帧（firstFrameAssetId 或接别的镜头的帧）。 */
  firstFrame: boolean;
  /** 对比实验镜头：哪一对、A 还是 B、B 改的是哪一段。 */
  experiment?: { base: string; side: "A" | "B"; changed?: string };
}
export interface ReviewEntry {
  assetId: string;
  /** 问题标签；空数组 + ok = 看过、没问题。 */
  tags: ReviewTagId[];
  ok?: boolean;
  /** 一句备注（选了「其他」时最有用，其它标签也可以写）。 */
  note?: string;
  queueTitle: string;
  shotTitle: string;
  /** 卡片上的 A / B / C 那个字母，方便人看。 */
  label?: string;
  context: ReviewContext;
  updatedAt: number;
}
/** assetId → 标记。 */
export type ReviewBook = Record<string, ReviewEntry>;

export const REVIEW_NOTE_MAX = 200;

/** 清理一条输入：只留认识的标签、去重；「没问题」和问题标签互斥（选了问题就不是没问题）。 */
export function normalizeEntry(entry: ReviewEntry): ReviewEntry | null {
  const tags = [...new Set(entry.tags.filter((tag) => TAG_IDS.has(tag)))] as ReviewTagId[];
  const note = entry.note?.trim().slice(0, REVIEW_NOTE_MAX) ?? "";
  const ok = !tags.length && Boolean(entry.ok);
  if (!tags.length && !ok && !note) return null;
  return { ...entry, tags, ok: ok || undefined, note: note || undefined };
}

/** 写入一条（返回新的 book，原来的不改）；清空了就删掉这一条。 */
export function putEntry(book: ReviewBook, entry: ReviewEntry): ReviewBook {
  const next = { ...book };
  const clean = normalizeEntry(entry);
  if (clean) next[entry.assetId] = clean; else delete next[entry.assetId];
  return next;
}

export function isReviewBook(value: unknown): value is ReviewBook {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => entry && typeof entry === "object" && typeof (entry as ReviewEntry).assetId === "string" && Array.isArray((entry as ReviewEntry).tags));
}

export const hasProblem = (entry: ReviewEntry | undefined) => Boolean(entry && entry.tags.length);

/** 出片时的写法快照，从队列里这一镜和 Run 的正本版本号算。 */
export function reviewContext(shot: ShotQueueShot, defaults: ShotQueue["defaults"], zhengben: string | undefined, experiment?: ReviewContext["experiment"]): ReviewContext {
  const option = queueGeneration(shot, defaults);
  return {
    zhengben: zhengben || "未记录",
    mode: option.generationMode,
    firstFrame: Boolean(shot.firstFrameAssetId || shot.firstFrameFrom),
    ...(experiment ? { experiment } : {}),
  };
}

/* ── 整集汇总：问题 → 哪几镜 ── */
export interface ProblemRow { tag: ReviewTagId; label: string; shots: { shotTitle: string; label?: string; note?: string }[] }
/** 只看这份队列的标记（按队列标题 + 镜头标题），每个标签列出哪几镜的哪一条。 */
export function problemsByTag(book: ReviewBook, queueTitle: string, shotTitles?: readonly string[]): ProblemRow[] {
  const wanted = shotTitles ? new Set(shotTitles) : null;
  const order = shotTitles ? new Map(shotTitles.map((title, i) => [title, i])) : null;
  const entries = Object.values(book).filter((entry) => entry.queueTitle === queueTitle && (!wanted || wanted.has(entry.shotTitle)));
  return REVIEW_TAGS.map((tag) => ({
    tag: tag.id, label: tag.label,
    shots: entries.filter((entry) => entry.tags.includes(tag.id))
      .sort((a, b) => (order?.get(a.shotTitle) ?? 0) - (order?.get(b.shotTitle) ?? 0) || (a.label ?? "").localeCompare(b.label ?? ""))
      .map((entry) => ({ shotTitle: entry.shotTitle, label: entry.label, note: entry.note })),
  })).filter((row) => row.shots.length > 0);
}

/* ── 按写法统计问题率 ── */
/** 少于这么多条，就直说「样本少」。 */
export const SMALL_SAMPLE = 5;
export type RateDimension = "zhengben" | "mode" | "firstFrame" | "experiment";
export const RATE_DIMENSION_LABEL: Record<RateDimension, string> = { zhengben: "按正本版本", mode: "按镜头模式", firstFrame: "按有没有首帧", experiment: "按对比实验 A / B" };
const MODE_TEXT: Record<string, string> = { auto: "auto（多参考）", "first-last": "first-last（首尾帧）", extend: "延长" };
export interface RateGroup { key: string; reviewed: number; withProblem: number; rate: number; small: boolean; byTag: Partial<Record<ReviewTagId, number>> }
export interface RateTable { dimension: RateDimension; label: string; groups: RateGroup[] }

function groupKey(entry: ReviewEntry, dimension: RateDimension): string | null {
  const context = entry.context;
  if (dimension === "zhengben") return `正本 ${context.zhengben}`;
  if (dimension === "mode") return MODE_TEXT[context.mode] ?? context.mode;
  if (dimension === "firstFrame") return context.firstFrame ? "有首帧" : "没有首帧";
  return context.experiment ? `${context.experiment.side}${context.experiment.side === "B" && context.experiment.changed ? `（改了${context.experiment.changed}）` : context.experiment.side === "A" ? "（原写法）" : ""}` : null;
}

/**
 * 问题率 = 打了问题标签的条数 ÷ 看过的条数（打了问题标签或标了「没问题」的）。
 * 没看过的视频不算进分母。queueTitle 不传就统计全部队列。
 */
export function problemRates(book: ReviewBook, options: { queueTitle?: string } = {}): RateTable[] {
  const reviewed = Object.values(book).filter((entry) => (entry.tags.length || entry.ok) && (!options.queueTitle || entry.queueTitle === options.queueTitle));
  return (Object.keys(RATE_DIMENSION_LABEL) as RateDimension[]).map((dimension) => {
    const groups = new Map<string, RateGroup>();
    for (const entry of reviewed) {
      const key = groupKey(entry, dimension); if (key === null) continue;
      const group = groups.get(key) ?? { key, reviewed: 0, withProblem: 0, rate: 0, small: true, byTag: {} };
      group.reviewed++;
      if (entry.tags.length) group.withProblem++;
      for (const tag of entry.tags) group.byTag[tag] = (group.byTag[tag] ?? 0) + 1;
      groups.set(key, group);
    }
    const list = [...groups.values()].map((group) => ({ ...group, rate: group.reviewed ? group.withProblem / group.reviewed : 0, small: group.reviewed < SMALL_SAMPLE })).sort((a, b) => a.key.localeCompare(b.key));
    return { dimension, label: RATE_DIMENSION_LABEL[dimension], groups: list };
  }).filter((table) => table.groups.length > 0);
}

export function rateText(group: RateGroup) {
  const percent = Math.round(group.rate * 100);
  const top = (Object.entries(group.byTag) as [ReviewTagId, number][]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag, n]) => `${REVIEW_TAG_LABEL[tag]} ${n}`).join("、");
  return `${group.withProblem}/${group.reviewed} 条有问题（${percent}%）${top ? `：${top}` : ""}${group.small ? ` · 样本少（不到 ${SMALL_SAMPLE} 条），先别下结论` : ""}`;
}

/* ── 一键生成返修队列 ── */
export interface ReworkShotNote { title: string; videos: { label?: string; tags: string[]; note?: string; zhengben: string }[] }
export interface ReworkPlan { queue: ShotQueue; title: string; shots: ReworkShotNote[]; skipped: { title: string; reason: string }[]; note: string }

/**
 * 有问题标签的镜头才收进来（同一镜有一条标了「没问题」的，就算已经有可用的，不收）。
 * 新队列标题加「_返修」，每镜正文一字不改，原队列不动。接别的镜头画面的镜头，来源不在返修队列里的不收，写进说明。
 */
export function planReworkQueue(queue: ShotQueue, book: ReviewBook): ReworkPlan | { error: string } {
  const entries = Object.values(book).filter((entry) => entry.queueTitle === queue.title);
  const pinned = pinRelativeReferences(queue);
  const flat = pinned.chapters.flatMap((chapter) => chapter.shots);
  const pick = new Set(flat.filter((shot) => {
    const mine = entries.filter((entry) => entry.shotTitle === shot.title);
    return mine.some((entry) => entry.tags.length) && !mine.some((entry) => entry.ok);
  }).map((shot) => shot.title));
  const skipped: ReworkPlan["skipped"] = [];
  const dependsOutside = (shot: ShotQueueShot) => [shot.firstFrameFrom?.shot, shot.lastFrameFrom?.shot, shot.sourceShot, ...(shot.timeAnchors ?? []).map((anchor) => anchor.frameFrom?.shot)].filter((title): title is string => Boolean(title) && !pick.has(title!));
  // A chained shot whose source is not reworked can't run alone; drop it (and anything chained to it) until stable.
  for (let changed = true; changed;) {
    changed = false;
    for (const shot of flat) {
      if (!pick.has(shot.title)) continue;
      const outside = dependsOutside(shot);
      if (outside.length) { pick.delete(shot.title); skipped.push({ title: shot.title, reason: `要接「${outside.join("」「")}」的画面，那一镜不在返修队列里。请在原队列里重渲，或先把首帧换成图片` }); changed = true; }
    }
  }
  if (!pick.size) return { error: skipped.length ? `打了问题标签的镜头都要接别的镜头的画面，单独返修跑不了：${skipped.map((item) => item.title).join("、")}` : "这份队列还没有打了问题标签的镜头（标了「没问题」的不算）" };
  let title = `${queue.title}_返修`.slice(0, 80);
  if (title === queue.title) title = `${queue.title.slice(0, 76)}_返修2`;
  const chapters = pinned.chapters.map((chapter) => ({ ...chapter, shots: chapter.shots.filter((shot) => pick.has(shot.title)).map((shot) => { const copy = structuredClone(shot); delete copy.shotId; return copy; }) })).filter((chapter) => chapter.shots.length);
  const next: ShotQueue = { ...structuredClone(pinned), title, chapters };
  const shots: ReworkShotNote[] = flat.filter((shot) => pick.has(shot.title)).map((shot) => ({
    title: shot.title,
    videos: entries.filter((entry) => entry.shotTitle === shot.title && (entry.tags.length || entry.note)).sort((a, b) => (a.label ?? "").localeCompare(b.label ?? "")).map((entry) => ({ label: entry.label, tags: entry.tags.map((tag) => REVIEW_TAG_LABEL[tag]), note: entry.note, zhengben: entry.context.zhengben })),
  }));
  return { queue: next, title, shots, skipped, note: reworkNote(queue.title, title, shots, skipped) };
}

/** 返修说明：交给人或 AI 改提示词用（title 一字不改）。 */
export function reworkNote(fromTitle: string, title: string, shots: ReworkShotNote[], skipped: ReworkPlan["skipped"]) {
  const lines = [
    `# 返修说明：${title}`,
    "",
    `来自队列「${fromTitle}」，共 ${shots.length} 镜。审片时打了下面这些问题标签；返修队列里每镜正文和原队列一字不差，请按标签改提示词（title 一字不改，写法以正本 %FRAMEFLOW_H3_TOOLS%\\SKILL_h3-video.md 为准，改完先跑正本 h3q check）。`,
    "",
  ];
  for (const shot of shots) {
    lines.push(`## ${shot.title}`);
    for (const video of shot.videos) lines.push(`- 视频 ${video.label ?? "?"}（正本 ${video.zhengben}）：${video.tags.length ? video.tags.join("、") : "没打标签"}${video.note ? `。备注：${video.note}` : ""}`);
    lines.push("");
  }
  if (skipped.length) {
    lines.push("## 没收进返修队列的");
    for (const item of skipped) lines.push(`- ${item.title}：${item.reason}`);
    lines.push("");
  }
  return lines.join("\n");
}
