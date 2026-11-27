"use client";
import { useState } from "react";
import { chapterPlanningTask, parseStoryChapters, type StoryChapters } from "@/lib/story-chapters";
import { saveStoryPlan } from "@/lib/production-plan-store";
import { MediaAuditPanel } from "@/components/media-audit-panel";
import { downloadProductionFile } from "@/lib/media-audit";

export function StoryChapterPlanner({ disabled, onUse }: { disabled: boolean; onUse: (brief: string, seconds: number) => void }) {
  const [script, setScript] = useState("");
  const [json, setJson] = useState("");
  const [plan, setPlan] = useState<StoryChapters | null>(null);
  const [task, setTask] = useState("");
  const [message, setMessage] = useState("");
  const [reference, setReference] = useState("");
  const run = async (action: () => void | Promise<void>) => { try { setMessage(""); await action(); } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); } };
  return <details className="autopilot-facts">
    <summary>长剧本：分段制作</summary>
    <p className="ff-hint backup-note">先分章节，再逐段复制导演任务、检查并确认制作。不会自动生成。检查后可保存到项目，在成片序列里查看制作进度；未保存输入关闭会丢失。夜班输出仍需独立归档。</p>
    <MediaAuditPanel onNotes={(text) => { setReference(text); setTask(""); setMessage("参考建议已带入；请重新复制章节规划任务"); }} />
    {reference && <p>已采用参考建议：{reference}（会进入规划任务，不直接写进 H3）</p>}
    <label className="autopilot-field"><span>完整剧本（最多 30000 字符）</span><textarea rows={5} maxLength={30000} value={script} onChange={(e) => { setScript(e.target.value); setPlan(null); setTask(""); }} /></label>
    <button type="button" disabled={!script.trim()} onClick={() => void run(async () => { const text = chapterPlanningTask(script, reference); setTask(text); try { await navigator.clipboard.writeText(text); setMessage("已复制，发给 GPT / Claude 分章节"); } catch { setMessage("请手动复制下面的规划任务"); } })}>复制章节规划任务</button>
    {task && <label className="autopilot-field"><span>规划任务（可手动复制）</span><textarea rows={3} readOnly value={task} onFocus={(e) => e.target.select()} /></label>}
    <label className="autopilot-field"><span>粘贴返回的章节 JSON，或载入之前下载的章节文件</span><textarea rows={4} value={json} onChange={(e) => { setJson(e.target.value); setPlan(null); }} /></label>
    <input type="file" accept=".json,application/json" aria-label="载入章节文件" onChange={(e) => { const file = e.target.files?.[0]; if (file) void run(async () => { if (file.size > 600000) throw new Error("章节文件过大"); const text = await file.text(); const raw = JSON.parse(text) as StoryChapters; const checked = parseStoryChapters(text, raw.script); setScript(checked.script); setJson(text); setPlan(checked); setReference(checked.referenceNotes ?? ""); setTask(""); }); e.target.value = ""; }} />
    <button type="button" disabled={!json.trim()} onClick={() => void run(() => { setPlan(parseStoryChapters(json, script)); setMessage("原文覆盖检查通过，请人工核对每段需求与连续性"); })}>检查章节</button>
    {message && <p role="status" className="backup-note">{message}</p>}
    {plan && <>
      <p>{plan.chapters.length} 段 · 目标合计 {plan.chapters.reduce((sum, c) => sum + c.seconds, 0)} 秒（不是实际出片时长）</p>
      <ol className="autopilot-plan">{plan.chapters.map((chapter, i) => <li key={i}>
        <header><b>{i + 1}. {chapter.title}</b><span>{chapter.seconds} 秒</span></header>
        <p>{chapter.brief}</p><p>连续性：{chapter.continuity || "未填写，请人工补充"}</p>
        <details><summary>核对本段原文</summary><pre style={{ whiteSpace: "pre-wrap" }}>{chapter.source}</pre></details>
        <button type="button" disabled={disabled} onClick={() => { onUse(chapter.brief, chapter.seconds); setMessage(`已载入第 ${i + 1} 段需求；请核对主体锚点和约束，再复制导演任务。未提交生成。`); }}>载入本段需求（替换上方需求）</button>
      </li>)}</ol>
      <button type="button" onClick={() => downloadProductionFile(new Blob([JSON.stringify({ ...plan, referenceNotes: reference }, null, 2)], { type: "application/json" }), "story-chapters-v1.json")}>下载章节文件（保存原文和计划）</button>
      <button type="button" disabled={disabled} onClick={() => void run(async () => { await saveStoryPlan({ ...plan, ...(reference ? { referenceNotes: reference } : {}) }); setMessage("已保存到项目，包含在项目备份；成片序列 → 制作进度与连续性可关联镜头"); })}>保存章节到项目制作进度板</button>
    </>}
  </details>;
}
