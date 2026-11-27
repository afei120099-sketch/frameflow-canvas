"use client";

import { useEffect, useMemo, useState } from "react";
import { askConfirm } from "@/components/in-page-dialog";
import { copyPlainText } from "@/lib/copy-plain-text";
import type { ShotQueue, ShotQueueShot } from "@/lib/shot-queue";
import { planReworkQueue, problemRates, problemsByTag, rateText, REVIEW_NOTE_MAX, REVIEW_TAG_LABEL, REVIEW_TAGS, reviewContext, type ReviewBook, type ReviewContext, type ReviewEntry, type ReviewTagId } from "@/lib/review-tags";
import { loadReviewBook, loadReworkNote, saveReviewEntry, saveReworkNote, subscribeReviewTags, type ReworkNoteRecord } from "@/lib/review-tags-store";

/**
 * 审片标记（镜头卡片里）：每镜视频下面给每条视频打问题标签；顶部整集汇总、按写法统计问题率、一键生成返修队列；
 * 返修队列打开时顶部显示返修说明。纯逻辑在 lib/review-tags.ts，存储在 lib/review-tags-store.ts。
 */

/** The whole book, kept fresh across the board (same page) and reloaded when the window regains focus (other tabs). */
export function useReviewBook() {
  const [book, setBook] = useState<ReviewBook>({});
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = () => void loadReviewBook().then((value) => { if (active) { setBook(value); setError(""); } }).catch(() => { if (active) setError("审片标记读不出来（生成记录库打不开）"); });
    load();
    const off = subscribeReviewTags((value) => { if (active) setBook(value); });
    window.addEventListener("focus", load);
    return () => { active = false; off(); window.removeEventListener("focus", load); };
  }, []);
  return { book, error };
}

export type ReviewVideo = { assetId: string; label: string; zhengben?: string; adopted?: boolean };
export type ReviewCtx = { book: ReviewBook; queueTitle: string; shot: ShotQueueShot; defaults: ShotQueue["defaults"]; experiment?: ReviewContext["experiment"] };

const tagLine = (entry: ReviewEntry | undefined) => !entry ? "" : entry.tags.length ? entry.tags.map((tag) => REVIEW_TAG_LABEL[tag]).join("、") : entry.ok ? "没问题" : "";

/** 视频下面那一块：选给哪一条打（默认卡片正在显示的那条，不改「已采用」），点标签就存。 */
export function VideoReview({ videos, chosenId, ctx }: { videos: ReviewVideo[]; chosenId: string; ctx: ReviewCtx }) {
  const [target, setTarget] = useState(chosenId);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  useEffect(() => setTarget(chosenId), [chosenId]);
  const video = videos.find((item) => item.assetId === target) ?? videos.find((item) => item.assetId === chosenId);
  if (!video) return null;
  const entry = ctx.book[video.assetId];
  const save = (change: Partial<Pick<ReviewEntry, "tags" | "ok" | "note">>) => {
    setError("");
    const base: ReviewEntry = entry ?? { assetId: video.assetId, tags: [], queueTitle: ctx.queueTitle, shotTitle: ctx.shot.title, context: reviewContext(ctx.shot, ctx.defaults, video.zhengben, ctx.experiment), updatedAt: 0 };
    // The context is the 写法 the video was made with: refreshed only if the entry is new (the queue may have changed since).
    void saveReviewEntry({ ...base, label: video.label, queueTitle: ctx.queueTitle, shotTitle: ctx.shot.title, ...change }).catch(() => setError("没存上（生成记录库写入失败），再点一次"));
  };
  const toggle = (tag: ReviewTagId) => { const tags = entry?.tags.includes(tag) ? entry.tags.filter((item) => item !== tag) : [...(entry?.tags ?? []), tag]; save({ tags, ok: false }); if (tag === "other" && !entry?.tags.includes("other")) { setOpen(true); setNoteDraft(entry?.note ?? ""); } };
  const summary = tagLine(entry);
  return <div className="rv-box">
    <button type="button" className={`rv-head ${entry?.tags.length ? "bad" : entry?.ok ? "ok" : ""}`} aria-expanded={open} onClick={() => setOpen((value) => !value)} title="出片后记下这条视频的问题，可以多选；只记在这台电脑的生成记录里，跟每日备份走，不改队列">
      审片{videos.length > 1 ? ` ${video.label}` : ""}：{summary || "没打标记"}{entry?.note ? " · 有备注" : ""}
    </button>
    {open && <div className="rv-panel">
      {videos.length > 1 && <div className="rv-which" role="radiogroup" aria-label="给哪一条打标记">{videos.map((item) => <button type="button" key={item.assetId} role="radio" aria-checked={item.assetId === video.assetId} className={item.assetId === video.assetId ? "on" : ""} title={tagLine(ctx.book[item.assetId]) || "还没打标记"} onClick={() => { setTarget(item.assetId); setNoteDraft(null); }}>{item.label}{ctx.book[item.assetId]?.tags.length ? "·" : ""}</button>)}</div>}
      <div className="rv-tags">
        {REVIEW_TAGS.map((tag) => <button type="button" key={tag.id} aria-pressed={Boolean(entry?.tags.includes(tag.id))} className={entry?.tags.includes(tag.id) ? "on" : ""} onClick={() => toggle(tag.id)}>{tag.label}</button>)}
        <button type="button" aria-pressed={Boolean(entry?.ok)} className={`okb ${entry?.ok ? "on" : ""}`} title="看过了，这条没问题（统计问题率时算进分母）" onClick={() => save({ tags: [], ok: !entry?.ok })}>没问题</button>
      </div>
      {noteDraft === null
        ? <button type="button" className="rv-note-link" onClick={() => setNoteDraft(entry?.note ?? "")}>{entry?.note ? `备注：${entry.note}` : "＋ 写一句备注"}</button>
        : <div className="rv-note"><input className="sc-input" maxLength={REVIEW_NOTE_MAX} value={noteDraft} placeholder="例如：3 秒处右手多一根手指" autoFocus onChange={(event) => setNoteDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { save({ note: noteDraft }); setNoteDraft(null); } }} /><button type="button" className="sc-btn" onClick={() => { save({ note: noteDraft }); setNoteDraft(null); }}>存</button></div>}
      {error && <p className="sc-intake-error">{error}</p>}
    </div>}
  </div>;
}

function download(name: string, text: string, type: string, ext: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") + ext;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 整集汇总：问题 → 哪几镜；按写法统计问题率；一键生成返修队列。 */
type ReviewSummaryProps = { queue: ShotQueue; book: ReviewBook; codes: { key: string; title: string; code: string }[]; jump: (key: string) => void; locked: string; loadQueue: (text: string) => string | null };

/** 顶部那排小卡片里「审片」那一张的一句摘要（主线 ScFoldBar）；这份队列和别的队列都没标记时不显示。 */
export function reviewDigest(queue: ShotQueue, book: ReviewBook, titles: readonly string[]): { show: boolean; tone: "warn" | "plain"; summary: string } {
  const mine = Object.values(book).filter((entry) => entry.queueTitle === queue.title && titles.includes(entry.shotTitle));
  const reviewed = mine.filter((entry) => entry.tags.length || entry.ok).length;
  const rows = problemsByTag(book, queue.title, titles);
  const plan = planReworkQueue(queue, book);
  const top = [...rows].sort((a, b) => b.shots.length - a.shots.length).slice(0, 2).map((row) => `${row.label} ${row.shots.length}`).join("、");
  return { show: mine.length > 0 || Object.keys(book).length > 0, tone: rows.length ? "warn" : "plain", summary: `看过 ${reviewed} 条${top ? ` · ${top}` : reviewed ? " · 都没问题" : ""}${"error" in plan ? "" : ` · 可返修 ${plan.shots.length} 镜`}` };
}

/** 「审片」小卡片点开后的详情：问题 → 哪几镜、按写法统计问题率、一键生成返修队列。 */
export function ReviewDetail({ queue, book, codes, jump, locked, loadQueue }: ReviewSummaryProps) {
  const [scope, setScope] = useState<"queue" | "all">("queue");
  const [note, setNote] = useState("");
  const titles = useMemo(() => codes.map((item) => item.title), [codes]);
  const rows = useMemo(() => problemsByTag(book, queue.title, titles), [book, queue.title, titles]);
  const rates = useMemo(() => problemRates(book, scope === "queue" ? { queueTitle: queue.title } : {}), [book, scope, queue.title]);
  const plan = useMemo(() => planReworkQueue(queue, book), [queue, book]);
  const codeOf = (title: string) => codes.find((item) => item.title === title);
  const rework = async () => {
    setNote("");
    if ("error" in plan) { setNote(plan.error); return; }
    if (!await askConfirm({ title: "生成返修队列", message: `新建「${plan.title}」，只收打了问题标签的 ${plan.shots.length} 镜，每镜正文一字不改。${plan.skipped.length ? `另有 ${plan.skipped.length} 镜要接别的镜头的画面，没收进来（写在说明里）。` : ""}
会下载两份文件：「${plan.title}.json」和「${plan.title}_返修说明.md」，然后把返修队列载入卡片（「JSON / 进度」里「${queue.title}」的文本会被换掉；它的视频、入队记录和修改历史都不动，要回去就在卡片里「换队列 JSON」贴回原文件）。还没入队，入队前照常确认。`, confirmLabel: "下载并载入返修队列" })) { setNote("已取消，什么都没改"); return; }
    if (locked) { setNote(locked); return; }
    const text = `${JSON.stringify(plan.queue, null, 2)}
`;
    await saveReworkNote({ from: queue.title, title: plan.title, text: plan.note, createdAt: Date.now() } satisfies ReworkNoteRecord).catch(() => setNote("返修说明没存进生成记录库，下载的 .md 文件里还有"));
    download(plan.title, text, "application/json;charset=utf-8", ".json");
    download(`${plan.title}_返修说明`, plan.note, "text/markdown;charset=utf-8", ".md");
    const problem = loadQueue(text);
    if (problem) setNote(`返修队列没载入：${problem}（两份文件已下载）`);
  };
  return <section className="rv-sum">
    <div className="rv-sum-head">
      <button type="button" className="sc-btn" disabled={"error" in plan || Boolean(locked)} title={locked || ("error" in plan ? plan.error : `只收打了问题标签的 ${plan.shots.length} 镜，生成「${plan.title}」，原队列不动`)} onClick={() => void rework()}>一键生成返修队列{"error" in plan ? "" : `（${plan.shots.length} 镜）`}</button>
      <span>{"error" in plan ? plan.error : "只收打了问题标签、而且没有一条标「没问题」的镜头；正文一字不改，原队列不动"}</span>
      {note && <em role="status">{note}</em>}
    </div>
    <div className="rv-sum-body">
      <div>
        <h4>问题 → 哪几镜</h4>
        {rows.length ? <ul>{rows.map((row) => <li key={row.tag}><b>{row.label}</b>{row.shots.map((shot, i) => { const code = codeOf(shot.shotTitle); return <button type="button" key={i} title={`${shot.shotTitle}${shot.note ? `：${shot.note}` : ""}`} onClick={() => code && jump(code.key)}>{code?.code ?? shot.shotTitle}{shot.label ? ` ${shot.label}` : ""}</button>; })}</li>)}</ul> : <p className="muted">还没有打了问题标签的视频</p>}
      </div>
      <div>
        <h4>按写法统计问题率 <span className="rv-scope"><button type="button" className={scope === "queue" ? "on" : ""} onClick={() => setScope("queue")}>本队列</button><button type="button" className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>全部队列</button></span></h4>
        <p className="muted">问题率 = 打了问题标签的 ÷ 看过的（打了标签或点了「没问题」）。没看过的视频不算。分组按出片时的写法记下，队列后来改了也不变。</p>
        {rates.length ? rates.map((table) => <div key={table.dimension} className="rv-rate"><b>{table.label}</b><ul>{table.groups.map((group) => <li key={group.key} className={group.small ? "small" : ""}><span>{group.key}</span>{rateText(group)}</li>)}</ul></div>) : <p className="muted">还没有看过的视频，统计不了</p>}
      </div>
    </div>
  </section>;
}

/** 返修队列打开时：顶部显示返修说明（每镜的标签和备注），可以复制、下载。 */
export function ReworkNoteBar({ queueTitle }: { queueTitle: string }) {
  const [record, setRecord] = useState<ReworkNoteRecord | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState("");
  useEffect(() => { let active = true; void loadReworkNote(queueTitle).then((value) => { if (active) setRecord(value); }); return () => { active = false; }; }, [queueTitle]);
  if (!record) return null;
  return <div className="sc-bulk rv-rework" role="status">
    <span>这是从「{record.from}」生成的返修队列。返修说明写了每镜审片时打的标签和备注，交给人或 AI 改提示词（title 一字不改）。</span>
    <button type="button" className="sc-btn" onClick={() => void copyPlainText(record.text).then((ok) => { setCopied(ok ? "已复制" : "复制失败"); window.setTimeout(() => setCopied(""), 2200); })}>{copied || "复制返修说明"}</button>
    <button type="button" className="sc-btn" onClick={() => download(`${record.title}_返修说明`, record.text, "text/markdown;charset=utf-8", ".md")}>下载 .md</button>
    <button type="button" className="sc-btn" onClick={() => setOpen((value) => !value)}>{open ? "收起" : "展开"}</button>
    {open && <pre className="rv-rework-text">{record.text}</pre>}
  </div>;
}

export const REVIEW_STYLE = `
.rv-box{margin-top:6px;font-size:12px}
.rv-head{width:100%;padding:4px 8px;border:1px solid var(--line-2);border-radius:8px;background:transparent;color:var(--muted);text-align:left;line-height:1.4}
.rv-head.bad{color:var(--stop);border-color:currentColor}.rv-head.ok{color:var(--go)}
.rv-head:hover{color:var(--paper)}
.rv-panel{margin-top:6px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.rv-which,.rv-tags{display:flex;flex-wrap:wrap;gap:4px}
.rv-which{margin-bottom:6px}
.rv-which button,.rv-tags button{padding:2px 8px;border:1px solid var(--line-2);border-radius:999px;background:transparent;color:var(--muted);font-size:12px}
.rv-which button.on,.rv-tags button.on{background:var(--paper);color:var(--ink);border-color:var(--paper)}
.rv-tags button.okb.on{background:transparent;color:var(--go);border-color:var(--go)}
.rv-note-link{margin-top:6px;padding:0;border:0;background:transparent;color:var(--dim);font-size:12px;text-align:left}
.rv-note{display:flex;gap:4px;margin-top:6px}.rv-note input{flex:1;min-width:0}
.rv-sum{margin:0;padding:4px 4px 2px;font-size:12.5px}
.rv-sum-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.rv-sum-head span{font-size:12px;color:var(--muted)}
.rv-sum-head em{font-style:normal;font-size:12px;color:var(--warn)}
.rv-sum-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:24px;margin-top:10px}
.rv-sum-body h4{margin:0 0 6px;font-size:13px;font-weight:600}
.rv-sum-body ul{margin:0;padding:0;list-style:none}
.rv-sum-body li{padding:3px 0;font-size:12px;color:var(--muted)}
.rv-sum-body li b{display:inline-block;min-width:76px;color:var(--paper);font-weight:500}
.rv-sum-body li button{margin:0 4px 2px 0;padding:0 7px;border:1px solid var(--line-2);border-radius:999px;background:transparent;font:12px var(--mono);color:var(--paper)}
.rv-sum-body li button:hover{background:var(--panel-2)}
.rv-rate{margin-top:8px}.rv-rate li span{display:inline-block;min-width:150px;color:var(--paper)}
.rv-rate li.small{color:var(--dim)}
.rv-scope{margin-left:8px}.rv-scope button{padding:0 8px;border:1px solid var(--line-2);background:transparent;color:var(--muted);font-size:12px}
.rv-scope button:first-child{border-radius:999px 0 0 999px}.rv-scope button:last-child{border-radius:0 999px 999px 0;border-left:0}
.rv-scope button.on{background:var(--paper);color:var(--ink)}
.rv-rework{flex-wrap:wrap}
.rv-rework-text{flex-basis:100%;max-height:260px;overflow:auto;margin:6px 0 0;padding:8px;border:1px solid var(--line);border-radius:8px;font:12px/1.6 var(--mono);white-space:pre-wrap;color:var(--muted)}
`;
