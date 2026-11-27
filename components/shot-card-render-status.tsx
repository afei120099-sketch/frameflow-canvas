"use client";
/**
 * 镜头卡片「视频」格：渲染中 · 已 N 秒 / 排队中 · 第 N 位（算法在 lib/shot-render-status.ts）。
 *
 * 只读、不提交：本地 Run 记录每 2 秒读一次；ComfyUI /queue 只在有镜头在排队 / 在跑时问，最多每 3 秒一次，
 * 走 h3-adapter 的共享缓存（节点自己的状态查询也读它，不会多打一份）；读失败安静地保留上一次。
 * 秒数靠本地每秒的计时器走。第几步来自 ComfyUI 进度消息（只听，不发请求），拿不到就不显示。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { listRuns } from "@/lib/production-records";
import { comfyUIH3Adapter } from "@/lib/comfyui/h3-adapter";
import { shotEstimate } from "@/lib/shot-time-estimate";
import type { ShotQueue } from "@/lib/shot-queue";
import { createQueueWatch, plausibleTimestamp, queuedText, renderStatusOf, runningText, type LiveProgress, type QueueSnapshot, type RenderRun, type RenderStatus } from "@/lib/shot-render-status";

type PageShots = () => { nodeId: string; title: string }[];
export type RenderInfo = { status: RenderStatus; live: () => LiveProgress | null };

const sameRuns = (a: RenderRun[], b: RenderRun[]) => a.length === b.length && a.every((run, i) => { const o = b[i]; return o.promptId === run.promptId && o.status === run.status && o.startedAt === run.startedAt && o.title === run.title; });

/** 每镜（按标题）现在的渲染状态；没有在 ComfyUI 里的镜头不在表里。 */
export function useRenderStatuses(queue: ShotQueue, pageShots: PageShots | undefined): Map<string, RenderInfo> {
  const [runs, setRuns] = useState<RenderRun[]>([]);
  const [snap, setSnap] = useState<{ snapshot: QueueSnapshot; at: number; stale: boolean } | null>(null);
  const live = useRef(new Map<string, LiveProgress>());
  const seen = useRef(new Map<string, number>());
  const titles = useMemo(() => new Set(queue.chapters.flatMap((chapter) => chapter.shots.map((shot) => shot.title))), [queue]);
  const shotsRef = useRef(pageShots); shotsRef.current = pageShots;
  const hasCanvas = Boolean(pageShots);

  // 本地 Run 记录：这一页上为队列镜头建的节点，正在排队 / 在跑的那条（提交结果待确认的不算，卡片照旧）。
  useEffect(() => {
    if (!hasCanvas) return;
    let active = true, timer = 0;
    const tick = async () => {
      try {
        const nodes = shotsRef.current?.() ?? [];
        const titleOf = new Map(nodes.filter((node) => titles.has(node.title)).map((node) => [node.nodeId, node.title]));
        const all = await listRuns();
        const latest = new Map<string, RenderRun>();
        for (const run of all) {
          const title = run.ownerNodeId ? titleOf.get(run.ownerNodeId) : undefined;
          if (!title || (run.status !== "queued" && run.status !== "running") || run.submission === "reserved" || !run.comfyPromptId) continue;
          const prior = latest.get(title);
          if (prior && prior.createdAt >= run.createdAt) continue;
          latest.set(title, { status: run.status, promptId: run.comfyPromptId, createdAt: run.acceptedAt ?? run.createdAt, startedAt: run.startedAt, startedExact: run.executionTiming?.source === "history" && run.executionTiming.startedAt === run.startedAt, nodeId: run.ownerNodeId, title, saveNodeId: run.submissionSnapshot?.saveNodeId });
        }
        const next = [...latest.values()].sort((a, b) => a.createdAt - b.createdAt);
        if (active) setRuns((current) => sameRuns(current, next) ? current : next);
      } catch { /* 本地记录一时读不到：保留上一次 */ }
      if (active) timer = window.setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { active = false; window.clearTimeout(timer); };
  }, [hasCanvas, titles]);

  // ComfyUI /queue：只在有镜头在排队 / 在跑时问。
  const watching = runs.length > 0;
  useEffect(() => {
    if (!watching) { setSnap(null); return; }
    const watch = createQueueWatch({ read: () => comfyUIH3Adapter.queueSnapshot(), intervalMs: 3000, onSnapshot: (snapshot, meta) => setSnap({ snapshot, at: meta.at, stale: meta.stale }) });
    return () => watch.stop();
  }, [watching]);

  // 进度消息：每个排队 / 在跑的镜头听一份（只听，不发请求）。
  const promptKey = runs.map((run) => `${run.promptId}:${run.saveNodeId ?? ""}`).join("|");
  useEffect(() => {
    const offs = runs.flatMap((run) => run.promptId ? [comfyUIH3Adapter.watchProgress(run.promptId, run.saveNodeId, (update) => {
      const id = run.promptId!;
      const prior = live.current.get(id) ?? {};
      const next: LiveProgress = { ...prior };
      if (plausibleTimestamp(update.startedAt)) next.startedAt = update.startedAt;
      if (typeof update.percent === "number") next.percent = update.percent;
      if (update.step !== undefined && update.steps !== undefined) { next.step = update.step; next.steps = update.steps; }
      if (["loading", "running", "decoding"].includes(update.status)) seen.current.set(id, seen.current.get(id) ?? Date.now());
      live.current.set(id, next);
    })] : []);
    return () => { offs.forEach((off) => off()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptKey]);

  return useMemo(() => {
    const now = Date.now();
    const shotOf = new Map(queue.chapters.flatMap((chapter) => chapter.shots.map((shot) => [shot.title, shot] as const)));
    const estimateOf = (run: RenderRun) => { const shot = run.title ? shotOf.get(run.title) : undefined; return shot ? shotEstimate(shot, queue.defaults) : null; };
    // ComfyUI 说在跑、Run 里还没有开始时间：记下卡片第一次看到的时间（标「约」）。
    for (const id of snap?.snapshot.running ?? []) if (!seen.current.has(id)) seen.current.set(id, now);
    const result = new Map<string, RenderInfo>();
    for (const run of runs) {
      const liveOf = () => (run.promptId ? live.current.get(run.promptId) : undefined) ?? null;
      const status = renderStatusOf(run, { snapshot: snap?.snapshot ?? null, snapshotAt: snap?.at, snapshotStale: snap?.stale, live: liveOf(), others: runs, now, estimateOf, seenRunningAt: (id) => seen.current.get(id) });
      if (status) result.set(run.title!, { status, live: liveOf });
    }
    return result;
  }, [runs, snap, queue]);
}

/** 每秒刷新一次（只在渲染中的格子里）。 */
function useSecondClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** 视频格里的状态：没出片时整格显示，已有视频（重渲中）时在视频上面一条细条。 */
export function RenderStatusTile({ info, aspect, compact = false }: { info: RenderInfo; aspect?: string; compact?: boolean }) {
  const running = info.status.kind === "running";
  const now = useSecondClock(running);
  const live = running ? info.live() : null;
  // 进度消息里有 ComfyUI 自己的开始时间就用它（不标「约」）。
  const status = info.status.kind === "running" && plausibleTimestamp(live?.startedAt, now) ? { ...info.status, startedAt: live!.startedAt!, approx: false } : info.status;
  const text = status.kind === "running" ? runningText(status, now, live) : null;
  const queued = info.status.kind === "queued" ? queuedText(info.status) : null;
  const head = text?.head ?? queued!.head;
  const sub = text ? text.step : queued!.sub;
  const title = text?.title ?? queued!.title;
  return <div className={`sc-video empty sc-render ${running ? "running" : "queued"} ${compact ? "compact" : ""}`} style={compact || !aspect ? undefined : { aspectRatio: aspect.replace(":", "/") }} title={title} role="status" aria-live="off">
    <span className="sc-render-head">{running ? <i className="sc-render-dot" aria-hidden="true" /> : null}{compact ? `新的一条 · ${head}` : head}</span>
    {sub && <small className="sc-render-sub">{sub}</small>}
    {running && <span className={`sc-render-bar ${text?.percent === null ? "indeterminate" : ""}`} aria-hidden="true"><i style={text?.percent === null ? undefined : { width: `${text!.percent}%` }} /></span>}
  </div>;
}

/** 黑白灰；渲染中只有一个呼吸点和一根 2px 的细进度条。 */
export const RENDER_STATUS_STYLE = `
.sc-root .sc-video.empty.sc-render{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:8px 10px;border-style:solid;position:relative}
.sc-root .sc-video.empty.sc-render.queued{border-style:dashed}
.sc-root .sc-video.empty.sc-render.compact{height:auto;min-height:0;margin-bottom:6px;padding:6px 10px 8px;flex-direction:row;flex-wrap:wrap;gap:2px 8px}
.sc-render-head{display:inline-flex;align-items:center;gap:6px;color:var(--paper);font:500 12.5px/1.4 var(--sans);font-variant-numeric:tabular-nums}
.sc-render.queued .sc-render-head{color:var(--muted)}
.sc-render-sub{color:var(--dim);font-size:11.5px;line-height:1.4;text-align:center;font-variant-numeric:tabular-nums}
.sc-render-dot{width:6px;height:6px;border-radius:50%;background:var(--paper);animation:sc-render-breathe 1.6s ease-in-out infinite}
.sc-render-bar{position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--line);overflow:hidden}
.sc-render-bar i{display:block;height:100%;width:0;background:var(--muted);transition:width .6s ease}
.sc-render-bar.indeterminate i{width:30%;animation:sc-render-slide 2.4s ease-in-out infinite}
@keyframes sc-render-breathe{0%,100%{opacity:.25}50%{opacity:1}}
@keyframes sc-render-slide{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}
@media (prefers-reduced-motion:reduce){.sc-render-dot,.sc-render-bar.indeterminate i{animation:none}.sc-render-dot{opacity:.8}}
`;
