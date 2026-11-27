/**
 * 对比实验：复制一镜成 A / B 两条，B 只改一段（按卡片现有的分段），两条用同一个种子，一起入队。
 *
 * - 原镜种子是 random（或没写、跟队列默认 random）时，先定一个具体种子，A / B 都用它；原镜本身不动。
 * - 队列还没入队过：A / B 插在原镜下面（照常进撤销 / 恢复）。
 * - 队列已经入队过（不能原地改）：另建一份只有 A / B 的小队列「原标题_对比」，载入卡片（「JSON / 进度」抽屉）。
 *   这时要接别的镜头画面的镜头做不了（来源不在小队列里），直接说清楚。
 * 标题：「原标题·对比A」「原标题·对比B」；同一镜做第二次是「·对比2A」「·对比2B」。
 */
import type { ShotQueue, ShotQueueShot } from "./shot-queue.ts";
import { queueGeneration } from "./shot-queue.ts";
import { promptSegments, replaceSegments } from "./shot-card-breakdown.ts";
import { pinRelativeReferences } from "./shot-card-structure.ts";
import { episodeSegments } from "./episode-settings.ts";

const PAIR = /^(.*)·对比(\d*)([AB])$/;
/** "L03·对比2B" → { base: "L03", run: "2", side: "B", key: "L03·对比2" }. */
export function experimentPair(title: string) {
  const match = PAIR.exec(title);
  return match ? { base: match[1], run: match[2], side: match[3] as "A" | "B", key: `${match[1]}·对比${match[2]}`, other: `${match[1]}·对比${match[2]}${match[3] === "A" ? "B" : "A"}` } : null;
}

export interface ExperimentSegment { index: number; label: string; text: string }
/**
 * 正本写法里风格、机位景别、光线这几行没有「xx：」标签，卡片分段叫它「正文」；这里按内容起个看得懂的名字
 * （一行里两样都有就都写上），只用于显示，分段本身和「编辑这一镜」完全一样。
 */
const GUESS: [string, RegExp][] = [["风格", /胶片|颗粒|质感|电影感|写实|Kodak|色彩|色调/i], ["机位景别", /机位|景别|特写|近景|中景|全景|远景|仰拍|俯拍|平视|\d+\s*mm|焦段|景深|运镜|推镜|拉镜|跟拍/i], ["光线", /光|灯|阴影|逆光|日光|月色/]];
function segmentLabel(label: string, text: string) {
  if (label !== "正文") return label;
  const found = GUESS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return found.length ? found.join(" · ") : "正文";
}
/** 可以改的段：就是卡片「编辑这一镜」里的分段。 */
export const experimentSegments = (prompt: string): ExperimentSegment[] => promptSegments(prompt).map((segment, index) => ({ index, label: segmentLabel(segment.label, segment.text), text: segment.text }));

/**
 * 这一段里有没有来自「本集设定」的句子（镜头正文里写的是 {{本集.xx}} 占位）。有就返回设定项名，如 ["光线.办公室"]。
 * 对比实验只改 B 这一镜：B 里被改的那句脱离本集设定，A 和其他镜头继续跟着本集设定走，本集设定本身不动。
 */
export function segmentEpisodeKeys(queue: ShotQueue, shot: ShotQueueShot, segmentText: string): string[] {
  const keys = episodeSegments(shot.promptTemplate, queue.episode, shot.prompt).filter((piece) => piece.key && piece.text && segmentText.includes(piece.text)).map((piece) => piece.key as string);
  return [...new Set(keys)];
}

/** 0 … 2^32-1, the same range 渲染这一镜 draws for a random seed. */
export const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

export interface ExperimentPlan {
  queue: ShotQueue; titles: { a: string; b: string }; seed: number; seedWasRandom: boolean;
  changed: { label: string; before: string; after: string };
  /** "insert" = A / B 插在原镜下面；"new" = 另建小队列。 */
  where: "insert" | "new";
}

const usedTitles = (queue: ShotQueue) => new Set(queue.chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.title)));
function pairTitles(base: string, taken: ReadonlySet<string>) {
  const cut = base.slice(0, 74);
  for (let n = 1; ; n++) {
    const run = n === 1 ? "" : String(n);
    const a = `${cut}·对比${run}A`, b = `${cut}·对比${run}B`;
    if (!taken.has(a) && !taken.has(b)) return { a, b };
  }
}

/**
 * B 的这一段换成 newText；其余一字不差。seed 只在原镜是 random 时用（传进来方便测试）。
 * newQueue = true：另建小队列（队列已入队过时用）。
 */
export function planExperiment(queue: ShotQueue, chapter: number, index: number, segmentIndex: number, newText: string, options: { newQueue?: boolean; seed?: number } = {}): ExperimentPlan | { error: string } {
  const pinned = pinRelativeReferences(queue);
  const original = pinned.chapters[chapter]?.shots[index];
  if (!original) return { error: "找不到这一镜" };
  const segments = promptSegments(original.prompt);
  const segment = segments[segmentIndex];
  if (!segment) return { error: "找不到要改的那一段" };
  const label = segmentLabel(segment.label, segment.text);
  const after = newText.trim();
  if (!after) return { error: "改后的这一段是空的；要删掉这一段请用「编辑这一镜」" };
  if (after === segment.text.trim()) return { error: "这一段没有改动，A / B 会一模一样" };
  if (options.newQueue) {
    const chained = [original.firstFrameFrom?.shot, original.lastFrameFrom?.shot, original.sourceShot, ...(original.timeAnchors ?? []).map((anchor) => anchor.frameFrom?.shot)].filter(Boolean);
    if (chained.length) return { error: `这一镜要接「${chained.join("」「")}」的画面，单独做对比实验跑不了。请先在还没入队的队列里做，或先把首帧换成一张图片` };
  }
  const option = queueGeneration(original, queue.defaults);
  const seedWasRandom = option.seed === "random";
  const seed = seedWasRandom ? options.seed ?? randomSeed() : option.seed as number;
  let promptB: string;
  try { promptB = replaceSegments(original.prompt, segments, segments.map((item, i) => i === segmentIndex ? after : item.text)); }
  catch (cause) { return { error: cause instanceof Error ? cause.message : "提示词分段对不上" }; }
  const copy = (title: string, prompt: string): ShotQueueShot => { const shot = structuredClone(original); shot.title = title; shot.prompt = prompt; shot.seed = seed; delete shot.shotId; delete shot.autoVoiceAssigned; return shot; };
  const changed = { label, before: segment.text, after };
  if (options.newQueue) {
    const titles = pairTitles(original.title, new Set());
    let title = `${queue.title}_对比`.slice(0, 80);
    if (title === queue.title) title = `${queue.title.slice(0, 76)}_对比2`;
    const chapterTitle = (pinned.chapters[chapter].title || "对比实验").slice(0, 80);
    return { queue: { ...structuredClone(pinned), title, chapters: [{ title: chapterTitle, shots: [copy(titles.a, original.prompt), copy(titles.b, promptB)] }] }, titles, seed, seedWasRandom, changed, where: "new" };
  }
  const titles = pairTitles(original.title, usedTitles(queue));
  const shots = [...pinned.chapters[chapter].shots];
  shots.splice(index + 1, 0, copy(titles.a, original.prompt), copy(titles.b, promptB));
  return { queue: { ...pinned, chapters: pinned.chapters.map((item, c) => c === chapter ? { ...item, shots } : item) }, titles, seed, seedWasRandom, changed, where: "insert" };
}

/** A / B 两条提示词里不一样的那一段（按分段比），给并排对比时显示「B 改了：光线」。 */
export function experimentDiff(promptA: string, promptB: string): { label: string; a: string; b: string }[] {
  const a = experimentSegments(promptA), b = experimentSegments(promptB);
  const out: { label: string; a: string; b: string }[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i]?.text !== b[i]?.text) out.push({ label: a[i]?.label ?? b[i]?.label ?? `第 ${i + 1} 段`, a: a[i]?.text ?? "", b: b[i]?.text ?? "" });
  return out;
}

/** 审片标记的写法快照用：这一镜是不是对比实验的 A / B，B 改的是哪一段。 */
export function experimentContext(queue: ShotQueue, title: string): { base: string; side: "A" | "B"; changed?: string } | undefined {
  const pair = experimentPair(title);
  if (!pair) return undefined;
  const shots = queue.chapters.flatMap((chapter) => chapter.shots);
  const me = shots.find((shot) => shot.title === title), other = shots.find((shot) => shot.title === pair.other);
  const diff = me && other ? experimentDiff(pair.side === "A" ? me.prompt : other.prompt, pair.side === "A" ? other.prompt : me.prompt) : [];
  return { base: pair.base, side: pair.side, ...(diff.length ? { changed: diff.map((item) => item.label).join("、") } : {}) };
}
