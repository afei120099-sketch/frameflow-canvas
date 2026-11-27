"use client";

import { useEffect, useRef, useState } from "react";
import { Play, X } from "lucide-react";
import { askConfirm } from "@/components/in-page-dialog";
import { VideoReview } from "@/components/shot-card-review";
import { experimentContext, experimentDiff, experimentPair, experimentSegments, planExperiment, segmentEpisodeKeys } from "@/lib/ab-experiment";
import { acquireMediaUrl, releaseMediaUrl } from "@/lib/local-video-store";
import { getPoster } from "@/lib/poster-cache";
import type { ReviewBook } from "@/lib/review-tags";
import { queueGeneration, type ShotQueue, type ShotQueueShot } from "@/lib/shot-queue";

/**
 * 对比实验（镜头卡片每镜「对比实验」）：选只改哪一段 → 只编辑那一段 → 同一个种子的 A / B 两条。
 * 队列没入队过：插在原镜下面（onChange，进撤销 / 恢复）；入队过：另建小队列「原标题_对比」（onLoad）。
 * 入队还是在卡片「JSON / 进度」抽屉里点，照常确认。出片后 B 下面并排放 A / B，两条都能直接打审片标记。纯逻辑在 lib/ab-experiment.ts。
 */

export function ExperimentDialog({ queue, title, submitted, locked, onChange, onLoad, onClose, onDone }: { queue: ShotQueue; title: string; submitted: boolean; locked: () => string; onChange: (next: ShotQueue) => string | null; onLoad: (text: string) => string | null; onClose: () => void; onDone: (message: string, titleB: string, where: "insert" | "new") => void }) {
  // Found by title on every render: Ctrl+Z / 恢复 can move or remove shots while this dialog is open.
  const chapter = queue.chapters.findIndex((item) => item.shots.some((shot) => shot.title === title));
  const index = chapter < 0 ? -1 : queue.chapters[chapter].shots.findIndex((shot) => shot.title === title);
  const shot: ShotQueueShot | undefined = queue.chapters[chapter]?.shots[index];
  const segments = shot ? experimentSegments(shot.prompt) : [];
  const [pick, setPick] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [segmentText, setSegmentText] = useState("");
  const [error, setError] = useState("");
  const latest = useRef(queue); latest.current = queue;
  const option = queueGeneration(shot ?? { title, prompt: "", roleIds: [], sceneAssetIds: [], seconds: 6, aspect: "9:16", soundMode: "ambient" }, queue.defaults);
  const seedNote = option.seed === "random" ? "原镜是随机种子：生成时先定一个具体种子，A / B 都用它（原镜不动）" : `原镜种子 ${option.seed}：A / B 都用它`;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const go = async () => {
    setError("");
    if (!shot) { setError("这一镜已经不在队列里了（刚撤销或改过），关掉重新点「对比实验」"); return; }
    if (pick === null) { setError("先选只改哪一段"); return; }
    if (segments[pick]?.text !== segmentText) { setError("这一镜刚被撤销或改过，选的那一段对不上了，请重新选"); setPick(null); return; }
    const plan = planExperiment(queue, chapter, index, pick, text, { newQueue: submitted });
    if ("error" in plan) { setError(plan.error); return; }
    const where = plan.where === "insert"
      ? `插在「${shot.title}」下面（原镜不动），这一改进修改历史，可以点「撤销」或按 Ctrl+Z 退回。`
      : `这份队列已经入队过，不能原地改：另建一份只有这两条的小队列「${plan.queue.title}」，载入卡片（「JSON / 进度」里「${queue.title}」的文本会被换掉，它的视频和入队记录不动）。`;
    const before = queue;
    if (!await askConfirm({ title: "对比实验", message: `新建两条：\n「${plan.titles.a}」= 原写法\n「${plan.titles.b}」= 只改了「${plan.changed.label}」这一段${shot && segmentEpisodeKeys(queue, shot, segmentText).length ? `\n（这一段来自本集设定「${segmentEpisodeKeys(queue, shot, segmentText).join("」「")}」：只改 B 这一镜，本集设定和 A 不变。）` : ""}\n两条都用种子 ${plan.seed}${plan.seedWasRandom ? "（原镜是随机，刚定的）" : ""}。\n${where}\n还没入队：到「JSON / 进度」点入队，入队前照常确认。`, confirmLabel: "生成 A / B" })) { setError("已取消，没有改动"); return; }
    const lock = locked(); if (lock) { setError(lock); return; }
    if (latest.current !== before) { setError("确认期间队列被撤销或改过了，没生成；请重新选一次"); return; }
    const problem = plan.where === "insert" ? onChange(plan.queue) : onLoad(`${JSON.stringify(plan.queue, null, 2)}\n`);
    if (problem) { setError(`没生成：${problem}`); return; }
    onDone(`已生成「${plan.titles.a}」「${plan.titles.b}」（种子 ${plan.seed}，B 改了「${plan.changed.label}」）。到「JSON / 进度」点入队，两条一起渲染；出片后在 B 下面并排比较、打审片标记。`, plan.titles.b, plan.where);
  };
  // Rendered inside the board (.sc-root), so it gets the board's colours.
  return <div className="ab-shade" role="dialog" aria-modal="true" aria-label="对比实验" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onWheel={(event) => event.stopPropagation()}>
    <div className="ab-dialog">
      <header><div><span className="sc-kicker">对比实验 · 同一种子只改一个变量</span><h3>{title}</h3></div><button type="button" className="sc-close" aria-label="关闭" onClick={onClose}><X size={16} /></button></header>
      <p className="muted">{seedNote}。A 是原写法，B 只改下面选的那一段，其余一字不差。</p>
      <ol className="ab-segs">{segments.map((segment) => <li key={segment.index}>
        <label className={pick === segment.index ? "on" : ""}><input type="radio" name="ab-seg" checked={pick === segment.index} onChange={() => { setPick(segment.index); setText(segment.text); setSegmentText(segment.text); setError(""); }} /><b>{segment.label}</b>{shot && segmentEpisodeKeys(queue, shot, segment.text).length > 0 && <i className="muted" title="这一段的句子来自本集设定">（本集设定）</i>}<span>{segment.text.length > 90 ? `${segment.text.slice(0, 90)}…` : segment.text}</span></label>
        {pick === segment.index && shot && segmentEpisodeKeys(queue, shot, segment.text).length > 0 && <p className="muted">这一段用了本集设定「{segmentEpisodeKeys(queue, shot, segment.text).join("」「")}」。对比实验只改 B 这一镜：B 的这句不再跟本集设定走，A 和其他镜头不变，本集设定本身也不动。要整集一起改，请去「本集设定」面板改。</p>}
        {pick === segment.index && <textarea className="sc-input" rows={Math.min(10, Math.max(3, Math.ceil(text.length / 60)))} value={text} spellCheck={false} autoFocus onChange={(event) => setText(event.target.value)} />}
      </li>)}</ol>
      {error && <p className="sc-intake-error">{error}</p>}
      <footer><span className="muted">{!shot ? "这一镜已经不在队列里了" : submitted ? "这份队列入队过：会另建小队列「" + queue.title + "_对比」" : "会插在原镜下面"}</span><button type="button" className="sc-btn" onClick={onClose}>取消</button><button type="button" className="sc-btn primary" disabled={pick === null} onClick={() => void go()}>生成 A / B</button></footer>
    </div>
  </div>;
}

type PairVideo = { assetId: string; label: string; source: string; zhengben?: string; stale?: boolean };
function MiniPlayer({ video, aspect }: { video: PairVideo | null; aspect: string }) {
  const [url, setUrl] = useState("");
  const keyRef = useRef<string | null>(null);
  useEffect(() => () => releaseMediaUrl(keyRef.current), []);
  useEffect(() => { releaseMediaUrl(keyRef.current); keyRef.current = null; setUrl(""); }, [video?.assetId]);
  if (!video) return <div className="ab-video empty" style={{ aspectRatio: aspect.replace(":", "/") }}><span>还没出片</span></div>;
  const poster = getPoster(video.source);
  const play = () => void acquireMediaUrl(video.source).then((media) => { keyRef.current = media.key; setUrl(media.url); }).catch(() => setUrl(""));
  return <div className="ab-video" style={{ aspectRatio: aspect.replace(":", "/") }}>{url ? <video src={url} controls autoPlay playsInline /> : <button type="button" onClick={play} style={poster ? { backgroundImage: `url(${poster})` } : undefined}><Play size={18} /><span>播放 {video.label}</span></button>}{video.stale && <i>旧提示词</i>}</div>;
}

/** 出片后在 B 下面并排放 A / B，两条都能直接打审片标记。videos 只给这一对在本画布页出过的视频。 */
export function ExperimentCompare({ queue, titleB, videos, book }: { queue: ShotQueue; titleB: string; videos: (title: string) => PairVideo[]; book: ReviewBook }) {
  const pair = experimentPair(titleB);
  if (!pair || pair.side !== "B") return null;
  const shots = queue.chapters.flatMap((chapter) => chapter.shots);
  const a = shots.find((shot) => shot.title === pair.other), b = shots.find((shot) => shot.title === titleB);
  if (!a || !b) return null;
  const diff = experimentDiff(a.prompt, b.prompt);
  const side = (shot: ShotQueueShot, name: "A" | "B") => {
    const list = videos(shot.title);
    const latest = list[list.length - 1] ?? null;
    return <div className="ab-side" key={name}>
      <b>{name} · {name === "A" ? "原写法" : `改了${diff.map((item) => item.label).join("、") || "（看不出差别）"}`}</b>
      <MiniPlayer video={latest} aspect={shot.aspect} />
      {latest && <VideoReview videos={list.map((item) => ({ assetId: item.assetId, label: item.label, zhengben: item.zhengben }))} chosenId={latest.assetId} ctx={{ book, queueTitle: queue.title, shot, defaults: queue.defaults, experiment: experimentContext(queue, shot.title) }} />}
    </div>;
  };
  return <section className="ab-compare" aria-label={`对比实验 ${pair.key}`}>
    <header><span className="sc-kicker">对比实验 · {pair.key} · 种子 {String(queueGeneration(b, queue.defaults).seed)}{queueGeneration(a, queue.defaults).seed !== queueGeneration(b, queue.defaults).seed ? "（A / B 种子不一样了，比较不公平）" : ""}</span></header>
    <div className="ab-sides">{side(a, "A")}{side(b, "B")}</div>
    {diff.length > 0 && <details className="ab-diff"><summary>B 改的那一段</summary>{diff.map((item, i) => <div key={i}><em>{item.label}</em><p><small>A</small>{item.a}</p><p><small>B</small>{item.b}</p></div>)}</details>}
  </section>;
}

export const EXPERIMENT_STYLE = `
.ab-shade{position:fixed;inset:0;z-index:10050;display:grid;place-items:center;padding:24px;background:rgba(0,0,0,.55)}
.ab-dialog{width:min(760px,100%);max-height:calc(100vh - 48px);display:flex;flex-direction:column;gap:10px;padding:18px 20px;border:1px solid var(--line-2);border-radius:12px;background:var(--panel);overflow:hidden}
.ab-dialog header{display:flex;justify-content:space-between;gap:12px}.ab-dialog h3{margin:2px 0 0;font:600 18px/1.3 var(--display)}
.ab-segs{flex:1;overflow:auto;margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.ab-segs label{display:grid;grid-template-columns:auto 84px 1fr;gap:8px;align-items:baseline;padding:6px 8px;border:1px solid var(--line);border-radius:8px;cursor:pointer;font-size:12px;color:var(--muted)}
.ab-segs label.on{border-color:var(--paper);color:var(--paper)}.ab-segs label b{font-weight:600;color:var(--paper)}
.ab-segs textarea{width:100%;margin-top:6px;font-size:13px}
.ab-dialog footer{display:flex;align-items:center;gap:8px}.ab-dialog footer .muted{flex:1;font-size:12px}
.ab-compare{grid-column:1/-1;margin:-4px 0 14px;padding:12px 16px;border:1px dashed var(--line-2);border-radius:10px;background:var(--panel)}
.ab-sides{display:grid;grid-template-columns:repeat(2,minmax(0,260px));gap:18px;margin-top:8px}
.ab-side>b{display:block;margin-bottom:6px;font-size:12px;font-weight:600}
.ab-video{position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--ink)}
.ab-video video{width:100%;height:100%;object-fit:contain;display:block}
.ab-video button{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:0;background:var(--ink) center/cover no-repeat;color:var(--paper);font-size:12px}
.ab-video.empty{display:grid;place-items:center;font-size:12px;color:var(--dim)}
.ab-video i{position:absolute;left:6px;top:6px;padding:0 6px;border-radius:4px;background:rgba(0,0,0,.6);font:normal 11px var(--mono);color:var(--warn)}
.ab-diff{margin-top:8px;font-size:12px;color:var(--muted)}.ab-diff em{font-style:normal;color:var(--paper)}
.ab-diff p{margin:4px 0;white-space:pre-wrap}.ab-diff small{display:inline-block;width:18px;color:var(--dim)}
`;
