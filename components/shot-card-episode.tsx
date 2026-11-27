"use client";

import { useMemo, useState } from "react";
import type { ShotQueue, ShotQueueShot } from "@/lib/shot-queue";
import type { CategoryId } from "@/lib/zhengben-categories";
import { collectEpisode, episodeEntries, episodeNearMisses, episodeSegments, episodeUsage, expandEpisode, expandedQueueJson, renameEpisodeScene, shotQueueJson, withEpisode, type EpisodeField, type EpisodeSettings } from "@/lib/episode-settings";
import { downloadQueueJson } from "@/lib/shot-list-download";

/**
 * 镜头卡片里的「本集设定」（用户 2026-11-11 确认，草案 docs/本集设定-格式草案.md）：
 * - EpisodePrompt：卡片「原文」显示换回后的全文（就是模型收到的），来自本集设定的句子灰底标出。
 * - EpisodePanel：顶部小卡片展开后的面板，改设定、改场景名、看哪几镜在用、把逐字重复的句子收进本集设定、导出展开版。
 * 样式只用 app/tokens.css 的灰阶，不用紫色。
 */

export const EPISODE_STYLE = `
.sce-from{background:var(--ff-surface-3, rgba(128,128,128,.22));color:var(--ff-text, inherit);border-radius:3px;box-shadow:0 0 0 1px var(--ff-border-soft, rgba(128,128,128,.35)) inset}
.sce-from small{font:10px var(--ff-mono, monospace);opacity:.6;margin-left:4px}
.sce-near{grid-column:1/-1;margin:6px 0 0;font-size:12px;color:var(--ff-text-2, inherit)}
.sce-panel{display:grid;gap:10px;margin:8px 32px 0;padding:12px 14px;border:1px solid var(--ff-border-soft, rgba(128,128,128,.35));border-radius:10px;font-size:12.5px}
.sce-panel h4{margin:6px 0 0;font-size:12.5px;font-weight:600}
.sce-entry{display:grid;gap:6px;padding:8px 10px;border:1px solid var(--ff-border-soft, rgba(128,128,128,.3));border-radius:8px}
.sce-entry header{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.sce-entry code{font:12px var(--ff-mono, monospace);opacity:.75}
.sce-entry textarea{width:100%;min-height:54px;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid var(--ff-border-soft, rgba(128,128,128,.35));background:transparent;color:inherit;font:12px/1.6 inherit;resize:vertical}
.sce-entry input{width:9em;padding:2px 6px;border-radius:6px;border:1px solid var(--ff-border-soft, rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit}
.sce-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.sce-muted{opacity:.65}
.sce-list{margin:0;padding-left:18px;display:grid;gap:2px}
`;

/** 本镜哪几类完整度标签的内容来自本集设定（给完整度标签加「本集」小字）。 */
export function episodeCategories(shot: Pick<ShotQueueShot, "promptTemplate">, episode: EpisodeSettings | undefined): Set<CategoryId> {
  const out = new Set<CategoryId>();
  if (!shot.promptTemplate) return out;
  for (const key of expandEpisode(shot.promptTemplate, episode).used) {
    const kind = key.split(".")[0];
    if (kind === "风格") out.add("style");
    if (kind === "光线") out.add("light");
    if (kind === "画面要求") out.add("require");
    if (kind === "底声") out.add("sound");
  }
  return out;
}

/** 卡片「原文」：全文 + 本集设定的句子灰底。 */
export function EpisodePrompt({ shot, episode }: { shot: ShotQueueShot; episode?: EpisodeSettings }) {
  const pieces = episodeSegments(shot.promptTemplate, episode, shot.prompt);
  const near = episodeNearMisses(shot, episode);
  return <>
    <pre className="sc-prompt">{pieces.map((piece, i) => piece.key
      ? <mark key={i} className="sce-from" title={`来自本集设定「${piece.key}」：改这句整集一起变，到顶部「本集设定」里改`}>{piece.text}<small>本集·{piece.key}</small></mark>
      : <span key={i}>{piece.text}</span>)}</pre>
    {near.length > 0 && <p className="sce-near">和本集设定差一点、仍是逐字照抄的句子：{near.map((miss) => `「${miss.key}」镜头里 ${miss.shot}，设定 ${miss.setting}`).join("；")}</p>}
  </>;
}

export function episodeFoldSummary(queue: ShotQueue): { text: string; tone: "plain" | "warn" } {
  if (!queue.episode) return { text: "没用本集设定（风格、光线、画面要求、底声逐字写在每镜里）· 点开可以收进来", tone: "plain" };
  const usage = episodeUsage(queue);
  const unused = [...usage.values()].filter((titles) => !titles.length).length;
  const near = queue.chapters.flatMap((chapter) => chapter.shots).flatMap((shot) => episodeNearMisses(shot, queue.episode)).length;
  return { text: `${usage.size} 条设定${unused ? ` · ${unused} 条没人用` : ""}${near ? ` · ${near} 处差一点` : ""}`, tone: unused || near ? "warn" : "plain" };
}

const FIELD_HINT: Record<EpisodeField, string> = { style: "风格（胶片、色彩）", lighting: "光线（每个场景一句，含时间和主色温）", frameRequirements: "画面要求（不含开头「画面要求：」四个字）", ambience: "环境底声（每个场景一句）" };

/** 顶部「本集设定」面板。所有修改走 onChange（照常进撤销 / 恢复）；收进本集设定走 onLoad，另存为新队列。 */
export function EpisodePanel({ queue, locked, onChange, onLoad }: { queue: ShotQueue; locked: string; onChange: (next: ShotQueue) => string | null; onLoad: (text: string) => string | null }) {
  const [note, setNote] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [report, setReport] = useState<ReturnType<typeof collectEpisode> | null>(null);
  const usage = useMemo(() => episodeUsage(queue), [queue]);
  const entries = episodeEntries(queue.episode);
  const near = queue.chapters.flatMap((chapter) => chapter.shots).flatMap((shot) => episodeNearMisses(shot, queue.episode));
  const saveText = (field: EpisodeField, scene: string | undefined, key: string) => {
    const text = drafts[key];
    if (text === undefined) return;
    const episode: EpisodeSettings = scene === undefined ? { ...queue.episode, [field]: text } : { ...queue.episode, [field]: { ...(queue.episode?.[field] as Record<string, string>), [scene]: text } };
    const problem = onChange(withEpisode(queue, episode));
    setNote(problem ?? `已改「${key}」，用到它的 ${usage.get(key)?.length ?? 0} 镜一起变；可以撤销`);
    if (!problem) setDrafts(({ [key]: _drop, ...rest }) => { void _drop; return rest; });
  };
  const rename = (field: "lighting" | "ambience", scene: string, key: string) => {
    const to = (names[key] ?? scene).trim();
    if (to === scene) return;
    const next = renameEpisodeScene(queue, field, scene, to);
    const problem = typeof next === "string" ? next : onChange(next);
    setNote(problem ?? `场景「${scene}」改名为「${to}」，镜头里的占位一起改了`);
  };
  const collect = () => { const result = collectEpisode(queue); setReport(result); setNote(result.ok ? "" : result.error ?? ""); };
  const applyCollect = () => {
    if (!report?.ok || !report.queue) return;
    let title = `${queue.title}·本集设定`;
    if (title.length > 80) title = title.slice(0, 80);
    const problem = onLoad(shotQueueJson({ ...report.queue, title }));
    setNote(problem ?? `已另存为「${title}」并载入，原队列没动`);
    if (!problem) setReport(null);
  };
  return <div className="sce-panel">
    <p className="sce-muted">风格、各场景光线句、画面要求、各场景环境底声放在这里，镜头正文写占位（如 {"{{本集.光线.办公室}}"}）。提交给模型时换回原句，和逐字复制一字不差。改一处，用到它的镜头全部跟着变。</p>
    {entries.length > 0 && <>
      <h4>本集设定（{entries.length} 条）</h4>
      {entries.map((entry) => {
        const users = usage.get(entry.key) ?? [];
        const draft = drafts[entry.key];
        return <div className="sce-entry" key={entry.key}>
          <header>
            <b>{FIELD_HINT[entry.field]}</b>
            {entry.scene !== undefined && <span className="sce-row">场景名 <input value={names[entry.key] ?? entry.scene} disabled={Boolean(locked)} onChange={(event) => setNames((current) => ({ ...current, [entry.key]: event.target.value }))} onBlur={() => rename(entry.field as "lighting" | "ambience", entry.scene!, entry.key)} /></span>}
            <code>{`{{本集.${entry.key}}}`}</code>
            <span className="sce-muted" title={users.join("\n")}>{users.length ? `${users.length} 镜在用` : "没有镜头用到"}</span>
          </header>
          <textarea value={draft ?? entry.text} disabled={Boolean(locked)} onChange={(event) => setDrafts((current) => ({ ...current, [entry.key]: event.target.value }))} />
          {draft !== undefined && draft !== entry.text && <div className="sce-row">
            <button type="button" className="sc-btn" onClick={() => saveText(entry.field, entry.scene, entry.key)}>保存（{users.length} 镜一起变）</button>
            <button type="button" className="sc-btn" onClick={() => setDrafts(({ [entry.key]: _drop, ...rest }) => { void _drop; return rest; })}>不改了</button>
          </div>}
        </div>;
      })}
    </>}
    {near.length > 0 && <>
      <h4>差一点、没用占位的句子（{near.length} 处，转换不替你统一）</h4>
      <ul className="sce-list">{near.map((miss, i) => <li key={i}>「{miss.title}」和「{miss.key}」：镜头里 {miss.shot}，设定 {miss.setting}</li>)}</ul>
    </>}
    <div className="sce-row">
      <button type="button" className="sc-btn" disabled={Boolean(locked)} title={locked || "找出每镜逐字重复的风格 / 光线 / 画面要求 / 底声句；先出报告，确认后另存为新队列"} onClick={collect}>把逐字重复的句子收进本集设定…</button>
      <button type="button" className="sc-btn" title="没有本集设定、全文展开的旧格式 JSON，给还不认识本集设定的工具用" onClick={() => downloadQueueJson(`${queue.title}-展开版`, expandedQueueJson(queue))}>导出展开版（旧格式）</button>
    </div>
    {report?.ok && <div className="sce-entry">
      <b>转换报告：换回后逐镜和原文一字不差</b>
      <ul className="sce-list">{Object.entries(report.used).map(([token, n]) => <li key={token}><code>{token}</code> {n} 镜</li>)}</ul>
      {report.kept.length > 0 && <><span>差一点、保留原文的 {report.kept.length} 处：</span><ul className="sce-list">{report.kept.map((miss, i) => <li key={i}>「{miss.title}」和「{miss.key}」：镜头里 {miss.shot}，设定 {miss.setting}</li>)}</ul></>}
      <div className="sce-row"><button type="button" className="sc-btn" onClick={applyCollect}>另存为「{queue.title}·本集设定」并载入</button><button type="button" className="sc-btn" onClick={() => setReport(null)}>不收了</button></div>
    </div>}
    {note && <p className="sce-muted">{note}</p>}
  </div>;
}
