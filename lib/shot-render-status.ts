/**
 * 镜头卡片「视频」格的渲染状态：渲染中 · 已 N 秒 / 排队中 · 第 N 位。
 *
 * 数据只从已有的地方拿，不另起高频轮询：
 * - 本队列每镜的 Run（use-shot-queue-execution 每 2 秒读一次本地记录）：状态、prompt_id、开始时间；
 * - ComfyUI GET /queue（经 h3-adapter 的共享缓存，最多每 3 秒问一次；失败保留上一次）；
 * - 节点自己从 ComfyUI 进度消息里收到的第几步 / 百分比、execution_start 的时间戳。
 * 开始时间：ComfyUI 给的时间戳算准；只有画布看到它开始的时间就标「约」。拿不到第几步就不显示，不编。
 */
import { formatEstimate, type Estimate } from "./shot-time-estimate.ts";

/** 本队列一镜的 Run（只在 queued / running 时给）。 */
export type RenderRun = {
  status: "queued" | "running";
  promptId: string | null;
  createdAt: number;
  /** Run.startedAt：画布看到它开始的时间，或 ComfyUI execution_start 的时间戳 */
  startedAt: number | null;
  /** startedAt 来自 ComfyUI 自己的时间戳 */
  startedExact?: boolean;
  nodeId?: string;
  /** 卡片用：哪一镜（队列里的标题）、提交的工作流保存节点（找采样器节点听进度） */
  title?: string;
  saveNodeId?: string;
};
/** 节点自己收到的进度（ComfyUI 进度消息）。只在节点正在跑这一镜时有。 */
export type LiveProgress = { percent?: number; step?: number; steps?: number; startedAt?: number };
/** ComfyUI /queue：running 里的 prompt_id，pending 按执行顺序排好。 */
export type QueueSnapshot = { running: string[]; pending: string[] };

export type RenderStatus =
  | { kind: "running"; startedAt: number | null; approx: boolean; nodeId?: string }
  | { kind: "queued"; position: number | null; ahead: number | null; foreignAhead: number; wait: Estimate | null };

const ids = (items: unknown) => Array.isArray(items) ? items : [];
/** ComfyUI /queue 原样 → 按执行顺序。pending 每项是 [号码, prompt_id, …]，号码小的先跑（插队的是负数）。 */
export function parseQueueSnapshot(raw: { queue_running?: unknown[]; queue_pending?: unknown[] } | null | undefined): QueueSnapshot {
  const pick = (item: unknown) => Array.isArray(item) && typeof item[1] === "string" ? { number: Number(item[0]), id: item[1] } : null;
  const running = ids(raw?.queue_running).map(pick).flatMap((item) => item ? [item.id] : []);
  const pending = ids(raw?.queue_pending).map(pick).flatMap((item) => item ? [item] : [])
    .map((item, order) => ({ ...item, order }))
    .sort((a, b) => (Number.isFinite(a.number) && Number.isFinite(b.number) ? a.number - b.number : 0) || a.order - b.order)
    .map((item) => item.id);
  return { running, pending };
}

/** 一个看起来像真时间戳（毫秒）的数：不早于 2020 年，不比现在晚一分钟以上。 */
export function plausibleTimestamp(value: unknown, now = Date.now()): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 1_577_836_800_000 && value < now + 60_000;
}

/**
 * 一镜现在的状态。没在 ComfyUI 里（还没入队、出完、失败、待确认）返回 null，卡片照旧。
 * @param others 本队列其他镜头的 Run（算前面还有几条是本队列的、估算要等多久）
 * @param estimateOf 一镜的「预计」估算（秒）
 * @param seenRunningAt 卡片第一次看到某个 prompt_id 在跑的时间（Run 里没有开始时间时用，标「约」）
 */
export function renderStatusOf(run: RenderRun | undefined, opts: {
  snapshot: QueueSnapshot | null; live?: LiveProgress | null; others?: RenderRun[]; now: number;
  /** 这份 /queue 是什么时候读到的；stale = 之后读失败了，保留的是旧的 */
  snapshotAt?: number; snapshotStale?: boolean;
  estimateOf?: (run: RenderRun) => Estimate | null; seenRunningAt?: (promptId: string) => number | undefined;
}): RenderStatus | null {
  if (!run) return null;
  const { snapshot, live, now } = opts;
  const id = run.promptId;
  let state: "running" | "queued" = run.status;
  let index = -1;
  if (snapshot && id) {
    if (snapshot.running.includes(id)) state = "running";
    else if ((index = snapshot.pending.indexOf(id)) >= 0) state = "queued";
    // ComfyUI 刚读到的队列里已经没有它（出完了、没了），而它在那次读取之前就提交了：不再说「渲染中」，等记录落定。
    else if (opts.snapshotAt !== undefined && !opts.snapshotStale && run.createdAt < opts.snapshotAt - 1000) return null;
  }
  if (state === "running") {
    if (plausibleTimestamp(live?.startedAt, now)) return { kind: "running", startedAt: live!.startedAt!, approx: false, nodeId: run.nodeId };
    if (run.startedAt !== null && plausibleTimestamp(run.startedAt, now)) return { kind: "running", startedAt: run.startedAt, approx: !run.startedExact, nodeId: run.nodeId };
    const seen = id ? opts.seenRunningAt?.(id) : undefined;
    return { kind: "running", startedAt: seen ?? null, approx: true, nodeId: run.nodeId };
  }
  if (!snapshot || !id || index < 0) return { kind: "queued", position: null, ahead: null, foreignAhead: 0, wait: null };
  const before = [...snapshot.running, ...snapshot.pending.slice(0, index)];
  const mine = new Map((opts.others ?? []).flatMap((other) => other.promptId ? [[other.promptId, other] as const] : []));
  const foreignAhead = before.filter((other) => !mine.has(other)).length;
  // 等待时间：前面全是本队列的、每条都有估算才算；正在跑的那条扣掉已经跑了的时间。
  let wait: Estimate | null = null;
  if (!foreignAhead && opts.estimateOf) {
    wait = { min: 0, max: 0 };
    for (const other of before) {
      const ahead = mine.get(other)!;
      const one = opts.estimateOf(ahead);
      if (!one) { wait = null; break; }
      const running = snapshot.running.includes(other);
      const started = running ? (ahead.startedAt ?? (other ? opts.seenRunningAt?.(other) : undefined)) : undefined;
      const spent = started !== undefined && plausibleTimestamp(started, now) ? Math.max(0, (now - started) / 1000) : 0;
      wait = { min: wait.min + Math.max(0, one.min - spent), max: wait.max + Math.max(0, one.max - spent) };
    }
  }
  return { kind: "queued", position: index + 1, ahead: before.length, foreignAhead, wait };
}

/** 「42 秒」「2 分 05 秒」 */
export function formatSeconds(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

/** 渲染中的两行字。now 由卡片每秒刷新。 */
export function runningText(status: Extract<RenderStatus, { kind: "running" }>, now: number, live?: LiveProgress | null) {
  const time = status.startedAt === null ? "刚开始" : `已${status.approx ? "约" : ""} ${formatSeconds((now - status.startedAt) / 1000)}`;
  const step = live && Number.isInteger(live.step) && Number.isInteger(live.steps) && live.steps! > 0 && live.step! >= 0 && live.step! <= live.steps!
    ? `第 ${live.step}/${live.steps} 步`
    : live && typeof live.percent === "number" && Number.isFinite(live.percent) ? `${Math.round(Math.min(100, Math.max(0, live.percent)))}%` : "";
  const percent = live && typeof live.percent === "number" && Number.isFinite(live.percent) ? Math.min(100, Math.max(0, live.percent)) : null;
  return {
    head: `渲染中 · ${time}`,
    step,
    percent,
    title: status.startedAt === null ? "ComfyUI 正在跑这一镜，还没拿到开始时间"
      : status.approx ? "「约」：ComfyUI 没给开始时间，这是画布看到它开始跑的时间，可能晚几秒" : "从 ComfyUI 开始执行这一镜算起",
  };
}

/** 排队中的两行字。 */
export function queuedText(status: Extract<RenderStatus, { kind: "queued" }>) {
  if (status.position === null) return { head: "排队中", sub: "", title: "已经交给 ComfyUI，还没轮到；ComfyUI 队列暂时没读到，先不显示第几位" };
  const ahead = status.ahead ?? 0;
  const parts = [ahead ? `前面还有 ${ahead} 条` : "下一条就是它"];
  if (status.foreignAhead) parts.push(`其中 ${status.foreignAhead} 条不是这份队列的`);
  if (status.wait && status.wait.max > 0) parts.push(`${formatEstimate(status.wait).replace(/^约 /, "约等 ")}（估算）`);
  return {
    head: `排队中 · 第 ${status.position} 位`,
    sub: parts.join(" · "),
    title: status.foreignAhead ? "前面有画布外直接交给 ComfyUI 的任务，算不出要等多久，只写第几位" : "等待时间按卡片顶栏「预计」那套估算：10 步约 140 秒一镜，理解优先 211–321 秒；不含换模型和后处理",
  };
}

/**
 * ComfyUI /queue 读取：最多每 intervalMs 问一次（走 adapter 的共享缓存）。
 * 读失败（显卡满负荷、ComfyUI 卡住）安静地保留上一次，不报错。
 */
export function createQueueWatch({ read, onSnapshot, intervalMs = 3000, setTimer = setTimeout, clearTimer = clearTimeout }: {
  read: () => Promise<{ queue_running?: unknown[]; queue_pending?: unknown[] }>;
  onSnapshot: (snapshot: QueueSnapshot, meta: { stale: boolean; at: number }) => void;
  intervalMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (handle: never) => void;
}) {
  let last: QueueSnapshot | null = null, lastKey = "", at = 0, stale = false, active = true, handle: unknown = null;
  const tick = async () => {
    try {
      const next = parseQueueSnapshot(await read());
      const key = JSON.stringify(next);
      if (!active) return;
      at = Date.now();
      if (key !== lastKey || stale) { last = next; lastKey = key; stale = false; onSnapshot(next, { stale: false, at }); }
    } catch {
      // 保留上一次；只记一下「旧的」，界面不弹错误。
      if (active && last && !stale) { stale = true; onSnapshot(last, { stale: true, at }); }
    }
    if (active) handle = setTimer(() => void tick(), intervalMs);
  };
  void tick();
  return {
    stop() { active = false; if (handle !== null) clearTimer(handle as never); },
    get last() { return last; },
    get stale() { return stale; },
  };
}
